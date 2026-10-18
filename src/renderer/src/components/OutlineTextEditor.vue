<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { escapeHtml, normalizeEditorHtml, plainTextFromHtml } from '@shared/outlineRichText'

/**
 * 单行内容编辑区（contenteditable）。
 * 为什么不用 textarea：大纲行需要行内格式（加粗/高亮/颜色/链接），textarea 做不了。
 * 关键约定：组件内部 DOM 不被 Vue 响应式改写——外部要换内容必须 bump syncToken，
 * 否则每次输入都会重设 innerHTML，光标会被打回行首。
 */
const props = defineProps<{
  /** 纯文本镜像（初始值；输入时由本组件向外回传） */
  text: string
  /** 富文本初始值（可选） */
  html?: string
  /** 外部内容变更令牌：变化时重设 DOM（撤销/切换笔记/导入等） */
  syncToken: number
  placeholder?: string
  ariaLabel?: string
}>()

const emit = defineEmits<{
  (e: 'change', payload: { text: string; html: string }): void
  (e: 'keydown', ev: KeyboardEvent): void
  (e: 'paste', ev: ClipboardEvent): void
  (e: 'focus', ev: FocusEvent): void
  (e: 'blur', ev: FocusEvent): void
  (e: 'select'): void
}>()

const el = ref<HTMLElement | null>(null)
let composing = false
let pendingCompositionEmit = false

const PURIFY = {
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'span', 'a', 'code', 'br', 'mark', 'font'],
  ALLOWED_ATTR: ['href', 'style'],
  ALLOW_DATA_ATTR: false
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, PURIFY)
}

function initialHtml(): string {
  if (props.html) {
    const clean = sanitize(props.html)
    if (clean) return clean
  }
  return escapeHtml(props.text).replace(/\n/g, '<br>')
}

/** 只在挂载/显式同步时写 DOM */
function render(): void {
  if (!el.value) return
  el.value.innerHTML = initialHtml()
}

function content(): { text: string; html: string } {
  if (!el.value) return { text: '', html: '' }
  const html = normalizeEditorHtml(sanitize(el.value.innerHTML))
  return { text: plainTextFromHtml(html), html }
}

function emitChange(): void {
  const c = content()
  emit('change', c)
}

function onInput(): void {
  if (composing) {
    pendingCompositionEmit = true
    return
  }
  emitChange()
}

function onCompositionStart(): void {
  composing = true
}

function onCompositionEnd(): void {
  composing = false
  if (pendingCompositionEmit) {
    pendingCompositionEmit = false
    emitChange()
  }
}

function selectionInside(): Selection | null {
  if (!el.value) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  return el.value.contains(range.commonAncestorContainer) ? sel : null
}

function onSelect(): void {
  emit('select')
}

/** 失焦时把「只有 br/零宽」的编辑区归一化为空，让占位文案重新生效 */
function onBlur(ev: FocusEvent): void {
  if (el.value && !content().text.trim()) el.value.innerHTML = ''
  emit('blur', ev)
}

/** 内容是否为空（只有零宽/br 也算空） */
function isEmpty(): boolean {
  return content().text.trim() === ''
}

