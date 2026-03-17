import type { Database } from 'better-sqlite3'
import crypto from 'node:crypto'
import type { MemoryAssetRecord, MemoryAssetDetail, MemoryRecord, Modality } from '../../../contracts/index'
import { assertConversationId, assertStrategyScope, mergeMeta, resolveStrategyScope } from './utils'
import { ensureAssetBlob } from './assetUpsert'

export type MemoryItemCreateInput = {
    conversationId: string
    strategyId: string
    type: string
    modality: Modality
    text?: string
    textRepr?: string
    textReprModel?: string
    content?: string
    sizeTokens?: number
    tags?: unknown[]
    meta?: Record<string, unknown>
    contentHash?: string
    priority?: number
    pinned?: boolean
    source?: {
        conversationId?: string
        turnId?: string
        messageId?: string
    }
}

export function createMemoryItem(db: Database, input: MemoryItemCreateInput): string {
    assertConversationId(input.conversationId)
    const now = Date.now()
    const id = `mem_${crypto.randomUUID()}`
    const jsonTags = input.tags ? JSON.stringify(input.tags) : null
    const jsonMeta = input.meta ? JSON.stringify(input.meta) : null

    db.prepare(`
        INSERT INTO memory_items(
            id, strategy_id,
            scope_type, scope_id,
            owner_type, owner_id,
            source_conversation_id, source_turn_id, source_message_id,
            type, modality,
            text_repr, text_repr_model,
            content, size_tokens,
            tags, meta, content_hash,
            priority,
            pinned,
            created_at, updated_at
        ) VALUES (
            @id, @strategy_id,
            'conversation', @scope_id,
            'conversation', @owner_id,
            @source_conversation_id, @source_turn_id, @source_message_id,
            @type, @modality,
            @text_repr, @text_repr_model,
            @content, @size_tokens,
            @tags, @meta, @content_hash,
            @priority,
            @pinned,
            @created_at, @updated_at
        )
    `).run({
        id,
        strategy_id: input.strategyId,
        scope_id: input.conversationId,
        owner_id: input.conversationId,
        source_conversation_id: input.source?.conversationId ?? null,
        source_turn_id: input.source?.turnId ?? null,
        source_message_id: input.source?.messageId ?? null,
        type: input.type,
        modality: input.modality,
        text_repr: input.textRepr ?? input.text ?? null,
        text_repr_model: input.textReprModel ?? null,
        content: input.content ?? input.text ?? null,
        size_tokens: input.sizeTokens ?? null,
        tags: jsonTags,
        meta: jsonMeta,
        content_hash: input.contentHash ?? null,
        priority: input.priority ?? null,
        pinned: input.pinned ? 1 : 0,
        created_at: now,
        updated_at: now,
    })

    return id
}

function parseTags(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    } catch {
        return []
    }
}

