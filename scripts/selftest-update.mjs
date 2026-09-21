// 自动更新（界面部分）CDP 自测：关于对话框 / 版本显示 / 手动检查更新 / 开发版提示
// 真实打包版的更新链路另用「打包 + 低版本运行」实测（见项目记忆），此脚本覆盖界面与交互
// 前提：npm run dev 已启动（9222）。用法：node scripts/selftest-update.mjs
const errors = []

const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = pages.find((p) => p.type === 'page' && /localhost:5173/.test(p.url))
if (!page) {
  console.log('FAIL: dev 未启动')
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
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 1200))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('CONSOLE-ERROR: ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 1200))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
    const text = m.params.args.map((a) => a.value || a.description || '').join(' ')
    if (text.includes('[Vue warn]')) errors.push('VUE-WARN: ' + text.slice(0, 1200))
  }
}
await new Promise((r) => (ws.onopen = r))
await send('Runtime.enable', {})

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || String(r.exceptionDetails) }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let mounted = false
for (let i = 0; i < 20; i++) {
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) { mounted = true; break }
  await sleep(500)
}
if (!mounted) {
  console.log('FAIL: 应用未挂载')
  process.exit(1)
}
console.log('=== 1. UI 挂载 OK ===')

const results = []
const check = (name, ok) => {
  results.push([name, ok])
  console.log((ok ? '✅' : '❌'), name)
}

// 2. 打开「关于」
const opened = await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.top-btn')].find((b) => b.textContent.trim() === '关于')
  if (!btn) return 'NO-BTN'
  btn.click()
  return 'clicked'
})()`)
await sleep(700)
const dialog = await evalJs(`(() => {
  const d = document.querySelector('.ab-dialog')
  if (!d) return null
  return { 版本行: d.querySelector('.ab-ver')?.textContent?.trim() ?? '', 状态行: d.querySelector('.ab-status')?.textContent?.trim() ?? '' }
})()`)
check('「关于」按钮打开对话框', opened === 'clicked' && !!dialog)
check('显示当前版本号', /v\d+\.\d+\.\d+/.test(dialog?.['版本行'] ?? ''))
check('显示更新说明（自动检查/由你决定）', (dialog?.['状态行'] ?? '').includes('自动检查'))

// 3. 手动检查更新（开发版应回「开发版不检查更新」）
const checked = await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.ab-dialog .ab-btn')].find((b) => b.textContent.trim().includes('检查'))
  if (!btn) return 'NO-BTN'
  btn.click()
  return 'clicked'
})()`)
let devMsg = ''
for (let i = 0; i < 16; i++) {
  await sleep(400)
  devMsg = await evalJs(`document.querySelector('.ab-dialog .ab-status')?.textContent?.trim() ?? ''`)
  if (devMsg.includes('开发版')) break
}
check('手动检查更新有响应（开发版提示）', checked === 'clicked' && devMsg.includes('开发版不检查更新'))

// 4. 关闭对话框
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.ab-dialog .ab-btn')].find((b) => b.textContent.trim() === '关闭')
  btn?.click()
  return 'ok'
})()`)
await sleep(500)
const closed = await evalJs(`!document.querySelector('.ab-dialog')`)
check('对话框可关闭', closed === true)

// 5. 更新提示组件仍挂载（空闲时不渲染内容，验证订阅链路不报错即可）
const toastProbe = await evalJs(`typeof window.lexbench.update.onStatus === 'function'`)
check('更新状态订阅接口可用', toastProbe === true)

console.log('\n=== 结论 ===')
let pass = true
for (const [, ok] of results) if (!ok) pass = false
if (errors.length) {
  pass = false
  console.log('\n控制台错误:\n' + errors.join('\n'))
} else {
  console.log('零控制台错误')
}
process.exit(pass ? 0 : 1)
