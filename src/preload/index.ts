import { contextBridge, ipcRenderer } from 'electron'
import type { UpdateCheckInfo, UpdateStatus } from '../shared/ipc'

/**
 * 渲染进程唯一的能力出口（白名单 API）。
 * 原则：渲染进程不接触任何文件路径；一切文件操作经由主进程完成。
 * 业务域（library/reader/workspace/ai…）随阶段1+ 按此模式扩充。
 */
const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion')
  },
  update: {
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    download: (): Promise<void> => ipcRenderer.invoke('update:download'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    /** 「关于」用：上次自动检查是否失败（失败时提示是网络问题，避免误以为没有新版） */
    getCheckInfo: (): Promise<UpdateCheckInfo> => ipcRenderer.invoke('update:getCheckInfo'),
    /** 仅开发模式存在：置位/复位「自动检查失败」标志（自测用） */
    __testSetCheckFailed: (v: boolean): Promise<void> =>
      ipcRenderer.invoke('update:__testSetCheckFailed', v),
    onStatus: (cb: (status: UpdateStatus) => void): void => {
      ipcRenderer.on('update:status', (_e, status: UpdateStatus) => cb(status))
    }
  }
}

export type LexBenchApi = typeof api

contextBridge.exposeInMainWorld('lexbench', api)
