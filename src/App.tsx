import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import ThemeProvider from "@/app/providers/ThemeProvider"
import { Toaster } from "@/shared/ui/sonner"
import ChatPage from "@/features/chat/pages/ChatPage"
import SettingsPage from "@/features/settings/shell/SettingsPage"
import AfferLabHome from "@/features/home/pages/AfferLabHome"
import ChatShell from "@/features/chat/pages/ChatShell"
import UpdateModal from "@/components/UpdateModal"

// Settings subpages
import ModelSettings from "@/features/models/providers/pages/ModelSettings"
import ModelSettingsPage from "@/features/models/defaults/pages/ModelSettingsPage"
import StrategySettings from "@/features/strategies/pages/StrategySettings"
import GeneralSettings from "@/features/settings/general/pages/GeneralSettings"
import PrivacySettings from "@/features/settings/privacy/pages/PrivacySettings"

export default function App() {
    return (
        <BrowserRouter>
            <ThemeProvider>
                <div className="min-h-screen text-[var(--color-text)] transition-colors duration-1000 ease-in-out">
                    <Routes>
                        <Route path="/" element={<ChatShell />}>
                            {/* Chat */}
                            <Route index element={<ChatPage />} />

                            {/* AfferLab home */}
                            <Route path="afferlab" element={<AfferLabHome />} />
                        </Route>

                        {/* Settings area + nested routing */}
                        <Route path="/settings" element={<SettingsPage />}>
                            <Route index element={<Navigate to="model" replace />} />
                            <Route path="model" element={<ModelSettings />} />
                            <Route path="model-settings" element={<ModelSettingsPage />} />
                            <Route path="strategy" element={<StrategySettings />} />
                            <Route path="general" element={<GeneralSettings />} />
                            <Route path="privacy" element={<PrivacySettings />} />
                        </Route>
                    </Routes>
                    <UpdateModal />
                    <Toaster />
                </div>
            </ThemeProvider>
        </BrowserRouter>
    )
}
