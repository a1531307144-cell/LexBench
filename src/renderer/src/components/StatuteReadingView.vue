<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { buildHighlightTerms, highlightText } from '@shared/highlight'
import { parseLocateQuery } from '@shared/locate'
import { buildStatuteToc, type StatuteTocEntry, type StatuteTocLevel } from '@shared/statuteToc'
import { usePageZoom } from '../composables/usePageZoom'
import type { AnnotationRow, DocumentDetail } from '@shared/types'

/**
 * 法规全页阅读（文档库/搜索直达统一落点）：
 * 连续正文 + 行内编/章/节标题（跳转锚点）+ 右侧目录栏点击跳转 +
 * 法条批注（选中→右键「添加批注」→浮窗→★常驻）+ 条文修正（✎）。
 * AI 已解绑为全局通用问答（App 顶栏「AI 助手」抽屉），本页不再挂 AI 入口。
 */
const props = defineProps<{
  doc: DocumentDetail
  /** 搜索直达 / AI 引用跳转：定位到该 order_index 并高亮；不传则按阅读进度恢复 */
  focusOrder?: number
  /** 续读契约的静默重开（恢复位置但不弹「已回到上次位置」提示） */
  silentRestore?: boolean
  /** 使用指引演示态：只展示，不写阅读进度 */
  guide?: boolean
}>()

const emit = defineEmits<{
  /** 返回（App 恢复原视图） */
  back: []
  error: [message: string]
  notice: [message: string]
  /** 条文修正保存后请求 App 重新拉取文档（content 变了，批注偏移已在主进程重定位） */
  'doc-changed': []
  /** 右上「全区」：隐藏/显示左侧竖排导航 */
  'toggle-rail': []
}>()

const scrollEl = ref<HTMLElement | null>(null)

/** 正文缩放（触控板双指捏合）：按文档记住比例，下次打开该法条仍用原比例 */
const { pageZoom, resetZoom } = usePageZoom({
  zoomKey: () => `read:zoom:doc:${props.doc.id}`,
  target: scrollEl
})

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

