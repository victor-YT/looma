import fs from 'node:fs'
import { getDB } from '../../db'
import { ingestDocument } from '../../core/memory/ingest'
import {
    AttachmentCapabilityError,
    guardAttachmentsUploadReady,
} from '../../core/attachments/validateAttachmentsBeforeSend'
import {
    readAttachmentStaging,
    resolveAttachmentStagingStorageKey,
    writeAttachmentStaging,
} from '../../core/attachments/attachmentStaging'
import { resolveAttachmentReference } from '../../core/attachments/attachmentReferenceResolver'
import { resolveReadableAttachment } from '../../core/attachments/readableAttachment'
import { normalizeAttachmentExt } from '../../core/attachments/attachmentPolicy'
import { log } from '../../core/logging/runtimeLogger'

import type {
    AttachmentSourceKind,
    PrepareAttachmentPayload,
    PrepareAttachmentResult,
    TurnAttachment,
} from './types'
import type { MessageContentPart } from '../chat/types'

function toAttachmentPart(args: {
    attachment: TurnAttachment
    assetId: string
    storageKey?: string
}): MessageContentPart {
    const mimeType = args.attachment.mimeType || 'application/octet-stream'
    return {
        type: mimeType.toLowerCase().startsWith('image/') ? 'image' : 'file',
        assetId: args.assetId,
        storageKey: args.storageKey ?? args.attachment.storageKey,
        name: args.attachment.name || args.assetId,
        mimeType,
        size: args.attachment.size ?? 0,
        status: args.attachment.status,
    }
}

function findStorageKeyByAssetId(args: {
    db: ReturnType<typeof getDB>
    conversationId: string
    assetId: string
}): string | null {
    const assetId = args.assetId.trim()
    if (!assetId) return null
    const rowScoped = args.db.prepare(`
        SELECT uri
        FROM memory_assets
        WHERE id = ? AND conversation_id = ? AND storage_backend = 'file'
        LIMIT 1
    `).get(assetId, args.conversationId) as { uri?: string | null } | undefined
    if (typeof rowScoped?.uri === 'string' && rowScoped.uri.trim()) return rowScoped.uri.trim()

    return null
}

function normalizeSourceKind(value?: string): AttachmentSourceKind {
    if (value === 'electronPath' || value === 'browserFile' || value === 'memoryAsset') return value
    return 'unknown'
}

function toUint8Array(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
        return Uint8Array.from(value as number[])
    }
    return null
}

function buildAttachmentReadError(args: {
    attachment: TurnAttachment
    codeMessage: string
    reason: string
    branchName?: string
    modelId: string
    provider: string
    selectedModelId?: string
    selectedProviderId?: string
}): AttachmentCapabilityError {
    const readDiag = args.attachment.readDiagnostics
    const sourceKind = args.attachment.sourceKind ?? readDiag?.sourceKind ?? 'unknown'
    const hasPath = args.attachment.hasPath ?? readDiag?.hasPath ?? Boolean(args.attachment.filePath)
    return new AttachmentCapabilityError(
        'AttachmentReadFailed',
        args.codeMessage,
        {
            modelId: args.modelId,
            provider: args.provider,
            selectedModelId: args.selectedModelId ?? 'not resolved',
            selectedProviderId: args.selectedProviderId ?? 'not resolved',
            attachmentCount: 1,
            supportedMimeTypes: [],
            violations: [{
                code: 'AttachmentReadFailed',
                attachmentId: args.attachment.id,
                fileName: args.attachment.name,
                mimeType: args.attachment.mimeType,
                size: args.attachment.size,
                reason: args.reason,
                branchName: readDiag?.branchName ?? args.branchName ?? 'missing_bytes_and_paths',
                sourceKind,
                hasPath,
                filePath: args.attachment.filePath ?? readDiag?.filePath,
                storageKey: args.attachment.storageKey ?? readDiag?.storageKey,
                assetId: args.attachment.assetId ?? readDiag?.assetId,
                bytesLength: args.attachment.data?.byteLength ?? readDiag?.bytesLength,
                exists: readDiag?.exists,
                fsErrorCode: readDiag?.fsErrorCode,
                stagingResolved: readDiag?.stagingResolved,
                message: readDiag?.message ?? args.codeMessage,
                stack: readDiag?.stack,
            }],
        },
    )
}

