import { parentPort } from 'node:worker_threads'
import type {
    Attachment,
    LLMModelConfig,
    LLMMessage,
    MemoryChunkSearchRequest,
    MemoryHit,
    MemoryIngestRequest,
    MemoryIngestResult,
    MemoryAssetRecord,
    RunResult,
    ToolChoice,
    ToolDefinition,
    MemoryRecord,
    MemoryQueryOptions,
} from '../../../contracts'

type HostRequestType =
    | 'getHistory'
    | 'getTurnUserInput'
    | 'measureTokens'
    | 'executeTool'
    | 'executeMemorySearch'
    | 'executeMemoryListAssets'
    | 'executeMemoryReadAsset'
    | 'executeMemoryDeleteAsset'
    | 'ingestDocument'
    | 'memoryQuery'
    | 'memoryRemoveMemory'
    | 'stateGet'
    | 'stateSet'
    | 'stateDelete'
    | 'stateHas'
    | 'llmCall'
    | 'runLLMLoop'
type HostRequest = {
    kind: 'hostRequest'
    id: string
    method: HostRequestType
    payload?: unknown
}
type HostResponse =
    | { kind: 'hostResponse'; id: string; ok: true; result?: unknown }
    | { kind: 'hostResponse'; id: string; ok: false; error: { message: string; stack?: string } }

class HostClient {
    private seq = 0
    private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeoutId: ReturnType<typeof setTimeout> }>()

    constructor() {
        parentPort?.on('message', (msg: HostResponse) => {
            if (!msg || msg.kind !== 'hostResponse') return
            const pending = this.pending.get(msg.id)
            if (!pending) return
            clearTimeout(pending.timeoutId)
            this.pending.delete(msg.id)
            if (msg.ok) pending.resolve(msg.result)
            else {
                const err = new Error(msg.error?.message || 'host error')
                if (msg.error?.stack) err.stack = msg.error.stack
                pending.reject(err)
            }
        })
    }

    request(method: HostRequestType, payload?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
        const id = String(++this.seq)
        const msg: HostRequest = { kind: 'hostRequest', id, method, payload }
        return new Promise((resolve, reject) => {
            const timeoutMs = Math.max(500, Math.round(opts?.timeoutMs ?? 8000))
            const timeoutId = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`[hostClient] timeout after ${timeoutMs}ms (${method})`))
            }, timeoutMs)
            this.pending.set(id, { resolve, reject, timeoutId })
            parentPort?.postMessage(msg)
        })
    }

    async getHistory(args: { conversationId: string; turnId?: string }): Promise<unknown[]> {
        const result = await this.request('getHistory', args)
        return Array.isArray(result) ? result : []
    }

    async getTurnUserInput(args: { conversationId: string; turnId: string }): Promise<{ text: string; attachments?: Attachment[] }> {
        const result = await this.request('getTurnUserInput', args)
        if (result && typeof result === 'object' && 'text' in result) {
            return result as { text: string; attachments?: Attachment[] }
        }
        return { text: '', attachments: [] }
    }

    async measureTokens(args: { text: string }): Promise<number> {
        const result = await this.request('measureTokens', args)
        return typeof result === 'number' && Number.isFinite(result) ? result : 0
    }

    async executeTool(args: {
        call: { id: string; name: string; args?: unknown }
        conversationId: string
        turnId: string
    }): Promise<{ ok: boolean; resultText?: string; error?: { message?: string } }> {
        const result = await this.request('executeTool', args)
        if (result && typeof result === 'object' && 'ok' in result) {
            return result as { ok: boolean; resultText?: string; error?: { message?: string } }
        }
        return { ok: true, resultText: typeof result === 'string' ? result : '' }
    }

    async executeMemorySearch(args: MemoryChunkSearchRequest & { conversationId: string }): Promise<MemoryHit[]> {
        const result = await this.request('executeMemorySearch', args)
        return Array.isArray(result) ? result as MemoryHit[] : []
    }

    async executeMemoryListAssets(args: { conversationId: string }): Promise<MemoryAssetRecord[]> {
        const result = await this.request('executeMemoryListAssets', args)
        return Array.isArray(result) ? result as MemoryAssetRecord[] : []
    }

    async executeMemoryReadAsset(args: { conversationId: string; assetId: string; maxChars?: number }): Promise<string> {
        const result = await this.request('executeMemoryReadAsset', args)
        return typeof result === 'string' ? result : ''
    }

    async executeMemoryDeleteAsset(args: { conversationId: string; assetId: string }): Promise<{ ok: true }> {
        const result = await this.request('executeMemoryDeleteAsset', args)
        return (result as { ok: true }) ?? { ok: true }
    }

    async ingestDocument(args: MemoryIngestRequest): Promise<MemoryIngestResult> {
        const result = await this.request('ingestDocument', args, { timeoutMs: 60000 })
        if (result && typeof result === 'object' && 'assetId' in result) {
            return result as MemoryIngestResult
        }
        return { assetId: '', chunkCount: 0, status: 'failed', error: 'ingest failed' }
    }

    async memoryQuery(args: { conversationId: string; options?: MemoryQueryOptions }): Promise<MemoryRecord[]> {
        const result = await this.request('memoryQuery', args)
        return Array.isArray(result) ? result as MemoryRecord[] : []
    }

    async memoryRemoveMemory(args: { conversationId: string; memoryId: string }): Promise<{ deleted: boolean }> {
        const result = await this.request('memoryRemoveMemory', args)
        if (result && typeof result === 'object' && 'deleted' in result) {
            return result as { deleted: boolean }
        }
        return { deleted: false }
    }

    async stateGet(args: { conversationId: string; strategyId: string; key: string }): Promise<unknown> {
        return this.request('stateGet', args, { timeoutMs: 8000 })
    }

    async stateSet(args: { conversationId: string; strategyId: string; key: string; value: unknown }): Promise<{ ok: true }> {
        const result = await this.request('stateSet', args, { timeoutMs: 8000 })
        return (result as { ok: true }) ?? { ok: true }
    }

    async stateDelete(args: { conversationId: string; strategyId: string; key: string }): Promise<{ ok: true }> {
        const result = await this.request('stateDelete', args, { timeoutMs: 8000 })
        return (result as { ok: true }) ?? { ok: true }
    }

    async stateHas(args: { conversationId: string; strategyId: string; key: string }): Promise<boolean> {
        const result = await this.request('stateHas', args, { timeoutMs: 8000 })
        return result === true
    }

    async llmCall(args: {
        conversationId: string
        turnId?: string
        model: LLMModelConfig
        messages: LLMMessage[]
        tools?: ToolDefinition[]
        toolChoice?: ToolChoice
        temperature?: number
    }): Promise<LLMMessage> {
        const result = await this.request('llmCall', args, { timeoutMs: 60000 })
        if (result && typeof result === 'object' && 'role' in result) {
            return result as LLMMessage
        }
        return { role: 'assistant', content: '' }
    }

    async runLLMLoop(args: {
        conversationId: string
        turnId?: string
        model: LLMModelConfig
        messages: LLMMessage[]
        tools?: ToolDefinition[]
        toolChoice?: ToolChoice
        maxRounds?: number
        temperature?: number
    }): Promise<RunResult> {
        const result = await this.request('runLLMLoop', args, { timeoutMs: 90000 })
        if (result && typeof result === 'object' && 'finishReason' in result) {
            return result as RunResult
        }
        return { content: '', finishReason: 'error', messages: [], error: { message: 'llm loop failed' } }
    }
}

export const hostClient = new HostClient()
