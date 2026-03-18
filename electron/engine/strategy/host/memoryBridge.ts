import type { MemoryChunkSearchRequest, MemoryIngestRequest, MemoryQueryOptions } from '../../../../contracts/index'
import { getDB } from '../../../db'
import { listAssets, deleteAsset, queryMemoryRecords, deleteMemoryItem } from '../../../core/memory/memoryStore'
import { strategyMemoryIngest, strategyMemoryReadAsset, strategyMemorySearch } from '../../../core/strategy/strategyMemory'

export function createMemoryBridge() {
    return {
        executeMemorySearch: async ({ conversationId, ...req }: MemoryChunkSearchRequest & { conversationId: string }) => {
            const db = getDB()
            return strategyMemorySearch(db, {
                conversationId,
                query: req.query,
                options: {
                    topK: req.topK,
                    tags: req.tags,
                    threshold: req.threshold,
                },
            })
        },
        executeMemoryListAssets: async ({ conversationId }: { conversationId: string }) => {
            const db = getDB()
            return listAssets(db, { conversationId })
        },
        executeMemoryReadAsset: async ({ conversationId, assetId, maxChars }: { conversationId: string; assetId: string; maxChars?: number }) => {
            const db = getDB()
            return strategyMemoryReadAsset(db, { conversationId, assetId, maxChars })
        },
        executeMemoryDeleteAsset: async ({ conversationId, assetId }: { conversationId: string; assetId: string }) => {
            const db = getDB()
            deleteAsset(db, { conversationId, assetId })
            return { ok: true as const }
        },
        ingestDocument: async (req: MemoryIngestRequest) => {
            const db = getDB()
            return strategyMemoryIngest(db, req)
        },
        memoryQuery: async ({ conversationId, options }: { conversationId: string; options?: MemoryQueryOptions }) => {
            const db = getDB()
            return queryMemoryRecords(db, {
                conversationId,
                tags: options?.tags,
                orderBy: options?.orderBy,
                order: options?.order,
                limit: options?.limit,
                offset: options?.offset,
            })
        },
        memoryRemoveMemory: async ({ conversationId, memoryId }: { conversationId: string; memoryId: string }) => {
            const db = getDB()
            const deleted = deleteMemoryItem(db, { conversationId, memoryId })
            return { deleted }
        },
    }
}
