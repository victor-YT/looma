import type {
    LLMModelConfig,
    LLMParams,
    ModelCapabilities,
    ModelDefinition,
    ModelOverride,
    ModelSettings,
    ModelSelectionReasonCode,
    ModelStatus,
    ModelStatusReason,
    ModelWithStatus,
    ResolvedModelConfig,
} from '../../../contracts/index'
import { loadModelsSync, invalidateModelsCache } from '../../config/loadModels'
import { getProviderDefaults, loadProviderSettings } from '../../config/providerSettings'
import { getProviderNativeFileCapabilities, hasProvider, providerSupportsComplete } from '../../llm'
import { getDB } from '../../db'
import {
    getAppSettings,
    getModelDefaultParams,
    listModelOverrides,
    setAppSettingsPatch,
    upsertModelOverride,
    migrateLegacyModelSettings,
} from '../settings/settingsStore'
import {
    listPersistedLocalProviderModels,
    listPersistedCustomProviderModelIds,
    replacePersistedRemoteProviderModels,
    upsertPersistedCustomProviderModel,
} from './localProviderModelStore'

export type ModelResolution = {
    model: LLMModelConfig
    selectedModelId: string
    fallbackUsed: boolean
    reasonCode?: ModelSelectionReasonCode
    reasonDetail?: string
}

export const CUSTOM_MODEL_ICON = 'custom-model'

const DEFAULT_MODEL_ID = 'gemini-2.5-pro'

const defaultCapabilities: ModelCapabilities = {
    stream: true,
    tools: true,
    json: true,
    vision: false,
    nativeSearch: false,
    embeddings: false,
    nativeFiles: false,
    supportedMimeTypes: [],
    attachmentTransport: 'none',
}

const FALLBACK_MAX_OUTPUT_TOKENS = 8192


type RepoModelConfig = {
    id: string
    name?: string
    label?: string
    provider?: string
    kind?: ModelDefinition['kind']
    icon?: string
    apiBase?: string
    stream?: boolean
    params?: Record<string, unknown>
    defaults?: Record<string, unknown>
    limits?: Record<string, unknown>
    capabilities?: Partial<ModelCapabilities>
    requirements?: ModelDefinition['requirements']
    deprecated?: boolean
    hidden?: boolean
}

let repoCache: LLMModelConfig[] | null = null
let dynamicCache: LLMModelConfig[] = []
let mergedCache: LLMModelConfig[] | null = null
let dynamicVersion = 0
let mergedVersion = -1
let persistedDynamicCacheLoaded = false

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback
    try {
        return JSON.parse(raw) as T
    } catch {
        return fallback
    }
}

const REMOTE_DYNAMIC_PROVIDERS = ['ollama', 'lmstudio'] as const
type DynamicProviderId = typeof REMOTE_DYNAMIC_PROVIDERS[number]
type DynamicFetchResult = {
    ok: boolean
    models: LLMModelConfig[]
}

function normalizeBaseUrl(baseUrl: string): string {
    return (baseUrl || '').trim().replace(/\/+$/, '')
}

function buildDynamicModel(
    providerId: string,
    modelId: string,
    options?: { name?: string; source?: 'remote' | 'custom' },
): LLMModelConfig {
    const label = options?.name?.trim() || modelId
    const source = options?.source ?? 'remote'
    const providerCaps = getProviderNativeFileCapabilities(providerId)
    return {
        id: modelId,
        label,
        name: label,
        provider: providerId,
        kind: 'chat',
        capabilities: {
            ...defaultCapabilities,
            ...providerCaps,
            tools: false,
            json: false,
            vision: false,
        },
        defaults: {
            temperature: 0.7,
            topP: 1,
        },
        params: {
            temperature: 0.7,
            top_p: 1,
        },
        requirements: defaultRequirementsForProvider(providerId),
        icon: source === 'custom' ? CUSTOM_MODEL_ICON : undefined,
    }
}

