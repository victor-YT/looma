// /types/strategies.ts

import type { LLMModelConfig } from '../llm'
import type { ConversationSnapshot } from '../ui/chat'
import type { UIMessage } from '../ui/UIMessage'
import type { Role } from '../shared'
import type { MemoryHit } from '../memory/memorySearch'
import type { MemoryIngestOptions, MemoryIngestResult } from '../memory/memoryIngest'
import type { MemoryRecord, ReadAssetOptions } from '../memory/memory'
import type { StrategyManifest } from '../settings'

/**
 * Small DSL that exposes tools for strategy files.
 * It can be extended later with injectSystem, injectMemory, reorder, and so on.
 */
export type ContextTools = {
    trimLatest: (keepLast: number) => void
}

export type ContextSessionLike = {
    getEffectiveContext(): UIMessage[]
    setWorkingContext(messages: UIMessage[]): void
    measure(modelId: string, opts?: { maxContextTokens?: number }): {
        totalTokens: number
        userTokens: number
        assistantTokens: number
        messages: number
        maxTokens: number
        usedRatio: number
    }
}

/**
 * ContextStrategy is the function signature exposed by user-authored strategy files.
 * ChatFlow invokes it on every turn.
 */
export type ContextStrategy = (args: {
    session: ContextSessionLike
    model: LLMModelConfig
    tools: ContextTools
}) => Promise<void> | void

export interface StrategyContextBuildResult {
    prompt: { messages: Message[] }
    tools?: ToolDefinition[]
    meta?: {
        trimmed?: boolean
        inputTokenEstimate?: number
        slotCount?: number
        historyOriginalCount?: number
        historySelectedCount?: number
        historyClipReason?: string
        historyDroppedMessageIds?: string[]
    }
}

export type StrategyContextBuildOutput =
    | StrategyContextBuildResult
    | { messages: Message[] }
    | Message[]

