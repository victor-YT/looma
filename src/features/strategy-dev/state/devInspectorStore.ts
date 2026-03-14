import { create } from "zustand"
import type { Message, StrategyDevEvent } from "@contracts"

export type DevTokenBreakdownItem = {
    name: string
    tokens: number
}

export type DevTokenBreakdown = {
    totalUsed: number
    maxTokens: number
    items: DevTokenBreakdownItem[]
}

export type DevTurnData = {
    conversationId: string
    strategyId: string
    turnId: string
    lastTs: number
    status: "running" | "done" | "error"
    startedAt?: number
    endedAt?: number
    stopReason?: string
    inputEvent?: Extract<StrategyDevEvent, { type: "context" }>
    promptEvent?: Extract<StrategyDevEvent, { type: "prompt" }>
    slotsEvent?: Extract<StrategyDevEvent, { type: "slots" }>
    budgetEvent?: Extract<StrategyDevEvent, { type: "budget" }>
    statusEvents: Extract<StrategyDevEvent, { type: "status" }>[]
    turnEvents: Extract<StrategyDevEvent, { type: "turn" }>[]
    errors: Extract<StrategyDevEvent, { type: "error" }>[]
    logs: Extract<StrategyDevEvent, { type: "console" }>[]
    tools: Extract<StrategyDevEvent, { type: "tools" }>[]
    memory: Extract<StrategyDevEvent, { type: "memory" }>[]
    usage?: {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
    }
    tokenBreakdown?: DevTokenBreakdown
}

type DevInspectorState = {
    eventsByConversation: Record<string, StrategyDevEvent[]>
    turnsByConversation: Record<string, Record<string, DevTurnData>>
    latestTurnByConversation: Record<string, DevTurnData | null>
    addEvent: (event: StrategyDevEvent) => void
    clearConversation: (conversationId: string) => void
}

const MAX_EVENTS = 500
const MAX_TURNS = 30
const FLUSH_MS = 80
const pendingEvents: StrategyDevEvent[] = []
let flushTimer: number | null = null

function estimateTokens(text: string): number {
    let latin = 0
    let cjk = 0
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0
        if (
            (code >= 0x4e00 && code <= 0x9fff) ||
            (code >= 0x3400 && code <= 0x4dbf) ||
            (code >= 0xf900 && code <= 0xfaff)
        ) {
            cjk += 1
        } else {
            latin += 1
        }
    }
    const estimate = Math.ceil(latin * 0.75 + cjk * 1.6)
    return Math.ceil(estimate * 1.1)
}

function estimateMessageTokens(message: Message): number {
    const content = typeof message.content === "string"
        ? message.content
        : message.content
            ? JSON.stringify(message.content)
            : ""
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls
    const extra = toolCalls ? JSON.stringify(toolCalls) : ""
    return estimateTokens(`${content}${extra}`)
}

function buildTokenBreakdown(turn: DevTurnData): DevTokenBreakdown | undefined {
    const slots = turn.slotsEvent?.data?.entries ?? []
    if (slots.length === 0) return undefined

    const items = slots.map((slot) => {
        const tokens = slot.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
        return { name: slot.name, tokens }
    })

    const estimatedTotal = items.reduce((sum, item) => sum + item.tokens, 0)
    const budgetMax = turn.budgetEvent?.data?.maxTokens ?? turn.inputEvent?.data?.budget?.maxInputTokens ?? 0
    const usageTotal =
        turn.usage?.inputTokens
        ?? turn.budgetEvent?.data?.totalTokens
        ?? (estimatedTotal > 0 ? estimatedTotal : 0)

    const maxTokens = typeof budgetMax === "number" && budgetMax > 0 ? budgetMax : usageTotal
    if (usageTotal > 0 && estimatedTotal > 0 && usageTotal !== estimatedTotal) {
        const scale = usageTotal / estimatedTotal
        const scaled = items.map((item) => ({
            name: item.name,
            tokens: Math.max(1, Math.round(item.tokens * scale)),
        }))
        return { totalUsed: usageTotal, maxTokens, items: scaled }
    }
    return { totalUsed: usageTotal, maxTokens, items }
}

function getEventTs(event: StrategyDevEvent): number {
    return event.ts ?? event.timestamp ?? Date.now()
}

