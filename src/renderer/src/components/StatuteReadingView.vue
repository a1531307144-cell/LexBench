<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildHighlightTerms, highlightText } from '@shared/highlight'
import { parseLocateQuery } from '@shared/locate'
import { buildStatuteToc, type StatuteTocEntry, type StatuteTocLevel } from '@shared/statuteToc'
import type { DocumentDetail } from '@shared/types'

/**
 * 法规全页阅读（doc_type='statute'，文档库入口专用）：
 * 连续正文 + 行内编/章/节标题（跳转锚点）+ 右侧目录栏点击跳转。
 * 纯阅读页：无批注无 AI（工作台能力留在专题/中栏单条视图）。
 */
const props = defineProps<{
  doc: DocumentDetail
}>()

const emit = defineEmits<{
  /** 返回（App 恢复原 Tab） */
  back: []
  error: [message: string]
}>()

const scrollEl = ref<HTMLElement | null>(null)

// ---------- 目录：面板与行内标题同源（唯一来源） ----------

const toc = computed(() => buildStatuteToc(props.doc.articles))
const hasToc = computed(() => toc.value.length > 0)

/** TOC 条目按 orderIndex 分组 —— 正文行内标题由此渲染 */
const headingsByOrder = computed(() => {
  const m = new Map<number, StatuteTocEntry[]>()
  for (const e of toc.value) {
    const arr = m.get(e.orderIndex)
    if (arr) arr.push(e)
    else m.set(e.orderIndex, [e])
  }
  return m
})

const tocOpen = ref(true)

// ---------- 法内搜索（独立于顶栏/中栏两个全局搜索框，只搜当前这部法） ----------

const searchOpen = ref(false)
const searchInputEl = ref<HTMLInputElement | null>(null)
const qInput = ref('')
/** 防抖后的生效查询：驱动候选、计数与全篇高亮（输入流畅优先；100ms=实时感） */
const q = ref('')
let qTimer: ReturnType<typeof setTimeout> | undefined
/** 候选下拉独立开关：外点别处收起（查询/高亮/计数保留），键入/聚焦重新展开 */
const popOpen = ref(true)
const searchComposing = ref(false)

watch(qInput, (v) => {
  clearTimeout(qTimer)
  qTimer = setTimeout(() => {
    q.value = v.trim()
    if (!q.value) activeOrder.value = -1
    else popOpen.value = true // 打字就（重新）展开候选
  }, 100)
})

watch(q, (v) => {
  popOpen.value = !!v
})

/** 点到搜索区之外 → 收起候选（同顶栏 onDocClickForMode 的外点模式） */
function onDocClickForStatute(e: MouseEvent): void {
  const el = e.target as HTMLElement
  if (!el.closest('.sv-search')) popOpen.value = false
}

/** 点回输入框：查询还在就重新展开候选 */
function onSearchInputFocus(): void {
  if (q.value) popOpen.value = true
}

interface StatuteHit {
  id: number
  order: number
  label: string
  snippet: string
}

/** 命中候选：条标/正文子串 + 条号直查，按条文顺序，封顶 50 条 */
const hits = computed<StatuteHit[]>(() => {
  const s = q.value
  if (!s) return []
  const lower = s.toLowerCase()
  const seen = new Set<number>()
  const out: StatuteHit[] = []
  const push = (a: (typeof props.doc.articles)[number], snippet: string): void => {
    if (seen.has(a.id) || out.length >= 50) return
    seen.add(a.id)
    out.push({ id: a.id, order: a.order_index, label: a.article_label, snippet })
  }
  for (const a of props.doc.articles) {
    const idx = a.content.toLowerCase().indexOf(lower)
    const inLabel = a.article_label.toLowerCase().includes(lower)
    if (idx < 0 && !inLabel) continue
    let snippet: string
    if (idx >= 0) {
      const from = Math.max(0, idx - 16)
      const to = Math.min(a.content.length, from + 56)
      snippet = (from > 0 ? '…' : '') + a.content.slice(from, to).replace(/\n/g, ' ')
      if (to < a.content.length) snippet += '…'
    } else {
      snippet = a.content.slice(0, 40).replace(/\n/g, ' ')
    }
    push(a, snippet)
  }
  // 条号直查：阿拉伯数字「1077 / 第1077条 / 1077条」乃至中文「第八条」按 article_no 精准命中
  // （正文/条标是中文数字，纯子串匹配搜不到阿拉伯数字——这里补上）
  const parsed = parseLocateQuery(s)
  if (parsed) {
    for (const a of props.doc.articles) {
      if (a.article_no === parsed.article_no) {
        push(a, a.content.slice(0, 40).replace(/\n/g, ' '))
      }
    }
  }
  return out
})

