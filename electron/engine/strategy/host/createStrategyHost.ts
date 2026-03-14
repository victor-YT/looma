import type { Database } from 'better-sqlite3'
import type {
    StrategyContextBuildResult,
    StrategyReplayTurnInput,
    StrategyRecord,
    UIMessage,
} from '../types'
import type { LLMModelConfig } from '../../llm/types'
import { getToolTimeoutMs } from '../../../workers/strategy/WorkerManager'
import { getConversationStrategyScope } from '../../../core/strategy/strategyScope'
import { getStrategyOrFallback } from '../../../core/strategy/strategyRegistry'
import { buildStrategyRuntimeConfig } from '../../../core/strategy/strategyConfig'
import { listStrategyState } from '../../../core/strategy/stateStore'
import { getModelById } from '../../../core/models/modelRegistry'
import { LLMRunner } from '../../llm/llmRunner'
import { applyContextStats } from './contextBuild'
import { hashMessages, logStrategyTrace } from './logging'
import { normalizeToolCalls, toBlueprintToolCall } from './tooling'
import { contextStore } from '../../../core/context'
import { emitStrategyDevEvent } from '../dev/devEventBus'
import { shouldEmitDevEvents } from '../dev/isDevStrategy'
import { createStrategyWorkerManager, excludeMessageById, historyKey } from './strategyHostHandlers'

const historyCache = new Map<string, UIMessage[]>()
const llmRunner = new LLMRunner()
const workerManager = createStrategyWorkerManager({ historyCache, llmRunner })

export function disposeStrategyWorkers(conversationIds: string[]): void {
    for (const id of conversationIds) {
        workerManager.disposeWorker(id)
    }
}

export class StrategyHost {
    constructor(private db: Database) {}

    private resolveStrategyRecord(conversationId: string): StrategyRecord {
        return getStrategyOrFallback(this.db, { conversationId }).strategy
    }

