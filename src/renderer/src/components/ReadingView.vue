<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmModal from './ConfirmModal.vue'
import type { BookNoteRow, DocumentDetail, ExportFormat } from '@shared/types'

/**
 * 沉浸阅读器（doc_type='book'），双模式：
 * - 文字模式（docx/txt）：chunks 渲染段落，划选记笔记 → <mark class="bn"> 高亮恢复
 * - 页面模式（.pdf）：系统内置 PDF 阅读器（iframe file://）呈现原书页面，批注按页码记录
 */
const props = defineProps<{
  /** 书籍详情：chunks 每项即一段；批注 start_para/end_para 与 chunk.seq 对应 */
  doc: DocumentDetail
  /** 进入时定位的段落 seq（检索命中传入，定位后短暂高亮）；缺省走阅读进度恢复 */
  focusPara?: number
}>()

const emit = defineEmits<{
  /** 返回（App 恢复原 Tab） */
  back: []
  error: [message: string]
  /** 导出成功等正向反馈，转全局消息条 */
  notice: [text: string]
}>()

const scrollEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)
const sideEl = ref<HTMLElement | null>(null)
const noteAreaEl = ref<HTMLTextAreaElement | null>(null)

const showSide = ref(true)

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

// ---------- 批注数据 ----------

const notes = ref<BookNoteRow[]>([])

async function reloadNotes(): Promise<void> {
  try {
    notes.value = await window.lexbench.reading.listBookNotes(props.doc.id)
  } catch (e) {
    emit('error', errText(e))
  }
}

/** 批注栏列表顺序：按起段 → 起偏移 */
const sortedNotes = computed(() =>
  [...notes.value].sort((a, b) => a.start_para - b.start_para || a.start_offset - b.start_offset)
)

// ---------- 段落切片：把批注区间包进 <mark class="bn">（支持跨段批注） ----------

interface Seg {
  text: string
  noteId?: number
}
const EMPTY_SEGS: Seg[] = []

/** 段落 seq → 切片数组；批注覆盖本段时：起段从 start_offset 到段尾、止段从段首到 end_offset、
 *  中间段整段包裹；重叠区间以先出现的批注为准 */
const segByPara = computed(() => {
  const map = new Map<number, Seg[]>()
  for (const c of props.doc.chunks) {
    const text = c.content
    const seq = c.seq
    const list = notes.value
      .filter((n) => n.start_para <= seq && seq <= n.end_para)
      .sort((a, b) => a.start_para - b.start_para || a.start_offset - b.start_offset)
    const segs: Seg[] = []
    let pos = 0
    for (const n of list) {
      const rawStart = seq === n.start_para ? n.start_offset : 0
      const rawEnd = seq === n.end_para ? n.end_offset : text.length
      const s = Math.max(pos, Math.min(rawStart, text.length))
      const e = Math.max(s, Math.min(rawEnd, text.length))
      if (s > pos) segs.push({ text: text.slice(pos, s) })
      if (e > s) segs.push({ text: text.slice(s, e), noteId: n.id })
      pos = Math.max(pos, e)
    }
    if (pos < text.length) segs.push({ text: text.slice(pos) })
    map.set(seq, segs)
  }
  return map
})

// ---------- 划选 → 浮动「记笔记」按钮 → 小表单 ----------

interface SelBox {
  top: number
  left: number
}
interface PendingSel {
  startPara: number
  startOffset: number
  endPara: number
  endOffset: number
  quote: string
  rect: DOMRect
}

/** 待成文选区（mouseup 后直接转成 form） */
let pendingSel: PendingSel | null = null
const form = ref<
  (SelBox & {
    quote: string
    /** 页笔记模式：不显示引用，显示「第 N 页」 */
    pageLabel?: string
    startPara: number
    startOffset: number
    endPara: number
    endOffset: number
  }) | null
>(null)
const draft = ref('')
const saving = ref(false)

function clampX(x: number): number {
  return Math.min(Math.max(8, x), window.innerWidth - 8)
}

