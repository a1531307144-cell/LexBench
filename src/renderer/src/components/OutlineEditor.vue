<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { shortLawName } from '@shared/lawName'
import MindMapView from './MindMapView.vue'
import type { ExportFormat, OutlineNode, OutlineRef, OutlineRow, SearchHit } from '@shared/types'

/**
 * 大纲编辑器（阶段2核心）：树拍平成行列表渲染，一行一个节点。
 * - 键位 = 业界大纲工具通用惯例：Enter 新建同级行（按光标分词）、Tab/Shift+Tab 降/升一级
 *   （仅行首）、行首 Backspace 先反缩进到底再并入上一行、↑↓ 行间移动（视觉列记忆）；
 * - 自动保存：任何改动 500ms 防抖整树 JSON 落库，卸载时强制冲刷（防丢最后半秒）；
 * - 引用节点（ref）行圆点换 📖、文本衬线体；右键逃生门/插入浮层在阶段2.3 接入。
 */
const props = defineProps<{ outline: OutlineRow }>()
const emit = defineEmits<{
  (e: 'error', err: unknown): void
  /** 标题或内容有改动并已落库（列表刷新用——树的静默自动保存不触发，避免列表跳动） */
  (e: 'list-changed'): void
  /** 引用节点右键「在文档库打开来源」（逃生门，单击不跳原则不变） */
  (e: 'open-source', ref: OutlineRef): void
  /** 「⋯」删除笔记（确认框由 App 统一管） */
  (e: 'delete-request'): void
  /** 导出成功反馈 */
  (e: 'notice', text: string): void
}>()

// ---------- 树与行模型 ----------

let idSeq = 0
function newNodeId(): string {
  idSeq += 1
  return `n${Date.now().toString(36)}${idSeq.toString(36)}`
}

function blankNode(): OutlineNode {
  return { id: newNodeId(), text: '', children: [] }
}

function parseTree(raw: string): OutlineNode[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as OutlineNode[]
  } catch {
    /* 坏数据兜底为空树 */
  }
  return []
}

const tree = ref<OutlineNode[]>(parseTree(props.outline.tree))
const title = ref(props.outline.title)
if (tree.value.length === 0) tree.value = [blankNode()]

// ---------- 视图：大纲 ⇄ 导图（笔记级记忆 view_mode） ----------
const viewMode = ref<'outline' | 'map'>(props.outline.view_mode === 'map' ? 'map' : 'outline')
const displayTitle = computed(() => title.value.trim() || '未命名笔记')

async function toggleView(): Promise<void> {
  viewMode.value = viewMode.value === 'map' ? 'outline' : 'map'
  try {
    await window.lexbench.outlines.setViewMode(props.outline.id, viewMode.value)
  } catch (e) {
    emit('error', e)
  }
}

/** 导图编辑回写：整树替换 + 落库（回流由 MindMapView 自身 pendingSelf 防环） */
function onMapChange(newTree: OutlineNode[]): void {
  tree.value = newTree.length ? newTree : [blankNode()]
  scheduleSave()
}

function onMindError(e: unknown): void {
  emit('error', e)
}

/** 拍平行：折叠子树不进列表；hidden = 折叠后被藏起来的后代数（行尾计数） */
interface FlatRow {
  node: OutlineNode
  depth: number
  hasChildren: boolean
  hidden: number
}

const rows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  const walk = (nodes: OutlineNode[], depth: number): void => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0
      let hidden = 0
      if (hasChildren && node.fold) {
        const count = (ns: OutlineNode[]): void => {
          for (const c of ns) {
            hidden += 1
            count(c.children)
          }
        }
        count(node.children)
      }
      out.push({ node, depth, hasChildren, hidden })
      if (hasChildren && !node.fold) walk(node.children, depth + 1)
    }
  }
  walk(tree.value, 0)
  return out
})

/** 定位节点：返回其所在兄弟数组与下标（结构改动后按 id 重新定位，勿缓存下标） */
function locate(
  id: string,
  nodes: OutlineNode[] = tree.value,
  parent: OutlineNode | null = null
): { arr: OutlineNode[]; idx: number; node: OutlineNode; parent: OutlineNode | null } | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n) continue
    if (n.id === id) return { arr: nodes, idx: i, node: n, parent }
    const hit = locate(id, n.children, n)
    if (hit) return hit
  }
  return null
}

function isDescendant(maybeChildId: string, ancestorId: string): boolean {
  const ancestor = locate(ancestorId)
  if (!ancestor) return false
  const walk = (ns: OutlineNode[]): boolean =>
    ns.some((n) => n.id === maybeChildId || walk(n.children))
  return walk(ancestor.node.children)
}