async function fetchLmStudioModels(baseUrl: string): Promise<DynamicFetchResult> {
    const normalized = normalizeBaseUrl(baseUrl)
    if (!normalized) return { ok: false, models: [] }
    const url = normalized.endsWith('/v1')
        ? `${normalized}/models`
        : `${normalized}/v1/models`
    try {
        const res = await fetch(url)
        if (!res.ok) return { ok: false, models: [] }
        const data = await res.json() as { data?: Array<{ id?: string }> }
        const list = Array.isArray(data?.data) ? data.data : []
        return {
            ok: true,
            models: list
            .map((entry) => (entry?.id ? buildDynamicModel('lmstudio', entry.id) : null))
            .filter((m): m is LLMModelConfig => Boolean(m))
        }
    } catch {
        return { ok: false, models: [] }
    }
}

async function fetchOllamaModels(baseUrl: string): Promise<DynamicFetchResult> {
    const normalized = normalizeBaseUrl(baseUrl)
    if (!normalized) return { ok: false, models: [] }
    const url = `${normalized}/api/tags`
    try {
        const res = await fetch(url)
        if (!res.ok) return { ok: false, models: [] }
        const data = await res.json() as { models?: Array<{ name?: string }> }
        const list = Array.isArray(data?.models) ? data.models : []
        return {
            ok: true,
            models: list
            .map((entry) => (entry?.name ? buildDynamicModel('ollama', entry.name) : null))
            .filter((m): m is LLMModelConfig => Boolean(m))
        }
    } catch {
        return { ok: false, models: [] }
    }
}

function setDynamicModelCache(list: LLMModelConfig[]): void {
    dynamicCache = list
    dynamicVersion += 1
    mergedCache = null
}

function ensurePersistedDynamicModelsLoaded(): void {
    if (persistedDynamicCacheLoaded) return
    const persisted = listPersistedLocalProviderModels(getDB())
    setDynamicModelCache(persisted)
    persistedDynamicCacheLoaded = true
}

export async function refreshProviderModels(): Promise<void> {
    ensurePersistedDynamicModelsLoaded()
    const settings = loadProviderSettings()
    const loaders: Record<DynamicProviderId, (baseUrl: string) => Promise<DynamicFetchResult>> = {
        ollama: fetchOllamaModels,
        lmstudio: fetchLmStudioModels,
    }
    const db = getDB()
    const customModelIds = new Set(listPersistedCustomProviderModelIds(db))
    const customModels = dynamicCache.filter((model) => customModelIds.has(model.id))
    const previousByProvider = new Map<DynamicProviderId, LLMModelConfig[]>()
    for (const providerId of REMOTE_DYNAMIC_PROVIDERS) {
        previousByProvider.set(
            providerId,
            dynamicCache.filter((model) => model.provider === providerId && !customModelIds.has(model.id)),
        )
    }
    const results: LLMModelConfig[] = [...customModels]
    const seen = new Set(results.map((model) => model.id))
    for (const providerId of REMOTE_DYNAMIC_PROVIDERS) {
        const cfg = settings[providerId]
        const fallback = getProviderDefaults(providerId)
        const baseUrl = typeof cfg?.apiHost === 'string' ? cfg.apiHost : (fallback.apiHost ?? '')
        const result = await loaders[providerId](baseUrl)
        if (result.ok) {
            replacePersistedRemoteProviderModels(db, providerId, result.models)
            for (const model of result.models) {
                if (seen.has(model.id)) continue
                results.push(model)
                seen.add(model.id)
            }
            continue
        }
        for (const model of previousByProvider.get(providerId) ?? []) {
            if (seen.has(model.id)) continue
            results.push(model)
            seen.add(model.id)
        }
    }
    setDynamicModelCache(results)
}