/** 候选下拉里的关键词标记：与全局搜索同一词条规则（完整原查询整词着色），v-html 安全 */
const svTerms = computed(() => buildHighlightTerms(q.value))
function markHtml(text: string): string {
  return highlightText(text, svTerms.value)
}

/** 当前跳到的命中条（下拉高亮 + Enter 循环用） */
const activeOrder = ref(-1)
const activeNo = computed(() => {
  if (activeOrder.value < 0) return 0
  const i = hits.value.findIndex((h) => h.order === activeOrder.value)
  return i < 0 ? 0 : i + 1
})

/** 全篇命中高亮：段落切成 [{text, hit}]，无查询时每段单节（DOM 与纯文本等价） */
interface Seg {
  text: string
  hit?: boolean
}
const segsById = computed(() => {
  const m = new Map<number, Seg[][]>()
  const s = q.value
  const re = s ? new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null
  for (const a of props.doc.articles) {
    const lines: Seg[][] = []
    for (const line of a.content.split('\n')) {
      if (!line.trim()) continue
      if (!re) {
        lines.push([{ text: line }])
        continue
      }
      re.lastIndex = 0
      const lineSegs: Seg[] = []
      let last = 0
      let mt: RegExpExecArray | null
      while ((mt = re.exec(line)) !== null) {
        if (mt[0].length === 0) {
          re.lastIndex++
          continue
        }
        if (mt.index > last) lineSegs.push({ text: line.slice(last, mt.index) })
        lineSegs.push({ text: mt[0], hit: true })
        last = mt.index + mt[0].length
      }
      if (last < line.length) lineSegs.push({ text: line.slice(last) })
      if (lineSegs.length) lines.push(lineSegs)
    }
    m.set(a.id, lines)
  }
  return m
})

function openSearch(): void {
  searchOpen.value = true
  void nextTick(() => searchInputEl.value?.focus())
}

function closeSearch(): void {
  searchOpen.value = false
  qInput.value = ''
  q.value = ''
  activeOrder.value = -1
  clearTimeout(qTimer)
  clearTimeout(flashTimer)
  flashOrder.value = -1
}

/** 点候选 → 居中定位该条并短暂高亮（与目录跳转同一套定位/高亮机制） */
function jumpToHit(h: StatuteHit): void {
  activeOrder.value = h.order
  scrollTo(h.order, undefined, 'center', 'smooth')
  flashOrder.value = h.order
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashOrder.value = -1), 1800)
}

