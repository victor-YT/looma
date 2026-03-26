import { Buffer } from 'node:buffer'
import type { Provider, StreamGen } from '../../common'
import type { LLMParams, ToolDef, TurnAttachment, UIMessage } from '../../../../contracts/index'
import { appendLegacyAttachmentsToLastUser, getMessageParts, getMessageText } from '../../adapters/messageParts'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'

type OllamaMessage = {
    role: string
    content: string
    images?: string[]
}

function normalizeBaseUrl(baseUrl: string): string {
    return (baseUrl || '').replace(/\/$/, '')
}

function toOllamaMessages(history: UIMessage[]): OllamaMessage[] {
    return history.map((msg) => {
        const parts = getMessageParts(msg)
        const content = getMessageText(msg)
        if (msg.role !== 'user' || parts.length === 0) {
            return {
                role: msg.role,
                content,
            }
        }
        const images: string[] = []
        for (const part of parts) {
            if (part.type === 'text') continue
            const mimeType = (part.mimeType || 'application/octet-stream').trim().toLowerCase()
            if (!mimeType.startsWith('image/')) {
                throw new Error(`UnsupportedAttachmentType: ${mimeType}`)
            }
            if (!part.data || part.data.length === 0) {
                throw new Error(`AttachmentDataMissing: ${part.name}`)
            }
            images.push(Buffer.from(part.data).toString('base64'))
        }
        return images.length > 0
            ? {
                role: msg.role,
                content,
                images,
            }
            : {
                role: msg.role,
                content,
            }
    })
}

async function readError(res: Response): Promise<string> {
    const text = await res.text()
    return text || res.statusText
}

export const OllamaProvider: Provider = {
    id: 'ollama',
    capabilities: {
        nativeFiles: true,
        supportedMimeTypes: ['image/*'],
        attachmentTransport: 'inline_base64',
    },
    supports: () => true,

    async *stream(
        { modelId, history, attachments, inputText }: {
            modelId: string
            history: UIMessage[]
            params?: LLMParams
            tools?: ToolDef[]
            attachments?: TurnAttachment[]
            inputText?: string
        },
        ctx
    ): StreamGen {
        const mergedHistory = appendLegacyAttachmentsToLastUser(history, attachments, inputText)
        const baseUrl = normalizeBaseUrl(ctx.baseUrl || DEFAULT_BASE_URL)
        const payload = {
            model: modelId,
            messages: toOllamaMessages(mergedHistory),
            stream: true,
        }
        const res = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(ctx.headers ?? {}) },
            body: JSON.stringify(payload),
            signal: ctx.abortSignal,
        })
        if (!res.ok) {
            const message = await readError(res)
            throw new Error(message)
        }
        const reader = res.body?.getReader()
        if (!reader) return
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let idx = buffer.indexOf('\n')
            while (idx !== -1) {
                const line = buffer.slice(0, idx).trim()
                buffer = buffer.slice(idx + 1)
                if (line) {
                    try {
                        const data = JSON.parse(line) as {
                            message?: { content?: string }
                            done?: boolean
                        }
                        if (data.message?.content) yield data.message.content
                        if (data.done) return
                    } catch {
                        // ignore invalid lines
                    }
                }
                idx = buffer.indexOf('\n')
            }
        }
        const tail = buffer.trim()
        if (tail) {
            try {
                const data = JSON.parse(tail) as {
                    message?: { content?: string }
                    done?: boolean
                }
                if (data.message?.content) yield data.message.content
            } catch {
                // ignore invalid tail
            }
        }
    },

    async complete(
        { modelId, history, attachments, inputText }: {
            modelId: string
            history: UIMessage[]
            params?: LLMParams
            tools?: ToolDef[]
            attachments?: TurnAttachment[]
            inputText?: string
        },
        ctx
    ): Promise<string> {
        const mergedHistory = appendLegacyAttachmentsToLastUser(history, attachments, inputText)
        const baseUrl = normalizeBaseUrl(ctx.baseUrl || DEFAULT_BASE_URL)
        const payload = {
            model: modelId,
            messages: toOllamaMessages(mergedHistory),
            stream: false,
        }
        const res = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(ctx.headers ?? {}) },
            body: JSON.stringify(payload),
            signal: ctx.abortSignal,
        })
        if (!res.ok) {
            const message = await readError(res)
            throw new Error(message)
        }
        const data = (await res.json()) as { message?: { content?: string } }
        return data.message?.content ?? ''
    },
}
