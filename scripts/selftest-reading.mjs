// v0.4.0 阅读模式 CDP 自测：书籍导入 → 批注锚定（段内+跨段）→ 高亮恢复 → 进度 → 导出 → 清理
// 前提：npm run dev 已启动（9222）。用法：node scripts/selftest-reading.mjs
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const errors = []
const tmp = mkdtempSync(join(tmpdir(), 'lexbench-reading-'))
// 造一份独一无二的书籍文本（避开哈希去重；每段一行，模拟书的段落）
const paras = []
for (let i = 1; i <= 14; i++) {
  paras.push(`第${i}节　这是阅读模式自测用的第 ${i} 段正文，用于验证书籍导入、批注锚定与高亮恢复的完整链路。`)
}
const bookPath = join(tmp, '阅读模式自测书.txt').replace(/\//g, '\\')
writeFileSync(bookPath, paras.join('\n'), 'utf-8')

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

const results = []
const check = (name, ok) => {
  results.push([name, ok])
  console.log((ok ? '✅' : '❌'), name)
}

// 2. 导入书籍（typeChoice='book'：一段一 chunk）
const imported = await api(`library.importDocuments([${JSON.stringify(bookPath)}], '', 'book')`)
const item = Array.isArray(imported) ? imported[0] : null
check('书籍导入 doc_type=book', item?.status === 'imported' && item?.doc_type === 'book')
const docId = item?.document_id

const detail = await api(`library.getDocument(${docId})`)
check('按段落建索引（14 段=14 chunk）', detail?.chunks?.length === 14 && detail.doc_type === 'book')

// 走 API 导入不会触发界面刷新列表（只有导入对话框会）——重载页面让 App 重新拉文档列表
await evalJs('location.reload()')
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) break
}
await send('Runtime.enable', {}) // 重载后重开错误收集

// 3a. 段内批注：锚定第 3 段（seq=2）
const para2 = detail.chunks.find((c) => c.seq === 2)
const quoteSame = para2.content.slice(6, 22)
const startSame = para2.content.indexOf(quoteSame)
const noteSame = await api(
  `reading.createBookNote(${docId}, { contentMd: '段内批注自测', quote: ${JSON.stringify(quoteSame)}, startPara: 2, startOffset: ${startSame}, endPara: 2, endOffset: ${startSame + quoteSame.length} })`
)
check('创建段内批注（起止同段）', !!noteSame?.id && noteSame.start_para === 2 && noteSame.end_para === 2)

// 3b. 跨段批注：第 1 段末尾 → 第 2 段开头（seq 0 → 1）
const para0 = detail.chunks.find((c) => c.seq === 0)
const para1 = detail.chunks.find((c) => c.seq === 1)
const tail0 = para0.content.slice(20)
const head1 = para1.content.slice(0, 10)
const quoteCross = tail0 + '\n' + head1
const noteCross = await api(
  `reading.createBookNote(${docId}, { contentMd: '跨段批注自测', quote: ${JSON.stringify(quoteCross)}, startPara: 0, startOffset: 20, endPara: 1, endOffset: 10 })`
)
check('创建跨段批注（起止异段）', !!noteCross?.id && noteCross.start_para === 0 && noteCross.end_para === 1)

const notes = await api(`reading.listBookNotes(${docId})`)
check('批注列表回读（2 则）', notes?.length === 2)

// 批注编辑 + 进度
await api(`reading.updateBookNote(${noteSame.id}, '段内批注（已编辑）')`)
const notes2 = await api(`reading.listBookNotes(${docId})`)
check('批注编辑生效', notes2?.find((n) => n.id === noteSame.id)?.content_md === '段内批注（已编辑）')
const p0 = await api(`reading.getProgress(${docId})`)
await api(`reading.saveProgress(${docId}, 5)`)
const p5 = await api(`reading.getProgress(${docId})`)
check('进度存取（null → 5）', p0 === null && p5?.paraIndex === 5)

// 4. UI 层：打开阅读模式，验证段落渲染 + 高亮恢复（段内 mark + 跨段双段 mark）
await evalJs(`[...document.querySelectorAll('.tab')].find((b) => b.textContent.includes('文档库')).click()`)
await new Promise((r) => setTimeout(r, 400))
await evalJs(`[...document.querySelectorAll('.row')].find((r) => r.textContent.includes('阅读模式自测书'))?.click()`)
let uiReady = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if ((await evalJs(`!!document.querySelector('.rv .para')`)) === true) { uiReady = true; break }
}
check('阅读模式界面打开（段落渲染）', uiReady)
const markProbe = await evalJs(`(() => {
  const marks = [...document.querySelectorAll('.rv mark.bn')]
  const byPara = {}
  for (const m of marks) {
    const seq = m.closest('p[data-para]')?.dataset.para
    byPara[seq] = (byPara[seq] ?? 0) + 1
  }
  return { total: marks.length, byPara }
})()`)
check(
  '高亮恢复（段内 1 处 + 跨段双段各 1 处）',
  markProbe?.total === 3 && markProbe.byPara['0'] === 1 && markProbe.byPara['1'] === 1 && markProbe.byPara['2'] === 1
)