/** Range 起点到段首的文本偏移（Range.toString 按 textContent 计，与高亮切片口径一致） */
function textOffsetTo(pEl: HTMLElement, container: Node, offset: number): number {
  const r = document.createRange()
  r.selectNodeContents(pEl)
  try {
    r.setEnd(container, offset)
  } catch {
    return 0
  }
  return r.toString().length
}

function paraOfNode(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null
  return el ? (el.closest('p[data-para]') as HTMLElement | null) : null
}

/** 由起止锚点拼出划选原文（跨段以 \n 相接，与 book_notes.quote 口径一致） */
function buildQuote(startPara: number, startOffset: number, endPara: number, endOffset: number): string {
  const textOf = (seq: number): string =>
    props.doc.chunks.find((c) => c.seq === seq)?.content ?? ''
  if (endPara === startPara) return textOf(startPara).slice(startOffset, endOffset)
  const parts: string[] = [textOf(startPara).slice(startOffset)]
  for (let s = startPara + 1; s < endPara; s++) parts.push(textOf(s))
  parts.push(textOf(endPara).slice(0, endOffset))
  return parts.join('\n')
}

function closeSelectionUi(): void {
  pendingSel = null
  if (form.value) cancelForm()
}

function onContentMousedown(): void {
  // 在正文里重新按下鼠标：收起上一轮划选（表单若有草稿即放弃）
  if (form.value) cancelForm()
  else pendingSel = null
}

function onMouseUp(): void {
  const sel = window.getSelection()
  const content = contentEl.value
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !content) {
    closeSelectionUi()
    return
  }
  const range = sel.getRangeAt(0)
  if (!content.contains(range.commonAncestorContainer)) {
    closeSelectionUi()
    return
  }
  const startP = paraOfNode(range.startContainer)
  const endP = paraOfNode(range.endContainer)
  if (!startP || !endP) {
    closeSelectionUi()
    return
  }
  const startPara = Number(startP.dataset.para)
  const endPara = Number(endP.dataset.para)
  const startOffset = textOffsetTo(startP, range.startContainer, range.startOffset)
  const endOffset = textOffsetTo(endP, range.endContainer, range.endOffset)
  const quote = buildQuote(startPara, startOffset, endPara, endOffset)
  if (!quote.trim()) {
    closeSelectionUi()
    return
  }
  pendingSel = {
    startPara,
    startOffset,
    endPara,
    endOffset,
    quote,
    rect: range.getBoundingClientRect()
  }
  // 一选中直接弹批注表单（段内/跨段同一流程，不设中间按钮）
  openForm()
}

const POP_W = 360
const POP_H = 300 // 估高：引文 + 输入 + 按钮

function openForm(): void {
  const sel = pendingSel
  if (!sel) return
  // 大段划选时选区矩形会超出视口：先尝试放选区下方，放不下放上方，再放不下贴视口底部
  const vh = window.innerHeight
  let top = sel.rect.bottom + 12
  if (top + POP_H > vh - 8) top = sel.rect.top - POP_H - 12
  if (top < 8 || top + POP_H > vh - 8) top = vh - POP_H - 8
  top = Math.min(Math.max(8, top), Math.max(8, vh - POP_H - 8))
  const left = clampX(sel.rect.left + sel.rect.width / 2 - POP_W / 2)
  form.value = {
    top,
    left: Math.min(Math.max(8, left), window.innerWidth - POP_W - 8),
    quote: sel.quote,
    startPara: sel.startPara,
    startOffset: sel.startOffset,
    endPara: sel.endPara,
    endOffset: sel.endOffset
  }
  draft.value = ''
  void nextTick(() => noteAreaEl.value?.focus())
}

function cancelForm(): void {
  form.value = null
  draft.value = ''
  pendingSel = null
  window.getSelection()?.removeAllRanges()
}

