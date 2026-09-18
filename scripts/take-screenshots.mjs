// README 界面截图：驱动真实应用拍摄三个场景
// 前提：npm run dev 已启动（9222）。用法：node scripts/take-screenshots.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'screenshots')

const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = pages.find((p) => p.type === 'page' && /localhost:5173/.test(p.url))
if (!page) {
  console.log('FAIL: 未找到应用页面')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
}
await new Promise((r) => (ws.onopen = r))
console.log('[check] ws 已连接')

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return r.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等应用挂载
for (let i = 0; i < 20; i++) {
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) break
  await sleep(500)
}
console.log('[check] 应用已挂载')

/** 在搜索框输入并点「检索」，等结果出现 */
async function search(query) {
  await evalJs(`(() => {
    const input = document.querySelector('.search-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(query)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await evalJs(`
    [...document.querySelectorAll('button')].find((b) => b.textContent.replace(/\\s/g, '').includes('检索')).click()
  `)
  await sleep(1500)
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('capture timeout')), ms))])

async function shot(name) {
  mkdirSync(OUT, { recursive: true })
  // 窗口最小化/遮挡时 Chromium 不出帧，captureScreenshot 会永远等待：
  // 先把窗口带到前台，再截图；仍超时则用 fromSurface:false（直接取窗口内容）
  await send('Page.bringToFront', {}).catch(() => {})
  await sleep(300)
  let r
  try {
    r = await withTimeout(send('Page.captureScreenshot', { format: 'png' }), 8000)
  } catch {
    r = await withTimeout(
      send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
      8000
    )
  }
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
  console.log('已保存', name)
}

// 场景1：法条定位 + 阅读器
await search('民法典 1077')
await sleep(800)
await shot('01-locate.png')

// 场景2：全文检索高亮
await search('离婚 冷静期')
await sleep(800)
await shot('02-fulltext.png')

// 场景3：文档库
await evalJs(`[...document.querySelectorAll('.tab')].find((b) => b.textContent.includes('文档库')).click()`)
await sleep(600)
await shot('03-library.png')

console.log('完成')
process.exit(0)
