import { parentPort } from 'node:worker_threads'
import type {
    LLMModelConfig,
    StrategyReplayTurnInput,
    StrategyScope,
    LoomaContext,
    LoomaMessage,
    Message,
    StrategyModule,
    StrategyContextBuildOutput,
    StrategyContextBuildResult,
    StrategyDevEvent,
    StrategyDevEventPhase,
} from '../../../contracts'
import { hostClient } from './hostClient'
import { loadStrategyModule } from './strategyLoader'
import { buildContext } from './buildContext'

type RequestType = 'init' | 'contextBuild' | 'turnEnd' | 'toolCall' | 'replayTurn' | 'dispose'

type StrategyWorkerRequest = {
    id: string
    type: RequestType
    payload?: unknown
}

type StrategyWorkerResponse =
    | { id: string; ok: true; result?: unknown }
    | { id: string; ok: false; error: { message: string; stack?: string } }

type WorkerEnvelope = { kind: 'hostRequest' } | { kind: 'hostResponse' }
type WorkerEventData = {
    [key: string]: unknown
    action?: string
    input?: unknown
    output?: unknown
    status?: 'start' | 'done' | 'error'
}
type WorkerDevEventInput = {
    type: StrategyDevEvent['type']
    turnId?: string | null
    ts?: number
    phase?: StrategyDevEventPhase | DevErrorPhase
    kind?: string
    data?: WorkerEventData
    level?: 'log' | 'warn' | 'error'
    text?: string
    message?: string
    stack?: string
    version?: string
    hash?: string
}

type StrategyRequestPayload = {
    conversationId: string
    turnId?: string
    model?: LLMModelConfig
    scope?: StrategyScope
    strategyId?: string
    strategyEntryPath?: string
    configValues?: Record<string, unknown>
    message?: LoomaMessage | null
    devMode?: boolean
}

let loadedStrategy: StrategyModule | null = null
let loadedEntryPath: string | null = null
let lastCtx: LoomaContext | null = null
let devMode = false
let devConversationId: string | null = null
let devStrategyId: string | null = null
let devTurnId: string | null = null
let consolePatched = false
let metaEmitted = false
let lastStatusKey: string | null = null

type ContextSnapshot = Extract<StrategyDevEvent, { type: 'context' }>['data']
type DevErrorPhase = Extract<StrategyDevEvent, { type: 'error' }>['phase']
type DevStatusData = Extract<StrategyDevEvent, { type: 'status' }>['data']

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object')
}

function normalizeContextBuildResult(result: StrategyContextBuildOutput): StrategyContextBuildResult {
    if (Array.isArray(result)) {
        return { prompt: { messages: result as Message[] } }
    }

    if (isRecord(result)) {
        const resultRecord = result as Record<string, unknown> & {
            prompt?: unknown
            messages?: unknown
            tools?: unknown
            meta?: unknown
        }
        const prompt = resultRecord.prompt
        if (isRecord(prompt) && Array.isArray(prompt.messages)) {
            return result as unknown as StrategyContextBuildResult
        }

        if (Array.isArray(resultRecord.messages)) {
            return {
                prompt: {
                    messages: resultRecord.messages as Message[],
                },
                tools: Array.isArray(resultRecord.tools)
                    ? (resultRecord.tools as StrategyContextBuildResult['tools'])
                    : undefined,
                meta: isRecord(resultRecord.meta)
                    ? (resultRecord.meta as StrategyContextBuildResult['meta'])
                    : undefined,
            }
        }
    }

    throw new Error('[strategy-worker] invalid onContextBuild result')
}

function isWorkerEnvelope(value: unknown): value is WorkerEnvelope {
    return Boolean(
        value
        && typeof value === 'object'
        && 'kind' in value
        && ((((value as { kind?: unknown }).kind) === 'hostRequest') || (((value as { kind?: unknown }).kind) === 'hostResponse'))
    )
}

