// v0.3.0 核心链路 CDP 自测：导入 → 建库 → 法条定位 → 全文检索 → 阅读器翻页
// 前提：npm run dev 已启动（开发模式开放 9222）。用法：node scripts/selftest-core.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// 自造测试语料（不依赖仓库样例；每次运行内容唯一以避开哈希去重）
const corpusTmp = mkdtempSync(join(tmpdir(), 'lexbench-core-'))
const nonce = String(Date.now())
const statuteTxt = join(corpusTmp, `自测法规_${nonce}.txt`).replace(/\//g, '\\')
const caseTxt = join(corpusTmp, `自测案例_${nonce}.txt`).replace(/\//g, '\\')
// 条文行垫高到 ≥250 字：让全文高度超过两屏，目录跳转的几何断言才有意义
// （填充接在同一条文行内，不另起段——避免走进 splitter 的续段分支）
const pad = (line) => {
  const filler = '本段文字为自测排版所加，用于撑起文档高度以便验证目录跳转与阅读进度的准确性。'
  let s = line
  while (s.length < 250) s += filler
  return s
}
writeFileSync(
  statuteTxt,
  [
    '第一章　总则',
    // 第一条含「光污染」（精准块正例）、第二条只有「污染」（模糊块噪音例）——
    // 验证「光污染」查询精准块排前、不会被任意「污染」顶掉
    pad('第一千零七十六条　夫妻双方自愿离婚的，应当签订书面离婚协议，并亲自到婚姻登记机关申请离婚登记。城市光污染的治理适用本条精神。'),
    pad('第一千零七十七条　自婚姻登记机关收到离婚登记申请之日起三十日内，任何一方不愿意离婚的，可以向婚姻登记机关撤回离婚登记申请。防治污染是全社会的共同责任。'),
    '第二章　离婚登记',
    pad('第一千零七十八条　婚姻登记机关查明双方确实是自愿离婚，并已经对子女抚养、财产以及债务处理等事项协商一致的，予以登记，发给离婚证。'),
    pad('第一千零七十九条　夫妻一方要求离婚的，可以由有关组织进行调解或者直接向人民法院提起离婚诉讼。'),
    '第三章　附则',
    pad('第八条　本自测法规的附则条目，用于验证多章目录结构与跳转。'),
    pad('第九条　本自测法规的附则第二条，凑足三章以覆盖目录的层级渲染。')
  ].join('\n'),
  'utf-8'
)
writeFileSync(
  caseTxt,
  [
    '北京市海淀区人民法院',
    '民事判决书',
    '（2026）京0108民初8888号',
    '原告：张某。被告：李某。',
    '本院认为，双方感情确已破裂，准予离婚。'
  ].join('\n'),
  'utf-8'
)
const files = [statuteTxt, caseTxt]
console.log('自造语料:', files.map((f) => f.split('\\').pop()).join(', '))

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

// 7a. 结果行三处整词标记：标题里的「民法典」必须带 <em>（词条含完整查询词段，不被分词截短）
const titleMark = await evalJs(`(() => {
  const t = document.querySelector('.search-pop .item-title')
  return t ? t.innerHTML : ''
})()`)
const titleMarkOk = typeof titleMark === 'string' && titleMark.includes('<em>民法典</em>')
console.log('=== 7a. 结果标题整词标记 ===', titleMarkOk ? 'OK' : 'FAIL', String(titleMark).slice(0, 60))

// ---------- 7b. 搜索加固回归（2026-09：标题入索引 / MATCH 安全 / 实时建议 / 旧结果 bug / IME） ----------
// 法规名全文命中：标题/条号已并入 FTS（依赖启动期 fts_version 重建生效）
const ftName = await evalJs(`window.lexbench.search.run('海商法', 'fulltext')`)
const nameOk = !ftName.__error && (ftName.results?.length ?? 0) > 0
// 大写 AND 不再炸 fts5 语法（token 已字面量化）
const ftAnd = await evalJs(`window.lexbench.search.run('合同 AND 违约', 'fulltext')`)
const andOk = !ftAnd.__error
// 纯标点查询 → emptyReason 归因（区别于「有 token 但无命中」）
const ftNoTok = await evalJs(`window.lexbench.search.run('。，', 'fulltext')`)
const noTokensOk = !ftNoTok.__error && ftNoTok.emptyReason === 'no_tokens'
console.log('=== 7b. 法名全文/AND 安全/no_tokens ===', JSON.stringify({ nameOk, andOk, noTokensOk }))

// 实时建议：键入即搜、浮层随输入更新（不回车、不点按钮）——等 mode-text 跟上新词，防旧结果假阳
await evalJs(`(() => {
  const input = document.querySelector('.search-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '海商法')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`)
let liveOk = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 300))
  const probe = await evalJs(`(() => {
    const pop = document.querySelector('.search-pop')
    const text = document.querySelector('.mode-text')?.textContent ?? ''
    return { items: pop ? pop.querySelectorAll('.item').length : 0, text }
  })()`)
  if (probe && !probe.__error && probe.text.includes('海商法') && probe.items > 0) { liveOk = true; break }
}
console.log('=== 7c. 键入实时候选 ===', liveOk ? 'OK' : 'FAIL')