/** Enter：首条 / 循环下一条（到尾回绕）；IME 选字回车忽略 */
function enterOrNext(e?: KeyboardEvent): void {
  if (e && (searchComposing.value || e.isComposing || e.keyCode === 229)) return
  if (!hits.value.length) return
  const i = hits.value.findIndex((h) => h.order === activeOrder.value)
  jumpToHit(hits.value[i < 0 ? 0 : (i + 1) % hits.value.length])
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

// ---------- 定位与高亮 ----------

const flashOrder = ref(-1)
let flashTimer: ReturnType<typeof setTimeout> | undefined
const RESTORE_PAD = 44 // 顶部留白补偿（目录跳转 / 进度恢复）

/** 锚点：指定层级时优先该级行内标题，兜底该 order 的首个标题/条文 */
function anchorFor(order: number, level?: StatuteTocLevel): HTMLElement | null {
  const el = scrollEl.value
  if (!el) return null
  if (level) {
    const h = el.querySelector<HTMLElement>(`.sv-h[data-level="${level}"][data-order="${order}"]`)
    if (h) return h
  }
  return (
    el.querySelector<HTMLElement>(`.sv-h[data-order="${order}"]`) ??
    el.querySelector<HTMLElement>(`.sv-article[data-order="${order}"]`)
  )
}

function scrollTo(
  order: number,
  level: StatuteTocLevel | undefined,
  mode: 'start' | 'center',
  behavior: 'instant' | 'smooth' = 'instant'
): void {
  const el = scrollEl.value
  const target = anchorFor(order, level)
  if (!el || !target) return
  const top =
    mode === 'center'
      ? target.offsetTop - el.clientHeight / 2 + target.clientHeight / 2
      : target.offsetTop - RESTORE_PAD
  // 平滑滚动只在「看得见」时有意义：隐藏窗口合成器不跑会悬在半路，
  // 减弱动效偏好下也不该有动画——两者都降级为瞬时定位
  const smooth =
    behavior === 'smooth' &&
    document.visibilityState !== 'hidden' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (smooth) el.scrollTo({ top, behavior: 'smooth' })
  else el.scrollTop = Math.max(0, top)
}

/** 目录点击 → 平滑滚到对应标题（顶部留白定位）+ 短暂高亮 */
function jumpFromToc(e: StatuteTocEntry): void {
  scrollTo(e.orderIndex, e.level, 'start', 'smooth')
  flashOrder.value = e.orderIndex
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashOrder.value = -1), 1800)
}

// ---------- 阅读进度 ----------

let progTimer: ReturnType<typeof setTimeout> | undefined
let lastSaved: number | null = null
const backHint = ref(false)
let backHintTimer: ReturnType<typeof setTimeout> | undefined

function onScroll(): void {
  if (progTimer) return
  progTimer = setTimeout(() => {
    progTimer = undefined
    void saveProgressNow()
  }, 500)
}

/** 找视口顶部可见的 [data-order] 存为进度 */
async function saveProgressNow(): Promise<void> {
  const el = scrollEl.value
  if (!el) return
  const box = el.getBoundingClientRect()
  const marks = el.querySelectorAll<HTMLElement>('[data-order]')
  let found = false
  let order = 0
  for (const m of marks) {
    if (m.getBoundingClientRect().bottom >= box.top + 64) {
      order = Number(m.dataset.order)
      found = true
      break
    }
  }
  if (!found && marks.length) order = Number(marks[marks.length - 1].dataset.order)
  if (order === lastSaved) return
  lastSaved = order
  // 注意语义：法规进度的 paraIndex = order_index（书籍 = chunk.seq）；
  // 键按 docId 隔离，一本书/一部法只有一种类型，两义互不冲突
  try {
    await window.lexbench.reading.saveProgress(props.doc.id, order)
  } catch (e) {
    emit('error', errText(e))
  }
}

// ---------- 生命周期 ----------

onMounted(async () => {
  document.addEventListener('click', onDocClickForStatute)
  await nextTick()
  try {
    const prog = await window.lexbench.reading.getProgress(props.doc.id)
    if (prog && prog.paraIndex >= 0 && props.doc.articles.length) {
      lastSaved = prog.paraIndex
      scrollTo(prog.paraIndex, undefined, 'start')
      backHint.value = true
      clearTimeout(backHintTimer)
      backHintTimer = setTimeout(() => (backHint.value = false), 4000)
    }
  } catch (e) {
    emit('error', errText(e))
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClickForStatute)
  clearTimeout(progTimer)
  clearTimeout(backHintTimer)
  clearTimeout(flashTimer)
  clearTimeout(qTimer)
})
</script>

