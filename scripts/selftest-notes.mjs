// 笔记库 CDP 自测：大纲编辑器（contenteditable 键位/折叠/自动保存/往返快照）+ 多选/拖拽
// + 引用通道 + 星标 + 续读契约 + 分类/贴图 + 思维导图（编辑/拖动/缩放/往返）+ 通用导入。
// 前提：npm run dev 已启动（开发模式开放 9222）。用法：node scripts/selftest-notes.mjs
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
await send('Page.enable', {})

// 超时探针（锁屏/挂起时 15s 转失败，不干等——配方同 selftest-core）
const evalJs = async (expression) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('EVALJS_TIMEOUT(15s)：渲染/连接无响应（锁屏或窗口挂起？）')), 15000))
  ]).catch((e) => ({ exceptionDetails: { exception: { description: String(e) } } }))
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || 'eval error' }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 轮询助手：隐藏页定时器节流（lessons #2），断言等待一律轮询不固定短睡
const until = async (fn, tries = 24) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(`(${fn})()`)
    if (v === true) return true
    await sleep(250)
  }
  return false
}

async function waitMounted() {
  for (let i = 0; i < 24; i++) {
    if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) return true
    await sleep(400)
  }
  return false
}

let mounted = await waitMounted()
if (!mounted) {
  console.log('FAIL: 应用未挂载')
  console.log(errors.join('\n') || '(无控制台错误)')
  process.exit(1)
}
await send('Page.bringToFront', {})
console.log('=== 1. UI 挂载 OK ===')

// 浏览器侧小工具（contenteditable 输入 / 键位 / 取值）。
// 必须在每次 Page.reload 之后注入（reload 会清掉 window 上的临时函数）。
const injectHelpers = () =>
  evalJs(`(() => {
  window.__ltSet = (idx, text, caret = 'end') => {
    const el = document.querySelectorAll('.ol-text')[idx]
    if (!el) return false
    el.focus()
    el.textContent = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    const sel = window.getSelection()
    const r = document.createRange()
    r.selectNodeContents(el)
    if (caret === 'start') r.collapse(true)
    else r.collapse(false)
    sel.removeAllRanges()
    sel.addRange(r)
    return true
  }
  window.__ltKey = (idx, key, extra = {}) => {
    const el = document.querySelectorAll('.ol-text')[idx]
    if (!el) return false
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
    return true
  }
  window.__ltVals = () => [...document.querySelectorAll('.ol-text')].map((e) => e.textContent)
  window.__ltRows = () => [...document.querySelectorAll('.ol-row')].map((r) => ({ id: r.dataset.rowId, depth: Number(r.dataset.depth), text: r.querySelector('.ol-text')?.textContent ?? '' }))
  return true
})()`)

// 清场：清掉上轮残留（笔记/星标/分类），再 reload 彻底重置 UI 状态
await evalJs(`(() => { const b = document.querySelector('.sv-back, .rv-back'); if (b) b.click(); return true })()`)
await until(`() => !!document.querySelector('.rail')`)
await evalJs(`(async () => {
  const s = await window.lexbench.outlines.listStarred()
  for (const x of s) await window.lexbench.outlines.setStarred(x.article_id, false)
  const l = await window.lexbench.outlines.list()
  for (const n of l) await window.lexbench.outlines.remove(n.id)
  const g = await window.lexbench.noteGroups.list()
  for (const x of g) await window.lexbench.noteGroups.remove(x.id)
  return true
})()`)
await send('Page.reload', {})
await sleep(2500)
if (!(await waitMounted())) {
  console.log('FAIL: reload 后未挂载')
  process.exit(1)
}
await injectHelpers()

