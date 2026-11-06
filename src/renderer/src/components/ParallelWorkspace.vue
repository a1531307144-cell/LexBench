<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type {
  DocGroupRow,
  DocumentDetail,
  DocumentRow,
  OutlineRow,
  ParallelLayout,
  ParallelPane,
  PaneRect
} from '@shared/types'
import {
  DEFAULT_NOTE_RATIO,
  MAX_NOTE_RATIO,
  MIN_NOTE_RATIO,
  addDocPane,
  bringToFront,
  createDefaultLayout,
  deriveSplitRects,
  normalizeColRatios,
  normalizeRowRatios,
  parseParallelLayout,
  removePane,
  serializeParallelLayout,
  setMode as setLayoutMode,
  splitRowsFor
} from '@shared/parallelLayout'
import OutlineEditor from './OutlineEditor.vue'
import ReadingView from './ReadingView.vue'
import StatuteReadingView from './StatuteReadingView.vue'
import ParallelPaneFrame from './ParallelPaneFrame.vue'
import ParallelDocPane from './ParallelDocPane.vue'
import DocPicker from './DocPicker.vue'

const props = defineProps<{
  note: OutlineRow | null
  noteRev: number
  documents: DocumentRow[]
  groups: DocGroupRow[]
  /** 左侧竖排是否已隐藏（全局模式） */
  railHidden?: boolean
}>()

const emit = defineEmits<{
  error: [err: unknown]
  notice: [text: string]
  'docs-changed': []
  'views-changed': []
  /** 切换全局模式：隐去/恢复左侧竖排 */
  'toggle-rail': []
  /** 模式切换/重置前刷新 App 手里的笔记快照，避免编辑器用旧树重挂 */
  'note-refreshed': [row: OutlineRow]
}>()

const layout = ref<ParallelLayout>(createDefaultLayout())
const loading = ref(false)
const activePaneId = ref<string | null>(null)
const maximizedPaneId = ref<string | null>(null)
/** 笔记编辑器实例：必须是函数 ref——浮动态编辑器在 v-for 里，用字符串 ref 会拿到数组 */
const noteEditor = ref<InstanceType<typeof OutlineEditor> | null>(null)
function setNoteEditor(el: unknown): void {
  noteEditor.value = (el as InstanceType<typeof OutlineEditor> | null) ?? null
}
const splitEl = ref<HTMLElement | null>(null)
const docAreaEl = ref<HTMLElement | null>(null)
const floatEl = ref<HTMLElement | null>(null)
const dropActive = ref(false)

/** 文档详情缓存（同一文档开两窗时共用一份） */
const details = reactive(new Map<number, DocumentDetail>())
const paneErrors = reactive(new Map<string, string>())
const loadingDocs = reactive(new Set<number>())

const picker = reactive({ open: false, target: 'new' as 'new' | string })

// ---------- 基础派生 ----------

const notePane = computed<ParallelPane | null>(
  () => layout.value.panes.find((p) => p.kind === 'note') ?? null
)
const docPanes = computed(() => layout.value.panes.filter((p) => p.kind === 'doc'))
const splitRows = computed(() => splitRowsFor(docPanes.value.length))
const rowRatios = computed(() => normalizeRowRatios(layout.value.rowRatios, splitRows.value.length))
const colRatios = computed(() => normalizeColRatios(layout.value.colRatios, splitRows.value.length))

const floatPanes = computed(() =>
  [...layout.value.panes]
    .map((pane, index) => ({ pane, index }))
    .sort((a, b) => a.pane.z - b.pane.z || a.index - b.index)
    .map((x) => x.pane)
)

function rowStart(row: number): number {
  let n = 0
  for (let i = 0; i < row; i += 1) n += splitRows.value[i] ?? 0
  return n
}

function rowPanes(row: number): ParallelPane[] {
  const start = rowStart(row)
  return docPanes.value.slice(start, start + (splitRows.value[row] ?? 0))
}

function noteWidthStyle(): Record<string, string> {
  return { width: `${layout.value.noteRatio * 100}%` }
}

function rowStyle(row: number): Record<string, string | number> {
  return { flexGrow: rowRatios.value[row] ?? 1 }
}

function paneFlexStyle(row: number, col: number): Record<string, string> {
  if ((splitRows.value[row] ?? 0) !== 2) return { flex: '1 1 0' }
  if (col === 0) return { flex: `0 0 calc(${(colRatios.value[row] ?? 0.5) * 100}% - 3px)` }
  return { flex: '1 1 0' }
}


