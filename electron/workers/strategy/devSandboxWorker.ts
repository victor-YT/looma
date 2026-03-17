import { parentPort } from 'node:worker_threads'
import { cloneValidatedConfigSchema } from '../../core/strategy/configSchema'

type DevWorkerRequest = {
    id: string
    code: string
}

type DevLogEntry = {
    level: 'log' | 'warn' | 'error'
    message: string
}

type DevWorkerResponse = {
    id: string
    ok: boolean
    meta?: Record<string, unknown>
    paramsSchema?: unknown
    exportsDetected?: string[]
    smokeTest?: {
        calledOnContextBuild?: boolean
        slotsAdded?: number
    }
    errors?: Array<{ message: string; stack?: string }>
    logs?: DevLogEntry[]
}

function formatLogArgs(args: unknown[]): string {
    return args
        .map((arg) => {
            if (typeof arg === 'string') return arg
            try {
                return JSON.stringify(arg)
            } catch {
                return String(arg)
            }
        })
        .join(' ')
}

function captureConsole(logs: DevLogEntry[]) {
    const original = {
        log: console.log,
        warn: console.warn,
        error: console.error,
    }

    console.log = (...args: unknown[]) => {
        logs.push({ level: 'log', message: formatLogArgs(args) })
    }
    console.warn = (...args: unknown[]) => {
        logs.push({ level: 'warn', message: formatLogArgs(args) })
    }
    console.error = (...args: unknown[]) => {
        logs.push({ level: 'error', message: formatLogArgs(args) })
    }

    return () => {
        console.log = original.log
        console.warn = original.warn
        console.error = original.error
    }
}

function createMockCtx() {
    const state = new Map<string, unknown>()
    const slotEntries: Array<{ name: string; content: unknown }> = []
    let slotsAdded = 0
    const llm = {
        call: async () => ({ role: 'assistant', content: '' }),
        run: async () => ({ content: '', finishReason: 'stop', messages: [] }),
    }
    const stateApi = {
        get: async (key: string) => (state.get(key) as unknown) ?? null,
        set: async (key: string, value: unknown) => {
            state.set(key, value)
        },
        delete: async (key: string) => {
            state.delete(key)
        },
        has: async (key: string) => state.has(key),
    }
    const memory = {
        query: async () => [],
        search: async () => [],
        ingest: async () => ({ assetId: '', chunkCount: 0, status: 'completed' as const }),
        readAsset: async () => '',
        removeMemory: async () => ({ deleted: false }),
    }
    const tools = {
        llm,
        state: stateApi,
        memory,
    }

    return {
        ctx: {
            input: { text: 'Hello from Looma', attachments: [] },
            config: {},
            history: {
                lastUser: () => null,
                lastAssistant: () => null,
                range: () => [],
                recent: () => [],
                byTokens: () => [],
                recentText: () => '',
            },
            slots: {
                add: (name: string, content: unknown) => {
                    slotsAdded += 1
                    slotEntries.push({ name, content })
                },
                render: () => {
                    const messages: Array<{ role: string; content: string }> = []
                    for (const entry of slotEntries) {
                        if (typeof entry.content === 'string') {
                            messages.push({ role: 'system', content: entry.content })
                        } else if (Array.isArray(entry.content)) {
                            for (const item of entry.content) {
                                if (item && typeof item === 'object' && 'role' in item && 'content' in item) {
                                    messages.push(item as { role: string; content: string })
                                }
                            }
                        } else if (entry.content && typeof entry.content === 'object') {
                            if ('role' in entry.content && 'content' in entry.content) {
                                messages.push(entry.content as { role: string; content: string })
                            }
                        }
                    }
                    return { messages }
                },
            },
            llm,
            state: stateApi,
            memory,
            tools,
            utils: {
                now: () => Date.now(),
                uuid: () => `mock-${Math.random().toString(36).slice(2, 10)}`,
            },
        },
        getSlotsAdded: () => slotsAdded,
    }
}

const HOOK_NAMES = [
    'onContextBuild',
    'onInit',
    'onTurnEnd',
    'onReplayTurn',
    'onError',
    'onCleanup',
    'onToolCall',
] as const

type HookName = typeof HOOK_NAMES[number]

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object')
}

function getHookCandidate(source: Record<string, unknown> | null, name: HookName): ((ctx: unknown, ...args: unknown[]) => unknown) | undefined {
    if (!source) return undefined
    const value = source[name]
    return typeof value === 'function' ? (value as (ctx: unknown, ...args: unknown[]) => unknown) : undefined
}

