// AI 独立窗口（2026-10-17 用户定位：浮窗 = 真·独立窗口）
// - 第二个 BrowserWindow：系统原生标题栏自带拖动/缩放/右上角关闭，与主窗口互不隶属；
// - 不设 alwaysOnTop（用户红线：不得永远前置）；不设 parent（真独立，主窗口最小化不影响它）；
// - 渲染同一份 renderer，以 ?aiWindow=1 分支挂载 AiFloatWindow 壳（见 renderer main.ts）；
// - 会话内记忆窗口位置尺寸（hide 时存 bounds，重建时恢复）。

import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'

let aiWin: BrowserWindow | null = null
/** 最近一次的位置尺寸（hide/close 时保存，重建恢复） */
let lastBounds: Electron.Rectangle | null = null

/** 转发通道：AI 窗点引用 → 主窗口打开对应法条 */
const OPEN_ARTICLE_CHANNEL = 'aiwin:openArticle'
/** 转发通道：AI 窗可见性变化 → 主窗口顶栏按钮态同步 */
const VISIBILITY_CHANNEL = 'aiwin:visibility'

function notifyVisibility(getMainWindow: () => BrowserWindow | null): void {
  const main = getMainWindow()
  if (main && !main.isDestroyed()) {
    main.webContents.send(VISIBILITY_CHANNEL, !!aiWin && aiWin.isVisible())
  }
}

function createAiWindow(getMainWindow: () => BrowserWindow | null): void {
  const base = {
    width: 420,
    height: 560,
    minWidth: 320,
    minHeight: 260,
    show: false,
    title: 'AI 助手',
    backgroundColor: '#f5f5f7', // 与主窗口同底（载入前的窗口底色）
    // 无边框 + 自绘标题栏（用户 2026-10-17：风格必须延续主窗口——同顶栏配方、同 ─□✕ 按钮；
    // 拖动走 -webkit-app-region、缩放走无边框窗口边缘命中，与主窗口同一套机制）
    frame: false,
    // 刻意不设 alwaysOnTop：独立但不永远前置（用户红线）
    alwaysOnTop: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
  const win = new BrowserWindow(lastBounds ? { ...base, ...lastBounds } : base)
  aiWin = win

  win.once('ready-to-show', () => win.show())
  // hide（顶栏开关切走）与 close（右上角 ✕）都记下几何，下次原样恢复
  const remember = (): void => {
    try {
      if (!win.isDestroyed()) lastBounds = win.getBounds()
    } catch {
      /* 窗口已不可用 */
    }
  }
  win.on('hide', remember)
  win.on('close', remember)
  win.on('closed', () => {
    aiWin = null
    notifyVisibility(getMainWindow)
  })
  win.on('show', () => notifyVisibility(getMainWindow))
  win.on('hide', () => notifyVisibility(getMainWindow))

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win.loadURL(`${rendererUrl}/?aiWindow=1`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: 'aiWindow=1' })
  }
}

/** 顶栏开关：开 → 已存在则显示并聚焦、不存在则新建；关（已显示）→ 隐藏（保留状态秒开） */
export function toggleAiWindow(getMainWindow: () => BrowserWindow | null): void {
  if (aiWin && !aiWin.isDestroyed()) {
    if (aiWin.isVisible()) {
      aiWin.hide()
    } else {
      aiWin.show()
      aiWin.focus()
    }
    notifyVisibility(getMainWindow)
    return
  }
  createAiWindow(getMainWindow)
}

export function registerAiWindowIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('aiWindow:toggle', () => toggleAiWindow(getMainWindow))
  // AI 窗内点引用 → 转给主窗口打开对应法条（AI 窗自己不动，保持独立）
  ipcMain.handle('aiWindow:openArticle', (_e, articleId: number): void => {
    const main = getMainWindow()
    if (main && !main.isDestroyed()) main.webContents.send(OPEN_ARTICLE_CHANNEL, Number(articleId))
  })
}