// 改词回车：结果必须跟随新词（根治「回车选中上一次旧结果、新查询根本没执行」）
await evalJs(`(() => {
  const input = document.querySelector('.search-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '劳动法 36')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'retyped'
})()`)
// 不等 150ms 防抖，立即回车：submitTop 应判定 lastQuery 不一致 → 对新词执行检索
await evalJs(`(() => {
  const input = document.querySelector('.search-input')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, keyCode: 13, which: 13 }))
  return 'enter'
})()`)
let staleOk = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 300))
  const text = await evalJs(`document.querySelector('.mode-text')?.textContent ?? ''`)
  if (typeof text === 'string' && text.includes('劳动法 36')) { staleOk = true; break }
}
console.log('=== 7d. 改词回车执行新查询 ===', staleOk ? 'OK' : 'FAIL')

// IME 守卫：keyCode 229 的回车（合成选字态）必须被忽略——浮层不收、结果不动
const imeTextBefore = await evalJs(`document.querySelector('.mode-text')?.textContent ?? ''`)
const imePopBefore = (await evalJs(`!!document.querySelector('.search-pop')`)) === true
await evalJs(`(() => {
  const input = document.querySelector('.search-input')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, keyCode: 229, which: 229 }))
  return 'ime-enter'
})()`)
await new Promise((r) => setTimeout(r, 500))
const imePopAfter = (await evalJs(`!!document.querySelector('.search-pop')`)) === true
const imeTextAfter = await evalJs(`document.querySelector('.mode-text')?.textContent ?? ''`)
const imeOk =
  imePopBefore && imePopAfter && imeTextAfter === imeTextBefore && String(imeTextBefore).includes('劳动法 36')
console.log('=== 7e. IME 选字回车被忽略 ===', imeOk ? 'OK' : 'FAIL', JSON.stringify({ imePopBefore, imePopAfter }))

// 7f. 精准搜索：「光污染」的精准块（整句短语/全词交集）必须排在任意「污染」之前；
// 且蓝色高亮必须整包「光污染」（高亮词条含用户原查询，不能只包分词后的「污染」）
const ftPrec = await evalJs(`window.lexbench.search.run('光污染', 'fulltext')`)
const precOk =
  !ftPrec.__error &&
  ftPrec.mode === 'fulltext' &&
  (ftPrec.results?.length ?? 0) > 0 &&
  String(ftPrec.results[0]?.snippet ?? '').includes('<em>光污染</em>')
console.log('=== 7f. 精准块排前 + 整词高亮（光污染）===', precOk ? 'OK' : 'FAIL',
  JSON.stringify((ftPrec.results ?? []).slice(0, 3).map((r) => String(r.snippet ?? '').slice(0, 46))))

// ---------- 8. 法规全页阅读：文档库点卡片 → 独立页面 + 目录 + 点击跳转 ----------
const statuteDocId = (docs || []).find((d) => /^自测法规_/.test(d.title))?.id ?? null

// 走 API 导入不会触发界面刷新列表（只有导入对话框会，同 selftest-reading 的做法）——
// 重载页面让 App 重新拉文档列表，否则新卡片根本不在 DOM 里
await evalJs(`(() => { location.reload(); return true })()`)
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) break
}
await send('Runtime.enable', {}) // 重载后重开错误收集

