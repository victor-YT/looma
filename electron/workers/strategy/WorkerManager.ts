import { Worker, type WorkerOptions } from 'node:worker_threads'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
    UIMessage,
    MemoryChunkSearchRequest,
    MemoryHit,
    MemoryIngestRequest,
    MemoryIngestResult,
    MemoryAssetRecord,
    LLMModelConfig,
    Attachment,
    LLMMessage,
    ToolChoice,
    ToolDefinition,
    RunResult,
    MemoryQueryOptions,
    MemoryRecord,
    StrategyDevEvent,
} from '../../../contracts'

type RequestType = 'init' | 'contextBuild' | 'turnEnd' | 'toolCall' | 'replayTurn' | 'dispose'

type StrategyWorkerRequest = {
    id: string
    type: RequestType
    payload?: unknown
}

type StrategyWorkerResponse =
    | { id: string; ok: true; result?: unknown }
    | { id: string; ok: false; error: { message: string; stack?: string } }

type WorkerDevEvent = { kind: 'devEvent'; payload: StrategyDevEvent }

type HostRequest =
    | { kind: 'hostRequest'; id: string; method: 'getHistory'; payload: { conversationId: string; turnId?: string } }
    | { kind: 'hostRequest'; id: string; method: 'getTurnUserInput'; payload: { conversationId: string; turnId: string } }
    | { kind: 'hostRequest'; id: string; method: 'measureTokens'; payload: { text: string } }
    | { kind: 'hostRequest'; id: string; method: 'executeTool'; payload: { call: { id: string; name: string; args?: unknown }; conversationId: string; turnId: string } }
    | { kind: 'hostRequest'; id: string; method: 'executeMemorySearch'; payload: MemoryChunkSearchRequest & { conversationId: string } }
    | { kind: 'hostRequest'; id: string; method: 'executeMemoryListAssets'; payload: { conversationId: string } }
    | { kind: 'hostRequest'; id: string; method: 'executeMemoryReadAsset'; payload: { conversationId: string; assetId: string; maxChars?: number } }
    | { kind: 'hostRequest'; id: string; method: 'executeMemoryDeleteAsset'; payload: { conversationId: string; assetId: string } }
    | { kind: 'hostRequest'; id: string; method: 'ingestDocument'; payload: MemoryIngestRequest }
    | { kind: 'hostRequest'; id: string; method: 'memoryQuery'; payload: { conversationId: string; options?: MemoryQueryOptions } }
    | { kind: 'hostRequest'; id: string; method: 'memoryRemoveMemory'; payload: { conversationId: string; memoryId: string } }
    | { kind: 'hostRequest'; id: string; method: 'stateGet'; payload: { conversationId: string; strategyId: string; key: string } }
    | { kind: 'hostRequest'; id: string; method: 'stateSet'; payload: { conversationId: string; strategyId: string; key: string; value: unknown } }
    | { kind: 'hostRequest'; id: string; method: 'stateDelete'; payload: { conversationId: string; strategyId: string; key: string } }
    | { kind: 'hostRequest'; id: string; method: 'stateHas'; payload: { conversationId: string; strategyId: string; key: string } }
    | { kind: 'hostRequest'; id: string; method: 'llmCall'; payload: { conversationId: string; turnId?: string; model: LLMModelConfig; messages: LLMMessage[]; tools?: ToolDefinition[]; toolChoice?: ToolChoice; temperature?: number } }
    | { kind: 'hostRequest'; id: string; method: 'runLLMLoop'; payload: { conversationId: string; turnId?: string; model: LLMModelConfig; messages: LLMMessage[]; tools?: ToolDefinition[]; toolChoice?: ToolChoice; maxRounds?: number; temperature?: number } }

type HostResponse =
    | { kind: 'hostResponse'; id: string; ok: true; result?: unknown }
    | { kind: 'hostResponse'; id: string; ok: false; error: { message: string; stack?: string } }

function isWorkerDevEvent(msg: unknown): msg is WorkerDevEvent {
    return Boolean(msg && typeof msg === 'object' && (msg as { kind?: unknown }).kind === 'devEvent')
}

function isHostRequest(msg: unknown): msg is HostRequest {
    return Boolean(msg && typeof msg === 'object' && (msg as { kind?: unknown }).kind === 'hostRequest')
}

function isStrategyWorkerResponse(msg: unknown): msg is StrategyWorkerResponse {
    return Boolean(msg && typeof msg === 'object' && 'id' in msg && 'ok' in msg)
}