function isStrategyWorkerRequest(value: unknown): value is StrategyWorkerRequest {
    return Boolean(
        value
        && typeof value === 'object'
        && 'id' in value
        && 'type' in value
    )
}

function updateDevContext(payload?: StrategyRequestPayload): void {
    if (!payload) return
    if (typeof payload.devMode === 'boolean') devMode = payload.devMode
    if (payload.conversationId) devConversationId = payload.conversationId
    if (payload.strategyId) devStrategyId = payload.strategyId
    if ('turnId' in payload) devTurnId = payload.turnId ?? null
    if (devMode) patchConsole()
}

function safeStringify(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function formatConsoleArgs(args: unknown[]): string {
    return args.map(safeStringify).join(' ')
}

const INVISIBLE_CHARS = /[\u200b-\u200d\ufeff\ue000-\uf8ff]/g

function stripInvisible(text: string): string {
    return text.replace(INVISIBLE_CHARS, '').trim()
}

function parseTaggedStrategyLog(args: unknown[]): { strategyTag: string; message: string } | null {
    if (args.length === 0) return null
    const firstRaw = args[0]
    if (typeof firstRaw !== 'string') return null

    const first = stripInvisible(firstRaw)
    const match = first.match(/^\[(log|warn|error)\]\s*(?:\[([^\]]+)\]|【([^】]+)】)\s*(.*)$/i)
    if (!match) return null

    const strategyTag = stripInvisible((match[2] ?? match[3] ?? '').toString())
    if (!strategyTag) return null

    const inline = stripInvisible((match[4] ?? '').toString())
    const rest = args.slice(1).map((item) => stripInvisible(safeStringify(item))).filter(Boolean).join(' ')
    const message = [inline, rest].filter(Boolean).join(' ').trim()
    return { strategyTag, message }
}

function formatConsolePayload(args: unknown[]): string {
    const tagged = parseTaggedStrategyLog(args)
    if (!tagged) return formatConsoleArgs(args)
    return `[strategy-log][${tagged.strategyTag}] ${tagged.message}`.trim()
}

function emitDevEvent(event: WorkerDevEventInput): void {
    if (!devMode || !parentPort) return
    if (!devConversationId || !devStrategyId) return
    const now = Date.now()
    const turnIdRaw = ('turnId' in event ? event.turnId : devTurnId) ?? undefined
    const turnId = turnIdRaw ?? `init-${devConversationId.slice(0, 6)}-${now.toString(36)}`
    const phase = event.phase ?? inferPhase(event) ?? 'system'
    const kind = event.kind ?? inferKind(event)
    const payload = {
        ...event,
        conversationId: devConversationId,
        strategyId: devStrategyId,
        turnId,
        timestamp: now,
        ts: event.ts ?? now,
        phase,
        kind,
    } as StrategyDevEvent
    parentPort.postMessage({ kind: 'devEvent', payload })
}

function resolvePhaseForEvent(event: WorkerDevEventInput, fallback: StrategyDevEventPhase): StrategyDevEventPhase {
    if (event.type === 'tools') {
        const action = event.data?.action
        if (action === 'llm.call' || action === 'llm.run') {
            return 'llm'
        }
    }
    return fallback
}

function inferPhase(event: WorkerDevEventInput): StrategyDevEventPhase | undefined {
    switch (event.type) {
        case 'context':
        case 'prompt':
        case 'slots':
        case 'budget':
        case 'state':
            return 'context'
        case 'tools':
            if (
                event.data?.action === 'llm.call'
                || event.data?.action === 'llm.run'
                || event.data?.action === 'llm.result'
            ) {
                return 'llm'
            }
            return 'turnEnd'
        case 'memory':
            return 'turnEnd'
        case 'console':
        case 'error':
        case 'meta':
        case 'reload':
        case 'status':
        case 'turn':
            return 'system'
        default:
            return undefined
    }
}