export function loadLocalSettings(): ModelSettings {
    const db = getDB()
    migrateLegacyModelSettings(db)
    const app = getAppSettings(db)
    const overrides = listModelOverrides(db)
    const modelOverrides: Record<string, ModelOverride> = {}
    const providers: Record<string, { apiKey?: string; baseUrl?: string; extra?: Record<string, unknown> }> = {}
    const models = loadRepoModels()
    const modelById = new Map(models.map(model => [model.id, model]))
    for (const row of overrides) {
        const params = safeJson<Record<string, unknown>>(row.params_json, {})
        const req = safeJson<Record<string, unknown>>(row.requirements_json, {})
        modelOverrides[row.model_id] = {
            enabled: row.enabled,
            defaultsOverride: params,
            endpointOverride: typeof req.baseUrl === 'string' ? req.baseUrl : undefined,
            providerOverride: typeof req.providerOverride === 'string' ? req.providerOverride : undefined,
        }
        const model = modelById.get(row.model_id)
        if (model) {
            const provider = typeof req.providerOverride === 'string' ? req.providerOverride : model.provider
            const entry = providers[provider] ?? {}
            if (typeof req.apiKey === 'string') entry.apiKey = req.apiKey
            if (typeof req.baseUrl === 'string') entry.baseUrl = req.baseUrl
            providers[provider] = entry
        }
    }
    const providerSettings = loadProviderSettings()
    for (const [providerId, cfg] of Object.entries(providerSettings)) {
        const entry = providers[providerId] ?? {}
        if (typeof cfg.apiKey === 'string') entry.apiKey = cfg.apiKey
        if (typeof cfg.apiHost === 'string') entry.baseUrl = cfg.apiHost
        providers[providerId] = entry
    }
    return {
        providers,
        modelOverrides,
        defaults: { chatModelId: app.active_model_id ?? undefined },
        fallbackOrder: [],
    }
}

export function saveLocalSettings(settings: ModelSettings): void {
    const db = getDB()
    for (const [modelId, override] of Object.entries(settings.modelOverrides ?? {})) {
        const requirements: Record<string, unknown> = {}
        if (override.endpointOverride) requirements.baseUrl = override.endpointOverride
        if (override.providerOverride) requirements.providerOverride = override.providerOverride
        void upsertModelOverride(db, {
            model_id: modelId,
            enabled: override.enabled,
            params: override.defaultsOverride ?? {},
            requirements,
        })
    }
    if (settings.defaults?.chatModelId) {
        setAppSettingsPatch(db, { active_model_id: settings.defaults.chatModelId })
    }
}

export function updateLocalSettings(patch: Partial<ModelSettings>): ModelSettings {
    const current = loadLocalSettings()
    const merged: ModelSettings = {
        providers: { ...current.providers, ...(patch.providers ?? {}) },
        modelOverrides: { ...current.modelOverrides, ...(patch.modelOverrides ?? {}) },
        defaults: { ...current.defaults, ...(patch.defaults ?? {}) },
        fallbackOrder: patch.fallbackOrder ?? current.fallbackOrder,
    }
    saveLocalSettings(merged)
    return merged
}

function normalizeRepoModel(raw: RepoModelConfig): LLMModelConfig | null {
    if (!raw?.id) return null
    const label = raw.label ?? raw.name ?? raw.id
    const provider = raw.provider ?? 'gemini'
    const kind = raw.kind ?? 'chat'
    const providerCaps = getProviderNativeFileCapabilities(provider)
    const caps = { ...defaultCapabilities, ...providerCaps, ...(raw.capabilities ?? {}) }
    if (typeof raw.stream === 'boolean') caps.stream = raw.stream

    const defaults = {
        ...(raw.defaults ?? {}),
        ...(raw.params ?? {}),
    }
    const limits = { ...(raw.limits ?? {}) }
    if (defaults.maxContextTokens != null && limits.maxContextTokens == null) {
        limits.maxContextTokens = defaults.maxContextTokens
    }
    if (defaults.maxOutputTokens != null && limits.maxOutputTokens == null) {
        limits.maxOutputTokens = defaults.maxOutputTokens
    }
    const params = { ...defaults }
    if (limits.maxContextTokens != null && params.maxContextTokens == null) {
        params.maxContextTokens = limits.maxContextTokens
    }

    const requirements = raw.requirements ?? defaultRequirementsForProvider(provider)

    return {
        id: raw.id,
        label,
        name: raw.name ?? label,
        provider,
        kind,
        capabilities: caps,
        limits,
        defaults,
        requirements,
        deprecated: raw.deprecated ?? false,
        hidden: raw.hidden ?? false,
        icon: raw.icon,
        apiBase: raw.apiBase,
        params,
    }
}