function normalizePreview(value: string | null | undefined, max = 240): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    if (!trimmed) return undefined
    return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`
}

function matchesAllTags(recordTags: string[], wanted: string[] | undefined): boolean {
    if (!wanted?.length) return true
    const tagSet = new Set(recordTags)
    return wanted.every((tag) => tagSet.has(tag))
}

export function queryMemoryRecords(
    db: Database,
    args: {
        conversationId: string
        tags?: string[]
        types?: string[]
        pinned?: boolean
        hasAsset?: boolean
        orderBy?: 'updatedAt' | 'createdAt'
        order?: 'desc' | 'asc'
        limit?: number
        offset?: number
    },
): MemoryRecord[] {
    assertConversationId(args.conversationId)
    const rows = db.prepare(`
        SELECT
            m.id,
            m.type,
            m.modality,
            m.text_repr,
            m.content,
            m.tags,
            m.created_at,
            m.updated_at,
            m.pinned,
            (
                SELECT a.id
                FROM memory_assets a
                WHERE a.memory_id = m.id
                ORDER BY a.created_at ASC
                LIMIT 1
            ) AS asset_id
        FROM memory_items m
        WHERE m.scope_type = 'conversation'
          AND m.scope_id = ?
    `).all(args.conversationId) as Array<{
        id: string
        type: string
        modality: Modality
        text_repr?: string | null
        content?: string | null
        tags?: string | null
        created_at: number
        updated_at: number
        pinned: 0 | 1
        asset_id?: string | null
    }>

    const records = rows.map((row): MemoryRecord => ({
        id: row.id,
        assetId: row.asset_id ?? undefined,
        title: row.text_repr ?? undefined,
        type: row.type,
        modality: row.modality,
        preview: normalizePreview(row.content ?? row.text_repr),
        tags: parseTags(row.tags),
        pinned: row.pinned === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }))

    const filtered = records.filter((record) => {
        if (args.types?.length && !args.types.includes(record.type)) return false
        if (typeof args.pinned === 'boolean' && record.pinned !== args.pinned) return false
        if (typeof args.hasAsset === 'boolean' && Boolean(record.assetId) !== args.hasAsset) return false
        return matchesAllTags(record.tags, args.tags)
    })

    const orderBy = args.orderBy ?? 'updatedAt'
    const direction = args.order === 'asc' ? 1 : -1
    filtered.sort((left, right) => {
        const a = orderBy === 'createdAt' ? left.createdAt : left.updatedAt
        const b = orderBy === 'createdAt' ? right.createdAt : right.updatedAt
        if (a !== b) return (a - b) * direction
        return left.id.localeCompare(right.id) * direction
    })

    const offset = Math.max(0, args.offset ?? 0)
    const limit = args.limit == null ? filtered.length : Math.max(0, args.limit)
    return filtered.slice(offset, offset + limit)
}

export function updateMemoryItem(
    db: Database,
    args: {
        conversationId: string
        memoryId: string
        title?: string
        tags?: unknown[]
        meta?: Record<string, unknown>
        priority?: number
    }
): void {
    assertConversationId(args.conversationId)
    const now = Date.now()
    db.prepare(`
        UPDATE memory_items
        SET text_repr = COALESCE(@title, text_repr),
            tags = COALESCE(@tags, tags),
            meta = COALESCE(@meta, meta),
            priority = COALESCE(@priority, priority),
            updated_at = @updated_at
        WHERE id = @id
          AND scope_type = 'conversation'
          AND scope_id = @scope_id
    `).run({
        id: args.memoryId,
        scope_id: args.conversationId,
        title: args.title ?? null,
        tags: args.tags ? JSON.stringify(args.tags) : null,
        meta: args.meta ? JSON.stringify(args.meta) : null,
        priority: args.priority ?? null,
        updated_at: now,
    })
}

export function setMemoryPinned(
    db: Database,
    args: { conversationId: string; memoryId: string; pinned: boolean },
): void {
    assertConversationId(args.conversationId)
    const now = Date.now()
    db.prepare(`
        UPDATE memory_items
        SET pinned = ?, updated_at = ?
        WHERE id = ?
          AND scope_type = 'conversation'
          AND scope_id = ?
    `).run(args.pinned ? 1 : 0, now, args.memoryId, args.conversationId)
}

export function deleteMemoryItem(
    db: Database,
    args: { conversationId: string; memoryId: string },
): boolean {
    assertConversationId(args.conversationId)
    const result = db.prepare(`
        DELETE FROM memory_items
        WHERE id = ?
          AND scope_type = 'conversation'
          AND scope_id = ?
    `).run(args.memoryId, args.conversationId)
    return (result.changes ?? 0) > 0
}

export function listAssets(
    db: Database,
    args: { conversationId: string },
): MemoryAssetRecord[] {
    assertConversationId(args.conversationId)
    const scope = resolveStrategyScope(db, args.conversationId)
    assertStrategyScope(scope)
    const rows = db.prepare(`
        SELECT
            a.id,
            a.memory_id,
            a.uri,
            a.storage_backend,
            a.mime_type,
            a.size_bytes,
            a.meta,
            a.created_at,
            (
                SELECT COUNT(1)
                FROM memory_chunks mc
                WHERE mc.asset_id = a.id
                  AND mc.conversation_id = a.conversation_id
                  AND mc.strategy_key = ?
                  AND mc.strategy_version = ?
            ) AS chunk_count
        FROM memory_assets a
        WHERE a.conversation_id = ?
        ORDER BY a.created_at DESC
    `).all(scope.strategyKey, scope.strategyVersion, args.conversationId) as Array<{
        id: string
        memory_id: string
        uri: string
        storage_backend: string
        mime_type?: string | null
        size_bytes?: number | null
        meta?: string | null
        created_at: number
        chunk_count?: number
    }>
    return rows.map((row) => ({
        id: row.id,
        memoryId: row.memory_id,
        uri: row.uri,
        storageBackend: row.storage_backend,
        mimeType: row.mime_type ?? null,
        sizeBytes: row.size_bytes ?? null,
        meta: row.meta ?? null,
        createdAt: row.created_at,
        chunkCount: row.chunk_count ?? 0,
    }))
}

export function deleteAsset(
    db: Database,
    args: { conversationId: string; assetId: string },
): void {
    assertConversationId(args.conversationId)
    const tx = db.transaction(() => {
        db.prepare(`
            DELETE FROM memory_vectors
            WHERE asset_id = ? AND conversation_id = ?
        `).run(args.assetId, args.conversationId)

        db.prepare(`
            DELETE FROM memory_chunk_vectors
            WHERE chunk_id IN (
                SELECT id FROM memory_chunks
                WHERE asset_id = ? AND conversation_id = ?
            )
        `).run(args.assetId, args.conversationId)

        db.prepare(`
            DELETE FROM memory_chunks
            WHERE asset_id = ? AND conversation_id = ?
        `).run(args.assetId, args.conversationId)

        db.prepare(`
            DELETE FROM memory_assets
            WHERE id = ? AND conversation_id = ?
        `).run(args.assetId, args.conversationId)
    })
    tx()
}

export function readAsset(
    db: Database,
    args: { conversationId: string; assetId: string; maxChars?: number },
): MemoryAssetDetail | null {
    assertConversationId(args.conversationId)
    const scope = resolveStrategyScope(db, args.conversationId)
    assertStrategyScope(scope)
    const row = db.prepare(`
        SELECT id, memory_id, uri, storage_backend, mime_type, size_bytes, meta, created_at
        FROM memory_assets
        WHERE id = ? AND conversation_id = ?
    `).get(args.assetId, args.conversationId) as {
        id: string
        memory_id: string
        uri: string
        storage_backend: string
        mime_type?: string | null
        size_bytes?: number | null
        meta?: string | null
        created_at: number
    } | undefined
    if (!row) return null

    const countRow = db.prepare(`
        SELECT COUNT(1) AS cnt
        FROM memory_chunks
        WHERE asset_id = ? AND conversation_id = ?
          AND strategy_key = ? AND strategy_version = ?
    `).get(args.assetId, args.conversationId, scope.strategyKey, scope.strategyVersion) as { cnt?: number } | undefined

    let text = readAssetText(db, {
        conversationId: args.conversationId,
        assetId: args.assetId,
        strategyKey: scope.strategyKey,
        strategyVersion: scope.strategyVersion,
    })
    if (typeof args.maxChars === 'number' && args.maxChars >= 0 && text) {
        if (text.length > args.maxChars) text = text.slice(0, args.maxChars)
    }

    return {
        asset: {
            id: row.id,
            memoryId: row.memory_id,
            uri: row.uri,
            storageBackend: row.storage_backend,
            mimeType: row.mime_type ?? null,
            sizeBytes: row.size_bytes ?? null,
            meta: row.meta ?? null,
            createdAt: row.created_at,
        },
        chunkCount: countRow?.cnt ?? 0,
        text,
    }
}

export function readAssetText(
    db: Database,
    args: { conversationId: string; assetId: string; strategyKey?: string; strategyVersion?: string },
): string | null {
    assertConversationId(args.conversationId)
    const scope = resolveStrategyScope(db, args.conversationId, args)
    assertStrategyScope(scope)
    const rows = db.prepare(`
        SELECT text
        FROM memory_chunks
        WHERE asset_id = ?
          AND conversation_id = ?
          AND strategy_key = ?
          AND strategy_version = ?
        ORDER BY idx ASC
    `).all(args.assetId, args.conversationId, scope.strategyKey, scope.strategyVersion) as Array<{ text: string }>
    if (!rows.length) return null
    return rows.map(r => r.text).join('\n\n')
}

export function readAssetTextAnyStrategy(
    db: Database,
    args: { conversationId: string; assetId: string },
): string | null {
    assertConversationId(args.conversationId)
    const rows = db.prepare(`
        SELECT text
        FROM memory_chunks
        WHERE asset_id = ?
          AND conversation_id = ?
        ORDER BY strategy_key, strategy_version, idx ASC
    `).all(args.assetId, args.conversationId) as Array<{ text: string }>
    if (!rows.length) return null
    return rows.map(r => r.text).join('\n\n')
}

export function updateAssetMeta(
    db: Database,
    args: { conversationId: string; assetId: string; meta: Record<string, unknown> },
): void {
    assertConversationId(args.conversationId)
    const row = db.prepare(`SELECT meta FROM memory_assets WHERE id = ? AND conversation_id = ?`)
        .get(args.assetId, args.conversationId) as { meta?: string | null } | undefined
    const next = mergeMeta(row?.meta ?? null, args.meta)
    db.prepare(`UPDATE memory_assets SET meta = ? WHERE id = ? AND conversation_id = ?`)
        .run(next, args.assetId, args.conversationId)
}

export function createAssetRecord(
    db: Database,
    args: {
        conversationId: string
        memoryId: string
        uri: string
        filename?: string
        mimeType?: string | null
        sizeBytes?: number | null
        data?: Uint8Array
        meta?: Record<string, unknown>
    },
): string {
    assertConversationId(args.conversationId)
    const assetId = `asset_${crypto.randomUUID()}`
    const hasUri = Boolean(args.uri)
    const storageBackend = hasUri ? 'file' : 'local'
    const storageUri = hasUri ? args.uri : ''
    const blob = args.data
        ? ensureAssetBlob({
            db,
            bytes: args.data,
            mimeType: args.mimeType ?? null,
            createdAt: Date.now(),
        })
        : null
    db.prepare(`
        INSERT INTO memory_assets(
            id, memory_id, conversation_id, blob_id, filename, uri, storage_backend, mime_type, size_bytes, meta, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        assetId,
        args.memoryId,
        args.conversationId,
        blob?.id ?? null,
        args.filename ?? null,
        storageUri,
        storageBackend,
        args.mimeType ?? null,
        args.sizeBytes ?? null,
        args.meta ? JSON.stringify(args.meta) : null,
        Date.now()
    )
    return assetId
}