// ---------- 焦点管理（结构改动后按行 id 恢复光标） ----------

const rowsEl = ref<HTMLElement | null>(null)
let pendingFocus: { id: string; col: number | 'end' } | null = null

function applyFocus(): void {
  const want = pendingFocus
  pendingFocus = null
  if (!want) return
  void nextTick(() => {
    const ta = rowsEl.value?.querySelector<HTMLTextAreaElement>(`textarea[data-id="${want.id}"]`)
    if (!ta) return
    ta.focus()
    const pos = want.col === 'end' ? ta.value.length : Math.min(want.col, ta.value.length)
    ta.setSelectionRange(pos, pos)
    ta.scrollIntoView({ block: 'nearest' })
  })
}

// ---------- 行高自适应与尺寸 ----------

function sizeTa(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight}px`
}

function resizeAll(): void {
  void nextTick(() => {
    rowsEl.value?.querySelectorAll<HTMLTextAreaElement>('textarea[data-id]').forEach(sizeTa)
  })
}

function onInput(e: Event, node: OutlineNode): void {
  const ta = e.target as HTMLTextAreaElement
  node.text = ta.value
  sizeTa(ta)
  scheduleSave()
}

// ---------- 自动保存（500ms 防抖整树落库；卸载强制冲刷） ----------

let saveTimer: ReturnType<typeof setTimeout> | undefined
let dirty = false
let titleDirty = false

function scheduleSave(): void {
  dirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveNow(false), 500)
}

function scheduleTitleSave(): void {
  titleDirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveNow(true), 500)
}

async function saveNow(withTitle: boolean): Promise<void> {
  clearTimeout(saveTimer)
  if (!dirty && !withTitle) return
  const sendTitle = titleDirty || withTitle
  dirty = false
  titleDirty = false
  try {
    await window.lexbench.outlines.save(props.outline.id, JSON.stringify(tree.value), sendTitle ? title.value : undefined)
    if (sendTitle) emit('list-changed')
  } catch (e) {
    dirty = true // 留脏标记，下次改动重试
    emit('error', e)
  }
}

onBeforeUnmount(() => {
  // 卸载即冲刷（切页/关阅读都可能先于防抖到期）。
  // 刻意不 emit('saved')：卸载期 emit 会打到还挂着的父监听器，而父级的重取+bump rev
  // 又会卸载-重挂编辑器 → 无限重挂风暴（DOM 追不上、按钮点击落空）。
  // 快照重取由 App 的 watch(tab) 单向负责，时序（save→get 走同一 IPC 队列）已有保证。
  if (dirty || titleDirty) void saveNow(true)
})

// ---------- 结构操作 ----------

function touch(focus?: { id: string; col: number | 'end' }): void {
  if (focus) pendingFocus = focus
  scheduleSave()
  resizeAll()
  applyFocus()
}

/** 行末追加一行（点编辑器空白处 / 底部提示行的降级） */
function appendRow(): void {
  const node = blankNode()
  tree.value.push(node)
  touch({ id: node.id, col: 0 })
}

/** Enter：当前行按光标一分为二，下半截成为下一同级行 */
function splitRow(node: OutlineNode, el: HTMLTextAreaElement): void {
  const pos = el.selectionStart
  const before = el.value.slice(0, pos)
  const after = el.value.slice(pos)
  const hit = locate(node.id)
  if (!hit) return
  node.text = before
  const created = { ...blankNode(), text: after }
  hit.arr.splice(hit.idx + 1, 0, created)
  touch({ id: created.id, col: 0 })
}

/** Tab（仅行首）：降一级——成为上一同级行的最后一个子节点（子树整体跟随，父级展开） */
function indent(node: OutlineNode, el: HTMLTextAreaElement): void {
  const hit = locate(node.id)
  if (!hit || hit.idx === 0) return // 没有上一同级行可挂
  const prev = hit.arr[hit.idx - 1]
  if (!prev) return
  hit.arr.splice(hit.idx, 1)
  prev.fold = false
  prev.children.push(node)
  touch({ id: node.id, col: Math.min(el.selectionStart, node.text.length) })
}

/** Shift+Tab（仅行首）：升一级——插到父节点之后成为其同级（子树整体跟随） */
function outdent(node: OutlineNode, el: HTMLTextAreaElement): void {
  const hit = locate(node.id)
  if (!hit || !hit.parent) return // 已在顶级
  const pHit = locate(hit.parent.id)
  if (!pHit) return
  hit.arr.splice(hit.idx, 1)
  pHit.arr.splice(pHit.idx + 1, 0, node)
  touch({ id: node.id, col: Math.min(el.selectionStart, node.text.length) })
}

/** 并入上一行（视觉上一行：同级前行；无则父行），光标落在拼接点 */
function mergeIntoPrev(node: OutlineNode, el: HTMLTextAreaElement): void {
  const hit = locate(node.id)
  if (!hit) return
  if (hit.idx > 0) {
    const prev = hit.arr[hit.idx - 1]
    if (!prev) return
    const joinAt = prev.text.length
    prev.text += node.text
    prev.children.push(...node.children) // 本行子树挂到上一行末尾
    hit.arr.splice(hit.idx, 1)
    touch({ id: prev.id, col: joinAt })
    return
  }
  if (hit.parent) {
    // 首个子行：文本并入父行末尾，本行子行顶替本行位置
    const parent = hit.parent
    const joinAt = parent.text.length
    parent.text += node.text
    hit.arr.splice(hit.idx, 1, ...node.children)
    touch({ id: parent.id, col: joinAt })
    return
  }
  // 顶级首行：无可并，保留空行
}

function onKeydown(e: KeyboardEvent, row: FlatRow): void {
  if (e.isComposing) return // IME 组字中，回车/Tab 归输入法
  const el = e.target as HTMLTextAreaElement
  const node = row.node

  // / 或 @ 且本行为空：打开插入引用浮层（业界大纲工具通用惯例）
  if ((e.key === '/' || e.key === '@') && node.text === '' && el.selectionStart === 0) {
    e.preventDefault()
    openPicker(node.id)
    return
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    splitRow(node, el)
    return
  }
  if (e.key === 'Tab') {
    if (el.selectionStart !== 0 || el.selectionEnd !== 0) return // 仅行首生效
    e.preventDefault()
    if (e.shiftKey) outdent(node, el)
    else indent(node, el)
    return
  }
  if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
    if (node.text !== '') {
      e.preventDefault() // 行首非空 → 并入上一行
      mergeIntoPrev(node, el)
      return
    }
    // 行首空行：先反缩进一级；已在顶级 → 并入上一行（并入对空行即整行消解）
    if (row.depth > 0) {
      e.preventDefault()
      outdent(node, el)
      return
    }
    const hit = locate(node.id)
    if (hit && (hit.idx > 0 || (hit.parent && hit.idx >= 0))) {
      e.preventDefault()
      mergeIntoPrev(node, el)
    }
    return
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const singleLine = el.scrollHeight <= el.clientHeight + 1
    const atEdge = e.key === 'ArrowUp' ? el.selectionStart === 0 : el.selectionEnd === el.value.length
    if (!singleLine && !atEdge) return // 多行文本且光标不在边缘 → 行内移动
    e.preventDefault()
    const idx = rows.value.findIndex((r) => r.node.id === node.id)
    const target = rows.value[idx + (e.key === 'ArrowUp' ? -1 : 1)]
    if (!target) return
    if (desiredCol === null) desiredCol = el.selectionStart
    const col = desiredCol
    pendingFocus = { id: target.node.id, col }
    void nextTick(() => {
      const ta = rowsEl.value?.querySelector<HTMLTextAreaElement>(`textarea[data-id="${target.node.id}"]`)
      if (!ta) return
      ta.focus()
      const pos = Math.min(col, ta.value.length)
      ta.setSelectionRange(pos, pos)
      ta.scrollIntoView({ block: 'nearest' })
    })
    return
  }
  desiredCol = null // 光标横移/其它键 → 清掉视觉列记忆
}

/** ↑↓ 跨行时保持的视觉列（列位置记忆；点击/输入后重置） */
let desiredCol: number | null = null

function onTaClick(): void {
  desiredCol = null
}

/** 粘贴分发：图片 → 挂节点；引用 → 引用节点；多行 → 拆行（防换行符污染单行节点） */
function onPaste(e: ClipboardEvent, node: OutlineNode): void {
  // 图片优先（剪贴板截图/复制的图）——同步分流，防文本分支抢跑
  const imgItem = clipboardImageItem(e)
  if (imgItem) {
    e.preventDefault()
    const file = imgItem.getAsFile()
    if (file) void attachImageFile(file, node)
    return
  }
  const text = e.clipboardData?.getData('text/plain') ?? ''
  // 「复制引用」粘贴：html 带 ref 元数据 → 生成引用节点（条名衬线 + 右键逃生门）
  const html = e.clipboardData?.getData('text/html') ?? ''
  const refMatch = /data-lb-ref="([^"]+)"/.exec(html)
  if (refMatch) {
    e.preventDefault()
    try {
      const ref = JSON.parse(refMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as OutlineRef
      const citeText = text.split(/\r?\n/)[0]?.trim() ?? ''
      const quote = text.split(/\r?\n/).slice(1).join('\n').trim()
      const hit = locate(node.id)
      if (!hit || !citeText) return
      const citeNode: OutlineNode = {
        ...blankNode(),
        text: citeText,
        ref,
        children: quote ? [{ ...blankNode(), text: quote }] : []
      }
      hit.arr.splice(hit.idx + 1, 0, citeNode)
      touch({ id: citeNode.id, col: 0 })
    } catch {
      /* 元数据坏了就按普通文本走默认粘贴 */
    }
    return
  }
  if (!text.includes('\n')) return // 单行粘贴走默认
  e.preventDefault()
  const el = e.target as HTMLTextAreaElement
  const pos = el.selectionStart
  const before = el.value.slice(0, pos)
  const after = el.value.slice(pos)
  const lines = text.split(/\r?\n/)
  const hit = locate(node.id)
  if (!hit) return
  node.text = before + (lines[0] ?? '')
  const created: OutlineNode[] = lines.slice(1).map((line, i) => ({
    ...blankNode(),
    text: i === lines.length - 2 ? line + after : line
  }))
  hit.arr.splice(hit.idx + 1, 0, ...created)
  const last = created[created.length - 1]
  touch(last ? { id: last.id, col: last.text.length } : { id: node.id, col: node.text.length })
}

// ---------- 折叠 ----------

function toggleFold(node: OutlineNode): void {
  node.fold = !node.fold
  scheduleSave()
  resizeAll()
}

// ---------- 贴图（Ctrl+V 图片 → userData/attachments；节点存相对文件名） ----------

/** fileName → Blob URL（渲染缓存；卸载统一回收） */
const imageUrls = reactive(new Map<string, string>())

async function ensureImageUrl(fileName: string): Promise<void> {
  if (imageUrls.has(fileName)) return
  try {
    const buf = await window.lexbench.attachments.read(fileName)
    imageUrls.set(fileName, URL.createObjectURL(new Blob([buf])))
  } catch {
    /* 缺图不阻断编辑（如数据包未带 attachments） */
  }
}

/** 扫全树补齐缺失的贴图 URL（打开笔记/结构变化后调用） */
function syncTreeImages(): void {
  const need = new Set<string>()
  const walk = (ns: OutlineNode[]): void => {
    for (const n of ns) {
      if (n.image) need.add(n.image)
      walk(n.children)
    }
  }
  walk(tree.value)
  for (const f of need) void ensureImageUrl(f)
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const r = String(reader.result ?? '')
      resolve(r.slice(r.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 同步判定剪贴板是否有图片项（onPaste 前置分流用——必须同步，否则文本分支先跑） */
function clipboardImageItem(e: ClipboardEvent): DataTransferItem | null {
  return Array.from(e.clipboardData?.items ?? []).find(
    (it) => it.kind === 'file' && it.type.startsWith('image/')
  ) ?? null
}

/** 落盘并挂到节点（async 体；调用方已 preventDefault 并 return） */
async function attachImageFile(file: File, node: OutlineNode): Promise<void> {
  try {
    const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
    const b64 = await fileToBase64(file)
    const fileName = await window.lexbench.attachments.saveImage(b64, ext)
    node.image = fileName
    await ensureImageUrl(fileName)
    touch({ id: node.id, col: node.text.length })
    emit('notice', '图片已插入节点')
  } catch (err) {
    emit('error', err)
  }
}

// ---------- 插入引用浮层（定稿「＋连加」：搜文档库，每条右侧 [＋] 插到光标处，浮层不关） ----------

const picker = ref<{
  open: boolean
  anchorId: string | null // 插到哪一行之后（打开浮层时的光标行）
  q: string
  loading: boolean
  results: SearchHit[]
}>({ open: false, anchorId: null, q: '', loading: false, results: [] })

const pickerInputEl = ref<HTMLInputElement | null>(null)
let pickerTimer: ReturnType<typeof setTimeout> | undefined
let pickerSeq = 0

function openPicker(anchorId: string): void {
  picker.value.open = true
  picker.value.anchorId = anchorId
  picker.value.q = ''
  picker.value.results = []
  void nextTick(() => pickerInputEl.value?.focus())
}

function closePicker(): void {
  picker.value.open = false
  clearTimeout(pickerTimer)
}

/** IME 组字防护 + 150ms 防抖 + 请求序号丢弃过期响应（配方同顶栏检索） */
let pickerComposing = false

function onPickerInput(): void {
  if (pickerComposing) return
  clearTimeout(pickerTimer)
  const q = picker.value.q.trim()
  if (!q) {
    picker.value.results = []
    return
  }
  picker.value.loading = true
  pickerTimer = setTimeout(() => void runPickerSearch(q), 150)
}

async function runPickerSearch(q: string): Promise<void> {
  const seq = ++pickerSeq
  try {
    const out = await window.lexbench.search.run(q, 'auto')
    if (seq !== pickerSeq) return
    // 插入引用只对法条有意义（段落命中无 article_id 可锚）
    picker.value.results = out.results.filter((r) => r.kind === 'article')
  } catch (e) {
    if (seq === pickerSeq) picker.value.results = []
  } finally {
    if (seq === pickerSeq) picker.value.loading = false
  }
}

/** ＋ 连加：插入引用节点（《法规》第X条 + 条文正文为子节点），浮层不关 */
async function insertRefFromPicker(hit: SearchHit): Promise<void> {
  const anchorId = picker.value.anchorId
  if (!anchorId || hit.kind !== 'article') return
  try {
    const detail = await window.lexbench.library.getArticle(hit.id)
    const citeNode: OutlineNode = {
      ...blankNode(),
      text: `《${shortLawName(detail.article.title ?? hit.title)}》${detail.article.article_label}`,
      ref: { docId: detail.article.document_id, articleId: detail.article.id },
      children: [{ ...blankNode(), text: detail.article.content }]
    }
    const anchor = locate(anchorId)
    if (anchor) {
      anchor.arr.splice(anchor.idx + 1, 0, citeNode)
    } else {
      tree.value.push(citeNode) // 锚行没了（被删/折叠外）兜底挂末尾
    }
    // 连加语义：锚定到新插的引用行之后，下一条接着排它后面
    picker.value.anchorId = citeNode.id
    touch({ id: citeNode.id, col: 0 })
  } catch (e) {
    emit('error', e)
  }
}

// ---------- 引用节点右键上下文（逃生门） ----------

let unsubOpenSource: (() => void) | null = null

function onRowContextmenu(row: FlatRow, e: MouseEvent): void {
  // DOM contextmenu 先于主进程 context-menu 事件，同一 IPC 管道保序——
  // 这里先报 ref，主进程菜单才能追加「在文档库打开来源」。
  // 注意：node.ref 是 reactive proxy，ipcRenderer.send 结构化克隆不过 Proxy——必须拆成普通对象
  const ref = row.node.ref
  window.lexbench.outlines.setRefContext(ref ? { docId: ref.docId, articleId: ref.articleId } : null)
}

onMounted(() => {
  unsubOpenSource = window.lexbench.outlines.onOpenSource((ref) => emit('open-source', ref))
  document.addEventListener('click', onDocClickMenu)
  syncTreeImages()
})

// 树变化（含粘贴/删除/切笔记重挂）→ 补齐贴图 URL
watch(tree, () => syncTreeImages(), { deep: true })

onBeforeUnmount(() => {
  unsubOpenSource?.()
  unsubOpenSource = null
  window.lexbench.outlines.setRefContext(null)
  clearTimeout(pickerTimer)
  document.removeEventListener('click', onDocClickMenu)
  // 回收 Blob URL
  for (const url of imageUrls.values()) URL.revokeObjectURL(url)
  imageUrls.clear()
})

// ---------- 拖动排序（配方照抄 DocLibrary 卡片拖动） ----------

const dragId = ref<string | null>(null)
const dropId = ref<string | null>(null)
const dropAfter = ref(false)

function onGutterDragStart(node: OutlineNode, e: DragEvent): void {
  dragId.value = node.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', node.id)
  }
}

function onRowDragOver(row: FlatRow, e: DragEvent): void {
  if (!dragId.value || dragId.value === row.node.id) return
  if (isDescendant(row.node.id, dragId.value)) return // 禁止拖进自己的子树
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropId.value = row.node.id
  dropAfter.value = e.clientY > rect.top + rect.height / 2
}

function onRowDrop(row: FlatRow): void {
  const draggedId = dragId.value
  const targetId = dropId.value
  const after = dropAfter.value
  clearDrag()
  if (!draggedId || !targetId || draggedId === targetId) return
  if (isDescendant(targetId, draggedId)) return
  const src = locate(draggedId)
  if (!src) return
  src.arr.splice(src.idx, 1)
  const dst = locate(targetId)
  if (!dst) return // 目标被移没了，还原不了——直接放弃（树保持移除后的合法态）
  dst.arr.splice(dst.idx + (after ? 1 : 0), 0, src.node)
  touch({ id: draggedId, col: 0 })
}

function clearDrag(): void {
  dragId.value = null
  dropId.value = null
}

// ---------- 标题 ----------

function onTitleInput(): void {
  scheduleTitleSave()
}

// ---------- 「⋯」菜单：导出 md/docx + 删除 ----------

const menuOpen = ref(false)

function closeMenu(): void {
  menuOpen.value = false
}

/** 点菜单外收起 */
function onDocClickMenu(e: MouseEvent): void {
  if (!(e.target as HTMLElement).closest('.ol-menu-wrap')) menuOpen.value = false
}

async function exportOutline(format: ExportFormat): Promise<void> {
  menuOpen.value = false
  try {
    await saveNow(true) // 导出前冲刷防抖（对话框打开期间编辑器可能失焦，落库保底）
    const res = await window.lexbench.outlines.export(props.outline.id, format)
    if (!res.canceled) emit('notice', `笔记已导出：${res.path}`)
  } catch (e) {
    emit('error', e)
  }
}

// ---------- 生命周期 ----------

onMounted(() => {
  resizeAll()
})
onBeforeUnmount(() => {
  clearTimeout(saveTimer)
})
</script>

<template>
  <div class="ol">
    <header class="ol-head">
      <input
        v-model="title"
        class="ol-title"
        type="text"
        placeholder="未命名笔记"
        spellcheck="false"
        @input="onTitleInput"
      />
      <button
        class="ol-insert-btn"
        title="插入文档库法条引用（空行上按 / 或 @ 也可唤出）"
        @click="openPicker(rows[rows.length - 1]?.node.id ?? '')"
      >
        插入引用
      </button>
      <button
        class="ol-insert-btn"
        :title="viewMode === 'map' ? '切回大纲编辑' : '转为思维导图（可编辑，与大纲实时同步）'"
        @click="toggleView"
      >
        {{ viewMode === 'map' ? '⇄ 大纲' : '⇄ 导图' }}
      </button>
      <div class="ol-menu-wrap">
        <button class="ol-more" title="更多操作" @click="menuOpen = !menuOpen">⋯</button>
        <Transition name="menu-pop">
          <div v-if="menuOpen" class="ol-menu">
            <button class="ol-menu-item" @click="exportOutline('md')">导出 Markdown</button>
            <button class="ol-menu-item" @click="exportOutline('docx')">导出 Word</button>
            <div class="ol-menu-sep"></div>
            <button class="ol-menu-item danger" @click="menuOpen = false; $emit('delete-request')">
              删除笔记
            </button>
          </div>
        </Transition>
      </div>
      <span class="ol-saved">自动保存</span>
    </header>

    <div v-if="viewMode === 'outline'" ref="rowsEl" class="ol-body" @click.self="appendRow">
      <div
        v-for="row in rows"
        :key="row.node.id"
        class="ol-row"
        :class="{
          'drop-before': dropId === row.node.id && !dropAfter,
          'drop-after': dropId === row.node.id && dropAfter,
          dragging: dragId === row.node.id,
          'is-ref': !!row.node.ref
        }"
        :style="{ paddingLeft: `${16 + row.depth * 24}px` }"
        @dragover="onRowDragOver(row, $event)"
        @drop.prevent="onRowDrop(row)"
        @dragend="clearDrag"
        @contextmenu="onRowContextmenu(row, $event)"
      >
        <button
          v-if="row.hasChildren"
          class="ol-fold"
          :class="{ open: !row.node.fold }"
          :title="row.node.fold ? `展开 ${row.hidden} 项` : '折叠'"
          @click.stop="toggleFold(row.node)"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <path d="M2.5 1.5L5.5 4l-3 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <span v-else class="ol-fold-space" aria-hidden="true"></span>

        <!-- 拖动把手：圆点；引用节点换 📖 -->
        <span
          class="ol-gutter"
          :class="{ ref: !!row.node.ref }"
          :title="row.node.ref ? '引用节点' : '拖动排序'"
          draggable="true"
          @dragstart="onGutterDragStart(row.node, $event)"
          >{{ row.node.ref ? '📖' : '●' }}</span
        >

        <textarea
          :data-id="row.node.id"
          class="ol-text"
          :class="{ 'is-ref': !!row.node.ref }"
          :value="row.node.text"
          rows="1"
          spellcheck="false"
          :placeholder="row.depth === 0 && rows.length === 1 ? '开始写笔记…（Enter 新行，Tab 缩进，Ctrl+V 贴图）' : ''"
          @input="onInput($event, row.node)"
          @keydown="onKeydown($event, row)"
          @paste="onPaste($event, row.node)"
          @click="onTaClick"
          @focus="onTaClick"
        ></textarea>

        <span v-if="row.node.fold && row.hidden > 0" class="ol-count">({{ row.hidden }})</span>

        <!-- 贴图：节点内嵌（折叠时随子树隐藏） -->
        <img
          v-if="row.node.image && imageUrls.has(row.node.image)"
          class="ol-img"
          :src="imageUrls.get(row.node.image)"
          alt=""
          draggable="false"
        />
      </div>

      <!-- 底部提示行：点击补新行 -->
      <button class="ol-append" @click="appendRow">＋ 新建一行</button>
    </div>

    <!-- 导图视图（⇄ 大纲互转；同一棵树实时同步） -->
    <MindMapView
      v-else
      :tree="tree"
      :title="displayTitle"
      @change="onMapChange"
      @error="onMindError"
    />

    <!-- 插入引用浮层：浮层不关可连加（定稿「＋连加」） -->
    <Transition name="menu-pop">
      <div v-if="picker.open" class="ol-picker" @click.self="closePicker">
        <div class="ol-picker-card">
          <div class="ol-picker-head">
            <input
              ref="pickerInputEl"
              v-model="picker.q"
              class="ol-picker-input"
              type="text"
              placeholder="搜索文档库法条…"
              @input="onPickerInput"
              @compositionstart="pickerComposing = true"
              @compositionend="pickerComposing = false; onPickerInput()"
              @keydown.esc="closePicker"
            />
            <button class="ol-picker-close" title="关闭" @click="closePicker">✕</button>
          </div>
          <p class="ol-picker-hint">点 [＋] 插入引用，浮层不关可连续添加</p>
          <div class="ol-picker-list">
            <p v-if="picker.loading" class="ol-picker-empty">检索中…</p>
            <p v-else-if="!picker.q.trim()" class="ol-picker-empty">输入关键词搜索库内法条</p>
            <p v-else-if="picker.results.length === 0" class="ol-picker-empty">没有命中的法条</p>
            <div v-for="r in picker.results" :key="`${r.kind}${r.id}`" class="ol-picker-item">
              <div class="opi-main">
                <span class="opi-title">{{ r.title }}</span>
                <span class="opi-label">{{ r.label }}</span>
              </div>
              <button class="opi-add" title="插入引用" @click="insertRefFromPicker(r)">＋</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ol {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--lb-panel);
}

/* ---------- 头部：标题 ---------- */
.ol-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 28px 12px;
  flex-shrink: 0;
}

.ol-title {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  font-size: 24px;
  font-weight: 700;
  color: var(--lb-text);
  letter-spacing: -0.01em;
  padding: 4px 8px;
  margin-left: -8px;
  border-radius: var(--lb-radius-s);
}

.ol-title::placeholder {
  color: var(--lb-muted);
  font-weight: 400;
}

.ol-title:hover {
  background: #f0f0f6;
}

.ol-title:focus {
  outline: none;
  background: #f0f0f6;
  box-shadow: inset 0 0 0 1px var(--lb-accent-2);
}

.ol-saved {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--lb-muted);
}

/* 头部「插入引用」按钮（配方同 .top-btn：悬停 accent 边+文字） */
.ol-insert-btn {
  flex-shrink: 0;
  padding: 6px 14px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  font-size: 13px;
  color: var(--lb-text);
}

.ol-insert-btn:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

/* 「⋯」更多菜单（配方同 .mode-menu / .mode-pop） */
.ol-menu-wrap {
  position: relative;
  flex-shrink: 0;
}

.ol-more {
  width: 30px;
  height: 30px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  color: var(--lb-muted);
  font-size: 15px;
  line-height: 1;
}

.ol-more:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.ol-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  min-width: 150px;
  padding: 5px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-2);
}

.ol-menu-item {
  display: block;
  width: 100%;
  padding: 7px 12px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: none;
  color: var(--lb-text);
  font-size: 13px;
  text-align: left;
}

.ol-menu-item:hover {
  background: #f0f0f6;
}

.ol-menu-item.danger {
  color: var(--lb-err-fg);
}

.ol-menu-item.danger:hover {
  background: var(--lb-err-bg);
}

.ol-menu-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--lb-border);
}

/* ---------- 行列表 ---------- */
.ol-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 40vh; /* 底部留白可点出新行 */
}

.ol-row {
  position: relative;
  display: flex;
  flex-wrap: wrap; /* 贴图独占下一段 */
  align-items: flex-start;
  gap: 6px;
  padding: 3px 24px 3px 16px;
  min-height: 28px;
}

/* 拖动落点指示线（配方照抄 .doc-card.drop-before/after） */
.ol-row.drop-before {
  box-shadow: inset 0 2px 0 var(--lb-accent);
}

.ol-row.drop-after {
  box-shadow: inset 0 -2px 0 var(--lb-accent);
}

.ol-row.dragging {
  opacity: 0.45;
}

/* 折叠钮：占位等宽，出现时不挤行 */
.ol-fold,
.ol-fold-space {
  flex: 0 0 16px;
  width: 16px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.ol-fold {
  border: none;
  background: none;
  color: var(--lb-muted);
  border-radius: var(--lb-radius-micro);
  transform: rotate(0deg);
}

.ol-fold svg {
  transition: transform 0.16s ease;
}

.ol-fold.open svg {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: no-preference) {
  .ol-fold:hover {
    background: var(--lb-chip);
    color: var(--lb-text);
  }
}

/* 拖动把手（圆点 / 引用 📖） */
.ol-gutter {
  flex: 0 0 14px;
  font-size: 8px;
  line-height: 22px;
  color: rgba(0, 0, 0, 0.25);
  cursor: grab;
  user-select: none;
  text-align: center;
}

.ol-gutter.ref {
  font-size: 12px;
  cursor: default;
}

.ol-row:hover .ol-gutter {
  color: rgba(0, 0, 0, 0.45);
}

/* 行文本：无边框自增高 */
.ol-text {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  resize: none;
  overflow: hidden;
  font-size: 15px;
  line-height: 1.55;
  color: var(--lb-text);
  padding: 2px 4px;
  margin-top: 1px;
  border-radius: var(--lb-radius-xs);
}

.ol-text.is-ref {
  font-family: var(--lb-serif);
  color: var(--lb-accent);
}

.ol-text::placeholder {
  color: var(--lb-muted);
}

.ol-text:focus {
  outline: none;
}

.ol-count {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--lb-muted);
  line-height: 26px;
  padding-right: 4px;
}

/* 贴图：占满整行显示在文本下方 */
.ol-img {
  flex-basis: 100%;
  width: fit-content;
  max-width: min(360px, 100%);
  max-height: 240px;
  border-radius: var(--lb-radius-s);
  border: 1px solid var(--lb-border);
  margin: 2px 0 4px;
  display: block;
  cursor: zoom-in;
}

/* 底部补行 */
.ol-append {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 24px 8px 38px;
  border: none;
  background: none;
  font-size: 13px;
  color: var(--lb-muted);
  border-radius: var(--lb-radius-xs);
}

.ol-append:hover {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

/* ---------- 插入引用浮层（配方同 .search-pop：radius-l 14px + 0 14px 36px 阴影） ---------- */
.ol-picker {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
  background: rgba(30, 28, 40, 0.18);
}

.ol-picker-card {
  width: min(520px, calc(100vw - 48px));
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-2);
  padding: 14px;
}

.ol-picker-head {
  display: flex;
  gap: 8px;
  align-items: center;
}

.ol-picker-input {
  flex: 1;
  min-width: 0;
  padding: 9px 14px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  font-size: 14px;
  transition:
    border-color 0.25s ease,
    box-shadow 0.25s ease;
}

.ol-picker-input:focus {
  outline: none;
  border-color: rgba(0, 113, 227, 0.55);
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
}

.ol-picker-close {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 13px;
}

.ol-picker-close:hover {
  color: var(--lb-text);
}

.ol-picker-hint {
  margin: 8px 2px 4px;
  font-size: 11px;
  color: var(--lb-muted);
}

.ol-picker-list {
  max-height: 320px;
  overflow-y: auto;
  margin-top: 6px;
}

.ol-picker-empty {
  padding: 18px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--lb-muted);
}

/* 候选行（配方同 ResultList .item:hover：accent 边 + translateY(-1px) + 0.12s） */
.ol-picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: var(--lb-radius-s);
  transition:
    border-color 0.12s ease,
    transform 0.12s ease,
    box-shadow 0.12s ease;
}

.ol-picker-item:hover {
  border-color: var(--lb-accent-2);
  transform: translateY(-1px);
  box-shadow: var(--lb-shadow-1);
}

.opi-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.opi-title {
  font-size: 13px;
  color: var(--lb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.opi-label {
  flex-shrink: 0;
  font-family: var(--lb-serif);
  font-size: 12px;
  color: var(--lb-muted);
}

.opi-add {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 14px;
  line-height: 1;
}

.ol-picker-item:hover .opi-add {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}
</style>
