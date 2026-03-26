import type { TurnStatus, UIMessage } from "@contracts"

export interface ErrorMessageContext {
    message: UIMessage
    turnStatus?: TurnStatus
    turnStopReason?: string | null
}

function asText(value: unknown): string | null {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
}

function firstMatch(lower: string, needles: string[]): string | null {
    for (const needle of needles) {
        if (lower.includes(needle)) return needle
    }
    return null
}

function stringifyRaw(raw: unknown): string | null {
    if (raw == null) return null
    if (typeof raw === "string") return raw.trim() ? raw : null
    try {
        const json = JSON.stringify(raw, null, 2)
        return json.trim() ? json : null
    } catch {
        return String(raw)
    }
}

function extractErrorText(value: string | null): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const match = trimmed.match(/^\[error\]\s*(.+)$/i)
    return match?.[1]?.trim() || trimmed
}

function collectSignals(input: ErrorMessageContext): string {
    const parts = [
        asText(input.message.errorMessage),
        asText(input.message.errorCode),
        asText(input.message.content),
        asText(input.message.finishReason),
        asText(input.turnStopReason),
        stringifyRaw(input.message.rawError),
    ]
    return parts.filter(Boolean).join("\n").toLowerCase()
}

type AttachmentViolation = {
    code?: string
    branchName?: string
    sourceKind?: string
    hasPath?: boolean
    filePath?: string
    storageKey?: string
    assetId?: string
    bytesLength?: number
    exists?: boolean
    fsErrorCode?: string
    mimeType?: string
    size?: number
    message?: string
    stack?: string
}

type AttachmentErrorDetails = {
    modelId?: string
    provider?: string
    selectedModelId?: string
    selectedProviderId?: string
    attachmentTransport?: string
    violations?: AttachmentViolation[]
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function readAttachmentErrorDetails(raw: unknown): AttachmentErrorDetails | null {
    if (!raw || typeof raw !== "object") return null
    const obj = raw as Record<string, unknown>
    const maybeAttachment = (obj.attachmentError && typeof obj.attachmentError === "object")
        ? (obj.attachmentError as Record<string, unknown>)
        : obj
    const modelId = typeof maybeAttachment.modelId === "string" ? maybeAttachment.modelId : undefined
    const provider = typeof maybeAttachment.provider === "string" ? maybeAttachment.provider : undefined
    const selectedModelId = typeof maybeAttachment.selectedModelId === "string" ? maybeAttachment.selectedModelId : undefined
    const selectedProviderId = typeof maybeAttachment.selectedProviderId === "string" ? maybeAttachment.selectedProviderId : undefined
    const attachmentTransport = typeof maybeAttachment.attachmentTransport === "string"
        ? maybeAttachment.attachmentTransport
        : undefined
    const violationsRaw = Array.isArray(maybeAttachment.violations) ? maybeAttachment.violations : []
    const violations: AttachmentViolation[] = violationsRaw
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
            code: typeof item.code === "string" ? item.code : undefined,
            branchName: typeof item.branchName === "string" ? item.branchName : undefined,
            sourceKind: typeof item.sourceKind === "string" ? item.sourceKind : undefined,
            hasPath: typeof item.hasPath === "boolean" ? item.hasPath : undefined,
            filePath: typeof item.filePath === "string" ? item.filePath : undefined,
            storageKey: typeof item.storageKey === "string" ? item.storageKey : undefined,
            assetId: typeof item.assetId === "string" ? item.assetId : undefined,
            bytesLength: typeof item.bytesLength === "number" ? item.bytesLength : undefined,
            exists: typeof item.exists === "boolean" ? item.exists : undefined,
            fsErrorCode: typeof item.fsErrorCode === "string" ? item.fsErrorCode : undefined,
            mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
            size: typeof item.size === "number" ? item.size : undefined,
            message: typeof item.message === "string" ? item.message : undefined,
            stack: typeof item.stack === "string" ? item.stack : undefined,
        }))
    if (!modelId && !provider && !selectedModelId && !selectedProviderId && !attachmentTransport && violations.length === 0) return null
    return { modelId, provider, selectedModelId, selectedProviderId, attachmentTransport, violations }
}