export function ensureAttachmentBytes(args: {
    db: ReturnType<typeof getDB>
    conversationId: string
    messageId?: string
    attachment: TurnAttachment
    modelId: string
    provider: string
    selectedModelId?: string
    selectedProviderId?: string
    deps?: {
        resolveAttachmentStagingStorageKey?: (assetId: string) => string | null
        readAttachmentStaging?: (storageKey: string) => Uint8Array
        writeAttachmentStaging?: typeof writeAttachmentStaging
        existsSync?: (target: string) => boolean
        readFileSync?: (target: string) => Buffer
    }
}): TurnAttachment {
    const { attachment } = args
    const existsSyncFn = args.deps?.existsSync ?? fs.existsSync
    if (process.env.DEBUG_ATTACHMENTS === '1') {
        const storageKey = typeof attachment.storageKey === 'string' ? attachment.storageKey.trim() : ''
        const filePath = typeof attachment.filePath === 'string' ? attachment.filePath.trim() : ''
        const storageKeyExists = storageKey ? existsSyncFn(storageKey) : false
        const filePathExists = filePath ? existsSyncFn(filePath) : false
        log('debug', '[ATTACH][ensure_before]', {
            conversationId: args.conversationId,
            traceId: (attachment as { traceId?: string }).traceId ?? null,
            messageId: args.messageId ?? null,
            assetId: attachment.assetId ?? null,
            storageKey: storageKey || null,
            filePath: filePath || null,
            bytesLength: attachment.data?.byteLength ?? null,
            status: attachment.status ?? null,
            ingestionState: attachment.ingestionState ?? null,
            storageKeyExists,
            filePathExists,
        }, { debugFlag: 'DEBUG_ATTACHMENTS' })
    }
    const resolvedRef = resolveAttachmentReference({
        conversationId: args.conversationId,
        attachment,
        findStorageKeyByAssetId: ({ conversationId, assetId }) => findStorageKeyByAssetId({
            db: args.db,
            conversationId,
            assetId,
        }),
        resolveAttachmentStagingStorageKey: args.deps?.resolveAttachmentStagingStorageKey ?? resolveAttachmentStagingStorageKey,
    })
    const canonicalAssetId = resolvedRef.canonicalId || attachment.assetId || attachment.id
    const resolvedStorageKey = resolvedRef.storageKey ?? undefined
    const resolvedReadable = resolveReadableAttachment({
        attachment,
        canonicalAssetId,
        resolvedStorageKey,
        stagingResolved: resolvedRef.stagingResolved,
        normalizeAttachmentExt,
        readAttachmentStaging: args.deps?.readAttachmentStaging ?? readAttachmentStaging,
        writeAttachmentStaging: args.deps?.writeAttachmentStaging ?? writeAttachmentStaging,
        existsSync: args.deps?.existsSync,
        readFileSync: args.deps?.readFileSync,
    })
    if (resolvedReadable.ok) return resolvedReadable.attachment
    throw buildAttachmentReadError({
        attachment: resolvedReadable.attachment,
        codeMessage: resolvedReadable.codeMessage,
        reason: resolvedReadable.reason,
        branchName: resolvedReadable.branchName,
        modelId: args.modelId,
        provider: args.provider,
        selectedModelId: args.selectedModelId,
        selectedProviderId: args.selectedProviderId,
    })
}

export function prepareAttachmentsForSend(args: {
    db: ReturnType<typeof getDB>
    conversationId: string
    messageId?: string
    attachments: TurnAttachment[]
    modelId: string
    provider: string
    selectedModelId?: string
    selectedProviderId?: string
    ensureBytes?: (attachment: TurnAttachment) => TurnAttachment
}): TurnAttachment[] {
    return guardAttachmentsUploadReady({
        modelId: args.modelId,
        provider: args.provider,
        attachments: args.attachments,
        selectedModelId: args.selectedModelId,
        selectedProviderId: args.selectedProviderId,
        run: () => {
            const ensure = args.ensureBytes ?? ((attachment: TurnAttachment) => ensureAttachmentBytes({
                db: args.db,
                conversationId: args.conversationId,
                messageId: args.messageId,
                attachment,
                modelId: args.modelId,
                provider: args.provider,
                selectedModelId: args.selectedModelId,
                selectedProviderId: args.selectedProviderId,
            }))
            return args.attachments.map((attachment) => ensure(attachment))
        },
    })
}

