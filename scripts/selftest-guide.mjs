// 使用指引 CDP 自测：首启欢迎 → 九步走完 → 示例笔记保留 → 关于回放 → 跳过/已读落库。
// 前提：dev 已启动，且以 `LEXBENCH_FORCE_ONBOARDING=1 npm run dev` 模拟「全新安装」
//（打包版忽略这个环境变量）。用法：node scripts/selftest-guide.mjs
const GUIDE_KEY = 'onboarding:guide:v1'
const SAMPLE_TITLE = '使用指引示例'
const errors = []

const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = pages.find((p) => p.type === 'page' && /localhost:5173/.test(p.url) && !p.url.includes('aiWindow'))
if (!page) {
  console.log('FAIL: 未找到应用页面（dev 未启动？）')
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
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 1000))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('CONSOLE-ERROR: ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 1000))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
    const text = m.params.args.map((a) => a.value || a.description || '').join(' ')
    if (text.includes('[Vue warn]')) errors.push('VUE-WARN: ' + text.slice(0, 1000))
  }
}
await new Promise((r) => (ws.onopen = r))
await send('Runtime.enable', {})
await send('Page.enable', {})

const evalJs = async (expression) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('EVALJS_TIMEOUT(15s)')), 15000))
  ]).catch((e) => ({ exceptionDetails: { exception: { description: String(e) } } }))
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || 'eval error' }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if ((await evalJs(`(${fn})()`)) === true) return true
    await sleep(250)
  }
  return false
}
const waitMounted = async () => {
  for (let i = 0; i < 30; i++) {
    if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) return true
    await sleep(300)
  }
  return false
}
const stepText = () => evalJs(`document.querySelector('.guide-count')?.textContent?.trim() ?? null`)
const waitStep = async (n) => until(`() => document.querySelector('.guide-count')?.textContent?.trim().startsWith('${n} /')`)

await send('Page.bringToFront')
if (!(await waitMounted())) {
  console.log('FAIL: 应用未挂载')
  process.exit(1)
}

const firstRun = await evalJs(`window.lexbench.library.getSeedInfo().then((i) => i.firstRun)`)
if (firstRun !== true) {
  console.log('FAIL: 当前 dev 未模拟全新安装。请用 LEXBENCH_FORCE_ONBOARDING=1 重启 dev 后再跑。')
  process.exit(1)
}

// 清场：删掉上一轮示例笔记、把指引状态置空，再重载
await evalJs(`(async () => {
  const l = await window.lexbench.outlines.list()
  for (const n of l) if (n.title === '${SAMPLE_TITLE}') await window.lexbench.outlines.remove(n.id)
  await window.lexbench.settings.set('${GUIDE_KEY}', '')
  return true
})()`)
await send('Page.reload', {})
await sleep(2600)
await waitMounted()
await sleep(1200)
errors.length = 0

let welcomeOk = false
let step1Ok = false
let step2Ok = false
let step3Ok = false
let step4Ok = false
let step5Ok = false
let step6Ok = false
let step7Ok = false
let step8Ok = false
let finishOk = false
let persistedOk = false
let sampleKeptOk = false
let restoredOk = false
let replayOk = false

welcomeOk = (await evalJs(`!!document.querySelector('.guide-welcome')`)) === true
if (!welcomeOk) {
  console.log('FAIL: 首启欢迎卡没有出现')
  console.log(errors.join('\n') || '(无控制台错误)')
  process.exit(1)
}
console.log('=== 1. 首启欢迎卡 OK ===')

await evalJs(`document.querySelector('.guide-welcome .guide-btn.primary')?.click()`)
step1Ok = await waitStep(1)
step1Ok = step1Ok && (await until(`() => !!document.querySelector('.guide-hole') && !!document.querySelector('.guide-tip.ready')`))

// 点高亮目标即前进（混合交互）
await evalJs(`(() => {
  const el = document.querySelector('[data-guide="rail-library"]')
  if (!el) return false
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
})()`)
step2Ok = await waitStep(2)
// 洞内可真实输入检索词
const typed = await evalJs(`(() => {
  const inp = document.querySelector('.search-input')
  if (!inp) return false
  inp.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(inp, '违约责任')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return document.activeElement === inp && inp.value === '违约责任'
})()`)
step2Ok = step2Ok && typed
await evalJs(`document.querySelector('.search-input')?.blur()`)

console.log('=== 2. 文档库/检索交互 OK ===')

await evalJs(`document.querySelector('.guide-tip .guide-btn.primary')?.click()`)
step3Ok = await waitStep(3)
step3Ok = step3Ok && (await until(`() => !!document.querySelector('.sv-top') && !!document.querySelector('.guide-hole')`))

await evalJs(`document.querySelector('.guide-tip .guide-btn.primary')?.click()`)
step4Ok = await waitStep(4)
step4Ok = step4Ok && (await until(`() => document.querySelector('.rail-panel')?.classList.contains('open') && !!document.querySelector('.guide-hole')`))
const ctaText = await evalJs(`document.querySelector('.guide-tip .guide-btn.primary')?.textContent?.trim()`)
step4Ok = step4Ok && ctaText === '创建示例笔记'

