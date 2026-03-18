import clsx from 'clsx'
import { rowToTurn } from '@/features/chat/utils/rowToTurn'
import { applyConversationSnapshot, getLastSnapshot } from '@/features/chat/utils/applyConversationSnapshot'
import Topbar from '@/features/chat/components/Topbar'
import { useEffect, useMemo, useRef, useState } from 'react'
import { chatStore, useChatStore } from '@/features/chat/state/chatStore'
import { useDevInspectorStore } from '@/features/strategy-dev/state/devInspectorStore'
import type {
    ChatItemRow,
    DoneMeta,
    LlmStreamChunkEventData,
    LlmStreamDoneEventData,
    LlmStreamStartedEventData,
    UIMessage,
    StrategyDevEvent,
} from '@contracts'
import type { IpcRendererEvent as ElectronIpcRendererEvent } from 'electron'
import TurnItem from '@/features/chat/components/TurnItem'
import { StreamSmoother } from '@/features/chat/utils/StreamSmoother'
import { buildDraftAttachmentsFromMessage } from '@/features/chat/attachments/utils/editDraftAttachments'
import { touchConversationActivity } from '@/features/chat/utils/touchConversationActivity'

interface ChatAreaProps { className?: string }

// Parse done.meta
function readDoneMeta(meta: unknown): Pick<DoneMeta, 'reason' | 'elapsedMs'> {
    if (!meta || typeof meta !== 'object') return {}
    const m = meta as DoneMeta
    const reason = typeof m.reason === 'string' ? m.reason : undefined
    const elapsedMs = typeof m.elapsedMs === 'number' ? m.elapsedMs : undefined
    return { reason, elapsedMs }
}

function readDoneError(meta: unknown): { code?: string; message?: string; raw?: unknown } {
    if (!meta || typeof meta !== 'object') return {}
    const obj = meta as Record<string, unknown>
    const rawError = obj.error
    if (rawError && typeof rawError === 'object') {
        const rec = rawError as Record<string, unknown>
        const code = typeof rec.code === 'string' ? rec.code : undefined
        const message = typeof rec.message === 'string' ? rec.message : undefined
        return { code, message, raw: rawError }
    }
    const code = typeof obj.errorCode === 'string'
        ? obj.errorCode
        : typeof obj.code === 'string'
            ? obj.code
            : undefined
    const message = typeof obj.errorMessage === 'string'
        ? obj.errorMessage
        : typeof obj.message === 'string'
            ? obj.message
            : undefined
    return { code, message }
}