function defaultRequirementsForProvider(provider: string): ModelDefinition['requirements'] {
    if (provider === 'gemini') {
        return { env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }
    }
    if (provider === 'openai') {
        return { env: ['OPENAI_API_KEY'] }
    }
    if (provider === 'anthropic') {
        return { env: ['ANTHROPIC_API_KEY'] }
    }
    if (provider === 'deepseek') {
        return { env: ['DEEPSEEK_API_KEY'] }
    }
    if (provider === 'ollama' || provider === 'lmstudio') {
        return {}
    }
    return {}
}

function loadRepoModelsRaw(): RepoModelConfig[] {
    const raw = loadModelsSync()
    return Array.isArray(raw) ? (raw as RepoModelConfig[]) : []
}

export function loadRepoModels(): LLMModelConfig[] {
    ensurePersistedDynamicModelsLoaded()
    if (!repoCache) {
        const raw = loadRepoModelsRaw()
        const normalized: LLMModelConfig[] = []
        for (const entry of raw) {
            const model = normalizeRepoModel(entry)
            if (model) normalized.push(model)
        }
        repoCache = normalized
    }
    if (mergedCache && mergedVersion === dynamicVersion) return mergedCache
    const seen = new Set<string>()
    const merged: LLMModelConfig[] = []
    for (const model of repoCache) {
        merged.push(model)
        seen.add(model.id)
    }
    for (const model of dynamicCache) {
        if (seen.has(model.id)) continue
        merged.push(model)
        seen.add(model.id)
    }
    mergedCache = merged
    mergedVersion = dynamicVersion
    return mergedCache
}

export function addPersistedProviderModel(args: {
    providerId: string
    modelId: string
    modelName?: string
}): LLMModelConfig[] {
    const providerId = args.providerId.trim()
    const modelId = args.modelId.trim()
    const modelName = args.modelName?.trim()
    if (!providerId) throw new Error('providerId missing')
    if (!modelId) throw new Error('modelId missing')

    const existing = loadRepoModels().find((model) => model.id === modelId)
    if (existing) {
        throw new Error(`model already exists: ${modelId}`)
    }

    const model = buildDynamicModel(providerId, modelId, {
        name: modelName || modelId,
        source: 'custom',
    })
    upsertPersistedCustomProviderModel(getDB(), providerId, model)
    persistedDynamicCacheLoaded = false
    ensurePersistedDynamicModelsLoaded()
    return loadRepoModels()
}

