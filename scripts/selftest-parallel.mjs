// 平行视图 CDP 自测：一笔记一视图、分屏/浮动布局、分隔条、文档窗、笔记落盘、重置布局。
// 前提：npm run dev 已启动（开发模式开放 9222，数据隔离在 %APPDATA%/lexbench-dev）。
// 用法：node scripts/selftest-parallel.mjs
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const errors = []
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}

const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = pages.find(
  (p) => p.type === 'page' && /localhost:5173/.test(p.url) && !p.url.includes('aiWindow')
)
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
    errors.push(
      'CONSOLE-ERROR: ' +
        m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 1000)
    )
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
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('EVALJS_TIMEOUT(15s)：渲染无响应（锁屏或窗口挂起？）')), 15000)
    )
  ]).catch((e) => ({ exceptionDetails: { exception: { description: String(e) } } }))
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || 'eval error' }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(expr, label, timeout = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await evalJs(expr)) return true
    await sleep(150)
  }
  console.log('TIMEOUT:', label)
  return false
}

async function drag(selector, dx, dy) {
  const box = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  })()`)
  if (!box || box.__error) return false
  const p = JSON.parse(box)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: p.x,
    y: p.y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: p.x + dx,
    y: p.y + dy,
    button: 'left',
    buttons: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: p.x + dx,
    y: p.y + dy,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await sleep(650)
  return true
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(tmpdir(), `${name}.png`), Buffer.from(r.data, 'base64'))
}

for (let i = 0; i < 40; i += 1) {
  if (await evalJs(`!!document.querySelector('.topbar')`)) break
  await sleep(300)
}

// 从干净页面开始：上一次自测/手工操作可能还停在某个工作区现场
await evalJs('location.reload()')
await sleep(1500)
for (let i = 0; i < 40; i += 1) {
  if (await evalJs(`!!document.querySelector('.topbar')`)) break
  await sleep(300)
}

// 清理上次中断可能留下的自测笔记
await evalJs(`(async () => {
  const list = await window.lexbench.outlines.list()
  for (const n of list.filter((x) => x.title === '平行视图自测' || x.title === '浮窗诊断')) await window.lexbench.outlines.remove(n.id)
})()`)

const docs = (await evalJs(`(async () => {
  const list = await window.lexbench.library.listDocuments()
  return JSON.stringify(list.slice(0, 3).map((d) => d.id))
})()`)) || '[]'
const docIds = JSON.parse(docs)
const noteId = await evalJs(`(async () => {
  const row = await window.lexbench.outlines.create('平行视图自测')
  await window.lexbench.outlines.save(row.id, JSON.stringify([{ id: 'n1', text: '自测起点', children: [] }]))
  return row.id
})()`)
check('新建自测笔记', Number.isInteger(noteId), String(noteId || ''))

// 默认存档（一笔记、无文档）
await evalJs(`(async () => {
  const layout = {
    v: 1, mode: 'split', noteRatio: 0.42, rowRatios: [], colRatios: [],
    panes: [{ id: 'note', kind: 'note', rect: { x: 0, y: 0, w: 0.42, h: 1 }, z: 0 }]
  }
  await window.lexbench.parallelViews.save(${JSON.stringify(noteId)}, JSON.stringify(layout), '')
})()`)
await until(`!!document.querySelector('[data-guide="rail-workspace"]')`, '第三个竖排入口')
check(
  '左侧出现平行入口',
  await evalJs(`!!document.querySelector('[data-guide="rail-workspace"]')`)
)

// 打开存档
await evalJs(
  `document.querySelector('[data-guide="rail-workspace"]')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`
)
await sleep(500)
const viewCount = await evalJs(`document.querySelectorAll('.pv-card').length`)
check('悬停面板列出存档', Number(viewCount) >= 1, String(viewCount))
// 创建入口必须明确二选一：新建笔记 / 从现有笔记创建
await evalJs(`document.querySelector('.pv-new')?.click()`)
await until(`!!document.querySelector('.pc-dialog')`, '创建对话框')
const optionCount = await evalJs(`document.querySelectorAll('[data-pc-option]').length`)
check('创建时明确两种方式', Number(optionCount) === 2, String(optionCount))
await evalJs(`document.querySelector('[data-pc-option="existing"]')?.click()`)
await until(`!!document.querySelector('.pc-note')`, '现有笔记列表')
check(
  '从现有笔记创建时直接展示笔记',
  (await evalJs(`document.querySelectorAll('.pc-note').length`)) > 0
)
check('搜索默认收起', (await evalJs(`!!document.querySelector('.pc-search-input')`)) === false)
await evalJs(`document.querySelector('[data-pc-search-toggle]')?.click()`)
await until(`!!document.querySelector('.pc-search-input')`, '搜索展开')
check('搜索作为可选操作展开', await evalJs(`!!document.querySelector('.pc-search-input')`))
await evalJs(`document.querySelector('[data-pc-search-toggle]')?.click()`)
await sleep(300)
check('搜索可收起回完整列表', (await evalJs(`!!document.querySelector('.pc-search-input')`)) === false)
await evalJs(`document.querySelector('.pc-note[data-note-id="${noteId}"]')?.click()`)
await until(`!!document.querySelector('[data-workspace-root]')`, '工作区挂载', 15000)
await until(`!!document.querySelector('[data-workspace-root] .ol')`, '笔记窗挂载', 12000)
check('工作区与笔记窗挂载', await evalJs(`!!document.querySelector('[data-workspace-root] .ol')`))
check(
  '默认分屏模式',
  (await evalJs(`document.querySelector('[data-workspace-root]')?.dataset.mode`)) === 'split'
)

// 通过「+ 文档」添加一个文档窗
if (docIds.length) {
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.ws-btn')].find((x) => x.textContent.includes('文档'))
    b?.click()
  })()`)
  await until(`document.querySelectorAll('.dp-item').length > 0`, '文档选择器')
  await evalJs(`document.querySelector('.dp-item')?.click()`)
  await until(`document.querySelectorAll('[data-pane-kind="doc"]').length >= 1`, '文档窗')
  await until(`!document.querySelector('.dp-mask')`, '文档选择器关闭')
  await sleep(600)
  check(
    '从文档库添加文档窗',
    (await evalJs(`document.querySelectorAll('[data-pane-kind="doc"]').length`)) >= 1
  )
  check('文档窗渲染阅读器', await evalJs(`!!document.querySelector('[data-pane-id] .sv, [data-pane-id] .rv')`))
}

