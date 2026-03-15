import type { Attachment, Input as StrategyInput, LoomaContext, Message, MessageContentPart, SlotsAddOptions } from '../../../../contracts'
import { messageTextFromParts, parseMessageContentParts } from '../../../../shared/chat/contentParts'
import { estimateTokens, estimateTokensForMessages } from '../../../core/tokens/tokenizer'

type SlotMessage = Message & {
    parts?: MessageContentPart[]
}

type SlotEntry = {
    name: string
    messages: SlotMessage[]
    options?: SlotsAddOptions
    index: number
}

type SlotsDebugEntry = {
    name: string
    messages: SlotMessage[]
    options?: SlotsAddOptions
}

type SlotsApiConfig = {
    tokenBudget?: number
    estimateMessages?: (messages: Message[]) => number
    onUpdate?: (entries: SlotsDebugEntry[]) => void
}

type WorkingSlot = SlotEntry & {
    tokenCount: number
}

type SlotConstraints = {
    priority: number
    minTarget: number
    maxTarget: number | null
}

function normalizeMessages(messages: SlotMessage[], role?: Message['role']): SlotMessage[] {
    return messages.map((msg) => {
        if (!role) return msg
        return { ...msg, role }
    })
}

function toAttachmentPart(attachment: Attachment): MessageContentPart {
    return {
        type: attachment.modality === 'image' ? 'image' : 'file',
        assetId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        size: attachment.size,
    }
}

function attachmentHintText(attachment: Attachment): string {
    return `File: ${attachment.name}`
}

function buildMessageParts(text: string | null | undefined, attachments: Attachment[] | undefined): MessageContentPart[] {
    const parts: MessageContentPart[] = []
    if (typeof text === 'string' && text.trim().length > 0) {
        parts.push({ type: 'text', text })
    }
    for (const attachment of attachments ?? []) {
        parts.push({ type: 'text', text: attachmentHintText(attachment) })
        parts.push(toAttachmentPart(attachment))
    }
    return parts
}

function isStrategyInput(value: unknown): value is StrategyInput {
    return Boolean(
        value
        && typeof value === 'object'
        && typeof (value as { text?: unknown }).text === 'string'
        && Array.isArray((value as { attachments?: unknown }).attachments)
    )
}

function toInputMessage(name: string, input: StrategyInput, role?: Message['role']): SlotMessage {
    const resolvedRole = role ?? (name === 'system' ? 'system' : 'user')
    const parts = buildMessageParts(input.text, input.attachments)

    return {
        role: resolvedRole,
        content: input.text,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        ...(parts.length > 0 ? { parts } : {}),
    }
}

function normalizeMessage(message: SlotMessage): SlotMessage {
    if (Array.isArray(message.parts) && message.parts.length > 0) {
        return {
            ...message,
            parts: parseMessageContentParts(message.parts, message.content ?? ''),
        }
    }
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) return message
    const parts = buildMessageParts(message.content, message.attachments)
    return {
        ...message,
        content: message.content ?? null,
        parts,
    }
}

function normalizeSlotContent(name: string, content: string | StrategyInput | Message | Message[] | null, role?: Message['role']): SlotMessage[] {
    if (content == null) return []
    if (isStrategyInput(content)) {
        return [toInputMessage(name, content, role)]
    }
    if (typeof content === 'string') {
        const resolvedRole = role ?? (name === 'system' ? 'system' : 'user')
        return [{ role: resolvedRole, content }]
    }
    const list = (Array.isArray(content) ? content : [content]) as SlotMessage[]
    return normalizeMessages(list, role).map(normalizeMessage)
}

function cloneMessages(messages: SlotMessage[]): SlotMessage[] {
    return messages.map((message) => ({
        ...message,
        parts: Array.isArray(message.parts) ? parseMessageContentParts(message.parts, message.content ?? '') : message.parts,
    }))
}

function extractParts(message: SlotMessage) {
    const parts = parseMessageContentParts(message.parts, message.content ?? '')
    return parts
}

function isSystemSlot(slot: SlotEntry): boolean {
    return slot.messages.length > 0 && slot.messages.every((message) => message.role === 'system')
}