async function saveNote(): Promise<void> {
  if (!form.value || saving.value) return
  const contentMd = draft.value.trim()
  if (!contentMd) return
  saving.value = true
  try {
    await window.lexbench.reading.createBookNote(props.doc.id, {
      contentMd,
      quote: form.value.quote,
      startPara: form.value.startPara,
      startOffset: form.value.startOffset,
      endPara: form.value.endPara,
      endOffset: form.value.endOffset
    })
    cancelForm()
    await reloadNotes()
  } catch (e) {
    emit('error', errText(e))
  } finally {
    saving.value = false
  }
}

// ---------- 批注栏：编辑 / 删除 / 定位 ----------

const editingId = ref(0)
const editDraft = ref('')
const editSaving = ref(false)
const pendingDel = ref<BookNoteRow | null>(null)
const activeNoteId = ref(0)
const sideFlashId = ref(0)
const flashNote = ref(0)
const flashPara = ref(-1)

let sideFlashTimer: ReturnType<typeof setTimeout> | undefined
let noteFlashTimer: ReturnType<typeof setTimeout> | undefined
let paraFlashTimer: ReturnType<typeof setTimeout> | undefined

const delMessage = computed(() =>
  pendingDel.value ? '确定删除这条批注？原文高亮将一并移除，此操作不可撤销。' : ''
)

function briefQuote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 40 ? t.slice(0, 40) + '…' : t
}

function fmtTime(s: string): string {
  return (s || '').replace('T', ' ').slice(0, 16)
}

function startEditNote(n: BookNoteRow): void {
  editingId.value = n.id
  editDraft.value = n.content_md
}

async function saveEdit(): Promise<void> {
  const id = editingId.value
  const contentMd = editDraft.value.trim()
  if (!id || !contentMd || editSaving.value) return
  editSaving.value = true
  try {
    await window.lexbench.reading.updateBookNote(id, contentMd)
    editingId.value = 0
    await reloadNotes()
  } catch (e) {
    emit('error', errText(e))
  } finally {
    editSaving.value = false
  }
}

async function confirmDel(): Promise<void> {
  const n = pendingDel.value
  if (!n) return
  pendingDel.value = null
  try {
    await window.lexbench.reading.deleteBookNote(n.id)
    if (activeNoteId.value === n.id) activeNoteId.value = 0
    await reloadNotes()
  } catch (e) {
    emit('error', errText(e))
  }
}

/** 点正文 mark → 批注栏定位到该条并高亮 */
function onMarkClick(noteId: number): void {
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) return // 有划选时不触发定位
  if (!notes.value.some((n) => n.id === noteId)) return
  activeNoteId.value = noteId
  sideEl.value?.querySelector(`[data-note-id="${noteId}"]`)?.scrollIntoView({ block: 'nearest' })
  sideFlashId.value = noteId
  clearTimeout(sideFlashTimer)
  sideFlashTimer = setTimeout(() => (sideFlashId.value = 0), 1600)
}

/** 点批注列表项 → 文字模式滚到段落 / 页面模式跳到对应页 */
function openNoteFromList(n: BookNoteRow): void {
  activeNoteId.value = n.id
  if (isPdf.value) {
    jumpToPdfPage(n.start_para + 1)
  } else {
    const el = scrollEl.value
    const p = el?.querySelector<HTMLElement>(`p[data-para="${n.start_para}"]`)
    if (el && p) {
      el.scrollTo({
        top: Math.max(0, p.offsetTop - el.clientHeight / 2 + p.clientHeight / 2),
        behavior: 'smooth'
      })
    }
  }
  flashNote.value = n.id
  clearTimeout(noteFlashTimer)
  noteFlashTimer = setTimeout(() => (flashNote.value = 0), 1800)
}

// ---------- 阅读进度 ----------

let progTimer: ReturnType<typeof setTimeout> | undefined
let lastSaved: number | null = null
const RESTORE_PAD = 88 // 回到上次位置时顶部留白补偿

const backHint = ref(false)
let backHintTimer: ReturnType<typeof setTimeout> | undefined

