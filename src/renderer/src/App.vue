<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AboutDialog from './components/AboutDialog.vue'
import AiSettingsDialog from './components/AiSettingsDialog.vue'
import BackupDialog from './components/BackupDialog.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import DocLibrary from './components/DocLibrary.vue'
import ImportDialog from './components/ImportDialog.vue'
import ReadingView from './components/ReadingView.vue'
import ResultList from './components/ResultList.vue'
import StatuteReadingView from './components/StatuteReadingView.vue'
import UpdateToast from './updaterUI/UpdateToast.vue'
import { TOPBAR_HINTS, pickDistinct } from '@shared/searchHints'
import type {
  DocGroupRow,
  DocumentDetail,
  DocumentRow,
  SearchHit,
  SearchMode,
  SearchOutcome
} from '@shared/types'

/**
 * 阅读器状态：书籍/案例/资料 = 沉浸阅读（ReadingView 按段落流）；
 * 法规 = 全页阅读（StatuteReadingView，focusOrder = 搜索直达的初始定位）。
 * 中栏单条/文档视图已随「专题」板块一并退场。
 */
type ReaderState =
  | { type: 'book'; data: DocumentDetail; focusPara?: number }
  | { type: 'statute-full'; data: DocumentDetail; focusOrder?: number }
  | null

/** 交给 ImportDialog 的待导入文件（路径经 webUtils 解析，仅用于交回主进程读取） */
interface ImportFileEntry {
  path: string
  name: string
  size: number
}

const query = ref('')
const modeSel = ref<SearchMode>('auto') // 检索模式三选，默认自动（修复旧版 #13）
/** 检索模式下拉（自定义菜单，替代原生 select 的系统样式） */
const modeMenuOpen = ref(false)
const modeNames: Record<SearchMode, string> = {
  auto: '自动',
  locate: '法条定位',
  fulltext: '全文搜索'
}

function pickMode(m: SearchMode): void {
  modeSel.value = m
  modeMenuOpen.value = false
  // 切模式立即按新模式重搜（旧版只改值不重搜，浮层留着旧模式的结果）
  if (query.value.trim()) {
    clearTimeout(topTimer)
    void runTopSearch({ pick: false })
  }
}

/** 点击菜单外部时收起下拉与结果浮层 */
function onDocClickForMode(e: MouseEvent): void {
  const el = e.target as HTMLElement
  if (!el.closest('.mode-menu')) modeMenuOpen.value = false
  // 顶栏检索结果浮层：点到它自己和检索区之外就收起
  if (!el.closest('.search-area') && !el.closest('.search-pop')) searchPopOpen.value = false
}

// ---------- 无边框窗口控制（自绘 ──□✕） ----------
function winMinimize(): void {
  window.lexbench.win.minimize()
}

function winToggleMax(): void {
  window.lexbench.win.toggleMaximize()
}

function winClose(): void {
  window.lexbench.win.close()
}
const searching = ref(false)
const searched = ref(false)
const lastQuery = ref('') // 最近一次检索实际使用的词（展示用，不随输入框实时变化）
const lastMode = ref<SearchOutcome['mode']>('none')
/** 本次结果的来源注记（ResultList 空态/结果态都要显示降级过程） */
const lastFallback = ref(false)
const lastRescued = ref(false)
const lastEmptyReason = ref<SearchOutcome['emptyReason']>(undefined)
const results = ref<SearchHit[]>([])
/** 顶栏快捷检索的结果浮层：结果只在这个小窗里呈现，不占主区域、不切页面 */
const searchPopOpen = ref(false)

/** 顶栏浮窗里键盘选中的那条（↑↓ 移动、回车选中） */
const topActive = ref(0)

