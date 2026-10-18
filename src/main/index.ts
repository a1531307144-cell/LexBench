import { app, BrowserWindow, ClipboardItem, clipboard, ipcMain, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { setupUpdater } from './updater'
import { registerLibraryIpc } from './library'
import { registerAnnotationsIpc, isAnnotationContextActive } from './annotations'
import { registerOutlinesIpc, getRefContext, clearRefContext } from './outlines'
import { registerSearchIpc } from './search'
import { registerReadingIpc } from './reading'
import { registerBackupIpc } from './backup'
import { applySeedIfNeeded } from './seed'
import { reindexFtsIfNeeded } from './reindex'
import { repairSubbranchIfNeeded } from './repairSubbranch'
import { registerGroupsIpc } from './groups'
import { registerAiIpc } from './ai'
import { registerAiWindowIpc } from './aiWindow'
import { initDb } from './db'

/** 主窗口引用（AI 独立窗口向它转发引用跳转/可见性同步用） */
let mainWindow: BrowserWindow | null = null

/** 唯一的主窗口（单窗口 + 左侧导航；资料库型应用，无标签页） */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '法研台',
    backgroundColor: '#f5f5f7',
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
  })
  mainWindow = win
  win.on('closed', () => {
    mainWindow = null
  })

  // 自绘标题栏的窗口控制（渲染进程按钮 → IPC）。
  // 按 event.sender 定位窗口——主窗与 AI 独立窗共用这三条通道，
  // 否则 AI 窗点 ─□✕ 会操作到主窗口（多窗口化的必修坑）。
  // 注册挪到模块级只做一次（createWindow 可能被多次调用，重复 on 会叠监听器）。

  // 外部链接一律交给系统默认浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https://')) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 右键上下文菜单（Electron 默认没有 → 此前右键毫无反应，「选中后复制不了」的根因）：
  // 输入框给 剪切/复制/粘贴，正文选中给 复制，其它给 全选——右键永远有可用项；
  // 法规全页阅读内且有选中时，追加「添加批注」（上下文开关由阅读页挂载/卸载控制）
  win.webContents.on('context-menu', (_e, params) => {
    const template: MenuItemConstructorOptions[] = []
    // 笔记引用节点右键（渲染层先报 ref）：逃生门「在文档库打开来源」。
    // 引用行文本是 textarea（editable），所以不分 editable 都追加。
    const refCtx = getRefContext()
    if (refCtx) {
      template.push(
        {
          label: '在文档库打开来源',
          click: () => {
            win.webContents.send('outlines:openSource', refCtx)
            clearRefContext()
          }
        },
        { type: 'separator' }
      )
    }
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
          },
          {
            // 读→写唯一通道：复制《法规》第X条+选中原文，粘进笔记成引用节点
            label: '复制引用',
            click: () => win.webContents.send('reading:copyRefRequest')
          }
        )
      }
      template.push({ type: 'separator' }, { role: 'selectAll', label: '全选' })
    } else {
      template.push({ role: 'selectAll', label: '全选' })
    }
    const menu = Menu.buildFromTemplate(template)
    // 菜单关闭即清引用上下文（点「打开来源」除外——那里已先清）
    menu.on('menu-will-close', () => clearRefContext())
    menu.popup({ window: win })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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

// 数据包导入完成后重启软件（重新加载暂存的数据库与原件）
ipcMain.handle('app:relaunch', () => {
  app.relaunch()
  app.exit(0)
})

// 「复制引用」写剪贴板：text/plain 给任意应用干净文本，text/html 带 ref 元数据
// （笔记编辑器粘贴时据此生成引用节点；主进程 clipboard 比渲染层 navigator.clipboard 稳）
ipcMain.handle('clipboard:writeRef', (_e, payload: { text: string; html: string }): Promise<void> => {
  return clipboard.write([new ClipboardItem({ 'text/plain': payload.text, 'text/html': payload.html })])
})

app.whenReady().then(async () => {
  // 显式初始化（跑迁移）：此前由 workspace 注册顺带调用，专题切除后必须自己保证
  initDb()
  registerLibraryIpc()
  registerSearchIpc()
  registerReadingIpc()
  registerBackupIpc()
  registerGroupsIpc()
  registerAiIpc()
  registerAnnotationsIpc()
  registerOutlinesIpc()
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

// 开发环境强制隔离（用户 2026-10-17 硬性要求）：dev 数据一律走 %APPDATA%\lexbench-dev，
// 与用户真实库（打包版默认 userData）物理分开——用户的库只有用户自己安装/升级应用时才会变化，
// 开发/自测永不触碰。LEXBENCH_USERDATA 仍可显式覆盖（一次性隔离自测等特殊场景）。
if (!app.isPackaged) {
  const devUserData = process.env.LEXBENCH_USERDATA || join(app.getPath('appData'), 'lexbench-dev')
  app.setPath('userData', devUserData)
}

// 开发模式开放调试端口（自测/排查用；必须在 app ready 前注册；打包版不开启）
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}
