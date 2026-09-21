// AI 助手 CDP 自测（离线部分）：多档案 CRUD / 密钥掩码 / 启用切换 / 未配置时的错误路径 / 归档
// 真实模型调用不在本脚本内（需真实 API Key，由用户验收时配置测试）
// 前提：npm run dev 已启动（9222）。用法：node scripts/selftest-ai.mjs
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
const api = (call) => evalJs(`window.lexbench.${call}`)
const tryErr = (call) => evalJs(`window.lexbench.${call}.catch((e) => ({ __error: e.message }))`)

let mounted = false
for (let i = 0; i < 20; i++) {
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) { mounted = true; break }
  await new Promise((r) => setTimeout(r, 500))
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

const NAME = `自测档案_${Date.now()}`

// 2. 新建档案（密钥掩码、启用规则）
const created = await api(
  `ai.saveProfile({ name: '${NAME}', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-' + 'a'.repeat(20) + 'xyz' })`
)
check('新建档案', created?.ok === true && typeof created.id === 'number')
const profileId = created?.id

const emptyName = await api(`ai.saveProfile({ name: '   ', baseUrl: 'x', model: 'y', apiKey: 'k' })`)
check('空名称被拒', emptyName?.ok === false && emptyName.error === '档案名称不能为空')

let profiles = await api('ai.listProfiles()')
const mine = (profiles ?? []).find((p) => p.id === profileId)
check('列表含新档案且密钥是掩码', !!mine && mine.api_key_set === true && mine.api_key_masked.includes('****'))
check('掩码不含完整密钥', !!mine && !mine.api_key_masked.includes('a'.repeat(20)))

// 3. 启用切换
await api(`ai.setActive(${profileId})`)
profiles = await api('ai.listProfiles()')
check('设为当前生效', (profiles ?? []).filter((p) => p.is_active === 1).length === 1 && (profiles ?? []).find((p) => p.id === profileId)?.is_active === 1)

// 4. 更新：留空密钥=保留原值
const before = (profiles ?? []).find((p) => p.id === profileId)?.api_key_masked
await api(`ai.saveProfile({ id: ${profileId}, name: '${NAME}改', baseUrl: 'https://api.example.com/v1', model: 'test-model-2' })`)
profiles = await api('ai.listProfiles()')
const after = (profiles ?? []).find((p) => p.id === profileId)
check('改名与改模型生效', after?.name === `${NAME}改` && after?.model === 'test-model-2')
check('留空密钥保留原值', after?.api_key_masked === before)

// 5. 测试连接（假地址应返回可读的中文错误，而不是抛未捕获异常）
const testRes = await api(
  `ai.test({ baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-' + 'x'.repeat(16) })`
)
check('测试连接失败时给中文原因', testRes?.ok === false && typeof testRes.error === 'string' && testRes.error.length > 0)

// 6. 未配置档案时的 run 错误路径（用不存在的最小 id 触发「未配置」或「档案不存在」，都应报错不崩）
const runRes = await api(
  `ai.run({ taskId: 'selftest-' + Date.now(), task: 'explain', articleId: 1, profileId: -999 })`
)
check('无效档案发起任务被拒绝且不崩', runRes?.ok === false && typeof runRes.error === 'string')

// 7. 归档接口（用一条真实法条：取任意 statute 文档的第一条）
const docs = await api('library.listDocuments()')
const statute = (docs ?? []).find((d) => d.doc_type === 'statute' && d.article_count > 0)
let articleId = 0
if (statute) {
  const detail = await api(`library.getDocument(${statute.id})`)
  articleId = detail?.articles?.[0]?.id ?? 0
}
const history = articleId ? await api(`ai.history(${articleId})`) : []
check('历史接口可用（可为空数组）', Array.isArray(history))
const delBad = await tryErr(`ai.deleteMessage(-1)`)
check('删除不存在的问答报错', delBad?.__error === '该问答不存在')

// 8. 清理测试档案
await api(`ai.deleteProfile(${profileId})`)
profiles = await api('ai.listProfiles()')
check('删除档案生效', !(profiles ?? []).some((p) => p.id === profileId))

console.log('\n=== 结论 ===')
let pass = true
for (const [, ok] of results) if (!ok) pass = false
if (errors.length) {
  pass = false
  console.log('\n控制台错误:\n' + errors.join('\n'))
} else {
  console.log('零控制台错误')
}
console.log('（真实模型调用请配置档案后在界面上验收；本脚本只覆盖离线可测部分）')
process.exit(pass ? 0 : 1)
