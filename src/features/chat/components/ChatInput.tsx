import { useCallback, useState, useRef, useMemo, useEffect, useLayoutEffect } from 'react'
import clsx from 'clsx'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useChatStore, chatStore } from '@/features/chat/state/chatStore'
import { sendUserMessage } from '@/features/chat/utils/sendUserMessage'
import { chatService } from '@/shared/services/ipc/chatService'
import { applyConversationSnapshot } from '@/features/chat/utils/applyConversationSnapshot'
import { rowToTurn } from '@/features/chat/utils/rowToTurn'
import { X, Plus, Globe, Square, ArrowUp, ChevronDown } from 'lucide-react'
import { shallow } from 'zustand/shallow'
import { v4 as uuidv4 } from 'uuid'
import type { Conversation, StrategyInfo, StrategyPrefs, TurnAttachment, ModelCapabilities } from '@contracts'
import {
    DEFAULT_ATTACHMENT_LIMITS,
    mimeMatchesAllowlist,
    normalizeAttachmentExt,
    normalizeAttachmentMime,
} from '@shared/attachments/attachmentPolicy'
import { buildAttachmentPickerAccept, resolveAttachmentType } from '@shared/attachments/attachmentTypeRegistry'
import InputAttachmentsBar, { type AttachmentIssue } from '@/features/chat/attachments/components/InputAttachmentsBar'
import {
    ingestAssetsForTurn,
    isAttachmentUploadingForTurn,
} from '@/features/chat/attachments/utils/ingestAssetsForTurn'
import { touchConversationActivity } from '@/features/chat/utils/touchConversationActivity'

type DraftAttachment = TurnAttachment

type ChatInputProps = {
    className?: string
}

function normalizeEditDraftAttachments(items?: TurnAttachment[]): TurnAttachment[] {
    if (!Array.isArray(items) || items.length === 0) return []
    return items.map((item) => ({
        ...item,
        id: item.assetId ?? item.id,
        assetId: item.assetId ?? item.id,
        status: 'ready',
        ready: true,
        ingestionState: 'ready',
    }))
}

function dragEventHasFiles(event: React.DragEvent<HTMLElement>): boolean {
    const types = event.dataTransfer?.types
    if (!types || types.length === 0) return false
    return Array.from(types).includes('Files')
}