/** 搜索示例占位：本次启动从池里随机取，别常年只显示同一组（输入后不影响） */
const topHint = pickDistinct(TOPBAR_HINTS, 1)[0] ?? TOPBAR_HINTS[0]
const documents = ref<DocumentRow[]>([])
/** 用户自建分类文件夹（全类型，DocLibrary / ImportDialog 各自按类型过滤） */
const groups = ref<DocGroupRow[]>([])
const reader = ref<ReaderState>(null)
const readerLoading = ref(false)
const showImport = ref(false)
/** 数据备份/恢复对话框（v0.5.0 数据包） */
const showBackup = ref(false)
/** AI 模型档案设置对话框（v0.7.0） */
const showAiSettings = ref(false)
/**
 * AI 独立窗口（2026-10-17 用户定位：真·独立窗口，与主窗口互不隶属，
 * 系统原生标题栏拖动/缩放/右上角关闭；不设 alwaysOnTop——绝不永远前置）。
 * 主窗口顶栏按钮只负责开关；窗口本体由主进程 aiWindow.ts 创建（?aiWindow=1 挂 AiFloatWindow）。
 */
const aiWinOpen = ref(false)

/** 顶栏开关：切走/唤出独立 AI 窗 */
function toggleAiWindow(): void {
  void window.lexbench.aiWindow.toggle().catch((e) => showError(e))
}
/** 「关于」对话框：版本信息 + 手动检查更新（v0.8.1） */
const showAbout = ref(false)
const dropFiles = ref<ImportFileEntry[]>([])
const dragging = ref(false)
const error = ref('')
const version = ref('')
const pendingDelete = ref<DocumentRow | null>(null)

/** 全局消息条：导出成功等正向反馈（复用错误条容器，6 秒自动消失） */
const notice = ref<{ text: string; kind: 'success' | 'warn' } | null>(null)

let dragDepth = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined

// 删除确认弹窗文案
const deleteMessage = computed(() =>
  pendingDelete.value
    ? `确定删除《${pendingDelete.value.title}》？其条文/段落与全文索引将一并移除，此操作不可撤销。`
    : ''
)

// 全局错误条：所有 API 失败都进这里，可手动关闭（修复旧版 #4/#19）
function showError(e: unknown): void {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  error.value = msg || '操作失败，请稍后重试'
}

/** 消息条（修复旧版 #23：导出等操作不再无反馈），6 秒自动消失 */
function setNotice(text: string, kind: 'success' | 'warn' = 'success'): void {
  notice.value = { text, kind }
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = null
  }, 6000)
}

async function refreshDocs(): Promise<void> {
  try {
    documents.value = await window.lexbench.library.listDocuments()
  } catch (e) {
    showError(e)
  }
}

async function refreshGroups(): Promise<void> {
  try {
    groups.value = await window.lexbench.groups.list()
  } catch (e) {
    showError(e)
  }
}

/** DocLibrary 内分类增删改 / 文档改归属：分组计数与文档列表都要重取 */
async function onGroupsChanged(): Promise<void> {
  await refreshGroups()
  await refreshDocs()
}

/** 导入完成（含部分失败）：新文档可能新建/归入分类，文档库与分组计数一并刷新 */
async function onImported(): Promise<void> {
  await refreshDocs()
  await refreshGroups()
}

// ---------- 顶栏实时检索（输入即搜；150ms 防抖 + 请求序号丢弃过期响应） ----------

const TOP_SEARCH_MS = 150
let topTimer: ReturnType<typeof setTimeout> | undefined
let topSeq = 0
/** IME 组合态：组合中不搜不跳（选字回车也不触发），上屏后补搜 */
const topComposing = ref(false)

/**
 * 顶栏检索唯一执行体。pick=true 仅用于显式提交（回车/检索按钮）：
 * 法条定位命中时自动打开第一条；实时路径必须 pick=false——
 * 否则打字过程中「民法典 10」这种瞬时可定位态会把阅读器跳走。
 */
async function runTopSearch(opts: { pick: boolean }): Promise<void> {
  const q = query.value.trim()
  if (!q) return
  const seq = ++topSeq
  searching.value = true
  try {
    const out = await window.lexbench.search.run(q, modeSel.value)
    if (seq !== topSeq) return // 过期响应：期间又敲了新查询，直接丢弃
    lastQuery.value = out.query
    lastMode.value = out.mode
    lastFallback.value = out.fallback ?? false
    lastRescued.value = out.rescued ?? false
    lastEmptyReason.value = out.emptyReason
    results.value = out.results
    searched.value = true
    topActive.value = 0
    // 结果落进小浮窗：不切页面、不占主区域，用户随手查一条就走
    searchPopOpen.value = true
    // 法条定位命中 → 直接打开全页阅读并跳到那一条（仅显式提交）
    if (opts.pick && out.mode === 'locate' && out.results[0]?.kind === 'article') {
      openResult(out.results[0])
    }
  } catch (e) {
    if (seq === topSeq) showError(e)
  } finally {
    if (seq === topSeq) searching.value = false
  }
}

