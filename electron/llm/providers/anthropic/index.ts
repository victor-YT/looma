import { Buffer } from 'node:buffer'
import type { Provider, StreamGen } from '../../common'
import type { LLMParams, ToolDef, TurnAttachment, UIMessage } from '../../../../contracts/index'
import { appendLegacyAttachmentsToLastUser, getMessageParts, getMessageText } from '../../adapters/messageParts'
import { normalizeError } from '../../adapters/error'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

type AnthropicMessage = {
    role: 'user' | 'assistant'
    content: string | AnthropicContentBlock[]
}

type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | {
        type: 'image'
        source: {
            type: 'base64'
            media_type: string
            data: string
        }
    }
    | {
        type: 'document'
        source: {
            type: 'base64'
            media_type: 'application/pdf'
            data: string
        }
    }

function toAnthropicMessages(history: UIMessage[]): { system?: string; messages: AnthropicMessage[] } {
    const systemMessages = history.filter((msg) => msg.role === 'system')
    const system = systemMessages.map((msg) => getMessageText(msg)).filter(Boolean).join('\n')
    const messages: AnthropicMessage[] = []
    for (const msg of history) {
        if (msg.role === 'system') continue
        const role = msg.role === 'assistant' ? 'assistant' : 'user'
        if (role === 'assistant') {
            messages.push({ role, content: getMessageText(msg) })
            continue
        }
        const parts = getMessageParts(msg)
        if (parts.length === 0) {
            messages.push({ role, content: msg.content ?? '' })
            continue
        }
        const content: AnthropicContentBlock[] = []
        for (const part of parts) {
            if (part.type === 'text') {
                if (part.text.trim()) content.push({ type: 'text', text: part.text })
                continue
            }
            if (!part.data || part.data.length === 0) {
                throw new Error(`AttachmentDataMissing: ${part.name}`)
            }
            const mimeType = (part.mimeType || 'application/octet-stream').trim().toLowerCase()
            const data = Buffer.from(part.data).toString('base64')
            if (mimeType.startsWith('image/')) {
                content.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: mimeType,
                        data,
                    },
                })
                continue
            }
            if (mimeType === 'application/pdf') {
                content.push({
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data,
                    },
                })
                continue
            }
            throw new Error(`UnsupportedAttachmentType: ${mimeType}`)
        }
        messages.push({ role, content })
    }
    return { system: system || undefined, messages }
}

function normalizeParams(params?: LLMParams): { temperature?: number; max_tokens?: number; top_p?: number; stop_sequences?: string[] } {
    const raw = params as Record<string, unknown> | undefined
    if (!raw) return {}
    const out: { temperature?: number; max_tokens?: number; top_p?: number; stop_sequences?: string[] } = {}
    if (typeof raw.temperature === 'number') out.temperature = raw.temperature
    const maxTokens = raw.maxTokens ?? raw.maxOutputTokens
    if (typeof maxTokens === 'number') out.max_tokens = maxTokens
    const topP = raw.top_p ?? raw.topP
    if (typeof topP === 'number') out.top_p = topP
    if (Array.isArray(raw.stop) && raw.stop.every((s) => typeof s === 'string')) {
        out.stop_sequences = raw.stop as string[]
    }
    return out
}

async function readErrorMessage(res: Response): Promise<string> {
    try {
        const data = (await res.json()) as { error?: { message?: string } }
        return data?.error?.message ?? res.statusText
    } catch {
        return res.statusText
    }
}

async function* streamSse(res: Response): AsyncGenerator<string, void> {
    const reader = res.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (!data) continue
            if (data === '[DONE]') return
            let parsed: unknown
            try {
                parsed = JSON.parse(data)
            } catch {
                continue
            }
            const event = parsed as {
                type?: string
                delta?: { text?: string }
                content_block?: { text?: string }
            }
            if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
                yield event.delta.text
            }
            if (event.type === 'content_block_start' && typeof event.content_block?.text === 'string') {
                yield event.content_block.text
            }
        }
    }
}

function rethrow(err: unknown, httpStatus?: number): never {
    const ne = normalizeError(err, { provider: 'anthropic', httpStatus })
    throw new Error(`${ne.code}: ${ne.message}`)
}

export const AnthropicProvider: Provider = {
    id: 'anthropic',
    supports: () => true,

    async *stream(
        { modelId, history, params, attachments, inputText }: {
            modelId: string
            history: UIMessage[]
            params?: LLMParams
            tools?: ToolDef[]
            attachments?: TurnAttachment[]
            inputText?: string
        },
        ctx
    ): StreamGen {
        try {
            if (!ctx.apiKey) throw new Error('API key missing')
            const baseUrl = (ctx.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
            const mergedHistory = appendLegacyAttachmentsToLastUser(history, attachments, inputText)
            const { system, messages } = toAnthropicMessages(mergedHistory)
            const payload = {
                model: modelId,
                messages,
                stream: true,
                system,
                ...normalizeParams(params),
            }
            const res = await fetch(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ctx.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                body: JSON.stringify(payload),
                signal: ctx.abortSignal,
            })
            if (!res.ok) {
                const msg = await readErrorMessage(res)
                throw new Error(msg)
            }
            yield* streamSse(res)
        } catch (e) {
            const err = e as Error & { status?: number }
            rethrow(err, err.status)
        }
    },

    async complete(
        { modelId, history, params, attachments, inputText }: {
            modelId: string
            history: UIMessage[]
            params?: LLMParams
            tools?: ToolDef[]
            attachments?: TurnAttachment[]
            inputText?: string
        },
        ctx
    ): Promise<string> {
        try {
            if (!ctx.apiKey) throw new Error('API key missing')
            const baseUrl = (ctx.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
            const mergedHistory = appendLegacyAttachmentsToLastUser(history, attachments, inputText)
            const { system, messages } = toAnthropicMessages(mergedHistory)
            const payload = {
                model: modelId,
                messages,
                stream: false,
                system,
                ...normalizeParams(params),
            }
            const res = await fetch(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ctx.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                body: JSON.stringify(payload),
                signal: ctx.abortSignal,
            })
            if (!res.ok) {
                const msg = await readErrorMessage(res)
                throw new Error(msg)
            }
            const data = await res.json() as { content?: Array<{ type?: string; text?: string }> }
            const parts = data.content ?? []
            return parts.map((p) => p.text ?? '').join('')
        } catch (e) {
            const err = e as Error & { status?: number }
            rethrow(err, err.status)
        }
    },
}
