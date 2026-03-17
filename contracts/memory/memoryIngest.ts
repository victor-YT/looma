export type MemoryIngestOptions = {
    wait?: 'load' | 'full'
    mode?: 'raw' | 'chunk' | 'rag'
    chunkSize?: number
    chunkOverlap?: number
    tags?: string[]
    type?: string
}

export type MemoryIngestRequest = {
    conversationId: string
    strategyKey?: string
    strategyVersion?: string
    assetId?: string
    filename: string
    mime?: string
    data?: Uint8Array
    text?: string
    options?: MemoryIngestOptions
    source?: {
        conversationId?: string
        turnId?: string
        messageId?: string
    }
}

export type MemoryIngestResult = {
    assetId: string
    storageKey?: string
    chunkCount: number
    status: 'completed' | 'failed' | 'loaded'
    reason?: 'no_text' | 'index_disabled' | 'unsupported'
    error?: string
}

export type MemoryIngestProgress = {
    conversationId: string
    assetId: string
    phase: 'parse' | 'chunk' | 'embed' | 'write' | 'loaded' | 'completed' | 'failed'
    done?: number
    total?: number
    status?: 'completed' | 'failed'
}