/** 光标在当前编辑区的纯文本偏移 */
function caretOffset(): number {
  if (!el.value) return 0
  const sel = selectionInside()
  if (!sel) return 0
  const range = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(el.value)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

/** 把光标放到纯文本偏移处（越界钳制） */
function focusOffset(offset: number | 'end' | 'start' = 'end'): void {
  if (!el.value) return
  el.value.focus()
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  let remaining = offset === 'end' ? Number.MAX_SAFE_INTEGER : offset === 'start' ? 0 : offset
  let placed = false
  const walker = document.createTreeWalker(el.value, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Text | null
  while (node) {
    const len = node.data.length
    if (remaining <= len) {
      range.setStart(node, remaining)
      range.collapse(true)
      placed = true
      break
    }
    remaining -= len
    node = walker.nextNode() as Text | null
  }
  if (!placed) {
    range.selectNodeContents(el.value)
    range.collapse(false)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * 在光标处拆行：返回前后两段的文本与 HTML。DOM 保留前半段，后半段被摘出。
 * 父级负责把后半段放进新节点并重挂组件（syncToken 会重设 DOM）。
 */
function splitAtCaret(): { beforeText: string; afterText: string; beforeHtml: string; afterHtml: string } | null {
  if (!el.value) return null
  const sel = selectionInside()
  if (!sel) return null
  const range = sel.getRangeAt(0)
  const tail = document.createRange()
  tail.selectNodeContents(el.value)
  tail.setStart(range.endContainer, range.endOffset)
  const frag = tail.extractContents()
  const wrap = document.createElement('div')
  wrap.appendChild(frag)
  const afterHtml = normalizeEditorHtml(sanitize(wrap.innerHTML))
  const beforeHtml = normalizeEditorHtml(sanitize(el.value.innerHTML))
  // 清掉拆行后残留的空行
  if (!el.value.textContent?.trim()) el.value.innerHTML = ''
  return {
    beforeText: plainTextFromHtml(beforeHtml),
    afterText: plainTextFromHtml(afterHtml),
    beforeHtml,
    afterHtml
  }
}

/** 插入已消毒 HTML（粘贴行内格式用） */
function insertHtml(html: string): void {
  if (!el.value) return
  el.value.focus()
  document.execCommand('insertHTML', false, sanitize(html))
  emitChange()
}

/** 选中当前行全部内容（用于整行加粗等） */
function selectAll(): void {
  if (!el.value) return
  el.value.focus()
  const range = document.createRange()
  range.selectNodeContents(el.value)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** 选区是否非空且在本编辑区内 */
function hasTextSelection(): boolean {
  const sel = selectionInside()
  return !!sel && !sel.isCollapsed
}

/** 选区矩形（浮动工具栏定位） */
function selectionRect(): DOMRect | null {
  const sel = selectionInside()
  if (!sel || sel.isCollapsed) return null
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) return null
  return rect
}

/** 执行行内格式命令（Chromium 的 execCommand 仍是 contenteditable 最稳路径） */
function format(command: 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'hiliteColor' | 'foreColor' | 'removeFormat' | 'insertHTML', value?: string): void {
  if (!el.value) return
  el.value.focus()
  try {
    document.execCommand('styleWithCSS', false, 'true')
    document.execCommand(command, false, value)
  } catch {
    /* 命令不支持时静默（不打断输入） */
  }
  emitChange()
  emit('select')
}

defineExpose({
  el,
  content,
  isEmpty,
  caretOffset,
  focusOffset,
  splitAtCaret,
  insertHtml,
  selectAll,
  hasTextSelection,
  selectionRect,
  format
})

onMounted(render)
watch(
  () => props.syncToken,
  () => {
    // 等父级把最新 text/html 传下来再写 DOM（否则会读到上一帧的 props）
    void nextTick(render)
  }
)
</script>

<template>
  <div
    ref="el"
    class="ol-text"
    contenteditable="true"
    spellcheck="false"
    role="textbox"
    :aria-label="ariaLabel"
    :data-placeholder="placeholder"
    @input="onInput"
    @keydown="emit('keydown', $event)"
    @paste="emit('paste', $event)"
    @focus="emit('focus', $event)"
    @blur="onBlur"
    @mouseup="onSelect"
    @keyup="onSelect"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
  ></div>
</template>

<style scoped>
.ol-text {
  flex: 1;
  min-width: 0;
  min-height: 1.6em;
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  font-size: 16px;
  line-height: 1.6;
  color: var(--lb-text);
  padding: 2px 4px;
  border-radius: 4px;
  caret-color: var(--lb-accent);
}

.ol-text:empty::before {
  content: attr(data-placeholder);
  color: var(--lb-muted);
  pointer-events: none;
}

.ol-text ::selection {
  background: rgba(0, 113, 227, 0.18);
}

.ol-text a {
  color: var(--lb-accent);
  text-decoration: underline;
  cursor: pointer;
}

.ol-text code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--lb-chip);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 0.92em;
}

.ol-text font[color] {
  color: inherit;
}
</style>
