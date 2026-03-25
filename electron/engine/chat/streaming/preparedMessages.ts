import type { TurnAttachment, UIMessage } from '../../../../contracts/index'
import { toLegacyAttachmentPart } from '../../../llm/adapters/messageParts'
import { parseMessageContentParts } from '../../../../shared/chat/contentParts'

type FileLikePart = Extract<ReturnType<typeof parseMessageContentParts>[number], { type: 'file' | 'image' }>

function toComparableText(message: UIMessage): string {
    return typeof message.content === 'string' ? message.content : ''
}

function getFileLikeParts(message: UIMessage): FileLikePart[] {
    return parseMessageContentParts(message.contentParts, message.content)
        .filter((part): part is FileLikePart => part.type === 'file' || part.type === 'image')
}

function sameAttachmentParts(a: FileLikePart[], b: FileLikePart[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        const left = a[i]
        const right = b[i]
        if (
            left.type !== right.type
            || left.assetId !== right.assetId
            || left.name !== right.name
            || left.mimeType !== right.mimeType
            || left.size !== right.size
        ) {
            return false
        }
    }
    return true
}

export function buildPreparedMessagesForStream(args: {
    strategyMessages: UIMessage[]
    parentUserId: string
    conversationId: string
    inputText?: string
    attachments?: TurnAttachment[]
}): UIMessage[] {
    const currentParts = [
        ...(typeof args.inputText === 'string' && args.inputText.trim().length > 0
            ? [{ type: 'text' as const, text: args.inputText }]
            : []),
        ...((args.attachments ?? []).map(toLegacyAttachmentPart)),
    ]
    if (currentParts.length === 0) return args.strategyMessages
    const existingIdx = args.strategyMessages.findIndex((message) => message.id === args.parentUserId)
    if (existingIdx >= 0) {
        const existing = args.strategyMessages[existingIdx]
        const existingParts = parseMessageContentParts(existing.contentParts, existing.content)
        const existingFilePartCount = existingParts.filter((part) => part.type === 'file' || part.type === 'image').length
        const incomingFilePartCount = currentParts.filter((part) => part.type === 'file' || part.type === 'image').length
        if (incomingFilePartCount <= 0 || existingFilePartCount > 0) {
            return args.strategyMessages
        }
        const next = [...args.strategyMessages]
        next[existingIdx] = {
            ...existing,
            content: typeof args.inputText === 'string' ? args.inputText : existing.content,
            contentParts: currentParts,
        }
        return next
    }
    const currentText = typeof args.inputText === 'string' ? args.inputText : ''
    const currentFileParts = currentParts.filter((part): part is FileLikePart => part.type === 'file' || part.type === 'image')
    const hasMatchingUserMessage = args.strategyMessages.some((message) => {
        if (message.role !== 'user') return false
        if (toComparableText(message) !== currentText) return false
        if (currentFileParts.length === 0) return true
        return sameAttachmentParts(getFileLikeParts(message), currentFileParts)
    })
    if (hasMatchingUserMessage) {
        return args.strategyMessages
    }

    return [
        ...args.strategyMessages,
        {
            id: args.parentUserId,
            conversation_id: args.conversationId,
            role: 'user',
            type: 'text',
            content: typeof args.inputText === 'string' ? args.inputText : '',
            contentParts: currentParts,
            timestamp: Date.now(),
        } as UIMessage,
    ]
}