export function normalizeErrorSummary(input: ErrorMessageContext): string {
    const code = asText(input.message.errorCode)
    const errorMessage = extractErrorText(asText(input.message.errorMessage))
    if (code === "UploadingInProgress") return "Wait for uploads to finish."
    if (code === "ModelDoesNotSupportFiles") return "The selected model does not support file attachments."
    if (code === "UnsupportedAttachmentType") return "This file type is not supported by the selected model."
    if (code === "AttachmentTooLarge") return "Attachment exceeds model file size limit."
    if (code === "TooManyAttachments") return "Too many attachments for this turn."
    if (code === "AttachmentUploading") return "Attachment is still uploading."
    if (code === "AttachmentUploadFailed") return "Failed to upload attachment."
    if (code === "AttachmentReadFailed") return "Failed to prepare attachment."
    if (errorMessage && !/^EMPTY_OUTPUT$/i.test(errorMessage)) return errorMessage

    const signals = collectSignals(input)
    const timeoutHit = firstMatch(signals, [
        "timed out",
        "timeout",
        "deadline exceeded",
        "etimedout",
    ])
    if (timeoutHit) {
        return "Request timed out"
    }

    const networkHit = firstMatch(signals, [
        "fetch failed",
        "failed to fetch",
        "econnreset",
        "econnrefused",
        "enotfound",
        "eai_again",
        "network",
        "connection",
        "socket",
        "offline",
    ])
    if (networkHit) {
        const cause = networkHit === "fetch failed"
            ? "fetch failed"
            : networkHit === "failed to fetch"
                ? "failed to fetch"
                : null
        return cause ? `Network error (${cause})` : "Network error"
    }

    const missingModelHit = firstMatch(signals, [
        "model not found",
        "unknown model",
        "invalid model",
        "unknown model id",
        "does not exist",
        "unsupported model",
        "no such model",
    ])
    if (missingModelHit) {
        return "Selected model ID is invalid or unavailable for this provider."
    }

    const attachmentCapabilityHit = firstMatch(signals, [
        "unsupported mime type",
        "provider has no native file/media transport",
        "does not support file attachments",
        "does not support one or more attachment mime types",
        "does not support one or more attached file types",
        "modeldoesnotsupportfiles",
        "unsupportedattachmenttype",
    ])
    if (attachmentCapabilityHit) {
        if (attachmentCapabilityHit === "provider has no native file/media transport"
            || attachmentCapabilityHit === "does not support file attachments"
            || attachmentCapabilityHit === "modeldoesnotsupportfiles") {
            return "The selected model does not support file attachments."
        }
        return "This file type is not supported by the selected model."
    }

    const looksLikeModelError = input.turnStatus === "error"
        || input.message.type === "error"
        || input.message.messageStatus === "error"
        || input.message.finishReason === "error"
        || Boolean(asText(input.message.errorCode))
        || Boolean(asText(input.message.errorMessage))

    if (looksLikeModelError) {
        return "Model error"
    }

    return "Request failed"
}

export function normalizeErrorDetails(input: ErrorMessageContext): string | null {
    const attachment = readAttachmentErrorDetails(input.message.rawError)
    if (attachment) {
        const first = attachment.violations?.[0]
        const lines: string[] = []
        if (attachment.modelId) lines.push(`model: ${attachment.modelId}`)
        if (attachment.provider) lines.push(`provider: ${attachment.provider}`)
        lines.push(`selectedModelId: ${attachment.selectedModelId ?? "not resolved"}`)
        lines.push(`selectedProviderId: ${attachment.selectedProviderId ?? "not resolved"}`)
        if (attachment.attachmentTransport) lines.push(`transport: ${attachment.attachmentTransport}`)
        if (first?.sourceKind) lines.push(`sourceKind: ${first.sourceKind}`)
        if (typeof first?.hasPath === "boolean") lines.push(`hasPath: ${first.hasPath ? "true" : "false"}`)
        if (first?.filePath) lines.push(`path: ${first.filePath}`)
        if (first?.storageKey) lines.push(`storageKey: ${first.storageKey}`)
        if (first?.assetId) lines.push(`assetId: ${first.assetId}`)
        if (typeof first?.bytesLength === "number") lines.push(`bytesLength: ${first.bytesLength}`)
        if (typeof first?.exists === "boolean") lines.push(`exists: ${first.exists ? "true" : "false"}`)
        if (first?.fsErrorCode) lines.push(`fsErrorCode: ${first.fsErrorCode}`)
        if (first?.mimeType) lines.push(`mimeType: ${first.mimeType}`)
        if (typeof first?.size === "number") lines.push(`file size: ${formatBytes(first.size)}`)
        if (first?.code || input.message.errorCode) lines.push(`error code: ${first?.code ?? input.message.errorCode}`)
        if (import.meta.env.DEV && first?.branchName) lines.push(`branchName: ${first.branchName}`)
        if (first?.message) lines.push(`message: ${first.message}`)
        if (first?.stack) lines.push(`stack:\n${first.stack}`)
        if (lines.length > 0) return lines.join("\n")
    }
    const lines = [
        extractErrorText(asText(input.message.errorMessage)),
        extractErrorText(asText(input.message.content)),
        stringifyRaw(input.message.rawError),
    ].filter((line): line is string => typeof line === 'string' && !/^EMPTY_OUTPUT$/i.test(line.trim()))
    if (lines.length > 0) return lines.join("\n\n")
    return null
}