// 切到文档库并复位「全部」过滤（防同会话里先前跑过的套件改过组件内过滤状态）
console.log('8-tab:', await evalJs(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find((b) => b.textContent.includes('文档库'))
  tab?.click()
  const all = [...document.querySelectorAll('.filter-chip')].find((c) => c.textContent.includes('全部'))
  all?.click()
  return tab ? 'ok' : 'no-tab'
})()`))

// 点法规卡片 → 轮询全页阅读出现
console.log('8-click:', await evalJs(`(() => {
  const card = [...document.querySelectorAll('.doc-card')].find((c) => c.textContent.includes('自测法规_'))
  card?.click()
  return card ? 'clicked' : 'no-card'
})()`))
let svOpen = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 300))
  if ((await evalJs(`!!document.querySelector('.sv .sv-article')`)) === true) { svOpen = true; break }
}
const fullPageOk =
  svOpen &&
  (await evalJs(`!!document.querySelector('main.reading-full .sv')`)) === true &&
  (await evalJs(`!document.querySelector('.reader-pane')`)) === true
console.log('=== 8a. 法规全页阅读 ===', fullPageOk ? 'OK' : 'FAIL')

// 行内标题与右栏目录：三章都要出现
const hTexts = (await evalJs(`[...document.querySelectorAll('.sv-h')].map((e) => e.textContent)`)) || []
const headingsOk =
  Array.isArray(hTexts) &&
  hTexts.length >= 3 &&
  ['第一章', '第二章', '第三章'].every((t) => hTexts.some((x) => String(x).includes(t)))
const tocInfo = (await evalJs(
  `[...document.querySelectorAll('.sv-toc-item')].map((e) => ({ t: e.textContent.trim(), o: Number(e.dataset.order) }))`
)) || []
const tocOk = Array.isArray(tocInfo) && tocInfo.length >= 3 && tocInfo[0].t.includes('第一章')
console.log('=== 8b. 行内标题/目录 ===', headingsOk && tocOk ? 'OK' : 'FAIL', JSON.stringify(hTexts), JSON.stringify(tocInfo.map((x) => x.t)))

// 目录点击跳转（几何断言：末章标题顶到滚动区上方留 44px；offsetTop>600 证明语料垫高生效）
const jumpOrder = tocOk ? tocInfo[tocInfo.length - 1].o : -1
if (jumpOrder >= 0) {
  await evalJs(`(() => {
    const items = document.querySelectorAll('.sv-toc-item')
    items[items.length - 1].click()
    return 'clicked'
  })()`)
}
await new Promise((r) => setTimeout(r, 400))
// 跳转可能走平滑滚动（可见窗口约 0.6s 才到位；隐藏窗口组件自动降级瞬时）——轮询到位，勿固定睡
let jumpGeo = null
if (jumpOrder >= 0) {
  for (let i = 0; i < 20; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300))
    jumpGeo = await evalJs(`(() => {
        const sc = document.querySelector('.sv-scroll')
        const h = document.querySelector('.sv-h[data-order="${jumpOrder}"]')
        if (!sc || !h) return null
        return { top: sc.scrollTop, expected: Math.max(0, h.offsetTop - 44), off: h.offsetTop }
      })()`)
    if (jumpGeo && !jumpGeo.__error && Math.abs(jumpGeo.top - jumpGeo.expected) < 6) break
  }
}
const jumpOk =
  !!jumpGeo && !jumpGeo.__error && Math.abs(jumpGeo.top - jumpGeo.expected) < 6 && jumpGeo.off > 600
console.log('=== 8c. 目录跳转 ===', jumpOk ? 'OK' : 'FAIL', JSON.stringify(jumpGeo))

// 阅读进度：跳转触发防抖落盘（500ms），paraIndex 应等于末章首条的 order_index
// 注意：自测时窗口在后台（visibilityState=hidden），两处与真实可见窗口不同——
// ① Chromium 不派发原生 scroll 事件（组件逻辑无恙，可见窗口下自然触发）：
//    手动补一个 scroll 模拟；Vue @scroll → 防抖 → saveProgressNow 读实时 scrollTop，语义一致。
// ② 隐藏页定时器被节流（500ms 防抖实际可能 ~1s 才跑）：不能固定睡 800ms，轮询等落盘。
await evalJs(`(() => {
  const sc = document.querySelector('.sv-scroll')
  sc?.dispatchEvent(new Event('scroll'))
  return sc ? 'dispatched' : 'no-sc'
})()`)
let prog = null
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 300))
  prog = statuteDocId ? await evalJs(`window.lexbench.reading.getProgress(${statuteDocId})`) : null
  if (prog && !prog.__error) break
}
const progOk =
  !!prog && !prog.__error && Number.isInteger(prog.paraIndex) && prog.paraIndex === jumpOrder
console.log('=== 8d. 进度记忆 ===', progOk ? 'OK' : 'FAIL', JSON.stringify(prog))

// 返回 → 整区卸载、回到文档库 Tab
await evalJs(`document.querySelector('.sv-back')?.click()`)
await new Promise((r) => setTimeout(r, 400))
const backOk =
  (await evalJs(`!document.querySelector('.sv')`)) === true &&
  (await evalJs(`!!document.querySelector('.doc-card')`)) === true &&
  (await evalJs(
    `[...document.querySelectorAll('.tab')].some((b) => b.textContent.includes('文档库') && b.getAttribute('aria-selected') === 'true')`
  )) === true
console.log('=== 8e. 返回文档库 ===', backOk ? 'OK' : 'FAIL')

// 重开 → 恢复上次阅读位置 + 「已回到上次阅读位置」提示
console.log('8-reclick:', await evalJs(`(() => {
  const card = [...document.querySelectorAll('.doc-card')].find((c) => c.textContent.includes('自测法规_'))
  card?.click()
  return card ? 'clicked' : 'no-card'
})()`))
let restoredTop = 0
let hintShown = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 300))
  const st = await evalJs(`(() => {
    const sc = document.querySelector('.sv-scroll')
    return { top: sc ? sc.scrollTop : -1, hint: !!document.querySelector('.sv-hint') }
  })()`)
  if (st && !st.__error) hintShown = st.hint
  if (st && st.top > 0) { restoredTop = st.top; break }
}
const restoreOk = restoredTop > 0 && hintShown
console.log('=== 8f. 重开恢复位置 ===', restoreOk ? 'OK' : 'FAIL', `scrollTop=${restoredTop}`)

// ---------- 8g+. 法内搜索（独立于顶栏/中栏的第三个搜索框，只搜当前这部法） ----------
// 语料里「附则」只出现在第八条/第九条正文（章节标题行不入 content）→ 恰好 2 命中
console.log('8-search:', await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.sv-top-btn')].find((b) => b.textContent.includes('搜索'))
  if (!btn) return 'no-btn'
  btn.click()
  return 'opened'
})()`))
let searchReady = false
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 200))
  if ((await evalJs(`!!document.querySelector('.sv-search-input')`)) === true) { searchReady = true; break }
}
await evalJs(`(() => {
  const input = document.querySelector('.sv-search-input')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '附则')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`)