type PendingRequest = {
    resolve: (value: unknown) => void
    reject: (err: Error) => void
    timeoutId: ReturnType<typeof setTimeout>
}

type WorkerHandle = {
    worker: Worker
    pending: Map<string, PendingRequest>
    unhealthy: boolean
}

export type HostHandlers = {
    getHistory: (args: { conversationId: string; turnId?: string }) => Promise<UIMessage[]>
    getTurnUserInput?: (args: { conversationId: string; turnId: string }) => Promise<{ text: string; attachments?: Attachment[] }>
    measureTokens?: (args: { text: string }) => Promise<number>
    executeTool?: (args: { call: { id: string; name: string; args?: unknown }; conversationId: string; turnId: string }) => Promise<string>
    executeMemorySearch?: (args: MemoryChunkSearchRequest & { conversationId: string }) => Promise<MemoryHit[]>
    executeMemoryListAssets?: (args: { conversationId: string }) => Promise<MemoryAssetRecord[]>
    executeMemoryReadAsset?: (args: { conversationId: string; assetId: string; maxChars?: number }) => Promise<string>
    executeMemoryDeleteAsset?: (args: { conversationId: string; assetId: string }) => Promise<{ ok: true }>
    ingestDocument?: (args: MemoryIngestRequest) => Promise<MemoryIngestResult>
    memoryQuery?: (args: { conversationId: string; options?: MemoryQueryOptions }) => Promise<MemoryRecord[]>
    memoryRemoveMemory?: (args: { conversationId: string; memoryId: string }) => Promise<{ deleted: boolean }>
    stateGet?: (args: { conversationId: string; strategyId: string; key: string }) => Promise<unknown>
    stateSet?: (args: { conversationId: string; strategyId: string; key: string; value: unknown }) => Promise<{ ok: true }>
    stateDelete?: (args: { conversationId: string; strategyId: string; key: string }) => Promise<{ ok: true }>
    stateHas?: (args: { conversationId: string; strategyId: string; key: string }) => Promise<boolean>
    llmCall?: (args: { conversationId: string; turnId?: string; model: LLMModelConfig; messages: LLMMessage[]; tools?: ToolDefinition[]; toolChoice?: ToolChoice; temperature?: number }) => Promise<LLMMessage>
    runLLMLoop?: (args: { conversationId: string; turnId?: string; model: LLMModelConfig; messages: LLMMessage[]; tools?: ToolDefinition[]; toolChoice?: ToolChoice; maxRounds?: number; temperature?: number }) => Promise<RunResult>
    onDevEvent?: (event: StrategyDevEvent) => void
}

const CONTEXT_BUILD_TIMEOUT_MS = 8000
const TURN_END_TIMEOUT_MS = 15000
const REPLAY_TURN_TIMEOUT_MS = 15000

const DEFAULT_TOOL_CALL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_DEFAULT_MS ?? '8000')