/** 显式提交（检索按钮 / 回车兜底）：定位命中即打开第一条 */
function doSearch(): void {
  clearTimeout(topTimer) // 收掉挂起的实时防抖，显式提交不被 pick:false 的实时请求反超
  void runTopSearch({ pick: true })
}

/** 顶栏键入：随输入实时出候选（清空则收起） */
function onTopInput(): void {
  if (topComposing.value) return // 拼音未上屏，不发半截查询
  clearTimeout(topTimer)
  const q = query.value.trim()
  if (!q) {
    searchPopOpen.value = false
    return
  }
  searchPopOpen.value = true
  topTimer = setTimeout(() => void runTopSearch({ pick: false }), TOP_SEARCH_MS)
}

/**
 * 沉浸阅读（书籍/案例/资料的段落流；pdf 走页面模式）：
 * hitId（检索命中的 chunk id）/focusPara 用于进入后定位段落。
 */
async function openReading(id: number, opts?: { hitId?: number; focusPara?: number }): Promise<void> {
  readerLoading.value = true
  try {
    const detail = await window.lexbench.library.getDocument(id)
    let focus = opts?.focusPara
    if (focus === undefined && opts?.hitId !== undefined) {
      focus = detail.chunks.find((c) => c.id === opts.hitId)?.seq
    }
    reader.value = { type: 'book', data: detail, focusPara: focus }
  } catch (e) {
    showError(e)
  } finally {
    readerLoading.value = false
  }
}

/** 法规全页阅读（文档库/搜索直达统一落点）：focusOrder = 打开时定位到该条 */
async function openStatuteFull(id: number, opts?: { focusOrder?: number }): Promise<void> {
  readerLoading.value = true
  try {
    reader.value = {
      type: 'statute-full',
      data: await window.lexbench.library.getDocument(id),
      focusOrder: opts?.focusOrder
    }
  } catch (e) {
    showError(e)
  } finally {
    readerLoading.value = false
  }
}

/** 法条修正保存后：重取文档（content 变了），保持当前位置不跳 */
async function reloadStatuteDoc(): Promise<void> {
  if (reader.value?.type !== 'statute-full') return
  try {
    reader.value = {
      type: 'statute-full',
      data: await window.lexbench.library.getDocument(reader.value.data.id)
    }
  } catch (e) {
    showError(e)
  }
}

/** 文档库卡片入口：statute→全页法规；其余（书籍/案例/资料）→沉浸阅读 */
async function openFromLibrary(id: number): Promise<void> {
  const doc = documents.value.find((d) => d.id === id)
  if (doc?.doc_type === 'statute') return openStatuteFull(id)
  return openReading(id)
}

/** 退出阅读模式：回到文档库 */
function closeReading(): void {
  reader.value = null
}

/** 阅读模式正向反馈 → 全局消息条 */
function onReadingNotice(text: string): void {
  setNotice(text)
}

/** 搜索结果落点：法条→全页阅读跳到该条；段落命中→沉浸阅读定位段落 */
function openResult(hit: SearchHit): void {
  if (hit.kind === 'article') {
    void openStatuteFull(hit.document_id, { focusOrder: hit.order_index })
  } else if (hit.doc_type === 'book') {
    void openReading(hit.document_id, { hitId: hit.id })
  } else {
    void openReading(hit.document_id, { hitId: hit.id })
  }
}

/** AI 独立窗里的引用点击：主窗口打开该法条所属文档并跳到该条（AI 窗保持独立不关闭） */
async function openArticleFromAi(articleId: number): Promise<void> {
  try {
    const d = await window.lexbench.library.getArticle(articleId)
    const docId = d.article.document_id
    const order = d.article.order_index
    if (reader.value?.type === 'statute-full' && reader.value.data.id === docId) {
      // 同文档：改 focusOrder 触发阅读页内跳转（组件靠 watch 二次定位，不重挂）
      reader.value = { ...reader.value, focusOrder: order }
    } else {
      await openStatuteFull(docId, { focusOrder: order })
    }
  } catch (e) {
    showError(e)
  }
}