export function updatePersistedProviderModel(args: {
    providerId: string
    modelId: string
    nextModelId: string
    modelName?: string
}): LLMModelConfig[] {
    const providerId = args.providerId.trim()
    const modelId = args.modelId.trim()
    const nextModelId = args.nextModelId.trim()
    const modelName = args.modelName?.trim()
    if (!providerId) throw new Error('providerId missing')
    if (!modelId) throw new Error('modelId missing')
    if (!nextModelId) throw new Error('nextModelId missing')

    const db = getDB()
    const existing = db.prepare(`
        SELECT source
        FROM local_provider_models
        WHERE provider_id = ? AND model_id = ?
    `).get(providerId, modelId) as { source?: string } | undefined
    if (existing?.source !== 'custom') {
        throw new Error('Only custom models can be edited')
    }

    const currentModels = loadRepoModels()
    const duplicate = currentModels.find((model) => model.id === nextModelId && model.id !== modelId)
    if (duplicate) {
        throw new Error(`model already exists: ${nextModelId}`)
    }

    const nextModel = buildDynamicModel(providerId, nextModelId, {
        name: modelName || nextModelId,
        source: 'custom',
    })
    const now = Date.now()

    const tx = db.transaction(() => {
        db.prepare(`
            DELETE FROM local_provider_models
            WHERE provider_id = ? AND model_id = ? AND source = 'custom'
        `).run(providerId, modelId)

        upsertPersistedCustomProviderModel(db, providerId, nextModel)

        if (modelId !== nextModelId) {
            db.prepare(`UPDATE model_overrides SET model_id = ? WHERE model_id = ?`).run(nextModelId, modelId)
            db.prepare(`UPDATE conversations SET model = ? WHERE model = ?`).run(nextModelId, modelId)
            db.prepare(`UPDATE messages SET model = ? WHERE model = ?`).run(nextModelId, modelId)
            db.prepare(`
                UPDATE app_settings
                SET
                    active_model_id = CASE WHEN active_model_id = ? THEN ? ELSE active_model_id END,
                    last_used_model_id = CASE WHEN last_used_model_id = ? THEN ? ELSE last_used_model_id END,
                    updated_at = ?
                WHERE id = 'singleton'
            `).run(modelId, nextModelId, modelId, nextModelId, now)
        }
    })

    tx()
    persistedDynamicCacheLoaded = false
    ensurePersistedDynamicModelsLoaded()
    return loadRepoModels()
}

export function deletePersistedProviderModel(args: {
    providerId: string
    modelId: string
}): LLMModelConfig[] {
    const providerId = args.providerId.trim()
    const modelId = args.modelId.trim()
    if (!providerId) throw new Error('providerId missing')
    if (!modelId) throw new Error('modelId missing')

    const db = getDB()
    const existing = db.prepare(`
        SELECT source
        FROM local_provider_models
        WHERE provider_id = ? AND model_id = ?
    `).get(providerId, modelId) as { source?: string } | undefined
    if (existing?.source !== 'custom') {
        throw new Error('Only custom models can be deleted')
    }

    const replacementModelId = loadRepoModels()
        .find((model) => model.id !== modelId && model.provider === providerId)?.id ?? null
    const now = Date.now()

    const tx = db.transaction(() => {
        db.prepare(`
            DELETE FROM local_provider_models
            WHERE provider_id = ? AND model_id = ? AND source = 'custom'
        `).run(providerId, modelId)

        db.prepare(`DELETE FROM model_overrides WHERE model_id = ?`).run(modelId)
        db.prepare(`UPDATE conversations SET model = ? WHERE model = ?`).run(replacementModelId, modelId)
        db.prepare(`
            UPDATE app_settings
            SET
                active_model_id = CASE WHEN active_model_id = ? THEN ? ELSE active_model_id END,
                last_used_model_id = CASE WHEN last_used_model_id = ? THEN ? ELSE last_used_model_id END,
                updated_at = ?
            WHERE id = 'singleton'
        `).run(modelId, replacementModelId, modelId, replacementModelId, now)
    })

    tx()
    persistedDynamicCacheLoaded = false
    ensurePersistedDynamicModelsLoaded()
    return loadRepoModels()
}

function applyOverride(
    model: LLMModelConfig,
    override: ModelOverride | undefined,
    globalDefaults: { temperature?: number; top_p?: number; maxTokensTier?: unknown }
): LLMModelConfig {
    const provider = override?.providerOverride ?? model.provider
    const globalParams = buildGlobalParams(model, globalDefaults)
    const defaults: ModelDefinition['defaults'] = {
        ...(model.defaults ?? {}),
        ...globalParams,
        ...(override?.defaultsOverride ?? {}),
    }
    const params: LLMParams = {
        ...(model.params ?? {}),
        ...globalParams,
        ...(override?.defaultsOverride ?? {}),
    }
    if (typeof params.maxTokens === 'number') {
        const clamped = clampMaxTokens(params.maxTokens, model)
        params.maxTokens = clamped
        defaults.maxOutputTokens = clamped
    }
    return {
        ...model,
        provider,
        defaults,
        params,
    }
}

