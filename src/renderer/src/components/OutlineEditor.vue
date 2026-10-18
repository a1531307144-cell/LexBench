<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import OutlineTextEditor from './OutlineTextEditor.vue'
import MindMapView from './MindMapView.vue'
import { shortLawName } from '@shared/lawName'
import {
  cloneSubtree,
  collapseAll as collapseAllTree,
  collapseByLevel,
  createOutlineNode,
  expandAll as expandAllTree,
  expandAncestors,
  findNode,
  flattenOutline,
  indentNode,
  insertAfter,
  insertBefore,
  insertChild,
  mergeOutlineNode,
  moveNodeDown,
  moveNodeUp,
  moveNodesRelative,
  newOutlineId,
  nodeImages,
  nodePath,
  normalizeOutlineTree,
  outdentNode,
  rangeNodeIds,
  removeNode,
  splitOutlineNode,
  visibleNodeIds
} from '@shared/outlineTree'
import { escapeHtml, hasInlineFormatting, htmlFromPlainText } from '@shared/outlineRichText'
import type { ExportFormat, OutlineNode, OutlineRef, OutlineRow, SearchHit } from '@shared/types'

/**
 * 大纲编辑器（笔记主视图）。
 * 交互骨架对齐主流大纲工具：圆点 = 结构选择/拖拽把手；缩进导轨；行悬停操作；
 * Enter 同级 / Tab 缩进 / Shift+Tab 反缩进 / 行首 Backspace 并上行；多选与整块拖动；
 * 富文本（B/I/U/S、高亮、颜色）走选区浮动工具栏 + 快捷键；任务、标题、备注、贴图；
 * 数据仍是一棵 OutlineNode 树，500ms 防抖整树落库，卸载强制冲刷。
 */
const props = defineProps<{ outline: OutlineRow }>()
const emit = defineEmits<{
  (e: 'error', err: unknown): void
  (e: 'list-changed'): void
  (e: 'open-source', ref: OutlineRef): void
  (e: 'delete-request'): void
  (e: 'notice', text: string): void
}>()

const INDENT = 28

// ---------- 树 ----------

function parseTree(raw: string): OutlineNode[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return normalizeOutlineTree(parsed)
  } catch {
    return []
  }
}

const tree = ref<OutlineNode[]>(parseTree(props.outline.tree))
if (tree.value.length === 0) tree.value = [createOutlineNode('')]
const title = ref(props.outline.title)
const displayTitle = computed(() => title.value.trim() || '未命名笔记')
const viewMode = ref<'outline' | 'map'>(props.outline.view_mode === 'map' ? 'map' : 'outline')
/** 外部改内容（撤销/合并/自动格式）后让所有行重设 DOM；打字本身不 bump，避免光标跳 */
const renderEpoch = ref(0)
function bumpRender(): void {
  renderEpoch.value += 1
}

// ---------- 钻取（Ctrl+[ 退出；菜单「进入」） ----------

const drilledId = ref<string | null>(null)
const drilledNode = computed(() => (drilledId.value ? findNode(tree.value, drilledId.value)?.node ?? null : null))
const rootNodes = computed(() => (drilledNode.value ? drilledNode.value.children : tree.value))
const breadcrumb = computed(() => (drilledId.value ? nodePath(tree.value, drilledId.value) ?? [] : []))
const rows = computed(() => flattenOutline(rootNodes.value, 0, true))

watch(drilledId, () => {
  if (drilledId.value && !findNode(tree.value, drilledId.value)) drilledId.value = null
})

function drillInto(row: { node: OutlineNode }): void {
  if (!(row.node.children ?? []).length) return
  drilledId.value = row.node.id
  clearSelection()
  scrollToTop()
}

function drillUp(): void {
  if (!drilledId.value) return
  const path = nodePath(tree.value, drilledId.value)
  const parent = path && path.length > 1 ? path[path.length - 2] : null
  drilledId.value = parent ? parent.id : null
  clearSelection()
  scrollToTop()
}

const scrollEl = ref<HTMLElement | null>(null)
function scrollToTop(): void {
  nextTick(() => scrollEl.value?.scrollTo({ top: 0 }))
}

// ---------- 选择（结构多选） ----------

const selected = reactive(new Set<string>())
const focusedId = ref<string | null>(null)
const anchorId = ref<string | null>(null)

function selectSingle(id: string): void {
  selected.clear()
  selected.add(id)
  anchorId.value = id
  focusedId.value = id
}

function toggleSelected(id: string): void {
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
  anchorId.value = id
  focusedId.value = id
}

function selectRangeTo(id: string): void {
  const from = anchorId.value
  if (!from) {
    selectSingle(id)
    return
  }
  const ids = rangeNodeIds(rootNodes.value, from, id)
  if (!ids.length) {
    selectSingle(id)
    return
  }
  selected.clear()
  for (const x of ids) selected.add(x)
  focusedId.value = id
}

function clearSelection(): void {
  selected.clear()
  anchorId.value = null
}

function selectAllRows(): void {
  const ids = visibleNodeIds(rootNodes.value)
  selected.clear()
  for (const id of ids) selected.add(id)
  anchorId.value = ids[0] ?? null
  focusedId.value = ids[ids.length - 1] ?? null
  hideToolbar()
}

/** 当前多选按树顺序排好（拖拽/复制用） */
function selectedOrdered(): string[] {
  if (selected.size === 0) return []
  return flattenOutline(tree.value, 0, false)
    .filter((r) => selected.has(r.node.id))
    .map((r) => r.node.id)
}

function rowFor(id: string): ReturnType<typeof flattenOutline>[number] | undefined {
  return rows.value.find((r) => r.node.id === id)
}

function nodeFor(id: string): OutlineNode | null {
  return findNode(tree.value, id)?.node ?? null
}

// ---------- 文本编辑器实例登记 / 焦点 ----------

interface TextEditorApi {
  el: HTMLElement | null
  content(): { text: string; html: string }
  isEmpty(): boolean
  caretOffset(): number
  focusOffset(offset: number | 'end' | 'start'): void
  splitAtCaret(): { beforeText: string; afterText: string; beforeHtml: string; afterHtml: string } | null
  insertHtml(html: string): void
  selectAll(): void
  hasTextSelection(): boolean
  selectionRect(): DOMRect | null
  format(command: string, value?: string): void
}

const textRefs = new Map<string, TextEditorApi>()

function setTextRef(id: string, el: unknown): void {
  if (el) textRefs.set(id, el as TextEditorApi)
  else textRefs.delete(id)
}

function editorFor(id: string | null): TextEditorApi | null {
  return id ? textRefs.get(id) ?? null : null
}