// 分隔条：拖动笔记窗宽并持久化
const noteRatioBefore = await evalJs(`(async () => {
  const r = await window.lexbench.parallelViews.get(${JSON.stringify(noteId)})
  return r ? JSON.parse(r.layout).noteRatio : 0
})()`)
await drag('.ws-vsplit', 80, 0)
await sleep(800)
const noteRatioAfter = await evalJs(`(async () => {
  const r = await window.lexbench.parallelViews.get(${JSON.stringify(noteId)})
  return r ? JSON.parse(r.layout).noteRatio : 0
})()`)
check(
  '拖动分隔条并持久化',
  Math.abs(Number(noteRatioAfter) - Number(noteRatioBefore)) > 0.01,
  `${noteRatioBefore} -> ${noteRatioAfter}`
)

// 浮动模式：拖动窗头 + 右下角缩放
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.ws-mode button')].find((x) => x.textContent.trim() === '浮动')
  b?.click()
})()`)
await sleep(600)
check(
  '切到浮动模式',
  (await evalJs(`document.querySelector('[data-workspace-root]')?.dataset.mode`)) === 'float'
)
const floatDocId =
  (await evalJs(
    `document.querySelector('.ws-pane.floating[data-pane-kind="doc"]')?.dataset.paneId ?? ''`
  )) || ''
const rectBefore = await evalJs(`(() => {
  const p = document.querySelector('.ws-pane.floating[data-pane-id="${floatDocId}"]')
  return p ? p.getAttribute('style') : ''
})()`)
// 浮窗初始贴右边/满高：只有向左上拖才有可移动空间
await drag(`.ws-pane.floating[data-pane-id="${floatDocId}"] .ws-pane-head`, -80, -30)
const rectAfter = await evalJs(`(() => {
  const p = document.querySelector('.ws-pane.floating[data-pane-id="${floatDocId}"]')
  return p ? p.getAttribute('style') : ''
})()`)
check('浮动窗可拖动', !!rectBefore && rectBefore !== rectAfter)
if (floatDocId) {
  const sizeBefore = await evalJs(`(() => {
    const p = document.querySelector('.ws-pane.floating[data-pane-id="${floatDocId}"]')
    return p ? p.style.width : ''
  })()`)
  await drag(`.ws-pane.floating[data-pane-id="${floatDocId}"] .rz-se`, -50, -40)
  const sizeAfter = await evalJs(`(() => {
    const p = document.querySelector('.ws-pane.floating[data-pane-id="${floatDocId}"]')
    return p ? p.style.width : ''
  })()`)
  check('浮动窗可缩放', !!sizeBefore && sizeBefore !== sizeAfter, `${sizeBefore} -> ${sizeAfter}`)
}

// 选中窗整体置顶（含窗内 fixed 浮层）+ 常驻置顶
if (floatDocId) {
  await evalJs(`document.querySelector('[data-pane-id="${floatDocId}"] .ws-pa.pin')?.click()`)
  await sleep(400)
  const pinOn = await evalJs(`!!document.querySelector('[data-pane-id="${floatDocId}"] .ws-pa.pin.on')`)
  check('常驻置顶可开启', pinOn === true)
  // 激活笔记窗：选中窗 z 必须高于常驻窗
  const noteHead = await evalJs(`(() => {
    const h=document.querySelector('[data-pane-id="note"] .ws-pane-head')
    if(!h) return null
    const r=h.getBoundingClientRect()
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})
  })()`)
  if (noteHead) {
    const p = JSON.parse(noteHead)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(400)
  }
  const zs = await evalJs(`JSON.stringify([...document.querySelectorAll('.ws-pane.floating')].map((p) => ({ id: p.dataset.paneId, z: Number(getComputedStyle(p).zIndex) })))`)
  const zObj = typeof zs === 'string' ? JSON.parse(zs || '[]') : []
  if (typeof zs !== 'string') console.log('zProbe:', JSON.stringify(zs))
  const noteZ = zObj.find((p) => p.id === 'note')?.z ?? 0
  const docZ = zObj.find((p) => p.id === floatDocId)?.z ?? 0
  check('常驻窗压过选中的普通窗', docZ > noteZ, `note=${noteZ}, doc=${docZ}`)
  // 再选中常驻窗：它应是全场最高
  const docHead = await evalJs(`(() => {
    const h=document.querySelector('[data-pane-id="${floatDocId}"] .ws-pane-head')
    if(!h) return null
    const r=h.getBoundingClientRect()
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})
  })()`)
  if (docHead) {
    const p = JSON.parse(docHead)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(400)
  }
  const zs2 = await evalJs(`JSON.stringify([...document.querySelectorAll('.ws-pane.floating')].map((p) => ({ id: p.dataset.paneId, z: Number(getComputedStyle(p).zIndex) })))`)
  const zObj2 = typeof zs2 === 'string' ? JSON.parse(zs2 || '[]') : []
  const maxZ = Math.max(...zObj2.map((p) => p.z))
  const pinnedZ = zObj2.find((p) => p.id === floatDocId)?.z ?? 0
  check('选中的常驻窗全场最高', pinnedZ === maxZ && pinnedZ > 0, JSON.stringify(zObj2))
}

// 全局模式：隐去左侧竖排，再恢复
const railBefore = await evalJs(`document.querySelector('.body')?.classList.contains('rail-off')`)
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.ws-btn')].find((x) => x.textContent.includes('全区'))
  b?.click()
})()`)
await sleep(500)
const railHiddenNow = await evalJs(`document.querySelector('.body')?.classList.contains('rail-off')`)
check('全局按钮隐藏左侧导航', railBefore === false && railHiddenNow === true)
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.ws-btn')].find((x) => x.textContent.includes('恢复'))
  b?.click()
})()`)
await sleep(400)
check('全局按钮可恢复左侧导航', (await evalJs(`document.querySelector('.body')?.classList.contains('rail-off')`)) === false)

// 浮动模式：编辑 -> 从面板重开同一视图（会走 workspace.flush，验证 v-for 里的编辑器 ref 不是数组）
await evalJs(`(() => {
  const el = document.querySelector('[data-workspace-root] .ol-text')
  if (!el) return false
  el.focus()
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
  document.execCommand('insertText', false, '【浮动保存】')
  return true
})()`)
await sleep(900)
await evalJs(
  `document.querySelector('[data-guide="rail-workspace"]')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`
)
await sleep(500)
await evalJs(`document.querySelector('.pv-card[data-note-id="${noteId}"]')?.click()`)
await sleep(1500)
const floatSaved = await evalJs(`(async () => {
  const r = await window.lexbench.outlines.get(${JSON.stringify(noteId)})
  return r.tree.includes('浮动保存')
})()`)
check('浮动模式切换视图不丢编辑', floatSaved === true)
check(
  '浮动模式重开后正文可见',
  (await evalJs(`document.querySelector('[data-workspace-root] .ol-text')?.textContent?.includes('浮动保存')`)) === true
)

// 切回分屏（编辑器重挂）后正文仍应在，且不被旧快照覆盖
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.ws-mode button')].find((x) => x.textContent.trim() === '分屏')
  b?.click()
})()`)
await sleep(1000)
check(
  '分屏/浮动切换不丢正文',
  (await evalJs(`document.querySelector('[data-workspace-root] .ol-text')?.textContent?.includes('浮动保存')`)) === true
)
const modeSwitchDb = await evalJs(`(async () => {
  const r = await window.lexbench.outlines.get(${JSON.stringify(noteId)})
  return r.tree.includes('浮动保存')
})()`)
check('模式切换后落库仍在', modeSwitchDb === true)
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.ws-mode button')].find((x) => x.textContent.trim() === '浮动')
  b?.click()
})()`)
await sleep(700)

// 切回分屏
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.ws-mode button')].find((x) => x.textContent.trim() === '分屏')
  b?.click()
})()`)
await sleep(600)

