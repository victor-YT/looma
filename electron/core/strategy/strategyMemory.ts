import fs from 'node:fs'
import type { Database } from 'better-sqlite3'
import type {
    MemoryHit,
    MemoryIngestRequest,
    MemoryIngestResult,
    StrategyRecord,
} from '../../../contracts/index'
import { ingestDocument, readAsset, searchChunks } from '../memory/memoryStore'
import { getStrategyOrFallback } from './strategyRegistry'
import { resolveEmbeddingProfile } from '../memory/embeddingProfile'
import { resolveStrategyMemoryCloudFeature } from './strategyFeatures'
import { log } from '../logging/runtimeLogger'

type StrategyMemorySearchInput = {
    conversationId: string
    query: string
    options?: {
        topK?: number
        threshold?: number
    }
}

type StrategyMemoryReadInput = {
    conversationId: string
    assetId: string
    maxChars?: number
}

type StrategyMemoryIngestInput = MemoryIngestRequest

function errorToLog(err: unknown): string {
    if (err instanceof Error) return err.stack ?? err.message
    return String(err)
}

function normalizeThreshold(value: number | undefined): number | undefined {
    if (!Number.isFinite(value)) return undefined
    return Math.min(1, Math.max(0, value as number))
}

async function assertMemoryCloudEnabled(db: Database, conversationId: string): Promise<StrategyRecord> {
    if (!conversationId) throw new Error('conversationId required')
    const conversation = db.prepare(`SELECT id, strategy_id FROM conversations WHERE id = ?`)
        .get(conversationId) as { id?: string; strategy_id?: string | null } | undefined
    if (!conversation?.id) throw new Error('conversation not found')

    const resolved = getStrategyOrFallback(db, {
        requestedStrategyId: conversation.strategy_id ?? null,
        conversationId,
    })
    const enabled = await resolveStrategyMemoryCloudFeature(resolved.strategy)
    if (!enabled) throw new Error('MEMORY_CLOUD_DISABLED')
    return resolved.strategy
}

function toSimilarity(score: number, metric: 'cosine' | 'l2' | 'dot'): number {
    if (!Number.isFinite(score)) return 0
    if (metric === 'l2') {
        const dist = Math.max(0, -score)
        return 1 / (1 + dist)
    }
    const raw = (score + 1) / 2
    if (raw <= 0) return 0
    if (raw >= 1) return 1
    return raw
}

export async function strategyMemorySearch(
    db: Database,
    args: StrategyMemorySearchInput,
): Promise<MemoryHit[]> {
    const t0 = Date.now()
    const strategy = await assertMemoryCloudEnabled(db, args.conversationId)
    const threshold = normalizeThreshold(args.options?.threshold)
    log('info', '[MEMORY_CLOUD][strategy_search_start]', {
        conversationId: args.conversationId,
        strategyId: strategy.id,
        queryLength: args.query?.length ?? 0,
        topK: args.options?.topK ?? null,
    })
    try {
        const request = {
            query: args.query,
            topK: args.options?.topK,
            scope: { type: 'conversation' as const, id: args.conversationId },
        }
        const result = await searchChunks(db, {
            conversationId: args.conversationId,
            request,
        })
        const profile = resolveEmbeddingProfile(undefined)
        const hits = result.chunks
            .map((chunk) => ({
                id: chunk.chunkId,
                type: 'chunk' as const,
                content: chunk.text,
                similarity: toSimilarity(chunk.score, profile.metric),
                assetId: chunk.assetId,
                chunkId: chunk.chunkId,
                source: {
                    strategyId: strategy.id,
                    conversationId: args.conversationId,
                },
            }))
            .filter((hit) => threshold == null || hit.similarity >= threshold)
        log('info', '[MEMORY_CLOUD][strategy_search_done]', {
            conversationId: args.conversationId,
            strategyId: strategy.id,
            elapsedMs: Date.now() - t0,
            count: hits.length,
        })
        return hits
    } catch (err) {
        log('error', '[MEMORY_CLOUD][strategy_search_error]', {
            conversationId: args.conversationId,
            strategyId: strategy.id,
            elapsedMs: Date.now() - t0,
            error: errorToLog(err),
        })
        throw err
    }
}

