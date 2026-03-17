import type { Database } from 'better-sqlite3'
import crypto from 'node:crypto'
import { ingestDocument, searchChunks, deleteAsset } from '../memoryStore'
import { DEFAULT_STRATEGY_ID, DEFAULT_STRATEGY_KEY, DEFAULT_STRATEGY_VERSION } from '../../strategy/strategyScope'

function createConversation(db: Database, id: string, title: string): void {
    const now = Date.now()
    db.prepare(`
        INSERT INTO conversations (
            id, title, created_at, updated_at, model, strategy_id, strategy_key, strategy_version
        )
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(id, title, now, now, DEFAULT_STRATEGY_ID, DEFAULT_STRATEGY_KEY, DEFAULT_STRATEGY_VERSION)
}

export async function runMemorySmoke(db: Database): Promise<void> {
    process.env.MEMORY_SMOKE_DEBUG = '1'
    const suffixA = crypto.randomUUID().slice(0, 8)
    const suffixB = crypto.randomUUID().slice(0, 8)
    const convA = `conv_smoke_a_${suffixA}`
    const convB = `conv_smoke_b_${suffixB}`
    createConversation(db, convA, `Smoke A ${suffixA}`)
    createConversation(db, convB, `Smoke B ${suffixB}`)

    const textA = `alpha_${suffixA}`
    const textB = `beta_${suffixB}`

    const ingestA = await ingestDocument(db, {
        conversationId: convA,
        filename: 'smoke-a.txt',
        text: textA,
        options: { wait: 'full' },
    })
    if (ingestA.status !== 'completed') {
        throw new Error(`[memorySmoke] ingest A failed: ${ingestA.error ?? 'unknown'}`)
    }

    const ingestB = await ingestDocument(db, {
        conversationId: convB,
        filename: 'smoke-b.txt',
        text: textB,
        options: { wait: 'full' },
    })
    if (ingestB.status !== 'completed') {
        throw new Error(`[memorySmoke] ingest B failed: ${ingestB.error ?? 'unknown'}`)
    }

    const hitsA = await searchChunks(db, {
        conversationId: convA,
        request: { query: textA, topK: 4 },
    })
    if (hitsA.chunks.length === 0) {
        throw new Error('[memorySmoke] expected hits in conversation A')
    }

    const hitsB = await searchChunks(db, {
        conversationId: convB,
        request: { query: textA, topK: 4 },
    })
    if (hitsB.chunks.length !== 0) {
        console.error('[memorySmoke] cross-conversation hits', hitsB)
        throw new Error('[memorySmoke] expected zero cross-conversation hits')
    }

    deleteAsset(db, { conversationId: convA, assetId: ingestA.assetId })

    const hitsAfterDelete = await searchChunks(db, {
        conversationId: convA,
        request: { query: textA, topK: 4 },
    })
    if (hitsAfterDelete.chunks.length !== 0) {
        throw new Error('[memorySmoke] expected zero hits after deleteAsset')
    }
}
