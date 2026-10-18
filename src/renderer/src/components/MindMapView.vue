<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import jsMind from 'jsmind'
import 'jsmind/style/jsmind.css'
import { cloneSubtree, newOutlineId, nodeImages } from '@shared/outlineTree'
import type { OutlineNode, OutlineRef } from '@shared/types'

/**
 * 思维导图视图：与大纲共用同一棵树。
 * - 节点拖动 = 改挂载（拖到节点中部成为子级，拖到上/下缘成为前后同级），带落点高亮；
 * - 底部工具条 / 右键菜单 / 缩放控件；Tab 子主题、Enter 同级、Shift+Tab 在前插入同级；
 * - 节点备注、待办、图片（背景缩略图）与大纲实时互通；
 * - 自身改动 emit change；父级回流用 pendingSelf 吞掉一次，防重载闪屏。
 */
const props = defineProps<{
  tree: OutlineNode[]
  title: string
}>()
const emit = defineEmits<{
  (e: 'change', tree: OutlineNode[]): void
  (e: 'error', err: unknown): void
  (e: 'rename', title: string): void
  (e: 'undo'): void
  (e: 'redo'): void
}>()

const hostEl = ref<HTMLElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
let jm: jsMind | null = null
let pendingSelf = false
let metaById = new Map<string, OutlineNode>()
let resizeTimers: ReturnType<typeof setTimeout>[] = []
let initialFitDone = false

const VIRTUAL_ROOT_ID = '_lb_root_'

// ---------- 映射：OutlineNode[] ↔ jsMind node_tree ----------

function toJsMindNode(n: OutlineNode): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (n.ref) data['ref'] = { ...n.ref }
  if (n.note) data['note'] = n.note
  if (n.task) data['task'] = n.task
  if (n.heading) data['heading'] = n.heading
  const images = nodeImages(n)
  if (images.length) {
    data['images'] = [...images]
    data['image'] = images[0]
  }
  if (n.html) data['html'] = n.html
  return {
    id: n.id,
    topic: n.text || ' ',
    ...(Object.keys(data).length ? { data } : {}),
    ...(n.fold ? { expanded: false } : {}),
    children: (n.children ?? []).map(toJsMindNode)
  }
}

/** 折叠态按 1 行算；未折叠按叶子数估算分支占用的纵向空间 */
function branchWeight(node: OutlineNode): number {
  if (!node.children?.length || node.fold) return 1
  return node.children.reduce((sum, child) => sum + branchWeight(child), 0)
}

/**
 * 顶层分支智能分侧：第一个分支留在右侧作主阅读方向，其余按子树重量贪心分到较轻一侧，
 * 避免所有方框挤在一边；只有一个分支时保持右侧。
 */
function rootDirections(nodes: OutlineNode[]): ('left' | 'right')[] {
  const n = nodes.length
  const dirs: ('left' | 'right')[] = new Array(n).fill('right')
  if (n <= 1) return dirs
  const weights = nodes.map(branchWeight)
  let leftLoad = 0
  let rightLoad = weights[0] ?? 1
  const rest = Array.from({ length: n - 1 }, (_, i) => i + 1).sort(
    (a, b) => (weights[b] ?? 1) - (weights[a] ?? 1)
  )
  for (const i of rest) {
    const w = weights[i] ?? 1
    if (leftLoad <= rightLoad) {
      dirs[i] = 'left'
      leftLoad += w
    } else {
      rightLoad += w
    }
  }
  // 贪心偏差兜底：至少让第二个分支去左侧（两个以上分支时不出现单侧堆积）
  if (!dirs.slice(1).includes('left')) dirs[1] = 'left'
  return dirs
}

function toJsMind(nodes: OutlineNode[]): Record<string, unknown> {
  const dirs = rootDirections(nodes)
  return {
    id: VIRTUAL_ROOT_ID,
    topic: props.title || '笔记',
    children: nodes.map((n, i) => ({ ...toJsMindNode(n), direction: dirs[i] ?? 'right' }))
  }
}

function fromJsMind(data: unknown): OutlineNode[] {
  const d = data as { children?: unknown[] } | null
  if (!d) return []
  const walk = (items: unknown[] | undefined): OutlineNode[] =>
    (items ?? []).map((raw) => {
      const it = raw as {
        id: string
        topic?: string
        data?: Record<string, unknown>
        expanded?: boolean
        children?: unknown[]
        ref?: OutlineRef
        note?: string
        task?: 1 | 2
        heading?: 1 | 2 | 3
        images?: string[]
        image?: string
        html?: string
      }
      // jsMind 的 NodeTreeFormat 输出会把 node.data 摊平到节点顶层（不是嵌套 data），
      // 新节点的元数据必须从这里读；嵌套 data 仅作兼容兜底。
      const bag = it.data ?? {}
      const fallback = metaById.get(it.id)
      const topic = (it.topic ?? '').trim() === '' ? '' : (it.topic ?? '')
      const ref = it.ref ?? (bag['ref'] as OutlineRef | undefined) ?? fallback?.ref
      const note = it.note ?? (bag['note'] as string | undefined) ?? fallback?.note
      const task = it.task ?? (bag['task'] as 1 | 2 | undefined) ?? fallback?.task
      const heading = it.heading ?? (bag['heading'] as 1 | 2 | 3 | undefined) ?? fallback?.heading
      const images = it.images ?? (bag['images'] as string[] | undefined) ?? fallback?.images
      const image = it.image ?? (bag['image'] as string | undefined) ?? fallback?.image
      const html =
        topic === (fallback?.text ?? topic)
          ? it.html ?? (bag['html'] as string | undefined) ?? fallback?.html
          : undefined
      const node: OutlineNode = {
        id: it.id,
        text: topic,
        children: walk(it.children)
      }
      if (it.expanded === false) node.fold = true
      if (ref) node.ref = { ...ref }
      if (note) node.note = note
      if (task) node.task = task
      if (heading) node.heading = heading
      if (images?.length) node.images = [...images]
      if (image) node.image = image
      if (html) node.html = html
      return node
    })
  return walk(d.children)
}

function indexTree(nodes: OutlineNode[]): Map<string, OutlineNode> {
  const m = new Map<string, OutlineNode>()
  const walk = (ns: OutlineNode[]): void => {
    for (const n of ns) {
      m.set(n.id, n)
      walk(n.children ?? [])
    }
  }
  walk(nodes)
  return m
}

// ---------- 同步 ----------