// 划选交互：小段选中 → 直接弹表单；大段选中 → 表单仍钳制在视口内；跨段划选 → 同样直弹表单
const selAndUp = `(startP, startO, endP, endO) => {
  const ps = document.querySelectorAll('.para')
  const sEl = [...ps].find((p) => p.dataset.para === String(startP))
  const eEl = [...ps].find((p) => p.dataset.para === String(endP))
  const tn = (el) => [...el.childNodes].find((n) => n.nodeType === 3 && n.length > 20)
  const range = document.createRange()
  range.setStart(tn(sEl), startO)
  range.setEnd(tn(eEl), endO)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  document.querySelector('.rv-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  return 'fired'
}`
const popProbe = `(() => {
  const pop = document.querySelector('.rv-pop')
  if (!pop) return null
  const r = pop.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, vh: window.innerHeight }
})()`
const esc = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`

// 小段选中 → 表单直接出现
await evalJs(`(${selAndUp})(1, 6, 1, 26)`)
const smallPop = await evalJs(popProbe)
check('一选中即弹批注表单（无中间按钮）', !!smallPop)
await evalJs(esc)

// 大段选中（跨出视口的选区）→ 表单仍在视口内
await evalJs(`(${selAndUp})(4, 0, 4, 30)`)
const bigPop = await evalJs(popProbe)
check('大段选中表单不跑出视口', !!bigPop && bigPop.top >= 8 && bigPop.bottom <= bigPop.vh - 4)
await evalJs(esc)

// 跨段划选 → 同样直弹表单（引用含两段拼接）
await evalJs(`(${selAndUp})(5, 3, 6, 8)`)
const crossPop = await evalJs(`(() => {
  const pop = document.querySelector('.rv-pop')
  if (!pop) return null
  const q = pop.querySelector('.rv-pop-quote')?.textContent ?? ''
  return { top: pop.getBoundingClientRect().top, quoteHasBreak: q.includes('第 6 段'), head: q.slice(0, 14) }
})()`)
check('跨段划选直弹表单（引用跨段拼接）', !!crossPop)
await evalJs(esc)

// 5. 导出（走 __test 通道；跨段批注应带「第1-2段」区间标签）
const mdPath = join(tmp, 'notes.md').replace(/\//g, '\\')
const mdOut = await api(`export.__testSaveBookNotes(${docId}, 'md', ${JSON.stringify(mdPath)})`)
let mdText = ''
try { mdText = readFileSync(mdPath, 'utf-8') } catch { /* 断言里兜底 */ }
check(
  '导出 Markdown（引用+批注+跨段区间标签）',
  mdOut?.path === mdPath &&
    mdText.includes('# 阅读模式自测书') &&
    mdText.includes('**引用**（第1-2段）') &&
    mdText.includes('段内批注（已编辑）')
)
const docxPath = join(tmp, 'notes.docx').replace(/\//g, '\\')
const docxOut = await api(`export.__testSaveBookNotes(${docId}, 'docx', ${JSON.stringify(docxPath)})`)
let docxHead = ''
try { docxHead = readFileSync(docxPath).subarray(0, 2).toString('latin1') } catch { /* 断言里兜底 */ }
check('导出 Word（PK 魔数 + 非空）', docxOut?.path === docxPath && docxHead === 'PK' && statSync(docxPath).size > 1000)

// 6. 清理
await api(`reading.deleteBookNote(${noteSame.id})`)
await api(`reading.deleteBookNote(${noteCross.id})`)
await api(`library.deleteDocument(${docId})`)
const docs = await api('library.listDocuments()')
check('清理完成（书籍与批注已删）', docs?.every((d) => d.id !== docId))

rmSync(tmp, { recursive: true, force: true })

// ===== PDF 页面模式（内置 Chromium 阅读器） =====
console.log('\n=== PDF 页面模式 ===')

function buildSamplePdf(pagesText) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const objs = []
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = pagesText.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pagesText.length} >>`)
  pagesText.forEach((text, i) => {
    const contentNum = 4 + i * 2
    const stream = `BT /F1 18 Tf 72 720 Td (${esc(text)}) Tj ET`
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 7 0 R >> >> >>`)
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = out.length
  const n = objs.length + 1
  out += `xref\n0 ${n}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

const pdfTmp = mkdtempSync(join(tmpdir(), 'lexbench-pdf-'))
const pdfPath = join(pdfTmp, '页面模式自测书.pdf').replace(/\//g, '\\')
writeFileSync(
  pdfPath,
  buildSamplePdf([
    'Page one text for selection and note test. The quick brown fox jumps over the lazy dog.',
    'Page two text continues the cross page note test. Pack my box with five dozen liquor jugs.',
    'Page three adds one more page for the jump test.'
  ])
)

const pdfImported = await api(`library.importDocuments([${JSON.stringify(pdfPath)}], '', 'book')`)
const pdfItem = Array.isArray(pdfImported) ? pdfImported[0] : null
check('PDF 书籍导入（file_ext=.pdf）', pdfItem?.status === 'imported' && pdfItem?.doc_type === 'book')
const pdfDocId = pdfItem?.document_id
const pdfDetail = await api(`library.getDocument(${pdfDocId})`)
check('按页建索引（3 页=3 chunk）+ file_ext', pdfDetail?.chunks?.length === 3 && pdfDetail.file_ext === '.pdf')
const pdfSize = await evalJs(`window.lexbench.reading.getPdfData(${pdfDocId}).then((ab) => ab.byteLength)`)
check('getPdfData 返回原件字节', typeof pdfSize === 'number' && pdfSize > 500)

const pageNote = await api(
  `reading.createBookNote(${pdfDocId}, { contentMd: '这是第 2 页的页笔记', quote: '', startPara: 1, startOffset: 0, endPara: 1, endOffset: 0 })`
)
check('页笔记创建（quote 为空、锚定页）', !!pageNote?.id && pageNote.start_para === 1 && pageNote.quote === '')
await api(`reading.saveProgress(${pdfDocId}, 1)`)
const pdfProg = await api(`reading.getProgress(${pdfDocId})`)
check('进度按页存取', pdfProg?.paraIndex === 1)

// UI：打开 → 内置阅读器 iframe（blob 地址）+ 页码工具条
await evalJs('location.reload()')
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) break
}
await send('Runtime.enable', {})
await evalJs(`[...document.querySelectorAll('.tab')].find((b) => b.textContent.includes('文档库')).click()`)
await new Promise((r) => setTimeout(r, 400))
await evalJs(`[...document.querySelectorAll('.row')].find((r) => r.textContent.includes('页面模式自测书'))?.click()`)
let pdfUiReady = false
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if ((await evalJs(`!!document.querySelector('.rv .pdf-iframe')`)) === true) {
    pdfUiReady = true
    break
  }
}
check('页面模式打开（内置阅读器 iframe）', pdfUiReady)
const frameProbe = await evalJs(`(() => {
  const f = document.querySelector('.pdf-iframe')
  return {
    srcPrefix: (f?.src ?? '').slice(0, 12),
    hasPageFrag: (f?.src ?? '').includes('#page=2'),
    totalHint: document.querySelector('.rv-page-ind')?.textContent?.trim() ?? ''
  }
})()`)
check('blob 载入 + 进度恢复定位到第 2 页', frameProbe?.srcPrefix === 'blob:http://' && frameProbe.hasPageFrag === true)
check('工具条显示总页数', (frameProbe?.totalHint ?? '').includes('共 3 页'))

// 跳页：填第 3 页 → 跳转
await evalJs(`(() => {
  const input = document.querySelector('.rv-page-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '3')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  ;[...document.querySelectorAll('.rv-top-btn')].find((b) => b.textContent.trim() === '跳转')?.click()
  return 'ok'
})()`)
await new Promise((r) => setTimeout(r, 800))
const jumpProbe = await evalJs(`(document.querySelector('.pdf-iframe')?.src ?? '').includes('#page=3')`)
check('跳页生效（地址片段指向第 3 页）', jumpProbe === true)

const sideProbe = await evalJs(`document.querySelector('.rv-side')?.textContent?.includes('第 2 页') ?? false`)
check('批注栏显示页笔记（第 2 页）', sideProbe === true)

await api(`reading.deleteBookNote(${pageNote.id})`)
await api(`library.deleteDocument(${pdfDocId})`)
const pdfDocsAfter = await api('library.listDocuments()')
check('PDF 清理完成', pdfDocsAfter?.every((d) => d.id !== pdfDocId))
rmSync(pdfTmp, { recursive: true, force: true })

// 重载避免测试态残留（裸 API 删除正打开的文档会绕过 App 视图清理）
await evalJs('location.reload()')
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) break
}

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