    async runContextBuild(args: {
        conversationId: string
        turnId: string
        model: LLMModelConfig
        history: UIMessage[]
    }): Promise<StrategyContextBuildResult> {
        const scope = getConversationStrategyScope(this.db, args.conversationId)
        if (process.env.NODE_ENV !== 'production') {
            console.log('[strategy] active', { key: scope.strategyKey, conversationId: args.conversationId })
        }

        const key = historyKey(args.conversationId, args.turnId)
        const strategyRecord = this.resolveStrategyRecord(args.conversationId)
        const configValues = buildStrategyRuntimeConfig(this.db, strategyRecord)
        const isDev = shouldEmitDevEvents({
            strategyId: strategyRecord.id,
            source: strategyRecord.source ?? null,
        })
        const turnRow = this.db.prepare(`
            SELECT user_message_id
            FROM turns
            WHERE id = ? AND conversation_id = ?
        `).get(args.turnId, args.conversationId) as { user_message_id?: string } | undefined
        const historyForContext = excludeMessageById(args.history, turnRow?.user_message_id)
        historyCache.set(key, historyForContext)
        try {
            if (isDev) {
                const now = Date.now()
                emitStrategyDevEvent({
                    type: 'turn',
                    conversationId: args.conversationId,
                    strategyId: strategyRecord.id,
                    turnId: args.turnId,
                    timestamp: now,
                    ts: now,
                    phase: 'system',
                    kind: 'turn.start',
                    data: { status: 'start' },
                })
            }
            if (process.env.NODE_ENV !== 'production') {
                console.log('[strategy][worker] contextBuild', {
                    conversationId: args.conversationId,
                    turnId: args.turnId,
                })
            }
            const result = await workerManager.requestContextBuild(args.conversationId, {
                conversationId: args.conversationId,
                turnId: args.turnId,
                model: args.model,
                scope,
                strategyId: strategyRecord.id,
                strategyEntryPath: strategyRecord.entry_path,
                configValues,
                devMode: isDev,
            })
            const built = result as StrategyContextBuildResult
            await applyContextStats(args, built)
            logStrategyTrace(scope, args, built)
            if (isDev) {
                const stats = contextStore.get(args.conversationId)
                if (stats) {
                    const now = Date.now()
                    emitStrategyDevEvent({
                        type: 'budget',
                        conversationId: args.conversationId,
                        strategyId: strategyRecord.id,
                        turnId: args.turnId,
                        timestamp: now,
                        ts: now,
                        phase: 'context',
                        kind: 'budget.summary',
                        data: stats,
                    })
                }
                const stateEntries = listStrategyState(this.db, {
                    strategyId: strategyRecord.id,
                    scopeType: 'conversation',
                    scopeId: args.conversationId,
                })
                const now = Date.now()
                emitStrategyDevEvent({
                    type: 'state',
                    conversationId: args.conversationId,
                    strategyId: strategyRecord.id,
                    turnId: args.turnId,
                    timestamp: now,
                    ts: now,
                    phase: 'context',
                    kind: 'state.snapshot',
                    data: { entries: stateEntries },
                })
                emitStrategyDevEvent({
                    type: 'status',
                    conversationId: args.conversationId,
                    strategyId: strategyRecord.id,
                    turnId: args.turnId,
                    timestamp: now,
                    ts: now,
                    phase: 'system',
                    kind: 'status',
                    data: {
                        active: true,
                        fallbackUsed: false,
                        source: 'host',
                    },
                })
            }
            if (process.env.NODE_ENV !== 'production') {
                const hash = hashMessages(built.prompt?.messages ?? [])
                console.log('[strategy] prompt', {
                    conversationId: args.conversationId,
                    turnId: args.turnId,
                    messages: built.prompt?.messages?.length ?? 0,
                    hash,
                })
            }
            return built
        } catch (err) {
            // Fallback policy: worker-only; on failure return raw history (no trim/slots) to avoid drift.
            console.warn('[strategy] worker contextBuild failed, fallback to minimal', err)
            if (isDev) {
                const message = err instanceof Error ? err.message : String(err)
                const now = Date.now()
                emitStrategyDevEvent({
                    type: 'status',
                    conversationId: args.conversationId,
                    strategyId: strategyRecord.id,
                    turnId: args.turnId,
                    timestamp: now,
                    ts: now,
                    phase: 'system',
                    kind: 'status',
                    data: {
                        active: false,
                        fallbackUsed: true,
                        message,
                        source: 'host',
                    },
                })
                emitStrategyDevEvent({
                    type: 'error',
                    phase: 'context',
                    message,
                    stack: err instanceof Error ? err.stack : undefined,
                    conversationId: args.conversationId,
                    strategyId: strategyRecord.id,
                    turnId: args.turnId,
                    timestamp: now,
                    ts: now,
                    kind: 'error',
                })
                emitStrategyDevEvent({
                    type: 'turn',
                    conversationId: args.conversationId,
                    strategyId: strategyRecord.id,
                    turnId: args.turnId,
                    timestamp: now,
                    ts: now,
                    phase: 'system',
                    kind: 'turn.error',
                    data: { status: 'error', reason: 'contextBuild', message },
                })
            }
            const fallback: StrategyContextBuildResult = { prompt: { messages: historyForContext ?? [] } }
            await applyContextStats(args, fallback)
            logStrategyTrace(scope, args, fallback)
            if (process.env.NODE_ENV !== 'production') {
                const hash = hashMessages(fallback.prompt?.messages ?? [])
                console.log('[strategy] prompt:fallback', {
                    conversationId: args.conversationId,
                    turnId: args.turnId,
                    messages: fallback.prompt?.messages?.length ?? 0,
                    hash,
                })
            }
            return fallback
        } finally {
            historyCache.delete(key)
        }
    }

