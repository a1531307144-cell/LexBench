// v0.4.0 研究工作台 CDP 自测：专题/收藏/笔记/排序/导出 全链路
// 前提：npm run dev 已启动（9222），库里已有可检索法条（先跑过 selftest-core.mjs）
// 用法：node scripts/selftest-workspace.mjs
import { readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const errors = []

const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
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
await new Promise((r) => (ws.onopen = r))
await send('Runtime.enable', {})

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || String(r.exceptionDetails) }
  return r.result.value
}

const api = (call) => evalJs(`window.lexbench.${call}`)
const tryErr = async (call) => {
  // 期望抛错的调用：抓住 Error.message 返回 {__error}
  return evalJs(`window.lexbench.${call}.catch((e) => ({ __error: e.message }))`)
}

// 等应用挂载
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

const tmp = mkdtempSync(join(tmpdir(), 'lexbench-selftest-'))
const results = []
const check = (name, ok) => {
  results.push([name, ok])
  console.log((ok ? '✅' : '❌'), name)
}

// 定位一条法条作为收藏素材
const locate = await api(`search.run('民法典 1077', 'auto')`)
const articleId = locate?.results?.[0]?.id
const locate2 = await api(`search.run('民法典 1076', 'auto')`)
const articleId2 = locate2?.results?.[0]?.id
check('前置：法条定位可用（1077/1076）', !!articleId && !!articleId2)

// 2. 建专题 + 重名拒绝
const topic = await api(`workspace.createTopic('自测专题', '阶段2全链路自测')`)
check('建专题', !!topic?.id)
const dup = await tryErr(`workspace.createTopic('自测专题')`)
check('重名专题被拒', dup?.__error === '已存在同名专题')

// 3. 收藏 + 幂等去重
const added = await api(`workspace.addTopicItem(${topic.id}, ${articleId})`)
check('收藏法条', added?.status === 'added')
const again = await api(`workspace.addTopicItem(${topic.id}, ${articleId})`)
check('重复收藏返回 duplicate', again?.status === 'duplicate' && again.itemId === added.itemId)

// 第二条 + 上移排序
await api(`workspace.addTopicItem(${topic.id}, ${articleId2})`)
let detail = await api(`workspace.getTopic(${topic.id})`)
check('专题含 2 条且按收藏序', detail?.items?.length === 2 && detail.items[0].article_id === articleId)
await api(`workspace.moveTopicItem(${topic.id}, ${articleId2}, 'up')`)
detail = await api(`workspace.getTopic(${topic.id})`)
check('上移后顺序交换', detail.items[0].article_id === articleId2)

// 4. 笔记（关联条文 + 专题级）
const note1 = await api(`workspace.createNote(${topic.id}, ${articleId}, '**要点**：冷静期 30 日，注意起算点')`)
check('建关联笔记（带条文标签）', !!note1?.id && note1.article_label === '第一千零七十七条')
const note2 = await api(`workspace.createNote(${topic.id}, null, '专题级备忘：先梳理协议离婚与诉讼离婚的界分')`)
check('建专题级笔记（article_label 为空）', !!note2?.id && note2.article_label === null)
await api(`workspace.updateNote(${note2.id}, '专题级备忘（已更新）')`)
detail = await api(`workspace.getTopic(${topic.id})`)
check('笔记更新生效（共 2 则）', detail.notes.length === 2 && detail.notes.some((n) => n.content_md.includes('已更新')))