function inferKind(event: WorkerDevEventInput): string | undefined {
    switch (event.type) {
        case 'context':
            return 'context.snapshot'
        case 'prompt':
            return 'prompt.final'
        case 'slots':
            return 'slots.snapshot'
        case 'budget':
            return 'budget.summary'
        case 'state':
            return 'state.snapshot'
        case 'tools':
            if (event.data?.action === 'toolCall') return 'tool.call'
            if (event.data?.action === 'tool.call') return 'tool.call'
            if (event.data?.action === 'tool.result') return 'tool.result'
            if (event.data?.action === 'tool.error') return 'tool.error'
            if (event.data?.action === 'llm.result') return 'llm.result'
            if (event.data?.action === 'llm.call' || event.data?.action === 'llm.run') {
                return event.data?.output ? 'llm.result' : 'llm.call'
            }
            return 'tools.context'
        case 'memory':
            return `memory.${event.data?.action ?? 'event'}`
        case 'console':
            return 'log'
        case 'error':
            return 'error'
        case 'meta':
            return 'meta'
        case 'reload':
            return 'reload'
        case 'status':
            return 'status'
        case 'turn':
            return event.data?.status === 'error'
                ? 'turn.error'
                : event.data?.status === 'done'
                    ? 'turn.done'
                    : 'turn.start'
        default:
            return undefined
    }
}
function emitStatus(data: DevStatusData): void {
    const key = JSON.stringify(data)
    if (key === lastStatusKey) return
    lastStatusKey = key
    emitDevEvent({ type: 'status', data })
}

function patchConsole(): void {
    if (consolePatched) return
    consolePatched = true
    const raw = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    }
    console.log = (...args: unknown[]) => {
        emitDevEvent({ type: 'console', level: 'log', text: formatConsolePayload(args) })
        raw.log(...args)
    }
    console.warn = (...args: unknown[]) => {
        emitDevEvent({ type: 'console', level: 'warn', text: formatConsolePayload(args) })
        raw.warn(...args)
    }
    console.error = (...args: unknown[]) => {
        emitDevEvent({ type: 'console', level: 'error', text: formatConsolePayload(args) })
        raw.error(...args)
    }
}

function snapshotContext(ctx: LoomaContext): ContextSnapshot {
    const historyApi = ctx.history as {
        recent?: (n: number) => Array<{ role: string; content: string | null | undefined }>
        peekRecent?: (n: number) => Array<{ role: string; content: string | null | undefined }>
        debugState?: () => ContextSnapshot['historySelection'] | null
    }
    const previewSource = historyApi.peekRecent
        ? historyApi.peekRecent(6)
        : historyApi.recent
            ? historyApi.recent(6)
            : []
    const historyPreview = previewSource.length > 0
        ? previewSource.map((msg) => ({
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : null,
        }))
        : []
    const historySelection = historyApi.debugState?.() ?? undefined
    return {
        input: ctx.input,
        budget: ctx.budget,
        capabilities: ctx.capabilities,
        model: ctx.model,
        config: ctx.config,
        message: ctx.message,
        historyPreview,
        historySelection,
    }
}

async function ensureStrategy(payload?: StrategyRequestPayload): Promise<StrategyModule> {
    updateDevContext(payload)
    const entryPath = payload?.strategyEntryPath
    if (!entryPath) {
        throw new Error('[strategy-worker] strategy entry_path missing')
    }
    if (loadedStrategy && loadedEntryPath === entryPath) return loadedStrategy
    loadedStrategy = await loadStrategyModule(entryPath)
    loadedEntryPath = entryPath
    metaEmitted = false
    emitStatus({ active: true, fallbackUsed: false, source: 'worker' })
    if (devMode && loadedStrategy?.meta && !metaEmitted) {
        emitDevEvent({
            type: 'meta',
            data: {
                name: loadedStrategy.meta.name,
                description: loadedStrategy.meta.description,
                version: loadedStrategy.meta.version,
            },
        })
        metaEmitted = true
    }
    if (loadedStrategy.hooks.onInit) {
        const ctx = payload?.conversationId
            ? await buildContext({
                conversationId: payload.conversationId,
                turnId: payload.turnId,
                model: payload.model,
                strategyId: payload.strategyId,
                configValues: payload.configValues,
                dev: { emit: (event) => emitDevEvent({ ...event, phase: resolvePhaseForEvent(event, 'context') }) },
            })
            : null
        if (ctx) {
            lastCtx = ctx
            emitDevEvent({ type: 'context', data: snapshotContext(ctx), phase: 'context' })
            await loadedStrategy.hooks.onInit(ctx)
        }
    }
    return loadedStrategy
}