function sortSlotsForRender(a: SlotEntry, b: SlotEntry): number {
    const ap = a.options?.position ?? Number.POSITIVE_INFINITY
    const bp = b.options?.position ?? Number.POSITIVE_INFINITY
    if (ap !== bp) return ap - bp
    return a.index - b.index
}

function clampRatio(value: number | undefined): number | undefined {
    if (!Number.isFinite(value)) return undefined
    return Math.min(1, Math.max(0, value as number))
}

function normalizeSlotsOptions(options?: SlotsAddOptions): SlotsAddOptions | undefined {
    if (!options) return undefined
    const priority = Number.isFinite(options.priority) ? options.priority : undefined
    const maxRatio = clampRatio(options.maxRatio)
    const rawMinRatio = clampRatio(options.minRatio)
    const minRatio = typeof rawMinRatio === 'number' && typeof maxRatio === 'number'
        ? Math.min(rawMinRatio, maxRatio)
        : rawMinRatio
    const minTokens = Number.isFinite(options.minTokens)
        ? Math.max(0, Math.floor(options.minTokens as number))
        : undefined
    const position = Number.isFinite(options.position) ? options.position : undefined
    return {
        ...options,
        priority,
        maxRatio,
        minRatio,
        minTokens,
        position,
    }
}

function withTokenCount(slot: SlotEntry, estimateMessagesFn: (messages: Message[]) => number): WorkingSlot {
    return {
        ...slot,
        messages: cloneMessages(slot.messages),
        tokenCount: estimateMessagesFn(slot.messages),
    }
}

function refreshTokenCount(slot: WorkingSlot, estimateMessagesFn: (messages: Message[]) => number): void {
    slot.tokenCount = estimateMessagesFn(slot.messages)
}

function trimTextToTokenTarget(text: string, targetTokens: number): string {
    if (!text || targetTokens <= 0) return ''
    if (estimateTokens(text) <= targetTokens) return text
    let low = 0
    let high = text.length
    let best = text
    while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const candidate = text.slice(mid).trimStart()
        const tokens = estimateTokens(candidate)
        if (tokens <= targetTokens) {
            best = candidate
            high = mid - 1
        } else {
            low = mid + 1
        }
    }
    return best
}

function updateMessageFromParts(message: SlotMessage, parts: ReturnType<typeof parseMessageContentParts>): SlotMessage {
    return {
        ...message,
        content: messageTextFromParts(parts, message.content),
        parts,
    }
}

function trimMessageAttachments(message: SlotMessage): SlotMessage | null {
    const parts = extractParts(message)
    if (!parts.some((part) => part.type === 'file' || part.type === 'image')) return message
    const textOnly = parts.filter((part) => part.type === 'text')
    if (textOnly.length === 0 && !(message.content ?? '').trim()) return null
    return updateMessageFromParts(message, textOnly)
}

function trimMessageText(message: SlotMessage, targetTokens: number): SlotMessage {
    const parts = extractParts(message)
    const textParts = parts.filter((part) => part.type === 'text')
    const nonTextParts = parts.filter((part) => part.type !== 'text')
    const text = textParts.length > 0
        ? messageTextFromParts(textParts, message.content)
        : (message.content ?? '')
    const trimmedText = trimTextToTokenTarget(text, targetTokens)
    const nextParts = [
        ...(trimmedText ? [{ type: 'text', text: trimmedText } as const] : []),
        ...nonTextParts,
    ]
    return {
        ...message,
        content: trimmedText,
        parts: nextParts,
    }
}

function trimSlotMessagesToBudget(args: {
    slot: WorkingSlot
    targetTokens: number
    estimateMessagesFn: (messages: Message[]) => number
}): void {
    const minimumTokens = Math.max(0, args.slot.options?.minTokens ?? 0)
    const budgetFloor = Math.max(args.targetTokens, minimumTokens)
    const trimBehavior = args.slot.options?.trimBehavior ?? 'message'
    while (args.slot.messages.length > 0 && args.slot.tokenCount > budgetFloor) {
        if (args.slot.messages.length > 1) {
            args.slot.messages.shift()
            refreshTokenCount(args.slot, args.estimateMessagesFn)
            continue
        }
        if (trimBehavior === 'message') {
            args.slot.messages = []
            refreshTokenCount(args.slot, args.estimateMessagesFn)
            break
        }
        const [lastMessage] = args.slot.messages
        const preservedMessageBudget = Math.max(0, budgetFloor)
        const trimmed = trimMessageText(lastMessage, preservedMessageBudget)
        args.slot.messages = [trimmed]
        refreshTokenCount(args.slot, args.estimateMessagesFn)
        break
    }
}

