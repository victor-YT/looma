import type { LoomaContext, StrategyContextBuildResult } from '../../../contracts/index'

export const meta = {
    name: 'Cloud',
    description: 'Memory Cloud test strategy',
    version: '0.2.5',
    features: { memoryCloud: true },
}

export const configSchema = []

export async function onContextBuild(ctx: LoomaContext): Promise<StrategyContextBuildResult> {
    const text = (ctx.input.text || '').trim()
    const history = ctx.history.recent(10) || []

    const items = await ctx.memory.query({
        tags: ['pinned'],
        orderBy: 'updatedAt',
        order: 'desc',
        limit: 200,
    })

    const blocks: string[] = []

    for (const item of items) {
        if (!item.assetId) continue
        try {
            const content = await ctx.memory.readAsset(item.assetId, { maxChars: 20000 })
            if (content) {
                blocks.push(`### ${item.title || item.type}\n${content}`)
            }
        } catch {
            // ignore read errors
        }
    }

    ctx.slots.add(
        'system',
        { role: 'system', content: 'You are a helpful assistant.' },
        { priority: 10, position: 0 }
    )

    if (blocks.length) {
        ctx.slots.add(
            'memoryCloud',
            {
                role: 'system',
                content: `Memory Cloud Assets:\n\n${blocks.join('\n\n')}`,
            },
            { priority: 6, position: 8, trimBehavior: 'char' }
        )
    }

    if (history.length) {
        ctx.slots.add('history', history, {
            priority: 1,
            position: 10,
            trimBehavior: 'message',
        })
    }

    ctx.slots.add(
        'input',
        { role: 'user', content: text || '(Empty input)' },
        { priority: 5, position: 20 }
    )

    return { prompt: ctx.slots.render(), tools: [] }
}