function syncToParent(): void {
  if (!jm) return
  try {
    const fmt = jm.get_data('node_tree') as { data?: unknown }
    const out = fromJsMind(fmt.data)
    metaById = indexTree(out)
    pendingSelf = true
    emit('change', out)
    paintDecorations()
  } catch (e) {
    emit('error', e)
  }
}

let loadSeq = 0

async function loadTree(nodes: OutlineNode[]): Promise<void> {
  if (!jm) return
  const seq = ++loadSeq
  metaById = indexTree(nodes)
  // 图片先转成 Blob URL 再渲染：自定义节点渲染是同步的，URL 没就绪会只剩文字
  await preloadImages(nodes)
  if (seq !== loadSeq || !jm) return
  jm.show({
    meta: { name: 'lexbench-note', author: 'lexbench', version: '1.0' },
    format: 'node_tree',
    data: toJsMind(nodes)
  } as never)
  jm.select_node(jm.get_root())
  scheduleResize()
  paintDecorations()
  if (!initialFitDone) {
    initialFitDone = true
    nextTick(() => {
      fitView()
      jm?.select_node(jm.get_root())
    })
  }
  updateZoomPercent()
}

function scheduleResize(): void {
  for (const t of resizeTimers) clearTimeout(t)
  resizeTimers = []
  resizeTimers.push(setTimeout(() => jm?.resize(), 0))
  resizeTimers.push(setTimeout(() => jm?.resize(), 300))
}

// ---------- 节点贴图（节点内缩略图，不再用会被文字遮住的背景图） ----------

const imageUrls = new Map<string, string>()
const imageSizes = new Map<string, { w: number; h: number }>()

async function ensureUrl(fileName: string): Promise<string | null> {
  const hit = imageUrls.get(fileName)
  if (hit) return hit
  try {
    const buf = await window.lexbench.attachments.read(fileName)
    const url = URL.createObjectURL(new Blob([buf]))
    imageUrls.set(fileName, url)
    return url
  } catch {
    return null
  }
}

/** 解码图片并记下原始尺寸：自定义渲染时先给 img 宽高，布局测量才不会按 0 高度算 */
function decodeImage(fileName: string, url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      imageSizes.set(fileName, { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height })
      resolve()
    }
    img.onerror = () => resolve()
    img.src = url
  })
}

async function preloadImages(nodes: OutlineNode[]): Promise<void> {
  const names = new Set<string>()
  const walk = (ns: OutlineNode[]): void => {
    for (const n of ns) {
      for (const img of nodeImages(n)) names.add(img)
      walk(n.children ?? [])
    }
  }
  walk(nodes)
  await Promise.all(
    [...names].map(async (name) => {
      const url = await ensureUrl(name)
      if (url) await decodeImage(name, url)
    })
  )
}

/** 自定义节点渲染：文字 + 节点内图片缩略图（图片随节点一起撑开尺寸） */
function renderNodeWithImage(_jm: unknown, el: HTMLElement, node: { topic?: string; data?: Record<string, unknown> }): boolean {
  const image = node.data?.['image'] as string | undefined
  if (!image) return false
  const url = imageUrls.get(image)
  if (!url) return false
  el.textContent = node.topic ?? ''
  const img = document.createElement('img')
  img.className = 'mm-node-img'
  const size = imageSizes.get(image)
  if (size) {
    const scale = Math.min(1, 180 / Math.max(1, size.w), 130 / Math.max(1, size.h))
    img.width = Math.max(1, Math.round(size.w * scale))
    img.height = Math.max(1, Math.round(size.h * scale))
  }
  img.src = url
  img.alt = ''
  img.draggable = false
  el.appendChild(img)
  const count = (node.data?.['images'] as string[] | undefined)?.length ?? 1
  if (count > 1) {
    const badge = document.createElement('span')
    badge.className = 'mm-img-count'
    badge.textContent = `+${count - 1}`
    el.appendChild(badge)
  }
  return true
}

// ---------- 节点装饰（任务/备注） ----------

function paintDecorations(): void {
  if (!jm) return
  for (const el of Array.from(jm.view.e_nodes.querySelectorAll('jmnode'))) {
    const id = jm.view.get_binded_nodeid(el)
    if (!id) continue
    const node = metaById.get(id)
    el.classList.toggle('mm-task', !!node?.task)
    el.classList.toggle('mm-task-done', node?.task === 2)
    el.classList.toggle('mm-has-note', !!node?.note)
    const jsnode = jm.mind.nodes[id]
    el.title = jsnode?.isroot ? '拖动空白处平移画布' : '拖动调整层级（松手到目标上/下缘=同级）'
  }
}

// ---------- 选择 / 导航 ----------

type MNode = NonNullable<ReturnType<jsMind['get_node']>>

function selected(): MNode | null {
  return jm?.get_selected_node() ?? null
}

function ensureSelected(): MNode | null {
  if (!jm) return null
  const sel = jm.get_selected_node()
  if (sel) return sel
  const root = jm.get_root()
  jm.select_node(root)
  return root
}

function nodeFrame(n: MNode): { x: number; y: number; w: number; h: number } {
  const loc = n.get_location()
  const size = n.get_size()
  return { x: loc.x, y: loc.y, w: size.w, h: size.h }
}

function moveSelection(key: string): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel) return
  let target: MNode | null = null
  if (key === 'ArrowLeft') {
    target = sel.isroot ? null : sel.parent
  } else if (key === 'ArrowRight') {
    target = (sel.children ?? []).find((c) => jm!.layout.is_visible(c)) ?? null
  } else {
    const siblings = sel.parent ? sel.parent.children : []
    const i = siblings.findIndex((n) => n.id === sel.id)
    const dir = key === 'ArrowUp' ? -1 : 1
    let j = i + dir
    while (j >= 0 && j < siblings.length) {
      const cand = siblings[j]
      if (cand && jm.layout.is_visible(cand)) {
        target = cand
        break
      }
      j += dir
    }
    if (!target) {
      // 几何兜底：可见节点里纵向最近（同侧）
      const cur = nodeFrame(sel)
      let bestDist = Infinity
      for (const n of Object.values(jm.mind.nodes)) {
        if (n.id === sel.id || !jm.layout.is_visible(n)) continue
        if (n.isroot) continue
        const f = nodeFrame(n)
        const vertical = key === 'ArrowUp' ? f.y + f.h <= cur.y + 2 : f.y >= cur.y + cur.h - 2
        if (!vertical) continue
        const dx = Math.abs(f.x - cur.x)
        const dy = key === 'ArrowUp' ? cur.y - (f.y + f.h) : f.y - (cur.y + cur.h)
        if (dy >= -2 && dx < 90 && dy + dx < bestDist) {
          bestDist = dy + dx
          target = n
        }
      }
    }
  }
  if (!target) return
  jm.select_node(target.id)
  jm.scroll_node_to_center(target.id)
}