// 笔记落盘：编辑后切走再回来
await evalJs(`(() => {
  const el = document.querySelector('[data-workspace-root] .ol-text')
  if (!el) return false
  el.focus()
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
  document.execCommand('insertText', false, '【平行自测】')
  return true
})()`)
// 不等 500ms 防抖：编辑后立刻切方向，专门验证 get 不会跑在编辑器 flush 之前
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.rail-item')].find((x) => x.textContent.includes('笔记'))
  b?.click()
})()`)
// 不只看最终 DB：切过去后界面上就必须是新内容（防 get 跑在 flush 前的假通过）
const freshVisible = await until(
  `!!document.querySelector('.main .ol-text') && document.querySelector('.main .ol-text').textContent.includes('平行自测')`,
  '切到笔记后显示最新编辑'
)
check('切到笔记后可见最新编辑', freshVisible)
await sleep(600)
const persisted = await evalJs(`(async () => {
  const r = await window.lexbench.outlines.get(${JSON.stringify(noteId)})
  return r.tree.includes('平行自测')
})()`)
check('笔记编辑跨 tab 落盘（立即切换）', persisted === true)

// 反向：笔记 tab 编辑后立即切回平行视图
await evalJs(`(() => {
  const el = document.querySelector('.main .ol-text')
  if (!el) return false
  el.focus()
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
  document.execCommand('insertText', false, '【笔记即时】')
  return true
})()`)
await evalJs(`(() => {
  const b = document.querySelector('[data-guide="rail-workspace"]')
  b?.click()
})()`)
await sleep(1800)
const backPersisted = await evalJs(`(async () => {
  const r = await window.lexbench.outlines.get(${JSON.stringify(noteId)})
  return r.tree.includes('笔记即时') && r.tree.includes('平行自测')
})()`)
check('笔记→平行立即切换不丢编辑', backPersisted === true)
check(
  '回平行后正文包含两段编辑',
  (await evalJs(`document.querySelector('[data-workspace-root] .ol-text')?.textContent?.includes('笔记即时')`)) === true
)

// 一笔记一视图：笔记列表与视图列表数量一致
const counts = await evalJs(`(async () => JSON.stringify({
  notes: (await window.lexbench.outlines.list()).length,
  views: (await window.lexbench.parallelViews.list()).length
}))()`)
const countObj = JSON.parse(counts || '{}')
check('平行视图数量锚定笔记', countObj.notes === countObj.views, counts)

// 重置布局：视图仍在、笔记保留、布局回默认
await evalJs(
  `document.querySelector('[data-guide="rail-workspace"]')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`
)
await sleep(500)
await evalJs(`document.querySelector('.pv-card[data-note-id="${noteId}"] [data-pv-action="reset"]')?.click()`)
await sleep(400)
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.cm-btn')].find((x) => x.textContent.includes('重置布局'))
  b?.click()
})()`)
await sleep(1200)
const resetProbe = await evalJs(`(async () => {
  const row = await window.lexbench.parallelViews.get(${JSON.stringify(noteId)})
  const layout = row ? JSON.parse(row.layout) : null
  return JSON.stringify({
    inList: (await window.lexbench.parallelViews.list()).some((v) => v.note_id === ${JSON.stringify(noteId)}),
    panes: layout ? layout.panes.length : 0,
    noteRatio: layout ? layout.noteRatio : 0
  })
})()`)
const resetObj = JSON.parse(resetProbe || '{}')
check('重置后视图仍在列表', resetObj.inList === true, resetProbe)
check('重置后布局回默认', resetObj.panes === 1 && Math.abs(resetObj.noteRatio - 0.42) < 0.001, resetProbe)
const noteAlive = await evalJs(`(async () => !!(await window.lexbench.outlines.get(${JSON.stringify(noteId)}).catch(() => null)))()`)
check('重置布局保留笔记', noteAlive === true)