function focusNode(id: string, offset: number | 'end' | 'start' = 'end', structural = false): void {
  const hit = findNode(tree.value, id)
  if (!hit) return
  expandAncestors(tree.value, id)
  selected.clear()
  // 打字光标不点亮整行（与主流大纲工具一致）；结构操作后可以显式选中
  if (structural) selected.add(id)
  anchorId.value = id
  focusedId.value = id
  nextTick(() => {
    editorFor(id)?.focusOffset(offset)
    document
      .querySelector(`.ol-row[data-row-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

// ---------- 保存（500ms 防抖整树落库） ----------

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
    await window.lexbench.outlines.save(
      props.outline.id,
      JSON.stringify(tree.value),
      sendTitle ? title.value : undefined
    )
    if (sendTitle) emit('list-changed')
  } catch (e) {
    dirty = true
    emit('error', e)
  }
}

// ---------- 撤销 / 重做（整树快照；文字输入每 700ms 汇总一次） ----------

const history = ref<string[]>([])
let historyIndex = 0
let historyTimer: ReturnType<typeof setTimeout> | undefined

function snapshot(): string {
  return JSON.stringify(tree.value)
}

function resetHistory(): void {
  history.value = [snapshot()]
  historyIndex = 0
}

function pushHistory(): void {
  clearTimeout(historyTimer)
  const s = snapshot()
  if (history.value[historyIndex] === s) return
  history.value = [...history.value.slice(0, historyIndex + 1), s].slice(-100)
  historyIndex = history.value.length - 1
}

function scheduleHistory(): void {
  clearTimeout(historyTimer)
  historyTimer = setTimeout(pushHistory, 700)
}

/** 结构操作前：把尚未汇总的输入快照落进历史 */
function beforeStructure(): void {
  clearTimeout(historyTimer)
  if (history.value[historyIndex] !== snapshot()) pushHistory()
}

function applySnapshot(s: string): void {
  try {
    tree.value = normalizeOutlineTree(JSON.parse(s))
  } catch {
    return
  }
  hideToolbar()
  selected.clear()
  bumpRender()
  scheduleSave()
  nextTick(() => {
    const id = focusedId.value && findNode(tree.value, focusedId.value) ? focusedId.value : rows.value[0]?.node.id
    if (id) {
      focusedId.value = id
      selected.clear()
      selected.add(id)
      anchorId.value = id
      editorFor(id)?.focusOffset('end')
    }
  })
}

function undo(): void {
  clearTimeout(historyTimer)
  if (historyIndex <= 0) return
  historyIndex -= 1
  applySnapshot(history.value[historyIndex] ?? '[]')
}

function redo(): void {
  clearTimeout(historyTimer)
  if (historyIndex >= history.value.length - 1) return
  historyIndex += 1
  applySnapshot(history.value[historyIndex] ?? '[]')
}

// ---------- 内容变更 ----------

function maybeMarkdown(node: OutlineNode): void {
  const text = node.text
  let m = /^(#{1,3})\s+/.exec(text)
  if (m) {
    node.heading = m[1]!.length as 1 | 2 | 3
    node.text = text.slice(m[0].length)
    delete node.html
    bumpRender()
    scheduleSave()
    nextTick(() => editorFor(node.id)?.focusOffset(0))
    return
  }
  m = /^\[( |x|X)?\]\s+/.exec(text)
  if (m) {
    node.task = m[1]?.toLowerCase() === 'x' ? 2 : 1
    node.text = text.slice(m[0].length)
    delete node.html
    bumpRender()
    scheduleSave()
    nextTick(() => editorFor(node.id)?.focusOffset(0))
  }
}

function syncNodeFromEditor(id: string): void {
  const ed = editorFor(id)
  const node = nodeFor(id)
  if (!ed || !node) return
  const c = ed.content()
  node.text = c.text
  if (hasInlineFormatting(c.html, c.text)) node.html = c.html
  else delete node.html
  scheduleSave()
  scheduleHistory()
}

function onNodeChange(node: OutlineNode, payload: { text: string; html: string }): void {
  node.text = payload.text
  if (hasInlineFormatting(payload.html, payload.text)) node.html = payload.html
  else delete node.html
  scheduleSave()
  scheduleHistory()
  maybeMarkdown(node)
}

// ---------- 结构操作 ----------

function addChild(row: { node: OutlineNode }, index?: number): void {
  beforeStructure()
  const created = createOutlineNode('')
  insertChild(tree.value, row.node.id, created, index)
  pushHistory()
  scheduleSave()
  focusNode(created.id, 'end', true)
}

function addSibling(row: { node: OutlineNode }, before = false): void {
  beforeStructure()
  const created = createOutlineNode('')
  if (before) insertBefore(tree.value, row.node.id, created)
  else insertAfter(tree.value, row.node.id, created)
  pushHistory()
  scheduleSave()
  focusNode(created.id, 'end', true)
}

function appendRow(): void {
  beforeStructure()
  const created = createOutlineNode('')
  rootNodes.value.push(created)
  pushHistory()
  scheduleSave()
  focusNode(created.id, 'end', true)
}

function handleEnter(row: { node: OutlineNode; hasChildren: boolean }, editor: TextEditorApi): void {
  const node = row.node
  if (row.hasChildren && !node.fold) {
    // 有展开的子级：回车落到首个子节点（与主流大纲工具一致）
    addChild({ node }, 0)
    return
  }
  const parts = editor.splitAtCaret()
  if (!parts) {
    addSibling({ node })
    return
  }
  beforeStructure()
  const created = splitOutlineNode(tree.value, node.id, parts)
  pushHistory()
  scheduleSave()
  if (created) focusNode(created.id, 0, true)
  else focusNode(node.id, 'end', true)
}

function handleTab(row: { node: OutlineNode }, editor: TextEditorApi, outdent: boolean): void {
  const offset = editor.caretOffset()
  beforeStructure()
  const ok = outdent ? outdentNode(tree.value, row.node.id) : indentNode(tree.value, row.node.id)
  if (!ok) return
  pushHistory()
  scheduleSave()
  focusNode(row.node.id, offset, true)
}

function handleBackspace(row: { node: OutlineNode; parent: OutlineNode | null }, editor: TextEditorApi): void {
  if (selected.size > 1) {
    deleteSelected()
    return
  }
  const node = row.node
  // 空行先反缩进一级，再并上一行
  if (!node.text.trim() && row.parent) {
    beforeStructure()
    if (outdentNode(tree.value, node.id)) {
      pushHistory()
      scheduleSave()
      focusNode(node.id, 0)
    }
    return
  }
  beforeStructure()
  const merged = mergeOutlineNode(tree.value, node.id)
  if (!merged) return
  if (node.ref && !merged.node.ref) merged.node.ref = node.ref
  pushHistory()
  bumpRender()
  scheduleSave()
  focusNode(merged.node.id, merged.offset)
}

function toggleFold(row: { node: OutlineNode; hasChildren: boolean }): void {
  if (!row.hasChildren) return
  beforeStructure()
  row.node.fold = !row.node.fold
  pushHistory()
  scheduleSave()
}

function deleteSelected(): void {
  if (selected.size === 0) return
  const ids = selectedOrdered()
  if (!ids.length) return
  // 删除后把焦点落到第一处被删位置的前一行（没有则后一行）
  const flat = flattenOutline(rootNodes.value, 0, true)
  const firstIdx = flat.findIndex((r) => selected.has(r.node.id))
  const fallback = flat[firstIdx - 1]?.node.id ?? flat.find((r) => !selected.has(r.node.id))?.node.id ?? null
  beforeStructure()
  const locs = flattenOutline(tree.value, 0, false)
    .filter((r) => selected.has(r.node.id))
    .sort((a, b) => b.depth - a.depth)
  for (const loc of locs) removeNode(tree.value, loc.node.id)
  selected.clear()
  anchorId.value = null
  pushHistory()
  scheduleSave()
  if (rootNodes.value.length === 0) rootNodes.value.push(createOutlineNode(''))
  bumpRender()
  const nextId = fallback && findNode(tree.value, fallback) ? fallback : rows.value[0]?.node.id
  if (nextId) focusNode(nextId, 'end', true)
}

function moveUp(row: { node: OutlineNode }, editor: TextEditorApi): void {
  const offset = editor.caretOffset()
  beforeStructure()
  if (!moveNodeUp(tree.value, row.node.id)) return
  pushHistory()
  scheduleSave()
  focusNode(row.node.id, Math.min(offset, row.node.text.length), true)
}

function moveDown(row: { node: OutlineNode }, editor: TextEditorApi): void {
  const offset = editor.caretOffset()
  beforeStructure()
  if (!moveNodeDown(tree.value, row.node.id)) return
  pushHistory()
  scheduleSave()
  focusNode(row.node.id, Math.min(offset, row.node.text.length), true)
}

function targetIds(): string[] {
  if (selected.size > 0) return selectedOrdered()
  return focusedId.value && findNode(tree.value, focusedId.value) ? [focusedId.value] : []
}

function duplicateSelected(): void {
  const ids = targetIds()
  if (!ids.length) return
  const idSet = new Set(ids)
  beforeStructure()
  const roots = flattenOutline(tree.value, 0, false).filter(
    (r) => idSet.has(r.node.id) && (!r.parent || !idSet.has(r.parent.id))
  )
  const createdIds: string[] = []
  // 从后往前插，避免下标漂移
  for (const loc of [...roots].reverse()) {
    const copy = cloneSubtree(loc.node, newOutlineId)
    const hit = findNode(tree.value, loc.node.id)
    if (hit) {
      hit.siblings.splice(hit.index + 1, 0, copy)
      createdIds.unshift(copy.id)
    }
  }
  pushHistory()
  scheduleSave()
  if (createdIds.length) focusNode(createdIds[0]!, 'end', true)
}

function setHeading(row: { node: OutlineNode }, level: 0 | 1 | 2 | 3): void {
  beforeStructure()
  if (level === 0) delete row.node.heading
  else row.node.heading = level
  pushHistory()
  scheduleSave()
}

function setTask(row: { node: OutlineNode }, value: 0 | 1 | 2): void {
  beforeStructure()
  if (value === 0) delete row.node.task
  else row.node.task = value
  pushHistory()
  scheduleSave()
}

function toggleTaskDone(row: { node: OutlineNode }): void {
  setTask(row, row.node.task === 2 ? 1 : 2)
}

// ---------- 复制 / 剪切 / 粘贴节点 ----------

const nodeClipboard = ref<OutlineNode[]>([])

function copySelected(): boolean {
  const ids = targetIds()
  if (!ids.length) return false
  const idSet = new Set(ids)
  const roots = flattenOutline(tree.value, 0, false).filter(
    (r) => idSet.has(r.node.id) && (!r.parent || !idSet.has(r.parent.id))
  )
  if (!roots.length) return false
  nodeClipboard.value = roots.map((r) => cloneSubtree(r.node))
  const text = roots
    .map((r) => flattenOutline([r.node], 0, false).map((x) => `${'  '.repeat(x.depth)}${x.node.text}`).join('\n'))
    .join('\n')
  void navigator.clipboard?.writeText(text).catch(() => undefined)
  return true
}

function cutSelected(): boolean {
  if (!copySelected()) return false
  if (selected.size === 0 && focusedId.value) {
    selected.add(focusedId.value)
    anchorId.value = focusedId.value
  }
  deleteSelected()
  return true
}

function pasteNodes(): boolean {
  if (!nodeClipboard.value.length) return false
  beforeStructure()
  const anchor = focusedId.value && findNode(tree.value, focusedId.value)
  const created: string[] = []
  if (anchor) {
    const copies = nodeClipboard.value.map((n) => cloneSubtree(n, newOutlineId))
    anchor.siblings.splice(anchor.index + 1, 0, ...copies)
    created.push(...copies.map((c) => c.id))
  } else {
    const copies = nodeClipboard.value.map((n) => cloneSubtree(n, newOutlineId))
    rootNodes.value.push(...copies)
    created.push(...copies.map((c) => c.id))
  }
  pushHistory()
  scheduleSave()
  if (created.length) focusNode(created[0]!, 'end', true)
  return true
}

// ---------- 键盘 ----------

function editorFromEvent(ev: KeyboardEvent): { row: ReturnType<typeof rowFor>; editor: TextEditorApi } | null {
  const target = ev.target as HTMLElement | null
  const edEl = target?.closest('.ol-text') as HTMLElement | null
  if (!edEl) return null
  const rowEl = edEl.closest('.ol-row[data-row-id]') as HTMLElement | null
  const id = rowEl?.dataset.rowId
  if (!id) return null
  const row = rowFor(id)
  const editor = editorFor(id)
  return row && editor ? { row, editor } : null
}

function isMod(ev: KeyboardEvent): boolean {
  return ev.ctrlKey || ev.metaKey
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.isComposing) return
  const target = ev.target as HTMLElement | null

  // 备注框
  if (target?.closest('.ol-note-input')) {
    const rowEl = target.closest('.ol-row[data-row-id]') as HTMLElement | null
    const row = rowEl ? rowFor(rowEl.dataset.rowId ?? '') : undefined
    if (row) {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        ;(target as HTMLTextAreaElement).blur()
        return
      }
      if (ev.key === 'Tab') {
        ev.preventDefault()
        editorFor(row.node.id)?.focusOffset('end')
        return
      }
      if (
        ev.key === 'Backspace' &&
        (target as HTMLTextAreaElement).selectionStart === 0 &&
        (target as HTMLTextAreaElement).selectionEnd === 0 &&
        !row.node.note
      ) {
        ev.preventDefault()
        delete row.node.note
        noteEditingId.value = null
        editorFor(row.node.id)?.focusOffset(0)
        scheduleSave()
        return
      }
    }
    return
  }

  // 标题输入框 / 其它原生输入框：键位交给浏览器
  if (target?.closest('input, textarea')) return

  // 非编辑区（结构选择态）的通用键
  if (!target?.closest('.ol-text')) {
    if (isMod(ev) && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault()
      if (ev.shiftKey) redo()
      else undo()
      return
    }
    if (isMod(ev) && (ev.key === 'y' || ev.key === 'Y')) {
      ev.preventDefault()
      redo()
      return
    }
    if (ev.key === 'Escape') {
      clearSelection()
      return
    }
    if (selected.size > 0 && (ev.key === 'Delete' || ev.key === 'Backspace')) {
      ev.preventDefault()
      deleteSelected()
      return
    }
    if (isMod(ev) && (ev.key === 'a' || ev.key === 'A')) {
      ev.preventDefault()
      selectAllRows()
      return
    }
    if (isMod(ev) && (ev.key === 'c' || ev.key === 'C')) {
      if (copySelected()) ev.preventDefault()
      return
    }
    if (isMod(ev) && (ev.key === 'x' || ev.key === 'X')) {
      if (cutSelected()) ev.preventDefault()
      return
    }
    if (isMod(ev) && (ev.key === 'v' || ev.key === 'V')) {
      if (pasteNodes()) ev.preventDefault()
      return
    }
    if (isMod(ev) && (ev.key === 'd' || ev.key === 'D')) {
      ev.preventDefault()
      duplicateSelected()
      return
    }
    return
  }

  const found = editorFromEvent(ev)
  if (!found) return
  const { row, editor } = found
  if (!row) return
  const node = row.node
  const key = ev.key

  // 撤销 / 重做
  if (isMod(ev) && (key === 'z' || key === 'Z')) {
    ev.preventDefault()
    if (ev.shiftKey) redo()
    else undo()
    return
  }
  if (isMod(ev) && (key === 'y' || key === 'Y')) {
    ev.preventDefault()
    redo()
    return
  }

  // 行内格式
  if (isMod(ev) && (key === 'b' || key === 'B' || key === 'i' || key === 'I' || key === 'u' || key === 'U')) {
    ev.preventDefault()
    const kind = key.toLowerCase() === 'b' ? 'bold' : key.toLowerCase() === 'i' ? 'italic' : 'underline'
    if (ev.shiftKey) applySameLevel(kind)
    else applyInlineFormat(kind)
    return
  }
  if (isMod(ev) && key === 'Enter') {
    ev.preventDefault()
    applyInlineFormat('strikeThrough')
    return
  }

  // 任务
  if (isMod(ev) && ev.shiftKey && (key === 'l' || key === 'L')) {
    ev.preventDefault()
    setTask(row, node.task ? 0 : 1)
    return
  }
  if (isMod(ev) && ev.shiftKey && (key === 'k' || key === 'K')) {
    ev.preventDefault()
    setTask(row, node.task === 2 ? 1 : 2)
    return
  }

  // 移动行
  if (isMod(ev) && ev.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    ev.preventDefault()
    if (key === 'ArrowUp') moveUp(row, editor)
    else moveDown(row, editor)
    return
  }

  // 标题级别
  if (ev.altKey && !isMod(ev) && ['1', '2', '3', '4'].includes(key)) {
    ev.preventDefault()
    setHeading(row, Number(key) === 4 ? 0 : (Number(key) as 1 | 2 | 3))
    return
  }

  // 按层级折叠
  if (isMod(ev) && ev.altKey && ['1', '2', '3'].includes(key)) {
    ev.preventDefault()
    collapseByLevel(tree.value, Number(key))
    scheduleSave()
    scheduleHistory()
    return
  }
  if (isMod(ev) && ev.altKey && ev.shiftKey && (key === '.' || key === '>')) {
    ev.preventDefault()
    collapseAllTree(tree.value)
    scheduleSave()
    scheduleHistory()
    return
  }

  // 钻取：Ctrl+] 进入有子级的当前行；Ctrl+[ 退出一层
  if (isMod(ev) && key === ']') {
    ev.preventDefault()
    if (row.hasChildren) drillInto(row)
    return
  }
  if (isMod(ev) && key === '[') {
    ev.preventDefault()
    drillUp()
    return
  }

  // 删除 / 行首退格
  if (key === 'Backspace') {
    // 只有多选块才整体删除；单行选中 + 行首退格仍应「并入上一行」
    if (selected.size > 1 && !editor.hasTextSelection()) {
      ev.preventDefault()
      deleteSelected()
      return
    }
    if (editor.caretOffset() === 0) {
      ev.preventDefault()
      handleBackspace(row, editor)
      return
    }
    return
  }
  if (key === 'Delete') {
    if (selected.size > 0 && !editor.hasTextSelection()) {
      ev.preventDefault()
      deleteSelected()
    }
    return
  }

  // 多选扩展（先有结构选择时接管 Shift+↑↓，否则让原生选字）
  if (ev.shiftKey && !isMod(ev) && !ev.altKey && (key === 'ArrowUp' || key === 'ArrowDown') && selected.size > 0) {
    ev.preventDefault()
    moveSelection(key === 'ArrowUp' ? -1 : 1, true)
    return
  }

  // 上下行移动（单行或光标在边界）
  if (!isMod(ev) && !ev.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const offset = editor.caretOffset()
    const len = node.text.length
    const singleLine = editor.el ? editor.el.getBoundingClientRect().height <= 34 : true
    const atEdge = key === 'ArrowUp' ? offset === 0 : offset >= len
    if (singleLine || atEdge) {
      ev.preventDefault()
      moveCaretToRow(key === 'ArrowUp' ? -1 : 1, offset, ev.shiftKey)
      return
    }
    return
  }

  // 回车
  if (key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault()
    handleEnter(row, editor)
    return
  }

  // Tab / Shift+Tab
  if (key === 'Tab') {
    ev.preventDefault()
    handleTab(row, editor, ev.shiftKey)
    return
  }

  // 引用浮层
  if ((key === '/' || key === '@') && node.text === '' && editor.caretOffset() === 0) {
    ev.preventDefault()
    openPicker(node.id)
    return
  }

  // Ctrl+A：结构全选（主流大纲工具的行为）
  if (isMod(ev) && (key === 'a' || key === 'A')) {
    ev.preventDefault()
    selectAllRows()
    return
  }

  // 复制 / 剪切 / 粘贴
  if (isMod(ev) && (key === 'c' || key === 'C') && selected.size > 0 && !editor.hasTextSelection()) {
    if (copySelected()) ev.preventDefault()
    return
  }
  if (isMod(ev) && (key === 'x' || key === 'X') && selected.size > 0 && !editor.hasTextSelection()) {
    if (cutSelected()) ev.preventDefault()
    return
  }
  if (isMod(ev) && (key === 'v' || key === 'V') && selected.size > 0 && !editor.hasTextSelection()) {
    if (pasteNodes()) ev.preventDefault()
    return
  }
  if (isMod(ev) && (key === 'd' || key === 'D')) {
    ev.preventDefault()
    duplicateSelected()
    return
  }

  // Esc：收起多选/浮层
  if (key === 'Escape') {
    hideToolbar()
    clearSelection()
  }
}

/** Shift+↑↓ 扩展结构选择 */
function moveSelection(delta: number, extend: boolean): void {
  const ids = visibleNodeIds(rootNodes.value)
  const cur = focusedId.value
  let i = cur ? ids.indexOf(cur) : -1
  if (i < 0) i = 0
  const next = Math.max(0, Math.min(ids.length - 1, i + delta))
  const id = ids[next]
  if (!id) return
  if (extend) {
    if (!anchorId.value) anchorId.value = cur ?? id
    selectRangeTo(id)
  } else {
    selectSingle(id)
  }
  focusedId.value = id
  document.querySelector(`.ol-row[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
}

/** 光标跨行移动（↑↓）；带 shift 时走结构选择 */
function moveCaretToRow(delta: number, offset: number, extend: boolean): void {
  const ids = visibleNodeIds(rootNodes.value)
  const cur = focusedId.value
  let i = cur ? ids.indexOf(cur) : -1
  if (i < 0) {
    const active = document.activeElement as HTMLElement | null
    const rowEl = active?.closest('.ol-row[data-row-id]') as HTMLElement | null
    i = rowEl ? ids.indexOf(rowEl.dataset.rowId ?? '') : -1
  }
  if (i < 0) return
  const id = ids[Math.max(0, Math.min(ids.length - 1, i + delta))]
  if (!id) return
  if (extend) {
    if (!anchorId.value) anchorId.value = cur ?? ids[i] ?? null
    selectRangeTo(id)
  }
  focusedId.value = id
  const target = nodeFor(id)
  nextTick(() => {
    editorFor(id)?.focusOffset(Math.min(offset, target?.text.length ?? offset))
    document.querySelector(`.ol-row[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

// ---------- 行内格式 / 浮动工具栏 ----------

const toolbar = reactive({
  visible: false,
  left: 0,
  top: 0,
  below: false,
  rowId: null as string | null
})

function activeEditor(): TextEditorApi | null {
  const sel = window.getSelection()
  const anchor = sel?.anchorNode
  if (anchor) {
    const el = (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement))?.closest?.(
      '.ol-text'
    ) as HTMLElement | null
    if (el) {
      const rowEl = el.closest('.ol-row[data-row-id]') as HTMLElement | null
      const id = rowEl?.dataset.rowId
      if (id) return editorFor(id)
    }
  }
  return editorFor(focusedId.value)
}

function activeRowId(): string | null {
  const sel = window.getSelection()
  const anchor = sel?.anchorNode
  if (anchor) {
    const el = (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement))?.closest?.(
      '.ol-text'
    ) as HTMLElement | null
    const rowEl = el?.closest('.ol-row[data-row-id]') as HTMLElement | null
    if (rowEl?.dataset.rowId) return rowEl.dataset.rowId
  }
  return focusedId.value
}

function refreshToolbar(): void {
  if (drag.active) {
    hideToolbar()
    return
  }
  const editor = activeEditor()
  const rect = editor?.selectionRect()
  if (!editor || !rect) {
    hideToolbar()
    return
  }
  const id = activeRowId()
  toolbar.rowId = id
  toolbar.visible = true
  const width = Math.min(460, window.innerWidth - 24)
  toolbar.left = Math.max(width / 2 + 12, Math.min(window.innerWidth - width / 2 - 12, rect.left + rect.width / 2))
  if (rect.top < 64) {
    toolbar.below = true
    toolbar.top = rect.bottom + 12
  } else {
    toolbar.below = false
    toolbar.top = rect.top - 10
  }
}

function hideToolbar(): void {
  toolbar.visible = false
}

function onSelectionChange(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) {
    hideToolbar()
    return
  }
  const anchor = sel.anchorNode
  const el = (anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement))?.closest?.(
    '.ol-text'
  )
  if (!el) {
    hideToolbar()
    return
  }
  refreshToolbar()
}

function applyInlineFormat(command: string, value?: string): void {
  const editor = activeEditor()
  if (!editor) return
  // 无选区时交给浏览器切换「后续输入」的样式；有选区则只作用于选中文字
  editor.format(command, value)
  const id = activeRowId()
  if (id) syncNodeFromEditor(id)
  refreshToolbar()
}

function applyCode(): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const text = sel.toString()
  if (!text) return
  const editor = activeEditor()
  if (!editor) return
  editor.insertHtml(`<code>${escapeHtml(text)}</code>`)
  const id = activeRowId()
  if (id) syncNodeFromEditor(id)
}

/** 同级批量样式（Ctrl+Shift+B/I/U）：整行包一层标签，当前行也包含在内 */
function applySameLevel(kind: 'bold' | 'italic' | 'underline'): void {
  const id = activeRowId()
  const loc = id ? findNode(tree.value, id) : null
  if (!loc) return
  const tag = kind === 'bold' ? 'b' : kind === 'italic' ? 'i' : 'u'
  const wrap = (node: OutlineNode): void => {
    const inner = node.html || htmlFromPlainText(node.text)
    if (new RegExp(`<${tag}\\b`, 'i').test(inner)) return
    node.html = `<${tag}>${inner}</${tag}>`
  }
  for (const sibling of loc.siblings) wrap(sibling)
  bumpRender()
  scheduleSave()
  scheduleHistory()
  nextTick(() => editorFor(id!)?.focusOffset('end'))
}

// ---------- 拖拽（圆点拖动：拖动排序 / 改挂载 / 多选整块搬） ----------

const drag = reactive({
  active: false,
  ids: [] as string[],
  startX: 0,
  startY: 0,
  ghostX: 0,
  ghostY: 0,
  dropRowId: null as string | null,
  dropMode: 'child' as 'child' | 'before' | 'after',
  dropTop: 0,
  dropLeft: 0,
  dropWidth: 0
})

let pendingDrag: { id: string; x: number; y: number } | null = null

function onBulletPointerDown(row: { node: OutlineNode }, ev: PointerEvent): void {
  if (ev.button !== 0) return
  ev.preventDefault()
  ev.stopPropagation()
  const id = row.node.id
  if (ev.shiftKey) selectRangeTo(id)
  else if (ev.ctrlKey || ev.metaKey) toggleSelected(id)
  else if (!selected.has(id)) selectSingle(id)
  else focusedId.value = id
  pendingDrag = { id, x: ev.clientX, y: ev.clientY }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp, { once: true })
  window.addEventListener('pointercancel', cancelDrag, { once: true })
}

function onDragMove(ev: PointerEvent): void {
  if (!pendingDrag) return
  if (!drag.active) {
    if (Math.hypot(ev.clientX - pendingDrag.x, ev.clientY - pendingDrag.y) < 4) return
    drag.active = true
    drag.ids = selected.has(pendingDrag.id) ? selectedOrdered() : [pendingDrag.id]
    if (!drag.ids.length) drag.ids = [pendingDrag.id]
    drag.startX = ev.clientX
    drag.startY = ev.clientY
    document.body.classList.add('ol-dragging')
    hideToolbar()
  }
  drag.ghostX = ev.clientX + 12
  drag.ghostY = ev.clientY + 10
  updateDropTarget(ev.clientX, ev.clientY)
  // 边缘自动滚动
  const box = scrollEl.value?.getBoundingClientRect()
  if (box) {
    if (ev.clientY < box.top + 56) scrollEl.value?.scrollBy(0, -14)
    else if (ev.clientY > box.bottom - 56) scrollEl.value?.scrollBy(0, 14)
  }
}

function updateDropTarget(x: number, y: number): void {
  drag.dropRowId = null
  let rowEl: HTMLElement | null = null
  for (const el of document.elementsFromPoint(x, y)) {
    if (el instanceof HTMLElement) {
      const r = el.closest('.ol-row[data-row-id]') as HTMLElement | null
      if (r) {
        rowEl = r
        break
      }
    }
  }
  if (!rowEl) return
  const targetId = rowEl.dataset.rowId
  if (!targetId || drag.ids.includes(targetId)) return
  const targetHit = findNode(tree.value, targetId)
  if (!targetHit) return
  for (const id of drag.ids) {
    const node = nodeFor(id)
    if (node && (node.id === targetId || findNode(tree.value, targetId)?.node === node || isAncestorOf(node, targetId))) {
      return
    }
  }
  const rect = rowEl.getBoundingClientRect()
  const rel = (y - rect.top) / Math.max(1, rect.height)
  const mode: 'child' | 'before' | 'after' = rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'child'
  drag.dropRowId = targetId
  drag.dropMode = mode
  const depth = targetHit.depth + (mode === 'child' ? 1 : 0)
  drag.dropLeft = rect.left + depth * INDENT
  drag.dropWidth = Math.max(80, rect.right - drag.dropLeft - 6)
  drag.dropTop = mode === 'before' ? rect.top : rect.bottom
}

function isAncestorOf(ancestor: OutlineNode, id: string): boolean {
  for (const child of ancestor.children ?? []) {
    if (child.id === id || isAncestorOf(child, id)) return true
  }
  return false
}

function onDragUp(): void {
  window.removeEventListener('pointermove', onDragMove)
  const pending = pendingDrag
  pendingDrag = null
  if (!drag.active) {
    cleanupDrag()
    return
  }
  const ids = [...drag.ids]
  const targetId = drag.dropRowId
  const mode = drag.dropMode
  cleanupDrag()
  if (!targetId || !ids.length) return
  beforeStructure()
  if (moveNodesRelative(tree.value, ids, targetId, mode)) {
    pushHistory()
    scheduleSave()
    focusNode(ids[0]!, 'end', true)
  }
}

function cancelDrag(): void {
  window.removeEventListener('pointermove', onDragMove)
  pendingDrag = null
  cleanupDrag()
}

function cleanupDrag(): void {
  drag.active = false
  drag.ids = []
  drag.dropRowId = null
  document.body.classList.remove('ol-dragging')
}

// ---------- 行悬停操作 / 行菜单 ----------

const rowMenu = reactive({
  open: false,
  rowId: null as string | null,
  left: 0,
  top: 0
})

function openRowMenu(row: { node: OutlineNode }, ev: MouseEvent): void {
  ev.stopPropagation()
  selectSingle(row.node.id)
  const btn = ev.currentTarget as HTMLElement
  const rect = btn.getBoundingClientRect()
  rowMenu.open = true
  rowMenu.rowId = row.node.id
  rowMenu.left = Math.min(window.innerWidth - 210, rect.right - 170)
  rowMenu.top = Math.min(window.innerHeight - 380, rect.bottom + 6)
  hideToolbar()
}

function closeRowMenu(): void {
  rowMenu.open = false
  rowMenu.rowId = null
}

function menuRow(): ReturnType<typeof rowFor> | null {
  return rowMenu.rowId ? rowFor(rowMenu.rowId) ?? null : null
}

function menuAction(fn: (row: NonNullable<ReturnType<typeof rowFor>>) => void): void {
  const row = menuRow()
  closeRowMenu()
  if (row) fn(row)
}

const headMenuOpen = ref(false)

function closeMenus(): void {
  closeRowMenu()
  headMenuOpen.value = false
}

function onDocClick(ev: MouseEvent): void {
  const t = ev.target as HTMLElement
  if (!t.closest('.ol-menu-wrap') && !t.closest('.ol-row-menu') && !t.closest('.ol-more')) {
    headMenuOpen.value = false
  }
  if (!t.closest('.ol-row-menu') && !t.closest('.ol-hover-actions')) closeRowMenu()
  if (!t.closest('.ol-toolbar')) {
    // 工具栏点击用了 mousedown.prevent，不会走到这里；点外部收起
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) hideToolbar()
  }
}

// ---------- 备注 ----------

const noteEditingId = ref<string | null>(null)

function startNote(row: { node: OutlineNode }): void {
  if (!row.node.note) row.node.note = ''
  noteEditingId.value = row.node.id
  scheduleSave()
  nextTick(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(
      `.ol-row[data-row-id="${CSS.escape(row.node.id)}"] .ol-note-input`
    )
    ta?.focus()
    if (ta) sizeNote(ta)
  })
}

function onNoteInput(row: { node: OutlineNode }, ev: Event): void {
  const ta = ev.target as HTMLTextAreaElement
  row.node.note = ta.value
  sizeNote(ta)
  scheduleSave()
  scheduleHistory()
}

function onNoteBlur(row: { node: OutlineNode }): void {
  if (!row.node.note?.trim()) delete row.node.note
  noteEditingId.value = null
  scheduleSave()
}

function sizeNote(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight}px`
}

// 打开已有备注时把 textarea 撑到内容高度
watch(noteEditingId, () => {
  nextTick(() => {
    document.querySelectorAll<HTMLTextAreaElement>('.ol-note-input').forEach(sizeNote)
  })
})

// ---------- 贴图 ----------

const imageUrls = reactive(new Map<string, string>())
const imagePreview = ref<string | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
let pendingImageNodeId: string | null = null

async function ensureImageUrl(fileName: string): Promise<string | null> {
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

function syncTreeImages(): void {
  const walk = (nodes: OutlineNode[]): void => {
    for (const n of nodes) {
      for (const img of nodeImages(n)) void ensureImageUrl(img)
      walk(n.children ?? [])
    }
  }
  walk(tree.value)
}

watch(tree, syncTreeImages, { deep: true })

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? '').slice(String(reader.result ?? '').indexOf(',') + 1))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function clipboardImageItems(ev: ClipboardEvent): DataTransferItem[] {
  return Array.from(ev.clipboardData?.items ?? []).filter(
    (it) => it.kind === 'file' && it.type.startsWith('image/')
  )
}

async function attachImageFiles(files: File[], node: OutlineNode): Promise<void> {
  for (const file of files) {
    try {
      const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
      const b64 = await fileToBase64(file)
      const name = await window.lexbench.attachments.saveImage(b64, ext)
      const list = node.images?.length ? node.images : node.image ? [node.image] : []
      if (!list.includes(name)) list.push(name)
      node.images = list
      node.image = list[0]
      await ensureImageUrl(name)
      scheduleSave()
      scheduleHistory()
      emit('notice', '图片已插入')
    } catch (e) {
      emit('error', e)
    }
  }
}

function requestImage(row: { node: OutlineNode }): void {
  pendingImageNodeId = row.node.id
  imageInput.value?.click()
}

async function onPickImages(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  const id = pendingImageNodeId
  pendingImageNodeId = null
  const node = id ? nodeFor(id) : null
  if (node && files.length) await attachImageFiles(files, node)
}

function removeImage(node: OutlineNode, fileName: string): void {
  const list = nodeImages(node).filter((x) => x !== fileName)
  if (list.length) {
    node.images = list
    node.image = list[0]
  } else {
    delete node.images
    delete node.image
  }
  scheduleSave()
  scheduleHistory()
}

function previewImage(url: string): void {
  imagePreview.value = url
}

// ---------- 粘贴 ----------

function onPasteFromRow(ev: ClipboardEvent, row: { node: OutlineNode; hasChildren: boolean }): void {
  const editor = editorFor(row.node.id)
  if (editor) void onPaste(ev, row, editor)
}

async function onPaste(ev: ClipboardEvent, row: { node: OutlineNode; hasChildren: boolean }, editor: TextEditorApi): Promise<void> {
  const imgItems = clipboardImageItems(ev)
  if (imgItems.length) {
    ev.preventDefault()
    const files = imgItems.map((it) => it.getAsFile()).filter((f): f is File => !!f)
    await attachImageFiles(files, row.node)
    return
  }

  const text = ev.clipboardData?.getData('text/plain') ?? ''
  const html = ev.clipboardData?.getData('text/html') ?? ''
  const refMatch = /data-lb-ref="([^"]+)"/.exec(html)
  if (refMatch) {
    ev.preventDefault()
    try {
      const ref = JSON.parse(refMatch[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as OutlineRef
      const citeText = text.split(/\r?\n/)[0]?.trim() ?? ''
      if (!citeText) return
      const quote = text.split(/\r?\n/).slice(1).join('\n').trim()
      beforeStructure()
      const citeNode = createOutlineNode(citeText, {
        ref,
        children: quote ? [createOutlineNode(quote)] : []
      })
      insertAfter(tree.value, row.node.id, citeNode)
      pushHistory()
      scheduleSave()
      focusNode(citeNode.id, 0, true)
    } catch {
      /* 元数据损坏时按普通文本走 */
    }
    return
  }

  // 结构选择态粘贴节点
  if (selected.size > 0 && !editor.hasTextSelection() && nodeClipboard.value.length) {
    ev.preventDefault()
    pasteNodes()
    return
  }

  if (!text.includes('\n')) {
    // 单行：行内 HTML 直接消毒插入；纯文本也走 HTML 插入，避免浏览器的脏样式
    if (html) {
      ev.preventDefault()
      editor.insertHtml(html)
      const id = row.node.id
      syncNodeFromEditor(id)
      return
    }
    return
  }

  ev.preventDefault()
  const split = editor.splitAtCaret()
  if (!split) return
  const lines = text.split(/\r?\n/)
  beforeStructure()
  row.node.text = split.beforeText + (lines[0] ?? '')
  const firstHtml = split.beforeHtml + htmlFromPlainText(lines[0] ?? '')
  if (hasInlineFormatting(firstHtml, row.node.text)) row.node.html = firstHtml
  else delete row.node.html
  const hit = findNode(tree.value, row.node.id)
  if (!hit) return
  const created: OutlineNode[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const isLast = i === lines.length - 1
    const textLine = isLast ? line + split.afterText : line
    const htmlLine = isLast ? escapeHtml(line) + split.afterHtml : escapeHtml(line)
    const n = createOutlineNode(textLine)
    if (hasInlineFormatting(htmlLine, textLine)) n.html = htmlLine
    created.push(n)
  }
  hit.siblings.splice(hit.index + 1, 0, ...created)
  pushHistory()
  bumpRender()
  scheduleSave()
  const last = created[created.length - 1]
  if (last) focusNode(last.id, 'end', true)
}

// ---------- 引用插入浮层 ----------

const picker = ref<{
  open: boolean
  anchorId: string | null
  q: string
  loading: boolean
  results: SearchHit[]
}>({ open: false, anchorId: null, q: '', loading: false, results: [] })

const pickerInputEl = ref<HTMLInputElement | null>(null)
let pickerTimer: ReturnType<typeof setTimeout> | undefined
let pickerSeq = 0
let pickerComposing = false

function openPicker(anchorId: string | null): void {
  picker.value.open = true
  picker.value.anchorId = anchorId
  picker.value.q = ''
  picker.value.results = []
  hideToolbar()
  nextTick(() => pickerInputEl.value?.focus())
}

function closePicker(): void {
  picker.value.open = false
  clearTimeout(pickerTimer)
}

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
    picker.value.results = out.results.filter((r) => r.kind === 'article')
  } catch {
    if (seq === pickerSeq) picker.value.results = []
  } finally {
    if (seq === pickerSeq) picker.value.loading = false
  }
}

async function insertRefFromPicker(hit: SearchHit): Promise<void> {
  if (hit.kind !== 'article') return
  try {
    const detail = await window.lexbench.library.getArticle(hit.id)
    beforeStructure()
    const citeNode = createOutlineNode(`《${shortLawName(detail.article.title ?? hit.title)}》${detail.article.article_label}`, {
      ref: { docId: detail.article.document_id, articleId: detail.article.id },
      children: [createOutlineNode(detail.article.content)]
    })
    const anchorId = picker.value.anchorId
    const anchor = anchorId ? findNode(tree.value, anchorId) : null
    if (anchor) anchor.siblings.splice(anchor.index + 1, 0, citeNode)
    else rootNodes.value.push(citeNode)
    picker.value.anchorId = citeNode.id
    pushHistory()
    scheduleSave()
    focusNode(citeNode.id, 'end', true)
    emit('notice', '已插入法条引用')
  } catch (e) {
    emit('error', e)
  }
}

// ---------- 引用行右键（原生菜单的逃生门） ----------

function onRowContextmenu(row: { node: OutlineNode }): void {
  const ref = row.node.ref
  window.lexbench.outlines.setRefContext(ref ? { docId: ref.docId, articleId: ref.articleId } : null)
}

function openSourceFromNode(node: OutlineNode): void {
  if (node.ref) emit('open-source', node.ref)
}

// ---------- 导出 / 视图切换 ----------

async function setView(mode: 'outline' | 'map'): Promise<void> {
  if (viewMode.value === mode) return
  await saveNow(false)
  viewMode.value = mode
  try {
    await window.lexbench.outlines.setViewMode(props.outline.id, mode)
  } catch (e) {
    emit('error', e)
  }
  if (mode === 'outline') {
    nextTick(() => {
      const id = focusedId.value && findNode(tree.value, focusedId.value) ? focusedId.value : rows.value[0]?.node.id
      if (id) editorFor(id)?.focusOffset('end')
    })
  }
}

function onMapChange(newTree: OutlineNode[]): void {
  beforeStructure()
  tree.value = normalizeOutlineTree(newTree)
  if (!tree.value.length) tree.value = [createOutlineNode('')]
  bumpRender()
  pushHistory()
  scheduleSave()
}

async function exportOutline(format: ExportFormat): Promise<void> {
  headMenuOpen.value = false
  try {
    await saveNow(true)
    const res = await window.lexbench.outlines.export(props.outline.id, format)
    if (!res.canceled) emit('notice', `笔记已导出：${res.path}`)
  } catch (e) {
    emit('error', e)
  }
}

// ---------- 行事件 ----------

function rowClass(row: ReturnType<typeof flattenOutline>[number]): Record<string, boolean> {
  const node = row.node
  return {
    selected: selected.has(node.id),
    focused: focusedId.value === node.id,
    'is-ref': !!node.ref,
    'heading-1': node.heading === 1,
    'heading-2': node.heading === 2,
    'heading-3': node.heading === 3,
    'task-done': node.task === 2,
    'drop-child': drag.active && drag.dropRowId === node.id && drag.dropMode === 'child',
    dragging: drag.active && drag.ids.includes(node.id)
  }
}

function onRowMouseDown(row: ReturnType<typeof flattenOutline>[number], ev: MouseEvent): void {
  if (ev.button !== 0) return
  const t = ev.target as HTMLElement
  if (t.closest('.ol-text, .ol-task, .ol-hover-actions, .ol-note, .ol-images, .ol-fold, .ol-bullet, .ol-count, .ol-gutter')) {
    return
  }
  if (t.closest('.ol-row') !== ev.currentTarget) return
  ev.preventDefault()
  if (ev.shiftKey) selectRangeTo(row.node.id)
  else if (ev.ctrlKey || ev.metaKey) toggleSelected(row.node.id)
  else selectSingle(row.node.id)
}

function onTextFocus(row: { node: OutlineNode }): void {
  // 直接点进另一行的文字 = 光标移到该行，顺手结束上一轮结构多选。
  // 由 focusNode 主动聚焦时 focusedId 已等于该行，不会误清刚建立的选择。
  if (focusedId.value !== row.node.id) {
    selected.clear()
    anchorId.value = row.node.id
  }
  focusedId.value = row.node.id
}

function onBlankClick(): void {
  appendRow()
}

// ---------- 生命周期 ----------

function onScrollHideToolbar(): void {
  hideToolbar()
}

onMounted(() => {
  resetHistory()
  syncTreeImages()
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('click', onDocClick)
  window.addEventListener('scroll', onScrollHideToolbar, true)
  nextTick(() => {
    if (rows.value.length === 1 && !rows.value[0]!.node.text) {
      // 新笔记：光标直接给标题，用户先写标题
      ;(document.querySelector('.ol-title') as HTMLInputElement | null)?.focus()
    }
  })
})

onBeforeUnmount(() => {
  clearTimeout(saveTimer)
  clearTimeout(historyTimer)
  clearTimeout(pickerTimer)
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('scroll', onScrollHideToolbar, true)
  window.removeEventListener('pointermove', onDragMove)
  document.body.classList.remove('ol-dragging')
  window.lexbench.outlines.setRefContext(null)
  // 卸载即冲刷；不 emit('saved')（见 lessons-log #11）
  if (dirty || titleDirty) void saveNow(true)
  for (const url of imageUrls.values()) URL.revokeObjectURL(url)
  imageUrls.clear()
})

</script>

<template>
  <div class="ol" :class="{ 'in-map': viewMode === 'map' }" @keydown="onKeydown">
    <div v-if="drilledId" class="ol-breadcrumb">
      <button class="ol-crumb" @click="drilledId = null">全部</button>
      <template v-for="(item, i) in breadcrumb" :key="item.id">
        <span class="ol-crumb-sep">›</span>
        <button class="ol-crumb" :class="{ on: i === breadcrumb.length - 1 }" @click="drilledId = item.id">
          {{ item.text || '未命名' }}
        </button>
      </template>
    </div>

    <header class="ol-head" :class="{ 'head-map': viewMode === 'map' }">
      <input
        v-model="title"
        class="ol-title"
        type="text"
        placeholder="未命名笔记"
        spellcheck="false"
        @input="scheduleTitleSave"
        @keydown.enter.prevent="focusNode(rows[0]?.node.id ?? '', 0)"
      />
      <div class="ol-head-actions">
        <button
          class="ol-insert-btn"
          title="插入文档库法条引用（空行上按 / 或 @ 也可唤出）"
          @click="openPicker(rows[rows.length - 1]?.node.id ?? null)"
        >
          <span class="ol-ico">＋</span> 引用
        </button>
        <div class="ol-view-switch" role="group" aria-label="视图">
          <button :class="{ on: viewMode === 'outline' }" title="大纲视图" @click="setView('outline')">大纲</button>
          <button :class="{ on: viewMode === 'map' }" title="思维导图（可拖动节点）" @click="setView('map')">导图</button>
        </div>
        <div class="ol-menu-wrap">
          <button class="ol-more" title="更多操作" @click.stop="headMenuOpen = !headMenuOpen">⋯</button>
          <Transition name="menu-pop">
            <div v-if="headMenuOpen" class="ol-menu" @click.stop>
              <button class="ol-menu-item" @click="exportOutline('md')">导出 Markdown</button>
              <button class="ol-menu-item" @click="exportOutline('docx')">导出 Word</button>
              <div class="ol-menu-sep"></div>
              <button
                class="ol-menu-item"
                @click="headMenuOpen = false; expandAllTree(tree); scheduleSave(); scheduleHistory()"
              >
                全部展开
              </button>
              <button
                class="ol-menu-item"
                @click="headMenuOpen = false; collapseAllTree(tree); scheduleSave(); scheduleHistory()"
              >
                全部折叠
              </button>
              <div class="ol-menu-sep"></div>
              <button class="ol-menu-item danger" @click="headMenuOpen = false; emit('delete-request')">
                删除笔记
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </header>

    <div v-if="viewMode === 'outline'" ref="scrollEl" class="ol-scroll">
      <div class="ol-page">
        <div class="ol-tree">
          <div
            v-for="row in rows"
            :key="row.node.id"
            class="ol-row"
            :class="rowClass(row)"
            :data-row-id="row.node.id"
            :data-depth="row.depth"
            @mousedown="onRowMouseDown(row, $event)"
            @contextmenu="onRowContextmenu(row)"
          >
            <span v-for="i in row.depth" :key="i" class="ol-indent" aria-hidden="true"></span>

            <div class="ol-node">
              <div
                class="ol-gutter"
                :title="row.node.ref ? '法条引用（拖动可移动）' : '拖动可移动 / 点击选中'"
                @pointerdown="onBulletPointerDown(row, $event)"
                @dblclick.stop="toggleFold(row)"
              >
                <button
                  v-if="row.hasChildren"
                  class="ol-fold"
                  :class="{ open: !row.node.fold }"
                  :title="row.node.fold ? `展开 ${row.hidden} 项` : '折叠'"
                  @click.stop="toggleFold(row)"
                  @pointerdown.stop
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                    <path
                      d="M2 1.2L5.6 4L2 6.8"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
                <span v-else class="ol-fold-space" aria-hidden="true"></span>
                <span
                  class="ol-bullet"
                  :class="{ ref: !!row.node.ref, collapsed: row.node.fold }"
                  aria-hidden="true"
                >
                  {{ row.node.ref ? '📖' : '' }}
                </span>
                <span v-if="row.node.fold && row.hidden > 0" class="ol-count">{{ row.hidden }}</span>
              </div>

              <div class="ol-content">
                <div class="ol-line">
                  <input
                    v-if="row.node.task"
                    type="checkbox"
                    class="ol-task"
                    :checked="row.node.task === 2"
                    title="完成 / 取消完成"
                    @change="toggleTaskDone(row)"
                    @mousedown.stop
                  />
                  <OutlineTextEditor
                    :ref="(el) => setTextRef(row.node.id, el)"
                    :text="row.node.text"
                    :html="row.node.html"
                    :sync-token="renderEpoch"
                    :placeholder="rows.length === 1 && row.depth === 0 ? '开始写笔记…（Enter 新行，Tab 缩进，/ 插入引用）' : ''"
                    :aria-label="'笔记第 ' + (row.depth + 1) + ' 级'"
                    @change="onNodeChange(row.node, $event)"
                    @paste="onPasteFromRow($event, row)"
                    @focus="onTextFocus(row)"
                    @select="refreshToolbar"
                  />
                </div>

                <div v-if="row.node.note || noteEditingId === row.node.id" class="ol-note">
                  <textarea
                    class="ol-note-input"
                    :value="row.node.note ?? ''"
                    rows="1"
                    placeholder="添加备注…"
                    @input="onNoteInput(row, $event)"
                    @blur="onNoteBlur(row)"
                    @focus="noteEditingId = row.node.id"
                    @keydown.enter.stop
                  ></textarea>
                </div>

                <div v-if="nodeImages(row.node).length" class="ol-images">
                  <div v-for="img in nodeImages(row.node)" :key="img" class="ol-image-wrap">
                    <img
                      v-if="imageUrls.has(img)"
                      class="ol-img"
                      :src="imageUrls.get(img)"
                      alt=""
                      draggable="false"
                      @click="previewImage(imageUrls.get(img)!)"
                    />
                    <button class="ol-img-del" title="移除图片" @click.stop="removeImage(row.node, img)">✕</button>
                  </div>
                </div>
              </div>

              <div class="ol-hover-actions">
                <button class="ol-act" title="新建子节点（Tab）" @mousedown.stop @click.stop="addChild(row)">＋</button>
                <button class="ol-act" title="更多" @mousedown.stop @click.stop="openRowMenu(row, $event)">⋯</button>
              </div>
            </div>
          </div>

          <button class="ol-append" @click="appendRow">
            <span class="ol-append-plus">＋</span> 新建一行
          </button>
        </div>
      </div>
      <div class="ol-tail" @click="appendRow"></div>
    </div>

    <MindMapView
      v-else
      :tree="tree"
      :title="displayTitle"
      @change="onMapChange"
      @error="(e) => emit('error', e)"
      @undo="undo"
      @redo="redo"
    />

    <!-- 拖拽落点指示 -->
    <div v-if="drag.active" class="ol-drag-ghost" :style="{ left: drag.ghostX + 'px', top: drag.ghostY + 'px' }">
      <span class="ol-drag-dot"></span>
      <span v-if="drag.ids.length > 1" class="ol-drag-count">{{ drag.ids.length }}</span>
    </div>
    <div
      v-if="drag.active && drag.dropRowId && drag.dropMode !== 'child'"
      class="ol-drop-line"
      :class="drag.dropMode"
      :style="{ left: drag.dropLeft + 'px', top: drag.dropTop + 'px', width: drag.dropWidth + 'px' }"
    ></div>

    <!-- 行菜单 -->
    <div
      v-if="rowMenu.open"
      class="ol-row-menu"
      :style="{ left: rowMenu.left + 'px', top: rowMenu.top + 'px' }"
      @click.stop
    >
      <button class="ol-menu-item" @click="menuAction((r) => addChild(r))">新建子节点 <kbd>Tab</kbd></button>
      <button class="ol-menu-item" @click="menuAction((r) => addSibling(r))">新建同级 <kbd>Enter</kbd></button>
      <button class="ol-menu-item" @click="menuAction((r) => addSibling(r, true))">在上方插入同级</button>
      <div class="ol-menu-sep"></div>
      <button class="ol-menu-item" @click="menuAction((r) => startNote(r))">添加 / 编辑备注</button>
      <button class="ol-menu-item" @click="menuAction((r) => requestImage(r))">插入图片</button>
      <button
        class="ol-menu-item"
        @click="menuAction((r) => setTask(r, r.node.task ? 0 : 1))"
      >
        {{ menuRow()?.node.task ? '取消待办' : '设为待办' }}
      </button>
      <div class="ol-menu-sep"></div>
      <button class="ol-menu-item" @click="menuAction((r) => setHeading(r, 1))">标题 1 <kbd>Alt+1</kbd></button>
      <button class="ol-menu-item" @click="menuAction((r) => setHeading(r, 2))">标题 2 <kbd>Alt+2</kbd></button>
      <button class="ol-menu-item" @click="menuAction((r) => setHeading(r, 3))">标题 3 <kbd>Alt+3</kbd></button>
      <button class="ol-menu-item" @click="menuAction((r) => setHeading(r, 0))">正文 <kbd>Alt+4</kbd></button>
      <div class="ol-menu-sep"></div>
      <button
        v-if="menuRow()?.hasChildren"
        class="ol-menu-item"
        @click="menuAction((r) => toggleFold(r))"
      >
        {{ menuRow()?.node.fold ? '展开子级' : '折叠子级' }}
      </button>
      <button
        v-if="menuRow()?.hasChildren"
        class="ol-menu-item"
        @click="menuAction((r) => drillInto(r))"
      >
        进入该节点 <kbd>Ctrl+[</kbd>
      </button>
      <button
        v-if="menuRow()?.node.ref"
        class="ol-menu-item"
        @click="menuAction((r) => openSourceFromNode(r.node))"
      >
        在文档库打开来源
      </button>
      <button class="ol-menu-item" @click="menuAction(() => duplicateSelected())">复制节点 <kbd>Ctrl+D</kbd></button>
      <div class="ol-menu-sep"></div>
      <button class="ol-menu-item danger" @click="menuAction(() => deleteSelected())">删除节点 <kbd>Del</kbd></button>
    </div>

    <!-- 富文本浮动工具栏 -->
    <Transition name="menu-pop">
      <div
        v-if="toolbar.visible"
        class="ol-toolbar"
        :class="{ below: toolbar.below }"
        :style="{ left: toolbar.left + 'px', top: toolbar.top + 'px' }"
        @mousedown.prevent
      >
        <button class="ol-tb" title="加粗 Ctrl+B" @click="applyInlineFormat('bold')"><b>B</b></button>
        <button class="ol-tb" title="斜体 Ctrl+I" @click="applyInlineFormat('italic')"><i>I</i></button>
        <button class="ol-tb" title="下划线 Ctrl+U" @click="applyInlineFormat('underline')"><u>U</u></button>
        <button class="ol-tb" title="删除线 Ctrl+Enter" @click="applyInlineFormat('strikeThrough')"><s>S</s></button>
        <button class="ol-tb mono" title="行内代码" @click="applyCode">&lt;/&gt;</button>
        <span class="ol-tb-sep"></span>
        <button
          v-for="c in ['#fff3a6', '#ffd6e7', '#cfe8ff', '#d6f5d6', '#eadcff']"
          :key="c"
          class="ol-swatch"
          :style="{ background: c }"
          title="高亮"
          @click="applyInlineFormat('hiliteColor', c)"
        ></button>
        <span class="ol-tb-sep"></span>
        <button
          v-for="c in ['#c0392b', '#e67e22', '#2e8b57', '#2471c8', '#7d5bc4']"
          :key="c"
          class="ol-swatch text"
          :style="{ background: c }"
          title="文字颜色"
          @click="applyInlineFormat('foreColor', c)"
        ></button>
        <span class="ol-tb-sep"></span>
        <button class="ol-tb faint" title="清除格式" @click="applyInlineFormat('removeFormat')">清除</button>
      </div>
    </Transition>

    <!-- 插入引用浮层 -->
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

    <input ref="imageInput" type="file" accept="image/*" multiple class="ol-file" @change="onPickImages" />

    <div v-if="imagePreview" class="ol-image-preview" @click="imagePreview = null">
      <img :src="imagePreview" alt="" @click.stop />
      <button class="ol-image-preview-close" title="关闭" @click="imagePreview = null">✕</button>
    </div>
  </div>
</template>

<!-- 变量遮蔽：script 中 row 形参与模板类型推断用；显式保持类型可读性 -->
<style scoped>
.ol {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--lb-panel);
  position: relative;
}

/* ---------- 面包屑（钻取） ---------- */
.ol-breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 10px 32px 0;
  flex-shrink: 0;
  min-height: 34px;
  overflow: hidden;
}

.ol-crumb {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 7px;
  border: none;
  border-radius: 6px;
  background: none;
  font-size: 12px;
  color: var(--lb-muted);
}

.ol-crumb:hover {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.ol-crumb.on {
  color: var(--lb-text);
  font-weight: 600;
}

.ol-crumb-sep {
  color: var(--lb-muted);
  font-size: 11px;
}

/* ---------- 头部 ---------- */
.ol-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 40px 16px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--lb-border);
  margin: 0 8px;
}

.ol-head.head-map {
  padding-bottom: 12px;
}

.ol-title {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  font-size: 26px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--lb-text);
  letter-spacing: -0.01em;
  padding: 2px 6px;
  margin-left: -6px;
  border-radius: 8px;
}

.ol-title::placeholder {
  color: var(--lb-muted);
  font-weight: 400;
}

.ol-title:hover {
  background: var(--lb-chip);
}

.ol-title:focus {
  outline: none;
  background: var(--lb-chip);
  box-shadow: inset 0 0 0 1px var(--lb-accent-2);
}

.ol-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.ol-insert-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 5px 11px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 10px;
  background: var(--lb-panel);
  font-size: 12px;
  color: var(--lb-text);
  white-space: nowrap;
}