// 防抖 200ms → 候选/计数/全篇高亮
let markCount = 0
let countText = ''
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 300))
  markCount = (await evalJs(`document.querySelectorAll('.sv-hit').length`)) || 0
  countText = (await evalJs(`document.querySelector('.sv-search-count')?.textContent ?? ''`)) || ''
  if (markCount > 0) break
}
const searchHitOk = searchReady && markCount === 2 && countText.includes('2')
console.log('=== 8g. 法内搜索命中与高亮 ===', searchHitOk ? 'OK' : 'FAIL', JSON.stringify({ markCount, countText }))

// 8g2. 候选下拉内关键词同样标记（em + 琥珀，与全局结果行一致）
const dropMarkHtml = await evalJs(`document.querySelector('.sv-search-item')?.innerHTML ?? ''`)
const dropMarkOk = typeof dropMarkHtml === 'string' && dropMarkHtml.includes('<em>附则</em>')
console.log('=== 8g2. 候选下拉关键词标记 ===', dropMarkOk ? 'OK' : 'FAIL', String(dropMarkHtml).slice(0, 80))

// 点第一个候选 → 平滑居中定位（轮询到位，公式与组件 center 模式一致）
await evalJs(`(() => {
  const item = document.querySelector('.sv-search-item')
  if (!item) return 'no-item'
  item.click()
  return 'clicked'
})()`)
let centerGeo = null
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 300))
  centerGeo = await evalJs(`(() => {
    const sc = document.querySelector('.sv-scroll')
    const item = document.querySelector('.sv-search-item')
    if (!sc || !item) return null
    const order = item.dataset.order
    const t =
      document.querySelector('.sv-h[data-order="' + order + '"]') ||
      document.querySelector('.sv-article[data-order="' + order + '"]')
    if (!t) return null
    // 居中目标可能超出最大可滚高度——浏览器会钳到 scrollHeight−clientHeight，公式需一致
    const raw = Math.max(0, t.offsetTop - sc.clientHeight / 2 + t.clientHeight / 2)
    const expected = Math.max(0, Math.min(raw, sc.scrollHeight - sc.clientHeight))
    return { top: sc.scrollTop, expected, order: Number(order) }
  })()`)
  if (centerGeo && !centerGeo.__error && Math.abs(centerGeo.top - centerGeo.expected) < 8) break
}
const centerOk = !!centerGeo && !centerGeo.__error && Math.abs(centerGeo.top - centerGeo.expected) < 8
console.log('=== 8h. 点击候选居中跳转 ===', centerOk ? 'OK' : 'FAIL', JSON.stringify(centerGeo))