// 5. 导出（走 __testSave 通道，跳过系统对话框）
const mdPath = join(tmp, 'report.md').replace(/\//g, '\\')
const mdOut = await api(`export.__testSaveTopicReport(${topic.id}, 'md', ${JSON.stringify(mdPath)})`)
let mdText = ''
try { mdText = readFileSync(mdPath, 'utf-8') } catch { /* 读取失败走断言 */ }
check(
  '导出 Markdown（结构完整）',
  mdOut?.path === mdPath && mdText.includes('# 自测专题') && mdText.includes('第一千零七') && mdText.includes('**笔记**') && mdText.includes('导出自 LexBench')
)
const docxPath = join(tmp, 'report.docx').replace(/\//g, '\\')
const docxOut = await api(`export.__testSaveTopicReport(${topic.id}, 'docx', ${JSON.stringify(docxPath)})`)
let docxHead = ''
try { docxHead = readFileSync(docxPath).subarray(0, 2).toString('latin1') } catch { /* 读取失败走断言 */ }
check('导出 Word（zip 魔数 PK + 非空）', docxOut?.path === docxPath && docxHead === 'PK' && statSync(docxPath).size > 1000)

// 6. 更新专题描述 + 列表计数
await api(`workspace.updateTopic(${topic.id}, { description: '描述已更新' })`)
const topics = await api('workspace.listTopics()')
const self = topics.find((t) => t.id === topic.id)
check('列表计数与描述（2 条 · 2 记）', self?.item_count === 2 && self?.note_count === 2 && self.description === '描述已更新')

// 6.5 笔记与法条的绑定：写笔记自动收进专题，移出法条连带带走笔记
//     （此前两头都能漏：未收藏时前端会把 article_id 悄悄写成 null；移出法条又不删笔记，
//      都会留下「专题里有笔记、却没有对应法条」的孤儿状态）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bindTopic = await api(`workspace.createTopic('自测绑定_' + Date.now())`)
const loc3 = await api(`search.run('民法典 1075', 'auto')`)
const a3 = loc3?.results?.[0]?.id
check('前置：1075 可定位', !!a3)
const n3 = await api(`workspace.createNote(${bindTopic.id}, ${a3}, '未收藏就先记的笔记')`)
check('笔记建成功且带条文标签', !!n3?.id && n3.article_label === '第一千零七十五条')
let bind = await api(`workspace.getTopic(${bindTopic.id})`)
check('写笔记时未收藏的法条被自动收进专题', bind.items.some((i) => i.article_id === a3))
check('专题条目带回笔记数 note_count', bind.items.find((i) => i.article_id === a3)?.note_count === 1)
await api(`workspace.removeTopicItem(${bindTopic.id}, ${a3})`)
bind = await api(`workspace.getTopic(${bindTopic.id})`)
check('移出法条时连带删除其笔记（不留孤儿）', bind.items.length === 0 && bind.notes.length === 0)

// 6.6 界面：中栏常驻检索条只在打开专题时出现（看文档库时仍是左右两栏）
//      api() 直接调 IPC、绕过 App 的状态刷新，所以建完专题要刷新页面再驱动界面；
//      另外得先放一条法条进去，条目行才有得验。
const uiTopic = await api(`workspace.createTopic('自测界面_' + Date.now())`)
await api(`workspace.addTopicItem(${uiTopic.id}, ${articleId})`)
await evalJs(`location.reload(); true`)
await sleep(2500)
await evalJs(`(() => { const x=[...document.querySelectorAll('.tab')].find(e=>e.textContent.includes('专题')); x && x.click(); return true })()`)
await sleep(600)
check('没打开专题时不出现中栏检索条（停在专题列表）', (await evalJs(`!!document.querySelector('.mid-search')`)) === false)
const opened = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.tp-row-name')]
  const r = rows.find((e) => e.textContent.includes('自测界面_'))
  if (!r) return false
  r.click()
  return true
})()`)
await sleep(800)
check('打开专题后中栏出现常驻检索条', opened === true && (await evalJs(`!!document.querySelector('.mid-search .search-input')`)) === true)
await evalJs(`(() => { const x=[...document.querySelectorAll('.tab')].find(e=>e.textContent.includes('文档库')); x && x.click(); return true })()`)
await sleep(600)
check('看文档库时中栏检索条消失', (await evalJs(`!!document.querySelector('.mid-search')`)) === false)
check('看文档库时右栏笔记面板也不出现（保持左右两栏）', (await evalJs(`!!document.querySelector('.np')`)) === false)
await evalJs(`(() => { const x=[...document.querySelectorAll('.tab')].find(e=>e.textContent.includes('专题')); x && x.click(); return true })()`)
await sleep(700)

// 6.7 界面：专题条目显示法规简称，全名走悬停
const shortShown = await evalJs(`(() => {
  const el = document.querySelector('.tp-item-doc')
  if (!el) return 'NO-EL'
  return JSON.stringify({ text: el.textContent.trim(), title: el.getAttribute('title') || '' })
})()`)
let shortInfo = null
try { shortInfo = JSON.parse(shortShown) } catch { /* 断言失败 */ }
check(
  '专题条目的法规名用简称显示、悬停给全名',
  !!shortInfo && shortInfo.text.length > 0 && shortInfo.title.length > shortInfo.text.length
)

await api(`workspace.deleteTopic(${bindTopic.id})`)
await api(`workspace.deleteTopic(${uiTopic.id})`)

// 7. 清理（删笔记/移出/删专题）
await api(`workspace.deleteNote(${note1.id})`)
await api(`workspace.deleteNote(${note2.id})`)
await api(`workspace.removeTopicItem(${topic.id}, ${articleId})`)
await api(`workspace.removeTopicItem(${topic.id}, ${articleId2})`)
const gone = await tryErr(`workspace.removeTopicItem(${topic.id}, ${articleId})`)
check('移出后重复移出报错', gone?.__error === '该法条不在此专题中')
await api(`workspace.deleteTopic(${topic.id})`)
const after = (await api('workspace.listTopics()')).find((t) => t.id === topic.id)
check('专题已删除', after === undefined)

rmSync(tmp, { recursive: true, force: true })

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
