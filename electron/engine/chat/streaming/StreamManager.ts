// electron/engine/chat/streaming/StreamManager.ts
import { EventEmitter } from 'node:events'
import { getDB as realGetDB } from '../../../db'
import { TurnWriter } from '../../../core/turnWriter'
import { LLMRunner } from '../../llm/llmRunner'
import { callLLMUniversalNonStream, getProviderCtxSource } from '../../../llm'
import { getModelById, getProviderConfigForModel, resolveModelConfig } from '../../../core/models/modelRegistry'
import { maybeAutoTitleConversation } from '../../../core/conversation/autoTitle'
import { StrategyHost } from '../../strategy/host/createStrategyHost'
import { emitStrategyDevEvent } from '../../strategy/dev/devEventBus'
import { getEffectiveToolsForRun, getEffectiveStrategies } from '../../settings/services/effectiveConfig'
import { getWebSearchSettings } from '../../settings/services/settingsStore'
import { shouldRunTurnEndForMode } from '../../../core/flow/turnMode'
import {
    AttachmentCapabilityError,
    summarizeAttachmentError,
} from '../../../core/attachments/validateAttachmentsBeforeSend'
import { isRetryableFileReferenceError } from '../../../core/attachments/fileRefRetryPolicy'
import { shouldEmitDevEvents } from '../../strategy/dev/isDevStrategy'
import { log, logEveryN } from '../../../core/logging/runtimeLogger'
import {
    prepareMessagesForStream,
    refreshProviderFileRefs,
    type HistoryScanSummary,
    type PayloadSummary,
    type PreparedFileSummary,
} from './preparedMessageService'
import { StreamTaskRegistry } from './streamTaskRegistry'
import { StreamEventPublisher } from './streamEventPublisher'
import type {
    DoneReason,
    StreamTimingTrace,
    TurnRunMode,
    UIMessage,
} from '../types'
import type { TurnAttachment } from '../../attachments/types'
import type { LLMModelConfig, ToolDef } from '../../llm/types'
import type { StrategyDevEvent } from '../../strategy/types'

type DB = ReturnType<typeof realGetDB>
type Deps = {
    getDB: () => DB
    llmRunner: LLMRunner
    flushEveryMs: number
}

export type StartParams = {
    conversationId: string
    turnId: string            // Current turn ID (required)
    replyId: string           // Active assistant message ID
    model: LLMModelConfig
    history: UIMessage[]
    parentUserId: string      // Current user message ID (fallback placeholder support)
    webContentsId?: number
    trace?: StreamTimingTrace
    traceId?: string
    forceWebSearch?: boolean
    attachments?: TurnAttachment[]
    inputText?: string
    mode?: TurnRunMode
    contextMeta?: {
        trimmed?: boolean
        inputTokenEstimate?: number
        slotCount?: number
        historyOriginalCount?: number
        historySelectedCount?: number
        historyClipReason?: string
        historyDroppedMessageIds?: string[]
    }
}

type SearchMode = 'off' | 'native' | 'tool'

function resolveSearchMode(args: {
    searchEnabled: boolean
    model: LLMModelConfig
}): SearchMode | 'unsupported' {
    if (!args.searchEnabled) return 'off'
    if (args.model.capabilities?.nativeSearch === true) return 'native'
    if (args.model.capabilities?.tools === true) return 'tool'
    return 'unsupported'
}

export class StreamManager extends EventEmitter {
    private readonly deps: Deps
    private readonly taskRegistry = new StreamTaskRegistry()
    private readonly eventPublisher = new StreamEventPublisher(this)

    constructor(deps?: Partial<Deps>) {
        super()
        this.deps = { getDB: realGetDB, llmRunner: new LLMRunner(), flushEveryMs: 400, ...deps }
    }

    /** Whether the conversation is busy (single-lane execution). */
    isConversationBusy = (conversationId: string) => {
        return this.taskRegistry.isConversationBusy(conversationId)
    }