.ol-insert-btn:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.ol-ico {
  font-size: 13px;
}

.ol-view-switch {
  display: inline-flex;
  padding: 2px;
  border-radius: 10px;
  background: var(--lb-chip);
}

.ol-view-switch button {
  padding: 4px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 12px;
  color: var(--lb-muted);
}

.ol-view-switch button:hover {
  color: var(--lb-text);
}

.ol-view-switch button.on {
  background: var(--lb-panel);
  color: var(--lb-text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.ol-menu-wrap {
  position: relative;
}

.ol-more {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--lb-muted);
  font-size: 16px;
  line-height: 1;
}

.ol-more:hover {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.ol-menu,
.ol-row-menu {
  position: absolute;
  z-index: 500;
  min-width: 196px;
  padding: 5px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-2);
}

.ol-row-menu {
  position: fixed;
  z-index: 900;
  max-height: 70vh;
  overflow-y: auto;
}

.ol-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 7px 11px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--lb-text);
  font-size: 13px;
  text-align: left;
}

.ol-menu-item:hover {
  background: var(--lb-chip);
}

.ol-menu-item kbd {
  font-family: inherit;
  font-size: 11px;
  color: var(--lb-muted);
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

/* ---------- 页面 ---------- */
.ol-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--lb-panel);
}