function onScroll(): void {
  // 页面模式（内置阅读器）不在此追踪进度：进度在「本页笔记」时按页码保存
  if (isPdf.value) return
  if (progTimer) return
  progTimer = setTimeout(() => {
    progTimer = undefined
    void saveProgressNow()
  }, 500)
}

/** 找视口顶部可见段落的 data-para 存为进度（文字模式） */
async function saveProgressNow(): Promise<void> {
  const el = scrollEl.value
  if (!el) return
  const box = el.getBoundingClientRect()
  const paras = el.querySelectorAll<HTMLElement>('p[data-para]')
  let found = false
  let seq = 0
  for (const p of paras) {
    if (p.getBoundingClientRect().bottom >= box.top + 64) {
      seq = Number(p.dataset.para)
      found = true
      break
    }
  }
  if (!found && paras.length) seq = Number(paras[paras.length - 1].dataset.para)
  if (seq === lastSaved) return
  lastSaved = seq
  try {
    await window.lexbench.reading.saveProgress(props.doc.id, seq)
  } catch (e) {
    emit('error', errText(e))
  }
}

/** 滚动定位到段落：start=顶部留白补偿；center=居中（文字模式） */
function scrollToSeq(seq: number, mode: 'start' | 'center'): void {
  const el = scrollEl.value
  if (!el) return
  const p = el.querySelector<HTMLElement>(`p[data-para="${seq}"]`)
  if (!p) return
  const target =
    mode === 'center'
      ? p.offsetTop - el.clientHeight / 2 + p.clientHeight / 2
      : p.offsetTop - RESTORE_PAD
  el.scrollTop = Math.max(0, target)
}

function flashParaSeq(seq: number): void {
  flashPara.value = seq
  clearTimeout(paraFlashTimer)
  paraFlashTimer = setTimeout(() => (flashPara.value = -1), 2000)
}

// ---------- PDF 页面模式 ----------

// 采用系统内置 Chromium PDF 引擎（iframe 以 file:// 加载原件）：翻页/缩放/搜索由内置
// 阅读器负责，兼容各类扫描件；批注按「页码 + 想法」记录（页笔记）。自研 pdfjs 渲染
// 对部分扫描件（内容流非标准）读不出内容，已弃用。

const isPdf = computed(() => props.doc.file_ext === '.pdf')
/** PDF 书籍一页一 chunk：chunk 数即总页数 */
const pdfTotal = computed(() => props.doc.chunks.length)
/** 原件字节的 blob 地址（http 页面不能直接载入 file://，用 blob 喂内置阅读器） */
const pdfBlob = ref<Blob | null>(null)
const pdfBlobUrl = ref('')
/** 当前页（1 基）：用于跳页与页笔记定位 */
const pdfPage = ref(1)
const notePageInput = ref(1)

const pdfViewerUrl = computed(() =>
  pdfBlobUrl.value ? `${pdfBlobUrl.value}#page=${pdfPage.value}&zoom=page-width` : ''
)

/** 用当前页码重建 blob 地址（内置阅读器按 URL 片段跳页，换地址即重新定位） */
function rebuildBlobUrl(): void {
  const blob = pdfBlob.value
  if (!blob) return
  if (pdfBlobUrl.value) URL.revokeObjectURL(pdfBlobUrl.value)
  pdfBlobUrl.value = URL.createObjectURL(blob)
}

async function loadPdf(): Promise<void> {
  try {
    const buf = await window.lexbench.reading.getPdfData(props.doc.id)
    pdfBlob.value = new Blob([buf], { type: 'application/pdf' })
    if (props.focusPara !== undefined) {
      // 检索命中进入：直达对应页
      pdfPage.value = props.focusPara + 1
      notePageInput.value = props.focusPara + 1
    } else {
      const prog = await window.lexbench.reading.getProgress(props.doc.id)
      if (prog && prog.paraIndex >= 0) {
        pdfPage.value = prog.paraIndex + 1
        notePageInput.value = prog.paraIndex + 1
        backHint.value = true
        clearTimeout(backHintTimer)
        backHintTimer = setTimeout(() => (backHint.value = false), 4000)
      }
    }
    rebuildBlobUrl()
  } catch (e) {
    emit('error', `PDF 打开失败：${errText(e)}`)
  }
}

