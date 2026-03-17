import type { Database } from 'better-sqlite3'
import { l2Normalize, upsertEmbedding, newVectorId, type Metric, type Level } from '../vectorService'
import { embedTextsWithProfile, normalizeEmbedding, resolveEmbeddingProfile } from './pipeline/embedding'
import { assertConversationId, assertStrategyScope, resolveStrategyScope } from './utils'
import type {
    MemoryChunkSearchRequest,
    MemoryChunkSearchResult,
    MemoryChunkSearchHit,
    Modality,
} from '../../../contracts/index'

export async function searchChunks(
    db: Database,
    args: { conversationId: string; request: MemoryChunkSearchRequest },
): Promise<MemoryChunkSearchResult> {
    assertConversationId(args.conversationId)
    const scope = resolveStrategyScope(db, args.conversationId)
    assertStrategyScope(scope)
    const debug = process.env.MEMORY_SMOKE_DEBUG === '1'
    const query = (args.request.query ?? '').trim()
    if (args.request.scope) {
        const scope = args.request.scope
        if (scope.type !== 'conversation' || scope.id !== args.conversationId) {
            throw new Error('[memoryStore] search scope must match conversationId')
        }
    }
    const profile = resolveEmbeddingProfile(undefined)
    if (!query) {
        return { embeddingProfile: profile.name, chunks: [] }
    }

    const embedded = await embedTextsWithProfile(profile, [query])
    const queryVecRaw = embedded.vectors[0]
    const queryVec = normalizeEmbedding(profile, queryVecRaw)

    const rows = db.prepare(`
        SELECT v.chunk_id, v.dim, v.vector,
               c.id AS c_id, c.asset_id, c.idx, c.text,
               a.id AS a_id,
               v.conversation_id AS v_conversation_id,
               c.conversation_id AS c_conversation_id,
               a.conversation_id AS a_conversation_id,
               v.strategy_key AS v_strategy_key,
               c.strategy_key AS c_strategy_key,
               v.strategy_version AS v_strategy_version,
               c.strategy_version AS c_strategy_version,
               v.embedding_profile AS embedding_profile
        FROM memory_chunk_vectors v
        JOIN memory_chunks c
            ON c.id = v.chunk_id
           AND c.conversation_id = ?
           AND c.strategy_key = ?
           AND c.strategy_version = ?
        JOIN memory_assets a
            ON a.id = c.asset_id
           AND a.conversation_id = ?
        WHERE v.conversation_id = ?
          AND v.strategy_key = ?
          AND v.strategy_version = ?
          AND v.embedding_profile = ?
    `).all(
        args.conversationId,
        scope.strategyKey,
        scope.strategyVersion,
        args.conversationId,
        args.conversationId,
        scope.strategyKey,
        scope.strategyVersion,
        profile.name,
    ) as Array<{
        chunk_id: string
        c_id: string
        dim: number
        vector: Buffer
        asset_id: string
        a_id: string
        idx: number
        text: string
        v_conversation_id: string
        c_conversation_id: string
        a_conversation_id: string
        v_strategy_key: string
        c_strategy_key: string
        v_strategy_version: string
        c_strategy_version: string
        embedding_profile: string
    }>

    const hits: MemoryChunkSearchHit[] = []
    const debugRows: Array<Record<string, unknown>> = []
    for (const row of rows) {
        const len = Math.floor(row.vector.byteLength / 4)
        if (len <= 0) continue
        const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, len)
        const score = profile.metric === 'l2'
            ? -l2Distance(queryVec, vec)
            : dot(queryVec, vec)
        if (debug) {
            debugRows.push({
                v_conversation_id: row.v_conversation_id,
                c_conversation_id: row.c_conversation_id,
                a_conversation_id: row.a_conversation_id,
                v_strategy_key: row.v_strategy_key,
                c_strategy_key: row.c_strategy_key,
                v_strategy_version: row.v_strategy_version,
                c_strategy_version: row.c_strategy_version,
                v_chunk_id: row.chunk_id,
                c_id: row.c_id,
                c_asset_id: row.asset_id,
                a_id: row.a_id,
                embedding_profile: row.embedding_profile,
                score,
            })
        }
        if (score <= 0) continue
        hits.push({
            chunkId: row.chunk_id,
            assetId: row.asset_id,
            idx: row.idx,
            text: row.text,
            score,
        })
    }

    if (debug) {
        console.log('[MEMORY][debug] searchChunks', {
            conversationId: args.conversationId,
            strategyKey: scope.strategyKey,
            strategyVersion: scope.strategyVersion,
            embeddingProfile: profile.name,
            query,
            rows: debugRows,
        })
    }

    hits.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (a.assetId !== b.assetId) return a.assetId.localeCompare(b.assetId)
        return (a.idx ?? 0) - (b.idx ?? 0)
    })

    const topK = Math.max(1, args.request.topK ?? 6)
    return { embeddingProfile: profile.name, chunks: hits.slice(0, topK) }
}

