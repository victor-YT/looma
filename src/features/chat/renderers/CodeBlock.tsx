import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import clsx from 'clsx'
import { bundledLanguages, getSingletonHighlighter } from 'shiki'
import { useThemeStore } from '@/features/settings/general/state/themeStore'

const SHIKI_LIGHT_THEME = 'min-light'
const SHIKI_DARK_THEME = 'min-dark'
const FALLBACK_LANGUAGE = 'text'
const PRELOADED_LANGUAGES = [
    'text',
    'plaintext',
    'bash',
    'shell',
    'sh',
    'zsh',
    'json',
    'javascript',
    'typescript',
    'jsx',
    'tsx',
    'python',
    'markdown',
    'html',
    'css',
    'yaml',
    'sql',
    'go',
    'rust',
] as const

let highlighterPromise: Promise<Awaited<ReturnType<typeof getSingletonHighlighter>>> | null = null

function getCodeHighlighter() {
    if (!highlighterPromise) {
        highlighterPromise = getSingletonHighlighter({
            themes: [SHIKI_LIGHT_THEME, SHIKI_DARK_THEME],
            langs: [...PRELOADED_LANGUAGES],
        })
    }
    return highlighterPromise
}

function normalizeLanguage(input?: string | null): string {
    const value = (input ?? '').trim().toLowerCase()
    if (!value) return FALLBACK_LANGUAGE
    if (value === 'shell') return 'bash'
    if (value === 'plaintext') return 'text'
    return value
}

function formatLanguageLabel(language: string): string {
    if (!language) return ''
    return language.charAt(0).toUpperCase() + language.slice(1)
}

async function renderHighlightedHtml(
    code: string,
    language: string | null | undefined,
    theme: 'light' | 'dark',
): Promise<string> {
    const highlighter = await getCodeHighlighter()
    const normalized = normalizeLanguage(language)
    const resolved = highlighter.resolveLangAlias(normalized) ?? normalized

    if (!highlighter.getLanguage(resolved)) {
        const bundled = bundledLanguages[resolved as keyof typeof bundledLanguages]
        if (bundled) {
            try {
                await highlighter.loadLanguage(bundled)
            } catch {
                // Fall through to plain text rendering below.
            }
        }
    }

    const finalLanguage = highlighter.getLanguage(resolved) ? resolved : FALLBACK_LANGUAGE
    return highlighter.codeToHtml(code, {
        lang: finalLanguage,
        theme: theme === 'dark' ? SHIKI_DARK_THEME : SHIKI_LIGHT_THEME,
    })
}

type CodeBlockProps = {
    code: string
    language?: string | null
    closed?: boolean
    className?: string
}

const CodeBlock = memo(function CodeBlock({
    code,
    language,
    closed = true,
    className,
}: CodeBlockProps) {
    const themePreference = useThemeStore((state) => state.theme)
    const [copied, setCopied] = useState(false)
    const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null)
    const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
        if (typeof window === 'undefined') return 'light'
        if (themePreference === 'system') {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        }
        return themePreference
    })
    const timeoutRef = useRef<number | null>(null)

    const normalizedLanguage = useMemo(
        () => normalizeLanguage(language),
        [language],
    )
    const languageLabel = useMemo(
        () => formatLanguageLabel(normalizedLanguage),
        [normalizedLanguage],
    )

    useEffect(() => {
        if (themePreference !== 'system') {
            setResolvedTheme(themePreference)
            return
        }

        const media = window.matchMedia('(prefers-color-scheme: dark)')
        const apply = () => {
            setResolvedTheme(media.matches ? 'dark' : 'light')
        }

        apply()
        media.addEventListener('change', apply)
        return () => {
            media.removeEventListener('change', apply)
        }
    }, [themePreference])

    useEffect(() => {
        let cancelled = false

        if (!closed) {
            setHighlightedHtml(null)
            return () => {
                cancelled = true
            }
        }

        void renderHighlightedHtml(code, normalizedLanguage, resolvedTheme)
            .then((html) => {
                if (cancelled) return
                setHighlightedHtml(html)
            })
            .catch(() => {
                if (cancelled) return
                setHighlightedHtml(null)
            })

        return () => {
            cancelled = true
        }
    }, [closed, code, normalizedLanguage, resolvedTheme])

    useEffect(() => {
        return () => {
            if (timeoutRef.current != null) {
                window.clearTimeout(timeoutRef.current)
            }
        }
    }, [])

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
            if (timeoutRef.current != null) {
                window.clearTimeout(timeoutRef.current)
            }
            timeoutRef.current = window.setTimeout(() => {
                setCopied(false)
                timeoutRef.current = null
            }, 2000)
        } catch {
            setCopied(false)
        }
    }

    return (
        <div
            className={clsx(
                'afferlab-code-block my-3 overflow-hidden rounded-xl border border-[#dfdfe3] bg-[#f5f5f7] text-[#2c2c2e]',
                'dark:border-[#2c2c2e] dark:bg-[#1c1c1e] dark:text-[#f2f2f7]',
                className,
            )}
        >
            <div className="flex items-center justify-between gap-3 border-b border-[#dfdfe3] bg-[#ececf1] px-3 py-1.5 dark:border-[#2c2c2e] dark:bg-[#232326]">
                <span className="truncate text-[12px] font-semibold text-[#6e6e73] dark:text-[#a1a1a6]">
                    {languageLabel}
                </span>

                <button
                    type="button"
                    onClick={handleCopy}
                    className={clsx(
                        'ui-fast inline-flex items-center gap-1.5 rounded-md px-2 py-1',
                        'cursor-pointer text-xs font-semibold text-[#636366] transition-colors',
                        'hover:text-[#1d1d1f] focus:outline-none focus:ring-0 focus-visible:outline-none',
                        'dark:text-[#b0b0b5] dark:hover:text-[#f2f2f7]',
                    )}
                    aria-label={copied ? 'Code copied' : 'Copy code'}
                    title={copied ? 'Copied' : 'Copy'}
                >
                    {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.9} />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
            </div>

            <div className="overflow-x-auto px-4 py-3">
                {highlightedHtml && closed ? (
                    <div
                        className={clsx(
                            'text-[13px] leading-[1.45]',
                            '[&_.shiki]:!bg-transparent [&_.shiki]:m-0 [&_.shiki]:p-0',
                            '[&_.shiki]:text-[13px] [&_.shiki]:leading-[1.45]',
                            '[&_.shiki_code]:font-mono [&_.shiki_code]:whitespace-pre',
                        )}
                        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                    />
                ) : (
                    <pre className="m-0 overflow-x-auto bg-transparent p-0 font-mono text-[13px] leading-[1.45] text-[#2c2c2e] dark:text-[#f2f2f7]">
                        <code>{code}</code>
                    </pre>
                )}
            </div>
        </div>
    )
})

export default CodeBlock