/** 浮动态层级：常驻窗最高（选中的常驻窗再高）> 选中普通窗 > 普通窗；
 *  仍低于 DocPicker(150)、顶栏(200) 与对话框 */
function floatZIndex(pane: ParallelPane): number {
  const all = floatPanes.value
  if (pane.pinned) {
    if (pane.id === activePaneId.value) return 120
    const i = all.filter((p) => p.pinned).findIndex((p) => p.id === pane.id)
    return 100 + Math.min(Math.max(i, 0), 15)
  }
  if (pane.id === activePaneId.value) return 60
  const i = all.filter((p) => !p.pinned).findIndex((p) => p.id === pane.id)
  return 1 + Math.min(Math.max(i, 0), 30)
}

function floatStyle(pane: ParallelPane): Record<string, string> {
  const z = { zIndex: String(floatZIndex(pane)) }
  if (maximizedPaneId.value === pane.id) {
    return { left: '0', top: '0', width: '100%', height: '100%', ...z }
  }
  const r = pane.rect
  return {
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
    ...z
  }
}

function paneTitle(pane: ParallelPane): string {
  if (pane.kind === 'note') return props.note?.title || '笔记'
  const detail = pane.docId ? details.get(pane.docId) : undefined
  if (detail) return detail.title
  return props.documents.find((d) => d.id === pane.docId)?.title ?? '未选择文档'
}

function paneNarrow(pane: ParallelPane): boolean {
  return pane.rect.w < 0.55
}

function isActive(pane: ParallelPane): boolean {
  return activePaneId.value === pane.id
}

function activatePane(paneId: string): void {
  activePaneId.value = paneId
  if (layout.value.mode === 'float') {
    layout.value = bringToFront(layout.value, paneId)
  }
}

// ---------- 文档详情 ----------

async function ensureDetail(docId: number): Promise<void> {
  if (details.has(docId) || loadingDocs.has(docId)) return
  loadingDocs.add(docId)
  paneErrors.delete(`doc:${docId}`)
  try {
    const detail = await window.lexbench.library.getDocument(docId)
    details.set(docId, detail)
  } catch (e) {
    paneErrors.set(`doc:${docId}`, e instanceof Error ? e.message : String(e ?? '文档打开失败'))
  } finally {
    loadingDocs.delete(docId)
  }
}

async function ensureAllDocs(l: ParallelLayout): Promise<void> {
  const ids = [...new Set(l.panes.filter((p) => p.kind === 'doc' && p.docId).map((p) => p.docId!))]
  await Promise.all(ids.map((id) => ensureDetail(id)))
}

function docError(pane: ParallelPane): string {
  if (!pane.docId) return ''
  return paneErrors.get(`doc:${pane.docId}`) ?? ''
}

function docDetail(pane: ParallelPane): DocumentDetail | null {
  return pane.docId ? details.get(pane.docId) ?? null : null
}

// ---------- 布局持久化 ----------

let saveTimer: ReturnType<typeof setTimeout> | undefined
let loadSeq = 0
let lastSaveErrorAt = 0
/** 存档被显式删除时置位：切空笔记的那一轮不要再把旧布局写回去 */
let suppressNextSave = false

function scheduleSave(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void saveNow(props.note?.id ?? null)
  }, 400)
}

async function saveNow(noteId: number | null, payload?: string): Promise<void> {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (!noteId) return
  try {
    // payload 由调用方在切换笔记的同步阶段抓快照，避免 await 之后把新笔记的布局写成旧笔记
    await window.lexbench.parallelViews.save(
      noteId,
      payload ?? serializeParallelLayout(layout.value),
      ''
    )
  } catch (e) {
    // 保存失败不刷屏：同一轮 2s 内只报一次
    const now = Date.now()
    if (now - lastSaveErrorAt > 2000) {
      lastSaveErrorAt = now
      emit('error', e)
    }
  }
}