.ol-page {
  max-width: 872px;
  margin: 0 auto;
  padding: 26px 52px 0;
  min-height: calc(100% - 26px);
}

.ol-tree {
  padding-bottom: 40px;
}

.ol-row {
  display: flex;
  position: relative;
  align-items: flex-start;
  min-height: 30px;
  border-radius: 5px;
}

.ol-indent {
  position: relative;
  flex: 0 0 28px;
  width: 28px;
  align-self: stretch;
}

.ol-indent::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 12px;
  border-left: 1px solid var(--lb-border);
}

.ol-row:hover > .ol-indent::before {
  border-color: var(--lb-border-strong);
}

.ol-row.selected > .ol-indent::before {
  border-color: transparent;
}

.ol-row.selected > .ol-indent {
  background: linear-gradient(to right, transparent 12px, var(--lb-accent-soft) 12px);
}

.ol-node {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: flex-start;
  border-radius: 5px;
}

.ol-gutter {
  flex: 0 0 24px;
  display: flex;
  align-items: flex-start;
  height: 28px;
  padding-top: 2px;
  user-select: none;
  cursor: grab;
  position: relative;
}

.ol-fold,
.ol-fold-space {
  flex: 0 0 14px;
  width: 14px;
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
  opacity: 0;
  transition: opacity 0.15s ease;
}