function toTimeoutMs(v: unknown, fallback: number) {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

const TOOL_TIMEOUTS: Record<string, number> = {
    'builtin.web_search': toTimeoutMs(process.env.TOOL_TIMEOUT_WEB_SEARCH_MS, 20000),
    'builtin.web_fetch': toTimeoutMs(process.env.TOOL_TIMEOUT_WEB_FETCH_MS, 60000),
}

export function getToolTimeoutMs(toolName: string): number {
    const raw = TOOL_TIMEOUTS[toolName]
    if (Number.isFinite(raw) && raw > 0) return raw
    return Number.isFinite(DEFAULT_TOOL_CALL_TIMEOUT_MS) && DEFAULT_TOOL_CALL_TIMEOUT_MS > 0
        ? DEFAULT_TOOL_CALL_TIMEOUT_MS
        : 8000
}

export class WorkerManager {
    constructor(private hostHandlers: HostHandlers) {}
    private workers = new Map<string, WorkerHandle>()
    private seq = 0

    disposeWorker(conversationId: string): void {
        const handle = this.workers.get(conversationId)
        if (!handle) return
        handle.unhealthy = true
        for (const pending of handle.pending.values()) {
            clearTimeout(pending.timeoutId)
            pending.reject(new Error('[strategy-worker] disposed'))
        }
        handle.pending.clear()
        try {
            void handle.worker.terminate()
        } catch {
            // ignore terminate failures
        }
        this.workers.delete(conversationId)
    }

    async requestContextBuild(conversationId: string, payload: unknown): Promise<unknown> {
        return this.request(conversationId, 'contextBuild', payload, CONTEXT_BUILD_TIMEOUT_MS)
    }

    async requestTurnEnd(conversationId: string, payload: unknown): Promise<void> {
        await this.request(conversationId, 'turnEnd', payload, TURN_END_TIMEOUT_MS)
    }

    async requestToolCall(conversationId: string, payload: unknown): Promise<unknown> {
        const toolName = (payload as { call?: { name?: string } } | undefined)?.call?.name ?? 'unknown'
        const timeoutMs = getToolTimeoutMs(toolName)
        return this.request(conversationId, 'toolCall', payload, timeoutMs, {
            terminateOnTimeout: false,
            timeoutResult: {
                ok: false,
                error: { type: 'timeout', tool: toolName, timeoutMs, message: `timeout after ${timeoutMs}ms` },
            },
        })
    }

    async requestReplayTurn(conversationId: string, payload: unknown): Promise<void> {
        await this.request(conversationId, 'replayTurn', payload, REPLAY_TURN_TIMEOUT_MS)
    }

    private request(
        conversationId: string,
        type: RequestType,
        payload: unknown,
        timeoutMs: number,
        options?: { terminateOnTimeout?: boolean; timeoutResult?: unknown },
    ): Promise<unknown> {
        const handle = this.getOrCreateWorker(conversationId)
        const id = String(++this.seq)
        const request: StrategyWorkerRequest = { id, type, payload }

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                handle.pending.delete(id)
                if (options?.timeoutResult !== undefined) {
                    resolve(options.timeoutResult)
                    return
                }
                if (options?.terminateOnTimeout !== false) {
                    handle.unhealthy = true
                    try {
                        handle.worker.terminate()
                    } catch {
                        // ignore terminate failures
                    }
                }
                reject(new Error(`[strategy-worker] timeout after ${timeoutMs}ms for ${type}`))
            }, timeoutMs)

            handle.pending.set(id, { resolve, reject, timeoutId })

            try {
                handle.worker.postMessage(request)
            } catch (err) {
                clearTimeout(timeoutId)
                handle.pending.delete(id)
                handle.unhealthy = true
                reject(err instanceof Error ? err : new Error(String(err)))
            }
        })
    }

    private getOrCreateWorker(conversationId: string): WorkerHandle {
        const existing = this.workers.get(conversationId)
        if (existing && !existing.unhealthy) return existing
        if (existing?.unhealthy) {
            this.workers.delete(conversationId)
        }
        const handle = this.spawnWorker(conversationId)
        this.workers.set(conversationId, handle)
        return handle
    }

    private spawnWorker(conversationId: string): WorkerHandle {
        const appRoot = process.env.APP_ROOT ?? process.cwd()
        const workerFile = path.join(appRoot, 'dist-electron', 'strategyWorker.js')
        const workerUrl = pathToFileURL(workerFile)
        const worker = new Worker(workerUrl, { type: 'module' } as unknown as WorkerOptions)
        const handle: WorkerHandle = { worker, pending: new Map(), unhealthy: false }

        worker.on('message', (msg: StrategyWorkerResponse | HostRequest | WorkerDevEvent) => {
            if (isWorkerDevEvent(msg)) {
                this.hostHandlers.onDevEvent?.(msg.payload)
                return
            }
            if (isHostRequest(msg)) {
                void this.handleHostRequest(handle, msg)
                return
            }
            if (!isStrategyWorkerResponse(msg)) {
                return
            }
            const pending = handle.pending.get(msg.id)
            if (!pending) return
            clearTimeout(pending.timeoutId)
            handle.pending.delete(msg.id)
            if (msg.ok) {
                pending.resolve(msg.result)
            } else {
                const err = new Error(msg.error?.message || '[strategy-worker] unknown error')
                if (msg.error?.stack) err.stack = msg.error.stack
                pending.reject(err)
            }
        })

        worker.on('error', (err) => {
            console.warn('[strategy-worker] error', { conversationId, err })
            this.failWorker(conversationId, err instanceof Error ? err : new Error(String(err)))
        })

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.warn('[strategy-worker] exit', { conversationId, code })
            }
            this.failWorker(conversationId, new Error(`worker exited with code ${code ?? 'unknown'}`))
            if (code !== 0) {
                const next = this.spawnWorker(conversationId)
                this.workers.set(conversationId, next)
            }
        })

        return handle
    }

    private async handleHostRequest(handle: WorkerHandle, req: HostRequest): Promise<void> {
        try {
            if (req.method === 'getHistory') {
                const messages = await this.hostHandlers.getHistory(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result: messages }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'getTurnUserInput') {
                if (!this.hostHandlers.getTurnUserInput) {
                    throw new Error('getTurnUserInput not supported')
                }
                const result = await this.hostHandlers.getTurnUserInput(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'measureTokens') {
                if (!this.hostHandlers.measureTokens) {
                    throw new Error('measureTokens not supported')
                }
                const tokens = await this.hostHandlers.measureTokens(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result: tokens }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'executeTool') {
                if (!this.hostHandlers.executeTool) {
                    throw new Error('executeTool not supported')
                }
                const resultText = await this.hostHandlers.executeTool(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result: { ok: true, resultText } }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'executeMemorySearch') {
                if (!this.hostHandlers.executeMemorySearch) {
                    throw new Error('executeMemorySearch not supported')
                }
                const result = await this.hostHandlers.executeMemorySearch(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'executeMemoryListAssets') {
                if (!this.hostHandlers.executeMemoryListAssets) {
                    throw new Error('executeMemoryListAssets not supported')
                }
                const result = await this.hostHandlers.executeMemoryListAssets(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'executeMemoryReadAsset') {
                if (!this.hostHandlers.executeMemoryReadAsset) {
                    throw new Error('executeMemoryReadAsset not supported')
                }
                const result = await this.hostHandlers.executeMemoryReadAsset(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'executeMemoryDeleteAsset') {
                if (!this.hostHandlers.executeMemoryDeleteAsset) {
                    throw new Error('executeMemoryDeleteAsset not supported')
                }
                const result = await this.hostHandlers.executeMemoryDeleteAsset(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'ingestDocument') {
                if (!this.hostHandlers.ingestDocument) {
                    throw new Error('ingestDocument not supported')
                }
                const result = await this.hostHandlers.ingestDocument(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'memoryQuery') {
                if (!this.hostHandlers.memoryQuery) {
                    throw new Error('memoryQuery not supported')
                }
                const result = await this.hostHandlers.memoryQuery(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'memoryRemoveMemory') {
                if (!this.hostHandlers.memoryRemoveMemory) {
                    throw new Error('memoryRemoveMemory not supported')
                }
                const result = await this.hostHandlers.memoryRemoveMemory(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'stateGet') {
                if (!this.hostHandlers.stateGet) {
                    throw new Error('stateGet not supported')
                }
                const result = await this.hostHandlers.stateGet(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'stateSet') {
                if (!this.hostHandlers.stateSet) {
                    throw new Error('stateSet not supported')
                }
                const result = await this.hostHandlers.stateSet(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'stateDelete') {
                if (!this.hostHandlers.stateDelete) {
                    throw new Error('stateDelete not supported')
                }
                const result = await this.hostHandlers.stateDelete(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'stateHas') {
                if (!this.hostHandlers.stateHas) {
                    throw new Error('stateHas not supported')
                }
                const result = await this.hostHandlers.stateHas(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'llmCall') {
                if (!this.hostHandlers.llmCall) {
                    throw new Error('llmCall not supported')
                }
                const result = await this.hostHandlers.llmCall(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            if (req.method === 'runLLMLoop') {
                if (!this.hostHandlers.runLLMLoop) {
                    throw new Error('runLLMLoop not supported')
                }
                const result = await this.hostHandlers.runLLMLoop(req.payload)
                const res: HostResponse = { kind: 'hostResponse', id: req.id, ok: true, result }
                handle.worker.postMessage(res)
                return
            }
            throw new Error('unknown host method')
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            const res: HostResponse = {
                kind: 'hostResponse',
                id: req.id,
                ok: false,
                error: { message: error.message, stack: error.stack },
            }
            handle.worker.postMessage(res)
        }
    }

    private failWorker(conversationId: string, err: Error): void {
        const handle = this.workers.get(conversationId)
        if (!handle) return
        handle.unhealthy = true
        for (const pending of handle.pending.values()) {
            clearTimeout(pending.timeoutId)
            pending.reject(err)
        }
        handle.pending.clear()
        try {
            handle.worker.terminate()
        } catch {
            // ignore terminate failures
        }
    }
}