/** 顶栏浮窗里选中一条：打开它，并收起浮窗（用户看完即走，不占版面） */
function onPopPick(hit: SearchHit): void {
  searchPopOpen.value = false
  openResult(hit)
}

/**
 * 点回检索框就把上次的结果重新弹出来——选中一条之后候选会收起，
 * 若只能靠重新打字才能再看，用起来很别扭。
 * 注意：确认后输入框仍是聚焦态，focus 不会再触发，所以 click 也要接。
 */
function onTopFocus(): void {
  // 只有结果确实对应当前输入才重开（否则会把上一个查询的旧结果弹出来）
  if (results.value.length && query.value.trim() === lastQuery.value) {
    searchPopOpen.value = true
  }
}

/** ↑↓ 在顶栏候选中移动 */
function moveTop(delta: number): void {
  const n = results.value.length
  if (!n) return
  topActive.value = (topActive.value + delta + n) % n
}

/** 回车：
 *  ① IME 选字回车忽略；② 空查询给提示（不再静默吞）；
 *  ③ 结果对应当前查询（lastQuery 一致）→ 选中高亮那条；
 *  ④ 否则（改了词还没搜过）→ 立即对新查询执行检索——
 *     根治「改词回车却选中上一次旧结果」的头号搜不到 bug */
async function submitTop(e: KeyboardEvent): Promise<void> {
  if (topComposing.value || e.isComposing || e.keyCode === 229) return
  clearTimeout(topTimer)
  const q = query.value.trim()
  if (!q) {
    setNotice('先输入检索词，再回车检索', 'warn')
    return
  }
  if (searchPopOpen.value && results.value.length && q === lastQuery.value) {
    onPopPick(results.value[topActive.value])
    return
  }
  await runTopSearch({ pick: true })
}

/** 顶栏候选中高亮的那条（给列表加选中文案） */
const topSelectedId = computed(() => {
  const h = results.value[topActive.value]
  return h && h.kind === 'article' ? h.id : -1
})

function askDelete(doc: DocumentRow): void {
  pendingDelete.value = doc
}

async function confirmDelete(): Promise<void> {
  const doc = pendingDelete.value
  if (!doc) return
  try {
    await window.lexbench.library.deleteDocument(doc.id)
    // 删除的正是打开中的文档时才关掉阅读视图
    if (reader.value && reader.value.data.id === doc.id) reader.value = null
    await refreshDocs()
  } catch (e) {
    showError(e)
  } finally {
    pendingDelete.value = null
  }
}

/** 需复查文档一键标记已复查（修复旧版 #2：文档状态只能看不能改） */
async function markReviewed(id: number): Promise<void> {
  try {
    await window.lexbench.library.setDocumentStatus(id, 'parsed')
    if (reader.value?.type === 'statute-full' && reader.value.data.id === id) await reloadStatuteDoc()
    await refreshDocs()
  } catch (e) {
    showError(e)
  }
}

// ---------- 全窗口拖拽导入 ----------

function onDragEnter(e: DragEvent): void {
  // 导入对话框打开时交给对话框内部拖拽区处理（修复旧版 #7 双重处理）
  if (showImport.value) return
  if (!e.dataTransfer?.types.includes('Files')) return
  dragDepth++
  dragging.value = true
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  if (showImport.value) return
  const all = Array.from(e.dataTransfer?.files ?? [])
  const ok = all.filter((f) => /\.(docx|pdf|txt|doc)$/i.test(f.name))
  if (!ok.length) {
    // 拖入不支持的类型给出可感知反馈，而非静默（修复旧版 #14）
    if (all.length) {
      error.value = '不支持的文件类型：目前仅支持 .docx / .doc / .pdf / .txt'
    }
    return
  }
  const entries = ok
    .map((f) => ({ path: window.lexbench.dialog.getPathForFile(f), name: f.name, size: f.size }))
    .filter((x) => x.path)
  if (!entries.length) {
    error.value = '无法读取拖入文件的本地路径，请改用右上角「导入文档」按钮'
    return
  }
  dropFiles.value = entries
  showImport.value = true
}

