// 通用键值设置 IPC：settings 表是既有的 UI 偏好载体（如 reading_progress:<docId>）。
// 这里只开一个最小读写口，供渲染层保存「每篇文档的阅读缩放」这类不建表的轻量偏好；
// 不做白名单——键由渲染层约定（zoom:doc:<id>），值一律以字符串存取。

import { ipcMain } from 'electron'
import { getSetting, setSetting } from './db'

export function registerSettingsIpc(): void {
  /** 读：未设置返回 null（渲染层据此走默认值） */
  ipcMain.handle('settings:get', (_e, key: string): string | null => {
    const value = getSetting(String(key ?? ''))
    return value === undefined ? null : value
  })

  /** 写：空键拒绝（避免污染 settings 表） */
  ipcMain.handle('settings:set', (_e, key: string, value: string): void => {
    const k = String(key ?? '').trim()
    if (!k) throw new Error('设置键不能为空')
    setSetting(k, String(value ?? ''))
  })
}
