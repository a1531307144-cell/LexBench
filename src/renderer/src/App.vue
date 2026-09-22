<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AboutDialog from './components/AboutDialog.vue'
import AiSettingsDialog from './components/AiSettingsDialog.vue'
import BackupDialog from './components/BackupDialog.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import DocLibrary from './components/DocLibrary.vue'
import FavoriteDialog from './components/FavoriteDialog.vue'
import ImportDialog from './components/ImportDialog.vue'
import NotePanel from './components/NotePanel.vue'
import Reader from './components/Reader.vue'
import ReadingView from './components/ReadingView.vue'
import ResultList from './components/ResultList.vue'
import TopicPanel from './components/TopicPanel.vue'
import UpdateToast from './updaterUI/UpdateToast.vue'
import type { ItemMoveDirection, TopicPatch } from '@shared/ipc'
import type {
  ArticleDetail,
  DocGroupRow,
  DocumentDetail,
  DocumentRow,
  ExportFormat,
  SearchHit,
  SearchMode,
  SearchOutcome,
  TopicDetail,
  TopicRow
} from '@shared/types'

/** 阅读器状态：法条 / 文档 / 书籍沉浸阅读（与 Reader.vue 内声明保持同一形状） */
type ReaderState =
  | { type: 'article'; data: ArticleDetail }
  | { type: 'document'; data: DocumentDetail }
  | { type: 'book'; data: DocumentDetail; focusPara?: number }
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
}