export function prepareAttachmentInMain(input: PrepareAttachmentPayload): PrepareAttachmentResult {
    const sourceKind = normalizeSourceKind(input.sourceKind)
    const hasPath = typeof input.filePath === 'string' && input.filePath.trim().length > 0
    const filePath = hasPath ? input.filePath!.trim() : undefined
    const ext = normalizeAttachmentExt(input.ext, input.name)

    let bytes: Uint8Array | null = null
    let readPathError: NodeJS.ErrnoException | null = null

    if (sourceKind === 'electronPath' && filePath) {
        try {
            bytes = new Uint8Array(fs.readFileSync(filePath))
        } catch (error) {
            readPathError = error as NodeJS.ErrnoException
        }
    }
    if (!bytes) {
        bytes = toUint8Array(input.bytes)
    }
    if (!bytes || bytes.byteLength === 0) {
        const exists = filePath ? fs.existsSync(filePath) : undefined
        const err = new Error('Attachment staging failed: no readable bytes')
        const detail = {
            code: 'AttachmentReadFailed',
            branchName: 'missing_bytes_and_paths',
            sourceKind,
            hasPath,
            path: filePath ?? null,
            storageKey: null,
            assetId: null,
            bytesLength: bytes?.byteLength ?? 0,
            exists: typeof exists === 'boolean' ? exists : null,
            fsErrorCode: readPathError?.code ?? null,
            message: readPathError?.message ?? err.message,
            stack: readPathError?.stack ?? err.stack ?? null,
        }
        log('error', '[ATTACH][prepare_failed]', detail)
        throw Object.assign(err, { detail })
    }

    const staged = writeAttachmentStaging({
        filename: input.name,
        ext,
        bytes,
    })
    return {
        assetId: staged.assetId,
        storageKey: staged.storageKey,
        bytesLength: staged.bytesLength,
        sourceKind,
        hasPath,
        filePath,
    }
}