// 删笔记 -> 对应视图随之消失
await evalJs(`(async () => {
  await window.lexbench.outlines.remove(${JSON.stringify(noteId)}).catch(() => {})
})()`)
await sleep(600)
const afterDelete = await evalJs(`(async () => (await window.lexbench.parallelViews.list()).some((v) => v.note_id === ${JSON.stringify(noteId)}))()`)
check('删除笔记后对应视图消失', afterDelete === false)

// 二选一的另一半：新建笔记应真的多出一篇笔记 + 对应视图
const idsBeforeNew = await evalJs(`(async () => (await window.lexbench.outlines.list()).map((n) => n.id))()`)
await evalJs(
  `document.querySelector('[data-guide="rail-workspace"]')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`
)
await sleep(500)
await evalJs(`document.querySelector('.pv-new')?.click()`)
await until(`!!document.querySelector('.pc-dialog')`, '创建对话框（新建）')
await evalJs(`document.querySelector('[data-pc-option="new"]')?.click()`)
await sleep(1500)
const idsAfterNew = await evalJs(`(async () => (await window.lexbench.outlines.list()).map((n) => n.id))()`)
const newIds = Array.isArray(idsAfterNew)
  ? idsAfterNew.filter((id) => !(Array.isArray(idsBeforeNew) && idsBeforeNew.includes(id)))
  : []
check('新建笔记方式会创建新笔记', newIds.length === 1, JSON.stringify(newIds))
await evalJs(`(async () => {
  for (const id of ${JSON.stringify(newIds)}) await window.lexbench.outlines.remove(id).catch(() => {})
})()`)
await evalJs(`location.reload()`)

check('无运行时报错', errors.length === 0, errors.slice(0, 3).join(' | '))
if (errors.length) await shot('lb-selftest-parallel-fail')

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
ws.close()