// ---------- 结构操作（工具条 / 右键菜单 / 键位共用） ----------

/** 根节点新增子主题时优先放到较轻的一侧，保持左右数量/空间平衡 */
function lighterRootSide(): 'left' | 'right' {
  if (!jm) return 'right'
  const root = jm.get_root()
  let left = 0
  let right = 0
  for (const child of root.children) {
    const meta = metaById.get(child.id)
    const w = meta ? branchWeight(meta) : 1
    if (child.direction === -1) left += w
    else right += w
  }
  return left < right ? 'left' : 'right'
}

function addChild(topic = '新主题'): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel) return
  const id = newOutlineId()
  jm.add_node(sel.id, id, topic, undefined, sel.isroot ? lighterRootSide() : sel.direction)
  jm.expand_node(sel.id)
  jm.select_node(id)
  syncToParent()
  nextTick(() => {
    jm?.begin_edit(id)
    setTimeout(() => jm?.scroll_node_to_center(id), 30)
  })
}

function addSibling(before = false): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel) return
  if (sel.isroot) {
    addChild()
    return
  }
  const parent = sel.parent
  const id = newOutlineId()
  jm.add_node(parent.id, id, '新主题', undefined, sel.direction)
  if (!before) {
    const idx = parent.children.findIndex((c) => c.id === sel.id)
    const next = parent.children[idx + 1]
    if (next && next.id !== id) jm.move_node(id, next.id, parent.id, sel.direction)
  } else {
    jm.move_node(id, sel.id, parent.id, sel.direction)
  }
  jm.select_node(id)
  syncToParent()
  nextTick(() => {
    jm?.begin_edit(id)
    setTimeout(() => jm?.scroll_node_to_center(id), 30)
  })
}

function deleteSelected(): void {
  if (!jm) return
  const sel = jm.get_selected_node()
  if (!sel || sel.isroot) return
  const parentId = sel.parent?.id
  jm.remove_node(sel.id)
  if (parentId) jm.select_node(parentId)
  syncToParent()
  paintDecorations()
}

function toggleCollapse(): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel || !(sel.children ?? []).length) return
  if (sel.expanded) jm.collapse_node(sel.id)
  else jm.expand_node(sel.id)
  syncToParent()
  paintDecorations()
  scheduleResize()
}

function collapseAll(): void {
  if (!jm) return
  for (const n of Object.values(jm.mind.nodes)) {
    if (!n.isroot && (n.children ?? []).length) jm.collapse_node(n.id)
  }
  syncToParent()
  paintDecorations()
}

function expandAll(): void {
  if (!jm) return
  for (const n of Object.values(jm.mind.nodes)) {
    if ((n.children ?? []).length) jm.expand_node(n.id)
  }
  syncToParent()
  paintDecorations()
  scheduleResize()
}

function editSelected(): void {
  if (!jm) return
  const sel = ensureSelected()
  if (sel) jm.begin_edit(sel.id)
}

function duplicateSelected(): void {
  if (!jm) return
  const sel = jm.get_selected_node()
  if (!sel || sel.isroot) return
  const src = metaById.get(sel.id)
  if (!src) return
  const parent = sel.parent
  const copy = cloneSubtree(src, newOutlineId)
  jm.add_nodes(parent.id, [toJsMindNode(copy)] as never)
  const idx = parent.children.findIndex((c) => c.id === sel.id)
  const next = parent.children[idx + 1]
  if (next && next.id !== copy.id) jm.move_node(copy.id, next.id, parent.id, sel.direction)
  jm.select_node(copy.id)
  syncToParent()
  paintDecorations()
  nextTick(() => jm?.scroll_node_to_center(copy.id))
}

// ---------- 备注 / 待办 / 图片 ----------

const noteEditor = reactive({
  open: false,
  nodeId: null as string | null,
  value: ''
})

function openNoteEditor(): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel || sel.isroot) return
  const node = metaById.get(sel.id)
  noteEditor.open = true
  noteEditor.nodeId = sel.id
  noteEditor.value = node?.note ?? ''
  closeMenu()
  nextTick(() => document.querySelector<HTMLTextAreaElement>('.mm-note-text')?.focus())
}

function saveNoteEditor(): void {
  const id = noteEditor.nodeId
  if (!id) return
  const jsnode = jm?.mind.nodes[id]
  if (jsnode) {
    const value = noteEditor.value.trim()
    if (value) jsnode.data['note'] = value
    else delete jsnode.data['note']
    const meta = metaById.get(id)
    if (meta) {
      if (value) meta.note = value
      else delete meta.note
    }
  }
  noteEditor.open = false
  noteEditor.nodeId = null
  syncToParent()
  paintDecorations()
}

function toggleTask(status: 0 | 1 | 2): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel || sel.isroot) return
  if (status === 0) delete sel.data['task']
  else sel.data['task'] = status
  const meta = metaById.get(sel.id)
  if (meta) {
    if (status === 0) delete meta.task
    else meta.task = status
  }
  paintDecorations()
  syncToParent()
}

function toggleTaskFromToolbar(): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel) return
  const current = (sel.data['task'] as 1 | 2 | undefined) ?? 0
  toggleTask(current === 0 ? 1 : current === 1 ? 2 : 1)
}

function requestImage(): void {
  imageInput.value?.click()
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? '').slice(String(reader.result ?? '').indexOf(',') + 1))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 图片落点：优先当前选中主题；若当前是中心主题/没有选中，就新建一个图片子主题。
 * （中心主题是虚拟 root，不承载图片；此前直接 return 导致用户点「插入图片」毫无反应。）
 */
function ensureImageTarget(): MNode | null {
  if (!jm) return null
  let sel = jm.get_selected_node()
  if (!sel) {
    jm.select_node(jm.get_root())
    sel = jm.get_root()
  }
  if (sel.isroot) {
    const id = newOutlineId()
    jm.add_node(sel.id, id, '图片', undefined, 'right')
    jm.expand_node(sel.id)
    jm.select_node(id)
    syncToParent()
    sel = jm.get_selected_node()
  }
  return sel
}