function buildGlobalParams(
    model: LLMModelConfig,
    globalDefaults: { temperature?: number; top_p?: number; maxTokensTier?: unknown }
): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (typeof globalDefaults.temperature === 'number') out.temperature = globalDefaults.temperature
    if (typeof globalDefaults.top_p === 'number') out.top_p = globalDefaults.top_p
    const tier = globalDefaults.maxTokensTier
    if (tier !== undefined) {
        const resolved = resolveMaxTokensTier(model, tier)
        if (typeof resolved === 'number') out.maxTokens = resolved
    }
    return out
}

function resolveMaxTokensTier(model: LLMModelConfig, tier: unknown): number | null {
    if (tier === 'max') return getModelMaxOutputTokens(model)
    if (typeof tier === 'number') return clampMaxTokens(tier, model)
    return null
}

function clampMaxTokens(value: number, model: LLMModelConfig): number {
    const limit = getModelMaxOutputTokens(model)
    return Math.min(value, limit)
}

function getModelMaxOutputTokens(model: LLMModelConfig): number {
    if (typeof model.limits?.maxOutputTokens === 'number') return model.limits.maxOutputTokens
    if (typeof model.defaults?.maxOutputTokens === 'number') return model.defaults.maxOutputTokens
    if (typeof model.params?.maxTokens === 'number') return model.params.maxTokens
    return FALLBACK_MAX_OUTPUT_TOKENS
}

type ProviderConfig = { apiKey?: string; baseUrl?: string; providerOverride?: string; enabled?: boolean }

function isEnvSatisfied(envs: string[] | undefined, providerCfg: ProviderConfig): boolean {
    if (!envs || envs.length === 0) return true
    if (providerCfg.apiKey) return true
    return envs.some((key) => Boolean(process.env[key]))
}

function buildStatus(
    model: LLMModelConfig,
    override: ModelOverride | undefined,
    providerCfg: ProviderConfig,
): ModelStatus {
    const reasons: ModelStatusReason[] = []
    let details: string | undefined

    if (override?.enabled === false) reasons.push('disabled')
    if (model.deprecated) reasons.push('model_deprecated')

    if (!hasProvider(model.provider)) {
        reasons.push('provider_not_installed')
    }

    if (providerCfg.enabled === false) {
        reasons.push('disabled')
    }

    if (model.capabilities?.stream === false && !providerSupportsComplete(model.provider)) {
        reasons.push('provider_not_supported')
    }

    const req = model.requirements ?? {}
    if (!isEnvSatisfied(req.env, providerCfg)) {
        reasons.push('missing_key')
        const envs = req.env?.join(', ')
        details = envs ? `missing env: ${envs}` : 'missing env'
    }

    const endpoint = override?.endpointOverride ?? providerCfg.baseUrl
    if (req.endpoint && !endpoint) {
        reasons.push('missing_endpoint')
        details = details ?? 'missing endpoint'
    }

    return { available: reasons.length === 0, reasons, details }
}

function reasonFromStatus(status: ModelStatus): { code: ModelSelectionReasonCode; detail?: string } {
    if (status.reasons.includes('disabled') || status.reasons.includes('model_deprecated')) {
        return { code: 'MODEL_DISABLED', detail: status.details }
    }
    if (status.reasons.includes('provider_not_installed')) {
        return { code: 'PROVIDER_MISSING', detail: status.details }
    }
    if (status.reasons.includes('provider_not_supported')) {
        return { code: 'STREAM_UNSUPPORTED', detail: status.details }
    }
    if (status.reasons.includes('missing_key') || status.reasons.includes('missing_endpoint')) {
        return { code: 'MISSING_REQUIREMENT', detail: status.details }
    }
    return { code: 'PROVIDER_UNREGISTERED', detail: status.details }
}

