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
  /** 缩放记忆键（settings 表）；空串则不记忆 */
  zoomKey?: string
  /** 所属笔记 id：配色与结构按笔记记住（settings 表） */
  noteId?: string | number
}>()
const emit = defineEmits<{
  (e: 'change', tree: OutlineNode[]): void
  (e: 'error', err: unknown): void
  (e: 'notice', text: string): void
  (e: 'rename', title: string): void
  (e: 'undo'): void
  (e: 'redo'): void
  /** 请求插入法条引用（/、@、Ctrl+K）：浮层在大纲壳里，导图只报锚点节点 */
  (e: 'ref-request', nodeId: string): void
}>()

const hostEl = ref<HTMLElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
let jm: jsMind | null = null
let pendingSelf = false
/** 最近一次同步出去的树：外部回流若与它同构就不重载画布（防无意义重建闪屏/高亮重闪） */
let lastSync: OutlineNode[] | null = null
let metaById = new Map<string, OutlineNode>()
let resizeTimers: ReturnType<typeof setTimeout>[] = []
let centerTimer: ReturnType<typeof setTimeout> | undefined
let initialFitDone = false

const VIRTUAL_ROOT_ID = '_lb_root_'

// ---------- 外观：结构 / 配色 ----------

type MapStructure = 'balanced' | 'alternate' | 'right' | 'left'

const STRUCTURES: { id: MapStructure; label: string }[] = [
  { id: 'balanced', label: '平衡分侧' },
  { id: 'alternate', label: '左右交替' },
  { id: 'right', label: '单向右展' },
  { id: 'left', label: '单向左展' }
]

interface MapTheme {
  /** 内部标识，不出现在界面上 */
  id: string
  dark: boolean
  canvas: string
  node: string
  rootBg: string
  text: string
  border: string
  line: string
  accent: string
  accentSoft: string
  accentLine: string
  rootBorder: string
  muted: string
  nodeShadow: string
  hoverShadow: string
  selectShadow: string
  dropBg: string
  editorBg: string
}

/** 配色：浅色六套、深色三套；界面只展示色样，不展示名字 */
const MAP_THEMES: MapTheme[] = [
  {
    id: 'paper',
    dark: false,
    canvas: '#ffffff',
    node: '#ffffff',
    rootBg: '#ffffff',
    text: '#1d1d1f',
    border: '#e7ebf0',
    line: '#b3bdc8',
    accent: '#0071e3',
    accentSoft: 'rgba(0, 113, 227, 0.1)',
    accentLine: 'rgba(0, 113, 227, 0.34)',
    rootBorder: 'rgba(0, 113, 227, 0.24)',
    muted: '#86868b',
    nodeShadow: 'rgba(20, 24, 38, 0.05)',
    hoverShadow: 'rgba(0, 90, 190, 0.1)',
    selectShadow: 'rgba(0, 90, 190, 0.14)',
    dropBg: '#f4f9ff',
    editorBg: '#ffffff'
  },
  {
    id: 'graphite',
    dark: false,
    canvas: '#fbfbfc',
    node: '#ffffff',
    rootBg: '#ffffff',
    text: '#1f2124',
    border: '#e3e5e8',
    line: '#b7bcc3',
    accent: '#4b5563',
    accentSoft: 'rgba(75, 85, 99, 0.1)',
    accentLine: 'rgba(75, 85, 99, 0.32)',
    rootBorder: 'rgba(75, 85, 99, 0.24)',
    muted: '#8a8e94',
    nodeShadow: 'rgba(20, 24, 38, 0.05)',
    hoverShadow: 'rgba(30, 35, 45, 0.1)',
    selectShadow: 'rgba(30, 35, 45, 0.14)',
    dropBg: '#f4f5f7',
    editorBg: '#ffffff'
  },
  {
    id: 'bamboo',
    dark: false,
    canvas: '#fbfdfb',
    node: '#ffffff',
    rootBg: '#ffffff',
    text: '#1c211e',
    border: '#e2eae5',
    line: '#b4c7bd',
    accent: '#2f7d5c',
    accentSoft: 'rgba(47, 125, 92, 0.1)',
    accentLine: 'rgba(47, 125, 92, 0.32)',
    rootBorder: 'rgba(47, 125, 92, 0.24)',
    muted: '#7f8c85',
    nodeShadow: 'rgba(20, 40, 30, 0.05)',
    hoverShadow: 'rgba(30, 100, 70, 0.1)',
    selectShadow: 'rgba(30, 100, 70, 0.14)',
    dropBg: '#f2faf6',
    editorBg: '#ffffff'
  },
  {
    id: 'clay',
    dark: false,
    canvas: '#fffdf9',
    node: '#fffdfb',
    rootBg: '#fffdfb',
    text: '#241f1b',
    border: '#ede4da',
    line: '#d2c3b4',
    accent: '#a4653c',
    accentSoft: 'rgba(164, 101, 60, 0.1)',
    accentLine: 'rgba(164, 101, 60, 0.32)',
    rootBorder: 'rgba(164, 101, 60, 0.24)',
    muted: '#8b8178',
    nodeShadow: 'rgba(50, 30, 15, 0.05)',
    hoverShadow: 'rgba(120, 60, 20, 0.1)',
    selectShadow: 'rgba(120, 60, 20, 0.14)',
    dropBg: '#fdf6ee',
    editorBg: '#fffdfb'
  },
  {
    id: 'violet',
    dark: false,
    canvas: '#fdfcff',
    node: '#ffffff',
    rootBg: '#ffffff',
    text: '#221f28',
    border: '#e8e3f0',
    line: '#c7c0d5',
    accent: '#6b5a90',
    accentSoft: 'rgba(107, 90, 144, 0.1)',
    accentLine: 'rgba(107, 90, 144, 0.32)',
    rootBorder: 'rgba(107, 90, 144, 0.24)',
    muted: '#86818f',
    nodeShadow: 'rgba(30, 20, 45, 0.05)',
    hoverShadow: 'rgba(80, 50, 120, 0.1)',
    selectShadow: 'rgba(80, 50, 120, 0.14)',
    dropBg: '#f7f4fd',
    editorBg: '#ffffff'
  },
  {
    id: 'slate',
    dark: false,
    canvas: '#fbfdff',
    node: '#ffffff',
    rootBg: '#ffffff',
    text: '#1b2226',
    border: '#e1e9ee',
    line: '#b4c6d1',
    accent: '#3a6d84',
    accentSoft: 'rgba(58, 109, 132, 0.1)',
    accentLine: 'rgba(58, 109, 132, 0.32)',
    rootBorder: 'rgba(58, 109, 132, 0.24)',
    muted: '#7d8a91',
    nodeShadow: 'rgba(10, 30, 45, 0.05)',
    hoverShadow: 'rgba(20, 70, 90, 0.1)',
    selectShadow: 'rgba(20, 70, 90, 0.14)',
    dropBg: '#f2f9fd',
    editorBg: '#ffffff'
  },
  {
    id: 'night',
    dark: true,
    canvas: '#191c21',
    node: '#24282f',
    rootBg: '#2a3038',
    text: '#e9ebee',
    border: '#363c45',
    line: '#4a525d',
    accent: '#5aa2f0',
    accentSoft: 'rgba(90, 162, 240, 0.18)',
    accentLine: 'rgba(90, 162, 240, 0.45)',
    rootBorder: 'rgba(90, 162, 240, 0.35)',
    muted: '#98a1ab',
    nodeShadow: 'rgba(0, 0, 0, 0.35)',
    hoverShadow: 'rgba(0, 0, 0, 0.4)',
    selectShadow: 'rgba(90, 162, 240, 0.2)',
    dropBg: '#1f2c3d',
    editorBg: '#1f242b'
  },
  {
    id: 'jade',
    dark: true,
    canvas: '#141a17',
    node: '#1e2723',
    rootBg: '#25302b',
    text: '#e4ece7',
    border: '#33433b',
    line: '#46584f',
    accent: '#63b48f',
    accentSoft: 'rgba(99, 180, 143, 0.18)',
    accentLine: 'rgba(99, 180, 143, 0.45)',
    rootBorder: 'rgba(99, 180, 143, 0.35)',
    muted: '#93a49b',
    nodeShadow: 'rgba(0, 0, 0, 0.35)',
    hoverShadow: 'rgba(0, 0, 0, 0.4)',
    selectShadow: 'rgba(99, 180, 143, 0.2)',
    dropBg: '#1b2b23',
    editorBg: '#1a231e'
  },
  {
    id: 'amber',
    dark: true,
    canvas: '#1b1714',
    node: '#27211c',
    rootBg: '#302820',
    text: '#f0e8df',
    border: '#41382f',
    line: '#54463a',
    accent: '#d79a63',
    accentSoft: 'rgba(215, 154, 99, 0.18)',
    accentLine: 'rgba(215, 154, 99, 0.45)',
    rootBorder: 'rgba(215, 154, 99, 0.35)',
    muted: '#a99a8c',
    nodeShadow: 'rgba(0, 0, 0, 0.35)',
    hoverShadow: 'rgba(0, 0, 0, 0.4)',
    selectShadow: 'rgba(215, 154, 99, 0.2)',
    dropBg: '#30251b',
    editorBg: '#221c17'
  }
]