export async function strategyMemoryReadAsset(
    db: Database,
    args: StrategyMemoryReadInput,
): Promise<string> {
    const t0 = Date.now()
    const strategy = await assertMemoryCloudEnabled(db, args.conversationId)
    log('info', '[MEMORY_CLOUD][strategy_read_start]', {
        conversationId: args.conversationId,
        strategyId: strategy.id,
        assetId: args.assetId,
    })
    try {
        const detail = readAsset(db, {
            conversationId: args.conversationId,
            assetId: args.assetId,
            maxChars: args.maxChars,
        })
        const text = detail?.text ?? ''
        log('info', '[MEMORY_CLOUD][strategy_read_done]', {
            conversationId: args.conversationId,
            strategyId: strategy.id,
            assetId: args.assetId,
            elapsedMs: Date.now() - t0,
            textLength: text.length,
        })
        return text
    } catch (err) {
        log('error', '[MEMORY_CLOUD][strategy_read_error]', {
            conversationId: args.conversationId,
            strategyId: strategy.id,
            assetId: args.assetId,
            elapsedMs: Date.now() - t0,
            error: errorToLog(err),
        })
        throw err
    }
}

function buildAssetIngestInput(
    db: Database,
    args: StrategyMemoryIngestInput,
): StrategyMemoryIngestInput {
    const assetId = args.assetId?.trim()
    if (!assetId) {
        throw new Error('MEMORY_ASSET_NOT_FOUND')
    }
    const row = db.prepare(`
        SELECT
            a.id,
            a.filename,
            a.uri,
            a.storage_backend,
            a.mime_type,
            ab.bytes
        FROM memory_assets a
        LEFT JOIN asset_blobs ab ON ab.id = a.blob_id
        WHERE a.id = ?
          AND a.conversation_id = ?
        LIMIT 1
    `).get(assetId, args.conversationId) as {
        id: string
        filename?: string | null
        uri?: string | null
        storage_backend: string
        mime_type?: string | null
        bytes?: Buffer | null
    } | undefined
    if (!row) {
        throw new Error('MEMORY_ASSET_NOT_FOUND')
    }

    let data: Uint8Array | undefined
    if (row.bytes && row.bytes.byteLength > 0) {
        data = new Uint8Array(row.bytes)
    } else if (row.storage_backend === 'file' && typeof row.uri === 'string' && row.uri.trim()) {
        data = new Uint8Array(fs.readFileSync(row.uri))
    }

    if (data && data.byteLength > 0) {
        return {
            ...args,
            assetId: undefined,
            filename: row.filename ?? assetId,
            mime: row.mime_type ?? args.mime,
            data,
            text: undefined,
        }
    }

    const detail = readAsset(db, {
        conversationId: args.conversationId,
        assetId,
    })
    const text = detail?.text?.trim()
    if (!text) {
        throw new Error('MEMORY_ASSET_NOT_READABLE')
    }

    return {
        ...args,
        assetId: undefined,
        filename: row.filename ?? `${assetId}.txt`,
        mime: row.mime_type ?? 'text/plain',
        data: undefined,
        text,
    }
}

export async function strategyMemoryIngest(
    db: Database,
    args: StrategyMemoryIngestInput,
): Promise<MemoryIngestResult> {
    const t0 = Date.now()
    const strategy = await assertMemoryCloudEnabled(db, args.conversationId)
    const wait = args.options?.wait ?? 'load'
    const inputKind = args.assetId
        ? 'asset'
        : args.text
            ? 'text'
            : args.data
                ? 'bytes'
                : 'unknown'
    log('info', '[MEMORY_CLOUD][strategy_ingest_start]', {
        conversationId: args.conversationId,
        strategyId: strategy.id,
        inputKind,
        wait,
        assetId: args.assetId ?? null,
    })
    try {
        const ingestArgs = args.assetId ? buildAssetIngestInput(db, args) : args
        const result = await ingestDocument(db, ingestArgs)
        const phase = result.status === 'loaded'
            ? '[MEMORY_CLOUD][strategy_ingest_loaded]'
            : result.status === 'completed'
                ? '[MEMORY_CLOUD][strategy_ingest_completed]'
                : '[MEMORY_CLOUD][strategy_ingest_error]'
        log(result.status === 'failed' ? 'error' : 'info', phase, {
            conversationId: args.conversationId,
            strategyId: strategy.id,
            inputKind,
            wait,
            assetId: result.assetId,
            elapsedMs: Date.now() - t0,
        })
        return result
    } catch (err) {
        log('error', '[MEMORY_CLOUD][strategy_ingest_error]', {
            conversationId: args.conversationId,
            strategyId: strategy.id,
            inputKind,
            wait,
            assetId: args.assetId ?? null,
            elapsedMs: Date.now() - t0,
            error: errorToLog(err),
        })
        throw err
    }
}