// Enter → 循环到下一条（active 落到第二条 order，滚动到其中心）
await evalJs(`(() => {
  const input = document.querySelector('.sv-search-input')
  if (!input) return 'no-input'
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return 'enter'
})()`)
let nextGeo = null
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 300))
  nextGeo = await evalJs(`(() => {
    const sc = document.querySelector('.sv-scroll')
    const act = document.querySelector('.sv-search-item.active')
    if (!sc || !act) return null
    const order = act.dataset.order
    const t =
      document.querySelector('.sv-h[data-order="' + order + '"]') ||
      document.querySelector('.sv-article[data-order="' + order + '"]')
    if (!t) return null
    const raw = Math.max(0, t.offsetTop - sc.clientHeight / 2 + t.clientHeight / 2)
    const expected = Math.max(0, Math.min(raw, sc.scrollHeight - sc.clientHeight))
    return { top: sc.scrollTop, expected, order: Number(order) }
  })()`)
  if (nextGeo && !nextGeo.__error && nextGeo.order !== centerGeo?.order && Math.abs(nextGeo.top - nextGeo.expected) < 8) break
}
const nextOk =
  !!nextGeo && !nextGeo.__error && nextGeo.order !== centerGeo?.order &&
  Math.abs(nextGeo.top - nextGeo.expected) < 8
console.log('=== 8i. Enter 循环下一条 ===', nextOk ? 'OK' : 'FAIL', JSON.stringify(nextGeo))

// Esc → 关闭搜索并清除全篇高亮
await evalJs(`(() => {
  const input = document.querySelector('.sv-search-input')
  if (!input) return 'no-input'
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return 'esc'
})()`)
let escOk = false
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 200))
  const gone = (await evalJs(`!document.querySelector('.sv-search-input')`)) === true
  const noMarks = (await evalJs(`document.querySelectorAll('.sv-hit').length`)) === 0
  if (gone && noMarks) { escOk = true; break }
}
console.log('=== 8j. Esc 关闭清除 ===', escOk ? 'OK' : 'FAIL')

// 8k. 外点收起：点到搜索区之外 → 候选收起，但输入/查询/高亮保留
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.sv-top-btn')].find((b) => b.textContent.includes('搜索'))
  btn?.click()
  return btn ? 'opened' : 'no-btn'
})()`)
await new Promise((r) => setTimeout(r, 250))
await evalJs(`(() => {
  const input = document.querySelector('.sv-search-input')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '附则')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`)
let outsideReady = false
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 300))
  const st = await evalJs(`(() => ({
    pop: !!document.querySelector('.sv-search-pop'),
    marks: document.querySelectorAll('.sv-hit').length
  }))()`)
  if (st && !st.__error && st.pop && st.marks === 2) { outsideReady = true; break }
}
await evalJs(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'clicked' })()`)
let outsideOk = false
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 200))
  const st = await evalJs(`(() => ({
    pop: !!document.querySelector('.sv-search-pop'),
    input: !!document.querySelector('.sv-search-input'),
    val: document.querySelector('.sv-search-input')?.value ?? '',
    marks: document.querySelectorAll('.sv-hit').length
  }))()`)
  if (st && !st.__error && !st.pop && st.input && st.val === '附则' && st.marks === 2) { outsideOk = true; break }
}
outsideOk = outsideReady && outsideOk
console.log('=== 8k. 外点收起保留查询高亮 ===', outsideOk ? 'OK' : 'FAIL')

