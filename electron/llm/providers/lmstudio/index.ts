import { createOpenAICompatibleProvider } from '../openaiCompatible'

function normalizeLmStudioBase(baseUrl: string): string {
    if (baseUrl.endsWith('/v1')) return baseUrl
    return `${baseUrl}/v1`
}

export const LMStudioProvider = createOpenAICompatibleProvider({
    id: 'lmstudio',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    requireApiKey: false,
    normalizeBaseUrl: normalizeLmStudioBase,
    capabilities: {
        nativeFiles: true,
        supportedMimeTypes: ['image/*'],
        attachmentTransport: 'inline_base64',
    },
})