function finalizeMessages(slots: WorkingSlot[]): Message[] {
    return slots
        .filter((slot) => slot.messages.length > 0)
        .sort(sortSlotsForRender)
        .flatMap((slot) => slot.messages)
}

export function enforcePromptTokenBudget(args: {
    messages: Message[]
    budget: number
    estimateMessages?: (messages: Message[]) => number
    preserveSystem?: boolean
}): { messages: Message[]; totalTokens: number; trimmed: boolean } {
    const estimateMessagesFn = args.estimateMessages ?? estimateTokensForMessages
    const budget = Math.max(0, Math.floor(args.budget))
    const preserveSystem = args.preserveSystem === true
    const working = cloneMessages(args.messages)
    let totalTokens = estimateMessagesFn(working)
    let trimmed = false
    let latestUserIndex = -1
    for (let i = working.length - 1; i >= 0; i -= 1) {
        if (working[i]?.role === 'user') {
            latestUserIndex = i
            break
        }
    }

    while (totalTokens > budget) {
        const removableIndex = working.findIndex((message, index) => {
            if (index === latestUserIndex) return false
            if (preserveSystem && message.role === 'system') return false
            return true
        })
        if (removableIndex >= 0) {
            working.splice(removableIndex, 1)
            if (latestUserIndex > removableIndex) latestUserIndex -= 1
            totalTokens = estimateMessagesFn(working)
            trimmed = true
            continue
        }

        if (latestUserIndex >= 0) {
            const current = working[latestUserIndex]
            const withoutCurrent = working.filter((_, index) => index !== latestUserIndex)
            const remainingBudget = Math.max(0, budget - estimateMessagesFn(withoutCurrent))
            const trimmedUser = trimMessageAttachments(current) ?? current
            const finalUser = trimMessageText(trimmedUser, remainingBudget)
            if (estimateMessagesFn([finalUser]) >= estimateMessagesFn([current]) && totalTokens > budget) {
                break
            }
            working[latestUserIndex] = finalUser
            totalTokens = estimateMessagesFn(working)
            trimmed = true
            continue
        }

        const systemIndex = preserveSystem ? -1 : working.findIndex((message) => message.role === 'system')
        if (systemIndex >= 0) {
            const current = working[systemIndex]
            const withoutCurrent = working.filter((_, index) => index !== systemIndex)
            const remainingBudget = Math.max(0, budget - estimateMessagesFn(withoutCurrent))
            const trimmedSystem = trimMessageText(current, remainingBudget)
            if (estimateMessagesFn([trimmedSystem]) >= estimateMessagesFn([current]) && totalTokens > budget) {
                break
            }
            working[systemIndex] = trimmedSystem
            totalTokens = estimateMessagesFn(working)
            trimmed = true
            continue
        }

        break
    }

    return {
        messages: working,
        totalTokens,
        trimmed,
    }
}

function hasExplicitPriorities(slots: SlotEntry[]): boolean {
    return slots.some((slot) => (slot.options?.priority ?? 0) !== 0)
}

function getSlotConstraints(slot: WorkingSlot, budget: number): SlotConstraints {
    const priority = slot.options?.priority ?? 0
    const minTokens = Math.max(0, slot.options?.minTokens ?? 0)
    const minRatio = slot.options?.minRatio ?? 0
    const maxRatio = slot.options?.maxRatio
    return {
        priority,
        minTarget: Math.max(minTokens, Math.floor(budget * minRatio)),
        maxTarget: typeof maxRatio === 'number' ? Math.floor(budget * maxRatio) : null,
    }
}

function trimSlotToTarget(args: {
    slot: WorkingSlot
    targetTokens: number
    estimateMessagesFn: (messages: Message[]) => number
}): void {
    if (args.slot.tokenCount <= args.targetTokens) return
    if ((args.slot.options?.trimBehavior ?? 'message') === 'char') {
        trimSlotMessagesToBudget(args)
        return
    }
    trimSlotMessagesToBudget(args)
}

