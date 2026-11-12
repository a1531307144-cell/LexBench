import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { applyNavigationGuards } from './windowGuards'
import { setupUpdater } from './updater'
import { registerLibraryIpc } from './library'
import { registerAnnotationsIpc, isAnnotationContextActive } from './annotations'
import { registerOutlinesIpc } from './outlines'
import { registerParallelViewsIpc } from './parallelViews'
import { registerSearchIpc } from './search'
import { registerReadingIpc } from './reading'
import { registerBackupIpc } from './backup'
import { applySeedIfNeeded } from './seed'
import { reindexFtsIfNeeded } from './reindex'
import { repairSubbranchIfNeeded } from './repairSubbranch'
import { registerGroupsIpc } from './groups'
import { registerSettingsIpc } from './settings'
import { registerAiIpc } from './ai'
import { closeAiWindow, registerAiWindowIpc } from './aiWindow'
import { getSetting, initDb } from './db'
import { themeWindowBackground } from '@shared/themes'

/** 主窗口引用（AI 独立窗口向它转发引用跳转/可见性同步用） */
let mainWindow: BrowserWindow | null = null

/** 已答完「关窗前冲刷」的窗口：再收到 close 就直接放行，避免无限拦 */
const closeFlushAcked = new WeakSet<BrowserWindow>()

/** 用户在「还没建出窗口」期间又启动了一次：窗口一出来就聚焦（首启预置法条可能数十秒） */
let showWhenReady = false

/** 关窗前问渲染层要一次落盘（笔记 500ms 防抖窗口内关窗会丢最后一笔）；
 *  兜底：渲染层卡死/崩溃时 2s 后强制放行，不能变成关不掉 */
function askRendererFlush(win: BrowserWindow): void {
  win.webContents.send('app:before-close')
  setTimeout(() => {
    if (win.isDestroyed() || closeFlushAcked.has(win)) return
    closeFlushAcked.add(win)
    win.close()
  }, 2000)
}

/** 唯一的主窗口（单窗口 + 左侧导航；资料库型应用，无标签页） */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '法研台',
    // 开发版任务栏/窗口图标；打包版由 electron-builder 把 build/icon.ico 嵌进 exe
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.ico'),
    // 载入前底色跟随已保存的主题，深色主题启动不闪白
    backgroundColor: themeWindowBackground(getSetting('ui:theme')),
    // 无边框窗口：去掉系统标题栏，控制按钮由顶栏自绘（ VS Code / Notion 方案）
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 内置 PDF 阅读器（Chromium/PDFium）需要启用插件支持
      plugins: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    if (showWhenReady) {
      showWhenReady = false
      win.focus()
    }
  })
  mainWindow = win
  win.on('closed', () => {
    mainWindow = null
    // 主窗口是应用主体：它关掉后 AI 独立窗若还留着，window-all-closed 永远不会触发，
    // 进程就变成「看不见也回不到界面」的僵尸进程。这里一并关掉。
    closeAiWindow()
  })
  win.on('close', (e) => {
    if (closeFlushAcked.has(win) || win.webContents.isDestroyed()) return
    e.preventDefault()
    askRendererFlush(win)
  })

  // 自绘标题栏的窗口控制（渲染进程按钮 → IPC）。
  // 按 event.sender 定位窗口——主窗与 AI 独立窗共用这三条通道，
  // 否则 AI 窗点 ─□✕ 会操作到主窗口（多窗口化的必修坑）。
  // 注册挪到模块级只做一次（createWindow 可能被多次调用，重复 on 会叠监听器）。

  // 导航防护由模块级 app.on('web-contents-created') 统一挂载（见 windowGuards.ts）：
  // 主窗口、AI 独立窗以及将来新增的任何窗口都在创建时自动受保护。

  // 右键上下文菜单（Electron 默认没有 → 此前右键毫无反应，「选中后复制不了」的根因）：
  // 输入框给 剪切/复制/粘贴，正文选中给 复制，其它给 全选——右键永远有可用项；
  // 法规全页阅读内且有选中时，追加「添加批注」（上下文开关由阅读页挂载/卸载控制）
  win.webContents.on('context-menu', (_e, params) => {
    const template: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      template.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      )
    } else if (params.selectionText) {
      template.push({ role: 'copy', label: '复制' })
      if (isAnnotationContextActive()) {
        template.push(
          { type: 'separator' },
          {
            label: '添加批注',
            click: () => win.webContents.send('annotations:addRequest')
          }
        )
      }
      template.push({ type: 'separator' }, { role: 'selectAll', label: '全选' })
    } else {
      template.push({ role: 'selectAll', label: '全选' })
    }
    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: win })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 开发环境强制隔离（用户 2026-10-17 硬性要求）：dev 数据一律走 %APPDATA%\lexbench-dev，