/** 跳到指定页（1 基）：重建地址让内置阅读器定位 */
function jumpToPdfPage(page: number): void {
  pdfPage.value = Math.min(Math.max(1, Math.round(page)), Math.max(1, pdfTotal.value))
  notePageInput.value = pdfPage.value
  rebuildBlobUrl()
}

/** 工具条「✎ 本页笔记」：按输入框页码创建批注，并同步阅读进度 */
function openPageNoteForm(): void {
  const p = Math.min(
    Math.max(1, Math.round(Number(notePageInput.value) || pdfPage.value)),
    Math.max(1, pdfTotal.value)
  )
  pdfPage.value = p
  notePageInput.value = p
  void window.lexbench.reading.saveProgress(props.doc.id, p - 1).catch(() => {})
  const vh = window.innerHeight
  form.value = {
    top: Math.max(8, Math.round(vh / 2 - POP_H / 2)),
    left: Math.max(8, Math.round(window.innerWidth / 2 - POP_W / 2)),
    quote: '',
    pageLabel: `第 ${p} 页`,
    startPara: p - 1,
    startOffset: 0,
    endPara: p - 1,
    endOffset: 0
  }
  draft.value = ''
  void nextTick(() => noteAreaEl.value?.focus())
}

// ---------- 导出笔记 ----------

const exporting = ref(false)

async function exportNotes(format: ExportFormat): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const r = await window.lexbench.export.saveBookNotes(props.doc.id, format)
    if (!r.canceled && r.path) emit('notice', `笔记已导出到 ${r.path}`)
  } catch (e) {
    emit('error', errText(e))
  } finally {
    exporting.value = false
  }
}

// ---------- 生命周期 ----------

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (form.value) cancelForm()
  else pendingSel = null
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await reloadNotes()
  if (isPdf.value) {
    // 页面模式：内置 PDF 阅读器加载原件；进度/检索命中都以页为定位（loadPdf 内处理）
    await loadPdf()
    return
  }
  await nextTick()
  if (props.focusPara !== undefined) {
    // 检索命中进入：定位该段并短暂高亮
    scrollToSeq(props.focusPara, 'center')
    flashParaSeq(props.focusPara)
  } else {
    try {
      const prog = await window.lexbench.reading.getProgress(props.doc.id)
      if (prog) {
        lastSaved = prog.paraIndex
        scrollToSeq(prog.paraIndex, 'start')
        backHint.value = true
        clearTimeout(backHintTimer)
        backHintTimer = setTimeout(() => (backHint.value = false), 4000)
      }
    } catch (e) {
      emit('error', errText(e))
    }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (pdfBlobUrl.value) URL.revokeObjectURL(pdfBlobUrl.value)
  clearTimeout(progTimer)
  clearTimeout(backHintTimer)
  clearTimeout(sideFlashTimer)
  clearTimeout(noteFlashTimer)
  clearTimeout(paraFlashTimer)
})
</script>