export default function ChatInput({ className }: ChatInputProps) {
    const selectedId = useChatStore(s => s.selectedConversationId)
    const busyInfo = useChatStore(s => (selectedId ? s.busyByConversation[selectedId] : undefined))
    const isBusy = !!busyInfo
    const isComposing = useRef(false)

    const [conversations, setConversations] = useChatStore(
        s => [s.conversations, s.setConversations],
        shallow
    )
    const setSelectedId = useChatStore(s => s.setSelectedConversationId)
    const draftConversation = useChatStore(s => s.draftConversation)
    const updateDraftConversation = useChatStore(s => s.updateDraftConversation)
    const isDraftSelected = Boolean(
        draftConversation?.id && selectedId === draftConversation.id
    )

    const selectedConversation = useMemo(() => {
        if (isDraftSelected) return draftConversation ?? null
        return conversations.find((c: Conversation) => c.id === selectedId) ?? null
    }, [conversations, selectedId, isDraftSelected, draftConversation])

    const draft = useChatStore(s => s.composerDraft)
    const clearDraft = useChatStore(s => s.clearComposerDraft)
    const updateTurnUser = useChatStore(s => s.updateTurnUser)
    const setTurnAssistants = useChatStore(s => s.setTurnAssistants)

    const [input, setInput] = useState(draft.text ?? '')
    const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)

    const [favoriteModels, setFavoriteModels] = useState<Array<{ id: string; name: string; available: boolean }>>([])
    const [modelsById, setModelsById] = useState<Record<string, { id: string; provider: string; capabilities: ModelCapabilities }>>({})
    const pendingModelId = useRef<string | null>(null)
    const pendingStrategyId = useRef<string | null>(null)
    const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([])

    const [strategies, setStrategies] = useState<StrategyInfo[]>([])
    const [strategyPrefs, setStrategyPrefs] = useState<StrategyPrefs | null>(null)
    const [activeStrategyId, setActiveStrategyId] = useState<string | null>(null)
    const [strategyLoading, setStrategyLoading] = useState(false)
    const [strategyError, setStrategyError] = useState<string | null>(null)
    const autoAssignedStrategies = useRef<Set<string>>(new Set())
    const lastStrategyId = useRef<string | null>(null)
    const [forceWebSearch, setForceWebSearch] = useState(false)
    const [isDraggingFiles, setIsDraggingFiles] = useState(false)

    // Measure the real ChatInput height, including padding and the draft bar
    const rootRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        const el = rootRef.current
        if (!el) return

        const write = () => {
            const h = Math.ceil(el.getBoundingClientRect().height)
            document.documentElement.style.setProperty('--synara-composer-h', `${h}px`)
        }

        write()

        const ro = new ResizeObserver(() => write())
        ro.observe(el)

        return () => ro.disconnect()
    }, [])

    /* ---------------- textarea auto-resize ---------------- */

    function autoResize(el: HTMLTextAreaElement, min = 22, max = 200) {
        el.style.height = 'auto'
        const h = Math.min(Math.max(el.scrollHeight, min), max)
        el.style.height = `${h}px`
        el.style.overflowY = h >= max ? 'auto' : 'hidden'
    }

    useEffect(() => {
        setInput(draft.text ?? '')
        setDraftAttachments(normalizeEditDraftAttachments(draft.attachments))
    }, [draft.text, draft.turnId, draft.attachments])

    useLayoutEffect(() => {
        if (textAreaRef.current) autoResize(textAreaRef.current)
    }, [input])

    const refreshFavorites = async () => {
        const [models, settings] = await Promise.all([
            window.chatAPI.getModelsWithStatus(),
            window.chatAPI.settings.get(),
        ])
        const byId: Record<string, { id: string; provider: string; capabilities: ModelCapabilities }> = {}
        for (const entry of models) {
            byId[entry.model.id] = {
                id: entry.model.id,
                provider: entry.model.provider,
                capabilities: entry.model.capabilities,
            }
        }
        setModelsById(byId)
        const favorites = new Set<string>()
        for (const row of settings.modelOverrides ?? []) {
            try {
                const req = JSON.parse(row.requirements_json) as Record<string, unknown>
                if (req.favorite === true) favorites.add(row.model_id)
            } catch {
                // ignore
            }
        }
        const filtered = models
            .filter((entry) => entry.status.available)
            .filter((entry) => favorites.has(entry.model.id))
            .map((entry) => ({
                id: entry.model.id,
                name: entry.model.label ?? entry.model.id,
                available: entry.status.available,
            }))
        setFavoriteModels(filtered)
    }

    useEffect(() => {
        let cancelled = false
        refreshFavorites().catch(() => {
            if (!cancelled) setFavoriteModels([])
        })
        return () => { cancelled = true }
    }, [selectedConversation?.model])

    useEffect(() => {
        if (typeof window === 'undefined') return
        try {
            lastStrategyId.current = window.localStorage.getItem('looma:last_strategy_id')
        } catch {
            lastStrategyId.current = null
        }
    }, [])

    useEffect(() => {
        const onUpdate = () => {
            refreshFavorites().catch(() => {
                setFavoriteModels([])
            })
        }
        window.chatAPI.onModelsUpdated(() => onUpdate())
        return () => {
            window.chatAPI.removeModelsUpdatedListener()
        }
    }, [])

    useEffect(() => {
        pendingModelId.current = null
        pendingStrategyId.current = null
    }, [selectedConversation?.id])

    useEffect(() => {
        setDraftAttachments([])
    }, [selectedConversation?.id])

    useEffect(() => {
        if (!selectedId || !busyInfo?.replyId) return
        let cancelled = false
        const timer = window.setInterval(() => {
            void chatService.isConversationBusy(selectedId)
                .then((status) => {
                    if (cancelled) return
                    if (!status?.busy) {
                        chatStore.getState().clearBusy(selectedId)
                    }
                })
                .catch(() => {
                    // ignore transient polling errors
                })
        }, 500)
        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [selectedId, busyInfo?.replyId])

    const prevAttachmentUrlsRef = useRef<Map<string, string>>(new Map())
    useEffect(() => {
        const nextMap = new Map<string, string>()
        for (const item of draftAttachments) {
            if (item.previewUrl) nextMap.set(item.id, item.previewUrl)
        }
        for (const [id, url] of prevAttachmentUrlsRef.current.entries()) {
            if (!nextMap.has(id)) {
                URL.revokeObjectURL(url)
            }
        }
        prevAttachmentUrlsRef.current = nextMap
    }, [draftAttachments])
    useEffect(() => {
        return () => {
            for (const url of prevAttachmentUrlsRef.current.values()) {
                URL.revokeObjectURL(url)
            }
        }
    }, [])

    /* ---------------- handlers ---------------- */

    const ensureConversationModelSynced = async () => {
        if (!selectedConversation || isDraftSelected) return
        const desired = pendingModelId.current ?? selectedConversation.model
        if (!desired || desired === selectedConversation.model) return
        await window.chatAPI.updateConversationModel(selectedConversation.id, desired)
        const newConvs = await window.chatAPI.getAllConversations()
        setConversations(newConvs)
        pendingModelId.current = null
    }

    const patchDraftAttachment = useCallback((id: string, patch: Partial<DraftAttachment>) => {
        setDraftAttachments((prev) => prev.map((entry) => entry.id === id
            ? {
                ...entry,
                ...patch,
            }
            : entry))
    }, [])

    const handlePickFiles = useCallback(async (list: FileList | File[] | null) => {
        const fileCount = list == null
            ? 0
            : Array.isArray(list)
                ? list.length
                : list.length
        if (fileCount > 0 && selectedConversation && !isDraftSelected) {
            touchConversationActivity(selectedConversation.id)
        }
        await ingestAssetsForTurn({
            input: { files: list },
            onAppend: (items) => setDraftAttachments((prev) => [...prev, ...items]),
            onUpdate: patchDraftAttachment,
        })
    }, [isDraftSelected, patchDraftAttachment, selectedConversation])

    useEffect(() => {
        if (!isDraggingFiles) return
        const reset = () => setIsDraggingFiles(false)
        window.addEventListener('dragend', reset)
        window.addEventListener('drop', reset)
        window.addEventListener('blur', reset)
        return () => {
            window.removeEventListener('dragend', reset)
            window.removeEventListener('drop', reset)
            window.removeEventListener('blur', reset)
        }
    }, [isDraggingFiles])

    const handleComposerDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!dragEventHasFiles(event)) return
        setIsDraggingFiles(true)
    }, [])

    const handleComposerDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!dragEventHasFiles(event)) return
        const nextTarget = event.relatedTarget as Node | null
        if (nextTarget && event.currentTarget.contains(nextTarget)) return
        setIsDraggingFiles(false)
    }, [])

    const handleComposerDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!dragEventHasFiles(event)) return
        event.preventDefault()
        setIsDraggingFiles(true)
    }, [])

    const handleComposerDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!dragEventHasFiles(event)) return
        event.preventDefault()
        setIsDraggingFiles(false)
        void handlePickFiles(event.dataTransfer.files)
    }, [handlePickFiles])

    const removeAttachment = useCallback((id: string) => {
        setDraftAttachments((prev) => {
            const target = prev.find((item) => item.id === id)
            if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
            return prev.filter((item) => item.id !== id)
        })
        if (selectedConversation && !isDraftSelected) {
            touchConversationActivity(selectedConversation.id)
        }
    }, [isDraftSelected, selectedConversation])

    const handleSend = async () => {
        const trimmed = input.trim()
        if ((!trimmed && draftAttachments.length === 0) || !selectedId) return
        if (strategyNeedsSwitch) return
        if (draftAttachments.some((attachment) => isAttachmentUploadingForTurn(attachment))) {
            console.warn('[send] blocked: attachment is still uploading')
            return
        }
        const attachmentsForSend = draftAttachments.map((attachment) => {
            const canonicalAssetId = attachment.assetId ?? attachment.id
            return {
                ...attachment,
                id: canonicalAssetId,
                assetId: canonicalAssetId,
                readDiagnostics: {
                    ...attachment.readDiagnostics,
                    assetId: canonicalAssetId,
                    storageKey: attachment.storageKey ?? attachment.readDiagnostics?.storageKey,
                },
            }
        })
        const effectiveModelId = pendingModelId.current ?? selectedConversation?.model
        if (!effectiveModelId || !favoriteModels.some((m) => m.id === effectiveModelId)) {
            console.warn('[send] MODEL_NOT_SELECTED')
            return
        }

        // —— rewrite
        if (draft.turnId) {
            const turnId = draft.turnId
            clearDraft()
            setInput('')
            setDraftAttachments([])

            updateTurnUser(turnId, { content: trimmed, type: 'text' })
            setTurnAssistants(turnId, [])

            // Local clipping
            {
                const st = chatStore.getState()
                const me = st.turns.find(t => t.id === turnId)
                const cutoff = me?.tseq ?? Number.POSITIVE_INFINITY
                const convId = me?.conversation_id
                chatStore.setState(s => ({
                    turns: s.turns.filter(
                        t => t.conversation_id !== convId || (t.tseq ?? Number.POSITIVE_INFINITY) <= cutoff
                    ),
                }))
            }

            try {
                const traceId = uuidv4()
                const res = await window.chatAPI.rewriteFromTurn(turnId, trimmed, attachmentsForSend, traceId)
                applyConversationSnapshot(res.snapshot)
                touchConversationActivity(res.meta?.conversationId ?? res.placeholder.conversation_id)
                const { setBusy } = chatStore.getState()
                if (res.placeholder.conversation_id && res.placeholder.id) {
                    setBusy(res.placeholder.conversation_id, res.placeholder.id)
                }
            } catch {
                const convId = chatStore.getState().selectedConversationId
                if (convId) {
                    const rows = await window.chatAPI.getChatItems(convId)
                    chatStore.getState().replaceTurns(rows.map(rowToTurn))
                }
            }
            return
        }

        if (isDraftSelected && selectedConversation) {
            setInput('')
            try {
                const created = await window.chatAPI.createConversation()
                const newId = created.id
                const desiredModelId = pendingModelId.current ?? selectedConversation.model
                const desiredStrategyId = pendingStrategyId.current
                    ?? selectedConversation.strategy_id
                    ?? null

                if (desiredModelId) {
                    await window.chatAPI.updateConversationModel(newId, desiredModelId)
                }
                if (desiredStrategyId) {
                    const res = await window.chatAPI.strategies.switch(newId, desiredStrategyId)
                    setActiveStrategyId(res.strategyId)
                }

                const newConvs = await window.chatAPI.getAllConversations()
                setConversations(newConvs)
                setSelectedId(newId)
                pendingModelId.current = null
                pendingStrategyId.current = null

                await sendUserMessage(trimmed, newId, {
                    forceWebSearch,
                    attachments: attachmentsForSend,
                })
                setDraftAttachments([])
            } catch (err) {
                console.error('[send] create conversation failed', err)
            }
            return
        }

        // —— normal send
        await ensureConversationModelSynced()
        setInput('')
        await sendUserMessage(trimmed, selectedId, {
            forceWebSearch,
            attachments: attachmentsForSend,
        })
        setDraftAttachments([])
    }

    const handleStop = async () => {
        if (!selectedId || !busyInfo) return
        try {
            await window.chatAPI.abortStream?.(busyInfo.replyId)
        } finally {
            chatStore.getState().clearBusy(selectedId)
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isComposing.current) return
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (!isBusy && !strategyNeedsSwitch) handleSend()
        }
    }

    const handleCompositionStart = () => (isComposing.current = true)
    const handleCompositionEnd = () => (isComposing.current = false)
    const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length === 0) return
        event.preventDefault()
        void handlePickFiles(files)
    }, [handlePickFiles])

    const modelLabel = useMemo(() => {
        const current = selectedConversation?.model
        if (!current) return 'Model'
        const match = favoriteModels.find((m) => m.id === current)
        return match?.name ?? 'Model'
    }, [favoriteModels, selectedConversation?.model])

    const effectiveModelId = useMemo(() => {
        return pendingModelId.current ?? selectedConversation?.model ?? null
    }, [selectedConversation?.model])

    const effectiveModelInfo = useMemo(() => {
        if (!effectiveModelId) return null
        return modelsById[effectiveModelId] ?? null
    }, [effectiveModelId, modelsById])

    const attachmentIssues = useMemo(() => {
        const issues: Record<string, AttachmentIssue> = {}
        const modelCaps = effectiveModelInfo?.capabilities
        const supported = modelCaps?.supportedMimeTypes ?? []
        const maxBytes = Number.isFinite(modelCaps?.maxFileSizeMB)
            ? Math.floor((modelCaps?.maxFileSizeMB as number) * 1024 * 1024)
            : Math.floor(DEFAULT_ATTACHMENT_LIMITS.maxFileSizeMB * 1024 * 1024)
        const maxFiles = Number.isFinite(modelCaps?.maxFilesPerTurn)
            ? (modelCaps?.maxFilesPerTurn as number)
            : DEFAULT_ATTACHMENT_LIMITS.maxFilesPerTurn

        for (let i = 0; i < draftAttachments.length; i++) {
            const attachment = draftAttachments[i]
            const ext = normalizeAttachmentExt(attachment.ext, attachment.name)
            const mimeType = normalizeAttachmentMime(attachment.mimeType, ext, attachment.name)
            const platformType = resolveAttachmentType({
                mimeType,
                ext,
                fileName: attachment.name,
            })

            if (attachment.status === 'error') {
                issues[attachment.id] = {
                    unsupported: true,
                    reason: attachment.errorMessage ?? 'Failed to prepare attachment.',
                }
                continue
            }
            if (!modelCaps || modelCaps.nativeFiles !== true || modelCaps.attachmentTransport === 'none') {
                issues[attachment.id] = {
                    unsupported: true,
                    reason: 'Current model does not support native file attachments.',
                }
                continue
            }
            if (maxFiles != null && maxFiles > 0 && i >= maxFiles) {
                issues[attachment.id] = {
                    unsupported: true,
                    reason: `Too many attachments (max ${maxFiles}).`,
                }
                continue
            }
            if (!platformType) {
                issues[attachment.id] = {
                    unsupported: true,
                    reason: `Unsupported file type: ${mimeType}.`,
                }
                continue
            }
            if (!mimeMatchesAllowlist(mimeType, supported)) {
                issues[attachment.id] = {
                    unsupported: true,
                    reason: `Current model does not support this file type (${mimeType}).`,
                }
                continue
            }
            if (maxBytes != null && attachment.size > maxBytes) {
                issues[attachment.id] = {
                    unsupported: true,
                    reason: `File exceeds limit (${Math.floor(maxBytes / (1024 * 1024))} MB).`,
                }
                continue
            }
            issues[attachment.id] = { unsupported: false, reason: null }
        }
        return issues
    }, [draftAttachments, effectiveModelInfo])

    const hasUnsupportedAttachment = useMemo(() => {
        return draftAttachments.some((item) => attachmentIssues[item.id]?.unsupported)
    }, [attachmentIssues, draftAttachments])
    const pickerAccept = useMemo(() => {
        const supported = effectiveModelInfo?.capabilities?.supportedMimeTypes ?? []
        return buildAttachmentPickerAccept(supported)
    }, [effectiveModelInfo?.capabilities?.supportedMimeTypes])
    const hasPendingAttachment = useMemo(() => {
        return draftAttachments.some((item) => isAttachmentUploadingForTurn(item))
    }, [draftAttachments])

    const enabledStrategyIds = useMemo(() => {
        if (strategyPrefs?.enabledIds?.length) return strategyPrefs.enabledIds
        return strategies.map((strategy) => strategy.id)
    }, [strategies, strategyPrefs])

    const installedNonDevStrategies = useMemo(() => {
        return strategies.filter((strategy) => strategy.source !== 'dev')
    }, [strategies])

    const disabledStrategyIds = useMemo(() => {
        const enabled = new Set(enabledStrategyIds)
        const disabled = new Set<string>()
        for (const strategy of strategies) {
            if (strategy.enabled === false || !enabled.has(strategy.id)) {
                disabled.add(strategy.id)
            }
        }
        return disabled
    }, [enabledStrategyIds, strategies])

    const enabledStrategies = useMemo(() => {
        const enabled = new Set(enabledStrategyIds)
        return strategies.filter((strategy) => enabled.has(strategy.id) && strategy.enabled !== false)
    }, [strategies, enabledStrategyIds])

    const activeStrategy = useMemo(() => {
        const currentId = isDraftSelected
            ? selectedConversation?.strategy_id ?? null
            : selectedConversation?.strategy_id ?? activeStrategyId ?? null
        if (!currentId) return null
        return strategies.find((strategy) => strategy.id === currentId) ?? null
    }, [activeStrategyId, isDraftSelected, selectedConversation?.strategy_id, strategies])

    const currentStrategyId = useMemo(() => {
        if (isDraftSelected) return selectedConversation?.strategy_id ?? null
        return selectedConversation?.strategy_id ?? activeStrategyId ?? null
    }, [activeStrategyId, isDraftSelected, selectedConversation?.strategy_id])

    const currentStrategy = useMemo(() => {
        if (!currentStrategyId) return null
        return strategies.find((strategy) => strategy.id === currentStrategyId) ?? null
    }, [currentStrategyId, strategies])

    const isDevConversationStrategyLocked = useMemo(() => {
        return typeof selectedConversation?.strategy_id === 'string'
            && selectedConversation.strategy_id.startsWith('dev:')
    }, [selectedConversation?.strategy_id])

    const isCurrentStrategyDisabled = useMemo(() => {
        if (!currentStrategyId) return false
        if (currentStrategy?.source === 'dev') return false
        return disabledStrategyIds.has(currentStrategyId)
    }, [currentStrategy, currentStrategyId, disabledStrategyIds])

    const strategyNeedsSwitch = useMemo(() => {
        if (isDraftSelected) return false
        if (!selectedConversation?.id) return false
        if (!currentStrategyId) return false
        return isCurrentStrategyDisabled
    }, [currentStrategyId, isCurrentStrategyDisabled, isDraftSelected, selectedConversation?.id])

    const strategyLabel = useMemo(() => {
        if (strategyNeedsSwitch) return 'Strategy needs switch'
        if (!activeStrategy) return 'Strategy'
        return activeStrategy.meta?.name ?? 'Strategy'
    }, [activeStrategy, strategyNeedsSwitch])

    const handleModelChange = async (modelId: string) => {
        if (!selectedConversation) return
        pendingModelId.current = modelId
        if (isDraftSelected) {
            updateDraftConversation({ model: modelId })
            return
        }
        await window.chatAPI.updateConversationModel(selectedConversation.id, modelId)
        const newConvs = await window.chatAPI.getAllConversations()
        setConversations(newConvs)
        pendingModelId.current = null
    }

    const handleStrategyChange = useCallback(async (strategyId: string) => {
        if (!selectedConversation) return
        if (
            isDevConversationStrategyLocked
            && strategyId !== (selectedConversation.strategy_id ?? null)
        ) {
            return
        }
        pendingStrategyId.current = strategyId
        try {
            if (isDraftSelected) {
                updateDraftConversation({ strategy_id: strategyId })
                setActiveStrategyId(strategyId)
            } else {
                const res = await window.chatAPI.strategies.switch(selectedConversation.id, strategyId)
                setActiveStrategyId(res.strategyId)
            }
            const nextPrefs = await window.chatAPI.strategies.setPrefs({ defaultId: strategyId })
            setStrategyPrefs(nextPrefs)
            if (typeof window !== 'undefined') {
                try {
                    window.localStorage.setItem('looma:last_strategy_id', strategyId)
                    lastStrategyId.current = strategyId
                } catch {
                    // ignore
                }
            }
            if (!isDraftSelected) {
                const newConvs = await window.chatAPI.getAllConversations()
                setConversations(newConvs)
            }
        } finally {
            pendingStrategyId.current = null
        }
    }, [
        isDevConversationStrategyLocked,
        isDraftSelected,
        selectedConversation,
        setConversations,
        setStrategyPrefs,
        updateDraftConversation,
    ])

    const handleToggleWebSearch = async () => {
        setForceWebSearch((current) => !current)
    }

    useEffect(() => {
        let cancelled = false
        setStrategyLoading(true)
        setStrategyError(null)
        Promise.all([
            window.chatAPI.strategies.list(),
            window.chatAPI.strategies.getPrefs(),
        ])
            .then(([list, prefs]) => {
                if (cancelled) return
                setStrategies(list)
                setStrategyPrefs(prefs)
                if (!lastStrategyId.current && prefs.defaultId) {
                    const defaultStrategy = list.find((strategy) => strategy.id === prefs.defaultId)
                    const isMemoryBuiltin = defaultStrategy?.source === 'builtin'
                        && defaultStrategy.features?.memoryCloud
                    if (!isMemoryBuiltin) {
                        lastStrategyId.current = prefs.defaultId
                        if (typeof window !== 'undefined') {
                            try {
                                window.localStorage.setItem('looma:last_strategy_id', prefs.defaultId)
                            } catch {
                                // ignore
                            }
                        }
                    }
                }
            })
            .catch((err) => {
                if (cancelled) return
                setStrategyError(err instanceof Error ? err.message : 'Failed to load strategies')
                setStrategies([])
                setStrategyPrefs(null)
            })
            .finally(() => {
                if (!cancelled) setStrategyLoading(false)
            })
        return () => { cancelled = true }
    }, [])

    useEffect(() => {
        if (!selectedConversation?.id) {
            setActiveStrategyId(null)
            return
        }
        if (isDraftSelected) {
            setActiveStrategyId(selectedConversation.strategy_id ?? null)
            return
        }
        let cancelled = false
        window.chatAPI.strategies
            .getActive(selectedConversation.id)
            .then((activeInfo) => {
                if (cancelled) return
                setActiveStrategyId(activeInfo.strategyId)
            })
            .catch(() => {
                if (cancelled) return
                setActiveStrategyId(null)
            })
        return () => { cancelled = true }
    }, [selectedConversation?.id, selectedConversation?.strategy_id, isDraftSelected])

    useEffect(() => {
        if (!selectedConversation?.id) return
        if (strategyLoading) return
        if (!isDraftSelected) return
        if (enabledStrategies.length === 0) return

        const enabledSet = new Set(enabledStrategies.map((strategy) => strategy.id))
        const currentId = isDraftSelected
            ? selectedConversation.strategy_id ?? null
            : activeStrategyId ?? selectedConversation.strategy_id ?? null
        if (autoAssignedStrategies.current.has(selectedConversation.id)) return

        const fallbackBuiltin = enabledStrategies.find(
            (strategy) => strategy.source === 'builtin' && !strategy.features?.memoryCloud
        )
        const defaultStrategy = strategyPrefs?.defaultId
            ? strategies.find((strategy) => strategy.id === strategyPrefs.defaultId)
            : null
        const shouldOverrideDefault = !lastStrategyId.current
            && defaultStrategy?.source === 'builtin'
            && defaultStrategy.features?.memoryCloud
            && fallbackBuiltin?.id
        if (currentId && enabledSet.has(currentId) && !shouldOverrideDefault) return
        const desired = shouldOverrideDefault
            ? fallbackBuiltin?.id
            : (strategyPrefs?.defaultId && enabledSet.has(strategyPrefs.defaultId))
                ? strategyPrefs.defaultId
                : fallbackBuiltin?.id ?? enabledStrategies[0]?.id
        if (!desired) return

        autoAssignedStrategies.current.add(selectedConversation.id)
        void handleStrategyChange(desired)
    }, [
        selectedConversation?.id,
        selectedConversation?.strategy_id,
        activeStrategyId,
        isDraftSelected,
        enabledStrategies,
        strategies,
        strategyPrefs?.defaultId,
        strategyLoading,
        handleStrategyChange,
    ])

    return (
        <div ref={rootRef} className={clsx("relative z-10 -mt-6 overflow-visible px-2 pb-2 pt-6", className)}>
            {draft.turnId && (
                <div className="mb-2 mx-auto max-w-4xl text-sm text-tx/70 flex items-center justify-between">
                    <span>Edit</span>
                    <button
                        onClick={() => {
                            clearDraft()
                            setInput("")
                        }}
                        className="p-1 rounded-md hover:bg-bg-iconbutton-button-hover cursor-pointer"
                        aria-label="Cancel edit"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}

            <div className="mx-auto max-w-4xl rounded-[18px] bg-black/[0.08] p-[1px] shadow-[0_18px_48px_rgba(0,0,0,0.16)] dark:bg-white/[0.10] dark:shadow-none">
                <div className="overflow-hidden rounded-[17px]">
                    {/* Keep the real background on the inner layer so rounded-corner comparisons stay consistent */}
                    <div
                        className={clsx(
                            "ui-base relative bg-bg-inputarea",
                            "px-2 pt-3 pb-1 transition-colors",
                            isDraggingFiles && "cursor-copy bg-black/[0.05] dark:bg-white/[0.05]"
                        )}
                        onDragEnter={handleComposerDragEnter}
                        onDragLeave={handleComposerDragLeave}
                        onDragOver={handleComposerDragOver}
                        onDrop={handleComposerDrop}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            className="hidden"
                            multiple
                            accept={pickerAccept || undefined}
                            onChange={(event) => {
                                void handlePickFiles(event.target.files)
                                event.currentTarget.value = ''
                            }}
                        />

                        <InputAttachmentsBar
                            attachments={draftAttachments}
                            issues={attachmentIssues}
                            onRemove={removeAttachment}
                        />

                        <textarea
                            id="composer-input"
                            ref={textAreaRef}
                            rows={1}
                            placeholder="Type a message..."
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onCompositionStart={handleCompositionStart}
                            onCompositionEnd={handleCompositionEnd}
                            onPaste={handlePaste}
                            className={clsx(
                                "w-full resize-none bg-transparent outline-none",
                                "text-[14px] font-medium pt-1 leading-[1.5]",
                                "placeholder:opacity-40",
                                "px-2 overflow-y-hidden"
                            )}
                        />

                        <div className="mt-1 flex items-center justify-between">
                            <div className="flex items-center gap-1">
                                <button
                                    className="h-9 w-9 rounded-full grid place-items-center cursor-pointer
                         ui-fast ui-press text-tx/80 hover:bg-bg-iconbutton-button-hover transition-colors"
                                    aria-label="Attach"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <Plus className="w-6 h-6" />
                                </button>

                                <button
                                    className={clsx(
                                        "h-9 w-9 rounded-full grid place-items-center cursor-pointer",
                                        "ui-fast ui-press hover:bg-bg-iconbutton-button-hover transition-colors",
                                        forceWebSearch && "bg-bg-iconbutton-button-active text-sky-400"
                                    )}
                                    aria-label="Web search (force)"
                                    onClick={handleToggleWebSearch}
                                >
                                    <Globe
                                        className={clsx(
                                            "w-5 h-5",
                                            forceWebSearch ? "text-sky-400" : "text-tx/80"
                                        )}
                                    />
                                </button>
                            </div>

                            <div className="flex items-center gap-2">
                            <DropdownMenu.Root>
                                <DropdownMenu.Trigger asChild>
                                    <button
                                        disabled={isDevConversationStrategyLocked}
                                        className={clsx(
                                            "ui-fast ui-press h-9 px-3 rounded-full cursor-pointer select-none",
                                            "text-[13px] font-semibold flex items-center gap-2 transition-colors",
                                            isDevConversationStrategyLocked && "cursor-not-allowed opacity-60 hover:bg-transparent",
                                            strategyNeedsSwitch
                                                ? "bg-[var(--warning-bg)] text-[var(--warning-fg)]"
                                                : "text-tx/80 hover:bg-bg-iconbutton-button-hover"
                                        )}
                                        title={isDevConversationStrategyLocked ? "Dev conversation strategy is locked" : strategyLabel}
                                    >
                                        <span className="max-w-[120px] truncate">{strategyLabel}</span>
                                        <ChevronDown className="w-4 h-4 opacity-70" />
                                    </button>
                                </DropdownMenu.Trigger>

                                <DropdownMenu.Portal>
                                    <DropdownMenu.Content
                                        forceMount
                                        side="top"
                                        align="end"
                                        sideOffset={8}
                                        className={clsx(
                                            "ui-panel-motion",
                                            "z-50 min-w-[260px] overflow-hidden rounded-xl select-none",
                                            "border border-border bg-bg-chatarea",
                                            "shadow-lg"
                                        )}
                                    >
                                        {strategyLoading ? (
                                            <div className="px-3 py-3 text-xs text-tx/60 select-none">
                                                Loading strategies...
                                            </div>
                                        ) : strategyError ? (
                                            <div className="px-3 py-3 text-xs text-tx/60 select-none">
                                                {strategyError}
                                            </div>
                                        ) : installedNonDevStrategies.length === 0 ? (
                                            <div className="px-3 py-3 text-xs text-tx/60 select-none">
                                                No installed strategies available.
                                            </div>
                                        ) : (
                                            installedNonDevStrategies.map((strategy) => {
                                                const disabled = disabledStrategyIds.has(strategy.id)
                                                return (
                                                    <DropdownMenu.Item
                                                        key={strategy.id}
                                                        disabled={disabled}
                                                        onSelect={() => {
                                                            if (disabled) return
                                                            void handleStrategyChange(strategy.id)
                                                        }}
                                                        className={clsx(
                                                            "px-3 py-2 text-[13px] font-semibold text-tx outline-none select-none",
                                                            disabled
                                                                ? "opacity-70 cursor-not-allowed"
                                                                : "ui-fast cursor-pointer transition-colors hover:bg-bg-sidebar-button-hover"
                                                        )}
                                                    >
                                                        <div className="flex items-start justify-between gap-3 w-full">
                                                            <div className="min-w-0">
                                                                <span>{strategy.meta?.name ?? strategy.id}</span>
                                                            </div>
                                                            {disabled ? (
                                                                <span className="shrink-0 rounded-full bg-[var(--error-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--error-fg)]">
                                                                    Disabled
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                    </DropdownMenu.Item>
                                                )
                                            })
                                        )}
                                    </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                            </DropdownMenu.Root>

                            <DropdownMenu.Root>
                                <DropdownMenu.Trigger asChild>
                                    <button
                                        className="ui-fast ui-press h-9 px-3 rounded-full cursor-pointer select-none
                             text-[13px] font-semibold text-tx/80 flex items-center gap-2 transition-colors
                             hover:bg-bg-iconbutton-button-hover"
                                        title={modelLabel}
                                    >
                                        <span className="max-w-[160px] truncate">{modelLabel}</span>
                                        <ChevronDown className="w-4 h-4 opacity-70" />
                                    </button>
                                </DropdownMenu.Trigger>

                                <DropdownMenu.Portal>
                                    <DropdownMenu.Content
                                        forceMount
                                        side="top"
                                        align="end"
                                        sideOffset={8}
                                        className={clsx(
                                            "ui-panel-motion",
                                            "z-50 min-w-[260px] overflow-hidden rounded-xl select-none",
                                            "border border-border bg-bg-chatarea",
                                            "shadow-lg"
                                        )}
                                    >
                                        {favoriteModels.length === 0 ? (
                                            <div className="px-3 py-3 text-xs font-semibold text-tx select-none">
                                                Go to Settings → Models to enable any model there.
                                            </div>
                                        ) : (
                                            favoriteModels.map((model) => (
                                                <DropdownMenu.Item
                                                    key={model.id}
                                                    onSelect={() => handleModelChange(model.id)}
                                                    disabled={!model.available}
                                                    className={clsx(
                                                        "ui-fast px-3 py-2 text-[13px] font-semibold text-tx cursor-pointer outline-none transition-colors select-none",
                                                        model.available
                                                            ? "hover:bg-bg-sidebar-button-hover"
                                                            : "opacity-50 cursor-not-allowed"
                                                    )}
                                                >
                                                    {model.name}
                                                </DropdownMenu.Item>
                                            ))
                                        )}
                                    </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                            </DropdownMenu.Root>

                            <button
                                onClick={isBusy ? handleStop : handleSend}
                                disabled={
                                    !selectedId
                                    || (!isBusy && (
                                        (!input.trim() && draftAttachments.length === 0)
                                        || strategyNeedsSwitch
                                        || hasPendingAttachment
                                        || hasUnsupportedAttachment
                                    ))
                                }
                                className={clsx(
                                    "ui-fast ui-press h-10 w-10 rounded-full grid place-items-center transition-colors",
                                    "cursor-pointer hover:bg-bg-iconbutton-button-hover",
                                    "disabled:opacity-50 disabled:cursor-not-allowed"
                                )}
                                aria-label={isBusy ? "Stop generating" : "Send"}
                                title={
                                    hasPendingAttachment
                                        ? "Attachment is still uploading."
                                        : hasUnsupportedAttachment
                                            ? "Current model does not support this file type."
                                            : undefined
                                }
                            >
                                {isBusy ? (
                                    <Square className="w-4 h-4 fill-current text-tx/80" strokeWidth={0} />
                                ) : (
                                    <ArrowUp className="w-5 h-5 text-tx/80" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
                </div>
            </div>
        </div>
    )
}
