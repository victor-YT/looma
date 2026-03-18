import type { ScopeType } from './memory'

export type MemoryChunkSearchRequest = {
    query: string
    scope?: { type: ScopeType; id: string }
    topK?: number
    tags?: string[]
    threshold?: number
}

export type MemoryHit = {
    id: string
    type: 'chunk' | 'asset' | 'text'
    content: string
    similarity: number
    assetId?: string
    chunkId?: string
    source?: {
        strategyId?: string
        conversationId?: string
    }
}

export type MemoryChunkSearchHit = {
    chunkId: string
    assetId: string
    idx?: number
    text: string
    score: number
}

export type MemoryChunkSearchResult = {
    embeddingProfile: string
    chunks: MemoryChunkSearchHit[]
}
