// AI 助手 CDP 自测：多档案 CRUD / 密钥掩码 / 启用切换 / 未配置时的错误路径 / 归档
//   + 双协议（OpenAI 兼容 & Anthropic 兼容）：线路格式、非流式取文、流式增量、错误提示
// 协议部分对着本机假服务端跑（127.0.0.1 临时端口），无需真实 API Key、不联网
// 前提：npm run dev 已启动（9222）。用法：node scripts/selftest-ai.mjs
import { createServer } from 'node:http'

const errors = []
const MOCK_KEY = 'sk-' + 'm'.repeat(20) + 'key'
const ANSWER = '连接正常，这是自测用的回答。'

// ---------- 假服务端：同时会说两套协议 ----------
/** 最近一次收到的请求（供断言线路格式：路径 / 鉴权头 / 请求体） */
let lastReq = null

function sse(res, frames, delayMs = 25) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  // 分两次写：逼客户端真的走「逐块增量」路径，而不是一次读完
  const half = Math.ceil(frames.length / 2)
  res.write(frames.slice(0, half).join(''))
  setTimeout(() => {
    res.write(frames.slice(half).join(''))
    res.end()
  }, delayMs)
}

const openaiSse = () => [
  `data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"连接正常"}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"，这是自测用的回答。"}}]}\n\n`,
  `data: [DONE]\n\n`
]

const anthropicSse = () => [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}}\n\n`,
  `event: ping\ndata: {"type":"ping"}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"连接正常"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，这是自测用的回答。"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`
]

const mock = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = null
    try {
      body = JSON.parse(raw || 'null')
    } catch {
      body = null
    }
    lastReq = { path: req.url, headers: req.headers, body }
    const streaming = body?.stream === true

    if (req.url === '/openai/v1/chat/completions') {
      if (streaming) return sse(res, openaiSse())
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ANSWER } }] }))
    }
    if (req.url === '/anthropic/v1/messages') {
      if (streaming) return sse(res, anthropicSse())
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: ANSWER }],
          stop_reason: 'end_turn'
        })
      )
    }
    // 其余路径：模拟「地址填错」的网关（200 + 错误体，不是 404）
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 500, msg: '404 NOT_FOUND' }))
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const MOCK_PORT = mock.address().port
const BASE_OPENAI = `http://127.0.0.1:${MOCK_PORT}/openai/v1`
const BASE_ANTHROPIC = `http://127.0.0.1:${MOCK_PORT}/anthropic`
console.log(`假服务端已就绪：127.0.0.1:${MOCK_PORT}`)

const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = pages.find((p) => p.type === 'page' && /localhost:5173/.test(p.url))
if (!page) {
  console.log('FAIL: dev 未启动')
  mock.close()
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
  mock.close()
  process.exit(1)
}
console.log('=== 1. UI 挂载 OK ===')

const results = []
const check = (name, ok) => {
  results.push([name, ok])
  console.log((ok ? '✅' : '❌'), name)
}

const NAME = `自测档案_${Date.now()}`
/** 跑完把用户的启用档案还原回去（本脚本会把「当前」切来切去，不能留下副作用） */
const initialProfiles = await api('ai.listProfiles()')
const originalActiveId = (initialProfiles ?? []).find((p) => p.is_active === 1)?.id ?? null

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

// ---------- 8. 双协议：档案落库 + 协议字段往返 ----------
const pOpenai = await api(
  `ai.saveProfile({ name: '${NAME}_openai', baseUrl: '${BASE_OPENAI}', model: 'mock-model', protocol: 'openai', apiKey: '${MOCK_KEY}' })`
)
const pAnthropic = await api(
  `ai.saveProfile({ name: '${NAME}_anthropic', baseUrl: '${BASE_ANTHROPIC}', model: 'mock-model', protocol: 'anthropic', apiKey: '${MOCK_KEY}' })`
)
profiles = await api('ai.listProfiles()')
const rowO = (profiles ?? []).find((p) => p.id === pOpenai?.id)
const rowA = (profiles ?? []).find((p) => p.id === pAnthropic?.id)
check('协议字段落库并回读（openai）', rowO?.protocol === 'openai')
check('协议字段落库并回读（anthropic）', rowA?.protocol === 'anthropic')