// 对话框关闭后清空预填文件，避免下次打开重现上一批拖拽文件
watch(showImport, (open) => {
  if (!open) dropFiles.value = []
})

/** AI 独立窗订阅的退订函数 */
let unsubAiVis: (() => void) | null = null
let unsubAiArticle: (() => void) | null = null

onMounted(() => {
  // 命名监听器，卸载时全部注销（修复旧版 #6）
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('drop', onDrop)
  document.addEventListener('click', onDocClickForMode)
  // AI 独立窗：顶栏按钮态同步 + 窗内引用跳转转发
  unsubAiVis = window.lexbench.aiWindow.onVisibility((v) => {
    aiWinOpen.value = v
  })
  unsubAiArticle = window.lexbench.aiWindow.onOpenArticle((id) => void openArticleFromAi(id))
  void refreshDocs()
  void refreshGroups()
  void window.lexbench.app
    .getVersion()
    .then((v) => {
      version.value = v
    })
    .catch(() => {})
  // 首次启动预置了随包法条 → 提示一次，便于新用户直接上手检索
  void window.lexbench.library
    .getSeedInfo()
    .then((info) => {
      if (info.justApplied && info.count > 0) {
        setNotice(`已为你预置 ${info.count} 部常用法律与司法解释，直接检索即可使用`, 'success')
      }
    })
    .catch(() => {})
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('drop', onDrop)
  document.removeEventListener('click', onDocClickForMode)
  unsubAiVis?.()
  unsubAiArticle?.()
  clearTimeout(noticeTimer)
  clearTimeout(topTimer)
})
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">法</span>
        <span class="brand-name">法研台</span>
        <span class="brand-en">LexBench<span v-if="version" class="brand-ver">v{{ version }}</span></span>
      </div>
      <div class="search-area">
        <div class="search-group">
          <div class="mode-menu">
            <button class="mode-trigger" title="检索模式" @click="modeMenuOpen = !modeMenuOpen">
              <span>{{ modeNames[modeSel] }}</span>
              <svg
                class="mode-caret"
                :class="{ open: modeMenuOpen }"
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
              >
                <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <Transition name="menu-pop">
              <div v-if="modeMenuOpen" class="mode-pop" role="listbox">
                <button
                  v-for="(name, m) in modeNames"
                  :key="m"
                  class="mode-opt"
                  :class="{ on: modeSel === m }"
                  role="option"
                  :aria-selected="String(modeSel === m)"
                  @click="pickMode(m as SearchMode)"
                >
                  <span>{{ name }}</span>
                  <svg v-if="modeSel === m" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M2.5 6.5l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
            </Transition>
          </div>
          <input
            v-model="query"
            class="search-input"
            type="text"
            :placeholder="topHint"
            @input="onTopInput"
            @focus="onTopFocus"
            @compositionstart="topComposing = true"
            @compositionend="topComposing = false; onTopInput()"
            @click="onTopFocus"
            @keydown.down.prevent="moveTop(1)"
            @keydown.up.prevent="moveTop(-1)"
            @keydown.enter="submitTop($event)"
            @keydown.esc="searchPopOpen = false"
          />
          <button class="search-btn" :disabled="searching" @click="doSearch">
            <span v-if="searching" class="spinner" aria-label="检索中"></span>
            <span v-else>检 索</span>
          </button>

          <!-- 快捷检索结果：就地一个小浮窗，不切页面、不占主区域，随手查一条就走 -->
          <Transition name="menu-pop">
            <div v-if="searchPopOpen" class="search-pop">
              <ResultList
                :results="results"
                :mode="lastMode"
                :searched="searched"
                :searching="searching"
                :query="lastQuery"
                :selected-id="topSelectedId"
                :has-docs="documents.length > 0"
                :fallback="lastFallback"
                :rescued="lastRescued"
                :empty-reason="lastEmptyReason"
                @select="onPopPick"
              />
            </div>
          </Transition>
        </div>
      </div>
      <button class="top-btn" @click="showImport = true">导入文档</button>
      <button
        class="top-btn"
        :class="{ on: aiWinOpen }"
        title="通用法律问答助手（独立窗口）：随便问，不用出软件去别处查"
        @click="toggleAiWindow"
      >
        ✦ AI 助手
      </button>
      <button class="top-btn" title="配置 AI 模型档案（接口地址 / 模型 / 密钥）" @click="showAiSettings = true">
        AI 设置
      </button>
      <button class="top-btn" title="导出/导入数据包（换电脑与备份）" @click="showBackup = true">
        数据
      </button>
      <button class="top-btn" title="版本信息与检查更新" @click="showAbout = true">关于</button>

      <!-- 无边框窗口自绘控制按钮（──□✕） -->
      <div class="win-controls">
        <button class="wc" title="最小化" aria-label="最小化" @click="winMinimize">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="4.6" width="8" height="0.9" fill="currentColor" /></svg>
        </button>
        <button class="wc" title="最大化 / 还原" aria-label="最大化或还原" @click="winToggleMax">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.2" y="1.2" width="7.6" height="7.6" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>
        </button>
        <button class="wc wc-close" title="关闭" aria-label="关闭" @click="winClose">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" /></svg>
        </button>
      </div>
    </header>

    <Transition name="bar-slide">
      <div v-if="error" class="error-bar">
        <span class="error-text">{{ error }}</span>
        <button class="error-close" title="关闭" @click="error = ''">✕</button>
      </div>
    </Transition>

    <!-- 全局消息条：成功/提示反馈（导出、收藏等），6 秒自动消失，也可手动关闭 -->
    <Transition name="bar-slide">
      <div v-if="notice" class="error-bar notice" :data-kind="notice.kind">
        <span class="error-text">{{ notice.text }}</span>
        <button class="error-close" title="关闭" @click="notice = null">✕</button>
      </div>
    </Transition>

    <!-- 书籍沉浸阅读：整区替换工作台三栏（返回时恢复原 Tab） -->
    <main v-if="reader?.type === 'book'" class="reading-full">
      <ReadingView
        :key="reader.data.id"
        :doc="reader.data"
        :focus-para="reader.focusPara"
        @back="closeReading"
        @error="showError"
        @notice="onReadingNotice"
      />
    </main>

    <!-- 法规全页阅读：文档库卡片 / 搜索直达统一落点，目录+连续正文+批注 -->
    <main v-else-if="reader?.type === 'statute-full'" class="reading-full">
      <StatuteReadingView
        :key="reader.data.id"
        :doc="reader.data"
        :focus-order="reader.focusOrder"
        @back="closeReading"
        @error="showError"
        @notice="setNotice"
        @doc-changed="reloadStatuteDoc"
      />
    </main>

    <!-- 首页 = 文档库（专题退场后唯一的常驻板块；笔记库在后续阶段加入左导航） -->
    <main v-else class="main">
      <aside class="side">
        <DocLibrary
          :documents="documents"
          :groups="groups"
          @open="openFromLibrary"
          @remove="askDelete"
          @mark-reviewed="markReviewed"
          @groups-changed="onGroupsChanged"
          @docs-changed="refreshDocs"
          @error="showError"
        />
      </aside>
    </main>

    <ImportDialog
      v-model:visible="showImport"
      :initial-files="dropFiles"
      :groups="groups"
      @imported="onImported"
      @error="showError"
    />

    <BackupDialog
      v-model:visible="showBackup"
      @error="showError"
      @notice="setNotice"
    />

    <AiSettingsDialog
      v-model:visible="showAiSettings"
      @error="showError"
      @notice="setNotice"
    />

    <AboutDialog v-model:visible="showAbout" @error="showError" />

    <ConfirmModal
      :visible="pendingDelete !== null"
      title="删除文档"
      :message="deleteMessage"
      danger
      confirm-text="删除"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <div v-if="dragging" class="drag-overlay">
      <div class="drag-hint">松开鼠标，导入法律文档</div>
    </div>

    <UpdateToast />
  </div>