.ol-fold svg {
  transition: transform 0.16s ease;
}

.ol-fold.open svg {
  transform: rotate(90deg);
}

.ol-row:hover .ol-fold,
.ol-fold:not(.open),
.ol-fold-space {
  opacity: 1;
}

.ol-fold:hover {
  color: var(--lb-text);
}

.ol-bullet {
  width: 18px;
  height: 18px;
  margin-top: 3px;
  margin-left: 2px;
  border-radius: 50%;
  background: transparent;
  transition: background 0.16s ease;
  position: relative;
}

.ol-bullet::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: #6e6e73;
}

.ol-bullet.ref::after {
  display: none;
}

.ol-bullet.ref {
  font-size: 13px;
  line-height: 18px;
  text-align: center;
}

.ol-gutter:hover .ol-bullet {
  background: var(--lb-chip);
}

.ol-gutter:hover .ol-bullet::after {
  background: var(--lb-text);
}

.ol-bullet.collapsed {
  background: var(--lb-border);
}

.ol-count {
  font-size: 11px;
  line-height: 24px;
  color: var(--lb-muted);
  padding-left: 2px;
}

.ol-content {
  flex: 1;
  min-width: 0;
  padding: 2px 64px 2px 7px;
  border-radius: 5px;
  transition: background-color 0.1s linear;
}

