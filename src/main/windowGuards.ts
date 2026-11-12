// 窗口导航防护（主窗口 / AI 独立窗 / 将来任何新窗口共用）
//
// 为什么必须是「所有窗口」：每次顶层导航都会重新执行该窗口的 preload，而 preload 末尾
// contextBridge.exposeInMainWorld 会把整套 window.lexbench 白名单交给新页面。若某个窗口
// 漏了拦截，用户点一下 AI 回答里的 Markdown 链接，外部页面就能读到全部笔记与法条库、
// 甚至调用删除类 IPC。因此这里用 app 级 web-contents-created 兜底，不依赖每个窗口自觉注册。
//
// 规则：
// - window.open / target=_blank 一律 deny；https 交给系统默认浏览器；
// - 顶层导航（will-navigate）一律拦截，https 交系统浏览器；站内同一地址不拦。

import { shell, type WebContents } from 'electron'

/** 已处理过的 contents（web-contents-created 与显式调用可能同时到达，避免重复挂监听） */
const guarded = new WeakSet<WebContents>()

export function applyNavigationGuards(contents: WebContents): void {
  if (guarded.has(contents)) return
  guarded.add(contents)

  contents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https://')) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (e, url) => {
    if (url === contents.getURL()) return
    e.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })
}
