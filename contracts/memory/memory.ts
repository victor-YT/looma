// electron/core/types/memory.ts
export type ScopeType = 'global' | 'project' | 'conversation'
export type Modality  = 'text' | 'image' | 'audio' | 'video' | 'file'
export type VecModality = 'text' | 'image' | 'audio' | 'video'

export type MemoryRecord = {
    id: string
    assetId?: string
    type: string
    modality: Modality
    title?: string
    preview?: string
    tags: string[]
    pinned: boolean
    createdAt: number
    updatedAt: number
}

export type ReadAssetOptions = {
    maxChars?: number
}

export interface MemoryItemInput {
    id?: string
    strategy_id: string

    scope_type: ScopeType
    scope_id: string

    owner_type?: ScopeType
    owner_id?: string

    source_conversation_id?: string
    source_turn_id?: string
    source_message_id?: string

    /** Business type tag, for example "clip.note" / "file.asset" / "summary.L0". */
    type: string
    modality: Modality

    /** Searchable text representation (preferred for RAG/vector retrieval). */
    text_repr?: string
    text_repr_model?: string

    /** Used only for short content; large payloads should go through memory_assets. */
    content?: string
    size_tokens?: number

    tags?: unknown[]
    meta?: Record<string, unknown>
    content_hash?: string

    priority?: number

    /** Legacy compatibility: if write-and-embed is needed, let the caller trigger embedMemory afterwards. */
    embed?: {
        enabled: boolean
        provider?: 'openai' | 'gemini' | 'local'
        apiKeyEnv?: string
        model?: string
        dim?: number
        metric?: 'cosine' | 'l2' | 'dot'
        level?: 'mem' | 'asset'
    }
}

/** Map MemoryItem modality to vector modality (treat file as text). */
export function toVecModality(m?: Modality): VecModality {
    switch (m) {
        case 'image': return 'image'
        case 'audio': return 'audio'
        case 'video': return 'video'
        case 'text':
        case 'file':
        default: return 'text'
    }
}
