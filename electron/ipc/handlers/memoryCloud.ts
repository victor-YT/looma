import { ipcMain, shell } from 'electron'
import { getDB } from '../../db'
import { IPC } from '../channels'

import {
    ingestDocument,
    listAssets,
    readAsset,
    deleteAsset,
} from '../../core/memory/memoryStore'
import { getStrategyOrFallback } from '../../core/strategy/strategyRegistry'
import { resolveStrategyMemoryCloudFeature } from '../../core/strategy/strategyFeatures'
import { log } from '../../core/logging/runtimeLogger'
import { touchConversation } from '../../core/conversation/touchConversation'

import type {
    MemoryIngestRequest,
    MemoryIngestResult,
    StrategyRecord,
} from '../../../contracts/index'

function errorToLog(err: unknown): string {
    if (err instanceof Error) return err.stack ?? err.message
    return String(err)
}

export function registerMemoryCloudIPC() {
    const assertMemoryCloudEnabled = async (conversationId: string): Promise<StrategyRecord> => {
        if (!conversationId) throw new Error('conversationId required')
        const db = getDB()
        const conversation = db.prepare(`SELECT id, strategy_id FROM conversations WHERE id = ?`)
            .get(conversationId) as { id?: string; strategy_id?: string | null } | undefined
        if (!conversation?.id) throw new Error('conversation not found')

        const resolved = getStrategyOrFallback(db, {
            requestedStrategyId: conversation.strategy_id ?? null,
            conversationId,
        })
        const enabled = await resolveStrategyMemoryCloudFeature(resolved.strategy)
        log('info', '[MEMORY_CLOUD][strategy_check]', {
            conversationId,
            strategyId: resolved.strategy.id,
            enabled,
        })
        if (!enabled) throw new Error('MEMORY_CLOUD_DISABLED')
        return resolved.strategy
    }

    const resolveAssetPath = (conversationId: string, assetId: string): string => {
        const db = getDB()
        const row = db.prepare(`
            SELECT uri, storage_backend
            FROM memory_assets
            WHERE id = ? AND conversation_id = ?
        `).get(assetId, conversationId) as { uri?: string | null; storage_backend?: string | null } | undefined
        if (!row) throw new Error('asset not found')
        if (row.storage_backend !== 'file') throw new Error('asset is not a file-backed resource')
        const uri = typeof row.uri === 'string' ? row.uri.trim() : ''
        if (!uri) throw new Error('asset file path missing')
        return uri
    }

    ipcMain.handle(IPC.MEMORY_CLOUD_IS_ENABLED, async (_e, conversationId: string) => {
        log('info', '[MEMORY_CLOUD][ipc_is_enabled]', { conversationId })
        try {
            await assertMemoryCloudEnabled(conversationId)
            return { enabled: true }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (message !== 'MEMORY_CLOUD_DISABLED') {
                log('error', '[MEMORY_CLOUD][ipc_is_enabled_error]', {
                    conversationId,
                    error: errorToLog(err),
                })
            }
            if (message === 'MEMORY_CLOUD_DISABLED') return { enabled: false }
            throw err
        }
    })

    ipcMain.handle(IPC.MEMORY_INGEST_DOCUMENT, async (event, payload: MemoryIngestRequest) => {
        log('info', '[MEMORY_CLOUD][ipc_ingest_document]', {
            conversationId: payload.conversationId,
            filename: payload.filename,
            mime: payload.mime,
            wait: payload.options?.wait,
            sizeBytes: payload.data?.byteLength ?? null,
        })
        try {
            const strategy = await assertMemoryCloudEnabled(payload.conversationId)
            const db = getDB()
            const result = await ingestDocument(db, {
                ...payload,
                options: {
                    ...(payload.options ?? {}),
                    type: payload.options?.type ?? 'memory_cloud.document',
                },
                onProgress: (p) => {
                    event.sender.send(IPC.MEMORY_INGEST_PROGRESS, p)
                },
            })
            log('info', '[MEMORY_CLOUD][ipc_ingest_document_done]', {
                conversationId: payload.conversationId,
                assetId: result.assetId,
                strategyId: strategy.id,
                status: result.status,
            })
            if (result.status !== 'failed') {
                touchConversation(db, payload.conversationId)
            }
            return result as MemoryIngestResult
        } catch (err) {
            log('error', '[MEMORY_CLOUD][ipc_ingest_document_error]', {
                conversationId: payload.conversationId,
                filename: payload.filename,
                error: errorToLog(err),
            })
            throw err
        }
    })

    // Asset list
    ipcMain.handle(IPC.MEMORY_ASSET_LIST, async (_e, args: { conversationId: string }) => {
        log('info', '[MEMORY_CLOUD][ipc_list_assets]', { conversationId: args.conversationId })
        try {
            const strategy = await assertMemoryCloudEnabled(args.conversationId)
            const db = getDB()
            const result = listAssets(db, { conversationId: args.conversationId })
            log('info', '[MEMORY_CLOUD][ipc_list_assets_done]', {
                conversationId: args.conversationId,
                strategyId: strategy.id,
                count: result.length,
            })
            return result
        } catch (err) {
            log('error', '[MEMORY_CLOUD][ipc_list_assets_error]', {
                conversationId: args.conversationId,
                error: errorToLog(err),
            })
            throw err
        }
    })

    // Asset details / preview
    ipcMain.handle(IPC.MEMORY_ASSET_READ, async (_e, args: { conversationId: string; assetId: string; maxChars?: number }) => {
        log('info', '[MEMORY_CLOUD][ipc_read_asset]', {
            conversationId: args.conversationId,
            assetId: args.assetId,
            maxChars: args.maxChars,
        })
        try {
            const strategy = await assertMemoryCloudEnabled(args.conversationId)
            const db = getDB()
            const result = readAsset(db, {
                conversationId: args.conversationId,
                assetId: args.assetId,
                maxChars: args.maxChars,
            })
            log('info', '[MEMORY_CLOUD][ipc_read_asset_done]', {
                conversationId: args.conversationId,
                assetId: args.assetId,
                strategyId: strategy.id,
                found: Boolean(result),
            })
            return result
        } catch (err) {
            log('error', '[MEMORY_CLOUD][ipc_read_asset_error]', {
                conversationId: args.conversationId,
                assetId: args.assetId,
                error: errorToLog(err),
            })
            throw err
        }
    })

    // Delete asset
    ipcMain.handle(IPC.MEMORY_ASSET_DELETE, async (_e, args: { conversationId: string; assetId: string }) => {
        log('info', '[MEMORY_CLOUD][ipc_delete_asset]', {
            conversationId: args.conversationId,
            assetId: args.assetId,
        })
        try {
            const strategy = await assertMemoryCloudEnabled(args.conversationId)
            const db = getDB()
            deleteAsset(db, { conversationId: args.conversationId, assetId: args.assetId })
            touchConversation(db, args.conversationId)
            log('info', '[MEMORY_CLOUD][ipc_delete_asset_done]', {
                conversationId: args.conversationId,
                assetId: args.assetId,
                strategyId: strategy.id,
            })
            return { ok: true }
        } catch (err) {
            log('error', '[MEMORY_CLOUD][ipc_delete_asset_error]', {
                conversationId: args.conversationId,
                assetId: args.assetId,
                error: errorToLog(err),
            })
            throw err
        }
    })

    ipcMain.handle(IPC.MEMORY_ASSET_OPEN, async (_e, args: { conversationId: string; assetId: string }) => {
        log('info', '[MEMORY_CLOUD][ipc_open_asset]', {
            conversationId: args.conversationId,
            assetId: args.assetId,
        })
        await assertMemoryCloudEnabled(args.conversationId)
        const filePath = resolveAssetPath(args.conversationId, args.assetId)
        const error = await shell.openPath(filePath)
        if (error) {
            throw new Error(error)
        }
        return { ok: true as const }
    })

    ipcMain.handle(IPC.MEMORY_ASSET_REVEAL, async (_e, args: { conversationId: string; assetId: string }) => {
        log('info', '[MEMORY_CLOUD][ipc_reveal_asset]', {
            conversationId: args.conversationId,
            assetId: args.assetId,
        })
        await assertMemoryCloudEnabled(args.conversationId)
        const filePath = resolveAssetPath(args.conversationId, args.assetId)
        shell.showItemInFolder(filePath)
        return { ok: true as const }
    })

}