</template>

<style>
/* 视觉令牌：全应用共用，组件内一律引用这些变量（Apple 风格：墨黑/银灰/苹果蓝/云雾灰） */
:root {
  --lb-bg: #f5f5f7;
  --lb-panel: #ffffff;
  --lb-text: #1d1d1f;
  --lb-muted: #86868b;
  --lb-border: rgba(0, 0, 0, 0.07);
  --lb-border-strong: rgba(0, 0, 0, 0.12);
  /* 搜索关键词高亮：accent 同源浅蓝胶囊（与 hover/选中态同色相，inline 尺寸），全搜索面统一 */
  --lb-hit: rgba(0, 113, 227, 0.14);
  --lb-accent: #0071e3;
  --lb-accent-2: #0077ed;
  --lb-grad: #0071e3; /* Apple 主按钮为纯色，不再使用渐变 */
  --lb-accent-soft: rgba(0, 113, 227, 0.1);
  --lb-chip: #e8e8ed;
  --lb-warn-bg: #fdf3e3;
  --lb-warn-fg: #9a6a15;
  --lb-err-bg: #fdecea;
  --lb-err-fg: #8c2b23;
  --lb-ok-bg: #e8f5ec;
  --lb-ok-fg: #22763a;
  --lb-radius-s: 10px;
  --lb-radius-l: 14px;
  --lb-serif: 'LXGW WenKai', 'Songti SC', 'STSong', 'SimSun', Georgia, 'Times New Roman', serif;
}
</style>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--lb-bg);
}

