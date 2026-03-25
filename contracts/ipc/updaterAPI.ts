export type UpdateReadyPayload = {
    version: string
}

export interface UpdaterAPI {
    onUpdateReady(cb: (data: UpdateReadyPayload) => void): void
    restart(): void
}

declare global {
    interface Window {
        updater: UpdaterAPI
    }
}

export {}
