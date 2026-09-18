<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ConfirmModal from './ConfirmModal.vue'
import type { BookNoteRow, DocumentDetail, ExportFormat } from '@shared/types'

/**
 * 沉浸阅读器（doc_type='book'）：划选记笔记 → <mark class="bn"> 高亮恢复 →
 * 右栏批注管理 → 阅读进度记忆。正文列按 chunks 渲染，每 chunk = 一段（seq=段落序号）。
 */
const props = defineProps<{
  /** 书籍详情：chunks 每项即一段；批注 para_index 与 chunk.seq 对应 */
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

/** 批注栏列表顺序：按段落 → 段内偏移 */
const sortedNotes = computed(() =>
  [...notes.value].sort((a, b) => a.para_index - b.para_index || a.quote_start - b.quote_start)
)

// ---------- 段落切片：把批注区间包进 <mark class="bn"> ----------

interface Seg {
  text: string
  noteId?: number
}
const EMPTY_SEGS: Seg[] = []

/** 段落 seq → 切片数组；重叠区间以先出现的批注为准 */
const segByPara = computed(() => {
  const map = new Map<number, Seg[]>()
  for (const c of props.doc.chunks) {
    const text = c.content
    const list = notes.value
      .filter((n) => n.para_index === c.seq)
      .sort((a, b) => a.quote_start - b.quote_start)
    const segs: Seg[] = []
    let pos = 0
    for (const n of list) {
      const s = Math.max(pos, Math.min(n.quote_start, text.length))
      const e = Math.max(s, Math.min(n.quote_end, text.length))
      if (s > pos) segs.push({ text: text.slice(pos, s) })
      if (e > s) segs.push({ text: text.slice(s, e), noteId: n.id })
      pos = Math.max(pos, e)
    }
    if (pos < text.length) segs.push({ text: text.slice(pos) })
    map.set(c.seq, segs)
  }
  return map
})

// ---------- 划选 → 浮动「记笔记」按钮 → 小表单 ----------

interface SelBox {
  top: number
  left: number
}
interface PendingSel {
  paraIndex: number
  quoteStart: number
  quoteEnd: number
  quote: string
  rect: DOMRect
}

const selHint = ref<(SelBox & { text: string }) | null>(null)
/** 待成文选区（按钮点击后转成 form） */
let pendingSel: PendingSel | null = null
const form = ref<(SelBox & { quote: string; paraIndex: number; quoteStart: number; quoteEnd: number }) | null>(null)
const draft = ref('')
const saving = ref(false)

let hintTimer: ReturnType<typeof setTimeout> | undefined

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

function closeSelectionUi(): void {
  selHint.value = null
  pendingSel = null
  if (form.value) cancelForm()
}

function onContentMousedown(): void {
  // 在正文里重新按下鼠标：收起上一轮划选 UI（表单若有草稿即放弃）
  if (selHint.value) {
    selHint.value = null
    pendingSel = null
  } else if (form.value) {
    cancelForm()
  }
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
  const rect = range.getBoundingClientRect()
  if (!startP || startP !== endP) {
    // 跨段划选：不能锚定，就近提示（纵坐标钳制进视口，选区很大时也看得到）。
    // 若批注表单正开着（编辑流程中）先关掉；否则只清待成文选区，保留用户划选的原文
    if (form.value) cancelForm()
    pendingSel = null
    selHint.value = {
      top: Math.min(Math.max(8, rect.bottom + 8), window.innerHeight - 48),
      left: clampX(rect.left + rect.width / 2),
      text: '请在同一段落内划选'
    }
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => (selHint.value = null), 2400)
    return
  }
  const start = textOffsetTo(startP, range.startContainer, range.startOffset)
  const end = textOffsetTo(startP, range.endContainer, range.endOffset)
  const quote = (startP.textContent ?? '').slice(start, end)
  if (end <= start || !quote.trim()) {
    closeSelectionUi()
    return
  }
  selHint.value = null
  pendingSel = {
    paraIndex: Number(startP.dataset.para),
    quoteStart: start,
    quoteEnd: end,
    quote,
    rect
  }
  // 一选中直接弹批注表单，不设中间按钮
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
    paraIndex: sel.paraIndex,
    quoteStart: sel.quoteStart,
    quoteEnd: sel.quoteEnd
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
      paraIndex: form.value.paraIndex,
      quoteStart: form.value.quoteStart,
      quoteEnd: form.value.quoteEnd
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

/** 点批注列表项 → 滚动到对应段落并闪现高亮 */
function openNoteFromList(n: BookNoteRow): void {
  activeNoteId.value = n.id
  const el = scrollEl.value
  const p = el?.querySelector<HTMLElement>(`p[data-para="${n.para_index}"]`)
  if (el && p) {
    el.scrollTo({
      top: Math.max(0, p.offsetTop - el.clientHeight / 2 + p.clientHeight / 2),
      behavior: 'smooth'
    })
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
  if (progTimer) return
  progTimer = setTimeout(() => {
    progTimer = undefined
    void saveProgressNow()
  }, 500)
}

/** 找视口顶部可见段落的 data-para 存为进度 */
async function saveProgressNow(): Promise<void> {
  const el = scrollEl.value
  if (!el) return
  const box = el.getBoundingClientRect()
  const paras = el.querySelectorAll<HTMLElement>('p[data-para]')
  let seq = 0
  let found = false
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

/** 滚动定位到段落：start=顶部留白补偿；center=居中 */
function scrollToSeq(seq: number, mode: 'start' | 'center'): void {
  const el = scrollEl.value
  const p = el?.querySelector<HTMLElement>(`p[data-para="${seq}"]`)
  if (!el || !p) return
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
  else if (selHint.value) {
    selHint.value = null
    pendingSel = null
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await reloadNotes()
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
  clearTimeout(progTimer)
  clearTimeout(backHintTimer)
  clearTimeout(hintTimer)
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
      <!-- 左主区：滚动正文 -->
      <div
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
              <p class="rv-note-quote">「{{ briefQuote(n.quote) }}」</p>
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

    <!-- 跨段提示 -->
    <div
      v-if="selHint"
      class="sel-hint"
      :style="{ top: selHint.top + 'px', left: selHint.left + 'px' }"
    >
      {{ selHint.text }}
    </div>

    <!-- 记笔记小表单 -->
    <div v-if="form" class="rv-pop" :style="{ top: form.top + 'px', left: form.left + 'px' }">
      <div class="rv-pop-label">划选原文</div>
      <div class="rv-pop-quote">「{{ form.quote }}」</div>
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

/* ---------- 跨段提示 ---------- */
.sel-hint {
  position: fixed;
  z-index: 320;
  transform: translateX(-50%);
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--lb-warn-bg);
  color: var(--lb-warn-fg);
  font-size: 12px;
  box-shadow: 0 4px 14px rgba(24, 28, 55, 0.12);
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
</style>