const lightThemes = MAP_THEMES.filter((t) => !t.dark)
const darkThemes = MAP_THEMES.filter((t) => t.dark)

const structure = ref<MapStructure>('balanced')
const themeId = ref('paper')
const currentTheme = computed(() => MAP_THEMES.find((t) => t.id === themeId.value) ?? MAP_THEMES[0]!)

/** 主题变量挂在 .mm-root 上：节点/连线/画布都从这里取色 */
const themeVars = computed<Record<string, string>>(() => {
  const t = currentTheme.value
  return {
    '--mm-canvas': t.canvas,
    '--mm-node-bg': t.node,
    '--mm-root-bg': t.rootBg,
    '--mm-text': t.text,
    '--mm-border': t.border,
    '--mm-line': t.line,
    '--mm-accent': t.accent,
    '--mm-accent-soft': t.accentSoft,
    '--mm-accent-line': t.accentLine,
    '--mm-root-border': t.rootBorder,
    '--mm-muted': t.muted,
    '--mm-node-shadow': t.nodeShadow,
    '--mm-hover-shadow': t.hoverShadow,
    '--mm-select-shadow': t.selectShadow,
    '--mm-drop-bg': t.dropBg,
    '--mm-editor-bg': t.editorBg
  }
})

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

/** 顶层分支方向：按用户选择的结构决定（默认智能平衡） */
function directionsFor(nodes: OutlineNode[]): ('left' | 'right')[] {
  const n = nodes.length
  if (n === 0) return []
  if (structure.value === 'right') return new Array<'right'>(n).fill('right')
  if (structure.value === 'left') return new Array<'left'>(n).fill('left')
  if (structure.value === 'alternate') {
    return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 'right' : 'left'))
  }
  return rootDirections(nodes)
}

function toJsMind(nodes: OutlineNode[]): Record<string, unknown> {
  const dirs = directionsFor(nodes)
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
    lastSync = out
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
  const reveal = pendingRevealId
  const rseq = ++revealSeq
  if (reveal) {
    // 有要揭示的新节点（刚插入的引用）：本轮的「回到画布中央」让位，
    // 等 resize 后的二次布局稳定再滚过去，否则刚滚到就被 centerViewport 拉回中间
    pendingRevealId = null
    const doReveal = (): void => {
      if (rseq === revealSeq) revealNode(reveal)
    }
    nextTick(doReveal)
    setTimeout(doReveal, 380)
  } else {
    // 初次进入/重载把视口放在额外画布中间，四向都有可拖空间
    nextTick(() => centerViewport())
    scheduleCenter()
    if (!initialFitDone) {
      initialFitDone = true
      nextTick(() => {
        fitView()
        centerViewport()
        scheduleCenter()
        jm?.select_node(jm.get_root())
      })
    }
  }
  syncZoom(false)
  void restoreZoom()
}

function scheduleResize(): void {
  for (const t of resizeTimers) clearTimeout(t)
  resizeTimers = []
  resizeTimers.push(setTimeout(() => jm?.resize(), 0))
  resizeTimers.push(setTimeout(() => jm?.resize(), 300))
}

