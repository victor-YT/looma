import { Buffer } from 'node:buffer'
import type { Provider, StreamGen } from '../../common'
import type { UIMessage, LLMParams, TurnAttachment } from '../../../../contracts/index'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { lastUserMessage } from '../../adapters/history'
import { pickBaseParams } from '../../adapters/params'
import { deltaStream } from '../../adapters/stream'
import { normalizeError } from '../../adapters/error'
import { toGeminiHistory } from './history'
import { toGeminiConfig } from './mapParams'
import { extractTextFromChunk, extractFinalText, isSendMessageStreamResult } from './parse'
import { appendLegacyAttachmentsToLastUser, getMessageParts } from '../../adapters/messageParts'

type SendMessageStreamResult = {
    stream: AsyncIterable<unknown>
    response: Promise<unknown>
}

type GeminiInputPart = {
    text?: string
    inlineData?: {
        mimeType: string
        data: string
    }
}

/** Small helper for creating an SDK chat instance and avoiding repetition. */
function startGeminiChat(
    apiKey: string,
    modelId: string,
    history: UIMessage[],
    params?: LLMParams,
    opts?: { nativeSearch?: boolean }
) {
    const genAI = new GoogleGenerativeAI(apiKey)
    const modelParams = {
        model: modelId,
        ...(opts?.nativeSearch
            ? { tools: [{ googleSearch: {} }] }
            : {}),
    } as unknown as Parameters<typeof genAI.getGenerativeModel>[0]
    const model = genAI.getGenerativeModel(modelParams)
    // Key behavior: exclude the last user message and ensure the first message is from the user
    const his = toGeminiHistory(history, { excludeLastUser: true })
    const cfg = toGeminiConfig(
        pickBaseParams(params as unknown as Record<string, unknown> | undefined),
        modelId
    )
    const chat = model.startChat({
        history: his as unknown as never,
        generationConfig: cfg,
    } as Parameters<typeof model.startChat>[0])
    return { chat }
}

function toGeminiInputParts(message: UIMessage): string | GeminiInputPart[] {
    const messageParts = getMessageParts(message)
    if (messageParts.length === 0) {
        return (message.content ?? '').trim()
    }
    const parts: GeminiInputPart[] = []
    for (const part of messageParts) {
        if (part.type === 'text') {
            if (part.text.trim()) {
                parts.push({ text: part.text.trim() })
            }
            continue
        }
        const mimeType = (part.mimeType || 'application/octet-stream').trim()
        if (!part.data || part.data.length === 0) {
            throw new Error(`AttachmentDataMissing: ${part.name}`)
        }
        const data = Buffer.from(part.data).toString('base64')
        parts.push({
            inlineData: {
                mimeType,
                data,
            },
        })
    }
    if (parts.length === 1 && parts[0].text) {
        return parts[0].text
    }
    return parts
}

function findLastUser(history: UIMessage[]): UIMessage | null {
    for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i]?.role === 'user') return history[i]
    }
    return null
}

/** Wrap provider errors in one normalized throw path. */
function rethrow(provider: string, err: unknown): never {
    const ne = normalizeError(err, { provider })
    throw new Error(`${ne.code}: ${ne.message}`)
}

export const GeminiProvider: Provider = {
    id: 'gemini',
    capabilities: { nativeFiles: true, attachmentTransport: 'inline_parts' },
    supports: id => id.toLowerCase().startsWith('gemini'),

    async *stream(
        { modelId, history, params, attachments, inputText }: {
            modelId: string
            history: UIMessage[]
            params?: LLMParams
            attachments?: TurnAttachment[]
            inputText?: string
        },
        ctx
    ): StreamGen {
        try {
            const apiKey = ctx.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
            if (!apiKey) throw new Error('GEMINI_API_KEY missing')

            const mergedHistory = appendLegacyAttachmentsToLastUser(history, attachments, inputText)
            const userMessage = findLastUser(mergedHistory)
            const userText = userMessage ? (lastUserMessage([userMessage]) ?? '').trim() : ''
            const hasAttachments = userMessage ? getMessageParts(userMessage).some((part) => part.type !== 'text') : false
            if (!userMessage && !userText && !hasAttachments) throw new Error('without user input')

            const { chat } = startGeminiChat(apiKey, modelId, mergedHistory, params, {
                nativeSearch: ctx.nativeSearch === true,
            })
            const input = userMessage ? toGeminiInputParts(userMessage) : userText

            const resUnknown: unknown = await chat.sendMessageStream(input as unknown as string)
            if (!isSendMessageStreamResult(resUnknown)) {
                throw new Error('Unexpected SDK response shape from sendMessageStream')
            }
            const res: SendMessageStreamResult = resUnknown

            // Stream delta chunks
            yield* deltaStream(res.stream, extractTextFromChunk, {
                mode: 'full',
                timeoutMs: ctx.timeoutMs,
                abortSignal: ctx.abortSignal,
            })

            // Finalization (reading the final response is enough; if a trailing patch is needed, compare cumulative length at the caller)
            try {
                const final = await res.response
                extractFinalText(final)
            } catch {
                /* ignore */
            }
        } catch (e) {
            rethrow('gemini', e)
        }
    },

    async complete(
        { modelId, history, params, attachments, inputText }: {
            modelId: string
            history: UIMessage[]
            params?: LLMParams
            attachments?: TurnAttachment[]
            inputText?: string
        },
        ctx
    ): Promise<string> {
        try {
            const apiKey = ctx.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
            if (!apiKey) throw new Error('GEMINI_API_KEY missing')

            const mergedHistory = appendLegacyAttachmentsToLastUser(history, attachments, inputText)
            const userMessage = findLastUser(mergedHistory)
            const userText = userMessage ? (lastUserMessage([userMessage]) ?? '').trim() : ''
            const hasAttachments = userMessage ? getMessageParts(userMessage).some((part) => part.type !== 'text') : false
            if (!userMessage && !userText && !hasAttachments) throw new Error('without user input')

            const { chat } = startGeminiChat(apiKey, modelId, mergedHistory, params, {
                nativeSearch: ctx.nativeSearch === true,
            })
            const input = userMessage ? toGeminiInputParts(userMessage) : userText
            const res: unknown = await chat.sendMessage(input as unknown as string)

            if (!res || typeof res !== 'object' || !('response' in res)) return ''
            return extractFinalText((res as { response: unknown }).response)
        } catch (e) {
            rethrow('gemini', e)
        }
    },
}