function detectExports(mod: Record<string, unknown>): string[] {
    const detected = new Set<string>()
    const defaultExport = isRecord(mod.default) ? mod.default : null
    const hookSources: Array<{ label: string; source: Record<string, unknown> | null }> = [
        { label: 'hooks', source: isRecord(mod.hooks) ? (mod.hooks as Record<string, unknown>) : null },
        { label: '', source: mod },
        { label: 'default.hooks', source: defaultExport && isRecord(defaultExport.hooks) ? (defaultExport.hooks as Record<string, unknown>) : null },
        { label: 'default', source: defaultExport },
    ]

    for (const name of HOOK_NAMES) {
        for (const entry of hookSources) {
            const fn = getHookCandidate(entry.source, name)
            if (fn) {
                const prefix = entry.label ? `${entry.label}.` : ''
                detected.add(`${prefix}${name}`)
            }
        }
    }
    return Array.from(detected)
}

function resolveHook(mod: Record<string, unknown>, name: HookName): ((ctx: unknown) => unknown) | undefined {
    const defaultExport = isRecord(mod.default) ? mod.default : null
    const hookSources: Array<Record<string, unknown> | null> = [
        isRecord(mod.hooks) ? (mod.hooks as Record<string, unknown>) : null,
        mod,
        defaultExport && isRecord(defaultExport.hooks) ? (defaultExport.hooks as Record<string, unknown>) : null,
        defaultExport,
    ]
    return hookSources.map((source) => getHookCandidate(source, name)).find(Boolean)
}

async function runSmokeTest(code: string): Promise<Omit<DevWorkerResponse, 'id'>> {
    const logs: DevLogEntry[] = []
    const restoreConsole = captureConsole(logs)
    let exportsDetected: string[] = []
    let calledOnContextBuild = false
    let slotsAdded = 0
    let paramsSchema: unknown = undefined

    try {
        const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
        const mod = (await import(dataUrl)) as Record<string, unknown>
        exportsDetected = detectExports(mod)
        const defaultExport = isRecord(mod.default) ? mod.default : null
        const rawConfigSchema = mod.configSchema ?? defaultExport?.configSchema
        paramsSchema = cloneValidatedConfigSchema(rawConfigSchema)

        const meta = (isRecord(mod.meta) ? mod.meta : null)
            ?? (isRecord(mod.default) && isRecord(mod.default.meta) ? mod.default.meta : null)
        const metaName = (meta as { name?: unknown } | undefined)?.name
        const metaDesc = (meta as { description?: unknown } | undefined)?.description
        const nameStr = typeof metaName === 'string' ? metaName.trim() : ''
        const descStr = typeof metaDesc === 'string' ? metaDesc.trim() : ''
        if (!meta || typeof meta !== 'object' || !nameStr) {
            throw new Error('export const meta.name is required')
        }
        if (nameStr.length > 80) {
            throw new Error('meta.name must be <= 80 characters')
        }
        if (!descStr) {
            throw new Error('meta.description is required')
        }
        if (descStr.length > 240) {
            throw new Error('meta.description must be <= 240 characters')
        }

        if (typeof rawConfigSchema !== 'undefined') {
            try {
                const serialized = JSON.stringify(rawConfigSchema)
                if (!serialized) {
                    throw new Error('configSchema must be JSON-serializable')
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                throw new Error(`configSchema must be JSON-serializable: ${msg}`)
            }
            try {
                paramsSchema = cloneValidatedConfigSchema(rawConfigSchema)
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                throw new Error(msg)
            }
        }

        const onContextBuild = resolveHook(mod, 'onContextBuild')

        if (typeof onContextBuild !== 'function') {
            throw new Error('export async function onContextBuild(ctx) is required')
        }

        const mock = createMockCtx()
        const ctx = mock.ctx
        const timeoutMs = 2000
        let timeoutId: ReturnType<typeof setTimeout> | null = null

        await Promise.race([
            Promise.resolve().then(() => {
                calledOnContextBuild = true
                return onContextBuild(ctx)
            }),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`onContextBuild timeout after ${timeoutMs}ms`)), timeoutMs)
            }),
        ])

        if (timeoutId) clearTimeout(timeoutId)

        slotsAdded = mock.getSlotsAdded()
        return {
            ok: true,
            meta: meta as Record<string, unknown>,
            paramsSchema,
            exportsDetected,
            smokeTest: {
                calledOnContextBuild,
                slotsAdded,
            },
            logs,
        }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        return {
            ok: false,
            paramsSchema,
            exportsDetected: exportsDetected.length ? exportsDetected : undefined,
            smokeTest: {
                calledOnContextBuild,
                slotsAdded,
            },
            errors: [{ message: error.message, stack: error.stack }],
            logs,
        }
    } finally {
        restoreConsole()
    }
}

if (!parentPort) {
    throw new Error('dev sandbox worker must be started with a parentPort')
}

parentPort.on('message', async (req: DevWorkerRequest) => {
    const result = await runSmokeTest(req.code)
    const msg: DevWorkerResponse = {
        id: req.id,
        ...result,
    }
    parentPort?.postMessage(msg)
})