    async runTurnEnd(args: {
        conversationId: string
        turnId: string
        messageId: string
        status: string
    }): Promise<void> {
        try {
            const scope = getConversationStrategyScope(this.db, args.conversationId)
            const strategyRecord = this.resolveStrategyRecord(args.conversationId)
            const configValues = buildStrategyRuntimeConfig(this.db, strategyRecord)
            const isDev = shouldEmitDevEvents({
                strategyId: strategyRecord.id,
                source: strategyRecord.source ?? null,
            })
            const row = this.db.prepare(`
                SELECT id, content, status, finish_reason, model,
                       usage_tokens_prompt, usage_tokens_completion, error_code, content_parts
                FROM messages WHERE id = ?
            `).get(args.messageId) as {
                id?: string
                content?: string | null
                status?: string | null
                finish_reason?: string | null
                model?: string | null
                usage_tokens_prompt?: number | null
                usage_tokens_completion?: number | null
                error_code?: string | null
                content_parts?: string | null
            } | undefined
            const modelConfig = row?.model ? getModelById(row.model) : undefined
            const finishReason = row?.finish_reason === 'stop'
                || row?.finish_reason === 'length'
                || row?.finish_reason === 'tool_calls'
                || row?.finish_reason === 'error'
                ? row.finish_reason
                : undefined
            const status = row?.status === 'completed'
                ? 'completed'
                : row?.status === 'stopped'
                    ? 'aborted'
                    : row?.status === 'error'
                        ? 'error'
                        : null
            const toolCalls = (() => {
                if (!row?.content_parts) return undefined
                try {
                    const parsed = JSON.parse(row.content_parts) as { tool_calls?: unknown }
                    const calls = normalizeToolCalls(parsed?.tool_calls)
                    return calls.length ? calls.map(call => toBlueprintToolCall(call)) : undefined
                } catch {
                    return undefined
                }
            })()
            await workerManager.requestTurnEnd(args.conversationId, {
                ...args,
                scope,
                strategyId: strategyRecord.id,
                strategyEntryPath: strategyRecord.entry_path,
                model: modelConfig,
                configValues,
                devMode: isDev,
                message: {
                    id: row?.id ?? args.messageId,
                    role: 'assistant',
                    content: typeof row?.content === 'string' && row.content.length > 0 ? row.content : null,
                    finishReason,
                    toolCalls,
                },
            })
            if (isDev) {
                const stateEntries = listStrategyState(this.db, {
                    strategyId: strategyRecord.id,
                    scopeType: 'conversation',
                    scopeId: args.conversationId,
                })
                const now = Date.now()
                emitStrategyDevEvent({
                    type: 'state',
                    conversationId: args.conversationId,
                    strategyId: strategyRecord.id,
                    turnId: args.turnId,
                    timestamp: now,
                    ts: now,
                    phase: 'turnEnd',
                    kind: 'state.snapshot',
                    data: { entries: stateEntries },
                })
                emitStrategyDevEvent({
                    type: 'turn',
                    conversationId: args.conversationId,
                    strategyId: strategyRecord.id,
                    turnId: args.turnId,
                    timestamp: now,
                    ts: now,
                    phase: 'system',
                    kind: status === 'error' ? 'turn.error' : 'turn.done',
                    data: {
                        status: status === 'error' ? 'error' : 'done',
                        reason: args.status,
                    },
                })
            }
        } catch (err) {
            console.warn('[strategy] worker turnEnd failed, ignored', err)
            try {
                const strategyRecord = this.resolveStrategyRecord(args.conversationId)
                if (shouldEmitDevEvents({
                    strategyId: strategyRecord.id,
                    source: strategyRecord.source ?? null,
                })) {
                    const now = Date.now()
                    emitStrategyDevEvent({
                        type: 'error',
                        phase: 'turnEnd',
                        message: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        conversationId: args.conversationId,
                        strategyId: strategyRecord.id,
                        turnId: args.turnId,
                        timestamp: now,
                        ts: now,
                        kind: 'error',
                    })
                    emitStrategyDevEvent({
                        type: 'turn',
                        conversationId: args.conversationId,
                        strategyId: strategyRecord.id,
                        turnId: args.turnId,
                        timestamp: now,
                        ts: now,
                        phase: 'system',
                        kind: 'turn.error',
                        data: {
                            status: 'error',
                            reason: 'turnEnd',
                            message: err instanceof Error ? err.message : String(err),
                        },
                    })
                }
            } catch {
                // ignore emit failures
            }
        }
    }

