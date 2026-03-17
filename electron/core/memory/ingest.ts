import type { Database } from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { persistAssetFile } from './pipeline/write'
import { extractTextFromBytes } from './pipeline/extractors'
import { chunkDocumentText, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, normalizeText } from './pipeline/chunking'
import { resolveMediaModality } from './pipeline/routeModality'
import { embedTextsWithProfile, normalizeEmbedding, resolveEmbeddingProfile } from './pipeline/embedding'
import { createMemoryItem } from './assets'
import { ensureAssetBlob, insertOrReuseConversationAsset, selectAssetByConversationAndBlob } from './assetUpsert'
import { assertConversationId, assertStrategyScope, errorToLog, mergeMeta, resolveStrategyId, resolveStrategyScope } from './utils'
import { loadAssetText } from '../attachments/assetLoader'
import type {
    MemoryIngestRequest,
    MemoryIngestResult,
    MemoryIngestProgress,
    Modality,
} from '../../../contracts/index'

type ProgressFn = (p: MemoryIngestProgress) => void
type LegacyIngestOptions = MemoryIngestRequest['options'] & { indexing?: 'full' | 'chunkOnly' | 'rawOnly' }

function resolveIngestMode(
    options: LegacyIngestOptions,
): 'raw' | 'chunk' | 'rag' {
    const mode = options?.mode
    if (mode === 'raw' || mode === 'chunk' || mode === 'rag') return mode
    const legacyIndexing = (options as LegacyIngestOptions | undefined)?.indexing
    if (legacyIndexing === 'rawOnly') return 'raw'
    if (legacyIndexing === 'chunkOnly') return 'chunk'
    return 'rag'
}