/** 点到搜索区之外 → 收起候选；点到批注浮窗之外 → 浮窗落盘收起（外点自动保存语义） */
function onDocClickForStatute(e: MouseEvent): void {
  const el = e.target as HTMLElement
  if (!el.closest('.sv-search')) popOpen.value = false
  if (annoPop.open && !el.closest('.sv-anno-pop') && !el.closest('.sv-anno-star') && !el.closest('.sv-fix-btn')) {
    void commitPop()
  }
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

// ---------- 星标（轻量临时收集；笔记库左列有星标入口） ----------

const starredIds = ref<Set<number>>(new Set())

async function loadStars(): Promise<void> {
  try {
    const all = await window.lexbench.outlines.listStarred()
    starredIds.value = new Set(
      all.filter((s) => s.document_id === props.doc.id).map((s) => s.article_id)
    )
  } catch {
    /* 星标失败不打扰阅读 */
  }
}

async function toggleStar(articleId: number): Promise<void> {
  const on = !starredIds.value.has(articleId)
  try {
    await window.lexbench.outlines.setStarred(articleId, on)
    const next = new Set(starredIds.value)
    if (on) next.add(articleId)
    else next.delete(articleId)
    starredIds.value = next
    emit('notice', on ? '已星标，笔记库左列可见' : '已取消星标')
  } catch (e) {
    emit('error', errText(e))
  }
}

// ---------- 批注（锚定法条选区的永久眉批；★ 常驻标记） ----------

/** 批注行 + 所属条文 order_index（listByDoc 返回） */
type AnnoRow = AnnotationRow & { order_index: number }

const annos = ref<AnnoRow[]>([])

/** articleId → 批注列表（渲染分段用） */
const annosByArticle = computed(() => {
  const m = new Map<number, AnnoRow[]>()
  for (const a of annos.value) {
    const arr = m.get(a.article_id)
    if (arr) arr.push(a)
    else m.set(a.article_id, [a])
  }
  return m
})

/**
 * 渲染行基址：与模板渲染同一套跳行规则（空行不渲染），
 * 返回每个渲染段落（.sv-p）对应的 content 起始偏移——选区 DOM→content 偏移换算的地基。
 */
function lineBases(content: string): Array<{ base: number; len: number }> {
  const out: Array<{ base: number; len: number }> = []
  let pos = 0
  for (const line of content.split('\n')) {
    const base = pos
    pos += line.length + 1 // +1 = 换行符
    if (!line.trim()) continue
    out.push({ base, len: line.length })
  }
  return out
}

/** 全篇渲染分段：搜索命中（胶囊）与批注选区（点线+★）叠加切分，无查询无批注时每段单节 */
interface Seg {
  text: string
  hit?: boolean
  anno?: number
  /** 本段末尾要挂的 ★（批注结束边界落点；可能多个批注同点结束） */
  annoEndIds?: number[]
}
const segsById = computed(() => {
  // 依赖批注数据：批注增删改后分段重算（★/点线随之更新）
  void annos.value
  const m = new Map<number, Seg[][]>()
  const s = q.value
  const re = s ? new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null
  for (const a of props.doc.articles) {
    const lines: Seg[][] = []
    let pos = 0
    for (const line of a.content.split('\n')) {
      const lineStart = pos
      pos += line.length + 1
      if (!line.trim()) continue
      // 行内搜索命中区间
      const hitRanges: Array<[number, number]> = []
      if (re) {
        re.lastIndex = 0
        let mt: RegExpExecArray | null
        while ((mt = re.exec(line)) !== null) {
          if (mt[0].length === 0) {
            re.lastIndex++
            continue
          }
          hitRanges.push([mt.index, mt.index + mt[0].length])
        }
      }
      // 批注区间：content 绝对偏移 → 行内相对
      const annoParts = (annosByArticle.value.get(a.id) ?? [])
        .map((an) => ({
          id: an.id,
          from: Math.max(an.start_offset, lineStart) - lineStart,
          to: Math.min(an.end_offset, lineStart + line.length) - lineStart,
          endHere: an.end_offset > lineStart && an.end_offset <= lineStart + line.length
        }))
        .filter((r) => r.to > r.from || (r.endHere && r.to >= 0))
      // 切点：行两端 + 命中边界 + 批注边界
      const cuts = new Set<number>([0, line.length])
      for (const [h0, h1] of hitRanges) {
        cuts.add(h0)
        cuts.add(h1)
      }
      for (const r of annoParts) {
        cuts.add(Math.max(0, Math.min(r.from, line.length)))
        cuts.add(Math.max(0, Math.min(r.to, line.length)))
      }
      const xs = [...cuts].sort((x, y) => x - y)
      const lineSegs: Seg[] = []
      for (let i = 0; i < xs.length - 1; i++) {
        const from = xs[i]
        const to = xs[i + 1]
        if (to <= from) continue
        const seg: Seg = { text: line.slice(from, to) }
        if (hitRanges.some(([h0, h1]) => h0 < to && from < h1)) seg.hit = true
        const an = annoParts.find((r) => r.from < to && from < r.to)
        if (an) seg.anno = an.id
        const ends = annoParts.filter((r) => r.endHere && r.to === to).map((r) => r.id)
        if (ends.length) {
          seg.annoEndIds = ends
          if (seg.anno === undefined) seg.anno = ends[0] // ★ 前的零长度段也算批注本体（星标可点）
        }
        lineSegs.push(seg)
      }
      // 行首即结束边界（批注恰好在上一行末尾结束的换行边界）：首段挂 ★
      const headEnds = annoParts.filter((r) => r.endHere && r.to === 0).map((r) => r.id)
      if (headEnds.length && lineSegs.length) {
        lineSegs[0].annoEndIds = [...(lineSegs[0].annoEndIds ?? []), ...headEnds]
      }
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
  // 正文容器带 CSS zoom：offsetTop 是未缩放单位，scrollTop/rect 是缩放后单位，混用会在
  // 缩放≠100% 时按比例落错位置。100% 时直接用 offsetTop——它不受入场动画 translateY 影响
  // （rect 差会被动画临时偏移 8px，目录刚打开就点会落偏）；缩放时才用矩形差换算内容坐标。
  const zoomed = pageZoom.value !== 1
  const contentTop = zoomed
    ? target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    : target.offsetTop
  const targetHeight = zoomed ? target.getBoundingClientRect().height : target.offsetHeight
  const top =
    mode === 'center'
      ? contentTop - el.clientHeight / 2 + targetHeight / 2
      : contentTop - RESTORE_PAD
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

// ---------- 批注浮窗 / 条文修正浮窗（共用一个浮窗体） ----------

/** 浮窗状态：anno = 批注（新建/查看编辑）；fix = 条文修正（锚整个 article.content） */
const annoPop = reactive({
  open: false,
  mode: 'anno' as 'anno' | 'fix',
  /** null = 新批注（尚未落库） */
  id: null as number | null,
  articleId: 0,
  start: 0,
  end: 0,
  /** 打开时的原文（判断是否改动） */
  origin: '',
  draft: '',
  time: '',
  pos: { x: 0, y: 0 }
})
const annoPopEl = ref<HTMLTextAreaElement | null>(null)

/** 把浮窗摆到锚点附近（视口内钳制） */
function placePop(rect: { left: number; top: number; width: number; height: number }): void {
  const W = 320
  const H = 150
  let x = rect.left
  let y = rect.top - H - 8 // 默认在选区上方
  if (y < 8) y = rect.bottom + 8 // 上方放不下 → 下方
  x = Math.max(8, Math.min(x, window.innerWidth - W - 8))
  y = Math.max(8, Math.min(y, window.innerHeight - H - 8))
  annoPop.pos = { x, y }
}

/**
 * DOM 选区 → content 字符偏移（同 .sv-article 内才算数）。
 * ★（sup.sv-anno-star）不是正文文本，计数时跳过。
 */
function offsetInArticle(node: Node, off: number, article: { id: number; content: string }): number | null {
  const el = scrollEl.value
  if (!el) return null
  const host = node instanceof Element ? node : node.parentElement
  const p = host?.closest('.sv-p')
  const articleEl = host?.closest('.sv-article')
  if (!p || !articleEl) return null
  if (Number(articleEl.getAttribute('data-article-id')) !== article.id) return null
  const pIndex = Number(p.getAttribute('data-line'))
  const base = lineBases(article.content)[pIndex]?.base
  if (base === undefined) return null
  let acc = 0
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const par = n.parentElement
      if (par && par.closest('.sv-anno-star')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let t: Node | null
  while ((t = walker.nextNode())) {
    if (t === node) return base + acc + off
    acc += t.textContent?.length ?? 0
  }
  return null
}

/** 右键菜单「添加批注」：把当前选区变成新批注草稿并弹浮窗 */
function tryAddFromSelection(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const endEl = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  const startArticleEl = startEl?.closest('.sv-article')
  const endArticleEl = endEl?.closest('.sv-article')
  if (!startArticleEl || startArticleEl !== endArticleEl) {
    emit('notice', '批注请在同一法条内选择文字')
    return
  }
  const order = Number(startArticleEl.getAttribute('data-order'))
  const article = props.doc.articles.find((x) => x.order_index === order)
  if (!article) return
  const s = offsetInArticle(range.startContainer, range.startOffset, article)
  const e = offsetInArticle(range.endContainer, range.endOffset, article)
  if (s === null || e === null) return
  const start = Math.min(s, e)
  const end = Math.max(s, e)
  if (end <= start) return
  commitPop() // 上一个浮窗先落盘
  annoPop.open = true
  annoPop.mode = 'anno'
  annoPop.id = null
  annoPop.articleId = article.id
  annoPop.start = start
  annoPop.end = end
  annoPop.origin = ''
  annoPop.draft = ''
  annoPop.time = ''
  placePop(range.getBoundingClientRect())
  void nextTick(() => annoPopEl.value?.focus())
}

/** 点 ★ / 点批注正文：打开已有批注 */
function openAnnoById(id: number): void {
  const an = annos.value.find((x) => x.id === id)
  if (!an) return
  commitPop()
  annoPop.open = true
  annoPop.mode = 'anno'
  annoPop.id = an.id
  annoPop.articleId = an.article_id
  annoPop.start = an.start_offset
  annoPop.end = an.end_offset
  annoPop.origin = an.content_md
  annoPop.draft = an.content_md
  annoPop.time = an.updated_at.slice(0, 16)
  const anchor = scrollEl.value?.querySelector<HTMLElement>(`.sv-anno[data-anno="${id}"]`)
  placePop(anchor?.getBoundingClientRect() ?? { left: 60, top: 120, width: 0, height: 40 })
  void nextTick(() => annoPopEl.value?.focus())
}

/** 条文修正（✎）：浮窗里编辑整条 content，保存走主进程并重建索引/批注偏移 */
function openFixPop(a: { id: number; content: string }): void {
  commitPop()
  annoPop.open = true
  annoPop.mode = 'fix'
  annoPop.id = null
  annoPop.articleId = a.id
  annoPop.start = 0
  annoPop.end = 0
  annoPop.origin = a.content
  annoPop.draft = a.content
  annoPop.time = ''
  const articleEl = scrollEl.value?.querySelector<HTMLElement>(`[data-article-id="${a.id}"]`)
  const btn = articleEl?.querySelector<HTMLElement>('.sv-fix-btn')
  placePop(btn?.getBoundingClientRect() ?? { left: 60, top: 120, width: 0, height: 40 })
  void nextTick(() => {
    annoPopEl.value?.focus()
    annoPopEl.value?.setSelectionRange(0, 0)
    annoPopEl.value?.scrollTo({ top: 0 })
  })
}

function closeAnnoPop(): void {
  annoPop.open = false
}

/**
 * 浮窗落盘（外点/Esc/打开新浮窗都走这里）：
 * 新批注空内容=丢弃；已有批注清空=删除；修正空内容=取消；其余保存。
 */
async function commitPop(): Promise<void> {
  if (!annoPop.open) return
  const draft = annoPop.draft.trim()
  try {
    if (annoPop.mode === 'fix') {
      if (draft && draft !== annoPop.origin) {
        await window.lexbench.library.updateArticle(annoPop.articleId, draft)
        emit('doc-changed')
      }
    } else if (annoPop.id === null) {
      if (draft && annoPop.end > annoPop.start) {
        const row = await window.lexbench.annotations.create({
          articleId: annoPop.articleId,
          quote: props.doc.articles.find((x) => x.id === annoPop.articleId)?.content.slice(annoPop.start, annoPop.end) ?? '',
          startOffset: annoPop.start,
          endOffset: annoPop.end,
          contentMd: draft
        })
        const order = props.doc.articles.find((x) => x.id === row.article_id)?.order_index ?? 0
        annos.value.push({ ...row, order_index: order })
      }
    } else if (draft === '') {
      await window.lexbench.annotations.delete(annoPop.id)
      annos.value = annos.value.filter((x) => x.id !== annoPop.id)
    } else if (draft !== annoPop.origin) {
      await window.lexbench.annotations.update(annoPop.id, draft)
      const an = annos.value.find((x) => x.id === annoPop.id)
      if (an) {
        an.content_md = draft
        an.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ')
      }
    }
  } catch (err) {
    emit('error', errText(err))
  }
  closeAnnoPop()
}

async function deleteFromPop(): Promise<void> {
  if (annoPop.mode !== 'anno' || annoPop.id === null) return
  try {
    await window.lexbench.annotations.delete(annoPop.id)
    annos.value = annos.value.filter((x) => x.id !== annoPop.id)
  } catch (err) {
    emit('error', errText(err))
  }
  closeAnnoPop()
}

async function loadAnnos(): Promise<void> {
  try {
    annos.value = await window.lexbench.annotations.listByDoc(props.doc.id)
  } catch (err) {
    emit('error', errText(err))
  }
}

watch(() => props.doc.id, () => void loadAnnos())

// ---------- 视口定位（进度 / 搜索直达共用） ----------

/** 视口顶部可见的首个 [data-order]（阅读进度用） */
function topVisibleOrder(): number | null {
  const el = scrollEl.value
  if (!el) return null
  const box = el.getBoundingClientRect()
  for (const m of el.querySelectorAll<HTMLElement>('[data-order]')) {
    if (m.getBoundingClientRect().bottom >= box.top + 64) return Number(m.dataset.order)
  }
  const marks = el.querySelectorAll<HTMLElement>('[data-order]')
  return marks.length ? Number(marks[marks.length - 1].dataset.order) : null
}

/** 跳到目标条并短暂高亮（focusOrder 初次打开与后续变化共用） */
function jumpToFocus(order: number): void {
  lastSaved = order
  scrollTo(order, undefined, 'center')
  flashOrder.value = order
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashOrder.value = -1), 1800)
}

// focusOrder 变化（同文档内从全局 AI 点引用再次跳转）：组件不重挂，靠 watch 二次定位
watch(
  () => props.focusOrder,
  (v) => {
    if (v === undefined || v < 0) return
    void nextTick(() => jumpToFocus(v))
  }
)

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
  if (props.guide) return
  const order = topVisibleOrder()
  if (order === null || order === lastSaved) return
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

/** 右键菜单「添加批注」通知的退订 */
let unsubAddRequest: (() => void) | null = null

onMounted(async () => {
  document.addEventListener('click', onDocClickForStatute)
  // 批注上下文：本页在场时主进程右键菜单才追加「添加批注」
  window.lexbench.annotations.setActive(true)
  unsubAddRequest = window.lexbench.annotations.onAddRequest(() => tryAddFromSelection())
  void loadAnnos()
  void loadStars()
  await nextTick()
  try {
    if (props.focusOrder !== undefined && props.focusOrder >= 0 && props.doc.articles.length) {
      // 搜索直达 / AI 引用：定位到命中条并高亮（不走进度恢复）
      jumpToFocus(props.focusOrder)
      return
    }
    const prog = await window.lexbench.reading.getProgress(props.doc.id)
    if (prog && prog.paraIndex >= 0 && props.doc.articles.length) {
      lastSaved = prog.paraIndex
      scrollTo(prog.paraIndex, undefined, 'start')
      if (!props.silentRestore) {
        backHint.value = true
        clearTimeout(backHintTimer)
        backHintTimer = setTimeout(() => (backHint.value = false), 4000)
      }
    }
  } catch (e) {
    emit('error', errText(e))
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClickForStatute)
  window.lexbench.annotations.setActive(false)
  unsubAddRequest?.()
  unsubAddRequest = null
  // 续读契约：防抖未到期也要冲刷进度（切去笔记等场景不丢最后半秒位置）
  clearTimeout(progTimer)
  void saveProgressNow()
  clearTimeout(backHintTimer)
  clearTimeout(flashTimer)
  clearTimeout(qTimer)
})
</script>

<template>
  <div class="sv">
    <!-- 顶栏 -->
    <header class="sv-top" data-guide="reading-head">
      <button class="sv-back" @click="emit('back')">← 返回</button>
      <div class="sv-title-wrap">
        <h1 class="sv-title" :title="doc.title">{{ doc.title }}</h1>
        <transition name="sv-fade">
          <span v-if="backHint" class="sv-hint">已回到上次阅读位置</span>
        </transition>
      </div>
      <div class="sv-ops">
        <button
          v-if="pageZoom !== 1"
          class="sv-zoom-reset"
          title="重置正文缩放（触控板双指可缩放）"
          @click="resetZoom()"
        >
          {{ Math.round(pageZoom * 100) }}%
        </button>
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
        <button
          class="sv-top-btn"
          title="隐藏左侧导航（全区阅读；再点恢复）"
          @click="emit('toggle-rail')"
        >
          ⛶ 全区
        </button>
      </div>
    </header>

    <div class="sv-main">
      <!-- 正文：单滚动容器，行内标题即跳转锚点 -->
      <div ref="scrollEl" class="sv-scroll" @scroll="onScroll">
        <div class="sv-col" :style="{ zoom: pageZoom }">
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
                :is="
                  e.level === 'branch'
                    ? 'h2'
                    : e.level === 'subbranch'
                      ? 'h3'
                      : e.level === 'chapter'
                        ? 'h4'
                        : 'h5'
                "
                class="sv-h"
                :data-level="e.level"
                :data-order="e.orderIndex"
                :class="[`sv-h-${e.level}`, { 'sv-flash': flashOrder === e.orderIndex }]"
              >{{ e.title }}</component>
              <section
                class="sv-article"
                :data-order="a.order_index"
                :data-article-id="a.id"
                :class="{ 'sv-flash': flashOrder === a.order_index }"
              >
                <div class="sv-label-row">
                  <span class="sv-label">{{ a.article_label }}</span>
                  <button
                    class="sv-star-btn"
                    :class="{ on: starredIds.has(a.id) }"
                    :title="starredIds.has(a.id) ? '取消星标' : '星标本条（笔记库星标入口可见）'"
                    @click.stop="toggleStar(a.id)"
                  >
                    {{ starredIds.has(a.id) ? '★' : '☆' }}
                  </button>
                  <button
                    class="sv-fix-btn"
                    title="修正本条条文"
                    @click.stop="openFixPop(a)"
                  >
                    ✎
                  </button>
                </div>
                <p v-for="(segs, i) in segsById.get(a.id) ?? []" :key="i" class="sv-p" :data-line="i">
                  <template v-for="(seg, j) in segs" :key="j">
                    <mark v-if="seg.hit && seg.anno !== undefined" class="sv-hit sv-anno" :data-anno="seg.anno">{{ seg.text }}</mark>
                    <mark v-else-if="seg.hit" class="sv-hit">{{ seg.text }}</mark>
                    <span v-else-if="seg.anno !== undefined" class="sv-anno" :data-anno="seg.anno">{{ seg.text }}</span>
                    <template v-else>{{ seg.text }}</template>
                    <sup
                      v-for="aid in seg.annoEndIds ?? []"
                      :key="'an' + aid"
                      class="sv-anno-star"
                      :data-anno-star="aid"
                      title="查看批注"
                      @click.stop="openAnnoById(aid)"
                    >★</sup>
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

    <!-- 批注/修正浮窗（贴锚点定位；外点/Esc 落盘收起） -->
    <div
      v-if="annoPop.open"
      class="sv-anno-pop"
      :style="{ left: annoPop.pos.x + 'px', top: annoPop.pos.y + 'px' }"
      @click.stop
    >
      <textarea
        ref="annoPopEl"
        v-model="annoPop.draft"
        class="sv-anno-input"
        :placeholder="annoPop.mode === 'fix' ? '修正条文内容（清空并点外部 = 取消）' : '写批注（清空并点外部 = 删除）'"
        @keydown.esc.stop.prevent="commitPop"
      ></textarea>
      <div class="sv-anno-pop-foot">
        <span class="sv-anno-time">{{ annoPop.time }}</span>
        <button v-if="annoPop.mode === 'anno' && annoPop.id !== null" class="sv-anno-del" @click="deleteFromPop">
          删除
        </button>
        <button class="sv-top-btn sv-anno-close" @click="commitPop">✕</button>
      </div>
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
  flex-shrink: 0;
  background: var(--lb-panel);
  /* 必须显式抬层：入场动画期间 .sv-top 带 transform（生成层叠上下文），
     搜索下拉的 z-index 会困在顶栏层内被正文盖住——这里让顶栏整体压过正文 */
  position: relative;
  z-index: 20;
}

/* 阅读顶栏底边：两端 32px 渐隐，避免整条直线过抢 */
.sv-top::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(
    to right,
    transparent 0,
    rgba(0, 0, 0, 0.06) 32px,
    rgba(0, 0, 0, 0.06) calc(100% - 32px),
    transparent 100%
  );
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
  border-radius: var(--lb-radius-full);
}

.sv-fade-enter-active,
.sv-fade-leave-active {
  transition: opacity 0.3s ease;
}

.sv-fade-enter-from,
.sv-fade-leave-to {
  opacity: 0;
}

.sv-zoom-reset {
  padding: 3px 8px;
  border: 1px solid var(--lb-border);
  border-radius: 8px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 11px;
  line-height: 1.5;
}

.sv-zoom-reset:hover {
  color: var(--lb-accent);
  border-color: var(--lb-accent-2);
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
  border-radius: var(--lb-radius-full);
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
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-2);
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
  box-shadow: var(--lb-shadow-1);
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

/* 候选下拉关键词标记：与全局结果列表同款高亮（--lb-hit）；v-html 内容无 scoped 位 → :deep */
.sv-search-pop :deep(em) {
  font-style: normal;
  font-weight: 600;
  background: var(--lb-hit);
  color: var(--lb-text);
  border-radius: var(--lb-radius-micro);
  padding: 0 2px;
  margin: 0 -1px;
}

/* 正文全篇命中高亮：同一琥珀令牌，柔和底、去蓝色下划线 */
.sv-scroll mark.sv-hit {
  background: var(--lb-hit);
  color: inherit;
  padding: 0 2px;
  border-radius: var(--lb-radius-micro);
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

/* ---------- 行内标题：编大分编次之章节小，编/分编/章居中 ---------- */
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

.sv-h-subbranch {
  font-size: 19px;
  font-weight: 600;
  margin: 44px 0 16px;
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
.sv-col > .sv-h-subbranch:first-child,
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
  border-radius: var(--lb-radius-micro);
}

.sv-label-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 18px 0 4px;
}

.sv-label {
  font-family: var(--lb-serif);
  font-size: 16px;
  font-weight: 700;
  color: var(--lb-text);
}

/* 条文修正入口：悬停条文才显露（平时不打扰阅读） */
.sv-fix-btn {
  border: none;
  background: transparent;
  color: var(--lb-muted);
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: var(--lb-radius-xs);
  opacity: 0;
  transition: opacity 0.15s ease, color 0.12s ease, background 0.12s ease;
}

.sv-article:hover .sv-fix-btn {
  opacity: 0.75;
}

.sv-fix-btn:hover {
  opacity: 1;
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

/* 星标开关：未星标随悬停浮现，已星标常驻可见（点亮态用 warn 金——区别于批注★的 accent） */
.sv-star-btn {
  border: none;
  background: transparent;
  color: var(--lb-muted);
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: var(--lb-radius-xs);
  opacity: 0;
  transition: opacity 0.15s ease, color 0.12s ease, background 0.12s ease;
}

.sv-article:hover .sv-star-btn {
  opacity: 0.75;
}

.sv-star-btn.on {
  opacity: 1;
  color: var(--lb-warn-fg);
}

.sv-star-btn:hover {
  opacity: 1;
  color: var(--lb-warn-fg);
  background: var(--lb-warn-bg);
}

.sv-article:first-child .sv-label-row {
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
  border-radius: var(--lb-radius-full);
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

.sv-toc-item[data-level='subbranch'] {
  padding-left: 20px;
  font-weight: 500;
}

/* ---------- 批注：点线下划线 + ★（accent 家族，与搜索胶囊区分） ---------- */
.sv-scroll .sv-anno {
  background: rgba(0, 113, 227, 0.05);
  border-radius: var(--lb-radius-micro);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-decoration-color: var(--lb-accent-2);
  text-underline-offset: 3px;
  transition: background 0.12s ease;
}

.sv-scroll .sv-anno:hover {
  background: rgba(0, 113, 227, 0.1);
}

.sv-anno-star {
  color: var(--lb-accent);
  font-size: 11px;
  cursor: pointer;
  padding: 0 1px;
  border-radius: var(--lb-radius-micro);
  transition: background 0.12s ease;
}

.sv-anno-star:hover {
  background: var(--lb-accent-soft);
}

/* ---------- 批注/修正浮窗（弹层配方同 .search-pop：radius-l + 同款投影） ---------- */
.sv-anno-pop {
  position: fixed;
  z-index: 420;
  width: 320px;
  padding: 10px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-2);
}

.sv-anno-input {
  width: 100%;
  min-height: 64px;
  max-height: 220px;
  resize: vertical;
  padding: 6px 9px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  color: var(--lb-text);
  outline: none;
  transition: border-color 0.25s, box-shadow 0.25s;
}

.sv-anno-input:focus {
  border-color: rgba(0, 113, 227, 0.55);
  box-shadow: 0 2px 10px rgba(0, 113, 227, 0.16);
}

.sv-anno-input::placeholder {
  color: var(--lb-muted);
}

.sv-anno-pop-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.sv-anno-time {
  flex: 1;
  font-size: 12px;
  color: var(--lb-muted);
}

.sv-anno-del {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: transparent;
  font-size: 12px;
  color: var(--lb-warn-fg);
}

.sv-anno-del:hover {
  border-color: var(--lb-warn-fg);
}

.sv-anno-close {
  height: 26px;
  padding: 0 10px;
}

/* （AI 已解绑为 App 全局抽屉——样式随组件迁去 App.vue） */

.sv-toc-item[data-level='chapter'] {
  padding-left: 34px;
}

.sv-toc-item[data-level='section'] {
  padding-left: 48px;
  font-size: 12.5px;
  color: var(--lb-muted);
}
</style>
