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

        // 1. load memory (best-effort)
        const items = await ctx.memory.query({
            orderBy: 'updatedAt',
            limit: 10,
        })

        const memoryBlocks: string[] = []

        for (const item of items) {
            if (!item.assetId) continue

            try {
                const content = await ctx.memory.readAsset(item.assetId, {
                    maxChars: 3000,
                })

                if (content) {
                    memoryBlocks.push(content)
                }
            } catch {
                continue
            }
        }

        // 2. system (stable)
        ctx.slots.add('system', 'You are a helpful assistant.', {
            priority: 3,
            position: 0,
        })

        // 3. memory (degradable)
        if (memoryBlocks.length > 0) {
            ctx.slots.add(
                'memory',
                'The following is long-term memory from the user:\n\n' +
                memoryBlocks.join('\n\n'),
                {
                    priority: 2,
                    position: 1,
                    trimBehavior: 'char',
                }
            )
        }

        // 4. history
        ctx.slots.add('history', history, {
            priority: 1,
            position: 2,
            trimBehavior: 'message',
        })

        // 5. input
        ctx.slots.add('input', ctx.input, {
            priority: 2,
            position: 3,
        })

        return ctx.slots.render()
    },

    async onTurnEnd(ctx) {
        // best-effort write, NEVER break flow
        try {
            const lastUser = ctx.history.lastUser?.()
            const lastAssistant = ctx.history.lastAssistant?.()

            if (!lastUser || !lastAssistant) return

            // very simple heuristic: skip very short / low-signal content
            const userText = lastUser.content?.trim?.() || ''
            const assistantText = lastAssistant.content?.trim?.() || ''

            if (userText.length < 10 && assistantText.length < 10) return

            const memoryText =
                `User: ${userText}\n` +
                `Assistant: ${assistantText}`

            await ctx.memory.ingest(memoryText, {
                tags: ['conversation'],
                mode: 'raw',   // no chunk / no embedding
                wait: 'load',  // do not block
            })
        } catch {
            // swallow all errors
        }
    },
})