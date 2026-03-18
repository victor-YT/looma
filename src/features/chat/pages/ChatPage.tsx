import ChatArea from "@/features/chat/components/ChatArea"
import ChatInput from "@/features/chat/components/ChatInput"
import DevPanel from "@/features/strategy-dev/components/DevPanel"
import { useChatStore } from "@/features/chat/state/chatStore"
import { useDevUiStore } from "@/features/strategy-dev/state/devUiStore"
import { Navigate } from "react-router-dom"

const DEV_PANEL_WIDTH = 360

export default function ChatPage() {
    const selectedConversationId = useChatStore((s) => s.selectedConversationId)
    const conversations = useChatStore((s) => s.conversations)
    const selectedConversation = conversations.find((c) => c.id === selectedConversationId) ?? null
    const isDevConversation = Boolean(selectedConversation?.strategy_id?.startsWith("dev:"))
    const devPanelOpen = useDevUiStore((s) => s.devPanelOpen)

    if (!selectedConversationId) {
        return <Navigate to="/looma" replace />
    }

    return (
        <div className="flex flex-1 min-h-0 relative">
            <div className="relative flex flex-col flex-1 min-w-0">
                <ChatArea className="flex-1 min-h-0" />
                <ChatInput />
            </div>
            {isDevConversation && devPanelOpen ? (
                <div className="shrink-0 h-full border-l border-border/60" style={{ width: DEV_PANEL_WIDTH }}>
                    <DevPanel />
                </div>
            ) : null}
        </div>
    )
}