    async runReplayTurn(args: StrategyReplayTurnInput): Promise<void> {
        try {
            const strategyRecord = this.resolveStrategyRecord(args.scope.conversationId)
            await workerManager.requestReplayTurn(args.scope.conversationId, {
                ...args,
                strategyId: strategyRecord.id,
                strategyEntryPath: strategyRecord.entry_path,
                devMode: shouldEmitDevEvents({
                    strategyId: strategyRecord.id,
                    source: strategyRecord.source ?? null,
                }),
            })
        } catch (err) {
            console.warn('[strategy] worker replayTurn failed, ignored', err)
        }
    }

    async runToolCall(args: {
        conversationId: string
        turnId: string
        messageId?: string
        call: { id: string; name: string; args?: unknown }
    }): Promise<string> {
        const t0 = Date.now()
        const timeoutMs = getToolTimeoutMs(args.call.name)
        const argsSummary = (() => {
            const raw = args.call.args
            if (typeof raw === 'string') return { kind: 'string', length: raw.length }
            if (raw && typeof raw === 'object') return { kind: 'object', keys: Object.keys(raw as Record<string, unknown>).slice(0, 6) }
            return { kind: typeof raw }
        })()
        console.log('[toolcall] start', { tool: args.call.name, timeoutMs, argsSummary })
        try {
            const scope = getConversationStrategyScope(this.db, args.conversationId)
            const strategyRecord = this.resolveStrategyRecord(args.conversationId)
            const configValues = buildStrategyRuntimeConfig(this.db, strategyRecord)
            const modelRow = this.db.prepare(`SELECT model FROM conversations WHERE id = ?`)
                .get(args.conversationId) as { model?: string | null } | undefined
            const model = modelRow?.model ? getModelById(modelRow.model) : undefined
            const result = await workerManager.requestToolCall(args.conversationId, {
                ...args,
                scope,
                strategyId: strategyRecord.id,
                strategyEntryPath: strategyRecord.entry_path,
                model,
                configValues,
                devMode: shouldEmitDevEvents({
                    strategyId: strategyRecord.id,
                    source: strategyRecord.source ?? null,
                }),
                message: {
                    id: args.messageId ?? `${args.turnId}:${args.call.id}`,
                    role: 'assistant',
                    content: null,
                    finishReason: 'tool_calls',
                    toolCalls: [toBlueprintToolCall(args.call)],
                },
            })
            if (typeof result === 'string') return result
            const parsed = result as { resultText?: string; ok?: boolean; error?: { message?: string; type?: string; tool?: string; timeoutMs?: number } }
            if (parsed?.ok === false) {
                const ms = Date.now() - t0
                if (parsed.error?.type === 'timeout') {
                    console.log('[toolcall][timeout]', { tool: args.call.name, timeoutMs: parsed.error.timeoutMs })
                }
                console.log('[toolcall] done', { tool: args.call.name, ms, status: parsed.error?.type ?? 'error', error: parsed.error })
                return `Error: ${parsed.error?.message ?? 'tool failed'}`
            }
            const text = typeof parsed?.resultText === 'string' ? parsed.resultText : ''
            if (process.env.DEBUG_TOOLS === '1') {
                console.log('[TOOLS][result]', {
                    name: args.call.name,
                    length: text.length,
                    preview: text.slice(0, 200),
                    isError: /^Error:/i.test(text),
                })
            }
            const ms = Date.now() - t0
            console.log('[toolcall] done', { tool: args.call.name, ms, status: 'ok' })
            return text
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.warn('[strategy] worker toolCall failed, fallback to error', err)
            const ms = Date.now() - t0
            console.log('[toolcall] done', { tool: args.call.name, ms, status: 'error', error: msg })
            return `Error: ${msg}`
        }
    }

    // Tool allowlist is handled by ToolRegistry.
}