// 8l. 条号直查：阿拉伯数字「8」→ 第八条（正文/条标是中文数字，纯子串搜不到，靠 article_no 直查）
await evalJs(`(() => {
  const input = document.querySelector('.sv-search-input')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '8')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`)
let numOk = false
let numSt = null
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 300))
  numSt = await evalJs(`(() => ({
    count: document.querySelector('.sv-search-count')?.textContent ?? '',
    first: document.querySelector('.sv-search-item .sv-search-label')?.textContent ?? ''
  }))()`)
  if (numSt && !numSt.__error && numSt.count === '1' && numSt.first.includes('第八条')) { numOk = true; break }
}
console.log('=== 8l. 阿拉伯数字条号直查 ===', numOk ? 'OK' : 'FAIL', JSON.stringify(numSt))

// 清理：删掉本脚本导入的测试文档（含此前版本遗留的同名文档）。
// 只删临时文件是不够的——文档进了库就一直躺在那儿，跑几次开发库就多几份垃圾。
const junkIds = JSON.parse(
  (await evalJs(
    `window.lexbench.library.listDocuments().then((d) => JSON.stringify(d.filter((x) => /^自测(法规|案例)_/.test(x.title)).map((x) => x.id)))`
  )) || '[]'
)
for (const docId of junkIds) {
  await evalJs(`window.lexbench.library.deleteDocument(${docId}).catch(() => null)`)
}
const junkLeft = JSON.parse(
  (await evalJs(
    `window.lexbench.library.listDocuments().then((d) => JSON.stringify(d.filter((x) => /^自测(法规|案例)_/.test(x.title)).map((x) => x.id)))`
  )) || '[]'
).length
// 破坏性收尾后重载：刚打开过被删的文档，不重载会留下僵尸视图连累后续断言
await evalJs('(() => { location.reload(); return true })()')
await new Promise((r) => setTimeout(r, 1500))

console.log('\n=== 结论 ===')
const checks = [
  ['全部文件导入成功', allImported],
  ['文档库 ≥2 份', Array.isArray(docs) && docs.length >= 2],
  ['法条定位命中 1077', locate?.mode === 'locate' && locate.results.length > 0],
  ['阅读器 prev/next', !!detail && (detail.prev !== undefined)],
  ['全文检索有结果', fulltext?.mode === 'fulltext' && fulltext.results.length > 0],
  ['UI 渲染结果列表', uiHasResults],
  ['结果标题整词标记（民法典带 em）', titleMarkOk],
  ['法名全文可命中（标题入索引）', nameOk],
  ['大写 AND 不再炸 fts5 语法', andOk],
  ['no_tokens 空态归因', noTokensOk],
  ['键入即出实时候选（免回车）', liveOk],
  ['改词回车执行新查询（不吃旧结果）', staleOk],
  ['IME 选字回车被忽略', imeOk],
  ['全文精准块排前 + 整词高亮（光污染）', precOk],
  ['文档库点法规 → 独立全页阅读', fullPageOk],
  ['正文行内渲染编/章标题（≥3 个）', headingsOk],
  ['右栏目录列出章节（≥3 条、首条第一章）', tocOk],
  ['目录点击跳转到对应标题', jumpOk],
  ['阅读进度按 order_index 保存', progOk],
  ['返回文档库（整区卸载 + Tab 恢复）', backOk],
  ['重开恢复阅读位置与提示', restoreOk],
  ['法内搜索：独立搜索框命中并全文高亮', searchHitOk],
  ['法内搜索：候选下拉关键词标记', dropMarkOk],
  ['法内搜索：点击候选居中跳转', centerOk],
  ['法内搜索：Enter 循环到下一条', nextOk],
  ['法内搜索：Esc 关闭并清除高亮', escOk],
  ['法内搜索：外点收起候选保留查询', outsideOk],
  ['法内搜索：阿拉伯数字条号直查', numOk],
  ['测试文档已清理（不留垃圾在库里）', junkLeft === 0],
  ['零控制台错误', errors.length === 0]
]
let pass = true
for (const [name, ok] of checks) {
  console.log((ok ? '✅' : '❌'), name)
  if (!ok) pass = false
}
if (errors.length) console.log('\n控制台错误详情:\n' + errors.join('\n'))
rmSync(corpusTmp, { recursive: true, force: true })
process.exit(pass ? 0 : 1)