<template>
  <div class="rv">
    <!-- 顶栏 -->
    <header class="rv-top">
      <button class="rv-back" @click="emit('back')">← 返回</button>
      <div class="rv-title-wrap">
        <h1 class="rv-title" :title="doc.title">{{ doc.title }}</h1>
        <transition name="rv-fade">
          <span v-if="backHint" class="rv-hint">已回到上次阅读位置</span>
        </transition>
      </div>
      <div class="rv-ops">
        <template v-if="isPdf">
          <span class="rv-page-ind">共 {{ pdfTotal }} 页</span>
          <label class="rv-page-jump">
            第
            <input
              v-model.number="notePageInput"
              class="rv-page-input"
              type="number"
              min="1"
              :max="pdfTotal"
              @keydown.enter="jumpToPdfPage(notePageInput)"
            />
            页
          </label>
          <button class="rv-top-btn" title="跳到该页" @click="jumpToPdfPage(notePageInput)">跳转</button>
          <button class="rv-top-btn" title="给该页记批注" @click="openPageNoteForm">✎ 本页笔记</button>
        </template>
        <button class="rv-top-btn" :disabled="exporting" title="导出批注为 Markdown" @click="exportNotes('md')">
          导出 .md
        </button>
        <button class="rv-top-btn" :disabled="exporting" title="导出批注为 Word" @click="exportNotes('docx')">
          导出 .docx
        </button>
        <button
          class="rv-top-btn side-toggle"
          :class="{ on: showSide }"
          :title="showSide ? '收起批注栏' : '展开批注栏'"
          @click="showSide = !showSide"
        >
          ☰
        </button>
      </div>
    </header>

    <div class="rv-main">
      <!-- PDF 页面模式：系统内置 PDF 阅读器（翻页/缩放/搜索由内置引擎负责） -->
      <div v-if="isPdf" class="rv-pdf-frame">
        <iframe
          v-if="pdfViewerUrl"
          :src="pdfViewerUrl"
          class="pdf-iframe"
          title="PDF 阅读器"
        ></iframe>
        <div v-else class="rv-pdf-loading">正在加载 PDF…</div>
      </div>
      <!-- 文字模式：滚动正文 -->
      <div
        v-else
        ref="scrollEl"
        class="rv-scroll"
        @mousedown="onContentMousedown"
        @mouseup="onMouseUp"
        @scroll="onScroll"
      >
        <div ref="contentEl" class="rv-col">
          <template v-for="c in doc.chunks" :key="c.id">
            <p
              v-if="c.content"
              class="para"
              :data-para="c.seq"
              :class="{ 'para-flash': c.seq === flashPara }"
            >
              <template v-for="(seg, i) in segByPara.get(c.seq) ?? EMPTY_SEGS" :key="i">
                <mark
                  v-if="seg.noteId"
                  class="bn"
                  :data-note-id="seg.noteId"
                  :class="{ flash: seg.noteId === flashNote }"
                  @click="onMarkClick(seg.noteId)"
                >{{ seg.text }}</mark>
                <template v-else>{{ seg.text }}</template>
              </template>
            </p>
          </template>
        </div>
      </div>

      <!-- 右批注栏 -->
      <aside v-show="showSide" class="rv-side">
        <div class="rv-side-head">
          <span class="rv-side-title">批注</span>
          <span class="rv-side-count">{{ notes.length }}</span>
        </div>
        <div ref="sideEl" class="rv-side-list">
          <div v-if="!sortedNotes.length" class="rv-side-empty">
            还没有批注。<br />划选正文任意文字即可记笔记。
          </div>
          <div
            v-for="n in sortedNotes"
            :key="n.id"
            class="rv-note"
            :data-note-id="n.id"
            :class="{ active: n.id === activeNoteId, flash: n.id === sideFlashId }"
            @click="openNoteFromList(n)"
          >
            <template v-if="editingId === n.id">
              <textarea v-model="editDraft" class="rv-note-edit" rows="4" :disabled="editSaving"></textarea>
              <div class="rv-note-ops" @click.stop>
                <span class="rv-flex"></span>
                <button class="rv-mini" :disabled="editSaving" @click="editingId = 0">取消</button>
                <button
                  class="rv-mini primary"
                  :disabled="editSaving || !editDraft.trim()"
                  @click="saveEdit"
                >
                  {{ editSaving ? '保存中…' : '保存' }}
                </button>
              </div>
            </template>
            <template v-else>
              <p v-if="n.quote" class="rv-note-quote">「{{ briefQuote(n.quote) }}」</p>
              <p v-else class="rv-note-quote"><span class="rv-note-page">第 {{ n.start_para + 1 }} 页</span></p>
              <p class="rv-note-body">{{ n.content_md }}</p>
              <div class="rv-note-foot">
                <span class="rv-note-time">{{ fmtTime(n.updated_at || n.created_at) }}</span>
                <span class="rv-flex"></span>
                <button class="rv-note-btn" title="编辑批注" @click.stop="startEditNote(n)">✎</button>
                <button class="rv-note-btn" title="删除批注" @click.stop="pendingDel = n">✕</button>
              </div>
            </template>
          </div>
        </div>
      </aside>
    </div>

    <!-- 记笔记小表单 -->
    <div v-if="form" class="rv-pop" :style="{ top: form.top + 'px', left: form.left + 'px' }">
      <div class="rv-pop-label">{{ form.pageLabel ? '批注位置' : '划选原文' }}</div>
      <div v-if="form.pageLabel" class="rv-pop-quote">{{ form.pageLabel }}</div>
      <div v-else class="rv-pop-quote">「{{ form.quote }}」</div>
      <textarea
        ref="noteAreaEl"
        v-model="draft"
        class="rv-pop-input"
        rows="4"
        placeholder="写下批注…（Ctrl+Enter 保存）"
        @keydown.ctrl.enter="saveNote"
        @keydown.meta.enter="saveNote"
      ></textarea>
      <div class="rv-pop-ops">
        <span class="rv-pop-tip">保存后原文将高亮标记</span>
        <span class="rv-flex"></span>
        <button class="rv-mini" :disabled="saving" @click="cancelForm">取消</button>
        <button class="rv-mini primary" :disabled="saving || !draft.trim()" @click="saveNote">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>

    <ConfirmModal
      :visible="pendingDel !== null"
      title="删除批注"
      :message="delMessage"
      danger
      confirm-text="删除"
      @confirm="confirmDel"
      @cancel="pendingDel = null"
    />
  </div>