function trimSlotsToBudget(args: {
    ordered: WorkingSlot[]
    budget: number
    estimateMessagesFn: (messages: Message[]) => number
}): void {
    const preserveSystem = !hasExplicitPriorities(args.ordered)
    const constraints = new Map<WorkingSlot, SlotConstraints>(
        args.ordered.map((slot) => [slot, getSlotConstraints(slot, args.budget)])
    )
    const minimumDemand = args.ordered.reduce((sum, slot) => sum + (constraints.get(slot)?.minTarget ?? 0), 0)
    const violatesMaxFloor = args.ordered.some((slot) => {
        const entry = constraints.get(slot)
        return Boolean(entry && entry.maxTarget != null && entry.minTarget > entry.maxTarget)
    })
    const usePriorityFallback = minimumDemand > args.budget || violatesMaxFloor

    if (!usePriorityFallback) {
        for (const slot of args.ordered) {
            const entry = constraints.get(slot)
            if (!entry || entry.maxTarget == null) continue
            const cappedTarget = Math.max(entry.minTarget, entry.maxTarget)
            trimSlotToTarget({
                slot,
                targetTokens: cappedTarget,
                estimateMessagesFn: args.estimateMessagesFn,
            })
        }
    }

    const trimQueue = [...args.ordered]
        .filter((slot) => !preserveSystem || !isSystemSlot(slot))
        .sort((a, b) => {
            const ac = constraints.get(a)?.priority ?? 0
            const bc = constraints.get(b)?.priority ?? 0
            if (ac !== bc) return ac - bc
            const ap = a.options?.position ?? Number.POSITIVE_INFINITY
            const bp = b.options?.position ?? Number.POSITIVE_INFINITY
            if (ap !== bp) return bp - ap
            return b.index - a.index
        })

    let totalTokens = args.ordered.reduce((sum, slot) => sum + slot.tokenCount, 0)
    for (const slot of trimQueue) {
        if (totalTokens <= args.budget) break
        const entry = constraints.get(slot)
        const floorTarget = usePriorityFallback ? 0 : (entry?.minTarget ?? 0)
        const nextTarget = Math.max(floorTarget, slot.tokenCount - (totalTokens - args.budget))
        trimSlotToTarget({
            slot,
            targetTokens: nextTarget,
            estimateMessagesFn: args.estimateMessagesFn,
        })
        totalTokens = args.ordered.reduce((sum, item) => sum + item.tokenCount, 0)
    }
}

export function createSlotsApi(config?: SlotsApiConfig): { add: LoomaContext['slots']['add']; render: LoomaContext['slots']['render'] } {
    const slots: SlotEntry[] = []
    const estimateMessagesFn = config?.estimateMessages ?? estimateTokensForMessages

    return {
        add: (name, content, options) => {
            const normalizedOptions = normalizeSlotsOptions(options)
            const messages = normalizeSlotContent(name, content, normalizedOptions?.role)
            if (messages.length === 0) return
            slots.push({
                name,
                messages,
                options: normalizedOptions,
                index: slots.length,
            })
            config?.onUpdate?.(slots.map((slot) => ({
                name: slot.name,
                messages: slot.messages,
                options: slot.options,
            })))
        },
        render: () => {
            const ordered = [...slots].sort(sortSlotsForRender).map((slot) => withTokenCount(slot, estimateMessagesFn))
            const budget = Math.max(0, Math.floor(config?.tokenBudget ?? Number.POSITIVE_INFINITY))
            if (Number.isFinite(budget)) {
                trimSlotsToBudget({
                    ordered,
                    budget,
                    estimateMessagesFn,
                })
            }

            const finalMessages = finalizeMessages(ordered)
            const preserveSystem = !hasExplicitPriorities(ordered)
            const enforced = Number.isFinite(budget)
                ? enforcePromptTokenBudget({
                    messages: finalMessages,
                    budget,
                    estimateMessages: estimateMessagesFn,
                    preserveSystem,
                })
                : {
                    messages: finalMessages,
                    totalTokens: estimateMessagesFn(finalMessages),
                    trimmed: false,
                }
            return { messages: enforced.messages }
        },
    }
}