async function loadForNote(noteId: number | null): Promise<void> {
  const seq = ++loadSeq
  maximizedPaneId.value = null
  if (!noteId) {
    layout.value = createDefaultLayout()
    activePaneId.value = null
    loading.value = false
    return
  }
  loading.value = true
  try {
    const row = await window.lexbench.parallelViews.get(noteId)
    if (seq !== loadSeq) return
    const next = row ? parseParallelLayout(row.layout) : createDefaultLayout()
    layout.value = next
    if (!row) {
      // 第一次打开：立即落一条默认存档，让它出现在左侧列表里
      try {
        await window.lexbench.parallelViews.save(noteId, serializeParallelLayout(next), '')
        emit('views-changed')
      } catch (e) {
        emit('error', e)
      }
    }
    await ensureAllDocs(next)
    if (seq !== loadSeq) return
    activePaneId.value = next.panes[0]?.id ?? null
  } catch (e) {
    if (seq === loadSeq) emit('error', e)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(
  () => props.note?.id ?? null,
  async (id, prev) => {
    // 同步抓旧布局快照，并立刻取消 400ms 防抖：否则它可能在下面的 await 期间
    // 用新笔记 id + 旧布局写库（A 的布局写进 B 的存档）
    const prevLayout = prev != null && prev !== id ? serializeParallelLayout(layout.value) : null
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (prev != null && prev !== id) {
      if (suppressNextSave) {
        // 存档已被用户删除：笔记照常留下，但不要把旧布局重新插入
        suppressNextSave = false
      } else {
        // 切走前先把旧笔记的编辑与布局落盘（watch 回调里 props 已是新值，必须显式传 prev）
        try {
          await noteEditor.value?.flush()
          await saveNow(prev, prevLayout ?? undefined)
        } catch {
          /* 单篇落盘失败不阻断切换 */
        }
      }
    }
    await loadForNote(id)
  },
  { immediate: true }
)

/** App 关窗 / 切 tab / 切笔记前调用；返回笔记是否保存成功 */
async function flush(): Promise<boolean> {
  let ok = true
  if (noteEditor.value) ok = await noteEditor.value.flush()
  if (saveTimer) await saveNow(props.note?.id ?? null)
  return ok
}

/** 重新从库里读布局（重置布局后用；先丢掉本地待写入的防抖） */
/** 让 App 重新取一次笔记快照：模式切换会重挂编辑器，不能用 App 手里的旧树 */
async function refreshNoteSnapshot(): Promise<void> {
  const id = props.note?.id
  if (!id) return
  try {
    const fresh = await window.lexbench.outlines.get(id)
    // 等 IPC 期间用户可能已切到别的笔记：过期快照不能把 App 拉回去
    if (props.note?.id !== id) return
    emit('note-refreshed', fresh)
  } catch {
    // 取不到就沿用当前快照；编辑器已有自己的保存链
  }
}

async function reloadLayout(): Promise<void> {
  const startId = props.note?.id ?? null
  clearTimeout(saveTimer)
  saveTimer = undefined
  suppressNextSave = false
  if (!(await flush())) {
    emit('error', '笔记保存失败，暂不重置布局')
    throw new Error('笔记保存失败，暂不重置布局')
  }
  if ((props.note?.id ?? null) !== startId) return
  await refreshNoteSnapshot()
  if ((props.note?.id ?? null) !== startId) return
  await loadForNote(startId)
}

/** 只取消待写入的布局防抖（重置布局用；不改变 suppressNextSave 语义） */
function cancelPendingSave(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
}

/** 存档被删除：取消待写入的防抖，并让下一轮“切空笔记”跳过一次保存 */
function discardCurrentLayout(): void {
  suppressNextSave = true
  clearTimeout(saveTimer)
  saveTimer = undefined
}

defineExpose({ flush, handleDrop, discardCurrentLayout, reloadLayout, cancelPendingSave })

// ---------- 增删文档窗 ----------

async function addDoc(docId: number): Promise<void> {
  if (!props.note) return
  try {
    layout.value = addDocPane(layout.value, docId)
    const pane = docPanes.value[docPanes.value.length - 1]
    if (pane) activePaneId.value = pane.id
    scheduleSave()
    await ensureDetail(docId)
  } catch (e) {
    emit('error', e)
  }
}

function closePane(paneId: string): void {
  try {
    layout.value = removePane(layout.value, paneId)
    if (activePaneId.value === paneId) activePaneId.value = notePane.value?.id ?? null
    if (maximizedPaneId.value === paneId) maximizedPaneId.value = null
    scheduleSave()
  } catch (e) {
    emit('error', e)
  }
}

async function replaceDoc(paneId: string, docId: number): Promise<void> {
  const pane = layout.value.panes.find((p) => p.id === paneId)
  if (!pane || pane.kind !== 'doc') return
  layout.value = {
    ...layout.value,
    panes: layout.value.panes.map((p) => (p.id === paneId ? { ...p, docId } : p))
  }
  scheduleSave()
  await ensureDetail(docId)
}

function openPicker(target: 'new' | string): void {
  picker.open = true
  picker.target = target
}

async function onPickDoc(docId: number): Promise<void> {
  const target = picker.target
  picker.open = false
  if (target === 'new') await addDoc(docId)
  else await replaceDoc(target, docId)
}

function reloadDoc(pane: ParallelPane): void {
  if (!pane.docId) return
  details.delete(pane.docId)
  void ensureDetail(pane.docId)
}

// ---------- 模式 / 重置 ----------

async function switchMode(mode: 'split' | 'float'): Promise<void> {
  if (layout.value.mode === mode) return
  const startId = props.note?.id ?? null
  // 两种模式的模板分支不同，编辑器会卸载重挂：先把笔记和布局都落盘、再刷新 App 快照
  if (!(await flush())) {
    emit('error', '笔记保存失败，暂不切换布局')
    return
  }
  if ((props.note?.id ?? null) !== startId) return
  await refreshNoteSnapshot()
  if ((props.note?.id ?? null) !== startId) return
  layout.value = setLayoutMode(layout.value, mode)
  maximizedPaneId.value = null
  scheduleSave()
}

function maximizePane(paneId: string): void {
  maximizedPaneId.value = maximizedPaneId.value === paneId ? null : paneId
}

/** 常驻置顶：不随选中态下沉，但当前选中窗仍然压过所有常驻窗 */
function togglePin(paneId: string): void {
  layout.value = {
    ...layout.value,
    panes: layout.value.panes.map((p) =>
      p.id === paneId ? { ...p, pinned: !p.pinned } : p
    )
  }
  scheduleSave()
}

function resetLayout(): void {
  const ids = docPanes.value.map((p) => p.docId!).filter((id) => Number.isInteger(id) && id > 0)
  let next = createDefaultLayout()
  for (const id of ids) next = addDocPane(next, id)
  layout.value = layout.value.mode === 'float' ? setLayoutMode(next, 'float') : next
  maximizedPaneId.value = null
  scheduleSave()
}

// ---------- 分隔条拖动 ----------

type DragKind = 'note' | 'row' | 'col' | 'move' | 'resize' | null
const drag = reactive({
  kind: null as DragKind,
  row: 0,
  paneId: '',
  startX: 0,
  startY: 0,
  startNoteRatio: DEFAULT_NOTE_RATIO,
  startRows: [] as number[],
  startCols: [] as number[],
  startRect: { x: 0, y: 0, w: 0, h: 0 } as PaneRect,
  resizeDir: '',
  boxW: 1,
  boxH: 1
})

function beginDrag(kind: DragKind, ev: PointerEvent): void {
  drag.kind = kind
  drag.startX = ev.clientX
  drag.startY = ev.clientY
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag, { once: true })
  window.addEventListener('pointercancel', endDrag, { once: true })
  document.body.style.userSelect = 'none'
  if (kind !== 'move' && kind !== 'resize') ev.preventDefault()
}

function startNoteSplit(ev: PointerEvent): void {
  if (!splitEl.value) return
  drag.startNoteRatio = layout.value.noteRatio
  drag.boxW = splitEl.value.clientWidth || 1
  beginDrag('note', ev)
}

function startRowSplit(row: number, ev: PointerEvent): void {
  if (!docAreaEl.value) return
  drag.row = row
  drag.startRows = [...rowRatios.value]
  drag.boxH = docAreaEl.value.clientHeight || 1
  beginDrag('row', ev)
}

function startColSplit(row: number, ev: PointerEvent): void {
  if (!docAreaEl.value) return
  drag.row = row
  drag.startCols = [...colRatios.value]
  drag.boxW = docAreaEl.value.clientWidth || 1
  beginDrag('col', ev)
}

function startPaneMove(pane: ParallelPane, ev: PointerEvent): void {
  if (layout.value.mode !== 'float' || maximizedPaneId.value) return
  if ((ev.target as HTMLElement | null)?.closest('button')) return
  activatePane(pane.id)
  drag.paneId = pane.id
  drag.startRect = { ...pane.rect }
  // 不能依赖 ev.currentTarget：组件 emit 到父级时它可能已被浏览器置空
  drag.boxW = floatEl.value?.clientWidth || 1
  drag.boxH = floatEl.value?.clientHeight || 1
  beginDrag('move', ev)
}

function startPaneResize(pane: ParallelPane, ev: PointerEvent, dir = 'se'): void {
  if (layout.value.mode !== 'float' || maximizedPaneId.value) return
  activatePane(pane.id)
  drag.paneId = pane.id
  drag.resizeDir = dir
  drag.startRect = { ...pane.rect }
  drag.boxW = floatEl.value?.clientWidth || 1
  drag.boxH = floatEl.value?.clientHeight || 1
  beginDrag('resize', ev)
}

function snapValue(value: number, candidates: number[], threshold: number): number {
  let best = value
  let bestDist = threshold
  for (const c of candidates) {
    const d = Math.abs(c - value)
    if (d < bestDist) {
      best = c
      bestDist = d
    }
  }
  return best
}

function onDragMove(ev: PointerEvent): void {
  if (!drag.kind) return
  const dx = ev.clientX - drag.startX
  const dy = ev.clientY - drag.startY

  if (drag.kind === 'note') {
    const ratio = drag.startNoteRatio + dx / drag.boxW
    const noteRatio = Math.min(MAX_NOTE_RATIO, Math.max(MIN_NOTE_RATIO, ratio))
    layout.value = deriveSplitRects({ ...layout.value, noteRatio })
    return
  }

  if (drag.kind === 'row') {
    const idx = drag.row
    const total = (drag.startRows[idx] ?? 0) + (drag.startRows[idx + 1] ?? 0)
    if (total <= 0) return
    const delta = dy / drag.boxH
    const min = Math.min(0.12, total / 3)
    const a = Math.min(total - min, Math.max(min, (drag.startRows[idx] ?? 0) + delta))
    const nextRows = [...drag.startRows]
    nextRows[idx] = a
    nextRows[idx + 1] = total - a
    layout.value = deriveSplitRects({ ...layout.value, rowRatios: nextRows })
    return
  }

  if (drag.kind === 'col') {
    const idx = drag.row
    const ratio = (drag.startCols[idx] ?? 0.5) + dx / drag.boxW
    const nextCols = [...drag.startCols]
    nextCols[idx] = Math.min(0.82, Math.max(0.18, ratio))
    layout.value = deriveSplitRects({ ...layout.value, colRatios: nextCols })
    return
  }

  if (drag.kind === 'move') {
    const pane = layout.value.panes.find((p) => p.id === drag.paneId)
    if (!pane) return
    const w = drag.startRect.w
    const h = drag.startRect.h
    const rawX = drag.startRect.x + dx / drag.boxW
    const rawY = drag.startRect.y + dy / drag.boxH
    const xEdges = [0, 1 - w]
    const yEdges = [0, 1 - h]
    for (const other of layout.value.panes) {
      if (other.id === drag.paneId) continue
      xEdges.push(other.rect.x, other.rect.x + other.rect.w, other.rect.x - w)
      yEdges.push(other.rect.y, other.rect.y + other.rect.h, other.rect.y - h)
    }
    const x = Math.min(1 - w, Math.max(0, snapValue(rawX, xEdges, 8 / drag.boxW)))
    const y = Math.min(1 - h, Math.max(0, snapValue(rawY, yEdges, 8 / drag.boxH)))
    layout.value = {
      ...layout.value,
      panes: layout.value.panes.map((p) =>
        p.id === drag.paneId ? { ...p, rect: { ...p.rect, x, y } } : p
      )
    }
    return
  }

  if (drag.kind === 'resize') {
    const pane = layout.value.panes.find((p) => p.id === drag.paneId)
    if (!pane) return
    const s = drag.startRect
    const dir = drag.resizeDir
    const minW = 240 / drag.boxW
    const minH = 160 / drag.boxH
    const dxn = dx / drag.boxW
    const dyn = dy / drag.boxH
    let x = s.x
    let y = s.y
    let w = s.w
    let h = s.h
    if (dir.includes('e')) w = Math.min(1 - s.x, Math.max(minW, s.w + dxn))
    if (dir.includes('s')) h = Math.min(1 - s.y, Math.max(minH, s.h + dyn))
    if (dir.includes('w')) {
      const nx = Math.min(s.x + s.w - minW, Math.max(0, s.x + dxn))
      w = s.x + s.w - nx
      x = nx
    }
    if (dir.includes('n')) {
      const ny = Math.min(s.y + s.h - minH, Math.max(0, s.y + dyn))
      h = s.y + s.h - ny
      y = ny
    }
    // 贴住画布右/下边缘时吸附，避免差一两像素
    if (dir.includes('e') && Math.abs(1 - (x + w)) < 8 / drag.boxW) w = 1 - x
    if (dir.includes('s') && Math.abs(1 - (y + h)) < 8 / drag.boxH) h = 1 - y
    layout.value = {
      ...layout.value,
      panes: layout.value.panes.map((p) =>
        p.id === drag.paneId ? { ...p, rect: { x, y, w, h } } : p
      )
    }
  }
}

function endDrag(): void {
  window.removeEventListener('pointermove', onDragMove)
  document.body.style.userSelect = ''
  const kind = drag.kind
  drag.kind = null
  if (kind) scheduleSave()
}

// ---------- 拖放 ----------

function hasDropPayload(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return (
    dt.types.includes('Files') ||
    dt.types.includes('application/x-lexbench-doc') ||
    dt.types.includes('text/plain')
  )
}

function onZoneDragOver(e: DragEvent): void {
  if (!hasDropPayload(e.dataTransfer)) return
  e.preventDefault()
  dropActive.value = true
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function onZoneDragLeave(e: DragEvent): void {
  const next = e.relatedTarget as Node | null
  if (next && (e.currentTarget as HTMLElement).contains(next)) return
  dropActive.value = false
}

/** App.onDrop 在检测到 [data-parallel-drop] 后调用 */
async function handleDrop(dt: DataTransfer | null): Promise<boolean> {
  dropActive.value = false
  if (!dt) return false
  const internal = dt.getData('application/x-lexbench-doc')
  if (internal) {
    const id = Number(internal)
    if (Number.isInteger(id) && id > 0) await addDoc(id)
    return true
  }
  const files = Array.from(dt.files ?? []).filter((f) => /\.(docx|doc|pdf|txt)$/i.test(f.name))
  if (!files.length) return false
  const paths = files
    .map((f) => window.lexbench.dialog.getPathForFile(f))
    .filter((p): p is string => !!p)
  if (!paths.length) {
    emit('error', '无法读取拖入文件的本地路径，请改用「导入文档」按钮')
    return true
  }
  try {
    const rows = await window.lexbench.library.importDocuments(paths, '', 'auto')
    emit('docs-changed')
    let added = 0
    for (const row of rows) {
      if (row.status === 'failed') {
        emit('error', `${row.title}：${row.message || '导入失败'}`)
        continue
      }
      if (row.document_id) {
        await addDoc(row.document_id)
        added += 1
      }
    }
    if (added) emit('notice', `已导入并打开 ${added} 篇文档`)
  } catch (e) {
    emit('error', e)
  }
  return true
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onDragMove)
  document.body.style.userSelect = ''
  clearTimeout(saveTimer)
  void saveNow(props.note?.id ?? null)
})
</script>

