import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from "react"
import clsx from "clsx"
import { ChevronDown, Cloud, Plus } from "lucide-react"

import { Skeleton } from "@/shared/ui/skeleton"
import { useMemoryCloud } from "../hooks/useMemoryCloud"
import { buildAssetView } from "../utils/assetView"
import AssetChip, { type AssetChipItem } from "@/features/chat/attachments/components/AssetChip"
import { useChatStore } from "@/features/chat/state/chatStore"

type MemoryCloudBarProps = {
    conversationId: string | null
}

function dragEventHasFiles(event: React.DragEvent<HTMLElement>): boolean {
    const types = event.dataTransfer?.types
    if (!types || types.length === 0) return false
    return Array.from(types).includes("Files")
}

export default function MemoryCloudBar({ conversationId }: MemoryCloudBarProps) {
    const memoryCloudOrderByConversation = useChatStore((s) => s.memoryCloudOrderByConversation)
    const setMemoryCloudOrder = useChatStore((s) => s.setMemoryCloudOrder)
    const {
        enabled,
        checked,
        assets,
        assetsLoading,
        ingesting,
        ingestFiles,
        deleteAsset,
        disabledReason,
    } = useMemoryCloud(conversationId)

    const [expanded, setExpanded] = useState(false)
    const [draggingId, setDraggingId] = useState<string | null>(null)
    const [isDraggingFiles, setIsDraggingFiles] = useState(false)
    const [hasLeftOverflow, setHasLeftOverflow] = useState(false)
    const [hasRightOverflow, setHasRightOverflow] = useState(false)

    const wrapperRef = useRef<HTMLDivElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const stripScrollRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        setExpanded(false)
    }, [conversationId])

    useEffect(() => {
        if (!expanded) return
        const onMouseDown = (event: MouseEvent) => {
            const target = event.target as Node | null
            if (!target) return
            if (wrapperRef.current?.contains(target)) return
            setExpanded(false)
        }
        window.addEventListener("mousedown", onMouseDown)
        return () => window.removeEventListener("mousedown", onMouseDown)
    }, [expanded])

    const disabled = disabledReason === "disabled"
    const savedOrder = useMemo(
        () => (conversationId ? (memoryCloudOrderByConversation[conversationId] ?? []) : []),
        [conversationId, memoryCloudOrderByConversation]
    )

    const orderedAssets = useMemo(() => {
        if (assets.length <= 1) return assets
        const byId = new Map(assets.map((asset) => [asset.id, asset]))
        const out: typeof assets = []
        for (const id of savedOrder) {
            const hit = byId.get(id)
            if (!hit) continue
            out.push(hit)
            byId.delete(id)
        }
        for (const asset of assets) {
            if (!byId.has(asset.id)) continue
            out.push(asset)
            byId.delete(asset.id)
        }
        return out
    }, [assets, savedOrder])

    const chipItems = useMemo<AssetChipItem[]>(
        () =>
            orderedAssets.map((asset) => {
                const view = buildAssetView(asset)

                return {
                    id: asset.id,
                    name: view.name,
                    mimeType: asset.mimeType ?? "application/octet-stream",
                    size: Number.isFinite(asset.sizeBytes ?? NaN) ? Number(asset.sizeBytes) : 0,
                    kind:
                        view.kind === "image"
                            ? "image"
                            : view.kind === "audio"
                                ? "audio"
                                : view.kind === "video"
                                    ? "video"
                                    : "document",
                }
            }),
        [orderedAssets]
    )
    const hasAssets = chipItems.length > 0
    const stripContainerClass =
        "overflow-x-auto overflow-y-hidden [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
    const stripTrackClass = "flex w-max flex-nowrap items-center gap-1.5"
    const collapsedAddAssetChipClass = clsx(
        "ui-fast ui-press grid h-7 w-7 shrink-0 place-items-center rounded-3xl border border-transparent bg-bg-messagebubble-user text-tx transition-[opacity,background-color,color] duration-250 ease-out",
        disabled || ingesting
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer opacity-0 group-hover/memory-cloud:opacity-100"
    )

    useEffect(() => {
        if (!conversationId) return
        const orderedIds = orderedAssets.map((asset) => asset.id)
        const sameLength = orderedIds.length === savedOrder.length
        const sameOrder = sameLength && orderedIds.every((id, index) => savedOrder[index] === id)
        if (!sameOrder) setMemoryCloudOrder(conversationId, orderedIds)
    }, [conversationId, orderedAssets, savedOrder, setMemoryCloudOrder])

    const handleFiles = useCallback(
        async (files: FileList | File[]) => {
            if (disabled || ingesting) return
            const list = Array.from(files)
            if (!list.length) return
            await ingestFiles(list)
        },
        [disabled, ingestFiles, ingesting]
    )

    useEffect(() => {
        if (!isDraggingFiles) return
        const reset = () => setIsDraggingFiles(false)
        window.addEventListener("dragend", reset)
        window.addEventListener("drop", reset)
        window.addEventListener("blur", reset)
        return () => {
            window.removeEventListener("dragend", reset)
            window.removeEventListener("drop", reset)
            window.removeEventListener("blur", reset)
        }
    }, [isDraggingFiles])

    const handleCloudDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (disabled || ingesting || !dragEventHasFiles(event)) return
        setIsDraggingFiles(true)
    }, [disabled, ingesting])

    const handleCloudDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!dragEventHasFiles(event)) return
        const nextTarget = event.relatedTarget as Node | null
        if (nextTarget && event.currentTarget.contains(nextTarget)) return
        setIsDraggingFiles(false)
    }, [])

    const handleCloudDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (disabled || ingesting || !dragEventHasFiles(event)) return
        event.preventDefault()
        setIsDraggingFiles(true)
    }, [disabled, ingesting])

    const handleCloudDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!dragEventHasFiles(event)) return
        event.preventDefault()
        setIsDraggingFiles(false)
        void handleFiles(event.dataTransfer.files)
    }, [handleFiles])

    const moveItem = useCallback(
        (fromId: string, toId: string) => {
            if (!conversationId || !fromId || !toId || fromId === toId) return
            const ids = orderedAssets.map((asset) => asset.id)
            const fromIndex = ids.indexOf(fromId)
            const toIndex = ids.indexOf(toId)
            if (fromIndex < 0 || toIndex < 0) return
            const next = ids.slice()
            const [moved] = next.splice(fromIndex, 1)
            next.splice(toIndex, 0, moved)
            setMemoryCloudOrder(conversationId, next)
        },
        [conversationId, orderedAssets, setMemoryCloudOrder]
    )

    const handlePinCurrent = useCallback(() => {
        if (fileInputRef.current) {
            fileInputRef.current.click()
        }
    }, [])

    const updateStripOverflow = useCallback(() => {
        const el = stripScrollRef.current
        if (!el) {
            setHasLeftOverflow(false)
            setHasRightOverflow(false)
            return
        }
        const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
        const left = el.scrollLeft > 0
        const right = el.scrollLeft < (maxScrollLeft - 1)
        setHasLeftOverflow(left)
        setHasRightOverflow(right)
    }, [])

    const handleStripWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
        const el = stripScrollRef.current
        if (!el) return
        if (expanded) return

        const horizontalDelta = Math.abs(event.deltaX)
        const verticalDelta = Math.abs(event.deltaY)
        if (verticalDelta <= horizontalDelta || verticalDelta === 0) return

        const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
        if (maxScrollLeft <= 0) return

        const nextScrollLeft = el.scrollLeft + event.deltaY
        const canScrollLeft = event.deltaY < 0 && el.scrollLeft > 0
        const canScrollRight = event.deltaY > 0 && el.scrollLeft < maxScrollLeft
        if (!canScrollLeft && !canScrollRight) return

        event.preventDefault()
        el.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft))
        updateStripOverflow()
    }, [expanded, updateStripOverflow])

    useEffect(() => {
        const raf = window.requestAnimationFrame(updateStripOverflow)
        const handleResize = () => updateStripOverflow()
        window.addEventListener("resize", handleResize)
        return () => {
            window.cancelAnimationFrame(raf)
            window.removeEventListener("resize", handleResize)
        }
    }, [updateStripOverflow, chipItems.length, assetsLoading, expanded])

    const renderMemoryChip = (item: AssetChipItem, keyPrefix: string = "") => {
        return (
            <AssetChip
                key={`${keyPrefix}${item.id}`}
                item={item}
                variant="memory"
                size="sm"
                onRemove={disabled ? undefined : deleteAsset}
                showRemove={!disabled}
                onDragStart={(event) => {
                    setDraggingId(item.id)
                    event.dataTransfer.effectAllowed = "move"
                    event.dataTransfer.setData("text/plain", item.id)
                }}
                onDragOver={(event) => {
                    if (!draggingId) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = "move"
                }}
                onDrop={(event) => {
                    event.preventDefault()
                    const fromId = draggingId || event.dataTransfer.getData("text/plain")
                    if (!fromId) return
                    moveItem(fromId, item.id)
                }}
                onDragEnd={() => setDraggingId(null)}
                draggable={!disabled && chipItems.length > 1}
            />
        )
    }

    const baseBar = (
        <div
            ref={wrapperRef}
            className="group/memory-cloud relative h-full [-webkit-app-region:no-drag]"
            onDragEnter={handleCloudDragEnter}
            onDragLeave={handleCloudDragLeave}
            onDragOver={handleCloudDragOver}
            onDrop={handleCloudDrop}
            onPaste={(event) => {
                if (disabled || ingesting) return
                const files = event.clipboardData?.files
                if (files && files.length > 0) {
                    event.preventDefault()
                    void handleFiles(files)
                }
            }}
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                    if (event.target.files?.length) {
                        void handleFiles(event.target.files)
                    }
                    event.currentTarget.value = ""
                }}
            />

            <div
                className={clsx(
                    "relative flex flex-col overflow-hidden rounded-3xl border border-border/50 bg-bg-inputarea backdrop-blur-xl",
                    "transition-colors duration-200 ease-out",
                    isDraggingFiles && "bg-black/[0.04] dark:bg-white/[0.04]",
                    disabled ? "opacity-60" : undefined
                )}
            >
                <div className="flex h-9 items-center px-3">
                    <div className="flex w-full items-center">
                        <div className="mt-px relative flex h-7 w-9 shrink-0 items-center pr-2">
                            <div
                                className={clsx(
                                    "absolute inset-0 grid place-items-center text-tx transition-[opacity,transform] duration-200 ease-out",
                                    "translate-y-0 opacity-100"
                                )}
                                aria-hidden="true"
                            >
                                <Cloud className="h-4 w-4" strokeWidth={2.6} />
                            </div>
                        </div>

                        <div
                            className="relative h-7 min-w-0 flex-1 px-2"
                            title={expanded ? undefined : "Memory assets"}
                        >
                            <div
                                className={clsx(
                                    "absolute inset-0 transition-[opacity,transform] duration-200 ease-out",
                                    expanded || isDraggingFiles
                                        ? "pointer-events-none translate-y-1 opacity-0"
                                        : "translate-y-0 opacity-100"
                                )}
                            >
                                <div
                                    ref={stripScrollRef}
                                    onScroll={updateStripOverflow}
                                    onWheel={handleStripWheel}
                                    className={stripContainerClass}
                                >
                                    <div className={stripTrackClass}>
                                        {assetsLoading ? (
                                            <>
                                                <Skeleton className="h-7 w-20 rounded-md bg-bg-topbar/55" />
                                                <Skeleton className="h-7 w-20 rounded-md bg-bg-topbar/55" />
                                            </>
                                        ) : null}
                                        {!assetsLoading && hasAssets ? chipItems.map((item) => renderMemoryChip(item)) : null}
                                        {!assetsLoading ? (
                                            <button
                                                type="button"
                                                aria-label="Add to memory"
                                                disabled={disabled || ingesting}
                                                className={collapsedAddAssetChipClass}
                                                onClick={handlePinCurrent}
                                            >
                                                <Plus className="h-4 w-4" strokeWidth={2.6} />
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                                {hasAssets && hasLeftOverflow ? (
                                    <div
                                        className="pointer-events-none absolute inset-y-0 -left-1 w-10"
                                        style={{
                                            backgroundImage:
                                                "linear-gradient(to right, var(--color-bg-inputarea) 0%, color-mix(in srgb, var(--color-bg-inputarea) 72%, transparent) 48%, transparent 100%)",
                                        }}
                                    />
                                ) : null}
                                {hasAssets && hasRightOverflow ? (
                                    <div
                                        className="pointer-events-none absolute inset-y-0 -right-1 w-10"
                                        style={{
                                            backgroundImage:
                                                "linear-gradient(to left, var(--color-bg-inputarea) 0%, color-mix(in srgb, var(--color-bg-inputarea) 72%, transparent) 48%, transparent 100%)",
                                        }}
                                    />
                                ) : null}
                            </div>

                            <div
                                className={clsx(
                                    "absolute inset-0 flex items-center justify-center text-center text-xs font-medium text-tx/55 transition-[opacity,transform] duration-200 ease-out",
                                    isDraggingFiles
                                        ? "translate-y-0 opacity-100"
                                        : expanded
                                            ? "translate-y-0 opacity-100"
                                            : "pointer-events-none translate-y-[-4px] opacity-0"
                                )}
                            >
                                Drag or click to upload assets
                            </div>
                        </div>

                        <div className="ml-2 mt-px flex h-7 shrink-0 items-center gap-1">
                            {!expanded && hasRightOverflow ? (
                                <button
                                    type="button"
                                    aria-label="Add to memory"
                                    disabled={disabled || ingesting}
                                    className={clsx(
                                        collapsedAddAssetChipClass,
                                        "transition-[opacity,transform] duration-200 ease-out translate-x-0"
                                    )}
                                    onClick={handlePinCurrent}
                                >
                                    <Plus className="h-4 w-4" strokeWidth={2.6} />
                                </button>
                            ) : null}
                            <button
                                type="button"
                                aria-label={expanded ? "Collapse memory panel" : "Expand memory panel"}
                                className="ui-fast ui-press grid h-7 w-7 place-items-center rounded-full text-tx/70 transition-colors hover:bg-bg-iconbutton-button-hover hover:text-tx cursor-pointer"
                                onClick={() => setExpanded((prev) => !prev)}
                            >
                                <ChevronDown className={clsx("h-4 w-4 transition-transform duration-[160ms] ease-out", expanded && "rotate-180")} />
                            </button>
                        </div>
                    </div>
                </div>

                <div
                    className={clsx(
                        "overflow-hidden transition-[max-height,opacity] duration-[180ms] ease-out",
                        expanded ? "pointer-events-auto max-h-[40vh] opacity-100" : "pointer-events-none max-h-0 opacity-0"
                    )}
                >
                    <div className="max-h-[40vh] overflow-y-auto p-2">
                        <div className="flex flex-wrap items-start gap-1.5">
                            {assetsLoading ? (
                                <>
                                    <Skeleton className="h-7 w-20 rounded-md bg-bg-topbar/55" />
                                    <Skeleton className="h-7 w-20 rounded-md bg-bg-topbar/55" />
                                    <Skeleton className="h-7 w-20 rounded-md bg-bg-topbar/55" />
                                </>
                            ) : hasAssets ? (
                                <>
                                    {chipItems.map((item) => renderMemoryChip(item, "panel-"))}
                                    <button
                                        type="button"
                                        aria-label="Add to memory"
                                        disabled={disabled || ingesting}
                                        className={clsx(
                                            collapsedAddAssetChipClass,
                                            "opacity-100"
                                        )}
                                        onClick={handlePinCurrent}
                                    >
                                        <Plus className="h-4 w-4" strokeWidth={2.6} />
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    aria-label="Add to memory"
                                    disabled={disabled || ingesting}
                                    className={clsx(
                                        collapsedAddAssetChipClass,
                                        "opacity-100"
                                    )}
                                    onClick={handlePinCurrent}
                                >
                                    <Plus className="h-4 w-4" strokeWidth={2.6} />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

        </div>
    )

    if (disabledReason === "disabled" && checked && !enabled) {
        return null
    }

    return baseBar
}