// 与用户真实库（打包版默认 userData）物理分开——用户的库只有用户自己安装/升级应用时才会变化，
// 开发/自测永不触碰。LEXBENCH_USERDATA 仍可显式覆盖（一次性隔离自测等特殊场景）。
//
// 必须在 requestSingleInstanceLock() 之前执行：单实例锁是按 userData 目录落的，
// 放在后面会让 dev 与安装版共用同一把锁（安装版开着时 dev 一启动就自己退出）。
if (!app.isPackaged) {
  const devUserData = process.env.LEXBENCH_USERDATA || join(app.getPath('appData'), 'lexbench-dev')
  app.setPath('userData', devUserData)
}

// 任何新建的 webContents（主窗口 / AI 独立窗 / 将来新增的窗口）在创建瞬间就挂上导航防护
app.on('web-contents-created', (_e, contents) => applyNavigationGuards(contents))

// 单实例锁：第二个实例直接退出，避免两个进程同时读写同一个 sqlite 文件。
// 首启要在无窗口状态下导入预置法条（可能数十秒），用户很容易以为没启动而再点一次图标。
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      // 首启预置法条期间还没有窗口：记下「用户想要界面」，窗口一出来就聚焦
      showWhenReady = true
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

// 预加载 API 白名单（只读接口）
ipcMain.handle('app:getVersion', () => app.getVersion())

// 自绘标题栏窗口控制：按 event.sender 定位（主窗与 AI 独立窗共用，各管各的窗口）
ipcMain.on('win:minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize()
})
ipcMain.on('win:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
})
ipcMain.on('win:close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close()
})

// 渲染层答「已落盘」：主进程据此真正关窗（拿不到窗口就当已关，别挂着）
ipcMain.on('app:flush-done', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  closeFlushAcked.add(w)
  w.close()
})

// 数据包导入完成后重启软件（重新加载暂存的数据库与原件）
ipcMain.handle('app:relaunch', () => {
  app.relaunch()
  app.exit(0)
})

app.whenReady().then(async () => {
  // 没拿到单实例锁的进程正在退出，不要再跑迁移/建窗
  if (!hasSingleInstanceLock) return
  // 显式初始化（跑迁移）：此前由 workspace 注册顺带调用，专题切除后必须自己保证
  initDb()
  registerLibraryIpc()
  registerSearchIpc()
  registerReadingIpc()
  registerBackupIpc()
  registerGroupsIpc()
  registerSettingsIpc()
  registerAiIpc()
  registerAnnotationsIpc()
  registerOutlinesIpc()
  registerParallelViewsIpc()
  registerAiWindowIpc(() => mainWindow)
  // 存量数据修复：旧版吞进正文的分编标题行还原（必须先于 FTS 重建，见 repairSubbranch.ts）
  repairSubbranchIfNeeded()
  // 存量库索引升级/旧分词修复：fts_version 不符时全量重建一次（失败不阻断启动）
  reindexFtsIfNeeded()
  // 首次启动预置常用法条（仅首跑执行一次；失败不阻断启动）
  await applySeedIfNeeded()
  createWindow()
  setupUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 开发模式开放调试端口（自测/排查用；必须在 app ready 前注册；打包版不开启）
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}