function dot(a: Float32Array, b: Float32Array): number {
    const len = Math.min(a.length, b.length)
    let sum = 0
    for (let i = 0; i < len; i++) sum += a[i] * b[i]
    return sum
}

function l2Distance(a: Float32Array, b: Float32Array): number {
    const len = Math.min(a.length, b.length)
    let sum = 0
    for (let i = 0; i < len; i++) {
        const d = a[i] - b[i]
        sum += d * d
    }
    return Math.sqrt(sum)
}

export function getMemoryItemForEmbedding(
    db: Database,
    args: { conversationId: string; memoryId: string },
): { text: string; modality: Modality } | null {
    assertConversationId(args.conversationId)
    const row = db.prepare(`
        SELECT text_repr, content, modality
        FROM memory_items
        WHERE id = ?
          AND scope_type = 'conversation'
          AND scope_id = ?
    `).get(args.memoryId, args.conversationId) as { text_repr?: string | null; content?: string | null; modality: Modality } | undefined
    if (!row) return null
    const text = (row.text_repr ?? row.content ?? '').trim()
    if (!text) return null
    return { text, modality: row.modality }
}

type VectorModality = Exclude<Modality, 'file'>

function toVectorModality(modality: Modality): VectorModality {
    return modality === 'file' ? 'text' : modality
}

export function upsertMemoryVector(
    db: Database,
    args: {
        conversationId: string
        vecId?: string
        memoryId?: string
        assetId?: string
        model: string
        modality: Modality
        dim: number
        metric: Metric
        level: Level
        vector: Float32Array | number[]
    },
): string {
    assertConversationId(args.conversationId)
    const scope = resolveStrategyScope(db, args.conversationId)
    assertStrategyScope(scope)
    const hasMem = args.memoryId != null
    const hasAsset = args.assetId != null
    if (hasMem === hasAsset) {
        throw new Error('[memoryStore] require exactly one of memoryId or assetId')
    }
    if (args.vector.length !== args.dim) {
        throw new Error(`[memoryStore] dim mismatch: expect ${args.dim}, got ${args.vector.length}`)
    }

    const vecId = args.vecId ?? newVectorId('vec')
    const vecArr = args.metric === 'cosine'
        ? l2Normalize(args.vector)
        : (args.vector instanceof Float32Array ? args.vector : new Float32Array(args.vector))
    const vecBuf = Buffer.from(new Uint8Array(vecArr.buffer, vecArr.byteOffset, vecArr.byteLength))
    const modality = toVectorModality(args.modality)
    const now = Date.now()

    const tx = db.transaction(() => {
        db.prepare(`
            INSERT INTO memory_vectors(
                id, memory_id, asset_id, conversation_id, strategy_key, strategy_version,
                model, modality, dim, vector, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                                          memory_id = excluded.memory_id,
                                          asset_id  = excluded.asset_id,
                                          conversation_id = excluded.conversation_id,
                                          strategy_key = excluded.strategy_key,
                                          strategy_version = excluded.strategy_version,
                                          model     = excluded.model,
                                          modality  = excluded.modality,
                                          dim       = excluded.dim,
                                          vector    = excluded.vector,
                                          created_at= excluded.created_at
        `).run(
            vecId,
            args.memoryId ?? null,
            args.assetId ?? null,
            args.conversationId,
            scope.strategyKey,
            scope.strategyVersion,
            args.model,
            modality,
            args.dim,
            vecBuf,
            now
        )

        upsertEmbedding(
            { level: args.level, model: args.model, dim: args.dim, metric: args.metric },
            {
                vecId,
                memId: args.memoryId,
                assetId: args.assetId,
                modality,
                conversationId: args.conversationId,
            },
            vecArr
        )
    })

    tx()
    return vecId
}
