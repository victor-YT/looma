import { memo, useMemo, type ReactElement } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import CodeBlock from './CodeBlock'
import InlineCode from './InlineCode'
import LinkRenderer from './LinkRenderer'
import TableRenderer from './TableRenderer'

export type FadeRange = {
    id: string
    start: number
    end: number
}

type MarkdownRendererProps = {
    content: string
    fadeRanges?: FadeRange[]
    className?: string
}

function toText(children: React.ReactNode): string {
    if (typeof children === 'string') return children
    if (typeof children === 'number') return String(children)
    if (Array.isArray(children)) return children.map(toText).join('')
    return ''
}

function normalizeFenceCode(text: string): string {
    return text.endsWith('\n') ? text.slice(0, -1) : text
}

function languageFromClassName(className?: string): string | null {
    if (!className) return null
    const match = className.match(/language-([\w-]+)/i)
    return match?.[1] ?? null
}

const MarkdownRenderer = memo(function MarkdownRenderer({
    content,
    fadeRanges,
    className,
}: MarkdownRendererProps) {
    const ranges = useMemo(() => {
        if (!fadeRanges?.length) return []
        return fadeRanges
            .filter((range) => range.end > range.start)
            .slice()
            .sort((a, b) => a.start - b.start)
    }, [fadeRanges])

    const components = useMemo<Components>(() => ({
        a: (props) => <LinkRenderer {...props} />,
        p: (props) => <p {...props} className="my-2 leading-6 text-tx" />,
        h1: (props) => <h1 {...props} className="mt-5 mb-3 text-[1.42rem] font-bold tracking-tight text-tx" />,
        h2: (props) => <h2 {...props} className="mt-5 mb-3 text-[1.26rem] font-semibold tracking-tight text-tx" />,
        h3: (props) => <h3 {...props} className="mt-4 mb-2 text-[1.12rem] font-semibold tracking-tight text-tx" />,
        h4: (props) => <h4 {...props} className="mt-4 mb-2 text-[1.02rem] font-semibold tracking-tight text-tx" />,
        h5: (props) => <h5 {...props} className="mt-3 mb-2 text-[0.97rem] font-semibold tracking-tight text-tx" />,
        h6: (props) => <h6 {...props} className="mt-3 mb-2 text-[0.9rem] font-medium tracking-tight text-tx/78" />,
        ul: (props) => <ul {...props} className="my-3 list-disc space-y-1 pl-5 text-tx" />,
        ol: (props) => <ol {...props} className="my-3 list-decimal space-y-1 pl-5 text-tx" />,
        li: (props) => <li {...props} className="leading-6" />,
        img: (props) => (
            <img
                {...props}
                className="my-3 max-w-full rounded-xl"
                loading="lazy"
            />
        ),
        blockquote: (props) => (
            <blockquote
                {...props}
                className="my-4 border-l-3 border-border pl-4 text-tx/75 italic"
            />
        ),
        hr: (props) => <hr {...props} className="my-5 border-0 border-t border-border/80" />,
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children, ...props }) => {
            const text = toText(children)
            const language = languageFromClassName(className)
            const isBlock = Boolean(language) || text.includes('\n')

            if (!isBlock) {
                return (
                    <InlineCode className={className} {...props}>
                        {children}
                    </InlineCode>
                )
            }

            return (
                <CodeBlock
                    code={normalizeFenceCode(text)}
                    language={language}
                />
            )
        },
        table: (props) => <TableRenderer {...props} />,
        thead: (props) => <thead {...props} className="bg-white/[0.03]" />,
        tbody: (props) => <tbody {...props} />,
        tr: (props) => <tr {...props} className="border-t border-border/70" />,
        th: (props) => <th {...props} className="px-3 py-2 text-[14px] font-semibold text-tx" />,
        td: (props) => <td {...props} className="px-3 py-2 align-top text-[14px] text-tx/85" />,
        text: ({ children, node }) => {
            const value = String(children ?? '')
            const startOffset = node?.position?.start?.offset
            const endOffset = node?.position?.end?.offset

            if (typeof startOffset !== 'number' || typeof endOffset !== 'number' || !ranges.length) {
                return value
            }
            if (endOffset <= startOffset) return value

            let cursor = 0
            const parts: Array<string | ReactElement> = []

            for (const range of ranges) {
                if (range.end <= startOffset || range.start >= endOffset) continue

                const overlapStart = Math.max(range.start, startOffset)
                const overlapEnd = Math.min(range.end, endOffset)
                const relStart = overlapStart - startOffset
                const relEnd = overlapEnd - startOffset

                if (relStart > cursor) {
                    parts.push(value.slice(cursor, relStart))
                }
                if (relEnd > relStart) {
                    parts.push(
                        <span
                            key={`${range.id}-${overlapStart}`}
                            className="afferlab-stream-reveal"
                            data-reveal="1"
                        >
                            {value.slice(relStart, relEnd)}
                        </span>,
                    )
                }
                cursor = Math.max(cursor, relEnd)
            }

            if (cursor < value.length) {
                parts.push(value.slice(cursor))
            }

            return <>{parts}</>
        },
    }), [ranges])

    return (
        <div className={className ?? 'min-w-0 text-[14px] font-[550] leading-6 text-tx'}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {content}
            </ReactMarkdown>
        </div>
    )
})

export default MarkdownRenderer