</template>

<style scoped>
.rv {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--lb-panel);
}

/* ---------- 顶栏 ---------- */
.rv-top {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 52px;
  padding: 0 16px;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
  background: var(--lb-panel);
}

.rv-back {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
  flex-shrink: 0;
}

.rv-back:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.rv-title-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.rv-title {
  font-family: var(--lb-serif);
  font-size: 16px;
  font-weight: 600;
  color: var(--lb-text);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rv-hint {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--lb-ok-fg);
  background: var(--lb-ok-bg);
  padding: 2px 10px;
  border-radius: 999px;
}

.rv-fade-enter-active,
.rv-fade-leave-active {
  transition: opacity 0.3s ease;
}

.rv-fade-enter-from,
.rv-fade-leave-to {
  opacity: 0;
}

.rv-ops {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.rv-top-btn {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}

.rv-top-btn:hover:not(:disabled) {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.rv-top-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.rv-top-btn.side-toggle.on {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

/* ---------- 主区 ---------- */
.rv-main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.rv-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  position: relative; /* 段落 offsetTop 的定位基准 */
  background: var(--lb-panel);
}

.rv-col {
  max-width: 760px;
  margin: 0 auto;
  padding: 46px 40px 160px;
}

.para {
  font-family: var(--lb-serif);
  font-size: 17px;
  line-height: 1.9;
  color: var(--lb-text);
  margin: 0 0 10px;
  text-indent: 2em;
  border-radius: 4px;
}

.para-flash {
  animation: para-flash 2s ease;
}

@keyframes para-flash {
  0%,
  35% {
    background: var(--lb-accent-soft);
    box-shadow: 0 0 0 6px var(--lb-accent-soft);
  }
  100% {
    background: transparent;
    box-shadow: 0 0 0 6px transparent;
  }
}

/* 批注高亮 */
.rv-scroll mark.bn {
  background: var(--lb-warn-bg);
  color: inherit;
  padding: 1px 0;
  border-radius: 3px;
  box-shadow: inset 0 -2px 0 #e9c98d;
  cursor: pointer;
  text-indent: 0;
  transition: background 0.2s ease;
}

.rv-scroll mark.bn:hover {
  background: #fbe7b8;
}

.rv-scroll mark.bn.flash {
  animation: bn-flash 1.8s ease;
}

@keyframes bn-flash {
  0%,
  40% {
    background: #f9d98d;
  }
  100% {
    background: var(--lb-warn-bg);
  }
}

/* ---------- 右批注栏 ---------- */
.rv-side {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--lb-border);
  background: var(--lb-panel);
}

.rv-side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.rv-side-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
}