function toAssetStorageKey(row: { storage_backend?: string | null; uri?: string | null } | null | undefined): string | undefined {
    if (!row) return undefined
    if (row.storage_backend !== 'file') return undefined
    if (typeof row.uri !== 'string') return undefined
    const trimmed = row.uri.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

function parseMetaValue(meta: string | null | undefined, key: string): unknown {
    if (!meta || !meta.trim()) return undefined
    try {
        const parsed = JSON.parse(meta) as Record<string, unknown>
        return parsed[key]
    } catch {
        return undefined
    }
}

function readMetaChunkCount(meta: string | null | undefined): number {
    const value = parseMetaValue(meta, 'chunk_count')
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function readMetaIngestStatus(meta: string | null | undefined): string | null {
    const value = parseMetaValue(meta, 'ingest_status')
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null
}

function cleanupConflictSideEffects(args: {
    db: Database
    candidateMemoryId: string
    candidateUri?: string
    selectedAssetUri?: string
}): void {
    if (
        args.candidateUri
        && args.selectedAssetUri
        && args.candidateUri !== args.selectedAssetUri
        && fs.existsSync(args.candidateUri)
    ) {
        try {
            fs.unlinkSync(args.candidateUri)
        } catch {
            // best effort cleanup
        }
    }
    args.db.prepare(`
        DELETE FROM memory_items
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM memory_assets WHERE memory_id = ?)
    `).run(args.candidateMemoryId, args.candidateMemoryId)
}


export async function ingestDocument(
    db: Database,
    input: MemoryIngestRequest & { onProgress?: ProgressFn },
): Promise<MemoryIngestResult> {
    assertConversationId(input.conversationId)
    const scope = resolveStrategyScope(db, input.conversationId, input)
    assertStrategyScope(scope)
    const now = Date.now()
    const options = input.options ?? {}
    const isAttachmentIngest = typeof options.type === 'string' && options.type.startsWith('attachment.')
    const isExplicitMemoryCloud = typeof options.type === 'string' && options.type.startsWith('memory_cloud.')
    const tagStore = isAttachmentIngest ? '[ASSET_STORE]' : isExplicitMemoryCloud ? '[MEMORY_CLOUD][STORE]' : '[MEMORY][STORE]'
    const tagIngest = isAttachmentIngest ? '[ASSET_STORE][INGEST]' : isExplicitMemoryCloud ? '[MEMORY_CLOUD][INGEST]' : '[MEMORY][INGEST]'
    const tagAsset = isAttachmentIngest ? '[ASSET_STORE][ASSET]' : isExplicitMemoryCloud ? '[MEMORY_CLOUD][ASSET]' : '[MEMORY][ASSET]'
    const tagIndex = isAttachmentIngest ? '[ASSET_STORE][INDEX]' : isExplicitMemoryCloud ? '[MEMORY_CLOUD][INDEX]' : '[MEMORY][INDEX]'
    const wait =
        options.wait === 'full'
            ? 'full'
            : options.wait === 'load'
                ? 'load'
                : options.wait
                    ? 'full'
                    : 'load'
    const mode = resolveIngestMode(options)
    const profile = resolveEmbeddingProfile(undefined)
    const assetId = `asset_${crypto.randomUUID()}`
    const strategyId = resolveStrategyId(db, input.conversationId)
    const filename = input.filename || (input.text ? 'ingest.txt' : 'document')
    const mimeType = input.mime
        ?? (filename.toLowerCase().endsWith('.pdf')
            ? 'application/pdf'
            : (input.text ? 'text/plain' : 'application/octet-stream'))
    const logBase = {
        conversationId: input.conversationId,
        assetId,
        strategyId,
        filename,
        mime: mimeType,
        wait,
    }
    let phase = 'load'
    const emit = (patch: Omit<MemoryIngestProgress, 'conversationId' | 'assetId'>) => {
        input.onProgress?.({
            conversationId: input.conversationId,
            assetId,
            ...patch,
        })
    }
    const updateAssetMeta = (patch: Record<string, unknown>) => {
        const metaRow = db.prepare(`SELECT meta FROM memory_assets WHERE id = ?`).get(assetId) as { meta?: string | null } | undefined
        db.prepare(`UPDATE memory_assets SET meta = ? WHERE id = ?`)
            .run(mergeMeta(metaRow?.meta ?? null, patch), assetId)
    }

    try {
        console.debug(tagStore, phase, logBase)
        console.debug(tagIngest, 'start', logBase)
        emit({ phase: 'parse', done: 0, total: 1 })

        const hasData = Boolean(input.data && input.data.length > 0)
        const sourceBytes = hasData
            ? input.data
            : (input.text ? new TextEncoder().encode(input.text) : null)
        if (!sourceBytes || sourceBytes.length === 0) {
            console.error(tagStore, 'failed', {
                ...logBase,
                phase,
                error: 'no input provided',
            })
            console.error(tagIngest, 'failed', {
                ...logBase,
                phase,
                error: 'no input provided',
            })
            emit({ phase: 'failed', status: 'failed' })
            return { assetId, chunkCount: 0, status: 'failed', reason: 'no_text', error: 'no input provided' }
        }
        const assetSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex')
        const assetBlob = ensureAssetBlob({
            db,
            bytes: sourceBytes,
            sha256: assetSha256,
            mimeType,
            createdAt: now,
        })
        const existingAsset = selectAssetByConversationAndBlob(db, input.conversationId, assetBlob.id)
        if (existingAsset) {
            const existingChunkCount = readMetaChunkCount(existingAsset.meta)
            const existingStatus = readMetaIngestStatus(existingAsset.meta)
            const completed = existingStatus === 'completed'
            console.debug(tagAsset, 'reuse', {
                ...logBase,
                requestedAssetId: assetId,
                reusedAssetId: existingAsset.id,
                sha256: assetSha256,
                storageKey: existingAsset.uri,
                ingestStatus: existingStatus ?? 'unknown',
            })
            emit({ phase: 'loaded', done: existingChunkCount, total: existingChunkCount })
            if (wait === 'load' || !completed) {
                return {
                    assetId: existingAsset.id,
                    storageKey: toAssetStorageKey(existingAsset),
                    chunkCount: existingChunkCount,
                    status: 'loaded',
                }
            }
            emit({ phase: 'completed', status: 'completed', done: existingChunkCount, total: existingChunkCount })
            return {
                assetId: existingAsset.id,
                storageKey: toAssetStorageKey(existingAsset),
                chunkCount: existingChunkCount,
                status: 'completed',
            }
        }
        let loadedPreview: Awaited<ReturnType<typeof loadAssetText>> | null = null
        try {
            loadedPreview = await loadAssetText({
                bytes: sourceBytes,
                filename,
                mimeType,
            })
        } catch (err) {
            console.warn(isAttachmentIngest ? '[ASSET_STORE][LOADER] preview failed' : '[MEMORY][LOADER] preview failed', {
                conversationId: input.conversationId,
                filename,
                mime: mimeType,
                error: errorToLog(err),
            })
        }
        const mediaModality = resolveMediaModality(mimeType, filename)
        const indexing = mediaModality
            ? 'raw'
            : mode
        const routedModality: Modality = mediaModality ?? (hasData ? 'file' : 'text')
        const ingestType = options.type ?? (mediaModality ? 'asset.raw' : 'doc.source')
        console.debug(tagIngest, 'modality route', {
            conversationId: input.conversationId,
            assetId,
            strategyId,
            filename,
            mime: mimeType,
            sizeBytes: sourceBytes.length,
            wait,
            indexing,
            modality: routedModality,
        })

        if (indexing === 'raw') {
            const hasFile = hasData
            let filePath = ''
            if (hasFile) {
                filePath = persistAssetFile({
                    filename,
                    data: input.data as Uint8Array,
                    defaultExt: '.bin',
                    contentHash: assetSha256,
                })
            }

            const memoryId = createMemoryItem(db, {
                conversationId: input.conversationId,
                strategyId: strategyId ?? 'manual.ingest',
                type: ingestType,
                modality: routedModality,
                textRepr: filename || 'asset',
                tags: options.tags,
                meta: {
                    filename,
                    mime: mimeType,
                    sha256: assetSha256,
                    ingest_status: 'completed',
                    mode: 'raw',
                    reason: 'index_disabled',
                    loader_id: loadedPreview?.loaderId ?? null,
                    loader_kind: loadedPreview?.kind ?? null,
                    loader_text_chars: loadedPreview?.textLength ?? 0,
                    loader_text_preview: loadedPreview?.text.slice(0, 200) ?? '',
                },
                source: input.source,
            })

            const storageBackend = hasFile ? 'file' : 'local'
            const storageUri = hasFile ? filePath : ''
            phase = 'write_asset'
            console.debug(tagStore, phase, logBase)
            const upsert = insertOrReuseConversationAsset({
                db,
                row: {
                    id: assetId,
                    memoryId,
                    conversationId: input.conversationId,
                    blobId: assetBlob.id,
                    filename,
                    uri: storageUri,
                    storageBackend,
                    mimeType,
                    sha256: assetSha256,
                    sizeBytes: hasFile ? (input.data?.byteLength ?? sourceBytes.length) : sourceBytes.length,
                    metaJson: JSON.stringify({
                        filename,
                        mime: mimeType,
                        sha256: assetSha256,
                        storage_key: storageUri,
                        ingest_status: 'completed',
                        mode: 'raw',
                        reason: 'index_disabled',
                        loader_id: loadedPreview?.loaderId ?? null,
                        loader_kind: loadedPreview?.kind ?? null,
                        loader_text_chars: loadedPreview?.textLength ?? 0,
                        loader_text_preview: loadedPreview?.text.slice(0, 200) ?? '',
                    }),
                    createdAt: now,
                },
            })
            if (!upsert.inserted) {
                cleanupConflictSideEffects({
                    db,
                    candidateMemoryId: memoryId,
                    candidateUri: storageUri || undefined,
                    selectedAssetUri: upsert.asset.uri,
                })
                const existingChunkCount = readMetaChunkCount(upsert.asset.meta)
                emit({ phase: 'loaded', done: existingChunkCount, total: existingChunkCount })
                if (wait === 'load') {
                    return {
                        assetId: upsert.asset.id,
                        storageKey: toAssetStorageKey(upsert.asset),
                        chunkCount: existingChunkCount,
                        status: 'loaded',
                    }
                }
                emit({ phase: 'completed', status: 'completed', done: existingChunkCount, total: existingChunkCount })
                return {
                    assetId: upsert.asset.id,
                    storageKey: toAssetStorageKey(upsert.asset),
                    chunkCount: existingChunkCount,
                    status: 'completed',
                }
            }

            console.debug(tagAsset, 'create', {
                ...logBase,
                sizeBytes: sourceBytes.length,
                mode: 'raw',
            })
            console.debug(tagIndex, 'skip', {
                ...logBase,
                sizeBytes: sourceBytes.length,
                reason: 'index_disabled',
                mode: 'raw',
            })

            emit({ phase: 'loaded', done: 1, total: 1, status: 'completed' })
            emit({ phase: 'completed', status: 'completed', done: 1, total: 1 })

            if (wait === 'load') {
                return { assetId, storageKey: hasFile ? storageUri : undefined, chunkCount: 0, status: 'loaded', reason: 'index_disabled' }
            }
            return { assetId, storageKey: hasFile ? storageUri : undefined, chunkCount: 0, status: 'completed', reason: 'index_disabled' }
        }
        phase = 'extract'
        console.debug(tagStore, phase, {
            ...logBase,
            sizeBytes: sourceBytes.length,
        })
        const text = await extractTextFromBytes(sourceBytes, {
            filename,
            mime: mimeType,
        })

        const normalized = normalizeText(text)
        if (!normalized) {
            console.error(tagStore, 'failed', {
                ...logBase,
                phase,
                error: 'no text extracted',
            })
            console.error(tagIngest, 'failed', {
                ...logBase,
                phase,
                error: 'no text extracted',
            })
            emit({ phase: 'failed', status: 'failed' })
            return { assetId, chunkCount: 0, status: 'failed', reason: 'no_text', error: 'no text extracted' }
        }

        const hasFile = hasData
        let filePath = ''
        if (hasFile) {
            filePath = persistAssetFile({
                filename,
                data: input.data as Uint8Array,
                defaultExt: '.txt',
                contentHash: assetSha256,
            })
        }

        const modality: Modality = hasFile ? 'file' : 'text'
        const memoryId = createMemoryItem(db, {
            conversationId: input.conversationId,
            strategyId: strategyId ?? 'manual.ingest',
            type: ingestType,
            modality,
            textRepr: filename || 'document',
            tags: options.tags,
            meta: {
                filename,
                mime: mimeType,
                sha256: assetSha256,
                ingest_status: 'ingesting',
                embedding_profile: indexing === 'rag' ? profile.name : null,
                mode: indexing,
                loader_id: loadedPreview?.loaderId ?? null,
                loader_kind: loadedPreview?.kind ?? null,
                loader_text_chars: loadedPreview?.textLength ?? 0,
                loader_text_preview: loadedPreview?.text.slice(0, 200) ?? '',
            },
            source: input.source,
        })

        const storageBackend = hasFile ? 'file' : 'local'
        const storageUri = hasFile ? filePath : ''
        phase = 'write_asset'
        console.debug(tagStore, phase, logBase)
        const upsert = insertOrReuseConversationAsset({
            db,
            row: {
                id: assetId,
                memoryId,
                conversationId: input.conversationId,
                blobId: assetBlob.id,
                filename,
                uri: storageUri,
                storageBackend,
                mimeType,
                sha256: assetSha256,
                sizeBytes: hasFile ? (input.data?.byteLength ?? sourceBytes.length) : Buffer.byteLength(normalized, 'utf8'),
                metaJson: JSON.stringify({
                    filename,
                    mime: mimeType,
                    sha256: assetSha256,
                    storage_key: storageUri,
                    ingest_status: 'ingesting',
                    embedding_profile: indexing === 'rag' ? profile.name : null,
                    mode: indexing,
                    loader_id: loadedPreview?.loaderId ?? null,
                    loader_kind: loadedPreview?.kind ?? null,
                    loader_text_chars: loadedPreview?.textLength ?? 0,
                    loader_text_preview: loadedPreview?.text.slice(0, 200) ?? '',
                }),
                createdAt: now,
            },
        })
        if (!upsert.inserted) {
            cleanupConflictSideEffects({
                db,
                candidateMemoryId: memoryId,
                candidateUri: storageUri || undefined,
                selectedAssetUri: upsert.asset.uri,
            })
            const existingChunkCount = readMetaChunkCount(upsert.asset.meta)
            const existingStatus = readMetaIngestStatus(upsert.asset.meta)
            emit({ phase: 'loaded', done: existingChunkCount, total: existingChunkCount })
            if (wait === 'load' || existingStatus !== 'completed') {
                return {
                    assetId: upsert.asset.id,
                    storageKey: toAssetStorageKey(upsert.asset),
                    chunkCount: existingChunkCount,
                    status: 'loaded',
                }
            }
            emit({ phase: 'completed', status: 'completed', done: existingChunkCount, total: existingChunkCount })
            return {
                assetId: upsert.asset.id,
                storageKey: toAssetStorageKey(upsert.asset),
                chunkCount: existingChunkCount,
                status: 'completed',
            }
        }
        console.debug(tagAsset, 'create', {
            ...logBase,
            sizeBytes: sourceBytes.length,
            mode: indexing,
        })

        const chunkSize = Math.max(100, options.chunkSize ?? DEFAULT_CHUNK_SIZE)
        const overlap = Math.max(0, Math.min(chunkSize - 1, options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP))

        const finalizeIngest = async (): Promise<number> => {
            const chunks = chunkDocumentText(normalized, chunkSize, overlap)
            phase = 'chunk'
            console.debug(tagStore, phase, { ...logBase, chunkCount: chunks.length })
            if (!chunks.length) {
                console.debug(tagIndex, 'skip', {
                    ...logBase,
                    sizeBytes: sourceBytes.length,
                    reason: 'no_text',
                    mode: indexing,
                })
            }
            emit({ phase: 'chunk', done: chunks.length, total: chunks.length })

            if (!chunks.length) {
                throw new Error('no chunks created')
            }

            const vectors = indexing === 'rag'
                ? (() => {
                    phase = 'embed'
                    console.debug(tagStore, phase, { ...logBase, chunkCount: chunks.length })
                    return embedTextsWithProfile(profile, chunks).then((embedded) => {
                        const vecs = embedded.vectors.map((v) => normalizeEmbedding(profile, v))
                        emit({ phase: 'embed', done: vecs.length, total: vecs.length })
                        return vecs
                    })
                })()
                : (() => {
                    console.debug(tagIndex, 'skip', {
                        ...logBase,
                        sizeBytes: sourceBytes.length,
                        reason: 'index_disabled',
                        mode: indexing,
                    })
                    return Promise.resolve([] as Float32Array[])
                })()
            const resolvedVectors = await vectors

            phase = 'write_chunks'
            console.debug(tagStore, phase, { ...logBase, chunkCount: chunks.length })
            const tx = db.transaction(() => {
                for (let i = 0; i < chunks.length; i++) {
                    const textChunk = chunks[i]
                    const hash = crypto.createHash('sha1').update(textChunk).digest('hex')
                    const chunkId = `chunk_${crypto.randomUUID()}`
                    db.prepare(`
                        INSERT OR IGNORE INTO memory_chunks(
                            id, asset_id, conversation_id, strategy_key, strategy_version, idx, text, hash, tokens, meta_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        chunkId,
                        assetId,
                        input.conversationId,
                        scope.strategyKey,
                        scope.strategyVersion,
                        i,
                        textChunk,
                        hash,
                        null,
                        null,
                        now
                    )

                    const row = db.prepare(`
                        SELECT id FROM memory_chunks
                        WHERE asset_id = ? AND hash = ? AND conversation_id = ?
                          AND strategy_key = ? AND strategy_version = ?
                    `).get(assetId, hash, input.conversationId, scope.strategyKey, scope.strategyVersion) as { id: string } | undefined
                    const finalChunkId = row?.id ?? chunkId

                    if (indexing === 'rag') {
                        const vec = resolvedVectors[i]
                        if (!vec) continue
                        const vecBuf = Buffer.from(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength))
                        db.prepare(`
                            INSERT INTO memory_chunk_vectors(
                                id, chunk_id, conversation_id, strategy_key, strategy_version, embedding_profile, vector, dim, created_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            `vec_${crypto.randomUUID()}`,
                            finalChunkId,
                            input.conversationId,
                            scope.strategyKey,
                            scope.strategyVersion,
                            profile.name,
                            vecBuf,
                            vec.length,
                            now
                        )
                    }
                }
            })
            tx()

            emit({ phase: 'write', done: chunks.length, total: chunks.length })

            updateAssetMeta({
                ingest_status: 'completed',
                chunk_count: chunks.length,
                embedding_profile: indexing === 'rag' ? profile.name : null,
                mode: indexing,
            })

            phase = 'completed'
            console.debug(tagStore, phase, { ...logBase, chunkCount: chunks.length })
            emit({ phase: 'completed', status: 'completed', done: chunks.length, total: chunks.length })
            return chunks.length
        }

        if (wait === 'load') {
            setImmediate(() => {
                void (async () => {
                    try {
                        await finalizeIngest()
                    } catch (err) {
                        updateAssetMeta({ ingest_status: 'failed', error: errorToLog(err) })
                        emit({ phase: 'failed', status: 'failed' })
                        console.error(tagStore, 'failed', {
                            ...logBase,
                            phase,
                            error: errorToLog(err),
                        })
                        console.error(tagIngest, 'failed', {
                            ...logBase,
                            phase,
                            error: errorToLog(err),
                        })
                    }
                })()
            })
            return { assetId, storageKey: hasFile ? storageUri : undefined, chunkCount: 0, status: 'loaded' }
        }

        const chunkCount = await finalizeIngest()
        return { assetId, storageKey: hasFile ? storageUri : undefined, chunkCount, status: 'completed' }
    } catch (err) {
        updateAssetMeta({ ingest_status: 'failed', error: errorToLog(err) })
        emit({ phase: 'failed', status: 'failed' })
        console.error(tagStore, 'failed', {
            ...logBase,
            phase,
            error: errorToLog(err),
        })
        console.error(tagIngest, 'failed', {
            ...logBase,
            phase,
            error: errorToLog(err),
        })
        const message = err instanceof Error ? err.message : String(err)
        const reason =
            message.includes('[ingest] no extractor')
                ? 'unsupported'
                : message.includes('no text')
                    ? 'no_text'
                    : undefined
        return { assetId, chunkCount: 0, status: 'failed', reason, error: message }
    }
}