<template>
  <div class="ws" data-workspace-root :data-mode="layout.mode">
    <div class="ws-bar">
      <div class="ws-mode" role="group" aria-label="布局模式">
        <button :class="{ on: layout.mode === 'split' }" @click="switchMode('split')">分屏</button>
        <button :class="{ on: layout.mode === 'float' }" @click="switchMode('float')">浮动</button>
      </div>
      <button class="ws-btn" :disabled="!note" @click="openPicker('new')">＋ 文档</button>
      <span class="ws-tip" v-if="note">
        {{ layout.mode === 'split' ? '拖动分隔条调整大小' : '拖窗头移动、拖边角缩放' }}
      </span>
      <span class="ws-spacer"></span>
      <button v-if="note" class="ws-btn" @click="resetLayout">重置布局</button>
      <button
        class="ws-btn"
        :class="{ on: railHidden }"
        :title="railHidden ? '恢复左侧导航' : '隐藏左侧导航，平行视图占满窗口'"
        @click="emit('toggle-rail')"
      >
        {{ railHidden ? '⇤ 恢复' : '⛶ 全区' }}
      </button>
    </div>

    <div v-if="!note" class="ws-empty">
      <p class="ws-empty-title">平行视图</p>
      <p class="ws-empty-line">从左侧「笔记」打开或新建一篇笔记，再来这里边读文档边记笔记。</p>
    </div>

    <div v-else-if="loading" class="ws-empty">
      <p class="ws-empty-line">正在载入平行视图…</p>
    </div>

    <template v-else>
      <!-- 分屏：笔记在左，文档区按网格铺在右侧；分隔条可拖 -->
      <div v-if="layout.mode === 'split'" ref="splitEl" class="ws-split">
        <ParallelPaneFrame
          v-if="notePane"
          class="ws-note"
          :style="noteWidthStyle()"
          :pane="notePane"
          :title="paneTitle(notePane)"
          :active="isActive(notePane)"
          :show-header="false"
          @activate="activatePane(notePane.id)"
        >
          <OutlineEditor
            :ref="setNoteEditor"
            :key="`${note.id}:${noteRev}`"
            :outline="note"
            :embedded="true"
            :narrow="notePane.rect.w < 0.5"
            :pane-active="isActive(notePane)"
            @error="emit('error', $event)"
            @notice="emit('notice', $event)"
            @list-changed="emit('views-changed')"
          />
        </ParallelPaneFrame>

        <div
          v-if="notePane"
          class="ws-vsplit"
          role="separator"
          aria-orientation="vertical"
          title="拖动调整笔记窗宽度"
          @pointerdown="startNoteSplit"
        ></div>

        <div
          ref="docAreaEl"
          class="ws-doc-area"
          :class="{ 'drop-on': dropActive }"
          data-parallel-drop
          @dragenter="onZoneDragOver"
          @dragover="onZoneDragOver"
          @dragleave="onZoneDragLeave"
        >
          <div v-if="docPanes.length === 0" class="ws-doc-empty" @click="openPicker('new')">
            <p>＋ 从文档库选择，或把文件拖到这里</p>
            <p class="ws-doc-empty-sub">拖入的文件会先加入文档库，再在这里打开</p>
          </div>

          <template v-for="(row, ri) in splitRows" :key="`row-${ri}`">
            <div
              v-if="ri > 0"
              class="ws-hsplit"
              role="separator"
              aria-orientation="horizontal"
              title="拖动调整行高"
              @pointerdown="startRowSplit(ri - 1, $event)"
            ></div>
            <div class="ws-doc-row" :style="rowStyle(ri)">
              <template v-for="(pane, ci) in rowPanes(ri)" :key="pane.id">
                <div
                  v-if="ci > 0"
                  class="ws-csplit"
                  role="separator"
                  aria-orientation="vertical"
                  title="拖动调整列宽"
                  @pointerdown="startColSplit(ri, $event)"
                ></div>
                <ParallelPaneFrame
                  :pane="pane"
                  :title="paneTitle(pane)"
                  :style="paneFlexStyle(ri, ci)"
                  :active="isActive(pane)"
                  closable
                  allow-source
                  @activate="activatePane(pane.id)"
                  @close="closePane(pane.id)"
                  @pick-source="openPicker(pane.id)"
                >
                  <ParallelDocPane
                    :pane="pane"
                    :detail="docDetail(pane)"
                    :error="docError(pane)"
                    :loading="!!pane.docId && loadingDocs.has(pane.docId) && !docDetail(pane)"
                    :narrow="paneNarrow(pane)"
                    :active="isActive(pane)"
                    :persist="isActive(pane)"
                    @close="closePane(pane.id)"
                    @error="emit('error', $event)"
                    @notice="emit('notice', $event)"
                    @doc-changed="reloadDoc(pane)"
                    @toggle-rail="maximizePane(pane.id)"
                  />
                </ParallelPaneFrame>
              </template>
            </div>
          </template>
        </div>
      </div>

      <!-- 浮动：窗口可拖动/缩放/置顶；DOM 顺序决定叠放，避免 z-index 困住窗内浮层 -->
      <div
        v-else
        ref="floatEl"
        class="ws-float"
        :class="{ 'drop-on': dropActive }"
        data-parallel-drop
        @dragenter="onZoneDragOver"
        @dragover="onZoneDragOver"
        @dragleave="onZoneDragLeave"
      >
        <ParallelPaneFrame
          v-for="pane in floatPanes"
          :key="pane.id"
          v-show="!maximizedPaneId || maximizedPaneId === pane.id"
          :style="floatStyle(pane)"
          :pane="pane"
          :title="paneTitle(pane)"
          :active="isActive(pane)"
          :floating="true"
          :maximized="maximizedPaneId === pane.id"
          :pinned="!!pane.pinned"
          :closable="pane.kind === 'doc'"
          :allow-source="pane.kind === 'doc'"
          @activate="activatePane(pane.id)"
          @move-start="startPaneMove(pane, $event)"
          @resize-start="(ev, dir) => startPaneResize(pane, ev, dir)"
          @close="closePane(pane.id)"
          @maximize="maximizePane(pane.id)"
          @pick-source="openPicker(pane.id)"
          @toggle-pin="togglePin(pane.id)"
        >
          <OutlineEditor
            v-if="pane.kind === 'note'"
            :ref="setNoteEditor"
            :key="`${note.id}:${noteRev}`"
            :outline="note"
            :embedded="true"
            :narrow="pane.rect.w < 0.5"
            :pane-active="isActive(pane)"
            @error="emit('error', $event)"
            @notice="emit('notice', $event)"
            @list-changed="emit('views-changed')"
          />
          <ParallelDocPane
            v-else
            :pane="pane"
            :detail="docDetail(pane)"
            :error="docError(pane)"
            :loading="!!pane.docId && loadingDocs.has(pane.docId) && !docDetail(pane)"
            :narrow="paneNarrow(pane)"
            :active="isActive(pane)"
            :persist="isActive(pane)"
            @close="closePane(pane.id)"
            @error="emit('error', $event)"
            @notice="emit('notice', $event)"
            @doc-changed="reloadDoc(pane)"
            @toggle-rail="maximizePane(pane.id)"
          />
        </ParallelPaneFrame>

        <div v-if="docPanes.length === 0" class="ws-doc-empty float-empty">
          <p>＋ 从文档库选择，或把文件拖到这里</p>
          <p class="ws-doc-empty-sub">拖入的文件会先加入文档库，再在这里打开</p>
        </div>
      </div>
    </template>

    <DocPicker
      :visible="picker.open"
      :documents="documents"
      :title="picker.target === 'new' ? '添加文档窗口' : '更换文档'"
      @close="picker.open = false"
      @select="onPickDoc"
    />
  </div>
