import { contextBridge } from 'electron'
import { createChatAPI } from './chatAPI'
import { createMemoryCloudAPI } from './memoryCloudAPI'
import { createToolAPI } from './toolAPI'
import { createApi } from './api'
import { createElectronAPI } from './electronAPI'
import { createUpdaterAPI } from './updaterAPI'

contextBridge.exposeInMainWorld('chatAPI', createChatAPI())
contextBridge.exposeInMainWorld('memoryCloudAPI', createMemoryCloudAPI())
contextBridge.exposeInMainWorld('toolAPI', createToolAPI())
contextBridge.exposeInMainWorld('api', createApi())
contextBridge.exposeInMainWorld('electronAPI', createElectronAPI())
contextBridge.exposeInMainWorld('updater', createUpdaterAPI())