<template>
  <div class="sv">
    <!-- 顶栏 -->
    <header class="sv-top">
      <button class="sv-back" @click="emit('back')">← 返回</button>
      <div class="sv-title-wrap">
        <h1 class="sv-title" :title="doc.title">{{ doc.title }}</h1>
        <transition name="sv-fade">
          <span v-if="backHint" class="sv-hint">已回到上次阅读位置</span>
        </transition>
      </div>
      <div class="sv-ops">
        <!-- 法内搜索：独立搜索框，只搜当前这部法 -->
        <div v-if="doc.articles.length" class="sv-search" :class="{ on: searchOpen }">
          <button v-if="!searchOpen" class="sv-top-btn" title="在本法中搜索条文" @click="openSearch">
            ⌕ 搜索
          </button>
          <template v-else>
            <input
              ref="searchInputEl"
              v-model="qInput"
              class="sv-search-input"
              type="text"
              placeholder="在本法中搜索条文…"
              @focus="onSearchInputFocus"
              @compositionstart="searchComposing = true"
              @compositionend="searchComposing = false"
              @keydown.enter="enterOrNext($event)"
              @keydown.esc="closeSearch"
            />
            <span v-if="q" class="sv-search-count">{{ activeNo ? activeNo + '/' : '' }}{{ hits.length }}</span>
            <button class="sv-top-btn" title="关闭搜索（Esc）" @click="closeSearch">✕</button>
            <div v-if="q && popOpen" class="sv-search-pop">
              <div v-if="!hits.length" class="sv-search-empty">没有匹配的条文</div>
              <div
                v-for="h in hits"
                :key="h.id"
                class="sv-search-item"
                :class="{ active: h.order === activeOrder }"
                :data-order="h.order"
                @click="jumpToHit(h)"
              >
                <span class="sv-search-label" v-html="markHtml(h.label)"></span>
                <span class="sv-search-snippet" v-html="markHtml(h.snippet)"></span>
              </div>
            </div>
          </template>
        </div>
        <span class="sv-meta">共 {{ doc.articles.length }} 条</span>
        <span v-if="doc.status === 'needs_review'" class="sv-chip-warn">需人工复查</span>
        <button
          v-if="hasToc"
          class="sv-top-btn"
          :class="{ on: tocOpen }"
          :title="tocOpen ? '收起目录' : '展开目录'"
          @click="tocOpen = !tocOpen"
        >
          ☰ 目录
        </button>
      </div>
    </header>

    <div class="sv-main">
      <!-- 正文：单滚动容器，行内标题即跳转锚点 -->
      <div ref="scrollEl" class="sv-scroll" @scroll="onScroll">
        <div class="sv-col">
          <div v-if="!doc.articles.length" class="sv-empty">
            未能解析出可阅读的条文。
            <p class="sv-empty-sub">
              {{ doc.status === 'needs_review' ? '该文档已标记「需人工复查」。' : '' }}可在文档库重新导入，或在检索结果里查看原文。
            </p>
          </div>
          <template v-else>
            <template v-for="a in doc.articles" :key="a.id">
              <!-- 行内标题：全部来自 headingsByOrder（与目录同源），兼作跳转锚点 -->
              <component
                v-for="e in headingsByOrder.get(a.order_index) ?? []"
                :key="e.level"
                :is="e.level === 'branch' ? 'h2' : e.level === 'chapter' ? 'h3' : 'h4'"
                class="sv-h"
                :data-level="e.level"
                :data-order="e.orderIndex"
                :class="[`sv-h-${e.level}`, { 'sv-flash': flashOrder === e.orderIndex }]"
              >{{ e.title }}</component>
              <section
                class="sv-article"
                :data-order="a.order_index"
                :class="{ 'sv-flash': flashOrder === a.order_index }"
              >
                <span class="sv-label">{{ a.article_label }}</span>
                <p v-for="(segs, i) in segsById.get(a.id) ?? []" :key="i" class="sv-p">
                  <template v-for="(seg, j) in segs" :key="j">
                    <mark v-if="seg.hit" class="sv-hit">{{ seg.text }}</mark>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </p>
              </section>
            </template>
          </template>
        </div>
      </div>

      <!-- 右目录栏（与阅读模式批注栏同壳）；appear=开页时随整体入场侧滑进入 -->
      <Transition name="sv-toc" appear>
        <aside v-show="hasToc && tocOpen" class="sv-side">
          <div class="sv-side-head">
            <span class="sv-side-title">目录</span>
            <span class="sv-side-count">{{ toc.length }}</span>
          </div>
          <div class="sv-side-list">
            <div
              v-for="(e, i) in toc"
              :key="i"
              class="sv-toc-item"
              :data-level="e.level"
              :data-order="e.orderIndex"
              @click="jumpFromToc(e)"
            >
              {{ e.title }}
            </div>
          </div>
        </aside>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.sv {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--lb-panel);
}

