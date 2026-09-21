// 分类文件夹 CDP 自测：增删改 / 导入归组 / 移动 / 删除语义
// 前提：npm run dev 已启动（9222）。用法：node scripts/selftest-groups.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const errors = []
const tmp = mkdtempSync(join(tmpdir(), 'lexbench-groups-'))
const nonce = String(Date.now())
const docPath = join(tmp, `分组自测文书_${nonce}.txt`).replace(/\//g, '\\')
writeFileSync(
  docPath,
  ['第一条　这是分组自测用的法规条文一。', '第二条　这是分组自测用的法规条文二。', '第三条　这是分组自测用的法规条文三。'].join('\n'),
  'utf-8'
)

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

const GROUP = `自测分组_${nonce}`

// 2. 建分组 + 校验
const created = await api(`groups.create('statute', '${GROUP}')`)
check('建分类文件夹', !!created?.id && created.doc_type === 'statute' && created.doc_count === 0)
const dup = await tryErr(`groups.create('statute', '${GROUP}')`)
check('同类型重名被拒', dup?.__error === '已存在同名分类')
const empty = await tryErr(`groups.create('statute', '   ')`)
check('空名称被拒', empty?.__error === '分类名称不能为空')
const sameNameOtherType = await api(`groups.create('book', '${GROUP}')`)
check('不同类型可同名', !!sameNameOtherType?.id)
await api(`groups.remove(${sameNameOtherType.id})`)

// 3. 导入时按分类名自动归组
const imported = await api(`library.importDocuments([${JSON.stringify(docPath)}], '${GROUP}', 'statute')`)
const item = Array.isArray(imported) ? imported[0] : null
check('导入成功', item?.status === 'imported')
const docId = item?.document_id
const docs = await api('library.listDocuments()')
const doc = (docs ?? []).find((d) => d.id === docId)
check('文档自动归入该文件夹', doc?.group_id === created.id && doc?.category === GROUP)
const listed = await api(`groups.list('statute')`)
const mine = (listed ?? []).find((g) => g.id === created.id)
check('分组列表计数正确（1 篇）', mine?.doc_count === 1)

// 4. 改名：文档跟随
const NEW_NAME = `${GROUP}_改`
await api(`groups.rename(${created.id}, '${NEW_NAME}')`)
const docs2 = await api('library.listDocuments()')
const doc2 = (docs2 ?? []).find((d) => d.id === docId)
check('改名后文档跟随', doc2?.category === NEW_NAME)

// 5. 移动文档：移出到未分类，再移回来
await api(`library.setDocumentGroup(${docId}, null)`)
let doc3 = ((await api('library.listDocuments()')) ?? []).find((d) => d.id === docId)
check('移出文件夹（未分类）', doc3?.group_id === null && doc3?.category === '')
await api(`library.setDocumentGroup(${docId}, ${created.id})`)
doc3 = ((await api('library.listDocuments()')) ?? []).find((d) => d.id === docId)
check('移回文件夹', doc3?.group_id === created.id)

// 6. 删除分组：文档保留并移入未分类
await api(`groups.remove(${created.id})`)
const afterDel = ((await api('library.listDocuments()')) ?? []).find((d) => d.id === docId)
const groupsAfter = await api(`groups.list('statute')`)
check(
  '删除分组：文档保留且移入未分类',
  !!afterDel && afterDel.group_id === null && !(groupsAfter ?? []).some((g) => g.id === created.id)
)

// 7. 拖动排序：两个文件夹交换顺序后，列表顺序应随之变化
const gA = await api(`groups.create('case', '自测排序A_${nonce}')`)
const gB = await api(`groups.create('case', '自测排序B_${nonce}')`)
let caseGroups = (await api(`groups.list('case')`)) ?? []
const orderBefore = caseGroups.filter((g) => g.id === gA.id || g.id === gB.id).map((g) => g.name)
await api(`groups.reorder(${JSON.stringify([gB.id, gA.id])})`)
caseGroups = (await api(`groups.list('case')`)) ?? []
const orderAfter = caseGroups.filter((g) => g.id === gA.id || g.id === gB.id).map((g) => g.name)
check(
  '拖动排序生效（A,B → B,A）',
  orderBefore.join() === [gA.name, gB.name].join() && orderAfter.join() === [gB.name, gA.name].join()
)
await api(`groups.remove(${gA.id})`)
await api(`groups.remove(${gB.id})`)

// 8. 「移动到…」下拉的收起行为（回归：此前点别处不关、点框体还会连带打开文档）
await evalJs('location.reload()')
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) break
}
await send('Runtime.enable', {})
await evalJs(`[...document.querySelectorAll('.tab')].find((b) => b.textContent.includes('文档库')).click()`)
await new Promise((r) => setTimeout(r, 600))

const openMover = await evalJs(`(() => {
  const btn = document.querySelector('.move-btn')
  if (!btn) return 'NO-BTN'
  btn.click()
  return 'ok'
})()`)
await new Promise((r) => setTimeout(r, 400))
check('点「⇄」弹出移动下拉', openMover === 'ok' && (await evalJs(`!!document.querySelector('.move-select')`)) === true)

// 点页面别处 → 应收起
await evalJs(`document.querySelector('.library')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
await new Promise((r) => setTimeout(r, 400))
check('点别处后下拉自动收起', (await evalJs(`!document.querySelector('.move-select')`)) === true)

// 点下拉框体本身 → 不应连带打开文档（阅读器/阅读页不应出现）
await evalJs(`document.querySelector('.move-btn')?.click()`)
await new Promise((r) => setTimeout(r, 300))
const stillOpen = await evalJs(`!!document.querySelector('.move-select')`)
await evalJs(`(() => { const s = document.querySelector('.move-select'); s?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok' })()`)
await new Promise((r) => setTimeout(r, 500))
// 判据：主区域仍停在欢迎页（.welcome）说明没有误打开文档
const openedDoc = await evalJs(`!document.querySelector('.welcome')`)
check('点下拉框体不会误打开文档', stillOpen === true && !openedDoc)

// 9. 清理测试文档
await api(`library.deleteDocument(${docId})`)
const finalDocs = await api('library.listDocuments()')
check('测试文档已清理', (finalDocs ?? []).every((d) => d.id !== docId))

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