.ol-row:hover .ol-content {
  background: var(--lb-accent-soft);
}

.ol-row.selected .ol-content {
  background: rgba(0, 113, 227, 0.14);
}

.ol-row.selected .ol-content ::selection {
  background: rgba(0, 113, 227, 0.22);
}

.ol-row.dragging {
  opacity: 0.45;
}

.ol-row.drop-child .ol-content {
  box-shadow: inset 0 0 0 2px var(--lb-accent-2);
}

.ol-line {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  min-height: 25px;
}

.ol-line :deep(.ol-text) {
  padding-top: 2px;
  padding-bottom: 2px;
}

.ol-row.heading-1 :deep(.ol-text) {
  font-size: 24px;
  line-height: 1.5;
  font-weight: 500;
}

.ol-row.heading-2 :deep(.ol-text) {
  font-size: 21px;
  line-height: 1.5;
  font-weight: 500;
}

.ol-row.heading-3 :deep(.ol-text) {
  font-size: 18px;
  line-height: 1.55;
  font-weight: 500;
}

.ol-row.is-ref .ol-line :deep(.ol-text) {
  font-family: var(--lb-serif);
  color: var(--lb-accent);
}

.ol-row.task-done :deep(.ol-text) {
  opacity: 0.5;
  text-decoration: line-through;
}