.rv-side-count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 12px;
  text-align: center;
}

.rv-side-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 10px 12px 14px;
}

.rv-side-empty {
  padding: 36px 14px;
  text-align: center;
  font-size: 13px;
  color: var(--lb-muted);
  line-height: 2;
}

.rv-note {
  padding: 10px 12px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 8px;
  cursor: pointer;
  background: #fbfbfe;
}

.rv-note:hover {
  border-color: var(--lb-accent-2);
}

.rv-note.active {
  border-color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.rv-note.flash {
  animation: note-flash 1.6s ease;
}

@keyframes note-flash {
  0%,
  40% {
    border-color: var(--lb-accent);
    background: var(--lb-accent-soft);
  }
  100% {
    background: #fbfbfe;
  }
}

.rv-note-quote {
  margin: 0;
  font-family: var(--lb-serif);
  font-size: 12px;
  color: var(--lb-warn-fg);
  line-height: 1.6;
}

.rv-note-body {
  margin: 5px 0 0;
  font-size: 13px;
  color: var(--lb-text);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.rv-note-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 7px;
}

.rv-note-time {
  font-size: 11px;
  color: var(--lb-muted);
}

.rv-note-btn {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 5px;
}

.rv-note-btn:hover {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.rv-note-edit {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--lb-accent-2);
  border-radius: 6px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  color: var(--lb-text);
  outline: none;
  resize: vertical;
  background: #fff;
}

.rv-flex {
  flex: 1;
}

/* ---------- 记笔记小表单 ---------- */
.rv-pop {
  position: fixed;
  z-index: 330;
  width: 360px;
  max-width: calc(100vw - 16px);
  padding: 12px 14px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-l);
  box-shadow: 0 12px 36px rgba(24, 28, 55, 0.2);
  display: flex;
  flex-direction: column;
}

.rv-pop-label {
  font-size: 11px;
  color: var(--lb-muted);
  margin-bottom: 4px;
}

.rv-pop-quote {
  max-height: 92px;
  overflow-y: auto;
  padding: 7px 10px;
  border-radius: 6px;
  background: var(--lb-warn-bg);
  color: var(--lb-warn-fg);
  font-family: var(--lb-serif);
  font-size: 12px;
  line-height: 1.7;
  word-break: break-word;
}

.rv-pop-input {
  width: 100%;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  color: var(--lb-text);
  outline: none;
  resize: vertical;
  background: #fff;
}

.rv-pop-input:focus {
  border-color: var(--lb-accent-2);
}

.rv-pop-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.rv-pop-tip {
  font-size: 11px;
  color: var(--lb-muted);
}

.rv-mini {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
  flex-shrink: 0;
}

.rv-mini.primary {
  border-color: var(--lb-accent);
  background: var(--lb-grad);
  color: #fff;
}

.rv-mini:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---------- PDF 页面模式（内置阅读器） ---------- */
.rv-pdf-frame {
  flex: 1;
  min-width: 0;
  background: #525659;
}

.pdf-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.rv-pdf-loading {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #d7d7de;
}

.rv-page-ind {
  font-size: 12px;
  color: #7c7c92;
  padding: 0 4px;
  white-space: nowrap;
}

.rv-page-jump {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #7c7c92;
}

.rv-page-input {
  width: 56px;
  padding: 3px 6px;
  border: 1px solid var(--lb-border);
  border-radius: 6px;
  font-size: 12px;
  color: #24242e;
  text-align: center;
}

.rv-note-page {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--lb-warn-bg);
  color: var(--lb-warn-fg);
  font-size: 12px;
}
</style>