/** 等 resize/布局完成后把视口放回中间（不被 scheduleResize 清掉） */
function scheduleCenter(): void {
  clearTimeout(centerTimer)
  centerTimer = setTimeout(centerViewport, 380)
}

/** 把视口滚到额外画布的中间：小图也能向四个方向平移 */
function centerViewport(): void {
  if (!jm) return
  const p = jm.view.e_panel
  if (!p) return
  p.scrollLeft = Math.max(0, Math.round((p.scrollWidth - p.clientWidth) / 2))
  p.scrollTop = Math.max(0, Math.round((p.scrollHeight - p.clientHeight) / 2))
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

/** 树同构比较：字段逐比 + 子树递归（归一化可能改字段序，不能用 JSON 全串比） */
function sameTree(a: OutlineNode[], b: OutlineNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!x || !y) return false
    if (
      x.id !== y.id ||
      x.text !== y.text ||
      x.fold !== y.fold ||
      x.task !== y.task ||
      x.heading !== y.heading ||
      (x.note ?? '') !== (y.note ?? '') ||
      (x.image ?? '') !== (y.image ?? '') ||
      (x.html ?? '') !== (y.html ?? '') ||
      (x.images ?? []).join('\u0000') !== (y.images ?? []).join('\u0000') ||
      JSON.stringify(x.ref ?? null) !== JSON.stringify(y.ref ?? null)
    ) {
      return false
    }
    if (!sameTree(x.children ?? [], y.children ?? [])) return false
  }
  return true
}

/** jsMind 内联编辑输入框被打断（DOM 重画拆掉）后残留会把 is_editing() 卡成 true：
 *  方向键从此全哑，残留蓝框条压在标题下像一条蓝线。每次交互前兜底收尾/清理。 */
function recoverStaleEditor(): void {
  if (!jm) return
  const view = jm.view as unknown as {
    e_editor: HTMLInputElement
    editing_node: unknown
    edit_node_end: () => void
  }
  const ed = view.e_editor
  const live = ed && ed.isConnected && document.activeElement === ed
  if (!live && view.editing_node) {
    try {
      view.edit_node_end() // 编辑器还在、只是失焦：正常收尾并落库
    } catch {
      view.editing_node = null // 编辑器已被重画拆掉：直接复位（丢失的改动本就已不在 DOM）
    }
  }
  if (view.editing_node) return
  // 无编辑状态下不留任何编辑框/空壳节点（残留后遮住标题、看起来像“蓝线”）
  for (const el of Array.from(jm.view.e_nodes.querySelectorAll('.jsmind-editor'))) el.remove()
  for (const el of Array.from(jm.view.e_nodes.querySelectorAll('jmnode'))) {
    const id = jm.view.get_binded_nodeid(el)
    const node = id ? jm.mind.nodes[id] : null
    // 只补「既无输入框也无图文内容」的空壳；纯图片/图标节点的 textContent 本就是空，
    // 直接写 node.topic 会把缩略图抹掉
    if (node && !el.querySelector('input, img, svg') && !el.textContent?.trim()) el.textContent = node.topic
  }
}

function paintDecorations(): void {
  if (!jm) return
  recoverStaleEditor()
  for (const el of Array.from(jm.view.e_nodes.querySelectorAll('jmnode'))) {
    const id = jm.view.get_binded_nodeid(el)
    if (!id) continue
    const node = metaById.get(id)
    el.classList.toggle('mm-task', !!node?.task)
    el.classList.toggle('mm-task-done', node?.task === 2)
    el.classList.toggle('mm-has-note', !!node?.note)
    // 法条引用节点：与大纲里的引用行同一套视觉语汇（衬线 + 强调色 + 📖）
    el.classList.toggle('mm-ref', !!node?.ref)
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

// ---------- 供父级调用 ----------

/** 等树回流重建后再揭示的节点（重建异步：图片预载），先记账，加载完再滚过去 */
let pendingRevealId: string | null = null
/** 揭示轮次：连续插入时只让最后一次的定时器生效 */
let revealSeq = 0

/** 选中并居中到指定节点；节点还没渲染就先记账 */
function revealNode(id: string): void {
  if (!jm) return
  const node = jm.mind.nodes[id]
  if (!node) {
    pendingRevealId = id
    return
  }
  jm.select_node(node)
  jm.scroll_node_to_center(node)
}

/** / @ Ctrl+K：请父级打开引用检索浮层，锚点=当前选中节点 */
function requestRefPicker(): void {
  const sel = ensureSelected()
  if (!sel) return
  emit('ref-request', sel.id)
}

defineExpose({ revealNode })

function nodeFrame(n: MNode): { x: number; y: number; w: number; h: number } {
  const loc = n.get_location()
  const size = n.get_size()
  return { x: loc.x, y: loc.y, w: size.w, h: size.h }
}

function centerOf(f: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: f.x + f.w / 2, y: f.y + f.h / 2 }
}

/** 纵向导航：同级沿分支上下移；无同级可去时全图取纵向最近（横向偏移加权惩罚） */
function pickVertical(sel: MNode, dir: -1 | 1): MNode | null {
  const siblings = (sel.parent ? sel.parent.children : []).filter((n) => jm!.layout.is_visible(n))
  const i = siblings.findIndex((n) => n.id === sel.id)
  const sib = siblings[i + dir]
  if (sib) return sib
  const cur = centerOf(nodeFrame(sel))
  let best: MNode | null = null
  let bestScore = Infinity
  for (const n of Object.values(jm!.mind.nodes)) {
    if (n.id === sel.id || n.isroot || !jm!.layout.is_visible(n)) continue
    const c = centerOf(nodeFrame(n))
    const dy = (c.y - cur.y) * dir
    if (dy <= 4) continue
    const score = dy + Math.abs(c.x - cur.x) * 1.2
    if (score < bestScore) {
      bestScore = score
      best = n
    }
  }
  return best
}

/** 横向导航：绝对方向（右键=选中更右边的节点），左右两侧分支都符合直觉；
 *  父/子关系加权：沿分支走优先于跨分支跳跃 */
function pickHorizontal(sel: MNode, dirX: 1 | -1): MNode | null {
  const cur = centerOf(nodeFrame(sel))
  const childIds = new Set((sel.children ?? []).map((c) => c.id))
  const parentId = sel.parent && !sel.isroot ? sel.parent.id : null
  let best: MNode | null = null
  let bestScore = Infinity
  for (const n of Object.values(jm!.mind.nodes)) {
    if (n.id === sel.id || !jm!.layout.is_visible(n)) continue
    const c = centerOf(nodeFrame(n))
    // 中心必须在目标方向上；同一列不横向跳
    const dcx = (c.x - cur.x) * dirX
    if (dcx <= 4) continue
    const dcy = Math.abs(c.y - cur.y)
    const kin = n.id === parentId || childIds.has(n.id) ? 0.55 : 1
    const score = (dcx + dcy * 2.2) * kin
    if (score < bestScore) {
      bestScore = score
      best = n
    }
  }
  return best
}

function moveSelection(key: string): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel) return
  const target =
    key === 'ArrowLeft'
      ? pickHorizontal(sel, -1)
      : key === 'ArrowRight'
        ? pickHorizontal(sel, 1)
        : pickVertical(sel, key === 'ArrowUp' ? -1 : 1)
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