.ol-task {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 6px 0 0 2px;
  accent-color: var(--lb-accent);
  cursor: pointer;
}

.ol-hover-actions {
  position: absolute;
  top: 2px;
  right: 6px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.ol-row:hover .ol-hover-actions,
.ol-row.selected .ol-hover-actions {
  opacity: 1;
}

.ol-act {
  width: 23px;
  height: 23px;
  border: none;
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-muted);
  font-size: 14px;
  line-height: 1;
  box-shadow: 0 0 0 1px var(--lb-border);
}

.ol-act:hover {
  color: var(--lb-accent);
  box-shadow: 0 0 0 1px var(--lb-accent-2);
}

/* ---------- 备注 ---------- */
.ol-note {
  margin: 1px 0 2px 1px;
  padding: 1px 0 1px 14px;
  border-left: 1px solid var(--lb-border);
}

.ol-note-input {
  display: block;
  width: 100%;
  min-height: 22px;
  padding: 2px 4px;
  border: none;
  background: transparent;
  resize: none;
  overflow: hidden;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.65;
  color: var(--lb-muted);
}

.ol-note-input::placeholder {
  color: var(--lb-muted);
  opacity: 0.7;
}

.ol-note-input:focus {
  outline: none;
  color: var(--lb-text);
}

/* ---------- 图片 ---------- */
.ol-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0 6px;
}