export function getModels(): LLMModelConfig[] {
    return loadRepoModels()
}

export function getModelById(id: string): LLMModelConfig | undefined {
    const settings = loadLocalSettings()
    const globalDefaults = getModelDefaultParams(getDB())
    const base = loadRepoModels().find(m => m.id === id)
    if (!base) return undefined
    const override = settings.modelOverrides[id]
    return applyOverride(base, override, globalDefaults)
}

type ResolveModelRuntimeOverrides = {
    params?: Record<string, unknown>
    providerId?: string
    apiKey?: string
    baseUrl?: string
    apiPath?: string
    headers?: Record<string, string>
}

export function resolveModelConfig(args: {
    modelId: string
    conversationId?: string
    runtimeOverrides?: ResolveModelRuntimeOverrides
}): ResolvedModelConfig {
    const db = getDB()
    migrateLegacyModelSettings(db)
    const settings = loadLocalSettings()
    const globalDefaults = getModelDefaultParams(db)
    const base = loadRepoModels().find(m => m.id === args.modelId)
    if (!base) throw new Error(`model not found: ${args.modelId}`)
    const override = settings.modelOverrides[base.id]

    let model = applyOverride(base, override, globalDefaults)

    const runtimeParams = args.runtimeOverrides?.params ?? {}
    const mergedParams = { ...(model.params ?? {}), ...runtimeParams }
    if (typeof mergedParams.maxTokens === 'number') {
        mergedParams.maxTokens = clampMaxTokens(mergedParams.maxTokens, model)
    }
    model = { ...model, params: mergedParams }

    const providerCfg = getProviderConfigForModel(model.id)
    const providerId = args.runtimeOverrides?.providerId ?? providerCfg.providerOverride ?? model.provider
    model = { ...model, provider: providerId }

    const ctx = {
        apiKey: args.runtimeOverrides?.apiKey ?? providerCfg.apiKey ?? undefined,
        baseUrl: args.runtimeOverrides?.baseUrl ?? providerCfg.baseUrl ?? model.apiBase ?? undefined,
    }
    if (!ctx.apiKey) {
        const envs = model.requirements?.env ?? []
        for (const key of envs) {
            const val = process.env[key]
            if (val) {
                ctx.apiKey = val
                break
            }
        }
    }
    const availability = buildStatus(model, override, { ...providerCfg, providerOverride: providerId })

    return {
        model,
        entryId: base.id,
        providerModelId: model.id,
        modelId: model.id,
        providerId,
        apiBase: ctx.baseUrl ?? model.apiBase,
        apiPath: args.runtimeOverrides?.apiPath,
        headers: args.runtimeOverrides?.headers,
        params: mergedParams,
        capabilities: model.capabilities,
        limits: model.limits,
        defaults: model.defaults,
        ctx,
        availability,
    }
}

export function getEffectiveModel(id: string): { model?: LLMModelConfig; status: ModelStatus } {
    const base = loadRepoModels().find(m => m.id === id)
    if (!base) return { model: undefined, status: { available: false, reasons: ['provider_not_supported'] } }
    const resolved = resolveModelConfig({ modelId: id })
    return { model: resolved.model as LLMModelConfig, status: resolved.availability }
}

export function getAvailableModel(id?: string | null): LLMModelConfig | null {
    if (!id) return null
    const resolved = getEffectiveModel(id)
    if (!resolved.model || !resolved.status.available) return null
    return resolved.model
}

export function listModelsWithStatus(kind?: ModelDefinition['kind']): ModelWithStatus[] {
    const models = loadRepoModels()
    const out: ModelWithStatus[] = []
    for (const base of models) {
        if (kind && base.kind !== kind) continue
        const resolved = resolveModelConfig({ modelId: base.id })
        out.push({ model: resolved.model, status: resolved.availability })
    }
    return out
}