await evalJs(`document.querySelector('.guide-tip .guide-btn.primary')?.click()`)
step5Ok = await waitStep(5)
step5Ok =
  step5Ok &&
  (await until(
    `() => !!document.querySelector('.ol-head') && document.querySelector('.ol-title')?.value === '${SAMPLE_TITLE}'`
  ))
const sampleInDb = await evalJs(`window.lexbench.outlines.list().then((l) => l.some((n) => n.title === '${SAMPLE_TITLE}'))`)
step5Ok = step5Ok && sampleInDb === true

console.log('=== 3. 阅读/笔记/大纲 OK ===')

await evalJs(`document.querySelector('.guide-tip .guide-btn.primary')?.click()`)
step6Ok = await waitStep(6)
step6Ok = step6Ok && (await until(`() => document.querySelectorAll('jmnode').length >= 2 && !!document.querySelector('.guide-hole')`))
const mapOn = await evalJs(`[...document.querySelectorAll('.ol-view-switch button')].find((b) => b.textContent.trim() === '导图')?.classList.contains('on') === true`)
step6Ok = step6Ok && mapOn === true

await evalJs(`document.querySelector('.guide-tip .guide-btn.primary')?.click()`)
step7Ok = await waitStep(7)
await evalJs(`document.querySelector('.guide-tip .guide-btn.primary')?.click()`)
step8Ok = await waitStep(8)

console.log('=== 4. 导图/AI/数据 OK ===')

await evalJs(`document.querySelector('.guide-tip .guide-btn.primary')?.click()`)
const finishCard = await until(`() => !!document.querySelector('.guide-finish')`)
if (finishCard) {
  await evalJs(`document.querySelector('.guide-finish .guide-btn.primary')?.click()`)
}
finishOk = finishCard && (await until(`() => !document.querySelector('.guide-layer')`))
persistedOk = (await evalJs(`window.lexbench.settings.get('${GUIDE_KEY}')`)) === 'done'
sampleKeptOk = (await evalJs(`window.lexbench.outlines.list().then((l) => l.filter((n) => n.title === '${SAMPLE_TITLE}').length === 1)`)) === true
restoredOk = await evalJs(`(() => {
  const active = document.querySelector('.rail-item.active .rail-label')?.textContent?.trim()
  return active === '文档库' && !document.querySelector('.sv-top') && !document.querySelector('.ol-head')
})()`)

console.log('=== 5. 完成/落库/现场恢复 OK ===')

// 关于 → 使用指引回放；Esc 退出
await evalJs(`[...document.querySelectorAll('.top-btn')].find((b) => b.textContent.trim() === '关于')?.click()`)
await sleep(300)
await evalJs(`[...document.querySelectorAll('.ab-btn')].find((b) => b.textContent.trim() === '使用指引')?.click()`)
replayOk = await waitStep(1)
replayOk = replayOk && (await until(`() => !!document.querySelector('.guide-tip.ready') && !document.querySelector('.guide-welcome')`))
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
replayOk = replayOk && (await until(`() => !document.querySelector('.guide-layer')`))
const skippedKey = await evalJs(`window.lexbench.settings.get('${GUIDE_KEY}')`)
replayOk = replayOk && skippedKey === 'skipped'

console.log('=== 6. 关于回放 + Esc 跳过 OK ===')

// 收尾：删除示例笔记，状态置空（方便反复跑）
await evalJs(`(async () => {
  const l = await window.lexbench.outlines.list()
  for (const n of l) if (n.title === '${SAMPLE_TITLE}') await window.lexbench.outlines.remove(n.id)
  await window.lexbench.settings.set('${GUIDE_KEY}', '')
  return true
})()`)

console.log('\n=== 结论 ===')
const checks = [
  ['首启欢迎卡', welcomeOk],
  ['第 1 步文档库', step1Ok],
  ['第 2 步检索可输入', step2Ok],
  ['第 3 步阅读法条', step3Ok],
  ['第 4 步笔记面板 + CTA', step4Ok],
  ['第 5 步示例笔记 + 大纲', step5Ok],
  ['第 6 步导图', step6Ok],
  ['第 7 步 AI', step7Ok],
  ['第 8 步数据', step8Ok],
  ['第 9 步完成', finishOk],
  ['完成状态落库', persistedOk],
  ['示例笔记保留', sampleKeptOk],
  ['结束恢复原现场', restoredOk],
  ['关于回放 + Esc 跳过', replayOk],
  ['零控制台错误', errors.length === 0]
]
let pass = true
for (const [name, ok] of checks) {
  console.log((ok ? '✅' : '❌'), name)
  if (!ok) pass = false
}
if (errors.length) console.log('\n控制台错误详情:\n' + errors.join('\n'))
process.exit(pass ? 0 : 1)