.ol-image-wrap {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

.ol-img {
  display: block;
  width: auto;
  max-width: min(420px, 100%);
  max-height: 260px;
  border-radius: 10px;
  border: 1px solid var(--lb-border);
  cursor: zoom-in;
}

.ol-img-del {
  position: absolute;
  top: -7px;
  right: -7px;
  width: 20px;
  height: 20px;
  border: 2px solid var(--lb-panel);
  border-radius: 50%;
  background: var(--lb-err-fg);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  display: none;
  align-items: center;
  justify-content: center;
}

.ol-image-wrap:hover .ol-img-del {
  display: flex;
}

.ol-file {
  display: none;
}

.ol-image-preview {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 20, 24, 0.72);
  padding: 36px;
}

.ol-image-preview img {
  max-width: 92vw;
  max-height: 88vh;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.ol-image-preview-close {
  position: absolute;
  top: 18px;
  right: 20px;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  font-size: 14px;
}

.ol-image-preview-close:hover {
  background: rgba(255, 255, 255, 0.28);
}

/* ---------- 底部补行 ---------- */
.ol-append {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
  padding: 7px 10px 7px 38px;
  border: none;
  background: none;
  font-size: 13px;
  color: var(--lb-muted);
  border-radius: 6px;
  text-align: left;
}

.ol-append:hover {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.ol-append-plus {
  font-size: 14px;
}

.ol-tail {
  min-height: 30vh;
  cursor: text;
}

/* ---------- 拖拽 ---------- */
.ol-drag-ghost {
  position: fixed;
  z-index: 1000;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.ol-drag-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--lb-accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}

.ol-drag-count {
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--lb-text);
  color: var(--lb-panel);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.ol-drop-line {
  position: fixed;
  z-index: 999;
  height: 2px;
  border-radius: 1px;
  background: var(--lb-accent);
  pointer-events: none;
  box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.15);
}

/* ---------- 浮动格式工具栏 ---------- */
.ol-toolbar {
  position: fixed;
  z-index: 950;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: 10px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.14);
  transform: translate(-50%, -100%);
}

.ol-toolbar.below {
  transform: translate(-50%, 0);
}

.ol-tb {
  min-width: 26px;
  height: 26px;
  padding: 0 5px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--lb-text);
  font-size: 13px;
  line-height: 1;
}

.ol-tb:hover {
  background: var(--lb-chip);
}

.ol-tb.mono {
  font-family: monospace;
  font-size: 11px;
}

.ol-tb.faint {
  color: var(--lb-muted);
  font-size: 11px;
}

.ol-tb-sep {
  width: 1px;
  height: 18px;
  margin: 0 3px;
  background: var(--lb-border);
}

.ol-swatch {
  width: 17px;
  height: 17px;
  margin: 0 1px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 5px;
}

.ol-swatch:hover {
  transform: scale(1.1);
}

.ol-swatch.text {
  border-radius: 50%;
}

/* ---------- 引用浮层 ---------- */
.ol-picker {
  position: fixed;
  inset: 0;
  z-index: 1100;
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

/* 拖动时关闭文本选择 */
:global(body.ol-dragging) {
  user-select: none;
  cursor: grabbing;
}
</style>