export async function materializeAttachmentParts(args: {
    db: ReturnType<typeof getDB>
    conversationId: string
    userMessageId: string
    attachments: TurnAttachment[]
    modelId: string
    provider: string
    selectedModelId?: string
    selectedProviderId?: string
}): Promise<MessageContentPart[]> {
    const out: MessageContentPart[] = []
    for (const attachment of args.attachments) {
        if (attachment.status === 'uploading') {
            throw new AttachmentCapabilityError(
                'UploadingInProgress',
                'Wait for uploads to finish.',
                {
                    modelId: args.modelId,
                    provider: args.provider,
                    selectedModelId: args.selectedModelId ?? 'not resolved',
                    selectedProviderId: args.selectedProviderId ?? 'not resolved',
                    attachmentCount: args.attachments.length,
                    supportedMimeTypes: [],
                    violations: [{
                        code: 'UploadingInProgress',
                        attachmentId: attachment.id,
                        fileName: attachment.name,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        message: 'Wait for uploads to finish.',
                    }],
                },
            )
        }
        if (!attachment.data || attachment.data.length === 0) {
            const readDiag = attachment.readDiagnostics
            throw new AttachmentCapabilityError(
                'AttachmentReadFailed',
                `Failed to read attachment: ${attachment.name}`,
                {
                    modelId: args.modelId,
                    provider: args.provider,
                    selectedModelId: args.selectedModelId ?? 'not resolved',
                    selectedProviderId: args.selectedProviderId ?? 'not resolved',
                    attachmentCount: args.attachments.length,
                    supportedMimeTypes: [],
                    violations: [{
                        code: 'AttachmentReadFailed',
                        attachmentId: attachment.id,
                        fileName: attachment.name,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        reason: readDiag?.reason ?? 'attachment_not_ready',
                        branchName: readDiag?.branchName ?? 'missing_bytes_and_paths',
                        sourceKind: attachment.sourceKind ?? readDiag?.sourceKind ?? 'unknown',
                        hasPath: attachment.hasPath ?? readDiag?.hasPath ?? Boolean(attachment.filePath),
                        filePath: readDiag?.filePath,
                        storageKey: attachment.storageKey ?? readDiag?.storageKey,
                        assetId: attachment.assetId ?? attachment.id ?? readDiag?.assetId,
                        bytesLength: attachment.data?.byteLength ?? readDiag?.bytesLength,
                        exists: readDiag?.exists,
                        fsErrorCode: readDiag?.fsErrorCode,
                        stack: readDiag?.stack,
                        message: `Failed to read attachment: ${attachment.name}`,
                    }],
                },
            )
        }
        const result = await ingestDocument(args.db, {
            conversationId: args.conversationId,
            filename: attachment.name,
            mime: attachment.mimeType,
            data: attachment.data,
            source: {
                conversationId: args.conversationId,
                messageId: args.userMessageId,
            },
            options: {
                wait: 'load',
                mode: 'raw',
                type: 'attachment.message',
            },
        })
        if (result.status === 'failed' || !result.assetId) {
            const readDiag = attachment.readDiagnostics
            throw new AttachmentCapabilityError(
                'AttachmentReadFailed',
                result.error || `Failed to store attachment: ${attachment.name}`,
                {
                    modelId: args.modelId,
                    provider: args.provider,
                    selectedModelId: args.selectedModelId ?? 'not resolved',
                    selectedProviderId: args.selectedProviderId ?? 'not resolved',
                    attachmentCount: args.attachments.length,
                    supportedMimeTypes: [],
                    violations: [{
                        code: 'AttachmentReadFailed',
                        attachmentId: attachment.id,
                        fileName: attachment.name,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        reason: readDiag?.reason ?? 'ingest_store_failed',
                        branchName: readDiag?.branchName ?? 'missing_bytes_and_paths',
                        sourceKind: attachment.sourceKind ?? readDiag?.sourceKind ?? 'unknown',
                        hasPath: attachment.hasPath ?? readDiag?.hasPath ?? Boolean(attachment.filePath),
                        filePath: readDiag?.filePath,
                        storageKey: attachment.storageKey ?? readDiag?.storageKey,
                        assetId: attachment.assetId ?? attachment.id ?? readDiag?.assetId,
                        bytesLength: attachment.data?.byteLength ?? readDiag?.bytesLength,
                        exists: readDiag?.exists,
                        fsErrorCode: readDiag?.fsErrorCode,
                        stack: readDiag?.stack,
                        message: result.error || `Failed to store attachment: ${attachment.name}`,
                    }],
                },
            )
        }
        const finalAssetId = result.assetId
        const finalStorageKey = result.storageKey
            ?? attachment.storageKey
            ?? attachment.readDiagnostics?.storageKey
        if (!finalStorageKey) {
            const readDiag = attachment.readDiagnostics
            throw new AttachmentCapabilityError(
                'AttachmentReadFailed',
                `Missing canonical storage key: ${attachment.name}`,
                {
                    modelId: args.modelId,
                    provider: args.provider,
                    selectedModelId: args.selectedModelId ?? 'not resolved',
                    selectedProviderId: args.selectedProviderId ?? 'not resolved',
                    attachmentCount: args.attachments.length,
                    supportedMimeTypes: [],
                    violations: [{
                        code: 'AttachmentReadFailed',
                        attachmentId: attachment.id,
                        fileName: attachment.name,
                        mimeType: attachment.mimeType,
                        size: attachment.size,
                        reason: readDiag?.reason ?? 'storage_key_missing',
                        branchName: readDiag?.branchName ?? 'missing_bytes_and_paths',
                        sourceKind: attachment.sourceKind ?? readDiag?.sourceKind ?? 'unknown',
                        hasPath: attachment.hasPath ?? readDiag?.hasPath ?? Boolean(attachment.filePath),
                        filePath: readDiag?.filePath,
                        storageKey: undefined,
                        assetId: finalAssetId,
                        bytesLength: attachment.data?.byteLength ?? readDiag?.bytesLength,
                        exists: readDiag?.exists,
                        fsErrorCode: readDiag?.fsErrorCode,
                        stack: readDiag?.stack,
                        message: `Missing canonical storage key: ${attachment.name}`,
                    }],
                },
            )
        }
        attachment.id = finalAssetId
        attachment.assetId = finalAssetId
        attachment.storageKey = finalStorageKey
        attachment.readDiagnostics = {
            ...attachment.readDiagnostics,
            assetId: finalAssetId,
            storageKey: finalStorageKey,
        }
        out.push(toAttachmentPart({
            attachment,
            assetId: finalAssetId,
            storageKey: finalStorageKey,
        }))
    }
    return out
}