/* ---------- 顶栏（Apple 浅色导航：与无边框窗口融合） ---------- */
.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  height: 54px;
  padding: 0 8px 0 20px;
  background: #fbfbfd;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  flex-shrink: 0;
  -webkit-app-region: drag; /* 顶栏空白处可拖动窗口 */
}

/* 顶栏内可交互元素必须排除拖拽，否则无法点击 */
.topbar button,
.topbar input,
.topbar select {
  -webkit-app-region: no-drag;
}

/* 顶栏里的浮层必须显式排除拖拽：
   上面的白名单只覆盖 button/input/select，而检索结果浮窗的候选行是 div——
   落在拖拽区里，真实鼠标点击会被吃掉（表现为「点候选没反应」）。
   注意：CDP 的合成事件会绕过拖拽区，所以自动化自测发现不了这个坑，必须真手点。 */
.topbar .search-pop,
.topbar .mode-pop {
  -webkit-app-region: no-drag;
}

/* ---------- 自绘窗口控制按钮（─□✕） ---------- */
.win-controls {
  display: flex;
  align-items: stretch;
  height: 100%;
  margin-left: 2px;
  flex-shrink: 0;
}

.wc {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  border: none;
  background: transparent;
  color: var(--lb-muted);
}

.wc:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--lb-text);
}

.wc:active {
  background: rgba(0, 0, 0, 0.1);
  transform: none; /* 窗口控制按钮不缩放，保持系统感 */
}

.wc.wc-close:hover {
  background: #ff3b30;
  color: #fff;
}

.wc.wc-close:active {
  background: #e03027;
  color: #fff;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--lb-radius-s);
  background: var(--lb-grad);
  color: #fff;
  font-family: var(--lb-serif);
  font-size: 18px;
  font-weight: 600;
}

.brand-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--lb-text);
  letter-spacing: -0.01em;
}

.brand-en {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #9a9aa8;
}

.brand-ver {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--lb-chip);
  font-size: 11px;
  color: var(--lb-muted);
}

.search-area {
  flex: 1;
  display: flex;
  justify-content: center;
  min-width: 0;
}

/* 检索框是结果浮窗的定位锚点 */
.search-group {
  position: relative;
}

/* ---------- 顶栏快捷检索的结果浮窗 ---------- */
.search-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 30;
  max-height: 60vh;
  overflow-y: auto;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  background: var(--lb-panel);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.18);
}

.search-group {
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 720px;
  background: var(--lb-panel);
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 980px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  transition: border-color 0.25s, box-shadow 0.25s;
}

/* ---------- 检索模式下拉（Apple 风格弹出菜单） ---------- */
.mode-menu {
  position: relative;
  flex-shrink: 0;
}

.mode-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 40px;
  padding: 0 10px 0 16px;
  border: none;
  border-radius: 980px;
  background: transparent;
  color: var(--lb-muted);
  font-size: 13px;
}

.mode-trigger:hover {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.mode-caret {
  transition: transform 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.mode-caret.open {
  transform: rotate(180deg);
}

.mode-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 148px;
  padding: 5px;
  background: var(--lb-panel);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: var(--lb-radius-l);
  box-shadow:
    0 4px 18px rgba(0, 0, 0, 0.1),
    0 12px 40px rgba(0, 0, 0, 0.08);
  z-index: 300;
}

.mode-opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--lb-radius-s);
  background: transparent;
  color: var(--lb-text);
  font-size: 13px;
  text-align: left;
}