async function attachImages(files: File[]): Promise<void> {
  if (!jm || !files.length) return
  const sel = ensureImageTarget()
  if (!sel) return
  const meta = metaById.get(sel.id)
  const list = meta ? nodeImages(meta) : []
  for (const file of files) {
    try {
      const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
      const name = await window.lexbench.attachments.saveImage(await fileToBase64(file), ext)
      if (!list.includes(name)) list.push(name)
    } catch (e) {
      emit('error', e)
    }
  }
  if (!list.length) return
  sel.data['images'] = [...list]
  sel.data['image'] = list[0]
  if (meta) {
    meta.images = [...list]
    meta.image = list[0]
  }
  const url = await ensureUrl(list[0]!)
  if (url) await decodeImage(list[0]!, url)
  if (!jm) return
  // 自定义节点渲染：重画节点（文字 + 图片缩略图），并按新尺寸重新布局
  jm.update_node(sel.id, sel.topic)
  jm.layout.layout()
  jm.view.relayout()
  paintDecorations()
  syncToParent()
  nextTick(() => jm?.scroll_node_to_center(sel.id))
}

async function onPickImages(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  await attachImages(files)
}

async function onHostPaste(ev: ClipboardEvent): Promise<void> {
  if (!jm || jm.view.is_editing()) return
  const items = Array.from(ev.clipboardData?.items ?? []).filter(
    (it) => it.kind === 'file' && it.type.startsWith('image/')
  )
  if (!items.length) return
  ev.preventDefault()
  const files = items.map((it) => it.getAsFile()).filter((f): f is File => !!f)
  await attachImages(files)
}

// ---------- 拖动改挂载 ----------

const drag = reactive({
  active: false,
  fromId: null as string | null,
  ghostX: 0,
  ghostY: 0,
  targetId: null as string | null,
  mode: 'child' as 'child' | 'before' | 'after',
  lineTop: 0,
  lineLeft: 0,
  lineWidth: 0
})
let pendingDrag: { id: string; x: number; y: number } | null = null
let viewDraggableWasOn = false

function onPointerDown(ev: PointerEvent): void {
  if (!jm || ev.button !== 0 || jm.view.is_editing()) return
  const el = (ev.target as HTMLElement).closest('jmnode') as HTMLElement | null
  if (!el) return
  const id = jm.view.get_binded_nodeid(el)
  if (!id) return
  const node = jm.mind.nodes[id]
  if (!node || node.isroot) return
  jm.select_node(id)
  hostEl.value?.focus()
  // 按在节点上时先关掉画布平移，避免拖节点时整张图跟着跑
  viewDraggableWasOn = jm.get_view_draggable()
  if (viewDraggableWasOn) jm.disable_view_draggable()
  pendingDrag = { id, x: ev.clientX, y: ev.clientY }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp, { once: true })
  window.addEventListener('pointercancel', cancelPointerDrag, { once: true })
}

function onPointerMove(ev: PointerEvent): void {
  if (!jm || !pendingDrag) return
  if (!drag.active) {
    if (Math.hypot(ev.clientX - pendingDrag.x, ev.clientY - pendingDrag.y) < 5) return
    drag.active = true
    drag.fromId = pendingDrag.id
    document.body.classList.add('mm-dragging')
    closeMenu()
  }
  ev.preventDefault()
  drag.ghostX = ev.clientX + 14
  drag.ghostY = ev.clientY + 12
  updateDropTarget(ev.clientX, ev.clientY)
  // 边缘自动滚动画布
  const panel = jm.view.e_panel
  const box = panel.getBoundingClientRect()
  if (ev.clientY < box.top + 44) panel.scrollTop -= 12
  else if (ev.clientY > box.bottom - 44) panel.scrollTop += 12
  if (ev.clientX < box.left + 44) panel.scrollLeft -= 12
  else if (ev.clientX > box.right - 44) panel.scrollLeft += 12
}

/** 当前指针下的节点；空白处按 90px 内最近邻兜底（拖到节点旁也能落点） */
function findDropNodeElement(x: number, y: number, from: MNode): HTMLElement | null {
  if (!jm) return null
  const acceptable = (id: string): boolean => {
    if (!id || id === from.id) return false
    const n = jm!.mind.nodes[id]
    if (!n || !jm!.layout.is_visible(n)) return false
    return !jsMind.node.inherited(from, n)
  }
  for (const el of document.elementsFromPoint(x, y)) {
    if (el instanceof HTMLElement && el.tagName.toLowerCase() === 'jmnode') {
      const id = jm.view.get_binded_nodeid(el)
      if (id && acceptable(id)) return el
    }
  }
  let best: HTMLElement | null = null
  let bestDist = Infinity
  for (const el of Array.from(jm.view.e_nodes.querySelectorAll('jmnode'))) {
    const id = jm.view.get_binded_nodeid(el)
    if (!id || !acceptable(id)) continue
    const r = el.getBoundingClientRect()
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
    const dist = Math.hypot(dx, dy)
    if (dist < bestDist) {
      bestDist = dist
      best = el
    }
  }
  return bestDist <= 90 ? best : null
}

function updateDropTarget(x: number, y: number): void {
  if (!jm || !drag.fromId) return
  clearDropHighlight()
  const from = jm.mind.nodes[drag.fromId]
  if (!from) return
  const targetEl = findDropNodeElement(x, y, from)
  if (!targetEl) return
  const id = jm.view.get_binded_nodeid(targetEl)
  if (!id) return
  const target = jm.mind.nodes[id]
  if (!target) return
  const rect = targetEl.getBoundingClientRect()
  const rel = Math.max(0, Math.min(1, (y - rect.top) / Math.max(1, rect.height)))
  const mode: 'child' | 'before' | 'after' =
    target.isroot ? 'child' : rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'child'
  drag.targetId = id
  drag.mode = mode
  if (mode === 'child') {
    targetEl.classList.add('mm-drop-into')
  } else {
    drag.lineLeft = rect.left
    drag.lineWidth = rect.width
    drag.lineTop = mode === 'before' ? rect.top - 2 : rect.bottom
  }
}

function clearDropHighlight(): void {
  drag.targetId = null
  if (!jm) return
  for (const el of Array.from(jm.view.e_nodes.querySelectorAll('jmnode.mm-drop-into'))) {
    el.classList.remove('mm-drop-into')
  }
}

