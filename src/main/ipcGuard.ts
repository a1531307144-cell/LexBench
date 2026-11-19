// IPC 来源校验：高权限通道（文件读写 / 数据包 / AI 密钥 / 更新安装）只接受应用自己的页面。
//
// 为什么需要：preload 暴露的是同一套 API，主窗与 AI 窗共用；一旦将来新增窗口
// 或某个窗口被导航到外部页面，不校验来源就等于把本机文件与密钥交给对方。
// 导航防护是第一道闸，这里是不依赖「导航是否封死」的第二道。

import { app, type IpcMainInvokeEvent } from 'electron'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 应用自带 renderer 的 file:// 前缀（打包版 out/renderer/）。
 * 用 pathToFileURL 而不是手拼：安装路径含 `#`/空格/中文、或 asar 路径时，
 * 手拼出的前缀与 Electron 实际 URL 的百分号编码对不上，会把全部 IPC 误判成非法来源。
 */
function rendererFileBase(): string {
  const dir = join(__dirname, '../renderer')
  return pathToFileURL(dir.endsWith(sep) ? dir : dir + sep).href.toLowerCase()
}

/** URL 是否属于应用自身（打包版 file:// 自带页面；开发版允许 dev server 同源） */
function isTrustedUrl(raw: string): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (url.protocol === 'file:') {
    return url.href.toLowerCase().startsWith(rendererFileBase())
  }

  if (!app.isPackaged) {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!dev) return false
    try {
      return url.origin === new URL(dev).origin
    } catch {
      return false
    }
  }
  return false
}

/** 校验失败直接抛中文错误（经 IPC reject 到渲染层错误条） */
export function assertAppSender(event: IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url ?? event.sender.getURL()
  if (!isTrustedUrl(frameUrl)) throw new Error('非法的调用来源')
}