export type ToolCall = {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

export type StrategyConfigType = 'text' | 'number' | 'boolean' | 'select'

export type StrategyConfigOption = {
    label: string
    value: string
}

export type StrategyConfigEntry = {
    key: string
    type: StrategyConfigType
    default: string | number | boolean
    label?: string
    description?: string
    min?: number
    max?: number
    step?: number
    options?: StrategyConfigOption[]
}

export type StrategyConfigSchema = StrategyConfigEntry[]

export type StrategyMessageRole = Extract<Role, 'user' | 'assistant' | 'system' | 'tool'>

export type Attachment = {
    id: string
    name: string
    size: number
    modality: 'document' | 'image' | 'audio' | 'video'
    mimeType?: string
}

export type LoomaAttachment = Attachment

export type Message = {
    role: StrategyMessageRole
    content: string | null
    attachments?: Attachment[]
}

export type MeasureInput =
    | string
    | Message
    | Message[]
    | Attachment
    | Attachment[]

export type LLMMessage = Message | {
    role: 'assistant'
    content: string | null
    attachments?: Attachment[]
    tool_calls?: ToolCall[]
    name?: string
} | {
    role: 'tool'
    content: string | null
    tool_call_id?: string
    name?: string
}

export type RuntimeMessage = LLMMessage & {
    attachments?: Attachment[]
    tool_calls?: ToolCall[]
    tool_call_id?: string
    name?: string
    id?: string
    conversation_id?: string
    type?: string
    model?: string | null
    parent_id?: string
    timestamp?: number
}

export type ToolDefinition = {
    type: 'function'
    function: {
        name: string
        description?: string
        parameters: Record<string, unknown>
    }
}

export type RunResult = {
    content: string
    finishReason: 'stop' | 'length' | 'tool_calls' | 'error' | 'aborted'
    messages: LLMMessage[]
    toolCalls?: Array<{
        id: string
        name: string
        args: Record<string, unknown>
        status: 'ok' | 'error' | 'aborted'
        resultText?: string
        errorMessage?: string
    }>
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
    error?: { code?: string; message?: string }
}

export type Input = {
    text: string
    attachments: Attachment[]
}

export type LoomaMessage = {
    id: string
    role: 'assistant'
    content: string | null
    toolCalls?: ToolCall[]
    finishReason?: 'stop' | 'length' | 'tool_calls' | 'error'
}

export type Budget = {
    maxInputTokens: number
    maxOutputTokens: number
    reservedTokens: number
    remainingInputTokens: number
}

export type Capabilities = {
    vision: boolean
    structuredOutput: boolean
    tools: boolean
}

export type HistoryHelper = {
    lastUser(): Message | null
    lastAssistant(): Message | null
    range(args: { fromEnd: number; toEnd: number }): Message[]
    recent(n: number): Message[]
    byTokens(maxTokens: number): Message[]
    recentText(n: number): string
    debugState?(): HistorySelectionDebug | null
}

export type HistorySelectionDebug = {
    mode: 'range' | 'recent' | 'byTokens'
    selectedCount: number
    originalCount: number
    requested?: number
    historyClipReason?: string
    historyDroppedMessageIds?: string[]
}

export type SlotsAddOptions = {
    priority?: number
    maxRatio?: number
    minRatio?: number
    minTokens?: number
    position?: number
    role?: StrategyMessageRole
    trimBehavior?: 'char' | 'message'
}

export type SlotsAPI = {
    add(name: string, content: string | Message | Message[] | Input | null, options?: SlotsAddOptions): void
    render(): { messages: Message[] }
}

export type ToolChoice =
    | 'auto'
    | 'none'
    | { type: 'function'; function: { name: string } }

export type MemoryQueryOptions = {
    tags?: string[]
    orderBy?: 'updatedAt' | 'createdAt'
    order?: 'desc' | 'asc'
    limit?: number
    offset?: number
}

export type MemorySearchOptions = {
    topK?: number
    tags?: string[]
    threshold?: number
}

export type MemoryIngestSource =
    | string
    | { assetId: string }
    | { text?: string; data?: Uint8Array; filename?: string; mime?: string }
export type MemoryIngestInput = MemoryIngestSource | MemoryIngestSource[]

export type LLMTools = {
    call(input: string | Message[]): Promise<Message>
    call(
        messages: LLMMessage[],
        options?: {
            tools?: ToolDefinition[]
            toolChoice?: ToolChoice
            temperature?: number
        }
    ): Promise<LLMMessage>
    run(options: {
        messages: LLMMessage[]
        tools?: ToolDefinition[]
        toolChoice?: ToolChoice
        maxRounds?: number
        onToolCall?: (call: { id: string; name: string; args: Record<string, unknown> }) => Promise<string>
        temperature?: number
    }): Promise<RunResult>
}

export type StateTools = {
    get<T = unknown>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    has(key: string): Promise<boolean>
}

export type MemoryAPI = {
    query(options?: MemoryQueryOptions): Promise<MemoryRecord[]>
    search(query: string, options?: MemorySearchOptions): Promise<MemoryHit[]>
    ingest(input: MemoryIngestInput, options?: MemoryIngestOptions): Promise<MemoryIngestResult | MemoryIngestResult[]>
    readAsset(asset: Attachment | string, options?: ReadAssetOptions): Promise<string>
    removeMemory(memoryId: string): Promise<{ deleted: boolean }>
}

export type ToolsAPI = {
    llm: LLMTools
    state: StateTools
    memory: MemoryAPI
}

export type LoomaContext = {
    input: Input
    history: HistoryHelper
    message: LoomaMessage | null
    config: Record<string, unknown>
    budget: Budget
    capabilities: Capabilities
    slots: SlotsAPI
    llm: LLMTools
    state: StateTools
    memory: MemoryAPI
    tools: ToolsAPI
    utils: {
        measure(input: MeasureInput): number
        now(): number
    }
}

export type StrategyMeta = {
    name: string
    description?: string
    version?: string
    icon?: string
}

export type StrategyHooks = {
    onInit?: (ctx: LoomaContext) => Promise<void> | void
    onContextBuild: (ctx: LoomaContext) => Promise<StrategyContextBuildOutput> | StrategyContextBuildOutput
    onTurnEnd?: (ctx: LoomaContext) => Promise<void> | void
    onCleanup?: (ctx: LoomaContext) => Promise<void> | void
    onError?: (ctx: LoomaContext, error: unknown, phase: string) => Promise<void> | void
    onReplayTurn?: (ctx: StrategyReplayTurnInput) => Promise<void> | void
    onToolCall?: (ctx: LoomaContext, call: unknown) => Promise<string> | string
}

export type StrategyModule = {
    meta: StrategyMeta
    configSchema?: StrategyConfigSchema
    hooks: StrategyHooks
}

export type StrategyDefinition =
    | StrategyModule
    | (Omit<StrategyModule, 'hooks'> & StrategyHooks)

export type StrategyScope = {
    conversationId: string
    strategyKey: string
    strategyVersion: string
}

export type StrategyReplayTurnInput = {
    scope: StrategyScope
    turnId: string
    tseq: number
    user?: { id: string; content: string }
    assistant?: { id: string; content: string; status?: string }
}

export type StrategySwitchMode = 'no_replay' | 'replay'

export type StrategySwitchRequest = {
    conversationId: string
    strategyKey: string
    strategyVersion: string
    mode: StrategySwitchMode
}

export type StrategySwitchResponse = {
    sessionId: string
    mode: StrategySwitchMode
    startTseq: number
    latestTseq: number
    snapshot: ConversationSnapshot
}

export type StrategyPrefs = {
    enabledIds: string[]
    defaultId: string
}

export type StrategyPrefsInput = {
    enabledIds?: string[]
    defaultId?: string
}

export type StrategyDisableInput = {
    strategyId: string
    reassignTo: string
}

export type StrategyUsageCounts = Record<string, number>
export type StrategyParams = Record<string, unknown>

export type StrategyInfo = {
    id: string
    key: string
    source: string
    meta: StrategyMeta
    entry_path: string
    manifest?: StrategyManifest | null
    paramsSchema?: unknown
    configSchema?: unknown
    capabilities?: Record<string, unknown>
    enabled?: boolean
    features?: {
        memoryCloud?: boolean
    }
}

export type StrategyActiveInfo = {
    strategyId: string
    sessionId?: string | null
}

export type StrategyDevCompileRequest = {
    filePath: string
    displayName?: string
}

export type StrategyDevLogEntry = {
    level: 'log' | 'warn' | 'error'
    message: string
}

export type StrategyDevError = {
    message: string
    stack?: string
}

export type StrategyDevDiagnostic = {
    kind: 'compile' | 'smoke' | 'runtime'
    message: string
    stack?: string
    file?: string
    line?: number
    column?: number
    frame?: string
}

export type StrategyDevCompileResult = {
    ok: boolean
    meta?: {
        name?: string
        description?: string
        version?: string
        [key: string]: unknown
    }
    exportsDetected?: string[]
    smokeTest?: {
        calledOnContextBuild?: boolean
        slotsAdded?: number
    }
    errors?: StrategyDevError[]
    diagnostics?: StrategyDevDiagnostic[]
    logs?: StrategyDevLogEntry[]
    bundleSize?: number
    paramsSchema?: unknown
    code?: string
    hash?: string
}

export type StrategyDevSaveRequest = {
    filePath: string
    code: string
    meta?: StrategyDevCompileResult['meta']
    paramsSchema?: StrategyDevCompileResult['paramsSchema']
    hash?: string
    diagnostics?: StrategyDevCompileResult['diagnostics']
}

export type StrategyDevSaveResult = {
    ok: boolean
    strategyId?: string
    sourceSnapshot?: string
    sourceError?: string
    error?: string
}

export type StrategyDevReloadRequest = {
    strategyId: string
    filePath: string
    code: string
    meta?: StrategyDevCompileResult['meta']
    paramsSchema?: StrategyDevCompileResult['paramsSchema']
    hash?: string
    diagnostics?: StrategyDevCompileResult['diagnostics']
}

export type StrategyDevReloadResult = {
    ok: boolean
    sourceSnapshot?: string
    sourceError?: string
    error?: string
}

export type StrategyDevSnapshotRequest = {
    strategyId: string
}

export type StrategyDevSnapshotResult = {
    ok: boolean
    sourceSnapshot?: string
    sourceError?: string
    error?: string
}

export type StrategyDevOpenChatRequest = {
    strategyId: string
}

export type StrategyDevOpenChatResult = {
    conversationId: string
}

export type StrategyDevOpenSourceFolderRequest = {
    strategyId: string
}

export type StrategyDevOpenSourceFolderResult = {
    ok: true
    path: string
}

export type StrategyDevEventPhase = 'context' | 'llm' | 'turnEnd' | 'system'

export type StrategyDevEventBase = {
    conversationId: string
    strategyId: string
    turnId?: string | null
    timestamp: number
    ts?: number
    phase?: StrategyDevEventPhase
    kind?: string
}

export type StrategyDevEvent =
    | (StrategyDevEventBase & {
        type: 'console'
        level: 'log' | 'warn' | 'error'
        text: string
    })
    | (StrategyDevEventBase & {
        type: 'prompt'
        data: {
            messages: Message[]
            meta?: StrategyContextBuildResult['meta']
        }
    })
    | (StrategyDevEventBase & {
        type: 'context'
        data: {
            input: LoomaContext['input']
            budget: LoomaContext['budget']
            capabilities: LoomaContext['capabilities']
            config: LoomaContext['config']
            message: LoomaContext['message'] | null
            historyPreview?: Array<{ role: string; content: string | null }>
            historySelection?: HistorySelectionDebug
        }
    })
    | (StrategyDevEventBase & {
        type: 'state'
        data: { entries: Array<{ key: string; value: unknown }> }
    })
    | (StrategyDevEventBase & {
        type: 'slots'
        data: {
            entries: Array<{
                name: string
                messages: Message[]
                options?: SlotsAddOptions
            }>
        }
    })
    | (StrategyDevEventBase & {
        type: 'budget'
        data: {
            totalTokens: number
            userTokens: number
            assistantTokens: number
            messages: number
            maxTokens: number
            usedRatio: number
        }
    })
    | (StrategyDevEventBase & {
        type: 'tools'
        data: {
            action:
                | 'context'
                | 'llm.call'
                | 'llm.run'
                | 'llm.result'
                | 'toolCall'
                | 'tool.call'
                | 'tool.result'
                | 'tool.error'
            input?: unknown
            output?: unknown
            error?: string
        }
    })
    | (StrategyDevEventBase & {
        type: 'memory'
        data: {
            action: 'query' | 'search' | 'ingest' | 'readAsset' | 'removeMemory'
            input?: unknown
            output?: unknown
            error?: string
        }
    })
    | (StrategyDevEventBase & {
        type: 'meta'
        data: {
            name?: string
            description?: string
            version?: string
        }
    })
    | (StrategyDevEventBase & {
        type: 'error'
        phase: StrategyDevEventPhase | 'init' | 'context' | 'turnEnd' | 'toolCall' | 'replay' | 'unknown'
        message: string
        stack?: string
    })
    | (StrategyDevEventBase & {
        type: 'reload'
        version?: string
        hash?: string
    })
    | (StrategyDevEventBase & {
        type: 'status'
        data: {
            active: boolean
            fallbackUsed: boolean
            message?: string
            source?: 'worker' | 'host'
        }
    })
    | (StrategyDevEventBase & {
        type: 'turn'
        data: {
            status: 'start' | 'done' | 'error'
            reason?: string
            message?: string
            rawError?: unknown
            selectedModelId?: string
            selectedProviderId?: string
        }
    })

export type StrategySwitchInput = {
    conversationId: string
    strategyId: string
    mode?: StrategySwitchMode
}

export type ConversationStrategyUpdateRequest = {
    conversationId: string
    strategyId: string
    mode?: StrategySwitchMode
}

export type ConversationStrategyUpdateResponse = {
    ok: true
    sessionId: string
    mode: StrategySwitchMode
    startTseq: number
    latestTseq: number
    snapshot: ConversationSnapshot
}

export type StrategyReplayStartedEvent = {
    sessionId: string
    conversationId: string
    strategyKey: string
    strategyVersion: string
    startTseq: number
    endTseq: number
}

export type StrategyReplayProgressEvent = {
    sessionId: string
    processed: number
    total: number
    currentTseq: number
}

export type StrategyReplayDoneEvent = {
    sessionId: string
    status: 'completed' | 'cancelled' | 'failed'
}

export interface Strategy {
    meta: { id: string; name: string; version?: string }
    allowedTools?: string[]
    allowedPermissions?: import('../tools').ToolPermissions
    onContextBuild(ctx: LoomaContext): Promise<StrategyContextBuildOutput>
    onTurnEnd?(ctx: LoomaContext): Promise<void>
    onReplayTurn?(ctx: StrategyReplayTurnInput): Promise<void>
    onToolCall?(ctx: LoomaContext, call: unknown): Promise<string>
}