// ---------- 编辑器：新建 + 键位 ----------
console.log('=== 2. 编辑器键位（Enter/Tab/Shift+Tab/Backspace）===')
await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('笔记'))?.click()`)
await sleep(400)
await evalJs(`document.querySelector('.np-nav-acts .np-icon-btn[title^="新建笔记"]')?.click()`)
const editorUp = await until(`() => !!document.querySelector('.ol-text')`)
if (!editorUp) {
  console.log('FAIL: 编辑器未出现')
  console.log(errors.join('\n') || '(无控制台错误)')
  process.exit(1)
}

// 标题
await evalJs(`(() => {
  const el = document.querySelector('.ol-title')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '自测笔记')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(700)

// Enter 分行
await evalJs(`window.__ltSet(0, '第一行')`)
await sleep(120)
await evalJs(`window.__ltKey(0, 'Enter')`)
await sleep(200)
const enterOk = await evalJs(`JSON.stringify(window.__ltVals()) === JSON.stringify(['第一行', ''])`)

// 第二行输入 + Tab 缩进
await evalJs(`window.__ltSet(1, '子行')`)
await sleep(120)
await evalJs(`window.__ltKey(1, 'Tab')`)
await sleep(200)
const indentOk = await evalJs(`window.__ltRows()[1]?.depth === 1 && document.querySelectorAll('.ol-row')[1]?.querySelectorAll('.ol-indent').length === 1`)
// 缩进后仍在编辑态：不能出现整行/缩进列高光
const editHighlightOk = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.ol-row')]
  const row = rows[1]
  const ind = row?.querySelector('.ol-indent')
  return document.querySelectorAll('.ol-row.selected').length === 0 &&
    !!row && getComputedStyle(row.querySelector('.ol-content')).backgroundColor === 'rgba(0, 0, 0, 0)' &&
    (!ind || getComputedStyle(ind).backgroundColor === 'rgba(0, 0, 0, 0)')
})()`)

// Shift+Tab 反缩进
await evalJs(`window.__ltKey(1, 'Tab', { shiftKey: true })`)
await sleep(200)
const outdentOk = await evalJs(`window.__ltRows()[1]?.depth === 0`)

// 行首 Backspace（非空）→ 并入上一行
await evalJs(`window.__ltSet(1, '子行', 'start')`)
await sleep(120)
await evalJs(`window.__ltKey(1, 'Backspace')`)
await sleep(250)
const mergeOk = await evalJs(`JSON.stringify(window.__ltVals()) === JSON.stringify(['第一行子行'])`)

// 大纲页面触控板捏合缩放 + 横向可平移空间
await evalJs(`(() => { document.querySelector('.ol')?.dispatchEvent(new WheelEvent('wheel', { deltaY: -150, ctrlKey: true, bubbles: true, cancelable: true })); return true })()`)
await sleep(350)
const outlineZoomOk = await evalJs(`(() => {
  const p = document.querySelector('.ol-page')
  return !!p && parseFloat(getComputedStyle(p).zoom) > 1 && !!document.querySelector('.ol-zoom-reset')
})()`)
await evalJs(`document.querySelector('.ol-zoom-reset')?.click()`)
await sleep(350)
const outlinePanSpaceOk = await evalJs(`(() => {
  const s = document.querySelector('.ol-scroll')
  return !!s && s.scrollWidth > s.clientWidth && s.scrollLeft > 0
})()`)

// 多选（圆点 Ctrl+点击）：选中第 1 行后再 Ctrl 点第 2 行
await evalJs(`window.__ltSet(0, '甲')`)
await sleep(100)
await evalJs(`window.__ltKey(0, 'Enter')`)
await sleep(200)
await evalJs(`window.__ltSet(1, '乙')`)
await sleep(120)
await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.ol-row')]
  const clickBullet = (row, ctrl) => {
    const b = row.querySelector('.ol-bullet')
    const r = b.getBoundingClientRect()
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ctrlKey: ctrl, clientX: r.x + 5, clientY: r.y + 5 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5 }))
  }
  clickBullet(rows[0], false)
  clickBullet(rows[1], true)
  return true
})()`)
await sleep(300)
const multiSelectOk = await evalJs(`document.querySelectorAll('.ol-row.selected').length === 2`)
// 清掉多选（Esc）再拖拽：否则拖的是整块选择，落点又在块内，按规则会被拒绝
await evalJs(`(() => { const el = document.querySelectorAll('.ol-text')[0]; el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true })()`)
await sleep(200)