function onPointerUp(): void {
  window.removeEventListener('pointermove', onPointerMove)
  if (!jm) {
    cleanupPointerDrag()
    return
  }
  if (drag.active) {
    const fromId = drag.fromId
    const targetId = drag.targetId
    const mode = drag.mode
    cleanupPointerDrag()
    if (fromId && targetId) {
      const from = jm.mind.nodes[fromId]
      const target = jm.mind.nodes[targetId]
      if (from && target) {
        if (mode === 'child') {
          jm.expand_node(target.id)
          jm.move_node(from.id, undefined, target.id, target.isroot ? lighterRootSide() : target.direction)
        } else if (!target.isroot && target.parent) {
          const parent = target.parent
          const idx = parent.children.findIndex((c) => c.id === target.id)
          const next = mode === 'after' ? parent.children[idx + 1] : target
          jm.move_node(from.id, next?.id, parent.id, target.direction)
        }
        syncToParent()
        paintDecorations()
        scheduleResize()
        nextTick(() => jm?.scroll_node_to_center(fromId))
      }
    }
  } else {
    cleanupPointerDrag()
  }
}

function cancelPointerDrag(): void {
  window.removeEventListener('pointermove', onPointerMove)
  cleanupPointerDrag()
}

function cleanupPointerDrag(): void {
  pendingDrag = null
  drag.active = false
  drag.fromId = null
  clearDropHighlight()
  document.body.classList.remove('mm-dragging')
  if (jm && viewDraggableWasOn) jm.enable_view_draggable()
  viewDraggableWasOn = false
}

// ---------- 右键菜单 ----------

const menu = reactive({ open: false, x: 0, y: 0 })

function openMenu(ev: MouseEvent): void {
  if (!jm) return
  const el = (ev.target as HTMLElement).closest('jmnode') as HTMLElement | null
  if (!el) return
  const id = jm.view.get_binded_nodeid(el)
  if (!id) return
  const node = jm.mind.nodes[id]
  if (!node || node.isroot) return
  ev.preventDefault()
  jm.select_node(id)
  menu.open = true
  menu.x = Math.min(window.innerWidth - 210, ev.clientX)
  menu.y = Math.min(window.innerHeight - 330, ev.clientY)
}

function closeMenu(): void {
  menu.open = false
}

function menuCall(fn: () => void): void {
  closeMenu()
  fn()
}

// ---------- 缩放 ----------

const zoomPercent = ref(100)

function updateZoomPercent(): void {
  if (!jm) return
  zoomPercent.value = Math.round(jm.view.zoom_current * 100)
}

function zoomIn(): void {
  jm?.view.zoom_in()
  updateZoomPercent()
}

function zoomOut(): void {
  jm?.view.zoom_out()
  updateZoomPercent()
}

function resetZoom(): void {
  jm?.view.set_zoom(1)
  updateZoomPercent()
  if (jm) jm.scroll_node_to_center(jm.get_root())
}

function fitView(): void {
  if (!jm || !hostEl.value) return
  const nodes = Object.values(jm.mind.nodes).filter((n) => jm!.layout.is_visible(n))
  if (!nodes.length) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const f = nodeFrame(n)
    minX = Math.min(minX, f.x)
    minY = Math.min(minY, f.y)
    maxX = Math.max(maxX, f.x + f.w)
    maxY = Math.max(maxY, f.y + f.h)
  }
  const w = hostEl.value.clientWidth - 120
  const h = hostEl.value.clientHeight - 120
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const scale = Math.max(0.45, Math.min(1, Math.min(w / bw, h / bh)))
  jm.view.set_zoom(scale)
  jm.scroll_node_to_center(jm.get_root())
  updateZoomPercent()
  scheduleResize()
}

// ---------- 连线：直角肘形（类似组织架构图，圆角过渡） ----------

function renderElbowLine(arg: {
  ctx: CanvasRenderingContext2D | SVGPathElement
  start_point: { x: number; y: number }
  end_point: { x: number; y: number }
}): void {
  const ctx = arg.ctx as CanvasRenderingContext2D
  if (typeof ctx.beginPath !== 'function') return
  const s = arg.start_point
  const e = arg.end_point
  ctx.beginPath()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (Math.abs(e.y - s.y) < 1) {
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(e.x, e.y)
    ctx.stroke()
    return
  }
  const dir = e.y > s.y ? 1 : -1
  // 拐角只留很小的圆角：分叉处干净利落，不要大弧线
  const r = Math.min(2, Math.abs(e.y - s.y) / 2)
  const offset = Math.max(14, Math.min(28, Math.abs(e.x - s.x) / 2))
  ctx.moveTo(s.x, s.y)
  if (e.x >= s.x) {
    const midX = s.x + offset
    ctx.lineTo(midX - r, s.y)
    ctx.quadraticCurveTo(midX, s.y, midX, s.y + dir * r)
    ctx.lineTo(midX, e.y - dir * r)
    ctx.quadraticCurveTo(midX, e.y, midX + r, e.y)
    ctx.lineTo(e.x, e.y)
  } else {
    const midX = s.x - offset
    ctx.lineTo(midX + r, s.y)
    ctx.quadraticCurveTo(midX, s.y, midX, s.y + dir * r)
    ctx.lineTo(midX, e.y - dir * r)
    ctx.quadraticCurveTo(midX, e.y, midX - r, e.y)
    ctx.lineTo(e.x, e.y)
  }
  ctx.stroke()
}

// ---------- 键盘 ----------

function onKeydown(ev: KeyboardEvent): void {
  if (!jm || ev.isComposing) return
  if (jm.view.is_editing()) return // 编辑输入框交给 jsMind / 浏览器
  const mod = ev.ctrlKey || ev.metaKey
  if (mod && ev.shiftKey && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault()
    emit('redo')
    return
  }
  if (mod && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault()
    emit('undo')
    return
  }
  if (mod && (ev.key === 'y' || ev.key === 'Y')) {
    ev.preventDefault()
    emit('redo')
    return
  }
  if (mod && (ev.key === '=' || ev.key === '+')) {
    ev.preventDefault()
    zoomIn()
    return
  }
  if (mod && ev.key === '-') {
    ev.preventDefault()
    zoomOut()
    return
  }
  if (mod && ev.key === '0') {
    ev.preventDefault()
    fitView()
    return
  }
  if (mod && (ev.key === 'd' || ev.key === 'D')) {
    ev.preventDefault()
    duplicateSelected()
    return
  }
  if (ev.key === 'Tab') {
    ev.preventDefault()
    if (ev.shiftKey) addSibling(true)
    else addChild()
    return
  }
  if (ev.key === 'Enter') {
    ev.preventDefault()
    addSibling()
    return
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault()
    deleteSelected()
    return
  }
  if (ev.key === ' ') {
    ev.preventDefault()
    editSelected()
    return
  }
  if (ev.key === 'F2') {
    ev.preventDefault()
    editSelected()
    return
  }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    ev.preventDefault()
    moveSelection(ev.key)
    return
  }
  if (ev.key === 'Escape') {
    closeMenu()
    noteEditor.open = false
    return
  }
}

