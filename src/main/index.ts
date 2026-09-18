import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { setupUpdater } from './updater'
import { registerLibraryIpc } from './library'
import { registerSearchIpc } from './search'

/** 唯一的主窗口（单窗口 + 左侧导航；资料库型应用，无标签页） */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '法研台',
    backgroundColor: '#f7f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  // 外部链接一律交给系统默认浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https://')) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 预加载 API 白名单（只读接口）
ipcMain.handle('app:getVersion', () => app.getVersion())

app.whenReady().then(() => {
  registerLibraryIpc()
  registerSearchIpc()
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