function applyEvent(turn: DevTurnData, event: StrategyDevEvent): DevTurnData {
    const next: DevTurnData = {
        ...turn,
        lastTs: Math.max(turn.lastTs, getEventTs(event)),
    }

    switch (event.type) {
        case "turn":
            next.turnEvents = [...next.turnEvents, event]
            if (event.data.status === "start") {
                next.status = "running"
                next.startedAt = getEventTs(event)
            } else if (event.data.status === "done") {
                next.status = "done"
                next.endedAt = getEventTs(event)
                next.stopReason = event.data.reason ?? next.stopReason
            } else if (event.data.status === "error") {
                next.status = "error"
                next.endedAt = getEventTs(event)
                next.stopReason = event.data.reason ?? next.stopReason
            }
            break
        case "context":
            next.inputEvent = event
            break
        case "prompt":
            next.promptEvent = event
            break
        case "slots":
            next.slotsEvent = event
            break
        case "budget":
            next.budgetEvent = event
            break
        case "status":
            next.statusEvents = [...next.statusEvents, event]
            break
        case "console":
            next.logs = [...next.logs, event]
            break
        case "tools":
            next.tools = [...next.tools, event]
            if (event.data?.action === "llm.result") {
                const usage = (event.data?.output as { usage?: { prompt?: number; completion?: number; total?: number } } | undefined)?.usage
                if (usage) {
                    next.usage = {
                        inputTokens: usage.prompt ?? next.usage?.inputTokens,
                        outputTokens: usage.completion ?? next.usage?.outputTokens,
                        totalTokens: usage.total ?? next.usage?.totalTokens,
                    }
                }
            }
            break
        case "memory":
            next.memory = [...next.memory, event]
            break
        case "error":
            next.errors = [...next.errors, event]
            next.status = "error"
            break
        default:
            break
    }

    next.tokenBreakdown = buildTokenBreakdown(next)
    return next
}

function ensureTurnSeed(event: StrategyDevEvent): DevTurnData {
    return {
        conversationId: event.conversationId,
        strategyId: event.strategyId,
        turnId: event.turnId ?? "unknown",
        lastTs: getEventTs(event),
        status: "running",
        statusEvents: [],
        turnEvents: [],
        errors: [],
        logs: [],
        tools: [],
        memory: [],
    }
}

function applyEvents(state: DevInspectorState, events: StrategyDevEvent[]): DevInspectorState {
    if (events.length === 0) return state
    let eventsByConversation = state.eventsByConversation
    let turnsByConversation = state.turnsByConversation
    let latestTurnByConversation = state.latestTurnByConversation

    for (const event of events) {
        const convId = event.conversationId
        const turnId = event.turnId ?? "unknown"

        const existingEvents = eventsByConversation[convId] ?? []
        const nextEvents = [...existingEvents, event]
        eventsByConversation = eventsByConversation === state.eventsByConversation
            ? { ...eventsByConversation, [convId]: nextEvents.slice(-MAX_EVENTS) }
            : { ...eventsByConversation, [convId]: nextEvents.slice(-MAX_EVENTS) }

        const existingTurns = turnsByConversation[convId] ?? {}
        const convTurns = existingTurns === state.turnsByConversation[convId]
            ? { ...existingTurns }
            : { ...existingTurns }
        const prevTurn = convTurns[turnId] ?? ensureTurnSeed(event)
        const nextTurn = applyEvent(prevTurn, event)
        convTurns[turnId] = nextTurn

        const turnEntries = Object.values(convTurns)
        if (turnEntries.length > MAX_TURNS) {
            turnEntries.sort((a, b) => a.lastTs - b.lastTs)
            const toRemove = turnEntries.slice(0, turnEntries.length - MAX_TURNS)
            for (const entry of toRemove) {
                delete convTurns[entry.turnId]
            }
        }

        turnsByConversation = turnsByConversation === state.turnsByConversation
            ? { ...turnsByConversation, [convId]: convTurns }
            : { ...turnsByConversation, [convId]: convTurns }

        const currentLatest = latestTurnByConversation[convId]
        const nextLatest = !currentLatest || nextTurn.lastTs >= currentLatest.lastTs
            ? nextTurn
            : currentLatest
        latestTurnByConversation = latestTurnByConversation === state.latestTurnByConversation
            ? { ...latestTurnByConversation, [convId]: nextLatest }
            : { ...latestTurnByConversation, [convId]: nextLatest }
    }

    return {
        ...state,
        eventsByConversation,
        turnsByConversation,
        latestTurnByConversation,
    }
}

function scheduleFlush(set: (fn: (state: DevInspectorState) => DevInspectorState) => void) {
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(() => {
        flushTimer = null
        const batch = pendingEvents.splice(0, pendingEvents.length)
        if (batch.length === 0) return
        set((state) => applyEvents(state, batch))
    }, FLUSH_MS)
}

export const useDevInspectorStore = create<DevInspectorState>((set) => ({
    eventsByConversation: {},
    turnsByConversation: {},
    latestTurnByConversation: {},
    addEvent: (event) => {
        pendingEvents.push(event)
        scheduleFlush(set)
    },
    clearConversation: (conversationId) =>
        set((state) => {
            const nextEvents = { ...state.eventsByConversation }
            const nextTurns = { ...state.turnsByConversation }
            const nextLatest = { ...state.latestTurnByConversation }
            delete nextEvents[conversationId]
            delete nextTurns[conversationId]
            delete nextLatest[conversationId]
            return {
                ...state,
                eventsByConversation: nextEvents,
                turnsByConversation: nextTurns,
                latestTurnByConversation: nextLatest,
            }
        }),
}))