/* ---------- 顶栏 ---------- */
.sv-top {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 52px;
  padding: 0 16px;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
  background: var(--lb-panel);
  /* 必须显式抬层：入场动画期间 .sv-top 带 transform（生成层叠上下文），
     搜索下拉的 z-index 会困在顶栏层内被正文盖住——这里让顶栏整体压过正文 */
  position: relative;
  z-index: 20;
}

.sv-back {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
  flex-shrink: 0;
}

.sv-back:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.sv-title-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.sv-title {
  font-family: var(--lb-serif);
  font-size: 16px;
  font-weight: 600;
  color: var(--lb-text);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sv-hint {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--lb-ok-fg);
  background: var(--lb-ok-bg);
  padding: 2px 10px;
  border-radius: 999px;
}

.sv-fade-enter-active,
.sv-fade-leave-active {
  transition: opacity 0.3s ease;
}

.sv-fade-enter-from,
.sv-fade-leave-to {
  opacity: 0;
}

.sv-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.sv-meta {
  font-size: 12px;
  color: var(--lb-muted);
  white-space: nowrap;
}

.sv-chip-warn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--lb-warn-bg);
  color: var(--lb-warn-fg);
  white-space: nowrap;
}

.sv-top-btn {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}

.sv-top-btn:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.sv-top-btn.on {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

/* ---------- 法内搜索（样式与顶栏 .search-group / 结果列表 .item 统一，见 frontend-design-unity） ---------- */
.sv-search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 输入态才出现容器边框；静息中性边 → 聚焦蓝边+柔光，与顶栏搜索胶囊同配方 */
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--lb-radius-s);
  transition: border-color 0.25s, box-shadow 0.25s;
}

.sv-search.on {
  padding: 0 8px;
  border-color: rgba(0, 0, 0, 0.1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.sv-search.on:focus-within {
  border-color: rgba(0, 113, 227, 0.55);
  box-shadow: 0 2px 10px rgba(0, 113, 227, 0.16);
}

.sv-search-input {
  width: 200px;
  height: 30px;
  padding: 0 4px;
  border: none;
  background: transparent;
  font-size: 13px;
  color: var(--lb-text);
  outline: none;
}

.sv-search-count {
  min-width: 30px;
  text-align: center;
  font-size: 12px;
  color: var(--lb-muted);
  white-space: nowrap;
}

.sv-search-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 300;
  width: 380px;
  max-height: 340px;
  overflow-y: auto;
  padding: 8px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.18);
}

.sv-search-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 6px;
  cursor: pointer;
  background: var(--lb-panel);
  transition: border-color 0.12s ease, transform 0.12s ease, box-shadow 0.12s ease;
}

.sv-search-item:last-child {
  margin-bottom: 0;
}

.sv-search-item:hover {
  border-color: var(--lb-accent-2);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.07);
}

.sv-search-item.active {
  border-color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.sv-search-label {
  flex-shrink: 0;
  font-family: var(--lb-serif);
  font-size: 13px;
  font-weight: 600;
  color: var(--lb-text);
}

.sv-search-snippet {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--lb-muted);
}

.sv-search-empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 13px;
  color: var(--lb-muted);
}

/* 候选下拉关键词标记：与全局结果列表同款 Apple 琥珀（--lb-hit）；v-html 内容无 scoped 位 → :deep */
.sv-search-pop :deep(em) {
  font-style: normal;
  font-weight: 600;
  background: var(--lb-hit);
  color: var(--lb-text);
  border-radius: 3px;
  padding: 0 2px;
  margin: 0 -1px;
}