// ---------- 工具条更多菜单 ----------

const moreMenu = ref(false)

function closeAllPopups(): void {
  closeMenu()
  moreMenu.value = false
}

// ---------- 生命周期 ----------

const titleComputed = computed(() => props.title || '笔记')

onMounted(() => {
  if (!hostEl.value) return
  try {
    jm = new jsMind({
      container: hostEl.value,
      editable: true,
      theme: null,
      support_html: false,
      view: {
        engine: 'canvas',
        hmargin: 60,
        vmargin: 24,
        line_width: 1.6,
        line_color: '#b3bdc8',
        line_style: 'curved',
        custom_line_render: renderElbowLine,
        custom_node_render: renderNodeWithImage,
        draggable: true,
        hide_scrollbars_when_draggable: true,
        node_overflow: 'wrap',
        zoom: { min: 0.4, max: 2, step: 0.1, mask_key: 17 }
      },
      layout: { hspace: 64, vspace: 26, pspace: 10, cousin_space: 16 },
      shortcut: {
        enable: false
      }
    })
    void loadTree(props.tree)
    jm.add_event_listener((type, data) => {
      if (!jm) return
      if (type === jsMind.event_type.edit) {
        // 中心主题就是笔记标题：导图里改名要回写标题，不能只改虚拟 root
        const root = jm.get_root()
        if (root && root.topic !== props.title) emit('rename', root.topic)
        syncToParent()
        paintDecorations()
      } else if (
        type === jsMind.event_type.show &&
        (data.evt === 'expand_node' || data.evt === 'collapse_node')
      ) {
        syncToParent()
        paintDecorations()
      }
    })
    hostEl.value.addEventListener('keydown', onKeydown)
    hostEl.value.addEventListener('pointerdown', onPointerDown)
    hostEl.value.addEventListener('contextmenu', openMenu)
    hostEl.value.addEventListener('paste', onHostPaste)
    hostEl.value.addEventListener('click', onHostClick)
    hostEl.value.addEventListener('wheel', onWheelZoom)
    hostEl.value.addEventListener('input', onEditorInput, true)
    hostEl.value.addEventListener('focusin', onEditorFocusIn)
    document.addEventListener('click', onDocumentClick)
  } catch (e) {
    emit('error', e)
  }
})

function onHostClick(): void {
  hostEl.value?.focus()
}

/** Ctrl+滚轮缩放由 jsMind 内部处理，这里只负责把百分比刷新回来 */
function onWheelZoom(): void {
  setTimeout(updateZoomPercent, 40)
}

/** 节点编辑框随输入增长（jsMind 默认固定 70px，长文本会被截住看不见） */
function sizeEditor(): void {
  if (!jm) return
  const input = jm.view.e_panel.querySelector('.jsmind-editor') as HTMLInputElement | null
  if (!input) return
  const max = Math.max(180, Math.min(680, (hostEl.value?.clientWidth ?? 800) - 120))
  input.style.maxWidth = 'none'
  // 先压到 1px 再量 scrollWidth，否则 input 默认 20 字符宽会把测量值撑大
  input.style.width = '1px'
  const measured = Math.max(input.scrollWidth + 24, input.value.length * 14 + 30, 120)
  input.style.width = `${Math.min(max, measured)}px`
}

function onEditorInput(ev: Event): void {
  const t = ev.target as HTMLElement | null
  if (t?.classList?.contains('jsmind-editor')) sizeEditor()
}

function onEditorFocusIn(ev: FocusEvent): void {
  const t = ev.target as HTMLElement | null
  if (t?.classList?.contains('jsmind-editor')) setTimeout(sizeEditor, 0)
}

function onDocumentClick(ev: MouseEvent): void {
  const t = ev.target as HTMLElement
  if (!t.closest('.mm-menu') && !t.closest('.mm-zoom') && !t.closest('.mm-fab-wrap')) closeMenu()
  if (!t.closest('.mm-fab-wrap')) moreMenu.value = false
  // 点备注面板之外保存（排除打开它的入口按钮，避免刚点开就被关）
  if (
    noteEditor.open &&
    !t.closest('.mm-note-card') &&
    !t.closest('.mm-fab-wrap') &&
    !t.closest('.mm-menu')
  ) {
    saveNoteEditor()
  }
}

watch(
  () => props.tree,
  (t) => {
    if (pendingSelf) {
      pendingSelf = false
      // 回流的是自己刚同步的树：只刷新装饰，不重载画布
      metaById = indexTree(t)
      paintDecorations()
      return
    }
    void loadTree(t)
  }
)

watch(
  () => props.title,
  (t) => {
    if (!jm) return
    const root = jm.get_root()
    if (root && root.topic !== (t || '笔记')) {
      jm.update_node(root.id, t || '笔记')
      paintDecorations()
    }
  }
)

onBeforeUnmount(() => {
  hostEl.value?.removeEventListener('keydown', onKeydown)
  hostEl.value?.removeEventListener('pointerdown', onPointerDown)
  hostEl.value?.removeEventListener('contextmenu', openMenu)
  hostEl.value?.removeEventListener('paste', onHostPaste)
  hostEl.value?.removeEventListener('click', onHostClick)
  hostEl.value?.removeEventListener('wheel', onWheelZoom)
  hostEl.value?.removeEventListener('input', onEditorInput, true)
  hostEl.value?.removeEventListener('focusin', onEditorFocusIn)
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('pointermove', onPointerMove)
  for (const t of resizeTimers) clearTimeout(t)
  resizeTimers = []
  if (jm) {
    jm.clear_event_listener()
    jm = null
  }
  for (const url of imageUrls.values()) URL.revokeObjectURL(url)
  imageUrls.clear()
  if (hostEl.value) hostEl.value.innerHTML = ''
})
</script>