/** 点击菜单外部时收起下拉（顶栏与专题中栏各有一个模式菜单，共用 .mode-menu 标记） */
function onDocClickForMode(e: MouseEvent): void {
  const el = e.target as HTMLElement
  if (!el.closest('.mode-menu')) {
    modeMenuOpen.value = false
    midModeMenuOpen.value = false
  }
  // 顶栏检索结果浮层：点到它自己和检索区之外就收起
  if (!el.closest('.search-area') && !el.closest('.search-pop')) searchPopOpen.value = false
  // 中栏候选浮层同理
  if (!el.closest('.mid-search') && !el.closest('.mid-pop')) midPopOpen.value = false
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
const results = ref<SearchHit[]>([])
/** 顶栏快捷检索的结果浮层：结果只在这个小窗里呈现，不占主区域、不切页面 */
const searchPopOpen = ref(false)

// ---------- 专题内常驻检索（只在中栏、且打开专题时出现）----------
const midQuery = ref('')
const midMode = ref<SearchMode>('auto')
const midModeMenuOpen = ref(false)
const midSearching = ref(false)
const midResults = ref<SearchHit[]>([])
const midModeUsed = ref<SearchOutcome['mode']>('none')
/** 候选高亮下标；↑↓ 移动时会即时把该条呈现在下方正文区（随检随显） */
const midActive = ref(0)
const midPopOpen = ref(false)
/** 正在加入专题的那条命中 id（−1 = 空闲），防连点 */
const addingId = ref(-1)

/** 导航只剩两栏：专题是工作台，文档库只看库里有什么。检索融进了专题与顶栏浮窗 */
const tab = ref<'topics' | 'library'>('topics')
const documents = ref<DocumentRow[]>([])
/** 用户自建分类文件夹（全类型，DocLibrary / ImportDialog 各自按类型过滤） */
const groups = ref<DocGroupRow[]>([])
const reader = ref<ReaderState>(null)
const readerLoading = ref(false)
/** 进入书籍阅读模式前的 Tab（返回时恢复） */
const preReaderTab = ref<'topics' | 'library'>('topics')
const showImport = ref(false)
/** 数据备份/恢复对话框（v0.5.0 数据包） */
const showBackup = ref(false)
/** AI 模型档案设置对话框（v0.7.0） */
const showAiSettings = ref(false)
/** 「关于」对话框：版本信息 + 手动检查更新（v0.8.1） */
const showAbout = ref(false)
const dropFiles = ref<ImportFileEntry[]>([])
const dragging = ref(false)
const error = ref('')
const version = ref('')
const pendingDelete = ref<DocumentRow | null>(null)

// ---------- 研究工作台（v0.4.0） ----------
const topics = ref<TopicRow[]>([])
const activeTopic = ref<TopicDetail | null>(null)
const showFav = ref(false)
/** 待收藏的法条（id + label），由阅读器的 ★ 收藏按钮赋值 */
const favArticle = ref<{ id: number; label: string } | null>(null)
/** 全局消息条：导出成功 / 收藏成功等正向反馈（复用错误条容器，6 秒自动消失） */
const notice = ref<{ text: string; kind: 'success' | 'warn' } | null>(null)

let dragDepth = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined

// 当前打开的法条 id（结果列表高亮 / 专题条目高亮用）
const selectedId = computed(() =>
  reader.value?.type === 'article' ? reader.value.data.article.id : 0
)

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

// ---------- 工作台：专题 ----------

async function refreshTopics(): Promise<void> {
  try {
    topics.value = await window.lexbench.workspace.listTopics()
  } catch (e) {
    showError(e)
  }
}

async function refreshActiveTopic(): Promise<void> {
  if (!activeTopic.value) return
  try {
    activeTopic.value = await window.lexbench.workspace.getTopic(activeTopic.value.id)
  } catch (e) {
    showError(e)
  }
}

async function openTopic(id: number): Promise<void> {
  try {
    activeTopic.value = await window.lexbench.workspace.getTopic(id)
  } catch (e) {
    showError(e)
  }
}

function backToTopics(): void {
  activeTopic.value = null
}

async function createTopic(name: string, description: string): Promise<void> {
  try {
    await window.lexbench.workspace.createTopic(name, description || undefined)
    await refreshTopics()
  } catch (e) {
    showError(e)
  }
}

async function renameTopic(id: number, patch: TopicPatch): Promise<void> {
  try {
    await window.lexbench.workspace.updateTopic(id, patch)
    await refreshTopics()
    if (activeTopic.value?.id === id) await refreshActiveTopic()
  } catch (e) {
    showError(e)
  }
}

async function deleteTopic(id: number): Promise<void> {
  try {
    await window.lexbench.workspace.deleteTopic(id)
    // 删除后清理：若删的是打开中的专题，右栏笔记随 activeTopic 一并消失
    if (activeTopic.value?.id === id) activeTopic.value = null
    await refreshTopics()
  } catch (e) {
    showError(e)
  }
}

async function removeTopicItem(topicId: number, articleId: number): Promise<void> {
  try {
    await window.lexbench.workspace.removeTopicItem(topicId, articleId)
    await refreshTopics()
    if (activeTopic.value?.id === topicId) await refreshActiveTopic()
  } catch (e) {
    showError(e)
  }
}

async function moveTopicItem(
  topicId: number,
  articleId: number,
  dir: ItemMoveDirection
): Promise<void> {
  try {
    await window.lexbench.workspace.moveTopicItem(topicId, articleId, dir)
    if (activeTopic.value?.id === topicId) await refreshActiveTopic()
  } catch (e) {
    showError(e)
  }
}

// ---------- 工作台：收藏 / 导出 ----------

function openFavorite(): void {
  if (reader.value?.type !== 'article') return
  favArticle.value = { id: reader.value.data.article.id, label: reader.value.data.article.label }
  showFav.value = true
}

/** 收藏成功（含重复幂等）：关对话框 + 刷新计数 + 消息条提示（修复旧版 #15） */
function onFavorited(res: { topicName: string; duplicate: boolean }): void {
  showFav.value = false
  setNotice(
    res.duplicate ? `该法条已收藏在「${res.topicName}」中` : `已收藏到「${res.topicName}」`,
    res.duplicate ? 'warn' : 'success'
  )
  void refreshTopics()
  void refreshActiveTopic()
}

/** 导出报告（修复旧版 #23：window.open 无反馈 → 本地写盘 + 成功消息条显示保存路径） */
async function exportTopic(format: ExportFormat): Promise<void> {
  const t = activeTopic.value
  if (!t) return
  try {
    const r = await window.lexbench.export.saveTopicReport(t.id, format)
    if (!r.canceled && r.path) setNotice(`已导出到 ${r.path}`)
  } catch (e) {
    showError(e)
  }
}

/** NotePanel 笔记增删改后：刷新专题详情与列表计数 */
async function onNotesChanged(): Promise<void> {
  await refreshTopics()
  await refreshActiveTopic()
}

// ---------- 工作台：专题内翻页 override ----------
// 当前法条在激活专题内 → 按专题顺序给相邻条；不在专题内 → undefined（Reader 走法条自身前后条）
const topicNeighbors = computed(() => {
  const t = activeTopic.value
  const r = reader.value
  if (!t || r?.type !== 'article') return undefined
  const cur = r.data.article.id
  const items = t.items
  const i = items.findIndex((it) => it.article_id === cur)
  if (i < 0) return undefined
  return {
    prev: i > 0 ? { id: items[i - 1].article_id, label: items[i - 1].article_label } : null,
    next:
      i < items.length - 1
        ? { id: items[i + 1].article_id, label: items[i + 1].article_label }
        : null
  }
})

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

async function doSearch(): Promise<void> {
  const q = query.value.trim()
  if (!q || searching.value) return
  searching.value = true
  try {
    const out = await window.lexbench.search.run(q, modeSel.value)
    lastQuery.value = out.query
    lastMode.value = out.mode
    results.value = out.results
    searched.value = true
    // 结果落进小浮窗：不切页面、不占主区域，用户随手查一条就走
    searchPopOpen.value = true
    // 法条定位命中 → 直接在中栏打开第一条（同样不切 Tab）
    if (out.mode === 'locate' && out.results[0]?.kind === 'article') {
      await openArticle(out.results[0].id)
    }
  } catch (e) {
    showError(e)
  } finally {
    searching.value = false
  }
}

// ---------- 专题内常驻检索（中栏）----------

/** 输入停顿多久才发检索——本地 SQLite 很快，稍等一点免得每敲一个字就查一次 */
const MID_SEARCH_MS = 300
let midTimer: ReturnType<typeof setTimeout> | undefined
const midInputEl = ref<HTMLInputElement | null>(null)

function onMidInput(): void {
  clearTimeout(midTimer)
  midTimer = setTimeout(() => void runMidSearch(), MID_SEARCH_MS)
}

async function runMidSearch(): Promise<void> {
  const q = midQuery.value.trim()
  if (!q) {
    midResults.value = []
    midPopOpen.value = false
    return
  }
  midSearching.value = true
  try {
    const out = await window.lexbench.search.run(q, midMode.value)
    midResults.value = out.results
    midModeUsed.value = out.mode
    midActive.value = 0
    midPopOpen.value = out.results.length > 0
    await previewMidHit()
  } catch (e) {
    showError(e)
  } finally {
    midSearching.value = false
  }
}

/** 把高亮的那条候选呈现在中栏正文区——「随检随显」，全程不切 Tab、不动左栏 */
async function previewMidHit(): Promise<void> {
  const hit = midResults.value[midActive.value]
  if (!hit) return
  if (hit.kind === 'article') await openArticle(hit.id)
  else if (hit.doc_type === 'book') await openBook(hit.document_id, { hitId: hit.id })
  else await openDocument(hit.document_id)
}

/** ↑↓ 在候选间移动，并即时换正文 */
function moveMid(delta: number): void {
  const n = midResults.value.length
  if (!n) return
  midActive.value = (midActive.value + delta + n) % n
  void previewMidHit()
}

function closeMidPop(): void {
  midPopOpen.value = false
}

/** 左栏「＋ 添加法条」→ 把焦点送到中栏检索条 */
function focusMidSearch(): void {
  tab.value = 'topics'
  midPopOpen.value = false
  void nextTick(() => midInputEl.value?.focus())
}

/** 把候选里的法条加入当前专题（重复收藏由主进程幂等处理） */
async function addHitToTopic(hit: SearchHit): Promise<void> {
  const topic = activeTopic.value
  if (!topic || addingId.value !== -1) return
  if (hit.kind !== 'article') {
    setNotice('只有法条能收进专题；案例与书籍请在「文档库」里查阅')
    return
  }
  addingId.value = hit.id
  try {
    const r = await window.lexbench.workspace.addTopicItem(topic.id, hit.id)
    await refreshTopics()
    await refreshActiveTopic()
    setNotice(r.status === 'duplicate' ? '这条法条已经在本专题里了' : '已加入本专题')
  } catch (e) {
    showError(e)
  } finally {
    addingId.value = -1
  }
}

async function openArticle(id: number): Promise<void> {
  readerLoading.value = true
  try {
    reader.value = { type: 'article', data: await window.lexbench.library.getArticle(id) }
  } catch (e) {
    showError(e)
  } finally {
    readerLoading.value = false
  }
}

async function openDocument(id: number): Promise<void> {
  // 书籍走沉浸阅读模式（阅读模式与法条/文档模式互斥）
  if (documents.value.find((d) => d.id === id)?.doc_type === 'book') {
    await openBook(id)
    return
  }
  readerLoading.value = true
  try {
    reader.value = { type: 'document', data: await window.lexbench.library.getDocument(id) }
  } catch (e) {
    showError(e)
  } finally {
    readerLoading.value = false
  }
}

/** 打开书籍沉浸阅读：hitId（检索命中的 chunk id）/focusPara 用于进入后定位段落 */
async function openBook(id: number, opts?: { hitId?: number; focusPara?: number }): Promise<void> {
  preReaderTab.value = tab.value
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

/** 退出阅读模式：恢复进入前的 Tab */
function closeReading(): void {
  reader.value = null
  tab.value = preReaderTab.value
}

/** 阅读模式正向反馈 → 全局消息条 */
function onReadingNotice(text: string): void {
  setNotice(text)
}

function openResult(hit: SearchHit): void {
  if (hit.kind === 'article') void openArticle(hit.id)
  else if (hit.doc_type === 'book') void openBook(hit.document_id, { hitId: hit.id })
  else void openDocument(hit.document_id)
}

/** 顶栏浮窗里选中一条：打开它，并收起浮窗（用户看完即走，不占版面） */
function onPopPick(hit: SearchHit): void {
  searchPopOpen.value = false
  openResult(hit)
}

/** 中栏候选里点了一条：正文其实已随高亮呈现过了，这里只是把高亮对齐并收起候选 */
function onMidPick(hit: SearchHit): void {
  const i = midResults.value.findIndex((r) => r.kind === hit.kind && r.id === hit.id)
  if (i >= 0) midActive.value = i
  midPopOpen.value = false
  void previewMidHit()
}

/** 中栏候选的高亮项（法条才有 id 可高亮） */
const midSelectedId = computed(() => {
  const h = midResults.value[midActive.value]
  return h && h.kind === 'article' ? h.id : -1
})

/** 条文修正保存完成（Reader 已重取详情）：同步阅读器状态；若该条在激活专题内则刷新专题摘要 */
function onArticleSaved(detail: ArticleDetail): void {
  reader.value = { type: 'article', data: detail }
  if (activeTopic.value?.items.some((it) => it.article_id === detail.article.id)) {
    void refreshActiveTopic()
  }
}

function askDelete(doc: DocumentRow): void {
  pendingDelete.value = doc
}

async function confirmDelete(): Promise<void> {
  const doc = pendingDelete.value
  if (!doc) return
  try {
    await window.lexbench.library.deleteDocument(doc.id)
    // 删除的正是打开中的文档/书籍时才关掉阅读视图；**不改当前标签页**
    // （此前会跳回「进入阅读前」的页面，在文档库里删文件时会被弹到检索页）
    if (
      (reader.value?.type === 'document' || reader.value?.type === 'book') &&
      reader.value.data.id === doc.id
    ) {
      reader.value = null
    }
    await refreshDocs()
    // FK 级联会连带删除该文档的收藏条目（笔记保留并置空关联），同步刷新工作台
    void refreshTopics()
    void refreshActiveTopic()
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
    if (reader.value?.type === 'document' && reader.value.data.id === id) await openDocument(id)
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
      error.value = '不支持的文件类型：目前仅支持 .docx / .pdf / .txt（.doc 老格式请先转换）'
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

onMounted(() => {
  // 命名监听器，卸载时全部注销（修复旧版 #6）
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('drop', onDrop)
  document.addEventListener('click', onDocClickForMode)
  void refreshDocs()
  void refreshGroups()
  void refreshTopics()
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
  clearTimeout(noticeTimer)
  clearTimeout(midTimer)
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
            placeholder="法条定位（如：民法典 1077）或关键词检索（如：离婚 冷静期）"
            @keydown.enter="doSearch"
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
                :selected-id="selectedId"
                :has-docs="documents.length > 0"
                :addable="!!activeTopic"
                :adding-id="addingId"
                @select="onPopPick"
                @add="addHitToTopic"
              />
            </div>
          </Transition>
        </div>
      </div>
      <button class="top-btn" @click="showImport = true">导入文档</button>
      <button class="top-btn" title="配置 AI 模型档案（解读法条 / 找案例 / 追问）" @click="showAiSettings = true">
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

    <main v-else class="main">
      <aside class="side">
        <div class="tabs" role="tablist">
          <div class="tab-slider" :class="tab === 'topics' ? 'pos-0' : 'pos-1'"></div>
          <button class="tab" role="tab" :aria-selected="String(tab === 'topics')" :class="{ active: tab === 'topics' }" @click="tab = 'topics'">
            专题<span class="count">{{ topics.length }}</span>
          </button>
          <button class="tab" role="tab" :aria-selected="String(tab === 'library')" :class="{ active: tab === 'library' }" @click="tab = 'library'">
            文档库<span class="count">{{ documents.length }}</span>
          </button>
        </div>

        <TopicPanel
          v-show="tab === 'topics'"
          :topics="topics"
          :active="activeTopic"
          :selected-id="selectedId"
          @create="createTopic"
          @open="openTopic"
          @back="backToTopics"
          @rename="renameTopic"
          @remove="deleteTopic"
          @remove-item="removeTopicItem"
          @move="moveTopicItem"
          @open-article="openArticle"
          @export-topic="exportTopic"
          @focus-search="focusMidSearch"
        />

        <DocLibrary
          v-show="tab === 'library'"
          :documents="documents"
          :groups="groups"
          @open="openDocument"
          @remove="askDelete"
          @mark-reviewed="markReviewed"
          @groups-changed="onGroupsChanged"
          @error="showError"
        />
      </aside>

      <section class="reader-pane">
        <!-- 专题内常驻检索：只在打开专题时出现（看文档库时仍是左右两栏）。
             随输入出候选，并把高亮的那条即时呈现在下方正文区——不必跳去别处找法条 -->
        <div v-if="tab === 'topics' && activeTopic" class="mid-search">
          <div class="search-group">
            <div class="mode-menu">
              <button class="mode-trigger" title="检索模式" @click="midModeMenuOpen = !midModeMenuOpen">
                <span>{{ modeNames[midMode] }}</span>
                <svg class="mode-caret" :class="{ open: midModeMenuOpen }" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <Transition name="menu-pop">
                <div v-if="midModeMenuOpen" class="mode-pop" role="listbox">
                  <button
                    v-for="(name, m) in modeNames"
                    :key="m"
                    class="mode-opt"
                    :class="{ on: midMode === m }"
                    role="option"
                    :aria-selected="String(midMode === m)"
                    @click="midMode = m as SearchMode; midModeMenuOpen = false"
                  >
                    <span>{{ name }}</span>
                  </button>
                </div>
              </Transition>
            </div>
            <input
              ref="midInputEl"
              v-model="midQuery"
              class="search-input"
              type="text"
              placeholder="在本专题里搜法条：如「民法典 1077」或「离婚 冷静期」"
              @input="onMidInput"
              @keydown.down.prevent="moveMid(1)"
              @keydown.up.prevent="moveMid(-1)"
              @keydown.enter.prevent="closeMidPop()"
              @keydown.esc="closeMidPop"
            />
            <button v-if="midSearching" class="search-btn" disabled>
              <span class="spinner" aria-label="检索中"></span>
            </button>
          </div>

          <Transition name="menu-pop">
            <div v-if="midPopOpen" class="mid-pop">
              <ResultList
                :results="midResults"
                :mode="midModeUsed"
                searched
                :searching="midSearching"
                :query="midQuery"
                :selected-id="midSelectedId"
                :has-docs="true"
                addable
                :adding-id="addingId"
                @select="onMidPick"
                @add="addHitToTopic"
              />
            </div>
          </Transition>
        </div>

        <Reader
          :state="reader"
          :loading="readerLoading"
          :nav-prev="topicNeighbors ? topicNeighbors.prev : undefined"
          :nav-next="topicNeighbors ? topicNeighbors.next : undefined"
          @open-article="openArticle"
          @saved="onArticleSaved"
          @favorite="openFavorite"
          @error="showError"
          @notice="setNotice"
          @open-settings="showAiSettings = true"
        />
      </section>

      <!-- 右栏笔记：只有「在专题里读法条」时才出现。
           看文档库时不出现——那时保持左右两栏，笔记属于专题，不属于文档库 -->
      <NotePanel
        v-if="tab === 'topics' && activeTopic && reader?.type === 'article'"
        :topic="activeTopic"
        :current-article-id="reader.data.article.id"
        :current-article-label="reader.data.article.article_label"
        @changed="onNotesChanged"
        @open-article="openArticle"
        @export="exportTopic"
        @error="showError"
      />
    </main>

    <ImportDialog
      v-model:visible="showImport"
      :initial-files="dropFiles"
      :groups="groups"
      @imported="onImported"
      @error="showError"
    />

    <FavoriteDialog
      v-model:visible="showFav"
      :article-id="favArticle?.id ?? 0"
      :article-label="favArticle?.label ?? ''"
      @done="onFavorited"
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

/* ---------- 专题中栏的常驻检索条 ---------- */
/* 只在打开专题时出现（模板里有 v-if）；看文档库时中栏仍是纯阅读区 */
.mid-search {
  position: sticky;
  top: 0;
  z-index: 8;
  padding: 10px 16px;
  background: var(--lb-bg);
  border-bottom: 1px solid var(--lb-border);
}

.mid-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 9;
  max-height: 48vh;
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

/* ---------- 分段控件（Apple segmented control） ---------- */
.tabs {
  position: relative;
  display: flex;
  margin: 12px 12px 0;
  padding: 3px;
  background: var(--lb-chip);
  border-radius: var(--lb-radius-s);
  flex-shrink: 0;
}

/* 白色滑块在两个选项间平滑滑动 */
.tab-slider {
  position: absolute;
  top: 3px;
  left: 3px;
  width: calc((100% - 6px) / 2);
  height: calc(100% - 6px);
  background: var(--lb-panel);
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.14);
}

@media (prefers-reduced-motion: no-preference) {
  .tab-slider {
    transition: transform 0.22s cubic-bezier(0.25, 0.1, 0.25, 1);
  }
}

.tab-slider.pos-0 {
  transform: translateX(0);
}

.tab-slider.pos-1 {
  transform: translateX(100%);
}


.tab {
  position: relative;
  z-index: 1;
  flex: 1;
  padding: 8px 0;
  background: none;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  color: var(--lb-muted);
}

.tab:hover {
  color: var(--lb-text);
}

.tab.active {
  color: var(--lb-text);
  font-weight: 600;
}

.count {
  display: inline-block;
  min-width: 18px;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--lb-chip);
  font-size: 12px;
  text-align: center;
}

.reader-pane {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
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
