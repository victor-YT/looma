import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC, type AllowedChannel } from '../ipc/channels'

const allowed = new Set<AllowedChannel>(Object.values(IPC))

export function safeInvoke<R = unknown, A extends unknown[] = unknown[]>(
    channel: AllowedChannel,
    ...args: A
): Promise<R> {
    if (!allowed.has(channel)) {
        throw new Error(`IPC channel not allowed: ${channel as string}`)
    }
    return ipcRenderer.invoke(channel, ...args)
}

export function safeOn<T>(
    channel: AllowedChannel,
    listener: (event: IpcRendererEvent, data: T) => void
): () => void {
    if (!allowed.has(channel)) {
        throw new Error(`IPC channel not allowed: ${channel as string}`)
    }
    const wrapped = (event: IpcRendererEvent, payload: unknown) => {
        listener(event, payload as T)
    }
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
}

export function safeSend<A extends unknown[] = unknown[]>(
    channel: AllowedChannel,
    ...args: A
): void {
    if (!allowed.has(channel)) {
        throw new Error(`IPC channel not allowed: ${channel as string}`)
    }
    ipcRenderer.send(channel, ...args)
}

export function safeRemoveAll(channel: AllowedChannel): void {
    if (!allowed.has(channel)) {
        throw new Error(`IPC channel not allowed: ${channel as string}`)
    }
    ipcRenderer.removeAllListeners(channel)
}
