import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { autoUpdater } from 'electron-updater'

app.setName('AfferLab')


import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { initDB, closeDB, getDB } from './db'
import { registerAllIPC } from './ipc'
import dotenv from 'dotenv'
import { registerDefaultEmbeddingsProviders } from './core/embeddings/registerDefaultProviders'
import { getAppSettings } from './engine/settings/services/settingsStore'
import { createMainWindow, createSplashWindow } from './app/main/createMainWindow'
import { registerRuntime } from './app/bootstrap/registerRuntime'
import { applyNativeTheme, isThemeSource, registerThemeIPC } from './app/theme/nativeTheme'
import { registerStrategies } from './strategies'
import { IPC } from './ipc/channels'
import type {
  UpdateReadyPayload,
  UpdaterStatusSnapshot,
} from '../contracts/ipc/updaterAPI'

dotenv.config()

const menu = Menu.buildFromTemplate([
  {
    label: 'AfferLab',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  },
  {
    label: 'File',
    submenu: [
      { role: 'close' }
    ]
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' }
    ]
  },
  {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' }
    ]
  },
  {
    label: 'Help',
    submenu: []
  }
])

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

declare global {
  // eslint-disable-next-line no-var
  var __filename: string
  // eslint-disable-next-line no-var
  var __dirname: string
}


global.__filename = __filename
global.__dirname = __dirname

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

const isMac = process.platform === 'darwin'

let updaterStatus: UpdaterStatusSnapshot = { kind: 'idle' }
let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null

function broadcastToAllWindows(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        win.webContents.send(channel, payload)
    }
}

function setUpdaterStatus(next: UpdaterStatusSnapshot): void {
    updaterStatus = next
    broadcastToAllWindows(IPC.UPDATE_STATUS, next)
}

function initAutoUpdater(): void {
    ipcMain.on(IPC.UPDATE_RESTART, () => {
        autoUpdater.quitAndInstall()
    })
    ipcMain.handle(IPC.UPDATE_GET_STATUS, () => updaterStatus)
    ipcMain.handle(IPC.UPDATE_CHECK, async () => {
        if (!app.isPackaged) {
            const next: UpdaterStatusSnapshot = {
                kind: 'unavailable',
                message: 'Updates can be checked in packaged builds.',
            }
            setUpdaterStatus(next)
            return next
        }

        setUpdaterStatus({ kind: 'checking' })

        try {
            const result = await autoUpdater.checkForUpdates()
            await result?.downloadPromise
            return updaterStatus
        } catch (error) {
            const next: UpdaterStatusSnapshot = {
                kind: 'error',
                message: error instanceof Error ? error.message : String(error),
            }
            setUpdaterStatus(next)
            return next
        }
    })

    if (!app.isPackaged) {
        console.log('[updater] skipped in development')
        setUpdaterStatus({
            kind: 'unavailable',
            message: 'Updates can be checked in packaged builds.',
        })
        return
    }

    autoUpdater.on('checking-for-update', () => {
        console.log('[updater] checking for updates')
        setUpdaterStatus({ kind: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
        console.log(`[updater] update available: ${info.version}`)
        setUpdaterStatus({ kind: 'available', version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
        console.log('[updater] no update available')
        setUpdaterStatus({ kind: 'current' })
    })

    autoUpdater.on('error', (error) => {
        console.error('[updater] failed to check for updates', error)
        setUpdaterStatus({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
        })
    })

    autoUpdater.on('update-downloaded', (info) => {
        console.log(`[updater] update downloaded: ${info.version}`)
        setUpdaterStatus({ kind: 'ready', version: info.version })
        const payload: UpdateReadyPayload = {
            version: info.version,
        }
        broadcastToAllWindows(IPC.UPDATE_READY, payload)
    })

    void autoUpdater.checkForUpdatesAndNotify().catch((error) => {
        console.error('[updater] checkForUpdatesAndNotify failed', error)
    })
}

function openMainWindow(): BrowserWindow {
    const win = createMainWindow({
        publicPath: process.env.VITE_PUBLIC,
        rendererDist: RENDERER_DIST,
        preloadPath: path.join(__dirname, 'preload.mjs'),
        devServerUrl: VITE_DEV_SERVER_URL,
    })

    mainWindow = win
    win.on('closed', () => {
        if (mainWindow === win) {
            mainWindow = null
        }
    })

    return win
}

function openSplashWindow(): BrowserWindow {
    const win = createSplashWindow({
        publicPath: process.env.VITE_PUBLIC,
    })

    splashWindow = win
    win.on('closed', () => {
        if (splashWindow === win) {
            splashWindow = null
        }
    })

    return win
}


function openStartupWindows(): void {
    const bounceId = isMac ? (app.dock.bounce as (type: string) => number)('indefinite') : null
    const splash = isMac ? null : openSplashWindow()
    const win = openMainWindow()

    win.once('ready-to-show', () => {
        if (isMac && bounceId !== null) {
            app.dock.cancelBounce(bounceId)
        }
        if (splash && !splash.isDestroyed()) {
            splash.close()
        }
        if (!win.isDestroyed()) {
            win.show()
        }
        registerStrategies()
        initAutoUpdater()
    })
}

registerRuntime({
  createWindow: openStartupWindows,
  clearWindow: () => {},
  closeDatabase: closeDB,
})

registerThemeIPC()

app.whenReady().then(async () => {

  Menu.setApplicationMenu(menu)

  registerDefaultEmbeddingsProviders()
  initDB()
  const appSettings = getAppSettings(getDB())
  applyNativeTheme(isThemeSource(appSettings.theme_mode) ? appSettings.theme_mode : 'system')

  registerAllIPC()
  console.log('IPC registered')

  openStartupWindows()
})