/* 正文全篇命中高亮：同一琥珀令牌，Apple 式柔和底、去蓝色下划线 */
.sv-scroll mark.sv-hit {
  background: var(--lb-hit);
  color: inherit;
  padding: 0 2px;
  border-radius: 3px;
  text-indent: 0;
  box-shadow: none;
}

/* ---------- 主区 ---------- */
.sv-main {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* ---------- 入场动效：与全局 lb-*-in 列表项同手法（淡入 + 8px 上浮、0.18s ease），
     顶栏先、正文后 0.05s 错一拍；减弱动效偏好下整体不播。
     用 backwards 而非 both：both 结束后会留下 transform:translateY(0)，
     单位变换也生成层叠上下文，把顶栏里的搜索下拉困在正文之下 ---------- */
@media (prefers-reduced-motion: no-preference) {
  .sv-top {
    animation: sv-in 0.18s ease backwards;
  }

  .sv-col {
    animation: sv-in 0.18s ease 0.05s backwards;
  }
}

@keyframes sv-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ---------- 目录栏开合：同消息条/对话框的滑入规格（0.24s + ease 曲线） ---------- */
@media (prefers-reduced-motion: no-preference) {
  .sv-toc-enter-active,
  .sv-toc-leave-active {
    transition:
      transform 0.24s cubic-bezier(0.25, 0.1, 0.25, 1),
      opacity 0.24s ease;
  }
}

.sv-toc-enter-from,
.sv-toc-leave-to {
  opacity: 0;
  transform: translateX(12px);
}

.sv-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  position: relative; /* 标题/条文 offsetTop 的定位基准 */
  background: var(--lb-panel);
}

.sv-col {
  max-width: 760px;
  margin: 0 auto;
  padding: 46px 40px 160px;
}

/* ---------- 行内标题：编大章中节小，编/章居中 ---------- */
.sv-h {
  font-family: var(--lb-serif);
  color: var(--lb-text);
  text-align: center;
  letter-spacing: 1px;
}

.sv-h-branch {
  font-size: 22px;
  font-weight: 700;
  margin: 52px 0 18px;
}

.sv-h-chapter {
  font-size: 18px;
  font-weight: 600;
  margin: 40px 0 14px;
}

.sv-h-section {
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  margin: 28px 0 10px;
  color: var(--lb-text);
}

.sv-col > .sv-h-branch:first-child,
.sv-col > .sv-h-chapter:first-child {
  margin-top: 0;
}

.sv-flash {
  animation: sv-flash 1.8s ease;
}

@keyframes sv-flash {
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

/* ---------- 条文 ---------- */
.sv-article {
  margin: 0 0 6px;
  border-radius: 4px;
}

.sv-label {
  display: block;
  font-family: var(--lb-serif);
  font-size: 16px;
  font-weight: 700;
  color: var(--lb-text);
  margin: 18px 0 4px;
}

.sv-article:first-child .sv-label {
  margin-top: 0;
}

.sv-p {
  font-family: var(--lb-serif);
  font-size: 17px;
  line-height: 1.9;
  color: var(--lb-text);
  margin: 0 0 10px;
  text-indent: 2em;
}

.sv-empty {
  padding-top: 110px;
  text-align: center;
  font-size: 15px;
  color: var(--lb-muted);
  line-height: 2;
}

.sv-empty-sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--lb-muted);
}

/* ---------- 右目录栏 ---------- */
.sv-side {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--lb-border);
  background: var(--lb-panel);
}

.sv-side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.sv-side-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
}

.sv-side-count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 12px;
  text-align: center;
}

.sv-side-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 10px 12px 14px;
}

.sv-toc-item {
  padding: 7px 10px;
  border-radius: var(--lb-radius-s);
  font-size: 13px;
  line-height: 1.6;
  color: var(--lb-text);
  cursor: pointer;
  border: 1px solid transparent;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sv-toc-item:hover {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
}

.sv-toc-item[data-level='branch'] {
  font-weight: 600;
  margin-top: 6px;
}

.sv-toc-item[data-level='chapter'] {
  padding-left: 24px;
}

.sv-toc-item[data-level='section'] {
  padding-left: 38px;
  font-size: 12.5px;
  color: var(--lb-muted);
}
</style>