<template>
  <div class="mm-root">
    <div ref="hostEl" class="ol-mind" tabindex="0"></div>

    <!-- 顶部小菜单：不常驻大工具条，只留一个不碍眼的入口 -->
    <div class="mm-fab-wrap" @click.stop>
      <button class="mm-fab" title="导图操作" @click.stop="moreMenu = !moreMenu">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.4" />
          <circle cx="10" cy="10" r="1.4" />
          <circle cx="15.5" cy="10" r="1.4" />
        </svg>
      </button>
      <div v-if="moreMenu" class="mm-fab-menu" @click.stop>
        <button class="mm-mi" @click="moreMenu = false; addChild()">新建子主题 <kbd>Tab</kbd></button>
        <button class="mm-mi" @click="moreMenu = false; addSibling()">新建同级主题 <kbd>Enter</kbd></button>
        <button class="mm-mi" @click="moreMenu = false; addSibling(true)">在前插入同级</button>
        <button class="mm-mi" @click="moreMenu = false; editSelected()">编辑 <kbd>Space</kbd></button>
        <div class="mm-sep-h"></div>
        <button class="mm-mi" @click="moreMenu = false; openNoteEditor()">备注</button>
        <button class="mm-mi" @click="moreMenu = false; toggleTaskFromToolbar()">待办 / 完成</button>
        <button class="mm-mi" @click="moreMenu = false; requestImage()">插入图片</button>
        <button class="mm-mi" @click="moreMenu = false; duplicateSelected()">复制节点 <kbd>Ctrl+D</kbd></button>
        <div class="mm-sep-h"></div>
        <button class="mm-mi" @click="moreMenu = false; expandAll()">全部展开</button>
        <button class="mm-mi" @click="moreMenu = false; collapseAll()">全部折叠</button>
        <button class="mm-mi" @click="moreMenu = false; fitView()">适应画布</button>
        <div class="mm-sep-h"></div>
        <button class="mm-mi danger" @click="moreMenu = false; deleteSelected()">删除主题 <kbd>Del</kbd></button>
      </div>
    </div>

    <!-- 缩放 -->
    <div class="mm-zoom" @click.stop>
      <button title="缩小（Ctrl+-）" @click="zoomOut()">−</button>
      <button class="mm-zoom-val" title="恢复 100%" @click="resetZoom()">{{ zoomPercent }}%</button>
      <button title="放大（Ctrl+=）" @click="zoomIn()">＋</button>
      <span class="mm-zoom-sep"></span>
      <button class="mm-zoom-fit" title="适应画布（Ctrl+0）" @click="fitView()">⤢</button>
    </div>

    <!-- 拖动幽灵 + 落点线 -->
    <div v-if="drag.active" class="mm-drag-ghost" :style="{ left: drag.ghostX + 'px', top: drag.ghostY + 'px' }">
      {{ metaById.get(drag.fromId ?? '')?.text || '移动主题' }}
    </div>
    <div
      v-if="drag.active && drag.targetId && drag.mode !== 'child'"
      class="mm-drop-line"
      :style="{ left: drag.lineLeft + 'px', top: drag.lineTop + 'px', width: drag.lineWidth + 'px' }"
    ></div>

    <!-- 右键菜单 -->
    <div v-if="menu.open" class="mm-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
      <button class="mm-mi" @click="menuCall(() => addChild())">新建子主题 <kbd>Tab</kbd></button>
      <button class="mm-mi" @click="menuCall(() => addSibling())">新建同级主题 <kbd>Enter</kbd></button>
      <button class="mm-mi" @click="menuCall(() => addSibling(true))">在前插入同级</button>
      <button class="mm-mi" @click="menuCall(() => editSelected())">编辑 <kbd>Space</kbd></button>
      <div class="mm-sep-h"></div>
      <button class="mm-mi" @click="menuCall(() => duplicateSelected())">复制节点 <kbd>Ctrl+D</kbd></button>
      <button class="mm-mi" @click="menuCall(() => openNoteEditor())">备注</button>
      <button class="mm-mi" @click="menuCall(() => toggleTask(1))">设为待办</button>
      <button class="mm-mi" @click="menuCall(() => toggleTask(2))">标记完成</button>
      <button class="mm-mi" @click="menuCall(() => toggleTask(0))">取消待办</button>
      <button class="mm-mi" @click="menuCall(() => requestImage())">插入图片</button>
      <div class="mm-sep-h"></div>
      <button class="mm-mi" @click="menuCall(() => toggleCollapse())">折叠 / 展开</button>
      <button class="mm-mi" @click="menuCall(() => fitView())">适应画布</button>
      <div class="mm-sep-h"></div>
      <button class="mm-mi danger" @click="menuCall(() => deleteSelected())">删除主题 <kbd>Del</kbd></button>
    </div>

    <!-- 备注编辑 -->
    <div v-if="noteEditor.open" class="mm-note-card" @click.stop>
      <div class="mm-note-head">
        <span>备注</span>
        <button title="关闭" @click="saveNoteEditor()">✕</button>
      </div>
      <textarea
        v-model="noteEditor.value"
        class="mm-note-text"
        rows="4"
        placeholder="给这个主题补一段说明…"
        @keydown.esc.prevent="saveNoteEditor()"
        @keydown.ctrl.enter.prevent="saveNoteEditor()"
      ></textarea>
      <div class="mm-note-foot">
        <span class="mm-note-hint">Ctrl+Enter 保存</span>
        <button class="mm-note-save" @click="saveNoteEditor()">保存</button>
      </div>
    </div>

    <input ref="imageInput" type="file" accept="image/*" multiple class="mm-file" @change="onPickImages" />
  </div>
</template>

<!-- jsMind 内部 DOM 不受 scoped 约束：作用域统一用 .ol-mind 前缀 -->
<style>
.ol-mind {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  outline: none;
  background: #fff;
  position: relative;
}

.ol-mind jmnode {
  background: #fff;
  color: var(--lb-text);
  border: 1px solid #e7ebf0;
  border-radius: 22px;
  box-shadow: 0 1px 2px rgba(20, 24, 38, 0.05);
  font-family: var(--lb-sans);
  font-size: 15px;
  line-height: 1.55;
  padding: 8px 15px;
  max-width: 280px;
  white-space: normal;
  cursor: grab;
  transition:
    border-color 0.14s ease,
    box-shadow 0.14s ease,
    transform 0.14s ease;
}

.ol-mind jmnode:active {
  cursor: grabbing;
}

