import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { StrategyModule } from '../../../contracts'
import { cloneValidatedConfigSchema } from '../../core/strategy/configSchema'

const HOOK_NAMES = [
    'onContextBuild',
    'onInit',
    'onTurnEnd',
    'onCloudAdd',
    'onCloudRemove',
    'onReplayTurn',
    'onError',
    'onCleanup',
    'onToolCall',
] as const

type HookName = typeof HOOK_NAMES[number]
type HookMap = Partial<Record<HookName, StrategyModule['hooks'][HookName]>>

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object')
}

function collectExportKeys(mod: Record<string, unknown>): { moduleKeys: string[]; defaultKeys: string[] } {
    const moduleKeys = Object.keys(mod)
    const defaultExport = isRecord(mod.default) ? mod.default : {}
    const defaultKeys = Object.keys(defaultExport)
    return { moduleKeys, defaultKeys }
}

function getHookCandidate(source: Record<string, unknown> | null, name: HookName): StrategyModule['hooks'][HookName] | undefined {
    if (!source) return undefined
    const value = source[name]
    return typeof value === 'function' ? (value as StrategyModule['hooks'][HookName]) : undefined
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

function normalizeStrategyModule(mod: Record<string, unknown>, entryPath: string): StrategyModule {
    const defaultExport = isRecord(mod.default) ? mod.default : null
    const meta = (isRecord(mod.meta) ? mod.meta : null)
        ?? (defaultExport && isRecord(defaultExport.meta) ? defaultExport.meta : null)
    const rawConfigSchema =
        (mod.configSchema as unknown)
        ?? (defaultExport?.configSchema as unknown)
    const configSchema = rawConfigSchema == null
        ? undefined
        : cloneValidatedConfigSchema(rawConfigSchema)

    const hookSources: Array<Record<string, unknown> | null> = [
        isRecord(mod.hooks) ? (mod.hooks as Record<string, unknown>) : null,
        mod,
        defaultExport && isRecord(defaultExport.hooks) ? (defaultExport.hooks as Record<string, unknown>) : null,
        defaultExport,
    ]

    const hooks: HookMap = {}
    for (const name of HOOK_NAMES) {
        const resolved = hookSources.map((source) => getHookCandidate(source, name)).find(Boolean)
        if (resolved) {
            hooks[name] = resolved
        }
    }

    if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) {
        throw new Error(`[strategy-loader] invalid meta.name for ${entryPath}`)
    }
    if (typeof hooks.onContextBuild !== 'function') {
        const keys = collectExportKeys(mod)
        const exportsDetected = detectExports(mod)
        const details = [
            `moduleKeys=[${keys.moduleKeys.join(', ')}]`,
            `defaultKeys=[${keys.defaultKeys.join(', ')}]`,
            exportsDetected.length ? `detected=[${exportsDetected.join(', ')}]` : 'detected=[]',
        ].join(' ')
        throw new Error(`[strategy-loader] missing onContextBuild for ${entryPath}: ${details}`)
    }

    return {
        meta: meta as StrategyModule['meta'],
        configSchema: configSchema as any,
        hooks: hooks as StrategyModule['hooks'],
    }
}

function resolveEntryPath(entryPath: string): string {
    const appRoot = process.env.APP_ROOT ?? process.cwd()
    const candidates: string[] = []

    if (entryPath.startsWith('builtin:')) {
        const name = entryPath.split(':')[1] ?? entryPath
        candidates.push(path.join(appRoot, 'dist-electron', 'strategies', 'builtin', `${name}.js`))
        candidates.push(path.join(appRoot, 'electron', 'strategies', 'builtin', `${name}.ts`))
    }

    if (path.isAbsolute(entryPath)) {
        candidates.push(entryPath)
    } else {
        candidates.push(path.join(appRoot, entryPath))
        candidates.push(path.join(appRoot, 'dist-electron', entryPath))
    }

    if (entryPath.endsWith('.js')) {
        const tsPath = entryPath.replace(/\.js$/, '.ts')
        candidates.push(path.join(appRoot, tsPath))
        candidates.push(path.join(appRoot, 'electron', tsPath))
    }

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate
    }

    throw new Error(`[strategy-loader] entry_path not found: ${entryPath}`)
}

export async function loadStrategyModule(entryPath: string): Promise<StrategyModule> {
    if (!entryPath || typeof entryPath !== 'string') {
        throw new Error('[strategy-loader] entry_path missing')
    }
    const resolved = resolveEntryPath(entryPath)
    try {
        const mod = await import(pathToFileURL(resolved).href) as Record<string, unknown>
        return normalizeStrategyModule(mod, entryPath)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`[strategy-loader] failed to load ${entryPath}: ${msg}`)
    }
}