.mode-opt:hover {
  background: var(--lb-chip);
}

.mode-opt.on {
  color: var(--lb-accent);
  font-weight: 600;
}

/* 弹出/收起动画：从触发器上方缩放浮现 */
@media (prefers-reduced-motion: no-preference) {
  .menu-pop-enter-active {
    transition:
      transform 0.18s cubic-bezier(0.25, 0.1, 0.25, 1),
      opacity 0.18s ease;
  }
  .menu-pop-leave-active {
    transition: transform 0.12s ease, opacity 0.12s ease;
  }
}

.menu-pop-enter-from,
.menu-pop-leave-to {
  transform: scale(0.95) translateY(-4px);
  transform-origin: top left;
  opacity: 0;
}

.search-input {
  flex: 1;
  height: 40px;
  padding: 0 8px;
  border: none;
  background: transparent;
  font-size: 14px;
  color: var(--lb-text);
  outline: none;
  min-width: 0;
}

.search-group:focus-within {
  border-color: rgba(0, 113, 227, 0.55);
  box-shadow: 0 2px 10px rgba(0, 113, 227, 0.16);
}

.search-btn {
  height: 32px;
  margin-right: 4px;
  padding: 0 20px;
  border: none;
  border-radius: 980px;
  background: var(--lb-accent);
  color: #fff;
  font-size: 13px;
  flex-shrink: 0;
  transition: background 0.2s;
}

.search-btn:hover {
  filter: brightness(1.06);
}

.search-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.top-btn {
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 980px;
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
  flex-shrink: 0;
  transition: border-color 0.2s, color 0.2s, box-shadow 0.2s;
}

.top-btn:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

/* ---------- 全局错误条 ---------- */
.error-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 20px;
  background: var(--lb-err-bg);
  color: var(--lb-err-fg);
  font-size: 13px;
  flex-shrink: 0;
}

.error-text {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
}

.error-close {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  padding: 2px 7px;
  border-radius: 5px;
  flex-shrink: 0;
}

.error-close:hover {
  background: rgba(0, 0, 0, 0.06);
}

/* 消息条变体：复用错误条容器（成功=绿 / 提示=黄） */
.error-bar.notice[data-kind='success'] {
  background: var(--lb-ok-bg);
  color: var(--lb-ok-fg);
}

.error-bar.notice[data-kind='warn'] {
  background: var(--lb-warn-bg);
  color: var(--lb-warn-fg);
}

/* ---------- 消息条滑入滑出（Apple：顶部推入而非突然出现） ---------- */
@media (prefers-reduced-motion: no-preference) {
  .bar-slide-enter-active,
  .bar-slide-leave-active {
    transition:
      transform 0.24s cubic-bezier(0.25, 0.1, 0.25, 1),
      opacity 0.24s ease;
  }
}

.bar-slide-enter-from,
.bar-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}

/* ---------- 检索按钮加载转圈 ---------- */
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: lb-spin 0.7s linear infinite;
}

@keyframes lb-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
    border: none;
    border-radius: 0;
    width: auto;
    height: auto;
  }
  .spinner::before {
    content: '检索中…';
  }
}

/* ---------- 主区布局 ---------- */
.main {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 书籍沉浸阅读：整区替换（侧栏/阅读器均由 ReadingView 自管） */
.reading-full {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.side {
  width: 340px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--lb-panel);
  border-right: 1px solid var(--lb-border);
}

/* 顶栏「✦ AI 助手」按下态（配方同 sv-top-btn.on：accent 边+柔底） */
.top-btn.on {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

/* ---------- 拖拽遮罩 ---------- */
.drag-overlay {
  position: fixed;
  inset: 0;
  background: rgba(30, 28, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 600;
  pointer-events: none;
}

.drag-hint {
  padding: 26px 46px;
  border: 2px dashed rgba(255, 255, 255, 0.8);
  border-radius: 14px;
  color: #fff;
  font-size: 18px;
  font-family: var(--lb-serif);
}
</style>
