import { IPC } from '../ipc/channels'
import { safeOn, safeSend } from './ipcHelpers'
import type { UpdateReadyPayload, UpdaterAPI } from '../../contracts/ipc/updaterAPI'

let updateReadyCallback: ((data: UpdateReadyPayload) => void) | null = null
let latestUpdateReadyPayload: UpdateReadyPayload | null = null
let isBound = false

function bindUpdateReadyListener(): void {
    if (isBound) return
    isBound = true
    safeOn<UpdateReadyPayload>(IPC.UPDATE_READY, (_event, data) => {
        latestUpdateReadyPayload = data
        updateReadyCallback?.(data)
    })
}

export function createUpdaterAPI(): UpdaterAPI {
    bindUpdateReadyListener()

    return {
        onUpdateReady: (callback) => {
            updateReadyCallback = callback
            if (latestUpdateReadyPayload) {
                callback(latestUpdateReadyPayload)
            }
        },
        restart: () => {
            safeSend(IPC.UPDATE_RESTART)
        },
    }
}