async function defaultToolCall(ctx: { conversationId: string; turnId: string; call: { id: string; name: string; args?: unknown } }): Promise<string> {
    const name = ctx.call?.name
    if (!name) return 'Error: tool name missing'
    const res = await hostClient.executeTool({
        call: ctx.call,
        conversationId: ctx.conversationId,
        turnId: ctx.turnId,
    })
    if (!res.ok) {
        return `Error: ${res.error?.message ?? 'tool failed'}`
    }
    return res.resultText ?? ''
}

function replyOk(id: string, result?: unknown) {
    const msg: StrategyWorkerResponse = { id, ok: true, result }
    parentPort?.postMessage(msg)
}

function replyError(id: string, err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    const msg: StrategyWorkerResponse = {
        id,
        ok: false,
        error: { message: error.message, stack: error.stack },
    }
    parentPort?.postMessage(msg)
}

    if (!parentPort) {
        throw new Error('strategy worker must be started with a parentPort')
    }

parentPort.on('message', async (req: StrategyWorkerRequest | WorkerEnvelope) => {
    if (isWorkerEnvelope(req)) {
        return
    }
    if (!isStrategyWorkerRequest(req)) {
        return
    }
    try {
        switch (req.type) {
            case 'init':
                replyOk(req.id, { ok: true })
                return
            case 'contextBuild': {
                const payload = (req.payload ?? {}) as StrategyRequestPayload
                updateDevContext(payload)
                const strategy = await ensureStrategy(payload)
                if (!payload.conversationId || !payload.turnId || !payload.model) {
                    throw new Error('[strategy-worker] invalid contextBuild payload')
                }
                const ctx = await buildContext({
                    conversationId: payload.conversationId,
                    turnId: payload.turnId,
                    model: payload.model,
                    strategyId: payload.strategyId,
                    configValues: payload.configValues,
                    dev: { emit: (event) => emitDevEvent({ ...event, phase: resolvePhaseForEvent(event, 'context') }) },
                })
                lastCtx = ctx
                emitDevEvent({ type: 'context', data: snapshotContext(ctx), phase: 'context' })
                const rawResult = await strategy.hooks.onContextBuild(ctx)
                const result = normalizeContextBuildResult(rawResult)
                if (result?.prompt?.messages) {
                    const historySelection = (ctx.history as {
                        debugState?: () => {
                            selectedCount: number
                            originalCount: number
                            historyClipReason?: string
                            historyDroppedMessageIds?: string[]
                        } | null
                    }).debugState?.()
                    if (historySelection) {
                        result.meta = {
                            ...(result.meta ?? {}),
                            historyOriginalCount: historySelection.originalCount,
                            historySelectedCount: historySelection.selectedCount,
                            historyClipReason: historySelection.historyClipReason,
                            historyDroppedMessageIds: historySelection.historyDroppedMessageIds,
                        }
                    }
                    emitDevEvent({
                        type: 'prompt',
                        phase: 'context',
                        data: {
                            messages: result.prompt.messages,
                            meta: result.meta,
                        },
                    })
                }
                if (result?.tools) {
                    emitDevEvent({
                        type: 'tools',
                        phase: 'context',
                        data: {
                            action: 'context',
                            input: { tools: result.tools },
                        },
                    })
                }
                replyOk(req.id, result)
                return
            }
            case 'turnEnd':
                {
                    const payload = (req.payload ?? {}) as StrategyRequestPayload
                    updateDevContext(payload)
                    const strategy = await ensureStrategy(payload)
                    if (strategy.hooks.onTurnEnd) {
                        const ctx = await buildContext({
                            conversationId: payload.conversationId,
                            turnId: payload.turnId,
                            model: payload.model,
                            strategyId: payload.strategyId,
                            configValues: payload.configValues,
                            message: payload.message ?? null,
                            dev: { emit: (event) => emitDevEvent({ ...event, phase: resolvePhaseForEvent(event, 'turnEnd') }) },
                        })
                        lastCtx = ctx
                        emitDevEvent({ type: 'context', data: snapshotContext(ctx), phase: 'turnEnd' })
                        await strategy.hooks.onTurnEnd(ctx)
                    }
                }
                replyOk(req.id, { ok: true })
                return
            case 'replayTurn': {
                const payload = (req.payload ?? {}) as StrategyReplayTurnInput & StrategyRequestPayload
                updateDevContext(payload)
                const strategy = await ensureStrategy(payload)
                if (strategy.hooks.onReplayTurn) {
                    await strategy.hooks.onReplayTurn(payload)
                }
                replyOk(req.id, { ok: true })
                return
            }
            case 'toolCall': {
                const payload = (req.payload ?? {}) as StrategyRequestPayload & {
                    conversationId: string
                    turnId: string
                    call: { id: string; name: string; args?: unknown }
                }
                updateDevContext(payload)
                const strategy = await ensureStrategy(payload)
                const ctx = await buildContext({
                    conversationId: payload.conversationId,
                    turnId: payload.turnId,
                    model: payload.model,
                    strategyId: payload.strategyId,
                    configValues: payload.configValues,
                    message: payload.message ?? null,
                    dev: { emit: (event) => emitDevEvent({ ...event, phase: resolvePhaseForEvent(event, 'turnEnd') }) },
                })
                lastCtx = ctx
                emitDevEvent({
                    type: 'tools',
                    phase: 'turnEnd',
                    data: {
                        action: 'tool.call',
                        input: payload.call,
                    },
                })
                try {
                    const resultText = strategy.hooks.onToolCall
                        ? await strategy.hooks.onToolCall(ctx, payload.call)
                        : await defaultToolCall(payload)
                    emitDevEvent({
                        type: 'tools',
                        phase: 'turnEnd',
                        data: {
                            action: 'tool.result',
                            input: payload.call,
                            output: { resultText },
                        },
                    })
                    replyOk(req.id, resultText)
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    emitDevEvent({
                        type: 'tools',
                        phase: 'turnEnd',
                        data: {
                            action: 'tool.error',
                            input: payload.call,
                            error: msg,
                        },
                    })
                    throw err
                }
                return
            }
            case 'dispose':
                if (loadedStrategy?.hooks.onCleanup) {
                    if (lastCtx) {
                        await loadedStrategy.hooks.onCleanup(lastCtx)
                    }
                }
                replyOk(req.id, { ok: true })
                process.exit(0)
                return
            default:
                throw new Error(`unknown request type: ${String(req.type)}`)
        }
    } catch (err) {
        if (loadedStrategy?.hooks.onError) {
            try {
                const phase = req.type ?? 'unknown'
                if (lastCtx) {
                    await loadedStrategy.hooks.onError(lastCtx, err, phase)
                }
            } catch {
                // ignore onError failures
            }
        }
        const reqType = req.type
        if (reqType === 'contextBuild') {
            const message = err instanceof Error ? err.message : String(err)
            emitStatus({ active: false, fallbackUsed: true, message, source: 'worker' })
        }
        emitDevEvent({
            type: 'error',
            phase: (() => {
                const raw = req.type ?? 'unknown'
                if (raw === 'contextBuild') return 'context'
                if (raw === 'turnEnd') return 'turnEnd'
                if (raw === 'toolCall') return 'toolCall'
                if (raw === 'replayTurn') return 'replay'
                if (raw === 'init') return 'init'
                return 'unknown'
            })() as DevErrorPhase,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
        })
        replyError(req.id, err)
    }
})