export function getCustomModelIds(): Set<string> {
    return new Set(listPersistedCustomProviderModelIds(getDB()))
}

export function getProviderConfigForModel(modelId: string): ProviderConfig {
    const db = getDB()
    const overrides = listModelOverrides(db)
    const row = overrides.find(o => o.model_id === modelId)
    const req = safeJson<Record<string, unknown>>(row?.requirements_json, {})
    const model = loadRepoModels().find(m => m.id === modelId)
    const providerOverride = typeof req.providerOverride === 'string' ? req.providerOverride : undefined
    const providerId = providerOverride ?? model?.provider
    const providerSettings = loadProviderSettings()
    const cfg = providerId ? providerSettings[providerId] : undefined
    return {
        apiKey: typeof cfg?.apiKey === 'string' ? cfg.apiKey : (typeof req.apiKey === 'string' ? req.apiKey : undefined),
        baseUrl: typeof cfg?.apiHost === 'string' ? cfg.apiHost : (typeof req.baseUrl === 'string' ? req.baseUrl : undefined),
        enabled: typeof cfg?.enabled === 'boolean' ? cfg.enabled : undefined,
        providerOverride,
    }
}

function pickFirstAvailable(models: ModelWithStatus[]): LLMModelConfig | null {
    for (const { model, status } of models) {
        if (status.available) return model
    }
    return null
}

export function pickFallback(
    kind: ModelDefinition['kind'],
    reasonContext?: string,
): LLMModelConfig {
    const settings = loadLocalSettings()
    const candidates = listModelsWithStatus(kind)
    const byId = new Map(candidates.map(c => [c.model.id, c]))
    const defaultId = kind === 'embedding'
        ? settings.defaults?.embeddingModelId
        : settings.defaults?.chatModelId
    const ordered = [
        defaultId,
        ...(settings.fallbackOrder ?? []),
        DEFAULT_MODEL_ID,
    ].filter(Boolean) as string[]

    for (const id of ordered) {
        const entry = byId.get(id)
        if (entry && entry.status.available) return entry.model as LLMModelConfig
    }

    const firstAvailable = pickFirstAvailable(candidates)
    if (firstAvailable) return firstAvailable

    if (reasonContext) {
        console.warn('[modelRegistry] fallback unavailable:', reasonContext)
    }
    return candidates[0]?.model ?? loadRepoModels()[0]
}

export function getModelOrFallback(modelId?: string | null): ModelResolution {
    const settings = loadLocalSettings()
    const targetId = modelId ?? settings.defaults?.chatModelId ?? DEFAULT_MODEL_ID
    const resolved = getEffectiveModel(targetId)
    if (resolved.model && resolved.status.available) {
        return {
            model: resolved.model,
            selectedModelId: resolved.model.id,
            fallbackUsed: false,
        }
    }

    const kind = resolved.model?.kind ?? 'chat'
    const fallback = pickFallback(kind, resolved.model ? resolved.status.reasons.join(',') : 'model_not_found')
    const reason = resolved.model
        ? reasonFromStatus(resolved.status)
        : { code: 'MODEL_NOT_FOUND' as const, detail: `missing model: ${targetId}` }
    return {
        model: fallback,
        selectedModelId: fallback.id,
        fallbackUsed: true,
        reasonCode: reason.code,
        reasonDetail: reason.detail,
    }
}

export function getConversationModelOrFallback(conversationId: string): ModelResolution {
    const db = getDB()
    const row = db.prepare('SELECT model FROM conversations WHERE id = ?')
        .get(conversationId) as { model?: string } | undefined
    return getModelOrFallback(row?.model ?? DEFAULT_MODEL_ID)
}

export function resetModelCache(): void {
    repoCache = null
    dynamicCache = []
    mergedCache = null
    dynamicVersion += 1
    mergedVersion = -1
    persistedDynamicCacheLoaded = false
    invalidateModelsCache()
}

export function reloadModels(): void {
    resetModelCache()
    loadRepoModels()
    loadLocalSettings()
}