</template>

<style scoped>
.ws {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--lb-bg);
}

.ws-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 10px;
  flex-shrink: 0;
  background: var(--lb-chrome);
  border-bottom: 1px solid var(--lb-border);
}

.ws-mode {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--lb-radius-xs);
  background: var(--lb-chip);
}

.ws-mode button {
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--lb-muted);
  font-size: 12px;
}

.ws-mode button.on {
  background: var(--lb-panel);
  color: var(--lb-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.ws-btn {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}

.ws-btn:hover:not(:disabled) {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.ws-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.ws-btn.on {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.ws-tip {
  font-size: 11px;
  color: var(--lb-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ws-spacer {
  flex: 1;
}

.ws-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
}

.ws-empty-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--lb-text);
}

.ws-empty-line {
  margin-top: 8px;
  font-size: 13px;
  color: var(--lb-muted);
  line-height: 1.8;
}

/* ---------- 分屏 ---------- */
.ws-split {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0;
  padding: 6px;
}

.ws-note {
  flex: 0 0 auto;
  min-width: 220px;
  height: 100%;
}

.ws-vsplit {
  width: 8px;
  flex: 0 0 8px;
  cursor: col-resize;
  position: relative;
}

.ws-vsplit::after,
.ws-csplit::after,
.ws-hsplit::after {
  content: '';
  position: absolute;
  background: var(--lb-border);
  border-radius: 1px;
}

.ws-vsplit::after {
  top: 8px;
  bottom: 8px;
  left: 3.5px;
  width: 1px;
}

.ws-doc-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border-radius: var(--lb-radius-l);
}

.ws-doc-area.drop-on,
.ws-float.drop-on {
  outline: 2px dashed var(--lb-accent-2);
  outline-offset: -4px;
}

.ws-doc-row {
  display: flex;
  flex-basis: 0;
  min-height: 210px;
  flex-shrink: 0;
  gap: 0;
  padding: 2px 0;
}

.ws-hsplit {
  flex: 0 0 8px;
  min-height: 8px;
  cursor: row-resize;
  position: relative;
}

.ws-hsplit::after {
  left: 8px;
  right: 8px;
  top: 3.5px;
  height: 1px;
}

.ws-csplit {
  width: 8px;
  flex: 0 0 8px;
  cursor: col-resize;
  position: relative;
}

.ws-csplit::after {
  top: 8px;
  bottom: 8px;
  left: 3.5px;
  width: 1px;
}

.ws-doc-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px dashed var(--lb-border-strong);
  border-radius: var(--lb-radius-l);
  color: var(--lb-muted);
  font-size: 13px;
  cursor: pointer;
}

.ws-doc-empty-sub {
  font-size: 11px;
}

/* ---------- 浮动 ---------- */
.ws-float {
  flex: 1;
  min-height: 0;
  position: relative;
  margin: 6px;
  border-radius: var(--lb-radius-l);
  overflow: hidden;
  background: var(--lb-elevated, transparent);
}

.ws-float.drop-on {
  outline-offset: -6px;
}

.float-empty {
  position: absolute;
  inset: 12px;
  z-index: 0;
}

/* ---------- 窄屏适配 ---------- */
@media (max-width: 720px) {
  .ws-tip {
    display: none;
  }
}
</style>