.ol-mind jmnode:hover {
  border-color: var(--lb-accent-2);
  box-shadow: 0 3px 10px rgba(0, 90, 190, 0.1);
}

.ol-mind jmnode.selected {
  background: #fff;
  color: var(--lb-text);
  border-color: var(--lb-accent);
  box-shadow:
    0 0 0 3px var(--lb-accent-soft),
    0 4px 14px rgba(0, 90, 190, 0.14);
}

.ol-mind jmnode.root {
  font-size: 18px;
  font-weight: 600;
  border-radius: 24px;
  padding: 11px 20px;
  border-color: rgba(0, 113, 227, 0.24);
}

.ol-mind jmnode.root.selected {
  border-color: var(--lb-accent);
}

.ol-mind jmnode.mm-drop-into {
  border-color: var(--lb-accent) !important;
  box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.18) !important;
  background: #f4f9ff;
}

.ol-mind jmnode.mm-task::before {
  content: '☐';
  display: inline-block;
  margin-right: 5px;
  color: var(--lb-muted);
  font-size: 13px;
}

.ol-mind jmnode.mm-task-done::before {
  content: '☑';
  color: var(--lb-accent);
}

.ol-mind jmnode.mm-task-done {
  text-decoration: line-through;
  opacity: 0.62;
}

.ol-mind jmnode.mm-has-note::after {
  content: '▤';
  display: inline-block;
  margin-left: 6px;
  color: var(--lb-muted);
  font-size: 10px;
  vertical-align: 1px;
}

.ol-mind jmnode .mm-node-img {
  display: block;
  max-width: 180px;
  max-height: 130px;
  margin: 7px auto 1px;
  border-radius: 10px;
  object-fit: cover;
  user-select: none;
  pointer-events: none;
}

.ol-mind jmnode .mm-img-count {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 0 5px;
  border-radius: 8px;
  background: rgba(43, 47, 54, 0.72);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
}

.ol-mind jmexpander {
  width: 16px;
  height: 16px;
  line-height: 15px;
  font-size: 11px;
  border-radius: 50%;
  border: 1px solid #c8ced4;
  background: #fff;
  color: #646a73;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.ol-mind jmexpander:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.ol-mind .jsmind-inner {
  background: transparent;
}

.ol-mind .jsmind-editor {
  box-sizing: border-box;
  border: 1px solid rgba(0, 113, 227, 0.55);
  border-radius: 10px;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
  font-family: var(--lb-sans);
  font-size: 14px;
  padding: 6px 10px;
  outline: none;
  position: relative;
  z-index: 2;
  background: #fff;
}

/* 拖动时关闭文本选择 */
body.mm-dragging {
  user-select: none;
  cursor: grabbing;
}
</style>

<style scoped>
.mm-root {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  background: #fff;
}

/* 不常驻大工具条：只留右上角一个低存在感入口 */
.mm-fab-wrap {
  position: absolute;
  top: 14px;
  right: 18px;
  z-index: 30;
}

.mm-fab {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--lb-border);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  color: var(--lb-muted);
  box-shadow: var(--lb-shadow-1);
  backdrop-filter: blur(8px);
  transition:
    color 0.14s ease,
    border-color 0.14s ease,
    transform 0.14s ease;
}

.mm-fab:hover {
  color: var(--lb-accent);
  border-color: var(--lb-accent-2);
  transform: translateY(-1px);
}

.mm-fab svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

.mm-fab-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 196px;
  padding: 5px;
  border-radius: 10px;
  background: #2b2f36;
  border: 1px solid #373c43;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
}

.mm-mi {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: none;
  color: #f2f3f5;
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
}

.mm-mi:hover {
  background: #373c43;
}

.mm-mi kbd {
  font-family: inherit;
  font-size: 11px;
  color: #a6adb5;
}

.mm-mi.danger {
  color: #ff7b72;
}

.mm-menu {
  position: fixed;
  z-index: 1000;
  min-width: 194px;
  padding: 5px;
  border-radius: 10px;
  background: #2b2f36;
  border: 1px solid #373c43;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
}

.mm-sep-h {
  height: 1px;
  margin: 4px 8px;
  background: #3d434b;
}

.mm-zoom {
  position: absolute;
  right: 20px;
  bottom: 26px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 4px;
  border-radius: 12px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  box-shadow: var(--lb-shadow-2);
}

.mm-zoom button {
  min-width: 30px;
  height: 28px;
  padding: 0 6px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--lb-text);
  font-size: 14px;
  line-height: 1;
}

.mm-zoom button:hover {
  background: var(--lb-chip);
}

.mm-zoom-val {
  min-width: 48px;
  font-size: 12px !important;
  color: var(--lb-muted) !important;
}

.mm-zoom-sep {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: var(--lb-border);
}

.mm-zoom-fit {
  font-size: 15px !important;
}

.mm-drag-ghost {
  position: fixed;
  z-index: 1200;
  max-width: 220px;
  padding: 6px 11px;
  border-radius: 12px;
  background: #fff;
  border: 1px solid var(--lb-accent);
  box-shadow: 0 8px 24px rgba(0, 60, 140, 0.18);
  font-size: 13px;
  color: var(--lb-text);
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mm-drop-line {
  position: fixed;
  z-index: 1100;
  height: 2px;
  border-radius: 1px;
  background: var(--lb-accent);
  box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.16);
  pointer-events: none;
}

.mm-note-card {
  position: absolute;
  left: 50%;
  bottom: 86px;
  z-index: 40;
  width: min(360px, calc(100% - 40px));
  padding: 12px;
  border-radius: 14px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  box-shadow: var(--lb-shadow-3);
  transform: translateX(-50%);
}

.mm-note-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: var(--lb-text);
}

.mm-note-head button {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 11px;
}

.mm-note-text {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 10px;
  background: var(--lb-panel);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  color: var(--lb-text);
  resize: vertical;
  min-height: 74px;
}

.mm-note-text:focus {
  outline: none;
  border-color: rgba(0, 113, 227, 0.55);
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
}

.mm-note-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}

.mm-note-hint {
  font-size: 11px;
  color: var(--lb-muted);
}

.mm-note-save {
  padding: 5px 14px;
  border: none;
  border-radius: 8px;
  background: var(--lb-accent);
  color: #fff;
  font-size: 12px;
}

.mm-note-save:hover {
  filter: brightness(1.05);
}

.mm-file {
  display: none;
}
</style>
