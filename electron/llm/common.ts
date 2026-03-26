import type { UIMessage, LLMParams, ToolDef, ModelCapabilities, TurnAttachment } from '../../contracts/index'

export type StreamGen = AsyncGenerator<string, void>

export interface ProviderCtx {
    apiKey?: string
    baseUrl?: string
    nativeSearch?: boolean
    headers?: Record<string, string>
    timeoutMs?: number
    conversationId?: string
    turnId?: string
    replyId?: string
    traceId?: string
    abortSignal?: AbortSignal
}

export interface Provider {
    id: string
    // Declare attachment capabilities here when they apply uniformly to the provider.
    // If support varies by model, prefer overriding capabilities in models.json.
    capabilities?: Partial<Pick<ModelCapabilities, 'nativeFiles' | 'supportedMimeTypes' | 'maxFileSizeMB' | 'maxFilesPerTurn' | 'attachmentTransport'>>
    supports: (modelId: string) => boolean
    // Providers receive hydrated UI history plus optional turn-scoped attachments/inputText.
    // Adapters are responsible for mapping that data into provider-native payloads.
    stream(
        args: {
            modelId: string
            history: UIMessage[]
            params?: LLMParams
            tools?: ToolDef[]
            attachments?: TurnAttachment[]
            inputText?: string
        },
        ctx: ProviderCtx
    ): StreamGen
    complete?(
        args: {
            modelId: string
            history: UIMessage[]
            params?: LLMParams
            tools?: ToolDef[]
            attachments?: TurnAttachment[]
            inputText?: string
        },
        ctx: ProviderCtx
    ): Promise<string>
}
