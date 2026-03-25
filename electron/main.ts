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
import { createMainWindow } from './app/main/createMainWindow'
import { registerRuntime } from './app/bootstrap/registerRuntime'
import { applyNativeTheme, isThemeSource, registerThemeIPC } from './app/theme/nativeTheme'
import { registerStrategies } from './strategies'
import { IPC } from './ipc/channels'
import type { UpdateReadyPayload } from '../contracts/ipc/updaterAPI'

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

function initAutoUpdater(): void {
    ipcMain.on(IPC.UPDATE_RESTART, () => {
        autoUpdater.quitAndInstall()
    })

    if (!app.isPackaged) {
        console.log('[updater] skipped in development')
        return
    }

    autoUpdater.on('checking-for-update', () => {
        console.log('[updater] checking for updates')
    })

    autoUpdater.on('update-available', (info) => {
        console.log(`[updater] update available: ${info.version}`)
    })

    autoUpdater.on('update-not-available', () => {
        console.log('[updater] no update available')
    })

    autoUpdater.on('error', (error) => {
        console.error('[updater] failed to check for updates', error)
    })

    autoUpdater.on('update-downloaded', (info) => {
        console.log(`[updater] update downloaded: ${info.version}`)
        const payload: UpdateReadyPayload = {
            version: info.version,
        }
        for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed()) continue
            win.webContents.send(IPC.UPDATE_READY, payload)
        }
    })

    void autoUpdater.checkForUpdatesAndNotify().catch((error) => {
        console.error('[updater] checkForUpdatesAndNotify failed', error)
    })
}

function openMainWindow(): void {
  createMainWindow({
    publicPath: process.env.VITE_PUBLIC,
    rendererDist: RENDERER_DIST,
    preloadPath: path.join(__dirname, 'preload.mjs'),
    devServerUrl: VITE_DEV_SERVER_URL,
  })
}

registerRuntime({
  createWindow: openMainWindow,
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

  registerStrategies()

  registerAllIPC()

  openMainWindow()
  initAutoUpdater()
})