export default function ChatArea({ className }: ChatAreaProps) {
    const topInsetPx = 72
    const selectedConversationId = useChatStore(s => s.selectedConversationId)
    const draftConversation = useChatStore(s => s.draftConversation)
    const isDraftSelected = Boolean(
        draftConversation?.id && draftConversation.id === selectedConversationId
    )
    const turns                  = useChatStore(s => s.turns)
    const replaceTurns           = useChatStore(s => s.replaceTurns)
    const setBusy                = useChatStore(s => s.setBusy)
    const clearBusy              = useChatStore(s => s.clearBusy)

    // APIs related to multi-version replies
    const setTurnAssistants        = useChatStore(s => s.setTurnAssistants)
    const pushAssistantVersion     = useChatStore(s => s.pushAssistantVersion)
    const appendAssistantDeltaById = useChatStore(s => s.appendAssistantDeltaById)
    const patchAssistantById       = useChatStore(s => s.patchAssistantById)
    const renameTurnId             = useChatStore(s => s.renameTurnId)
    const addStreamingSegment      = useChatStore(s => s.addStreamingSegment)
    const clearStreamingSegments   = useChatStore(s => s.clearStreamingSegments)
    const clearAllStreamingSegments = useChatStore(s => s.clearAllStreamingSegments)
    const addDevEvent              = useDevInspectorStore(s => s.addEvent)

    const [crossfadeFromTurns, setCrossfadeFromTurns] = useState<typeof turns | null>(null)
    const [crossfadeActive, setCrossfadeActive] = useState(false)
    const chatAreaRef = useRef<HTMLDivElement>(null)
    const [isUserAtBottom, setIsUserAtBottom] = useState(true)
    const reloadInFlight = useRef<Set<string>>(new Set())
    const crossfadeTimerRef = useRef<number | null>(null)

    // ↩️ reply_id -> turn_id
    const replyToTurn = useRef<Map<string, string>>(new Map())

    const smoother = useMemo(
        () =>
            new StreamSmoother({
                appendDelta: appendAssistantDeltaById,
                addSegment: addStreamingSegment,
            }),
        [appendAssistantDeltaById, addStreamingSegment]
    )

    useEffect(() => {
        return () => {
            if (crossfadeTimerRef.current != null) {
                window.clearTimeout(crossfadeTimerRef.current)
                crossfadeTimerRef.current = null
            }
            smoother.flushAll()
            clearAllStreamingSegments()
        }
    }, [smoother, clearAllStreamingSegments])

    // Regenerate: append a new version immediately (for example <1/2>)
    const onRegen = async (turnId: string) => {
        const st = chatStore.getState()
        const me = st.turns.find(t => t.id === turnId)
        const cutoff = me?.tseq ?? Number.POSITIVE_INFINITY
        const convId = me?.conversation_id
        if (convId) {
            chatStore.setState(s => ({
                turns: s.turns.filter(t =>
                    t.conversation_id !== convId || (t.tseq ?? Number.POSITIVE_INFINITY) <= cutoff
                ),
            }))
        }
        const res = await window.chatAPI.regenerateMessage(turnId)
        applyConversationSnapshot(res.snapshot)
        touchConversationActivity(res.meta?.conversationId ?? res.placeholder.conversation_id)
        setBusy(res.placeholder.conversation_id, res.placeholder.id)
    }

    // Edit and rerun: only restore the draft into the input; the real rerun logic lives in ChatInput
    const setComposerDraft = useChatStore(s => s.setComposerDraft)
    const onRewrite = (turnId: string, userMessage: UIMessage) => {
        setComposerDraft({
            turnId,
            text: userMessage.content ?? '',
            attachments: buildDraftAttachmentsFromMessage(userMessage),
        })
        document.getElementById('composer-input')?.focus()
        chatAreaRef.current?.scrollTo({ top: chatAreaRef.current.scrollHeight, behavior: 'smooth' })
    }

    // Auto-scroll
    useEffect(() => {
        if (isUserAtBottom && chatAreaRef.current) {
            chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight
        }
    }, [turns, isUserAtBottom])

    // Listen to scroll changes
    useEffect(() => {
        const el = chatAreaRef.current
        if (!el) return
        const onScroll = () => {
            const tolerance = 60
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < tolerance
            setIsUserAtBottom(atBottom)
        }
        el.addEventListener('scroll', onScroll)
        return () => el.removeEventListener('scroll', onScroll)
    }, [])

    // Initial load / conversation switch: fetch the main list and then all versions for each turn
    useEffect(() => {
        if (!selectedConversationId || isDraftSelected) {
            replaceTurns([])
            return
        }

        let cancelled = false

        ;(async () => {
            try {
                const rows: ChatItemRow[] = await window.chatAPI.getChatItems(selectedConversationId)
                if (cancelled) return

                const sortedRows = rows
                    .slice()
                    .sort((a, b) => (a.tseq ?? 0) - (b.tseq ?? 0))
                const answersByTurn = new Map<string, UIMessage[]>()

                await Promise.all(sortedRows.map(async (r) => {
                    try {
                        const answers: UIMessage[] = await window.chatAPI.getTurnAnswers(r.turn_id)
                        answersByTurn.set(r.turn_id, answers)
                    } catch (e) {
                        console.warn('[getTurnAnswers] failed for turn:', r.turn_id, e)
                    }
                }))
                if (cancelled) return

                const previousTurns = chatStore.getState().turns.slice()
                const next = sortedRows.map(rowToTurn)

                if (crossfadeTimerRef.current != null) {
                    window.clearTimeout(crossfadeTimerRef.current)
                    crossfadeTimerRef.current = null
                }
                setCrossfadeFromTurns(previousTurns.length > 0 ? previousTurns : null)
                setCrossfadeActive(false)

                replaceTurns(next)
                for (const r of sortedRows) {
                    const activeId = r.asst_msg_id || undefined
                    const answers = answersByTurn.get(r.turn_id)
                    if (answers) {
                        setTurnAssistants(r.turn_id, answers, activeId)
                    }
                }

                if (previousTurns.length > 0) {
                    requestAnimationFrame(() => setCrossfadeActive(true))
                    crossfadeTimerRef.current = window.setTimeout(() => {
                        setCrossfadeFromTurns(null)
                        setCrossfadeActive(false)
                        if (chatAreaRef.current) {
                            chatAreaRef.current.scrollTop = 0
                        }
                        crossfadeTimerRef.current = null
                    }, 140)
                } else if (chatAreaRef.current) {
                    chatAreaRef.current.scrollTop = 0
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                console.error('[ChatArea] load error:', msg)
            }
        })()

        return () => {
            cancelled = true
            if (crossfadeTimerRef.current != null) {
                window.clearTimeout(crossfadeTimerRef.current)
                crossfadeTimerRef.current = null
            }
        }
    }, [selectedConversationId, isDraftSelected, replaceTurns, setTurnAssistants])

    const renderTurnList = (items: typeof turns, keyPrefix: string) => (
        <ul className="space-y-2">
            {items.map(t => (
                <TurnItem
                    key={`${keyPrefix}-${t.id}`}
                    turn={t}
                    onRegen={onRegen}
                    onRewrite={onRewrite}
                />
            ))}
        </ul>
    )

    useEffect(() => {
        const handler = (_e: ElectronIpcRendererEvent, event: StrategyDevEvent) => {
            addDevEvent(event)
        }
        window.chatAPI.strategyDev?.onEvent?.(handler)
        return () => {
            window.chatAPI.strategyDev?.removeEventListener?.()
        }
    }, [addDevEvent])

    // Streaming events: update precisely by reply_id without replacing turns and clobbering local state
    useEffect(() => {
        window.chatAPI.clearStreamHandlers?.()
        const mapRef = replyToTurn.current
        const debugStream =
            (import.meta as unknown as { env?: Record<string, string> }).env?.DEBUG_STREAM === '1' ||
            (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DEBUG_STREAM === '1' ||
            (window as unknown as { DEBUG_STREAM?: string }).DEBUG_STREAM === '1'

        const logStream = (
            phase: 'started' | 'chunk' | 'done',
            data: LlmStreamStartedEventData | LlmStreamChunkEventData | LlmStreamDoneEventData,
            turnId: string | undefined,
            hasAssistant: boolean,
        ) => {
            if (!debugStream) return
            console.log('[stream][ui]', {
                phase,
                activeConversationId: selectedConversationId,
                conversationId: data.conversation_id,
                replyId: data.reply_id,
                turnId,
                hasAssistant,
                modelId: (data as { model_id?: string }).model_id,
                providerId: (data as { provider_id?: string }).provider_id,
            })
        }

        const reloadConversation = async (conversationId: string) => {
            if (reloadInFlight.current.has(conversationId)) return
            reloadInFlight.current.add(conversationId)
            try {
                const rows: ChatItemRow[] = await window.chatAPI.getChatItems(conversationId)
                if (chatStore.getState().selectedConversationId !== conversationId) return

                const next = rows
                    .slice()
                    .sort((a, b) => (a.tseq ?? 0) - (b.tseq ?? 0))
                    .map(rowToTurn)
                replaceTurns(next)

                await Promise.all(rows.map(async (r) => {
                    const activeId = r.asst_msg_id || undefined
                    try {
                        const answers: UIMessage[] = await window.chatAPI.getTurnAnswers(r.turn_id)
                        setTurnAssistants(r.turn_id, answers, activeId)
                    } catch (e) {
                        console.warn('[stream][ui] getTurnAnswers failed for reload', r.turn_id, e)
                    }
                }))
            } catch (err) {
                console.warn('[stream][ui] reload conversation failed', conversationId, err)
            } finally {
                reloadInFlight.current.delete(conversationId)
            }
        }

        // started
        const onStarted = (_e: ElectronIpcRendererEvent, data: LlmStreamStartedEventData) => {
            setBusy(data.conversation_id, data.reply_id)
            clearStreamingSegments(data.reply_id)

            const turnId = (data as unknown as { turn_id?: string }).turn_id
            if (!turnId) {
                if (data.conversation_id === selectedConversationId) {
                    const cached = getLastSnapshot(data.conversation_id)
                    if (cached) {
                        console.warn('[stream][fallback] missing turn_id, applying cached snapshot', {
                            conversationId: data.conversation_id,
                            replyId: data.reply_id,
                            turnId: undefined,
                        })
                        applyConversationSnapshot(cached)
                    } else {
                        console.warn('[stream][fallback] missing turn_id, reload conversation', {
                            conversationId: data.conversation_id,
                            replyId: data.reply_id,
                            turnId: undefined,
                        })
                        void reloadConversation(data.conversation_id)
                    }
                }
                return
            }
            mapRef.set(data.reply_id, turnId)

            // If the UI does not yet have this reply version, insert a placeholder defensively
            const st = chatStore.getState()
            const t = st.turns.find(tt => tt.id === turnId)
            const exists = t?.assistants?.some(a => a.id === data.reply_id)
            logStream('started', data, turnId, !!exists)
            if (!t && data.conversation_id === selectedConversationId) {
                const cached = getLastSnapshot(data.conversation_id)
                if (cached) {
                    console.warn('[stream][fallback] applying cached snapshot on started', {
                        turnId,
                        conversationId: data.conversation_id,
                        replyId: data.reply_id,
                    })
                    applyConversationSnapshot(cached)
                } else {
                    console.warn('[stream][fallback] reload conversation on started', {
                        turnId,
                        conversationId: data.conversation_id,
                        replyId: data.reply_id,
                    })
                    void reloadConversation(data.conversation_id)
                }
            }
            if (!exists) {
                pushAssistantVersion(turnId, {
                    id: data.reply_id,
                    conversation_id: data.conversation_id,
                    role: 'assistant',
                    type: 'loading',
                    content: '',
                    model: (data as { model_id?: string }).model_id ?? undefined,
                    timestamp: Date.now(),
                })
            }

            // If a placeholder turnId was created earlier (assistant.id = reply_id), merge it now
            const tmp = st.turns.find(tt => tt.assistants?.some(a => a.id === data.reply_id) && tt.id !== turnId)
            if (tmp) renameTurnId(tmp.id, turnId)
        }

        // chunk: append precisely by asstId
        const onChunk = (_e: ElectronIpcRendererEvent, data: LlmStreamChunkEventData) => {
            const convId = selectedConversationId
            if (!convId || data.conversation_id !== convId) return
            const st = chatStore.getState()

            const idFromEvent = (data as unknown as { turn_id?: string }).turn_id
            const idFromMap   = mapRef.get(data.reply_id)
            const idFallback  = st.turns.find(t => t.assistants?.some(a => a.id === data.reply_id))?.id
            const turnId      = idFromEvent ?? idFromMap ?? idFallback
            if (!turnId) {
                if (debugStream) {
                    console.warn('[stream][ui] chunk missing turnId', {
                        conversationId: data.conversation_id,
                        replyId: data.reply_id,
                    })
                }
                return
            }
            const turn = st.turns.find(t => t.id === turnId)
            if (!turn) {
                if (debugStream) {
                    console.warn('[stream][ui] chunk turn not in store', {
                        conversationId: data.conversation_id,
                        replyId: data.reply_id,
                        turnId,
                    })
                }
                return
            }
            const hasAssistant = !!turn.assistants?.some(a => a.id === data.reply_id)
            logStream('chunk', data, turnId, hasAssistant)
            if (!hasAssistant) {
                if (debugStream) {
                    console.warn('[stream][ui] chunk missing assistant, creating placeholder', {
                        conversationId: data.conversation_id,
                        replyId: data.reply_id,
                        turnId,
                    })
                }
                pushAssistantVersion(turnId, {
                    id: data.reply_id,
                    conversation_id: data.conversation_id,
                    role: 'assistant',
                    type: 'loading',
                    content: '',
                    model: (data as { model_id?: string }).model_id ?? undefined,
                    timestamp: Date.now(),
                })
            }

            smoother.enqueue(turnId, data.reply_id, data.chunk ?? '')
        }

        // done: write terminal state by asstId; never replaceTurns here to avoid wiping assistants[]
        const onDone = (_e: ElectronIpcRendererEvent, data: LlmStreamDoneEventData) => {
            const st = chatStore.getState()
            if (st.busyByConversation[data.conversation_id]) {
                clearBusy(data.conversation_id)
            }

            if (selectedConversationId !== data.conversation_id) return

            const idFromEvent = (data as unknown as { turn_id?: string }).turn_id
            const idFromMap   = mapRef.get(data.reply_id)
            const idFallback  = st.turns.find(t => t.assistants?.some(a => a.id === data.reply_id))?.id
            const turnId      = idFromEvent ?? idFromMap ?? idFallback
            if (!turnId) return
            const hasAssistant = !!st.turns.find(t => t.id === turnId)?.assistants?.some(a => a.id === data.reply_id)
            logStream('done', data, turnId, hasAssistant)

            const { reason } = readDoneMeta(data.meta)
            const doneError = readDoneError(data.meta)
            const nextType: UIMessage['type'] = reason === 'error'
                ? 'error'
                : reason === 'aborted'
                    ? 'stopped'
                    : 'text'

            smoother.flushMessage(data.reply_id)
            clearStreamingSegments(data.reply_id)

            patchAssistantById(turnId, data.reply_id, prev => ({
                ...prev,
                type: nextType,
                ...(data.final_content != null ? { content: data.final_content } : {}),
                ...(reason ? { finishReason: reason } : {}),
                ...(data.provider_id ? { providerId: data.provider_id } : {}),
                ...(doneError.code ? { errorCode: doneError.code } : {}),
                ...(doneError.message ? { errorMessage: doneError.message } : {}),
                ...(doneError.raw !== undefined ? { rawError: doneError.raw } : {}),
            }))
            chatStore.getState().updateTurnStatus(
                turnId,
                reason === 'error' ? 'error' : reason === 'aborted' ? 'aborted' : 'completed'
            )
            if (reason !== 'error' && reason !== 'aborted') {
                touchConversationActivity(data.conversation_id)
            }

            mapRef.delete(data.reply_id)
            // Do not refresh the full list anymore; local memory already holds the terminal state.
            // If a stricter reconciliation is needed, refetch answers for this turn only:
            // window.chatAPI.getTurnAnswers(turnId).then(ans => setTurnAssistants(turnId, ans))
        }

        window.chatAPI.onStreamStarted?.(onStarted)
        window.chatAPI.onStreamChunk(onChunk)
        window.chatAPI.onStreamDone(onDone)

        return () => {
            window.chatAPI.removeStreamStartedListener?.(onStarted)
            window.chatAPI.removeStreamChunkListener(onChunk)
            window.chatAPI.removeStreamDoneListener(onDone)
            mapRef.clear()
            smoother.flushAll()
            clearAllStreamingSegments()
        }
    }, [
        selectedConversationId,
        setBusy, clearBusy,
        pushAssistantVersion,
        appendAssistantDeltaById,
        patchAssistantById,
        renameTurnId,
        replaceTurns,
        setTurnAssistants,
        smoother,
        clearStreamingSegments,
        clearAllStreamingSegments,
    ])

    return (
        <div className={clsx('relative flex-1 flex flex-col', className)}>
            <Topbar />

            {/* Outer ChatArea container: non-scrolling, responsible only for overlay positioning */}
            <main className="relative flex-1 overflow-hidden bg-bg-chatarea text-tx">
                {/* Actual scrolling layer */}
                <div
                    ref={chatAreaRef}
                    className="scrollbar-chat h-full overflow-y-auto overflow-x-hidden"
                >
                    <div className="px-4">
                        <div className="mx-auto w-full max-w-4xl pb-6 pt-0">
                            <div style={{ height: topInsetPx }} className="shrink-0" aria-hidden="true" />
                            {crossfadeFromTurns ? (
                                <div className="relative">
                                    <div
                                        className={clsx(
                                            "ui-fast transition-opacity pointer-events-none",
                                            crossfadeActive ? "opacity-0" : "opacity-100"
                                        )}
                                    >
                                        {renderTurnList(crossfadeFromTurns, "old")}
                                    </div>
                                    <div
                                        className={clsx(
                                            "ui-fast absolute inset-0 transition-opacity",
                                            crossfadeActive ? "opacity-100" : "opacity-0"
                                        )}
                                    >
                                        {renderTurnList(turns, "new")}
                                    </div>
                                </div>
                            ) : (
                                renderTurnList(turns, "live")
                            )}
                        </div>
                    </div>
                </div>

                {/* Top gradient: smooth transition when text scrolls out of view */}
                <div
                    className="pointer-events-none absolute left-0 right-0 top-0 z-10"
                    style={{
                        height: '50px',
                        backgroundImage:
                            'linear-gradient(to bottom, var(--color-bg-chatarea) 0%, transparent 100%)',
                    }}
                />

                {/* Bottom gradient: flush with the bottom edge of ChatArea (right above the input area) */}
                <div
                    className="pointer-events-none absolute left-0 right-0 bottom-0 z-10"
                    style={{
                        height: '30px',
                        backgroundImage:
                            'linear-gradient(to bottom, transparent 0%, var(--color-bg-chatarea) 100%)',
                    }}
                />
            </main>
        </div>
    )
}
