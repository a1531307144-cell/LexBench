import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/ipc'

/**
 * 自动更新：启动 3 秒后静默检查；发现新版本只提示，由用户决定是否下载安装。
 * 原则：更新永远不干扰使用、不擅自下载——任何网络错误只写日志，零弹窗。
 * 仅打包版启用（开发版检查更新无意义且会报错）。
 */

let manualCheck = false
/** 上次**自动**检查更新是否失败。只为「关于」里留一行小字，绝不弹窗打扰。 */
let lastAutoCheckFailed = false

function broadcast(payload: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', payload)
  }
}

export function setupUpdater(): void {
  // 「关于」对话框读取：自动检查失败时提示「是网络问题」而不是让人以为「没有新版」。
  // 开发版也要注册（返回 false），否则渲染层调用会直接报错。
  ipcMain.handle('update:getCheckInfo', () => ({ lastAutoCheckFailed }))

  // 仅开发模式：把「自动检查失败」标志置位/复位，用于实机验证「关于」的两种形态
  if (!app.isPackaged) {
    ipcMain.handle('update:__testSetCheckFailed', (_e, v: unknown) => {
      lastAutoCheckFailed = Boolean(v)
    })
  }

  // 手动「检查更新」/ 下载 / 安装：开发版也要注册（否则界面调用直接报错）；
  // 开发版不做真实检查，回一条明确状态，便于在开发窗口里验证「关于」的交互
  ipcMain.handle('update:check', () => {
    if (!app.isPackaged) {
      broadcast({ type: 'dev-mode' })
      return
    }
    manualCheck = true
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('手动检查更新失败', err)
    })
  })

  ipcMain.handle('update:download', () => {
    if (!app.isPackaged) return
    autoUpdater.downloadUpdate().catch((err) => {
      console.warn('下载更新失败', err)
    })
  })

  ipcMain.handle('update:install', () => {
    if (!app.isPackaged) return
    // 静默安装并重启（per-user 安装无需管理员权限）
    autoUpdater.quitAndInstall(true, true)
  })

  // 仅打包版启用更新检查与事件广播（开发版无 app-update.yml，检查必然失败且无意义）
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => broadcast({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    lastAutoCheckFailed = false
    broadcast({ type: 'available', version: info.version })
  })
  autoUpdater.on('download-progress', (p) =>
    broadcast({ type: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    manualCheck = false
    broadcast({ type: 'downloaded', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    const manual = manualCheck
    manualCheck = false
    lastAutoCheckFailed = false
    broadcast({ type: 'not-available', manual })
  })
  autoUpdater.on('error', (err) => {
    const manual = manualCheck
    manualCheck = false
    // 自动检查失败：记下来供「关于」展示，但界面上完全静默
    if (!manual) lastAutoCheckFailed = true
    console.warn('更新失败（不影响使用）', err)
    broadcast({ type: 'error', manual })
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      /* 自动检查失败完全静默 */
    })
  }, 3000)
}
