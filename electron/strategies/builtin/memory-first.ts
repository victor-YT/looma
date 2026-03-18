import { defineStrategy } from '../../../contracts'

export const configSchema = []

export default defineStrategy({
    meta: {
        name: 'Cloud',
        description: 'Persistent memory-enabled assistant',
        version: '0.1.0',
        features: { memoryCloud: true },
    },

    configSchema,

    async onContextBuild(ctx) {
        const history = ctx.history.recent(10)

        // 1. load memory (no embedding / no search)
        const items = await ctx.memory.query({
            orderBy: 'updatedAt',
            limit: 10,
        })

        const memoryBlocks: string[] = []

        for (const item of items) {
            if (!item.assetId) continue

            const content = await ctx.memory.readAsset(item.assetId, {
                maxChars: 3000,
            })

            if (content) {
                memoryBlocks.push(content)
            }
        }

        // 2. build memory section
        let memorySection = ''

        if (memoryBlocks.length > 0) {
            memorySection =
                'The following is long-term memory from the user:\n\n' +
                memoryBlocks.join('\n\n')
        }

        // 3. system prompt
        const systemPrompt = memorySection
            ? `You are a helpful assistant.\n\n${memorySection}`
            : 'You are a helpful assistant.'

        ctx.slots.add('system', systemPrompt, {
            priority: 3,
        })

        // 4. history
        ctx.slots.add('history', history, {
            priority: 1,
            trimBehavior: 'message',
        })

        // 5. input
        ctx.slots.add('input', ctx.input, {
            priority: 2,
        })

        return ctx.slots.render()
    },
})