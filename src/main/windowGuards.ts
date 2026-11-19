// 窗口导航防护（主窗口 / AI 独立窗 / 将来任何新窗口共用）
//
// 为什么必须是「所有窗口」：每次顶层导航都会重新执行该窗口的 preload，而 preload 末尾
// contextBridge.exposeInMainWorld 会把整套 window.lexbench 白名单交给新页面。若某个窗口
// 漏了拦截，用户点一下 AI 回答里的 Markdown 链接，外部页面就能读到全部笔记与法条库、
// 甚至调用删除类 IPC。因此这里用 app 级 web-contents-created 兜底，不依赖每个窗口自觉注册。
//
// 规则：
// - window.open / target=_blank 一律 deny；https 交给系统默认浏览器；
// - 顶层导航（will-navigate / will-frame-navigate 主框架）拦截外部地址，https 交给系统浏览器；
// - 服务端重定向（will-redirect）同样拦截；
// - 子框架只允许 blob: / about: / 应用自身 / Chromium 内置 PDF 查看器；
// - 所有权限请求默认拒绝（只放行全屏与用户主动复制）。

import { shell, type WebContents } from 'electron'

/** 已处理过的 contents（web-contents-created 与显式调用可能同时到达，避免重复挂监听） */
const guarded = new WeakSet<WebContents>()
/** 已设置过权限处理器的 session（同一 session 只设一次） */
const guardedSessions = new WeakSet<Electron.Session>()

/**
 * Chromium 内置 PDF 查看器（Electron `plugins: true`）。
 * 打开 PDF 时它会创建插件子框架并导航到这个扩展地址；拦掉就等于 PDF 一片空白。
 */
const PDF_VIEWER_PREFIX = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'

/** 站内地址：顶层导航到自身（重载 / 同一 URL）直接放行；file: 必须逐路径比较 */
function isSelf(contents: WebContents, url: string): boolean {
  const current = contents.getURL()
  if (url === current) return true
  try {
    const next = new URL(url)
    const cur = new URL(current)
    if (next.protocol !== cur.protocol) return false
    // file: 的 origin 恒为 'null'，直接比 origin 会让任意本地文件都算「同源」
    if (next.protocol === 'file:') return next.pathname === cur.pathname
    if (next.protocol === 'http:' || next.protocol === 'https:') {
      return next.origin === cur.origin
    }
    // data:/blob:/javascript: 等一律不算站内
    return false
  } catch {
    return false
  }
}

/** 外链去重：will-frame-navigate 与 will-navigate 在部分版本会同时派发 */
let lastExternalUrl = ''
let lastExternalAt = 0
function openExternalOnce(url: string): void {
  const now = Date.now()
  if (url === lastExternalUrl && now - lastExternalAt < 1000) return
  lastExternalUrl = url
  lastExternalAt = now
  void shell.openExternal(url)
}

/** 主框架导航的统一处理：站内放行，外部拦截并把 https 交给系统浏览器 */
function handleTopNavigation(contents: WebContents, event: Electron.Event, url: string): void {
  if (isSelf(contents, url)) return
  event.preventDefault()
  if (url.startsWith('https://')) openExternalOnce(url)
}

export function applyNavigationGuards(contents: WebContents): void {
  if (guarded.has(contents)) return
  guarded.add(contents)

  contents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https://')) openExternalOnce(details.url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (e, url) => handleTopNavigation(contents, e, url))

  // 服务端 302 不会触发 will-navigate，必须单独拦
  contents.on('will-redirect', (e, url) => handleTopNavigation(contents, e, url))

  // 子框架（iframe）：只允许同源、本地 blob: 与 Chromium 内置 PDF 查看器。
  // 注意：主框架也会派发本事件，而且一旦在这里 preventDefault，will-navigate 就不再派发——
  // 所以主框架必须在这里完成「站内放行 / 外链交系统浏览器」的完整处理。
  contents.on('will-frame-navigate', (e) => {
    let proto = ''
    try {
      proto = new URL(e.url).protocol
    } catch {
      e.preventDefault()
      return
    }

    if (e.isMainFrame) {
      handleTopNavigation(contents, e, e.url)
      return
    }

    if (proto === 'blob:' || proto === 'about:') return
    if (e.url.startsWith(PDF_VIEWER_PREFIX)) return
    if (isSelf(contents, e.url)) return
    e.preventDefault()
  })

  // 权限：默认拒绝；只放行全屏与「用户主动复制」这类无害能力
  const session = contents.session
  if (!guardedSessions.has(session)) {
    guardedSessions.add(session)
    const allowed = new Set(['fullscreen', 'clipboard-sanitized-write'])
    session.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(allowed.has(permission))
    )
    session.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  }
}