    /** Start a stream (idempotent + placeholder fallback + full trace logging). */
    start = async (p: StartParams): Promise<void> => {
        const {
            conversationId,
            turnId,
            replyId,
            model,
            history,
            parentUserId,
            webContentsId,
            forceWebSearch,
            attachments,
            inputText,
            contextMeta,
            traceId: inputTraceId,
            mode,
        } = p
        const traceId = inputTraceId ?? `${conversationId}:${turnId}:${replyId}`
        const runMode: TurnRunMode = mode ?? 'normal'
        const db = this.deps.getDB()
        const turnWriter = new TurnWriter(db)
        const strategyHost = new StrategyHost(db)
        const trace: StreamTimingTrace = p.trace ?? { t0: Date.now() }
        const t0 = trace.t0
        const streamLog = (
            level: 'debug' | 'info' | 'warn' | 'error',
            phase: string,
            extra?: Record<string, unknown>,
            opts?: { debugFlag?: string },
        ) => {
            log(level, '[STREAM]', {
                traceId,
                phase,
                conversationId,
                turnId,
                replyId,
                ...(extra ?? {}),
            }, { debugFlag: opts?.debugFlag })
        }

        streamLog('info', 'ENTER', { modelId: model.id, historyCount: history.length, mode: runMode })

        // A. Idempotency: already running
        if (this.taskRegistry.has(replyId)) {
            streamLog('warn', 'ALREADY_RUNNING_SKIP')
            return
        }

        // B. Idempotency: DB row already finalized
        const existing = db.prepare(`
            SELECT status, type, model, LENGTH(content) AS len
            FROM messages WHERE id = ?
        `).get(replyId) as { status?: string; type?: string; len?: number; model?: string | null } | undefined

        if (existing && existing.status !== 'progress') {
            const row = db.prepare(
                `SELECT content FROM messages WHERE id = ?`
            ).get(replyId) as { content?: string } | undefined
            streamLog('info', 'ALREADY_FINALIZED_EMIT_DONE', { contentLen: row?.content?.length ?? 0 })
            const existingModel = existing?.model ?? undefined
            const existingCfg = existingModel ? getModelById(existingModel) : undefined
            this.eventPublisher.emitDone({
                wcId: webContentsId,
                conversationId,
                turnId,
                replyId,
                reason: 'already_finalized',
                elapsedMs: 0,
                finalContent: row?.content ?? '',
                modelId: existingModel ?? undefined,
                providerId: existingCfg?.provider,
                traceId,
            })
            return
        }

        // C. Fallback placeholder (usually inserted by the handler; this is just a safeguard)
        if (!existing) {
            streamLog('warn', 'PLACEHOLDER_PATCH')
            turnWriter.ensureAssistantPlaceholder({
                assistantMessageId: replyId,
                conversationId,
                turnId,
                model: model.id ?? null,
                parentUserId,
                timestampMs: t0,
            })
        }

        // D. Register the task
        const abortController = new AbortController()
        this.taskRegistry.create({
            conversationId,
            replyId,
            mode: runMode,
            startedAt: t0,
            abortController,
            trace,
            webContentsId,
        })
        this.taskRegistry.clearDoneSignal(replyId)

        // E. Notify the renderer: started (includes turn_id)
        const target = this.eventPublisher.emitStarted({
            webContentsId,
            payload: {
                conversation_id: conversationId,
                reply_id: replyId,
                turn_id: turnId,
                model_id: model.id,
                provider_id: model.provider,
            },
        })
        streamLog('info', 'STREAM_STARTED')
        streamLog('debug', 'STARTED_SENT', undefined, { debugFlag: 'DEBUG_STREAM_CHUNKS' })

        // F. Start streaming
        let chunks = 0
        let fullText = ''
        let endReason: DoneReason = 'stop'
        const searchMode = resolveSearchMode({
            searchEnabled: forceWebSearch === true,
            model,
        })

        if (searchMode === 'unsupported') {
            const summary = 'Search is not supported for this model'
            const ts = Date.now()
            turnWriter.finalizeTurn({
                turnId,
                assistantMessageId: replyId,
                status: 'error',
                finishReason: 'error',
                finalContent: summary,
                timestampMs: ts,
                error: { code: 'SEARCH_UNSUPPORTED', message: summary },
            })
            const wcId = this.taskRegistry.consumeWebContentsId(replyId)
            this.taskRegistry.delete(replyId)
            this.eventPublisher.emitDone({
                wcId,
                conversationId,
                turnId,
                replyId,
                reason: 'error',
                elapsedMs: ts - t0,
                finalContent: summary,
                modelId: model.id,
                providerId: model.provider,
                traceId,
                error: { code: 'SEARCH_UNSUPPORTED', message: summary },
            })
            return
        }

        const TOOLS_DISABLED = false
        const convRow = db.prepare(`SELECT strategy_id FROM conversations WHERE id = ?`)
            .get(conversationId) as { strategy_id?: string | null } | undefined
        const strategyRow = convRow?.strategy_id
            ? db.prepare(`SELECT id, source FROM strategies WHERE id = ?`)
                .get(convRow.strategy_id) as { id?: string; source?: string } | undefined
            : undefined
        const devStrategyId = strategyRow?.id ?? convRow?.strategy_id ?? null
        const isDev = shouldEmitDevEvents({
            strategyId: devStrategyId,
            source: strategyRow?.source ?? null,
        })
        type StrategyDevEventInput = Partial<StrategyDevEvent> & {
            type: StrategyDevEvent['type']
            ts?: number
        }
        const emitDevEvent = (event: StrategyDevEventInput) => {
            if (!isDev || !devStrategyId) return
            const now = Date.now()
            emitStrategyDevEvent({
                ...event,
                conversationId,
                strategyId: devStrategyId,
                turnId,
                timestamp: now,
                ts: event.ts ?? now,
            } as StrategyDevEvent)
        }
        let toolDefs: ToolDef[] = []
        if (!TOOLS_DISABLED && searchMode === 'tool') {
            try {
                toolDefs = await getEffectiveToolsForRun(db, {
                    conversationId,
                    strategyId: convRow?.strategy_id ?? undefined,
                })
            } catch (err) {
                streamLog('warn', 'TOOLS_LIST_FAILED', {
                    error: err instanceof Error ? err.message : String(err),
                })
                toolDefs = []
            }
        }
        streamLog('debug', 'TOOLS_RAW', { tools: toolDefs.map(tool => tool.name) }, { debugFlag: 'DEBUG_TOOLS' })
        toolDefs = toolDefs.filter(tool => tool.name === 'builtin.web_search' || tool.name === 'builtin.web_fetch')
        streamLog('debug', 'TOOLS_FILTERED', { tools: toolDefs.map(tool => tool.name) }, { debugFlag: 'DEBUG_TOOLS' })
        if (searchMode === 'tool' && !toolDefs.some(tool => tool.name === 'builtin.web_search')) {
            const webSearch = getWebSearchSettings(db)
            const strategies = getEffectiveStrategies(db)
            const activeStrategy = strategies.find((s) => s.id === (convRow?.strategy_id ?? '')) ?? strategies[0]
            const allowlist = activeStrategy?.manifest?.allowlist ?? []
            const allowsWebSearch = allowlist.length === 0
                ? true
                : allowlist.some((rule) => {
                    if (rule.endsWith('*')) return 'builtin.web_search'.startsWith(rule.slice(0, -1))
                    return rule === 'builtin.web_search'
                })
            const reason = !webSearch.enabled
                ? 'web_search disabled'
                : !allowsWebSearch
                    ? 'allowlist blocked'
                    : 'tool filtered'
            const summary = `Search is unavailable because platform web_search is not available (${reason})`
            const ts = Date.now()
            turnWriter.finalizeTurn({
                turnId,
                assistantMessageId: replyId,
                status: 'error',
                finishReason: 'error',
                finalContent: summary,
                timestampMs: ts,
                error: { code: 'SEARCH_TOOL_UNAVAILABLE', message: summary },
            })
            const wcId = this.taskRegistry.consumeWebContentsId(replyId)
            this.taskRegistry.delete(replyId)
            this.eventPublisher.emitDone({
                wcId,
                conversationId,
                turnId,
                replyId,
                reason: 'error',
                elapsedMs: ts - t0,
                finalContent: summary,
                modelId: model.id,
                providerId: model.provider,
                traceId,
                error: { code: 'SEARCH_TOOL_UNAVAILABLE', message: summary },
            })
            return
        }
        const allowedToolNames = new Set(toolDefs.map(tool => tool.name))
        const onToolCall = toolDefs.length
            ? async (call: { id: string; name: string; args?: unknown }) => {
                streamLog('debug', 'TOOL_CALL_RECEIVED', { name: call.name }, { debugFlag: 'DEBUG_TOOLS' })
                emitDevEvent({
                    type: 'tools',
                    phase: 'turnEnd',
                    kind: 'tool.call',
                    data: { action: 'tool.call', input: call },
                })
                if (!allowedToolNames.has(call.name)) {
                    streamLog('warn', 'TOOL_CALL_BLOCKED', { name: call.name })
                    emitDevEvent({
                        type: 'tools',
                        phase: 'turnEnd',
                        kind: 'tool.error',
                        data: { action: 'tool.error', input: call, error: 'tool not allowed' },
                    })
                    return `Error: tool not allowed (${call.name})`
                }
                const startedAt = Date.now()
                try {
                    const result = await strategyHost.runToolCall({ conversationId, turnId, messageId: replyId, call })
                    streamLog('debug', 'TOOL_EXECUTED', {
                        name: call.name,
                        ms: Date.now() - startedAt,
                    }, { debugFlag: 'DEBUG_TOOLS' })
                    emitDevEvent({
                        type: 'tools',
                        phase: 'turnEnd',
                        kind: 'tool.result',
                        data: { action: 'tool.result', input: call, output: { length: result.length } },
                    })
                    return result
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    streamLog('warn', 'TOOL_FAILED', {
                        name: call.name,
                        ms: Date.now() - startedAt,
                        error: msg,
                    })
                    emitDevEvent({
                        type: 'tools',
                        phase: 'turnEnd',
                        kind: 'tool.error',
                        data: { action: 'tool.error', input: call, error: msg },
                    })
                    throw err
                }
            }
            : undefined
        log('info', '[TOOLS_FINAL]', {
            traceId,
            conversationId,
            turnId,
            replyId,
            toolCount: toolDefs.length,
            tools: toolDefs.map(tool => tool.name),
        })

        const ctxSource = getProviderCtxSource(model.provider)
        if (searchMode === 'tool') {
            emitDevEvent({
                type: 'console',
                level: 'log',
                text: '[websearch] force enabled: injected system instruction',
            })
        } else if (searchMode === 'native') {
            emitDevEvent({
                type: 'console',
                level: 'log',
                text: '[websearch] native search enabled for this model',
            })
        }
        streamLog('info', 'LLM_REQUEST', {
            provider: model.provider,
            modelId: model.id,
            toolCount: toolDefs.length,
            ctxSource,
            searchMode,
        })
        if (model.provider === 'gemini') {
            const providerCfg = getProviderConfigForModel(model.id)
            const apiHost = providerCfg.baseUrl ?? '(default)'
            streamLog('debug', 'GEMINI_RUNTIME', {
                apiHost,
                toolCount: toolDefs.length,
                streamMode: 'sdk',
                nativeSearch: searchMode === 'native',
            }, { debugFlag: 'DEBUG_PROVIDER_PAYLOAD' })
        }

        trace.t_llm_request_start = Date.now()

        const forceInstruction = "本轮必须使用 builtin.web_search 获取实时信息后再回答；如需要网页内容再用 builtin.web_fetch；禁止声称无法联网/无法浏览网页。"
        const strategyMessages = searchMode === 'tool'
            ? [
                {
                    id: `force_web_${Date.now()}`,
                    conversation_id: conversationId,
                    role: 'system',
                    type: 'text',
                    content: forceInstruction,
                    timestamp: Date.now(),
                } as UIMessage,
                ...history,
            ]
            : history
        let callMessages: UIMessage[] = []
        let payloadSummary!: PayloadSummary
        let hasMessageFileParts = false
        let requestAttachments: TurnAttachment[] | undefined
        let requestInputText: string | undefined
        let resolvedModelForFiles: ReturnType<typeof resolveModelConfig> | null = null
        let historyScan!: HistoryScanSummary
        let preparedFileSummary: PreparedFileSummary | undefined
        try {
            const prepared = await prepareMessagesForStream({
                db,
                model,
                strategyMessages,
                parentUserId,
                conversationId,
                inputText,
                attachments,
                traceId,
                signal: abortController.signal,
            })
            callMessages = prepared.callMessages
            payloadSummary = prepared.payloadSummary
            hasMessageFileParts = prepared.hasMessageFileParts
            requestAttachments = prepared.requestAttachments
            requestInputText = prepared.requestInputText
            resolvedModelForFiles = prepared.resolvedModelForFiles
            historyScan = prepared.historyScan
            preparedFileSummary = prepared.preparedFileSummary
        } catch (err) {
            if (err instanceof AttachmentCapabilityError) {
                const summary = summarizeAttachmentError(err)
                const ts = Date.now()
                turnWriter.finalizeTurn({
                    turnId,
                    assistantMessageId: replyId,
                    status: 'error',
                    finishReason: 'error',
                    finalContent: summary,
                    timestampMs: ts,
                    error: { code: err.code, message: summary },
                    contentParts: { attachmentError: err.details },
                })
                const wcId = this.taskRegistry.consumeWebContentsId(replyId)
                this.taskRegistry.delete(replyId)
                this.eventPublisher.emitDone({
                    wcId,
                    conversationId,
                    turnId,
                    replyId,
                    reason: 'error',
                    elapsedMs: ts - t0,
                    finalContent: summary,
                    modelId: model.id,
                    providerId: model.provider,
                    traceId,
                    error: { code: err.code, message: summary, raw: err.details },
                })
                return
            }
            throw err
        }
        emitDevEvent({
            type: 'tools',
            phase: 'llm',
            kind: 'llm.call',
            data: {
                action: 'llm.call',
                input: {
                    model: model.id,
                    provider: model.provider,
                    attachmentTransport: model.capabilities?.attachmentTransport ?? 'none',
                    capabilities: {
                        nativeFiles: model.capabilities?.nativeFiles === true,
                        attachmentTransport: model.capabilities?.attachmentTransport ?? 'none',
                        supportedMimeTypes: model.capabilities?.supportedMimeTypes ?? [],
                        maxFileSizeMB: model.capabilities?.maxFileSizeMB,
                        maxFilesPerTurn: model.capabilities?.maxFilesPerTurn,
                    },
                    messageCount: callMessages.length,
                    historySelectedCount: contextMeta?.historySelectedCount ?? callMessages.length,
                    historyOriginalCount: contextMeta?.historyOriginalCount,
                    historyClipReason: contextMeta?.historyClipReason,
                    historyDroppedMessageIds: contextMeta?.historyDroppedMessageIds,
                    toolCount: toolDefs.length,
                    tools: toolDefs.map((tool) => tool.name),
                    toolsUsed: toolDefs.map((tool) => tool.name),
                    forceWebSearch: forceWebSearch === true,
                    webSearchMode: searchMode,
                    partsCount: payloadSummary.partsCount,
                    attachmentsCount: payloadSummary.attachmentsCount,
                    estimatedTokens: payloadSummary.estimatedTokens,
                    safetyMargin: payloadSummary.safetyMargin,
                },
            },
        })
        log('info', '[ATTACH][HISTORY_SCAN]', {
            traceId,
            conversationId,
            turnId,
            replyId,
            scannedCount: historyScan.scannedCount,
            retainedCount: historyScan.retainedCount,
            droppedCount: historyScan.droppedCount,
            droppedByReason: historyScan.droppedByReason,
            droppedAssetIds: historyScan.droppedAssetIds,
        })
        if (preparedFileSummary) {
            log('info', '[ATTACH][PREPARED_SUMMARY]', {
                traceId,
                conversationId,
                turnId,
                replyId,
                totalFileParts: preparedFileSummary.totalFileParts,
                bytesOkCount: preparedFileSummary.bytesOkCount,
                missingBytesCount: preparedFileSummary.missingBytesCount,
                assetIdsMissingBytes: preparedFileSummary.assetIdsMissingBytes,
            })
        }

        const runStreamOnce = async () => this.deps.llmRunner.stream(
            {
                model: model.id,
                messages: callMessages,
                conversationId,
                turnId,
                replyId,
                traceId,
                signal: abortController.signal,
                tools: toolDefs,
                attachments: requestAttachments,
                inputText: requestInputText,
                searchMode,
            },
            ({ deltaText }) => {
                const task = this.taskRegistry.get(replyId)
                if (!task || task.cancelled) {
                    endReason = 'aborted'
                    streamLog('info', 'ABORT_SEEN_BREAK')
                    throw new Error('Aborted')
                }
                if (!deltaText) return

                fullText += deltaText
                task.buffered += deltaText
                this.flushToDB(replyId)

                chunks++
                trace.chunk_count = chunks
                trace.chunk_chars = (trace.chunk_chars ?? 0) + deltaText.length
                if (!trace.t_first_chunk) {
                    trace.t_first_chunk = Date.now()
                }
                if (process.env.DEBUG_STREAM_CHUNKS === '1' && logEveryN(`${traceId}:chunk`, 25)) {
                    streamLog('debug', 'CHUNK', {
                        n: chunks,
                        len: deltaText.length,
                        acc: fullText.length,
                    }, { debugFlag: 'DEBUG_STREAM_CHUNKS' })
                }

                this.eventPublisher.emitChunk({
                    target,
                    payload: {
                        conversation_id: conversationId,
                        reply_id: replyId,
                        turn_id: turnId,
                        chunk: deltaText,
                        model_id: model.id,
                        provider_id: model.provider,
                    },
                })
            },
            {
                onToolCall,
                maxRounds: 5,
                emitErrorChunk: !hasMessageFileParts,
            },
        )

        let streamResult = await runStreamOnce()
        const shouldRetryFileRef = Boolean(
            hasMessageFileParts
            && resolvedModelForFiles
            && streamResult.finishReason === 'error'
            && isRetryableFileReferenceError({
                errorCode: streamResult.error?.code,
                errorMessage: streamResult.error?.message,
                fallbackText: fullText,
            }),
        )
        if (shouldRetryFileRef && resolvedModelForFiles) {
            streamLog('warn', 'FILE_REF_SELF_HEAL_RETRY_START', {
                code: streamResult.error?.code ?? null,
                message: streamResult.error?.message ?? null,
            })
            this.flushToDB(replyId, true)
            const task = this.taskRegistry.get(replyId)
            if (task) {
                task.buffered = ''
                task.lastFlushAt = 0
            }
            fullText = ''
            chunks = 0
            trace.chunk_count = 0
            trace.chunk_chars = 0
            trace.t_first_chunk = undefined
            db.prepare(`
                UPDATE messages
                SET content = '',
                    status = 'progress',
                    error_code = NULL,
                    error_message = NULL,
                    finish_reason = NULL,
                    updated_at = ?
                WHERE id = ?
            `).run(Date.now(), replyId)
            const invalidated = await refreshProviderFileRefs({
                db,
                model,
                resolvedModelForFiles,
                messages: callMessages,
                signal: abortController.signal,
                traceId,
            })
            streamLog('info', 'FILE_REF_SELF_HEAL_INVALIDATED', {
                invalidatedCount: invalidated.invalidatedCount,
                invalidatedShaCount: invalidated.invalidatedShaCount,
            })
            callMessages = invalidated.callMessages
            streamResult = await runStreamOnce()
            streamLog('info', 'FILE_REF_SELF_HEAL_RETRY_DONE', {
                finishReason: streamResult.finishReason,
                code: streamResult.error?.code ?? null,
            })
        }
        endReason = (streamResult.finishReason || 'stop') as DoneReason
        if (streamResult.finishReason === 'error' && streamResult.error?.message) {
            streamLog('warn', 'ERROR_THROWN', { message: streamResult.error.message })
        }

        let fallbackError: { code?: string; message?: string } | undefined
        const hasExplicitStreamError = endReason === 'error' && Boolean(streamResult.error?.message || streamResult.error?.code)
        if (hasExplicitStreamError && fullText.length === 0 && streamResult.error?.message) {
            fullText = `[error] ${streamResult.error.message}`
        }
        if (fullText.length === 0 && endReason !== 'aborted' && !hasExplicitStreamError) {
            streamLog('warn', 'EMPTY_OUTPUT_FALLBACK', {
                provider: model.provider,
                modelId: model.id,
            })
            try {
                const resolved = resolveModelConfig({ modelId: model.id })
                const fallback = await callLLMUniversalNonStream(
                    resolved,
                    callMessages,
                    undefined,
                    { nativeSearch: searchMode === 'native' },
                    requestAttachments,
                    requestInputText,
                )
                const trimmed = (fallback ?? '').trim()
                if (trimmed.length > 0) {
                    fullText = fallback
                    endReason = 'stop'
                } else {
                    fullText = '[error] EMPTY_OUTPUT'
                    endReason = 'error'
                    fallbackError = { code: 'EMPTY_OUTPUT', message: 'EMPTY_OUTPUT' }
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                streamLog('warn', 'EMPTY_OUTPUT_FALLBACK_FAILED', { message: msg })
                fullText = '[error] EMPTY_OUTPUT'
                endReason = 'error'
                fallbackError = { code: 'EMPTY_OUTPUT', message: 'EMPTY_OUTPUT' }
            }
        }

        emitDevEvent({
            type: 'tools',
            phase: 'llm',
            kind: 'llm.result',
            data: {
                action: 'llm.result',
                output: {
                    finishReason: endReason,
                    usage: streamResult.usage,
                    toolCalls: streamResult.toolCalls,
                    toolCallRounds: streamResult.toolCallRounds,
                    rawOutput: fullText && fullText !== '[error] EMPTY_OUTPUT' ? fullText : undefined,
                },
                error: streamResult.error?.message ?? fallbackError?.message,
            },
        })

        // G. Finalize: persist final state + close the turn + touch the conversation
        const ts = Date.now()
        if (this.taskRegistry.hasDoneSignal(replyId)) {
            streamLog('debug', 'DONE_ALREADY_SIGNALED_SKIP_FINALIZE', undefined, { debugFlag: 'DEBUG_STREAM_CHUNKS' })
            this.taskRegistry.clear(replyId)
            return
        }
        this.flushToDB(replyId, true)
        const wcId = this.taskRegistry.consumeWebContentsId(replyId)
        this.taskRegistry.delete(replyId)

        trace.t_finalize_start = Date.now()
        const finalError = endReason === 'error'
            ? (streamResult.error ?? fallbackError ?? { code: 'EMPTY_OUTPUT', message: 'EMPTY_OUTPUT' })
            : undefined
        const finalText = fullText
        turnWriter.finalizeTurn({
            turnId,
            assistantMessageId: replyId,
            status: endReason === 'aborted' ? 'aborted' : endReason === 'error' ? 'error' : 'completed',
            finishReason: endReason,
            finalContent: finalText,
            timestampMs: ts,
            error: finalError,
            contentParts: streamResult.toolCalls?.length
                ? {
                    tool_calls: streamResult.toolCalls,
                    tool_rounds: streamResult.toolCallRounds ?? 0,
                    tool_call_history: streamResult.toolCallHistory ?? undefined,
                }
                : null,
        })
        trace.t_db_finalize_done = Date.now()
        if (shouldRunTurnEndForMode(runMode)) {
            void strategyHost.runTurnEnd({
                conversationId,
                turnId,
                messageId: replyId,
                status: endReason,
            })
        } else {
            streamLog('info', 'TURN_END_SKIPPED', { mode: runMode, reason: 'rewrite_mode' })
        }

        if (!this.taskRegistry.hasDoneSignal(replyId)) {
            trace.t_done = Date.now()
            streamLog('info', 'FINALIZE_EMIT_DONE', { reason: endReason, elapsed: ts - t0, total: finalText.length })
            this.eventPublisher.emitDone({
                wcId,
                conversationId,
                turnId,
                replyId,
                reason: endReason,
                elapsedMs: ts - t0,
                finalContent: finalText,
                modelId: model.id,
                providerId: model.provider,
                traceId,
                error: finalError,
            })
        }

        const finalizeInfo = {
            provider: model.provider,
            model: model.id,
            accumulatedChars: finalText.length,
            dbFinalizeDone: trace.t_db_finalize_done ?? null,
        }
        if (endReason !== 'aborted' && endReason !== 'error') {
            void maybeAutoTitleConversation({
                db,
                conversationId,
                turnId,
                replyId,
                modelId: model.id,
                providerId: model.provider,
            }).then((res) => {
                log('info', '[SEND][finalize]', {
                    traceId,
                    conversationId,
                    turnId,
                    replyId,
                    ...finalizeInfo,
                    autoTitleTriggered: res.updated,
                    skipReason: res.skipReason ?? null,
                })
            })
        } else {
            log('info', '[SEND][finalize]', {
                traceId,
                conversationId,
                turnId,
                replyId,
                ...finalizeInfo,
                autoTitleTriggered: false,
                skipReason: endReason === 'error' ? 'finalize_not_success' : 'aborted',
            })
        }

        const status = endReason === 'error' ? 'error' : 'done'

        const ctxMs = trace.t_ctx_start && trace.t_ctx_done ? trace.t_ctx_done - trace.t_ctx_start : undefined
        const llmWaitMs = trace.t_llm_request_start && trace.t_first_chunk
            ? trace.t_first_chunk - trace.t_llm_request_start
            : undefined
        const streamMs = trace.t_first_chunk && trace.t_done
            ? trace.t_done - trace.t_first_chunk
            : undefined
        const finalizeMs = trace.t_finalize_start && trace.t_db_finalize_done
            ? trace.t_db_finalize_done - trace.t_finalize_start
            : undefined
        const totalMs = trace.t_done ? trace.t_done - trace.t0 : Date.now() - trace.t0

        streamLog('info', 'TIMING_SUMMARY', {
            provider: model.provider,
            modelId: model.id,
            status,
            totalMs,
            ctxMs: ctxMs ?? null,
            llmWaitMs: llmWaitMs ?? null,
            streamMs: streamMs ?? null,
            finalizeMs: finalizeMs ?? null,
            chunkCount: trace.chunk_count ?? 0,
            chunkChars: trace.chunk_chars ?? 0,
            elapsedMs: ts - t0,
        })
        process.stdout.write('\n------------------------------------------------------------\n')
    }

    /** Cancel explicitly (keep existing deltas and mark as aborted). */
    abort = (replyId: string): void => {
        const t = this.taskRegistry.get(replyId)
        if (!t) return
        const runMode: TurnRunMode = t.mode ?? 'normal'
        const now = Date.now()
        const db = this.deps.getDB()
        const turnWriter = new TurnWriter(db)
        const strategyHost = new StrategyHost(db)

        t.cancelled = true
        t.abortController?.abort()
        this.flushToDB(replyId, true)

        const row = db.prepare(`SELECT conversation_id, turn_id, content, model FROM messages WHERE id=?`)
            .get(replyId) as { conversation_id: string; turn_id: string; content?: string; model?: string | null } | undefined
        if (!row) return

        turnWriter.finalizeTurn({
            turnId: row.turn_id,
            assistantMessageId: replyId,
            status: 'aborted',
            timestampMs: now,
        })
        if (shouldRunTurnEndForMode(runMode)) {
            void strategyHost.runTurnEnd({
                conversationId: row.conversation_id,
                turnId: row.turn_id,
                messageId: replyId,
                status: 'aborted',
            })
        } else {
            log('info', '[STREAM]', {
                traceId: null,
                phase: 'TURN_END_SKIPPED',
                conversationId: row.conversation_id,
                turnId: row.turn_id,
                replyId,
                mode: runMode,
                reason: 'rewrite_mode',
            })
        }

        const wcId = this.taskRegistry.getWebContentsId(replyId)
        const modelCfg = row.model ? getModelById(row.model) : undefined
        this.eventPublisher.emitDone({
            wcId,
            conversationId: row.conversation_id,
            turnId: row.turn_id,
            replyId,
            reason: 'aborted',
            finalContent: row.content ?? '',
            modelId: row.model ?? undefined,
            providerId: modelCfg?.provider,
        })

        this.taskRegistry.markDoneSignal(replyId)
        this.taskRegistry.clear(replyId)
    }

    status = (replyId: string) => {
        return this.taskRegistry.status(replyId)
    }

    /** Flush buffered output to DB with throttling. */
    private flushToDB(replyId: string, force = false): void {
        const t = this.taskRegistry.get(replyId)
        if (!t || !t.buffered) return
        const now = Date.now()
        if (!force && now - t.lastFlushAt < this.deps.flushEveryMs) return
        const turnWriter = new TurnWriter(this.deps.getDB())
        turnWriter.appendAssistantDelta({ assistantMessageId: replyId, delta: t.buffered, timestampMs: now })
        t.buffered = ''
        t.lastFlushAt = now
    }
}

export const streamManager = new StreamManager()