// 拖拽（大纲）：把第 2 行拖到第 1 行中部 → 成为子级
const outlineDragOk = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.ol-row')]
  if (rows.length < 2) return false
  const from = rows[1]; const to = rows[0]
  const b = from.querySelector('.ol-bullet'); const br = b.getBoundingClientRect()
  const tr = to.getBoundingClientRect()
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: br.x + 5, clientY: br.y + 5 }))
  for (let i = 1; i <= 10; i++) {
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: br.x + 5 + (tr.x + tr.width / 2 - br.x - 5) * i / 10, clientY: br.y + 5 + (tr.y + tr.height / 2 - br.y - 5) * i / 10 }))
  }
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: tr.x + tr.width / 2, clientY: tr.y + tr.height / 2 }))
  return true
})()`)
await sleep(700)
const outlineDragTreeOk = await until(`() => {
  return window.lexbench.outlines.list().then(async (l) => {
    const n = l.find((x) => x.title === '自测笔记')
    if (!n) return false
    const d = await window.lexbench.outlines.get(n.id)
    const t = JSON.parse(d.tree)
    return t.length === 1 && (t[0].children ?? []).length === 1
  })
}`)

// ---------- 折叠 ----------
console.log('=== 3. 折叠/展开 ===')
await evalJs(`document.querySelector('.ol-fold')?.click()`)
const foldOk = await until(`() => !!document.querySelector('.ol-count')`)
await evalJs(`document.querySelector('.ol-fold')?.click()`)
const unfoldOk = await until(`() => !document.querySelector('.ol-count') && document.querySelectorAll('.ol-text').length >= 2`)

// ---------- 自动保存落库 ----------
console.log('=== 4. 自动保存落库 ===')
const titleSaved = await until(`() => {
  return window.lexbench.outlines.list().then(l => l.some(n => n.title === '自测笔记'))
}`)
const treeSaved = await until(`() => {
  return window.lexbench.outlines.list().then(async (l) => {
    const n = l.find(x => x.title === '自测笔记')
    if (!n) return false
    const d = await window.lexbench.outlines.get(n.id)
    const walk = (ns) => ns.some((x) => x.text === '甲' || walk(x.children ?? []))
    return walk(JSON.parse(d.tree))
  })
}`)

// ---------- 往返快照 ----------
console.log('=== 5. 往返快照（切走→切回不丢数据）===')
await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('文档库'))?.click()`)
await sleep(400)
await evalJs(`(() => { const b = document.querySelector('.sv-back, .rv-back'); if (b) b.click(); return true })()`)
await until(`() => !!document.querySelector('.rail')`)
await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('笔记'))?.click()`)
await sleep(400)
const roundtripOk = await until(`() => !!document.querySelector('.ol-title') && document.querySelector('.ol-title').value === '自测笔记'`)

// ---------- 插入浮层 ----------
console.log('=== 6. 插入引用浮层（/ 唤出 + 连加）===')
await evalJs(`document.querySelector('.ol-append')?.click()`)
await sleep(300)
const pickerOpen = await (async () => {
  const idx = await evalJs(`document.querySelectorAll('.ol-text').length - 1`)
  await evalJs(`window.__ltKey(${idx}, '/')`)
  return until(`() => !!document.querySelector('.ol-picker-card')`)
})()
await evalJs(`(() => {
  const el = document.querySelector('.ol-picker-input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '离婚')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
const pickerHits = await until(`() => document.querySelectorAll('.ol-picker-item').length > 0`)
let addOk = false
let stillOpen = false
let secondOk = false
if (pickerHits) {
  const before = await evalJs(`document.querySelectorAll('.ol-row').length`)
  await evalJs(`document.querySelector('.opi-add')?.click()`)
  await sleep(600)
  const after1 = await evalJs(`document.querySelectorAll('.ol-row').length`)
  addOk = after1 > before
  stillOpen = await evalJs(`!!document.querySelector('.ol-picker-card')`)
  await evalJs(`document.querySelector('.opi-add')?.click()`)
  await sleep(600)
  const after2 = await evalJs(`document.querySelectorAll('.ol-row').length`)
  secondOk = after2 > after1
}
await evalJs(`document.querySelector('.ol-picker-close')?.click()`)
const pickerClosed = await until(`() => {
  const ov = document.querySelector('.ol-picker')
  return !ov || ov.className.includes('menu-pop-leave')
}`)

// ---------- 引用节点 ----------
console.log('=== 7. 引用节点（浮层插入落库 / 粘贴生成）===')
const refSaved = await until(`() => {
  return window.lexbench.outlines.list().then(async (l) => {
    const n = l.find(x => x.title === '自测笔记')
    if (!n) return false
    const d = await window.lexbench.outlines.get(n.id)
    const walk = (ns) => ns.some(x => (x.ref && x.ref.articleId) || walk(x.children ?? []))
    return walk(JSON.parse(d.tree))
  })
}`)
await evalJs(`document.querySelector('.ol-append')?.click()`)
await sleep(300)
const pasteRefOk = await evalJs(`(() => {
  const tas = document.querySelectorAll('.ol-text')
  const ta = tas[tas.length - 1]
  if (!ta) return false
  ta.focus()
  const dt = new DataTransfer()
  dt.setData('text/plain', '《自测法》第一条\\n自测引用原文')
  dt.setData('text/html', '<span data-lb-ref="{&quot;docId&quot;:1,&quot;articleId&quot;:1}">《自测法》第一条</span><br>自测引用原文')
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  return true
})()`)
await sleep(600)
const pasteRefRowOk = await evalJs(`(() => {
  const row = [...document.querySelectorAll('.ol-row')].find(
    r => r.classList.contains('is-ref') && r.querySelector('.ol-text').textContent.includes('《自测法》')
  )
  return !!row && row.querySelector('.ol-bullet').textContent.includes('📖')
})()`)
const escapeOk = await evalJs(`(() => {
  const row = [...document.querySelectorAll('.ol-row')].find(r => r.classList.contains('is-ref'))
  if (!row) return false
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  return typeof window.lexbench.outlines.setRefContext === 'function' && typeof window.lexbench.outlines.onOpenSource === 'function'
})()`)

// ---------- 星标 ----------
console.log('=== 8. 星标链路 ===')
await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('文档库'))?.click()`)
await sleep(300)
await evalJs(`document.querySelector('.doc-card')?.click()`)
const inReading = await until(`() => !!document.querySelector('.sv-article')`)
let starClickOk = false
let starDbOk = false
if (inReading) {
  starClickOk = await evalJs(`(() => { const b = document.querySelector('.sv-star-btn'); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  starDbOk = await evalJs(`window.lexbench.outlines.listStarred().then(r => r.length >= 1)`)
}

// ---------- 阅读缩放（触控板捏合）+ 缩放后目录跳转 ----------
console.log('=== 8b. 阅读缩放与缩放后跳转 ===')
let zoomOk = false
let zoomJumpOk = false
if (inReading) {
  // 捏合 = ctrl+wheel（往放大方向）
  await evalJs(`(() => {
    const sc = document.querySelector('.sv-scroll')
    if (!sc) return false
    sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true }))
    return true
  })()`)
  await sleep(500)
  const zoomNow = await evalJs(`parseFloat(document.querySelector('.sv-col')?.style.zoom || '1')`)
  zoomOk = typeof zoomNow === 'number' && zoomNow > 1.05
  // 缩放≠1 时目录跳转仍要落到目标条文（offsetTop 与 scrollTop 单位混用会按比例偏）
  // 有的文档没有编/章标题就没有目录面板：此时跳过（恢复位置的同类跳转由第 9 步在缩放态下覆盖）
  const tocOrder = await evalJs(`(() => {
    const items = [...document.querySelectorAll('.sv-toc-item')]
    const mid = items[Math.floor(items.length / 2)]
    if (!mid) return null
    mid.click()
    return Number(mid.dataset.order)
  })()`)
  if (typeof tocOrder === 'number') {
    zoomJumpOk = await until(`() => {
      const sc = document.querySelector('.sv-scroll')
      const el = sc?.querySelector('.sv-article[data-order="${tocOrder}"]')
      if (!sc || !el) return false
      const dy = el.getBoundingClientRect().top - sc.getBoundingClientRect().top
      return dy >= 0 && dy <= 170
    }`, 16)
  } else {
    zoomJumpOk = true
    console.log('（本文档无目录项，缩放后跳转断言跳过）')
  }
}

// ---------- 续读契约 ----------
console.log('=== 9. 续读契约（静默重开 + 位置恢复）===')
const scrolledOrder = await evalJs(`(() => {
  const sc = document.querySelector('.sv-scroll')
  const arts = [...document.querySelectorAll('.sv-article')]
  if (!sc || arts.length < 5) return null
  const target = arts[Math.floor(arts.length / 2)]
  sc.scrollTop = target.offsetTop - 100
  sc.dispatchEvent(new Event('scroll'))
  return Number(target.getAttribute('data-order'))
})()`)
await sleep(1200)
await evalJs(`document.querySelector('.sv-back')?.click()`)
const backOk = await until(`() => !!document.querySelector('.rail')`)
await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('笔记'))?.click()`)
await sleep(400)
await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('文档库'))?.click()`)
const resumeOk = await until(`() => !!document.querySelector('.sv-article')`)
let posOk = false
let silentOk = false
if (resumeOk && typeof scrolledOrder === 'number' && scrolledOrder > 0) {
  posOk = await evalJs(`(() => {
    const sc = document.querySelector('.sv-scroll')
    if (!sc) return false
    const box = sc.getBoundingClientRect()
    for (const a of document.querySelectorAll('.sv-article')) {
      if (a.getBoundingClientRect().bottom >= box.top + 64) {
        return Math.abs(Number(a.getAttribute('data-order')) - ${scrolledOrder}) <= 3
      }
    }
    return false
  })()`)
  silentOk = await evalJs(`![...document.querySelectorAll('*')].some(el => el.children.length === 0 && el.textContent?.includes('已回到上次阅读位置'))`)
}

// 缩放记忆：重开同一法条应回到上次比例（随后复位，不影响后续用例）
const zoomPersistOk = resumeOk
  ? (await evalJs(`parseFloat(document.querySelector('.sv-col')?.style.zoom || '1')`)) > 1.05
  : false
await evalJs(`document.querySelector('.sv-zoom-reset')?.click()`)
await sleep(500)

// ---------- 导出 ----------
console.log('=== 10. 导出 md ===')
let exportOk = false
{
  await evalJs(`(() => { const b = document.querySelector('.sv-back'); if (b) b.click(); return true })()`)
  await until(`() => !!document.querySelector('.rail')`)
  await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('笔记'))?.click()`)
  await sleep(400)
  await evalJs(`[...document.querySelectorAll('.np-card')].find(b => b.textContent.includes('自测笔记'))?.click()`)
  await until(`() => !!document.querySelector('.ol-title')`)
  exportOk = await evalJs(`(async () => {
    const l = await window.lexbench.outlines.list()
    const n = l.find(x => x.title === '自测笔记')
    if (!n || !window.lexbench.outlines.__testExport) return false
    try {
      const res = await window.lexbench.outlines.__testExport(n.id, 'md', 'C:\\\\Users\\\\Public\\\\lexbench-notes-selftest.md')
      return res && res.canceled === false
    } catch (e) { return false }
  })()`)
}

// ---------- 分类 / 贴图 / 导图 ----------
console.log('=== 11. 分类 / 贴图 / 导图编辑 ===')
let catOk = false
let catFilterOk = false
let nestedOk = false
let bodySearchOk = false
let imgOk = false
let imgDbOk = false
let mapOk = false
let mapEditOk = false
let mapImageKept = false
let mapModeOk = false
{
  await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('笔记'))?.click()`)
  await sleep(400)
  await evalJs(`(() => { const b = document.querySelector('.np-nav-acts .np-icon-btn[title="新建文件夹"]'); if (b) { b.click(); return true } return false })()`)
  await sleep(300)
  await evalJs(`(() => {
    const inp = document.querySelector('.np-card-input')
    if (!inp) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(inp, '自测分类')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'ok'
  })()`)
  catOk = await until(() => [...document.querySelectorAll('.np-card')].some((g) => g.textContent.includes('自测分类')))
  await evalJs(`(() => { const g = [...document.querySelectorAll('.np-card')].find((x) => x.textContent.includes('自测分类')); g?.click(); return !!g })()`)
  await sleep(300)
  await evalJs(`document.querySelector('.np-nav-acts .np-icon-btn[title^="新建笔记"]')?.click()`)
  await until(() => !!document.querySelector('.ol-title'))
  catFilterOk = await evalJs(`window.lexbench.outlines.list().then((l) => l.some((n) => n.group_id !== null))`)

  // 嵌套文件夹：在「自测分类」内新建子文件夹，parent_id 应指向当前层
  await evalJs(`document.querySelector('.np-nav-acts .np-icon-btn[title="新建文件夹"]')?.click()`)
  await sleep(300)
  await evalJs(`(() => {
    const inp = document.querySelector('.np-card-input')
    if (!inp) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(inp, '自测子分类')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  })()`)
  nestedOk = await until(`() => window.lexbench.noteGroups.list().then((gs) => {
    const p = gs.find((g) => g.name === '自测分类')
    const c = gs.find((g) => g.name === '自测子分类')
    return !!p && !!c && c.parent_id === p.id
  })`)

  // 正文搜索：标题不含关键词，命中来自正文并回带摘录
  await evalJs(`window.__ltSet(0, '正文命中关键词：独角兽')`)
  await sleep(900)
  await evalJs(`(() => {
    const inp = document.querySelector('.np-search-input')
    if (!inp) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(inp, '独角兽')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  bodySearchOk = await until(`() => [...document.querySelectorAll('.np-item')].some((x) => x.querySelector('.np-item-snippet')?.textContent.includes('独角兽'))`, 16)
  await evalJs(`document.querySelector('.np-search-clear')?.click()`)
  await sleep(300)

  await evalJs(`window.__ltSet(0, '贴图载体行')`)
  await sleep(300)
  imgOk = await evalJs(`(() => {
    const ta = document.querySelector('.ol-text')
    if (!ta) return false
    ta.focus()
    const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const file = new File([arr], 'x.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return true
  })()`)
  imgOk = imgOk && (await until(() => !!document.querySelector('.ol-img')))
  imgDbOk = await until(() => {
    return window.lexbench.outlines.list().then(async (l) => {
      const n = l.find((x) => x.group_id !== null)
      if (!n) return false
      const d = await window.lexbench.outlines.get(n.id)
      return JSON.parse(d.tree).some((x) => !!(x.image || x.images?.length))
    })
  })

  await evalJs(`[...document.querySelectorAll('.ol-view-switch button')].find((x) => x.textContent.includes('导图'))?.click()`)
  mapOk = await until(() => document.querySelectorAll('jmnode').length >= 2)
  await sleep(600)
  // 先点选节点，再用 Space 进入编辑（比合成 dblclick 稳定）
  await evalJs(`(() => {
    const n = [...document.querySelectorAll('jmnode')].find((x) => !x.classList.contains('root') && x.textContent.includes('贴图载体行'))
    if (!n) return false
    const r = n.getBoundingClientRect()
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    const host = document.querySelector('.ol-mind')
    host?.focus()
    host?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    return true
  })()`)
  const editing = await until(() => !!document.querySelector('.ol-mind .jsmind-editor'))
  if (editing) {
    await evalJs(`(() => {
      const inp = document.querySelector('.ol-mind .jsmind-editor')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(inp, '导图自测节点')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      const ke = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      Object.defineProperty(ke, 'keyCode', { value: 13 })
      inp.dispatchEvent(ke)
      return true
    })()`)
    await sleep(900)
  }
  const editSaved = editing && (await until(() => {
    return window.lexbench.outlines.list().then(async (l) => {
      const n = l.find((x) => x.group_id !== null)
      if (!n) return false
      const d = await window.lexbench.outlines.get(n.id)
      const walk = (ns) => ns.some((x) => x.text === '导图自测节点' || walk(x.children ?? []))
      return walk(JSON.parse(d.tree))
    })
  }))
  await evalJs(`[...document.querySelectorAll('.ol-view-switch button')].find((x) => x.textContent.includes('大纲'))?.click()`)
  const editUiOk = await until(() => [...document.querySelectorAll('.ol-text')].some((t) => t.textContent.includes('导图自测节点')))
  mapEditOk = editing && editSaved && editUiOk
  mapImageKept = await evalJs(`(async () => {
    const l = await window.lexbench.outlines.list()
    const n = l.find((x) => x.group_id !== null)
    if (!n) return false
    const d = await window.lexbench.outlines.get(n.id)
    return JSON.parse(d.tree).some((x) => !!(x.image || x.images?.length))
  })()`)
  mapModeOk = await evalJs(`(async () => {
    const l = await window.lexbench.outlines.list()
    const n = l.find((x) => x.group_id !== null)
    if (!n) return false
    const d = await window.lexbench.outlines.get(n.id)
    return d.view_mode === 'outline'
  })()`)
}

// ---------- 导图拖动 / 缩放（用户点名的核心交互） ----------
console.log('=== 11b. 导图拖动 + 缩放 ===')
let mapDragOk = false
let mapZoomOk = false
let mapChromeOk = false
let mapEditorGrowOk = false
let mapImageOk = false
let mapBalanceOk = false
let mapElasticOk = false
let mapWheelZoomOk = false
let mapWheelPanOk = false
let mapEditImageOk = false
let mapLookOk = false
let mapLookStructureOk = false
let mapLookPersistOk = false
let mapLookThemeOk = false
let headMenuFitOk = false
{
  await evalJs(`(async () => {
    const l = await window.lexbench.outlines.list()
    for (const n of l) if (n.title === '拖动自测') await window.lexbench.outlines.remove(n.id)
    const row = await window.lexbench.outlines.create('拖动自测', null)
    const tree = [
      { id: 'a', text: 'A', children: [{ id: 'a1', text: 'A1', children: [] }] },
      { id: 'b', text: 'B', children: [] },
      { id: 'c', text: 'C', children: [] }
    ]
    await window.lexbench.outlines.save(row.id, JSON.stringify(tree))
    await window.lexbench.outlines.setViewMode(row.id, 'map')
    return true
  })()`)
  await send('Page.reload', {})
  await sleep(2500)
  await waitMounted()
  await injectHelpers()
  await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('笔记'))?.click()`)
  await sleep(400)
  await evalJs(`[...document.querySelectorAll('.np-card')].find(b => b.textContent.includes('拖动自测'))?.click()`)
  await until(() => document.querySelectorAll('jmnode').length >= 4)
  await sleep(800)
  // 空白画布弹性 + 平移（小图也要有四个方向的可拖动空间）
  const mapPan = await evalJs(`(() => {
    const host = document.querySelector('.ol-mind')
    const inner = document.querySelector('.jsmind-inner')
    if (!host || !inner) return null
    const elastic = inner.scrollWidth > inner.clientWidth && inner.scrollHeight > inner.clientHeight
    const r = host.getBoundingClientRect()
    const sx = r.x + 20, sy = r.y + 20
    const before = { l: inner.scrollLeft, t: inner.scrollTop }
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: sx, clientY: sy }))
    host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: sx - 80, clientY: sy - 60 }))
    host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: sx - 80, clientY: sy - 60 }))
    return { elastic, before, after: { l: inner.scrollLeft, t: inner.scrollTop } }
  })()`)
  mapElasticOk = !!mapPan && mapPan.elastic && (mapPan.after.l > mapPan.before.l || mapPan.after.t > mapPan.before.t)

  // 顶层分支智能分侧：两侧都要有节点，不能全部挤在右边
  mapBalanceOk = await evalJs(`(() => {
    const root = [...document.querySelectorAll('jmnode')].find(n => n.classList.contains('root'))
    if (!root) return false
    const rr = root.getBoundingClientRect()
    const rc = rr.x + rr.width / 2
    let left = 0
    let right = 0
    for (const n of document.querySelectorAll('jmnode')) {
      if (n === root) continue
      const r = n.getBoundingClientRect()
      if (r.x + r.width / 2 < rc) left++
      else right++
    }
    return left > 0 && right > 0
  })()`)
  const dragSent = await evalJs(`(() => {
    const nodes = [...document.querySelectorAll('jmnode')]
    const a = nodes.find(n => n.textContent === 'A')
    const b = nodes.find(n => n.textContent === 'B')
    if (!a || !b) return false
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect()
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: br.x + br.width / 2, clientY: br.y + br.height / 2 }))
    for (let i = 1; i <= 12; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: br.x + br.width / 2 + (ar.x + ar.width / 2 - br.x - br.width / 2) * i / 12, clientY: br.y + br.height / 2 + (ar.y + ar.height / 2 - br.y - br.height / 2) * i / 12 }))
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: ar.x + ar.width / 2, clientY: ar.y + ar.height / 2 }))
    return true
  })()`)
  mapDragOk = dragSent && (await until(() => {
    return window.lexbench.outlines.list().then(async (l) => {
      const n = l.find((x) => x.title === '拖动自测')
      if (!n) return false
      const d = await window.lexbench.outlines.get(n.id)
      const t = JSON.parse(d.tree)
      const a = t.find((x) => x.id === 'a')
      return !!a && (a.children ?? []).some((c) => c.id === 'b')
    })
  }))
  const zoomBefore = await evalJs(`document.querySelector('.mm-zoom-val')?.textContent`)
  // 小图在 100% 时缩小会被 jsMind 拒绝（图比视口还小），用放大断言控件链路
  await evalJs(`[...document.querySelectorAll('.mm-zoom button')].find(b => (b.title || '').includes('放大'))?.click()`)
  await sleep(350)
  const zoomAfter = await evalJs(`document.querySelector('.mm-zoom-val')?.textContent`)
  mapZoomOk = !!zoomBefore && !!zoomAfter && zoomBefore !== zoomAfter

  // 触控板捏合 = ctrl+wheel 缩放；双指滑动 = wheel 平移
  const wheelZ0 = await evalJs(`document.querySelector('.mm-zoom-val')?.textContent`)
  await evalJs(`(() => { const p = document.querySelector('.jsmind-inner'); p?.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true })); return true })()`)
  // 隐藏窗口定时器会节流：等缩放百分比真正变化，别固定短睡（lessons #2）
  let wheelZ1 = wheelZ0
  for (let i = 0; i < 12; i++) {
    await sleep(250)
    wheelZ1 = await evalJs(`document.querySelector('.mm-zoom-val')?.textContent`)
    if (wheelZ1 && wheelZ1 !== wheelZ0) break
  }
  mapWheelZoomOk = !!wheelZ0 && !!wheelZ1 && wheelZ0 !== wheelZ1
  const wheelPan0 = await evalJs(`document.querySelector('.jsmind-inner')?.scrollTop ?? -1`)
  await evalJs(`(() => { const p = document.querySelector('.jsmind-inner'); p?.dispatchEvent(new WheelEvent('wheel', { deltaY: 90, bubbles: true, cancelable: true })); return true })()`)
  let wheelPan1 = wheelPan0
  for (let i = 0; i < 12; i++) {
    await sleep(200)
    wheelPan1 = await evalJs(`document.querySelector('.jsmind-inner')?.scrollTop ?? -1`)
    if (wheelPan1 > wheelPan0) break
  }
  mapWheelPanOk = wheelPan0 >= 0 && wheelPan1 > wheelPan0

  // 白底 + 不常驻底部工具条（反馈修正）
  mapChromeOk = await evalJs(`(() => {
    const m = document.querySelector('.ol-mind')
    return !document.querySelector('.mm-toolbar') && !!document.querySelector('.mm-fab') && !!m && getComputedStyle(m).backgroundColor === 'rgb(255, 255, 255)'
  })()`)

  // 编辑框随键入扩展（jsMind 默认固定宽度会截住长文本）
  await evalJs(`(() => { const n = [...document.querySelectorAll('jmnode')].find(x => x.textContent === 'A'); n?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return !!n })()`)
  const growEditor = await until(`() => !!document.querySelector('.jsmind-editor')`)
  if (growEditor) {
    const w0 = await evalJs(`document.querySelector('.jsmind-editor')?.getBoundingClientRect().width ?? 0`)
    await evalJs(`(() => {
      const inp = document.querySelector('.jsmind-editor')
      if (!inp) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(inp, '这是一段很长的导图节点文字用来测试编辑框是否随输入扩展')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(400)
    const w1 = await evalJs(`document.querySelector('.jsmind-editor')?.getBoundingClientRect().width ?? 0`)
    mapEditorGrowOk = w1 > w0 + 80
    await evalJs(`(() => {
      const inp = document.querySelector('.jsmind-editor')
      if (!inp) return false
      const ke = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      Object.defineProperty(ke, 'keyCode', { value: 13 })
      inp.dispatchEvent(ke)
      return true
    })()`)
    await sleep(500)
  }

  // 导图节点内插入图片（根节点选中时也要能落图）
  await evalJs(`(() => {
    const n = document.querySelector('jmnode[nodeid="a"]')
    if (!n) return false
    const r = n.getBoundingClientRect()
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    return true
  })()`)
  await sleep(250)
  await evalJs(`(() => {
    const host = document.querySelector('.ol-mind')
    host?.focus()
    const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const file = new File([arr], 'x.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    host?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return true
  })()`)
  const mapImageUi = await until(() => !!document.querySelector('jmnode[nodeid="a"] .mm-node-img'))
  const mapImageDb = await until(() => {
    return window.lexbench.outlines.list().then(async (l) => {
      const n = l.find((x) => x.title === '拖动自测')
      if (!n) return false
      const d = await window.lexbench.outlines.get(n.id)
      const a = JSON.parse(d.tree).find((x) => x.id === 'a')
      return !!a && (!!a.image || (a.images?.length ?? 0) > 0)
    })
  })
  mapImageOk = mapImageUi && mapImageDb

  // 正在键入节点时粘贴图片：挂在当前主题，不新建方框
  const editImgCount0 = await evalJs(`document.querySelectorAll('jmnode').length`)
  await evalJs(`(() => {
    const n = document.querySelector('jmnode[nodeid="b"]')
    if (!n) return false
    const r = n.getBoundingClientRect()
    n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    const host = document.querySelector('.ol-mind')
    host?.focus()
    host?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    return true
  })()`)
  const editImgEditing = await until(`() => !!document.querySelector('.jsmind-editor')`)
  if (editImgEditing) {
    await evalJs(`(() => {
      const inp = document.querySelector('.jsmind-editor')
      const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const file = new File([arr], 'z.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      inp?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return true
    })()`)
    await sleep(1200)
  }
  const editImgCount1 = await evalJs(`document.querySelectorAll('jmnode').length`)
  const editImgDb = await until(() => {
    return window.lexbench.outlines.list().then(async (l) => {
      const n = l.find((x) => x.title === '拖动自测')
      if (!n) return false
      const d = await window.lexbench.outlines.get(n.id)
      // B 已被前面的拖动用例挂到 A 下面，不能只查顶层
      const walk = (ns) => ns.some((x) => (x.id === 'b' && (!!x.image || (x.images?.length ?? 0) > 0)) || walk(x.children ?? []))
      return walk(JSON.parse(d.tree))
    })
  })
  mapEditImageOk = editImgEditing && editImgCount1 === editImgCount0 && editImgDb

  // 外观面板：结构 / 配色（右上角第二个圆钮）
  const lookId = await evalJs(`window.lexbench.outlines.list().then((l) => l.find((x) => x.title === '拖动自测')?.id ?? null)`)
  await evalJs(`document.querySelector('.mm-look-wrap .mm-fab')?.click()`)
  mapLookOk =
    (await until(
      `() => document.querySelectorAll('.mm-fab-bar .mm-fab').length === 2 && document.querySelectorAll('.mm-struct-card').length === 4 && document.querySelectorAll('.mm-swatch').length === 9`
    )) === true
  await evalJs(`[...document.querySelectorAll('.mm-struct-card')].find((x) => x.textContent.includes('单向右展'))?.click()`)
  await sleep(600)
  mapLookStructureOk = await evalJs(`(() => {
    const root = [...document.querySelectorAll('jmnode')].find((n) => n.classList.contains('root'))
    if (!root) return false
    const rr = root.getBoundingClientRect()
    const rc = rr.x + rr.width / 2
    return [...document.querySelectorAll('jmnode')].every((n) => {
      if (n === root) return true
      const r = n.getBoundingClientRect()
      return r.x + r.width / 2 > rc
    })
  })()`)
  mapLookPersistOk = await evalJs(
    `window.lexbench.settings.get('note:map:look:${lookId}').then((v) => !!v && JSON.parse(v).structure === 'right')`
  )
  await evalJs(`document.querySelectorAll('.mm-swatch')[6]?.click()`)
  await sleep(350)
  mapLookThemeOk = await evalJs(
    `getComputedStyle(document.querySelector('.ol-mind')).backgroundColor === 'rgb(25, 28, 33)'`
  )
  // 还原默认外观，避免影响后续断言与清理
  await evalJs(`(() => {
    document.querySelectorAll('.mm-swatch')[0]?.click()
    document.querySelectorAll('.mm-struct-card')[0]?.click()
    document.querySelector('.ol-mind')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })()`)
  await sleep(350)

  // 头部「⋯」菜单靠右展开：不能越出 .main / 视口被裁掉
  await evalJs(`(() => {
    if (!document.querySelector('.ol-head .ol-menu')) document.querySelector('.ol-head .ol-more')?.click()
    return true
  })()`)
  await sleep(300)
  headMenuFitOk = await evalJs(`(() => {
    const m = document.querySelector('.ol-head .ol-menu')
    const main = document.querySelector('.main')
    if (!m || !main) return false
    const r = m.getBoundingClientRect()
    const mr = main.getBoundingClientRect()
    return r.left >= mr.left && r.right <= mr.right && r.right <= innerWidth && r.bottom <= innerHeight
  })()`)
  await evalJs(`document.querySelector('.ol-head .ol-more')?.click()`)
  await sleep(200)

  await evalJs(`(async () => {
    const l = await window.lexbench.outlines.list()
    for (const n of l) if (n.title === '拖动自测') await window.lexbench.outlines.remove(n.id)
    return true
  })()`)
}

// ---------- 通用导入 ----------
console.log('=== 12. 通用导入 ===')
let importPreviewOk = false
let importRunOk = false
let importDupOk = false
let importTreeOk = false
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const fixDir = mkdtempSync(join(tmpdir(), 'lexbench-import-'))
  const fixPaths = [join(fixDir, '套件OPML.opml'), join(fixDir, '套件HTML.html'), join(fixDir, '套件MD.md')]
  writeFileSync(
    fixPaths[0],
    '<?xml version="1.0"?><opml version="2.0"><head><title>套件OPML大纲</title></head><body>' +
      '<outline text="第一章"><outline text="任务项" _complete="true"/></outline><outline text="第二章"/></body></opml>',
    'utf8'
  )
  writeFileSync(fixPaths[1], '<html><head><title>套件HTML大纲</title></head><body><ul><li>甲<ul><li>乙</li></ul></li><li>丙</li></ul></body></html>', 'utf8')
  writeFileSync(fixPaths[2], '# 套件MD大纲\n- 上一\n  - 下一\n', 'utf8')
  const fixJson = JSON.stringify(fixPaths.map((p) => p.split('\\').join('/')))

  const preview = await evalJs(`window.lexbench.outlines.previewImport(${fixJson})`)
  importPreviewOk =
    Array.isArray(preview) &&
    preview.length === 3 &&
    preview.every((p) => !p.error) &&
    preview[0].format === 'opml' &&
    preview[1].format === 'html' &&
    preview[2].format === 'md'

  const run = await evalJs(`window.lexbench.outlines.runImport(${fixJson}, 'skip')`)
  importRunOk = Array.isArray(run) && run.length === 3 && run.every((r) => r.status === 'imported')

  const rerun = await evalJs(`window.lexbench.outlines.runImport(${fixJson}, 'skip')`)
  importDupOk = Array.isArray(rerun) && rerun.every((r) => r.status === 'skipped')

  importTreeOk = await evalJs(`(async () => {
    const l = await window.lexbench.outlines.list()
    const n = l.find((x) => x.title === '套件OPML大纲')
    if (!n) return false
    const d = await window.lexbench.outlines.get(n.id)
    const t = JSON.parse(d.tree)
    return t.length === 2 && t[0].children[0].text.includes('[✓]') && t[1].text === '第二章'
  })()`)

  rmSync(fixDir, { recursive: true, force: true })
  await evalJs(`(async () => {
    const l = await window.lexbench.outlines.list()
    for (const x of l) if (x.title.includes('套件')) await window.lexbench.outlines.remove(x.id)
    return true
  })()`)
}

// ---------- 收尾 ----------
console.log('=== 13. 收尾清理 ===')
await evalJs(`(async () => {
  const s = await window.lexbench.outlines.listStarred()
  for (const x of s) await window.lexbench.outlines.setStarred(x.article_id, false)
  const l = await window.lexbench.outlines.list()
  for (const n of l) await window.lexbench.outlines.remove(n.id)
  const g = await window.lexbench.noteGroups.list()
  for (const x of g) await window.lexbench.noteGroups.remove(x.id)
  return (await window.lexbench.outlines.list()).length === 0
})()`)
try {
  const { rmSync } = await import('node:fs')
  rmSync('C:\\Users\\Public\\lexbench-notes-selftest.md', { force: true })
} catch {
  /* 不存在就算了 */
}
const cleanOk = await evalJs(`window.lexbench.outlines.list().then(l => l.length === 0)`)
await evalJs(`[...document.querySelectorAll('.rail-item')].find(b => b.textContent.includes('文档库'))?.click()`)

console.log('\n=== 结论 ===')
const checks = [
  ['编辑器出现', editorUp],
  ['Enter 分行', enterOk],
  ['Tab 缩进（行首）', indentOk],
  ['缩进编辑时无高光', editHighlightOk],
  ['Shift+Tab 反缩进', outdentOk],
  ['行首 Backspace 并入上一行', mergeOk],
  ['大纲页面触控板缩放', outlineZoomOk],
  ['大纲横向可平移空间', outlinePanSpaceOk],
  ['圆点多选（Ctrl+点击）', multiSelectOk],
  ['大纲拖动改挂载', outlineDragOk && outlineDragTreeOk],
  ['折叠 + 计数', foldOk],
  ['展开恢复', unfoldOk],
  ['标题自动保存落库', titleSaved],
  ['树内容落库', treeSaved],
  ['往返快照（切走切回不丢）', roundtripOk],
  ['/ 唤出插入浮层', pickerOpen],
  ['浮层出候选', pickerHits],
  ['＋插入引用行', addOk],
  ['浮层不关（连加）', stillOpen],
  ['第二条继续插入', secondOk],
  ['✕ 关闭浮层', pickerClosed],
  ['引用节点 ref 落库', refSaved],
  ['粘贴生成引用节点', pasteRefOk && pasteRefRowOk],
  ['逃生门 API + contextmenu 派发', escapeOk],
  ['打开法规阅读页', inReading],
  ['星标按钮点亮', starClickOk],
  ['星标落库', starDbOk],
  ['返回文档库（Tab 恢复）', backOk],
  ['笔记往返后静默重开阅读', resumeOk],
  ['恢复位置（容差±3条）', posOk],
  ['静默恢复（无横幅）', silentOk],
  ['阅读缩放：捏合生效', zoomOk],
  ['阅读缩放后目录跳转不偏移', zoomJumpOk],
  ['阅读缩放：重开记住比例', zoomPersistOk],
  ['导出 md（自测通道）', exportOk],
  ['分类：面板新建 + 落分类', catOk && catFilterOk],
  ['分类：嵌套子文件夹落父级', nestedOk],
  ['搜索：正文命中带摘录', bodySearchOk],
  ['贴图：粘贴渲染 + 落库', imgOk && imgDbOk],
  ['导图：⇄ 渲染节点', mapOk],
  ['导图：编辑回写大纲', mapEditOk],
  ['导图往返贴图元数据保留', mapImageKept],
  ['view_mode 记忆落库', mapModeOk],
  ['导图：节点拖动改挂载', mapDragOk],
  ['导图：缩放控件', mapZoomOk],
  ['导图：白底且无底部工具条', mapChromeOk],
  ['导图：编辑框随输入扩展', mapEditorGrowOk],
  ['导图：节点内插入图片', mapImageOk],
  ['导图：顶层分支智能分侧', mapBalanceOk],
  ['导图：空白画布四向平移', mapElasticOk],
  ['导图：触控板捏合缩放', mapWheelZoomOk],
  ['导图：触控板双指平移', mapWheelPanOk],
  ['导图：编辑中粘贴图片不新建方框', mapEditImageOk],
  ['导图：外观面板（结构 + 配色）', mapLookOk],
  ['导图：结构切换生效', mapLookStructureOk],
  ['导图：结构选择落库', mapLookPersistOk],
  ['导图：深色配色生效', mapLookThemeOk],
  ['笔记头部⋯菜单不被裁切', headMenuFitOk],
  ['导入：预检三格式', importPreviewOk],
  ['导入：执行落库', importRunOk],
  ['导入：同源重复 skip', importDupOk],
  ['导入：OPML 树结构', importTreeOk],
  ['测试数据已清理', cleanOk],
  ['零控制台错误', errors.length === 0]
]
let pass = true
for (const [name, ok] of checks) {
  console.log((ok ? '✅' : '❌'), name)
  if (!ok) pass = false
}
if (errors.length) console.log('\n控制台错误详情:\n' + errors.join('\n'))
process.exit(pass ? 0 : 1)