// 编辑别的字段时协议不被冲掉（未传 protocol 应保留原值）
await api(`ai.saveProfile({ id: ${pAnthropic?.id}, name: '${NAME}_anthropic2', baseUrl: '${BASE_ANTHROPIC}', model: 'mock-model' })`)
profiles = await api('ai.listProfiles()')
check('不传 protocol 时保留原协议', (profiles ?? []).find((p) => p.id === pAnthropic?.id)?.protocol === 'anthropic')

// 未知协议值一律按 openai 处理
const badProto = await api(
  `ai.saveProfile({ name: '${NAME}_bad', baseUrl: '${BASE_OPENAI}', model: 'mock-model', protocol: 'gemini', apiKey: '${MOCK_KEY}' })`
)
profiles = await api('ai.listProfiles()')
check('未知协议值回落为 openai', (profiles ?? []).find((p) => p.id === badProto?.id)?.protocol === 'openai')

// ---------- 9. 双协议：测试连接（真发请求给假服务端）----------
lastReq = null
const tOpenai = await api(`ai.test({ id: ${pOpenai?.id} })`)
check('OpenAI 档案测试连接成功', tOpenai?.ok === true && String(tOpenai.reply).includes('连接正常'))
check(
  'OpenAI 线路格式：Bearer 鉴权 + 无 system 顶层字段 + 无 max_tokens',
  lastReq?.path === '/openai/v1/chat/completions' &&
    lastReq.headers.authorization === `Bearer ${MOCK_KEY}` &&
    lastReq.headers['x-api-key'] === undefined &&
    lastReq.body?.system === undefined &&
    lastReq.body?.max_tokens === undefined &&
    lastReq.body?.messages?.[0]?.role === 'user' // 探测只发一条 user，不带 system
)

lastReq = null
const tAnthropic = await api(`ai.test({ id: ${pAnthropic?.id} })`)
check(
  'Anthropic 档案测试连接成功（非流式取 content[].text）',
  tAnthropic?.ok === true && String(tAnthropic.reply).includes('连接正常')
)
check(
  'Anthropic 线路格式：x-api-key + 版本头 + Bearer（兼容只认后者的网关）、max_tokens 必填、messages 无 system',
  lastReq?.path === '/anthropic/v1/messages' &&
    lastReq.headers['x-api-key'] === MOCK_KEY &&
    typeof lastReq.headers['anthropic-version'] === 'string' &&
    lastReq.headers.authorization === `Bearer ${MOCK_KEY}` &&
    Array.isArray(lastReq.body?.messages) &&
    lastReq.body.messages.every((m) => m.role !== 'system') &&
    typeof lastReq.body?.max_tokens === 'number'
)

// 填错端点：假服务端回「200 + 错误体」，应把体内原因透出来并按协议给样例
lastReq = null
const tWrong = await api(
  `ai.test({ baseUrl: 'http://127.0.0.1:${MOCK_PORT}/nope/v1', model: 'mock-model', protocol: 'openai', apiKey: '${MOCK_KEY}' })`
)
check(
  '填错端点时透出体内错误并给地址提示',
  tWrong?.ok === false && String(tWrong.error).includes('404 NOT_FOUND') && String(tWrong.error).includes('/v1 或 /v4')
)

// ---------- 10. 双协议：流式对话（真跑 streamChat + SSE 解析 + 归档）----------
await evalJs(`(() => {
  window.__aiTest = { deltas: [], done: null }
  window.__aiTestOff = window.lexbench.ai.onProgress((p) => {
    if (p.delta) window.__aiTest.deltas.push(p.delta)
    if (p.done) window.__aiTest.done = p
  })
  return true
})()`)

