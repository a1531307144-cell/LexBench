// v0.3.0 核心链路 CDP 自测：导入 → 建库 → 法条定位 → 全文检索 → 阅读器翻页
// 前提：npm run dev 已启动（开发模式开放 9222）。用法：node scripts/selftest-core.mjs
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

function getJSON(url) {
  return fetch(url).then((r) => r.json())
}

const pages = await getJSON('http://127.0.0.1:9222/json')
const page = pages.find((p) => p.type === 'page' && /localhost:5173/.test(p.url))
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
    errors.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 1200))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('CONSOLE-ERROR: ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 1200))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
    // Vue 警告（如 beforeUnmount 钩子异常）会让界面状态卡死却是 warning，必须当失败对待
    const text = m.params.args.map((a) => a.value || a.description || '').join(' ')
    if (text.includes('[Vue warn]')) errors.push('VUE-WARN: ' + text.slice(0, 1200))
  }
}
await new Promise((r) => ws.onopen = r)
await send('Runtime.enable', {})

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || 'eval error' }
  return r.result.value
}

// 等应用挂载（轮询，不固定 sleep）
let mounted = false
for (let i = 0; i < 20; i++) {
  const probe = await evalJs(`!!document.querySelector('#app .topbar')`)
  if (probe === true) { mounted = true; break }
  await new Promise((r) => setTimeout(r, 500))
}
if (!mounted) {
  console.log('FAIL: 应用未挂载')
  console.log(errors.join('\n') || '(无控制台错误)')
  process.exit(1)
}
console.log('=== 1. UI 挂载 OK ===')

// 收集示例文件
const samplesDir = join(ROOT, 'samples')
const files = readdirSync(samplesDir).filter((f) => f.endsWith('.txt')).map((f) => join(samplesDir, f).replace(/\//g, '\\'))
console.log('示例文件:', files.map((f) => f.split('\\').pop()).join(', '))

// 导入（走真实主进程：mammoth/pdfjs 分词建库）
const imported = await evalJs(`window.lexbench.library.importDocuments(${JSON.stringify(files)}, '测试分类')`)
if (imported.__error) { console.log('FAIL 导入:', imported.__error); process.exit(1) }
console.log('=== 2. 导入结果 ===')
console.log(JSON.stringify(imported, null, 1))
// 幂等：首次跑为 imported，重复跑同一批文件为 duplicate（去重功能正确生效），均算通过
const allImported =
  Array.isArray(imported) && imported.every((r) => r.status === 'imported' || r.status === 'duplicate')

// 文档列表
const docs = await evalJs(`window.lexbench.library.listDocuments()`)
console.log('=== 3. 文档库 ===')
console.log((docs || []).map((d) => `${d.id}:${d.title}(${d.doc_type},${d.article_count}条,${d.status})`).join(' | '))

// 法条定位：民法典 1077
const locate = await evalJs(`window.lexbench.search.run('民法典 1077', 'auto')`)
console.log('=== 4. 法条定位「民法典 1077」===')
console.log('mode:', locate?.mode, '| 命中数:', locate?.results?.length)
console.log('首条:', JSON.stringify(locate?.results?.[0] && {
  label: locate.results[0].label, title: locate.results[0].title,
  content: (locate.results[0].content || '').slice(0, 60)
}))

// 打开该法条 + 翻页
const firstId = locate?.results?.[0]?.id
const detail = firstId ? await evalJs(`window.lexbench.library.getArticle(${firstId})`) : null
console.log('=== 5. 阅读器详情 ===')
console.log(JSON.stringify(detail && {
  label: detail.article.article_label, prev: detail.prev?.label ?? null, next: detail.next?.label ?? null
}))

// 全文检索：离婚 冷静期
const fulltext = await evalJs(`window.lexbench.search.run('离婚 冷静期', 'auto')`)
console.log('=== 6. 全文检索「离婚 冷静期」===')
console.log('mode:', fulltext?.mode, '| 命中数:', fulltext?.results?.length)
console.log('首条摘要:', (fulltext?.results?.[0]?.snippet || '').slice(0, 120))

// UI 层探测：搜索框输入 + 点击检索按钮，看结果列表真的渲染
await evalJs(`
  const input = document.querySelector('.search-input')
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('检 索') || b.textContent.includes('检索'))
  if (input && btn) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '民法典 1077')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    btn.click()
  }
  'clicked'
`)
let uiHasResults = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const probe = await evalJs(`document.querySelectorAll('.result-item, [class*=result] li, .result-list > *').length`)
  if (typeof probe === 'number' && probe > 0) { uiHasResults = true; break }
}
console.log('=== 7. UI 真实渲染结果列表 ===', uiHasResults ? 'OK' : 'FAIL（点检索后列表为空）')

console.log('\n=== 结论 ===')
const checks = [
  ['全部文件导入成功', allImported],
  ['文档库 ≥2 份', Array.isArray(docs) && docs.length >= 2],
  ['法条定位命中 1077', locate?.mode === 'locate' && locate.results.length > 0],
  ['阅读器 prev/next', !!detail && (detail.prev !== undefined)],
  ['全文检索有结果', fulltext?.mode === 'fulltext' && fulltext.results.length > 0],
  ['UI 渲染结果列表', uiHasResults],
  ['零控制台错误', errors.length === 0]
]
let pass = true
for (const [name, ok] of checks) {
  console.log((ok ? '✅' : '❌'), name)
  if (!ok) pass = false
}
if (errors.length) console.log('\n控制台错误详情:\n' + errors.join('\n'))
process.exit(pass ? 0 : 1)