/** 根下新增分支落哪一侧：按当前结构决定（平衡时选较轻一侧） */
function rootSideForNew(): 'left' | 'right' {
  if (structure.value === 'right') return 'right'
  if (structure.value === 'left') return 'left'
  if (structure.value === 'alternate') {
    const children = jm?.get_root().children ?? []
    const last = children[children.length - 1]
    return last?.direction === -1 ? 'right' : 'left'
  }
  return lighterRootSide()
}

function addChild(topic = '新主题'): void {
  if (!jm) return
  const sel = ensureSelected()
  if (!sel) return
  const id = newOutlineId()
  jm.add_node(sel.id, id, topic, undefined, sel.isroot ? rootSideForNew() : sel.direction)
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
 * 图片落点：只落在当前选中/正在编辑的主题里，不自动新建方框。
 * 中心主题是虚拟 root（笔记标题），不能直接承载图片——提示用户先选一个子主题。
 */
function ensureImageTarget(): MNode | null {
  if (!jm) return null
  const sel = jm.get_selected_node()
  if (sel && !sel.isroot) return sel
  emit('notice', '请先选中要插入图片的主题（中心主题不能直接放图）')
  return null
}

async function attachImages(files: File[], target?: MNode | null): Promise<void> {
  if (!jm || !files.length) return
  const sel = target && !target.isroot ? target : ensureImageTarget()
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
  if (!jm) return
  const items = Array.from(ev.clipboardData?.items ?? []).filter(
    (it) => it.kind === 'file' && it.type.startsWith('image/')
  )
  if (!items.length) return
  ev.preventDefault()
  const files = items.map((it) => it.getAsFile()).filter((f): f is File => !!f)
  // 正在键入节点时粘贴图片 = 插到当前编辑的主题里（不新建方框）
  if (jm.view.is_editing()) {
    const editing = jm.view.get_editing_node()
    if (editing && !editing.isroot) await attachImages(files, editing)
    else emit('notice', '中心主题不能直接放图，请先选中一个子主题')
    return
  }
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

/** 空白处按下 = 平移画布：只负责把光标切换成「抓住」，实际滚动由 jsMind 处理 */
function startPanCursor(): void {
  document.body.classList.add('mm-panning')
  const end = (): void => {
    document.body.classList.remove('mm-panning')
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
  }
  window.addEventListener('pointerup', end, { once: true })
  window.addEventListener('pointercancel', end, { once: true })
}

function onPointerDown(ev: PointerEvent): void {
  if (!jm || ev.button !== 0 || jm.view.is_editing()) return
  const el = (ev.target as HTMLElement).closest('jmnode') as HTMLElement | null
  if (!el) {
    startPanCursor()
    return
  }
  const id = jm.view.get_binded_nodeid(el)
  if (!id) return
  const node = jm.mind.nodes[id]
  if (!node || node.isroot) return
  // 不让浏览器顺手把节点文字选中：点了/拖了就留一层蓝色文本高亮，很没必要
  ev.preventDefault()
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
          jm.move_node(from.id, undefined, target.id, target.isroot ? rootSideForNew() : target.direction)
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
  window.removeEventListener('pointermove', onPointerMove)
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

// ---------- 外观（配色 / 结构） ----------

const lookOpen = ref(false)

function lookKey(): string {
  return props.noteId ? `note:map:look:${props.noteId}` : ''
}

function persistLook(): void {
  const key = lookKey()
  if (!key) return
  void window.lexbench.settings
    .set(key, JSON.stringify({ theme: themeId.value, structure: structure.value }))
    .catch(() => {
      // 外观记忆失败不打断编辑，下次回默认外观
    })
}

async function restoreLook(): Promise<void> {
  const key = lookKey()
  if (!key) return
  try {
    const raw = await window.lexbench.settings.get(key)
    if (!raw) return
    const parsed = JSON.parse(raw) as { theme?: unknown; structure?: unknown }
    if (typeof parsed.theme === 'string' && MAP_THEMES.some((t) => t.id === parsed.theme)) {
      themeId.value = parsed.theme
    }
    if (typeof parsed.structure === 'string' && STRUCTURES.some((s) => s.id === parsed.structure)) {
      structure.value = parsed.structure as MapStructure
    }
  } catch {
    // 读失败就用默认外观
  }
}

/** 把当前结构应用到现有顶层分支：不重建画布，保留选中/折叠态 */
function applyStructure(): void {
  if (!jm) return
  const root = jm.get_root()
  if (!root) return
  const nodes = root.children.map(
    (c) => metaById.get(c.id) ?? { id: c.id, text: '', children: [] as OutlineNode[] }
  )
  const dirs = directionsFor(nodes)
  root.children.forEach((child, i) => {
    child.direction = dirs[i] === 'left' ? -1 : 1
  })
  jm.layout.layout()
  jm.view.relayout()
  scheduleResize()
  nextTick(() => jm?.scroll_node_to_center(root.id))
}

function chooseStructure(id: MapStructure): void {
  if (structure.value === id) return
  structure.value = id
  applyStructure()
  persistLook()
}

function chooseTheme(id: string): void {
  if (themeId.value === id) return
  themeId.value = id
  persistLook()
}

function toggleLook(): void {
  lookOpen.value = !lookOpen.value
  if (lookOpen.value) {
    closeMenu()
    moreMenu.value = false
    if (noteEditor.open) saveNoteEditor()
  }
}

function toggleMore(): void {
  moreMenu.value = !moreMenu.value
  if (moreMenu.value) lookOpen.value = false
}

/** 连线颜色由 canvas 直接绘制，换配色时同步 opts 并重画 */
watch(themeId, () => {
  if (!jm) return
  const view = jm.view as unknown as { opts: { line_color: string }; show_lines: () => void }
  view.opts.line_color = currentTheme.value.line
  view.show_lines()
})

// ---------- 缩放 ----------

const zoomPercent = ref(100)
/** 缩放记忆：按笔记落 settings，切回大纲/重开笔记都回到上次比例 */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2
let zoomSaveTimer: ReturnType<typeof setTimeout> | undefined
let zoomPending = false
let zoomLoadSeq = 0
/** 关窗冲刷的退订函数（onBeforeUnmount 不保证在关窗时执行，单独订阅） */
let unsubBeforeClose: (() => void) | null = null

const clampZoom = (n: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100))

function zoomKeyOf(): string {
  return props.zoomKey ?? ''
}

function scheduleZoomSave(): void {
  if (!zoomKeyOf()) return
  zoomPending = true
  clearTimeout(zoomSaveTimer)
  zoomSaveTimer = setTimeout(flushZoomSave, 320)
}

/** 立即落盘（防抖窗口结束与卸载时调用） */
function flushZoomSave(): void {
  clearTimeout(zoomSaveTimer)
  if (!zoomPending) return
  zoomPending = false
  const key = zoomKeyOf()
  if (!key) return
  void window.lexbench.settings.set(key, String(zoomPercent.value / 100)).catch(() => {
    // 记忆失败只是下次回到自适应，不打断操作
  })
}

/** 缩放变化的统一出口：刷新百分比，需要落库时落库 */
function syncZoom(persist: boolean): void {
  if (!jm) return
  zoomPercent.value = Math.round(jm.view.zoom_current * 100)
  if (persist) scheduleZoomSave()
}

function updateZoomPercent(): void {
  syncZoom(false)
}

/** 读回该笔记的记忆比例；没有记忆就保留 fitView 的自适应结果 */
async function restoreZoom(): Promise<void> {
  const key = zoomKeyOf()
  const seq = ++zoomLoadSeq
  if (!key || !jm) return
  try {
    const raw = await window.lexbench.settings.get(key)
    if (seq !== zoomLoadSeq || !jm) return
    const n = raw === null ? Number.NaN : Number(raw)
    if (Number.isFinite(n)) jm.view.set_zoom(clampZoom(n))
    syncZoom(false)
  } catch {
    // 读失败就用当前比例
  }
}

function zoomIn(): void {
  jm?.view.zoom_in()
  syncZoom(true)
}

function zoomOut(): void {
  jm?.view.zoom_out()
  syncZoom(true)
}

function resetZoom(): void {
  jm?.view.set_zoom(1)
  syncZoom(true)
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
  syncZoom(true)
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

/** 输入框/富文本内把按键交还给输入法与浏览器（含 jsMind 节点编辑输入框） */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t instanceof HTMLElement ? t : null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function onKeydown(ev: KeyboardEvent): void {
  if (!jm || ev.isComposing) return
  if (isTypingTarget(ev.target)) return
  // 焦点在面板按钮上时也要能 Esc 收起（下面的控件过滤会提前 return）
  if (ev.key === 'Escape' && lookOpen.value) {
    lookOpen.value = false
    return
  }
  recoverStaleEditor()
  if (jm.view.is_editing()) return // 编辑输入框交给 jsMind / 浏览器
  // 键挂 window：焦点滑到 body（刚切到导图、点击后焦点丢失）也响应，方向键不再“失灵”；
  // 但在导图之外的交互元素（如下方列表、顶栏输入）上时不抢按键
  const active = document.activeElement
  const inHost =
    ev.target instanceof HTMLElement && !!hostEl.value && hostEl.value.contains(ev.target)
  // 焦点落在按钮/链接等控件上时，按键要还给控件本身（Enter/Space 激活、Esc 关下拉）：
  // 否则「＋ / ⋯」这类工具钮会因为导图抢键而按不动
  const onControl =
    active instanceof HTMLElement && !!active.closest('button, a, [role="button"]')
  const inMapChrome =
    !onControl && active instanceof HTMLElement && !!active.closest('.mm-root')
  const focusFree = !active || active === document.body || active === document.documentElement
  const inEditorShell =
    !onControl &&
    !inMapChrome &&
    active instanceof HTMLElement &&
    !!active.closest('.ol')
  if (!inHost && !inMapChrome && !focusFree && !inEditorShell) return
  // 结构键（Tab/Enter/Del/空格）只在画布/导图浮层/焦点悬空时生效：
  // 避免焦点还在「大纲/导图」切换钮上时按 Tab 突然瞦出新节点
  const structuralOK = inHost || inMapChrome || focusFree
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
  // 插入法条引用：/ @ 与 Ctrl+K 都唤出（与大纲同一套浮层）；Enter 插为选中节点的子主题
  if (mod && !ev.shiftKey && (ev.key === 'k' || ev.key === 'K')) {
    ev.preventDefault()
    requestRefPicker()
    return
  }
  if (!mod && !ev.altKey && (ev.key === '/' || ev.key === '@')) {
    ev.preventDefault()
    requestRefPicker()
    return
  }
  if (structuralOK && ev.key === 'Tab') {
    ev.preventDefault()
    if (ev.shiftKey) addSibling(true)
    else addChild()
    return
  }
  if (structuralOK && ev.key === 'Enter') {
    ev.preventDefault()
    addSibling()
    return
  }
  if (structuralOK && (ev.key === 'Delete' || ev.key === 'Backspace')) {
    ev.preventDefault()
    deleteSelected()
    return
  }
  if (structuralOK && ev.key === ' ') {
    ev.preventDefault()
    editSelected()
    return
  }
  if (structuralOK && ev.key === 'F2') {
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
    // Esc 语义统一：一次关掉所有浮层；备注先把内容落库再关（只关不存会丢字）
    closeAllPopups()
    return
  }
}

// ---------- 工具条更多菜单 ----------

const moreMenu = ref(false)

function closeAllPopups(): void {
  closeMenu()
  moreMenu.value = false
  lookOpen.value = false
  // 备注卡：保存后再关，与卡片内的 Esc/Ctrl+Enter 同一个出口
  if (noteEditor.open) saveNoteEditor()
}

// ---------- 生命周期 ----------

const titleComputed = computed(() => props.title || '笔记')

onMounted(async () => {
  if (!hostEl.value) return
  // 先读回这篇笔记的配色/结构，首屏就按记忆渲染，不闪一下默认外观
  await restoreLook()
  if (!hostEl.value) return
  try {
    jm = new jsMind({
      container: hostEl.value,
      editable: true,
      theme: null,
      support_html: false,
      view: {
        engine: 'canvas',
        hmargin: 640,
        vmargin: 480,
        line_width: 1.6,
        line_color: currentTheme.value.line,
        line_style: 'curved',
        custom_line_render: renderElbowLine,
        custom_node_render: renderNodeWithImage,
        draggable: true,
        hide_scrollbars_when_draggable: true,
        node_overflow: 'wrap',
        // mask_key 是修饰键位掩码：ctrlKey<<12 = 4096（不是 Ctrl 的 keyCode 17）
        zoom: { min: 0.4, max: 2, step: 0.1, mask_key: 4096 }
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
    // 快捷键挂 window（焦点不依赖 hostEl）；导图卸载即注销
    window.addEventListener('keydown', onKeydown)
    hostEl.value.addEventListener('pointerdown', onPointerDown)
    hostEl.value.addEventListener('contextmenu', openMenu)
    hostEl.value.addEventListener('paste', onHostPaste)
    hostEl.value.addEventListener('click', onHostClick)
    hostEl.value.addEventListener('wheel', onHostWheel, { passive: false })
    hostEl.value.addEventListener('input', onEditorInput, true)
    hostEl.value.addEventListener('focusin', onEditorFocusIn)
    document.addEventListener('click', onDocumentClick)
    // 拖动中途窗口失焦（Alt+Tab/切屏）可能再无 pointerup：遗留落点线/幽灵就是那条“蓝线”
    window.addEventListener('blur', cancelPointerDrag)
    // 关窗时渲染进程直接销毁、onBeforeUnmount 不跑：把防抖里的缩放记忆先写出去
    unsubBeforeClose = window.lexbench.app.onBeforeClose(() => flushZoomSave())
  } catch (e) {
    emit('error', e)
  }
})

function onHostClick(): void {
  hostEl.value?.focus()
}

/**
 * 触控板：
 * - 双指捏合 = ctrl+wheel，由 jsMind 缩放（mask_key 4096），这里只刷新百分比；
 * - 双指滑动 = 普通 wheel，jsMind 不管，这里手动平移画布。
 */
function onHostWheel(ev: WheelEvent): void {
  if (!jm) return
  if (ev.ctrlKey || ev.metaKey) {
    // jsMind 自己缩放了（mask_key 4096），等它算完再读比例并落库
    setTimeout(() => syncZoom(true), 40)
    return
  }
  const p = jm.view.e_panel
  if (!p) return
  ev.preventDefault()
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? p.clientHeight : 1
  p.scrollLeft += ev.deltaX * unit
  p.scrollTop += ev.deltaY * unit
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
  if (!t.closest('.mm-look-wrap')) lookOpen.value = false
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
    // 同构树（含归一化差异）也不重载：每次交互都重建画布会闪高亮、丢选中态
    if (lastSync && sameTree(t, lastSync)) {
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
  // 切视图/换笔记即销毁实例：弹出的比例先把防抖里的那笔写完
  flushZoomSave()
  unsubBeforeClose?.()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', cancelPointerDrag)
  hostEl.value?.removeEventListener('pointerdown', onPointerDown)
  hostEl.value?.removeEventListener('contextmenu', openMenu)
  hostEl.value?.removeEventListener('paste', onHostPaste)
  hostEl.value?.removeEventListener('click', onHostClick)
  hostEl.value?.removeEventListener('wheel', onHostWheel)
  hostEl.value?.removeEventListener('input', onEditorInput, true)
  hostEl.value?.removeEventListener('focusin', onEditorFocusIn)
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('pointermove', onPointerMove)
  for (const t of resizeTimers) clearTimeout(t)
  resizeTimers = []
  clearTimeout(centerTimer)
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
  <div class="mm-root" :style="themeVars">
    <div ref="hostEl" class="ol-mind" tabindex="0"></div>

    <!-- 顶部小菜单：不常驻大工具条，只留两个不碍眼的圆钮 -->
    <div class="mm-fab-bar" data-guide="map-chrome" @click.stop>
      <div class="mm-look-wrap">
        <button
          class="mm-fab"
          :class="{ 'is-on': lookOpen }"
          title="配色与结构"
          aria-label="配色与结构"
          @click.stop="toggleLook()"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="3" y="3" width="6" height="6" rx="1.7" />
            <rect x="11" y="3" width="6" height="6" rx="1.7" opacity="0.4" />
            <rect x="3" y="11" width="6" height="6" rx="1.7" opacity="0.4" />
            <rect x="11" y="11" width="6" height="6" rx="1.7" />
          </svg>
        </button>

        <div v-if="lookOpen" class="mm-look-panel" role="dialog" aria-label="配色与结构" @click.stop>
          <div class="mm-look-head">
            <span>外观</span>
            <button class="mm-look-x" title="关闭" @click="lookOpen = false">✕</button>
          </div>

          <div class="mm-look-title">结构</div>
          <div class="mm-struct-grid">
            <button
              v-for="s in STRUCTURES"
              :key="s.id"
              class="mm-struct-card"
              :class="{ active: structure === s.id }"
              :title="s.label"
              :aria-pressed="structure === s.id"
              @click="chooseStructure(s.id)"
            >
              <svg class="mm-struct-thumb" viewBox="0 0 88 44" aria-hidden="true">
                <template v-if="s.id === 'balanced'">
                  <path class="thumb-link" d="M34 22 H22 M54 22 H59 V11 H66 M54 22 H59 V32 H66" />
                  <rect class="thumb-root" x="34" y="16" width="20" height="12" rx="3.5" />
                  <rect class="thumb-leaf" x="4" y="17" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="66" y="6" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="66" y="27" width="18" height="10" rx="2.5" />
                </template>
                <template v-else-if="s.id === 'alternate'">
                  <path
                    class="thumb-link"
                    d="M34 22 H29 V11 H22 M34 22 H29 V32 H22 M54 22 H59 V11 H66 M54 22 H59 V32 H66"
                  />
                  <rect class="thumb-root" x="34" y="16" width="20" height="12" rx="3.5" />
                  <rect class="thumb-leaf" x="4" y="6" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="4" y="27" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="66" y="6" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="66" y="27" width="18" height="10" rx="2.5" />
                </template>
                <template v-else-if="s.id === 'right'">
                  <path class="thumb-link" d="M26 22 H44 V7 H64 M26 22 H44 V22 H64 M26 22 H44 V37 H64" />
                  <rect class="thumb-root" x="6" y="16" width="20" height="12" rx="3.5" />
                  <rect class="thumb-leaf" x="64" y="2" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="64" y="17" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="64" y="32" width="18" height="10" rx="2.5" />
                </template>
                <template v-else>
                  <path class="thumb-link" d="M62 22 H44 V7 H24 M62 22 H44 V22 H24 M62 22 H44 V37 H24" />
                  <rect class="thumb-root" x="62" y="16" width="20" height="12" rx="3.5" />
                  <rect class="thumb-leaf" x="6" y="2" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="6" y="17" width="18" height="10" rx="2.5" />
                  <rect class="thumb-leaf" x="6" y="32" width="18" height="10" rx="2.5" />
                </template>
              </svg>
              <span>{{ s.label }}</span>
            </button>
          </div>

          <div class="mm-look-title">配色</div>
          <div class="mm-look-sub">浅色</div>
          <div class="mm-swatch-grid">
            <button
              v-for="t in lightThemes"
              :key="t.id"
              class="mm-swatch"
              :class="{ active: themeId === t.id }"
              :style="{ background: t.canvas }"
              title="使用这套配色"
              :aria-pressed="themeId === t.id"
              @click="chooseTheme(t.id)"
            >
              <span class="mm-swatch-row">
                <i class="sw-accent" :style="{ background: t.accent }"></i>
                <i class="sw-node" :style="{ background: t.node, borderColor: t.border }"></i>
                <i class="sw-line" :style="{ background: t.line }"></i>
              </span>
            </button>
          </div>
          <div class="mm-look-sub">深色</div>
          <div class="mm-swatch-grid">
            <button
              v-for="t in darkThemes"
              :key="t.id"
              class="mm-swatch"
              :class="{ active: themeId === t.id }"
              :style="{ background: t.canvas }"
              title="使用这套配色"
              :aria-pressed="themeId === t.id"
              @click="chooseTheme(t.id)"
            >
              <span class="mm-swatch-row">
                <i class="sw-accent" :style="{ background: t.accent }"></i>
                <i class="sw-node" :style="{ background: t.node, borderColor: t.border }"></i>
                <i class="sw-line" :style="{ background: t.line }"></i>
              </span>
            </button>
          </div>
        </div>
      </div>

      <div class="mm-fab-wrap">
        <button class="mm-fab" title="导图操作" @click.stop="toggleMore()">
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
          <button class="mm-mi" @click="moreMenu = false; requestRefPicker()">插入法条引用 <kbd>Ctrl+K</kbd></button>
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
      <button class="mm-mi" @click="menuCall(() => requestRefPicker())">插入法条引用 <kbd>Ctrl+K</kbd></button>
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
        <span class="mm-note-hint">Esc / Ctrl+Enter 保存并关闭</span>
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
  background: var(--mm-canvas, #fff);
  position: relative;
  cursor: grab;
}

body.mm-panning .ol-mind,
body.mm-panning .ol-mind *,
body.mm-dragging .ol-mind,
body.mm-dragging .ol-mind * {
  cursor: grabbing !important;
}

.ol-mind jmnode {
  background: var(--mm-node-bg, #fff);
  color: var(--mm-text, var(--lb-text));
  border: 1px solid var(--mm-border, #e7ebf0);
  border-radius: 22px;
  box-shadow: 0 1px 2px var(--mm-node-shadow, rgba(20, 24, 38, 0.05));
  font-family: var(--lb-sans);
  font-size: 15px;
  line-height: 1.55;
  padding: 8px 15px;
  max-width: 280px;
  white-space: normal;
  cursor: grab;
  /* 点选/拖动不该顺带把标题文字选中（蓝色文本高亮是误染而非反馈） */
  user-select: none;
  -webkit-user-select: none;
  transition:
    border-color 0.14s ease,
    box-shadow 0.14s ease,
    transform 0.14s ease;
}

.ol-mind jmnode:active {
  cursor: grabbing;
}

.ol-mind jmnode:hover {
  border-color: var(--mm-accent, var(--lb-accent-2));
  box-shadow: 0 3px 10px var(--mm-hover-shadow, rgba(0, 90, 190, 0.1));
}

.ol-mind jmnode.selected {
  background: var(--mm-node-bg, #fff);
  color: var(--mm-text, var(--lb-text));
  border-color: var(--mm-accent, var(--lb-accent));
  box-shadow:
    0 0 0 3px var(--mm-accent-soft, var(--lb-accent-soft)),
    0 4px 14px var(--mm-select-shadow, rgba(0, 90, 190, 0.14));
}

.ol-mind jmnode.root {
  background: var(--mm-root-bg, #fff);
  font-size: 18px;
  font-weight: 600;
  border-radius: 24px;
  padding: 11px 20px;
  border-color: var(--mm-root-border, rgba(0, 113, 227, 0.24));
}

.ol-mind jmnode.root.selected {
  border-color: var(--mm-accent, var(--lb-accent));
}

.ol-mind jmnode.mm-drop-into {
  border-color: var(--mm-accent, var(--lb-accent)) !important;
  box-shadow: 0 0 0 4px var(--mm-accent-soft, rgba(0, 113, 227, 0.18)) !important;
  background: var(--mm-drop-bg, #f4f9ff);
}

.ol-mind jmnode.mm-task::before {
  content: '☐';
  display: inline-block;
  margin-right: 5px;
  color: var(--mm-muted, var(--lb-muted));
  font-size: 13px;
}

/* 法条引用：📖 常显；同时是待办时与勾选框并存（两个标记都挂 ::before）*/
.ol-mind jmnode.mm-ref::before {
  content: '📖';
  display: inline-block;
  margin-right: 5px;
  font-size: 12px;
}

.ol-mind jmnode.mm-ref.mm-task::before {
  content: '📖 ☐';
}

.ol-mind jmnode.mm-ref.mm-task-done::before {
  content: '📖 ☑';
}

/* :not(.selected) 让选中态的强调边框优先级不受影响 */
.ol-mind jmnode.mm-ref:not(.selected) {
  font-family: var(--lb-serif);
  color: var(--mm-accent, var(--lb-accent));
  border-color: var(--mm-accent-line, rgba(0, 113, 227, 0.34));
}

.ol-mind jmnode.mm-task-done::before {
  content: '☑';
  color: var(--mm-accent, var(--lb-accent));
}

.ol-mind jmnode.mm-task-done {
  text-decoration: line-through;
  opacity: 0.62;
}

.ol-mind jmnode.mm-has-note::after {
  content: '▤';
  display: inline-block;
  margin-left: 6px;
  color: var(--mm-muted, var(--lb-muted));
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
  border: 1px solid var(--mm-border, #c8ced4);
  background: var(--mm-node-bg, #fff);
  color: var(--mm-muted, #646a73);
  box-shadow: 0 1px 3px var(--mm-node-shadow, rgba(0, 0, 0, 0.08));
}

.ol-mind jmexpander:hover {
  border-color: var(--mm-accent, var(--lb-accent-2));
  color: var(--mm-accent, var(--lb-accent));
}

.ol-mind .jsmind-inner {
  background: transparent;
}

.ol-mind .jsmind-editor {
  box-sizing: border-box;
  border: 1px solid var(--mm-accent, rgba(0, 113, 227, 0.55));
  border-radius: 10px;
  box-shadow: 0 0 0 3px var(--mm-accent-soft, rgba(0, 113, 227, 0.12));
  font-family: var(--lb-sans);
  font-size: 14px;
  padding: 6px 10px;
  outline: none;
  position: relative;
  z-index: 2;
  background: var(--mm-editor-bg, #fff);
  color: var(--mm-text, var(--lb-text));
  /* 节点禁止选中，但编辑框本身要能选文字 */
  user-select: text;
  -webkit-user-select: text;
}

/* jsMind 进编辑是整段选中再敲键替换：选区弱化成淡色，别整块高亮 */
.ol-mind .jsmind-editor::selection {
  background: var(--mm-accent-soft, rgba(0, 113, 227, 0.16));
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
  background: var(--mm-canvas, #fff);
}

/* 不常驻大工具条：只留右上角两个低存在感圆钮 */
.mm-fab-bar {
  position: absolute;
  top: 14px;
  right: 18px;
  z-index: 30;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.mm-look-wrap,
.mm-fab-wrap {
  position: relative;
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

.mm-fab.is-on {
  color: var(--lb-accent);
  border-color: rgba(0, 113, 227, 0.45);
  box-shadow:
    0 0 0 3px var(--lb-accent-soft),
    var(--lb-shadow-1);
}

/* ---------- 外观面板：结构缩略图 + 配色色样 ---------- */

.mm-look-panel {
  position: absolute;
  top: calc(100% + 8px);
  /* 与右侧「⋯」钮的右缘对齐，视觉上仍是右上角一块 */
  right: -42px;
  z-index: 40;
  width: 304px;
  max-height: min(74vh, 640px);
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  background: var(--lb-panel);
  box-shadow: var(--lb-shadow-2);
}

.mm-look-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px 10px;
}

.mm-look-head span {
  font-size: 13px;
  font-weight: 600;
  color: var(--lb-text);
}

.mm-look-x {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 11px;
}

.mm-look-title {
  margin: 14px 2px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--lb-text);
}

.mm-look-head + .mm-look-title {
  margin-top: 0;
}

.mm-look-sub {
  margin: 8px 2px 6px;
  font-size: 11px;
  color: var(--lb-muted);
}

.mm-struct-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.mm-struct-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 7px 6px 6px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-muted);
  transition:
    border-color 0.14s ease,
    box-shadow 0.14s ease,
    transform 0.14s ease,
    color 0.14s ease;
}

.mm-struct-card:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-text);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.07);
}

.mm-struct-card.active {
  border-color: var(--lb-accent);
  color: var(--lb-accent);
  box-shadow: 0 0 0 3px var(--lb-accent-soft);
}

.mm-struct-card span {
  font-size: 11px;
  line-height: 1.2;
  color: inherit;
}

.mm-struct-thumb {
  display: block;
  width: 100%;
  height: 38px;
}

.mm-struct-thumb .thumb-root {
  fill: currentColor;
}

.mm-struct-thumb .thumb-leaf {
  fill: currentColor;
  opacity: 0.34;
}

.mm-struct-thumb .thumb-link {
  fill: none;
  stroke: currentColor;
  stroke-opacity: 0.42;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mm-swatch-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.mm-swatch {
  position: relative;
  display: flex;
  align-items: flex-end;
  height: 42px;
  padding: 8px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-xs);
  transition:
    border-color 0.14s ease,
    box-shadow 0.14s ease,
    transform 0.14s ease;
}

.mm-swatch:hover {
  border-color: var(--lb-accent-2);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.07);
}

.mm-swatch.active {
  border-color: var(--lb-accent);
  box-shadow: 0 0 0 3px var(--lb-accent-soft);
}

.mm-swatch.active::after {
  content: '';
  position: absolute;
  top: 7px;
  right: 7px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--lb-accent);
}

.mm-swatch-row {
  display: flex;
  align-items: flex-end;
  gap: 3px;
}

.mm-swatch-row i {
  display: block;
  height: 10px;
  border-radius: 3px;
}

.mm-swatch-row .sw-accent {
  width: 18px;
}

.mm-swatch-row .sw-node {
  width: 12px;
  border: 1px solid transparent;
}

.mm-swatch-row .sw-line {
  width: 6px;
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