async function runStreaming(profileIdValue, label) {
  await evalJs(`window.__aiTest.deltas = []; window.__aiTest.done = null`)
  const r = await api(
    `ai.run({ taskId: 'selftest-${label}-' + Date.now(), task: 'explain', articleId: ${articleId}, profileId: ${profileIdValue} })`
  )
  const got = await evalJs(`window.__aiTest.deltas.join('')`)
  const done = await evalJs(`window.__aiTest.done`)
  return { r, got, done }
}

if (!articleId) {
  check('流式对话（需要库里有法条）', false)
} else {
  lastReq = null
  const o = await runStreaming(pOpenai?.id, 'openai')
  check(
    'OpenAI 流式：增量拼成完整回答',
    o.r?.ok === true && o.got === ANSWER && o.done?.messageId > 0
  )
  check(
    'OpenAI 流式：请求带 stream:true 且 system 留在 messages',
    lastReq?.body?.stream === true &&
      lastReq?.path === '/openai/v1/chat/completions' &&
      lastReq?.body?.messages?.[0]?.role === 'system' &&
      lastReq?.body?.system === undefined
  )

  lastReq = null
  const a = await runStreaming(pAnthropic?.id, 'anthropic')
  check(
    'Anthropic 流式：content_block_delta 增量拼成完整回答',
    a.r?.ok === true && a.got === ANSWER && a.done?.messageId > 0
  )
  check(
    'Anthropic 流式：请求带 stream:true、system 在顶层、messages 无 system',
    lastReq?.body?.stream === true &&
      lastReq?.path === '/anthropic/v1/messages' &&
      typeof lastReq?.body?.system === 'string' &&
      lastReq.body.system.length > 0 &&
      lastReq?.body?.messages?.every((m) => m.role !== 'system') === true &&
      lastReq?.body?.max_tokens > 0
  )

  // 归档落库：回答与流式结果一致
  const hist = await api(`ai.history(${articleId})`)
  const lastMsg = Array.isArray(hist) ? hist[hist.length - 1] : null
  check('流式回答已归档且内容一致', !!lastMsg && JSON.stringify(lastMsg).includes(ANSWER))

  // 清理：删掉自测写入的问答（不留痕在用户的库里）
  let cleaned = true
  for (const mid of [o.done?.messageId, a.done?.messageId]) {
    if (!mid) continue
    const d = await tryErr(`ai.deleteMessage(${mid})`)
    if (d?.__error) cleaned = false
  }
  check('自测问答已清理', cleaned)
}

// 解除进度订阅（避免监听器泄漏）
await evalJs(`(() => { if (window.__aiTestOff) window.__aiTestOff(); return true })()`)

// ---------- 11. 清理测试档案 + 还原用户的启用档案 ----------
for (const pid of [profileId, pOpenai?.id, pAnthropic?.id, badProto?.id]) {
  if (pid) await api(`ai.deleteProfile(${pid})`)
}
profiles = await api('ai.listProfiles()')
check(
  '删除测试档案生效',
  !(profiles ?? []).some((p) => [profileId, pOpenai?.id, pAnthropic?.id, badProto?.id].includes(p.id))
)
if (originalActiveId != null) {
  await api(`ai.setActive(${originalActiveId})`)
  profiles = await api('ai.listProfiles()')
  check('还原原来的启用档案', (profiles ?? []).find((p) => p.id === originalActiveId)?.is_active === 1)
}

mock.close()
console.log('\n=== 结论 ===')
let pass = true
for (const [, ok] of results) if (!ok) pass = false
if (errors.length) {
  pass = false
  console.log('\n控制台错误:\n' + errors.join('\n'))
} else {
  console.log('零控制台错误')
}
console.log('（真实服务商调用仍需在界面上用真实 Key 验收；本脚本已覆盖两套协议的线路格式与流式解析）')
process.exit(pass ? 0 : 1)
