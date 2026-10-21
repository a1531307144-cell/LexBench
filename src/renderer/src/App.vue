<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AboutDialog from './components/AboutDialog.vue'
import AiSettingsDialog from './components/AiSettingsDialog.vue'
import BackupDialog from './components/BackupDialog.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import DocLibrary from './components/DocLibrary.vue'
import GuideOverlay from './components/GuideOverlay.vue'
import ImportDialog from './components/ImportDialog.vue'
import NotesPanel from './components/NotesPanel.vue'
import OutlineEditor from './components/OutlineEditor.vue'
import ReadingView from './components/ReadingView.vue'
import ResultList from './components/ResultList.vue'
import StatuteReadingView from './components/StatuteReadingView.vue'
import UpdateToast from './updaterUI/UpdateToast.vue'
import { GUIDE_KEY, buildGuideSteps } from './guide/guideSteps'
import { newOutlineId } from '@shared/outlineTree'
import { TOPBAR_HINTS, pickDistinct } from '@shared/searchHints'
import type {
  DocGroupRow,
  DocumentDetail,
  DocumentRow,
  NoteGroupRow,
  OutlineListRow,
  OutlineNode,
  OutlineRow,
  SearchHit,
  SearchMode,
  SearchOutcome
} from '@shared/types'

/**
 * 阅读器状态：书籍/案例/资料 = 沉浸阅读（ReadingView 按段落流）；
 * 法规 = 全页阅读（StatuteReadingView，focusOrder = 搜索直达的初始定位）。
 * 中栏单条/文档视图已随「专题」板块一并退场。
 * silentRestore = 续读契约的静默重开（恢复位置但不弹「已回到上次位置」提示）。
 */
type ReaderState =
  | { type: 'book'; data: DocumentDetail; focusPara?: number; silentRestore?: boolean; guide?: boolean }
  | {
      type: 'statute-full'
      data: DocumentDetail
      focusOrder?: number
      silentRestore?: boolean
      guide?: boolean
    }
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
/** 主板块方向：文档库 / 笔记（左导航两项，阶段2） */
const tab = ref<'library' | 'notes'>('library')
/**
 * 续读契约（§3.5，用户点名必须做好）：离开阅读（返回）时记住文档；
 * 从笔记切回文档库方向时**静默**重开该文档并恢复位置（不弹横幅）。
 * 只恢复一次；用户从文档库显式打开新文档即作废。
 */
const resumeDoc = ref<{ id: number; type: 'statute' | 'book' } | null>(null)

// ---------- 左侧竖排导航 + 悬停浮层面板（2026-10-17 用户定稿） ----------
// 热区 = 竖排 + 浮层面板整体：面板内连续翻文档/笔记保持展开，移出后 150ms 才折叠；
// 面板是覆盖式浮层（不推挤正文），动画沿用现成配方（0.18s cubic-bezier(0.25,0.1,0.25,1)）。
const panelOpen = ref(false)
/** 面板显示哪个方向的内容：悬停项优先，决定面板内容而非当前方向 */
const panelTab = ref<'library' | 'notes'>('library')
/** 阅读页右上「全区展开」：true=隐藏竖排（仅阅读时生效，离开阅读复位） */
const railHidden = ref(false)
let panelCloseTimer: ReturnType<typeof setTimeout> | undefined
/**
 * 最后一次指针坐标：mouseleave 在面板内换节点（＋新建分类按钮换输入框）时会整链误报，
 * 收面板绝不能听事件里的“离开”，一律以指针**真实坐标**判据（几何命中）＋焦点判据。
 */
const lastPointer = { x: -1, y: -1 }

// ---------- 使用指引（首启一次性 + 关于页回放） ----------

type GuideMode = 'closed' | 'welcome' | 'tour'
interface GuideSnapshot {
  tab: 'library' | 'notes'
  panelTab: 'library' | 'notes'
  panelOpen: boolean
  railHidden: boolean
  reader: ReaderState
  activeOutline: OutlineRow | null
}

const GUIDE_SAMPLE_TITLE = '使用指引示例'
const guideMode = ref<GuideMode>('closed')
const guideIndex = ref(0)
const guideSeedCount = ref(0)
const guideSampleId = ref<number | null>(null)
const guideClosing = ref(false)
let guideSnapshot: GuideSnapshot | null = null
/** 指引期间抑制竖排面板自动收起、tab 切换副作用等，避免说明卡一出现界面就变 */
const guideActive = computed(() => guideMode.value !== 'closed')

function trackPointer(e: MouseEvent): void {
  lastPointer.x = e.clientX
  lastPointer.y = e.clientY
}

/** 指针/焦点是否真的还落在竖排或面板内（不含瞬时失真的 :hover / elementFromPoint） */
function pointerInHotZone(): boolean {
  // 1) 焦点豁免：面板里任何控件还在输入态（新建/改名分类、搜索框）就是没离开
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.rail, .rail-panel')) return true
  // 2) 指针几何命中：竖排+面板都是固定竖条，直接拿矩形比对坐标
  if (lastPointer.x < 0) return false
  for (const z of document.querySelectorAll<HTMLElement>('.rail, .rail-panel')) {
    const r = z.getBoundingClientRect()
    if (
      lastPointer.x >= r.left && lastPointer.x <= r.right &&
      lastPointer.y >= r.top && lastPointer.y <= r.bottom
    ) {
      return true
    }
  }
  return false
}

/** 收面板统一入口：150ms 后复核指针真的离开了热区才收（否则按钮换输入框的假 leave 会把面板误收、输入框连带销毁） */
function schedulePanelClose(): void {
  if (guideActive.value) return
  clearTimeout(panelCloseTimer)
  panelCloseTimer = setTimeout(() => {
    // 指针已出窗时 mousemove 停止派发、lastPointer 冻结在热区内，几何判据会误判「还在里面」：
    // 用 :hover 为空反证指针不在窗口内，此时无条件收起
    const hovered = document.documentElement.querySelector(':hover') != null
    if (hovered && pointerInHotZone()) return
    panelOpen.value = false
  }, 150)
}

/** 指针直接移出窗口（不经过内容区）时 mouseleave 链只有一次复核，补一条出窗即收的兜底 */
function onDocumentLeave(): void {
  if (guideActive.value) return
  clearTimeout(panelCloseTimer)
  panelOpen.value = false
}

function railEnter(which: 'library' | 'notes'): void {
  clearTimeout(panelCloseTimer)
  panelTab.value = which
  panelOpen.value = true
}

function railLeave(): void {
  schedulePanelClose()
}

function panelEnter(): void {
  clearTimeout(panelCloseTimer)
  panelOpen.value = true
}

function panelLeave(): void {
  schedulePanelClose()
}

/** 点击竖排项：切方向 + 展开面板（阅读中切方向由 watch(tab) 关阅读并记续读） */
function pickNav(which: 'library' | 'notes'): void {
  clearTimeout(panelCloseTimer)
  tab.value = which
  panelTab.value = which
  panelOpen.value = true
}

/** 点内容区空白处收起面板（补悬停机制之外的兜底）；命中目标可能被瞬时重排（按钮换输入框）重定向到正文，
 * 此时以指针真实位置为准：仍在热区就不收。 */
function onBodyClick(): void {
  if (guideActive.value) return
  if (pointerInHotZone()) return
  panelOpen.value = false
}

/** 阅读页「全区展开」开关（右上角按钮转发） */
function toggleRail(): void {
  railHidden.value = !railHidden.value
}
/** 笔记列表（更新时间序）与当前打开的笔记全文 */
const notes = ref<OutlineListRow[]>([])
/** 笔记自定义分类（note_groups；面板内增删改后经 groups-changed 刷新） */
const noteGroups = ref<NoteGroupRow[]>([])
const activeOutline = ref<OutlineRow | null>(null)
/** 笔记快照版本：卸载冲刷后重取快照时 +1，强制编辑器用新数据重挂（防旧快照覆盖） */
const outlineRev = ref(0)
/** 笔记左列面板（星标列表切回该方向时刷新） */
const notesPanelRef = ref<InstanceType<typeof NotesPanel> | null>(null)
/** 关窗前冲刷用：编辑器暴露 flush() */
const outlineEditorRef = ref<InstanceType<typeof OutlineEditor> | null>(null)
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
/** 待删除笔记（「⋯」→删除笔记、列表行 ✕ 共用的确认弹窗；只需要 id + 标题） */
const pendingNoteDelete = ref<{ id: number; title: string } | null>(null)

/** 全局消息条：导出成功等正向反馈（复用错误条容器，6 秒自动消失） */
const notice = ref<{ text: string; kind: 'success' | 'warn' } | null>(null)

let dragDepth = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let errorTimer: ReturnType<typeof setTimeout> | undefined

// 错误条也自动收起（8s）：不再需要用户手动找 ✕，也不会长期挂在界面上
watch(error, (text) => {
  clearTimeout(errorTimer)
  if (text) errorTimer = setTimeout(() => (error.value = ''), 8000)
})

// 删除确认弹窗文案
const deleteMessage = computed(() =>
  pendingDelete.value
    ? `确定删除《${pendingDelete.value.title}》？其条文/段落与全文索引将一并移除，此操作不可撤销。`
    : ''
)

const deleteNoteMessage = computed(() =>
  pendingNoteDelete.value
    ? `确定删除笔记《${pendingNoteDelete.value.title}》？此操作不可撤销。`
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

// ---------- 笔记库（阶段2） ----------

async function refreshNotes(): Promise<void> {
  try {
    notes.value = await window.lexbench.outlines.list()
  } catch (e) {
    showError(e)
  }
}

async function refreshNoteGroups(): Promise<void> {
  try {
    noteGroups.value = await window.lexbench.noteGroups.list()
  } catch (e) {
    showError(e)
  }
}

async function openNote(id: number): Promise<void> {
  try {
    activeOutline.value = await window.lexbench.outlines.get(id)
  } catch (e) {
    activeOutline.value = null
    showError(e)
  }
}

async function createNote(groupId?: number | null): Promise<void> {
  try {
    const row = await window.lexbench.outlines.create('未命名笔记', groupId ?? null)
    await refreshNotes()
    activeOutline.value = row
  } catch (e) {
    showError(e)
  }
}

// ---------- 使用指引：九步编排 ----------

const guideHasSample = computed(() =>
  notes.value.some((n) => n.id === guideSampleId.value || n.title === GUIDE_SAMPLE_TITLE)
)
const guideSteps = computed(() =>
  buildGuideSteps({
    hasSampleNote: guideHasSample.value,
    hasStatute: documents.value.some((d) => d.doc_type === 'statute')
  })
)

/** 示例笔记：给大纲/导图两步一个真实可操作的载体；结束后保留，用户可自行删改 */
function guideSampleTree(): OutlineNode[] {
  return [
    {
      id: newOutlineId(),
      text: '把一次研究拆成几个问题',
      children: [
        { id: newOutlineId(), text: '争议焦点一：合同效力如何认定？', children: [] },
        { id: newOutlineId(), text: '争议焦点二：违约责任如何承担？', children: [] }
      ]
    },
    { id: newOutlineId(), text: '行首输入 / 可插入文档库里的法条引用', children: [] },
    { id: newOutlineId(), text: '右上角切换到「导图」，同一份内容换个看法', children: [] }
  ]
}

/** 应用启动、数据就绪后判断：只有全新安装且从没看过指引才自动弹欢迎卡 */
async function initOnboarding(): Promise<void> {
  let info: { justApplied: boolean; count: number; firstRun: boolean }
  try {
    info = await window.lexbench.library.getSeedInfo()
  } catch {
    return
  }
  const notice = (): void => {
    if (info.justApplied && info.count > 0) {
      setNotice(`已为你预置 ${info.count} 部常用法律与司法解释，直接检索即可使用`, 'success')
    }
  }
  // 更新场景（已有 seed_version）不弹首启指引；后续更新另行告知
  if (!info.firstRun) {
    notice()
    return
  }
  let seen = ''
  try {
    seen = (await window.lexbench.settings.get(GUIDE_KEY)) ?? ''
  } catch {
    seen = ''
  }
  if (seen) {
    notice()
    return
  }
  guideSeedCount.value = info.count
  // 等首屏布局稳定再弹，避免引导卡位置先闪一下
  await new Promise((r) => setTimeout(r, 320))
  guideMode.value = 'welcome'
}

function snapshotGuideState(): void {
  guideSnapshot = {
    tab: tab.value,
    panelTab: panelTab.value,
    panelOpen: panelOpen.value,
    railHidden: railHidden.value,
    reader: reader.value,
    activeOutline: activeOutline.value
  }
}

async function startGuide(): Promise<void> {
  if (guideMode.value !== 'welcome') return
  snapshotGuideState()
  guideIndex.value = 0
  guideMode.value = 'tour'
  try {
    await prepareGuideStep(0)
  } catch (e) {
    showError(e)
  }
}

function startGuideReplay(): void {
  if (guideActive.value) return
  snapshotGuideState()
  guideIndex.value = 0
  guideMode.value = 'tour'
  void prepareGuideStep(0).catch((e) => showError(e))
}

function onAboutGuide(): void {
  showAbout.value = false
  startGuideReplay()
}

async function guideNext(): Promise<void> {
  if (guideClosing.value || guideMode.value !== 'tour') return
  if (guideIndex.value >= guideSteps.value.length - 1) {
    await finishGuide('done')
    return
  }
  guideIndex.value += 1
  try {
    await prepareGuideStep(guideIndex.value)
  } catch (e) {
    showError(e)
  }
}

function guidePrev(): void {
  if (guideClosing.value || guideMode.value !== 'tour' || guideIndex.value === 0) return
  guideIndex.value -= 1
  void prepareGuideStep(guideIndex.value).catch((e) => showError(e))
}

async function guideCta(): Promise<void> {
  if (guideClosing.value || guideMode.value !== 'tour') return
  const step = guideSteps.value[guideIndex.value]
  if (!step) return
  if (step.id === 'notes') {
    try {
      await ensureGuideNote('outline')
    } catch (e) {
      showError(e)
      return
    }
  }
  await guideNext()
}

/** 按步骤把界面摆到位：切方向、开阅读、准备示例笔记；说明卡自己会等目标渲染 */
async function prepareGuideStep(index: number): Promise<void> {
  const step = guideSteps.value[index]
  if (!step) return
  if (step.id === 'library') {
    reader.value = null
    railHidden.value = false
    tab.value = 'library'
    panelTab.value = 'library'
    panelOpen.value = true
  } else if (step.id === 'search') {
    reader.value = null
    railHidden.value = false
    tab.value = 'library'
    panelTab.value = 'library'
    panelOpen.value = false
  } else if (step.id === 'reading') {
    await openGuideReading()
  } else if (step.id === 'notes') {
    reader.value = null
    railHidden.value = false
    tab.value = 'notes'
    panelTab.value = 'notes'
    panelOpen.value = true
    activeOutline.value = null
  } else if (step.id === 'editor') {
    await ensureGuideNote('outline')
  } else if (step.id === 'map') {
    await ensureGuideNote('map')
  }
  await nextTick()
}

/** 阅读演示：打开第一部预置法规，guide 标记让它不写续读进度 */
async function openGuideReading(): Promise<void> {
  const doc = documents.value.find((d) => d.doc_type === 'statute')
  if (!doc) {
    tab.value = 'library'
    return
  }
  try {
    const data = await window.lexbench.library.getDocument(doc.id)
    reader.value = {
      type: 'statute-full',
      data,
      focusOrder: 0,
      silentRestore: true,
      guide: true
    }
    railHidden.value = false
    tab.value = 'library'
    panelOpen.value = false
  } catch (e) {
    showError(e)
  }
}

/** 找（或创建）示例笔记，并按当前步骤切大纲/导图 */
async function ensureGuideNote(view: 'outline' | 'map'): Promise<void> {
  let note = notes.value.find((n) => n.id === guideSampleId.value) ?? null
  if (!note) note = notes.value.find((n) => n.title === GUIDE_SAMPLE_TITLE) ?? null
  if (!note) {
    const row = await window.lexbench.outlines.create(GUIDE_SAMPLE_TITLE, null)
    await window.lexbench.outlines.save(row.id, JSON.stringify(guideSampleTree()))
    guideSampleId.value = row.id
    await refreshNotes()
    note = notes.value.find((n) => n.id === row.id) ?? null
  } else {
    guideSampleId.value = note.id
  }
  if (!note) return
  try {
    await window.lexbench.outlines.setViewMode(note.id, view)
  } catch {
    // 视图模式写失败不影响演示，按当前模式打开即可
  }
  const fresh = await window.lexbench.outlines.get(note.id)
  reader.value = null
  railHidden.value = false
  tab.value = 'notes'
  panelTab.value = 'notes'
  panelOpen.value = false
  activeOutline.value = fresh
  outlineRev.value += 1
}

/** 结束（完成/跳过）：先记状态，再恢复进入指引前的现场 */
async function finishGuide(mark: 'done' | 'skipped'): Promise<void> {
  if (guideClosing.value) return
  guideClosing.value = true
  try {
    try {
      await window.lexbench.settings.set(GUIDE_KEY, mark)
    } catch {
      // 记忆失败不阻断关闭
    }
    await restoreGuideState()
  } finally {
    guideMode.value = 'closed'
    guideIndex.value = 0
    guideClosing.value = false
  }
}

async function restoreGuideState(): Promise<void> {
  const snap = guideSnapshot
  guideSnapshot = null
  if (!snap) return
  reader.value = snap.reader
  tab.value = snap.tab
  panelTab.value = snap.panelTab
  panelOpen.value = snap.panelOpen
  railHidden.value = snap.railHidden
  if (snap.activeOutline) {
    try {
      // 重新取快照：卸载冲刷后旧对象可能落后（见笔记编辑器的落盘契约）
      activeOutline.value = await window.lexbench.outlines.get(snap.activeOutline.id)
      outlineRev.value += 1
    } catch {
      activeOutline.value = null
    }
  } else {
    activeOutline.value = null
  }
}

/** 星标法条入口：直达全页阅读并跳到该条 */
async function openStarredArticle(payload: { documentId: number; orderIndex: number }): Promise<void> {
  await openStatuteFull(payload.documentId, { focusOrder: payload.orderIndex })
}

/** 引用节点右键「在文档库打开来源」（逃生门）：全页阅读跳到该条 */
async function openSourceFromNote(ref: { docId: number; articleId: number }): Promise<void> {
  try {
    const detail = await window.lexbench.library.getArticle(ref.articleId)
    await openStatuteFull(ref.docId, { focusOrder: detail.article.order_index })
  } catch (e) {
    // 来源已被删：提示而非白屏
    showError(e)
  }
}

/** 「⋯」→删除笔记：确认后删库、清选中、刷列表 */
async function confirmDeleteNote(): Promise<void> {
  const target = pendingNoteDelete.value
  pendingNoteDelete.value = null
  if (!target) return
  try {
    await window.lexbench.outlines.remove(target.id)
    if (activeOutline.value?.id === target.id) activeOutline.value = null
    await refreshNotes()
    setNotice('笔记已删除')
  } catch (e) {
    showError(e)
  }
}

/** 笔记列表行 ✕：同一套确认流程 */
function askDeleteNote(note: { id: number; title: string }): void {
  pendingNoteDelete.value = note
}

/** 编辑器标题改名后列表要重排（updated_at 序）；树的静默保存不触发 */
async function onNoteListChanged(): Promise<void> {
  await refreshNotes()
}

/** 笔记面板改过名/导入后：刷列表，并把当前打开笔记的标题同步给编辑器
 *  （否则编辑器手里的旧标题会在卸载冲刷时把刚改的名字写回去） */
async function onNotesPanelChanged(): Promise<void> {
  await refreshNotes()
  const cur = activeOutline.value
  if (!cur) return
  const row = notes.value.find((n) => n.id === cur.id)
  if (row && row.title !== cur.title) cur.title = row.title
}

// 切到笔记方向时：刷新星标入口 + 重取当前笔记快照。
// 快照必须重取——切走时编辑器卸载已 flush 落库，App 手里的 outline 是卸载前的旧数据，
// 直接重挂会用旧树覆盖刚存的内容。save/get 走同一 renderer→main IPC 队列，main 侧
// node:sqlite 同步按序处理，get 一定读到 flush 之后的状态（不依赖卸载 emit，那条链不可靠）。
// 切回文档库方向时：续读契约——离开时在读（resumeDoc 有值）则静默重开该文档恢复位置。
watch(tab, async (t) => {
  // 指引自己编排视图：不要让切 tab 触发续读/重取快照，结束后统一恢复现场
  if (guideActive.value) return
  // 阅读中经竖排切方向：关阅读（卸载冲刷进度 + 记 resumeDoc，回库方向时静默重开）
  if (reader.value) closeReading()
  if (t === 'library') {
    const resume = resumeDoc.value
    // readerLoading 在途 = 正在打开另一文档（如从笔记面板直接点开）——不抢，留给它
    if (resume && !reader.value && !readerLoading.value) {
      resumeDoc.value = null // 一次性消费：再从笔记回来若没再读过 → 回首页
      if (resume.type === 'statute') await openStatuteFull(resume.id, { silentRestore: true })
      else await openReading(resume.id, { silentRestore: true })
    }
    return
  }
  void notesPanelRef.value?.refreshStarred()
  const cur = activeOutline.value
  if (!cur) return
  try {
    activeOutline.value = await window.lexbench.outlines.get(cur.id)
    outlineRev.value += 1 // 强制编辑器用新快照重挂
  } catch {
    activeOutline.value = null // 笔记已被删（如数据包导入后）
  }
})

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
 * 打开阅读一律切到文档库方向（顶栏搜索直达/星标入口都从笔记方向也能正确落位）。
 */
async function openReading(
  id: number,
  opts?: { hitId?: number; focusPara?: number; silentRestore?: boolean }
): Promise<void> {
  tab.value = 'library'
  readerLoading.value = true
  try {
    const detail = await window.lexbench.library.getDocument(id)
    let focus = opts?.focusPara
    if (focus === undefined && opts?.hitId !== undefined) {
      focus = detail.chunks.find((c) => c.id === opts.hitId)?.seq
    }
    reader.value = {
      type: 'book',
      data: detail,
      focusPara: focus,
      silentRestore: opts?.silentRestore
    }
  } catch (e) {
    // 续读期间文档被删：落回首页 + 提示，不白屏
    if (opts?.silentRestore) setNotice('上次阅读的文档已不存在，已回到文档库', 'warn')
    showError(e)
  } finally {
    readerLoading.value = false
    panelOpen.value = false // 阅读打开即收面板，不挡正文
  }
}

/** 法规全页阅读（文档库/搜索直达统一落点）：focusOrder = 打开时定位到该条 */
async function openStatuteFull(
  id: number,
  opts?: { focusOrder?: number; silentRestore?: boolean }
): Promise<void> {
  tab.value = 'library'
  readerLoading.value = true
  try {
    reader.value = {
      type: 'statute-full',
      data: await window.lexbench.library.getDocument(id),
      focusOrder: opts?.focusOrder,
      silentRestore: opts?.silentRestore
    }
  } catch (e) {
    if (opts?.silentRestore) setNotice('上次阅读的文档已不存在，已回到文档库', 'warn')
    showError(e)
  } finally {
    readerLoading.value = false
    panelOpen.value = false
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

/** 退出阅读模式：回到文档库（记住最近阅读，供续读契约静默恢复；全区态复位） */
function closeReading(): void {
  if (reader.value?.type === 'statute-full') {
    resumeDoc.value = { id: reader.value.data.id, type: 'statute' }
  } else if (reader.value?.type === 'book') {
    resumeDoc.value = { id: reader.value.data.id, type: 'book' }
  }
  reader.value = null
  railHidden.value = false
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
let unsubBeforeClose: (() => void) | null = null

onMounted(() => {
  // 命名监听器，卸载时全部注销（修复旧版 #6）
  window.addEventListener('mousemove', trackPointer, { passive: true })
  window.addEventListener('pointerdown', trackPointer, { passive: true, capture: true })
  document.addEventListener('mouseleave', onDocumentLeave)
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
  // 关窗前把编辑器防抖窗口里的内容落盘（主进程拦 close，等这条回执）
  unsubBeforeClose = window.lexbench.app.onBeforeClose(() => {
    void (async () => {
      try {
        await outlineEditorRef.value?.flush()
      } catch {
        // 落盘失败不阻断关窗（错误已在编辑器内提示）
      }
      window.lexbench.app.flushDone()
    })()
  })
  // 首屏数据与首启指引都等列表就绪后再决定（预置法条的一次性提示也在 initOnboarding 里）
  const boot = Promise.allSettled([refreshDocs(), refreshGroups(), refreshNotes(), refreshNoteGroups()])
  void boot.then(() => void initOnboarding())
  void window.lexbench.app
    .getVersion()
    .then((v) => {
      version.value = v
    })
    .catch(() => {})
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', trackPointer)
  window.removeEventListener('pointerdown', trackPointer, { capture: true })
  document.removeEventListener('mouseleave', onDocumentLeave)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('drop', onDrop)
  document.removeEventListener('click', onDocClickForMode)
  unsubAiVis?.()
  unsubAiArticle?.()
  unsubBeforeClose?.()
  clearTimeout(noticeTimer)
  clearTimeout(errorTimer)
  clearTimeout(topTimer)
  clearTimeout(panelCloseTimer)
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
        <div class="search-group" data-guide="top-search">
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
      <button class="top-btn" data-guide="top-import" @click="showImport = true">导入文档</button>
      <button
        class="top-btn"
        data-guide="top-ai"
        :class="{ on: aiWinOpen }"
        title="通用法律问答助手（独立窗口）：随便问，不用出软件去别处查"
        @click="toggleAiWindow"
      >
        ✦ AI 助手
      </button>
      <button class="top-btn" title="配置 AI 模型档案（接口地址 / 模型 / 密钥）" @click="showAiSettings = true">
        AI 设置
      </button>
      <button
        class="top-btn"
        data-guide="top-data"
        title="导出/导入数据包（换电脑与备份）"
        @click="showBackup = true"
      >
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

    <!-- 主体：常驻竖排导航 + 悬停浮层面板（覆盖式，热区=导航+面板） + 内容区 -->
    <div class="body" :class="{ 'rail-off': railHidden }" @click="onBodyClick">
      <nav class="rail" aria-label="主导航" @mouseleave="railLeave">
        <button
          class="rail-item"
          data-guide="rail-library"
          :class="{ active: tab === 'library' }"
          title="文档库"
          @mouseenter="railEnter('library')"
          @click="pickNav('library')"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="2.5" y="2.5" width="13" height="4.4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3" />
            <rect x="2.5" y="9" width="13" height="4.4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.55" />
            <path d="M5 16h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.35" />
          </svg>
          <span class="rail-label">文档库</span>
          <span class="rail-count">{{ documents.length }}</span>
        </button>
        <button
          class="rail-item"
          data-guide="rail-notes"
          :class="{ active: tab === 'notes' }"
          title="笔记"
          @mouseenter="railEnter('notes')"
          @click="pickNav('notes')"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M4 2.8h10v12.4H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            <path d="M6.6 6.4h4.8M6.6 9.2h4.8M6.6 12h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          <span class="rail-label">笔记</span>
          <span class="rail-count">{{ notes.length }}</span>
        </button>
      </nav>

      <!-- 悬停浮层面板：覆盖式滑入（配方时长 0.18s/缓动同 menu-pop），DOM 常驻控显隐 -->
      <aside
        class="rail-panel"
        data-guide="notes-panel"
        :class="{ open: panelOpen, wide: panelTab === 'notes' }"
        @mouseenter="panelEnter"
        @mouseleave="panelLeave"
      >
        <DocLibrary
          v-show="panelTab === 'library'"
          :documents="documents"
          :groups="groups"
          @open="openFromLibrary"
          @remove="askDelete"
          @mark-reviewed="markReviewed"
          @groups-changed="onGroupsChanged"
          @docs-changed="refreshDocs"
          @error="showError"
        />
        <NotesPanel
          v-show="panelTab === 'notes'"
          ref="notesPanelRef"
          :notes="notes"
          :note-groups="noteGroups"
          :active-id="activeOutline?.id ?? null"
          @open="openNote"
          @create="(gid) => createNote(gid)"
          @remove="askDeleteNote"
          @open-starred="openStarredArticle"
          @error="showError"
          @groups-changed="refreshNoteGroups"
          @imported="onNotesPanelChanged"
        />
      </aside>

      <!-- 书籍沉浸阅读（竖排常驻，右上可切全区） -->
      <main v-if="reader?.type === 'book'" class="reading-full">
        <ReadingView
          :key="reader.data.id"
          :doc="reader.data"
          :focus-para="reader.focusPara"
          :silent-restore="reader.silentRestore"
          :guide="!!reader.guide"
          @back="closeReading"
          @error="showError"
          @notice="onReadingNotice"
          @toggle-rail="toggleRail"
        />
      </main>

      <!-- 法规全页阅读：文档库卡片 / 搜索直达统一落点，目录+连续正文+批注 -->
      <main v-else-if="reader?.type === 'statute-full'" class="reading-full">
        <StatuteReadingView
          :key="reader.data.id"
          :doc="reader.data"
          :focus-order="reader.focusOrder"
          :silent-restore="reader.silentRestore"
          :guide="!!reader.guide"
          @back="closeReading"
          @error="showError"
          @notice="setNotice"
          @doc-changed="reloadStatuteDoc"
          @toggle-rail="toggleRail"
        />
      </main>

      <!-- 内容区：笔记编辑 / 库方向空态（浏览界面收进悬停面板，空间留给正文） -->
      <main v-else class="main">
        <section v-if="tab === 'notes' && activeOutline" class="notes-main">
          <OutlineEditor
            :key="`${activeOutline.id}:${outlineRev}`"
            ref="outlineEditorRef"
            :outline="activeOutline"
            @error="showError"
            @list-changed="onNoteListChanged"
            @open-source="openSourceFromNote"
            @delete-request="pendingNoteDelete = activeOutline"
            @notice="setNotice"
          />
        </section>
        <section v-else-if="tab === 'notes'" class="notes-main notes-empty">
          <p class="notes-empty-title">选择或新建一篇笔记</p>
          <p class="notes-empty-line">大纲式笔记：Enter 新行，Tab 缩进，可插入文档库法条引用</p>
        </section>
        <section v-else class="lib-home">
          <p class="lib-home-title">从左侧「文档库」选择文档开始阅读</p>
          <p class="lib-home-line">悬停竖排项展开列表；右上角「导入文档」可添加新资料</p>
        </section>
      </main>
    </div>

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

    <AboutDialog v-model:visible="showAbout" @error="showError" @guide="onAboutGuide" />

    <GuideOverlay
      :mode="guideMode"
      :steps="guideSteps"
      :index="guideIndex"
      :seeded-count="guideSeedCount"
      @start="startGuide"
      @skip="finishGuide('skipped')"
      @next="guideNext"
      @prev="guidePrev"
      @cta="guideCta"
      @finish="finishGuide('done')"
    />

    <ConfirmModal
      :visible="pendingDelete !== null"
      title="删除文档"
      :message="deleteMessage"
      danger
      confirm-text="删除"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <ConfirmModal
      :visible="pendingNoteDelete !== null"
      title="删除笔记"
      :message="deleteNoteMessage"
      danger
      confirm-text="删除"
      @confirm="confirmDeleteNote"
      @cancel="pendingNoteDelete = null"
    />

    <div v-if="dragging" class="drag-overlay">
      <div class="drag-hint">松开鼠标，导入法律文档</div>
    </div>

    <UpdateToast />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--lb-bg);
}

/* ---------- 顶栏（浅色导航：与无边框窗口融合） ---------- */
.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  position: relative;
  height: 54px;
  padding: 0 8px 0 20px;
  background: var(--lb-chrome);
  flex-shrink: 0;
  -webkit-app-region: drag; /* 顶栏空白处可拖动窗口 */
}

/* 顶栏底边：两端渐隐，避免通到底的矩形切割线 */
.topbar::after {
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
    rgba(0, 0, 0, 0.08) 32px,
    rgba(0, 0, 0, 0.08) calc(100% - 32px),
    transparent 100%
  );
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
  border-radius: var(--lb-radius-full);
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
  corner-shape: var(--lb-corner-shape);
  background: var(--lb-panel);
  box-shadow: var(--lb-shadow-2);
}

.search-group {
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 720px;
  background: var(--lb-panel);
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: var(--lb-radius-full);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  transition: border-color 0.25s, box-shadow 0.25s;
}

/* ---------- 检索模式下拉（浅色弹出菜单） ---------- */
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
  border-radius: var(--lb-radius-full);
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
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-2);
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
  border-radius: var(--lb-radius-full);
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
  border-radius: var(--lb-radius-full);
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
  border-radius: var(--lb-radius-xs);
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

/* ---------- 消息条滑入滑出（顶部推入而非突然出现） ---------- */
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

/* ---------- 主体骨架：竖排导航 + 悬停浮层面板 + 内容区 ---------- */
.body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  background: var(--lb-chrome);
}

/* 内容画布：四周留 4px 近白呼吸缝（不回到 8px 灰缝的浮卡观感），
   26px 连续曲率（左上角即顶栏/竖排交汇处的内凹圆角，保持 26px 不变），
   与两条 32px 渐隐分割线一起承接窗口动线。 */
.body > main {
  margin: 4px;
  border-radius: var(--lb-radius-xl);
  corner-shape: var(--lb-corner-shape);
  overflow: hidden;
  background: var(--lb-panel);
}

.main {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 书籍沉浸阅读（竖排常驻；rail-off 时隐藏 rail 占满正文） */
.reading-full {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* ---------- 常驻竖排导航 ---------- */
.rail {
  position: relative;
  width: 60px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 10px;
  background: var(--lb-chrome);
  z-index: 30; /* 压住浮层面板左沿（面板展开时不留缝） */
}

/* 竖排右边：上下两端渐隐，不做通到底的矩形切割线 */
.rail::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 1px;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    transparent 0,
    rgba(0, 0, 0, 0.08) 32px,
    rgba(0, 0, 0, 0.08) calc(100% - 32px),
    transparent 100%
  );
}

.rail-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  margin: 0 6px;
  padding: 10px 2px 8px;
  border: none;
  border-radius: var(--lb-radius-s);
  background: none;
  color: var(--lb-muted);
}

.rail-item:hover {
  background: #f0f0f6;
  color: var(--lb-text);
}

.rail-item.active {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
}

.rail-label {
  font-size: 12px;
}

.rail-item.active .rail-label {
  font-weight: 600;
}

.rail-count {
  font-size: 10px;
  font-weight: 400;
  color: var(--lb-muted);
}

.rail-item.active .rail-count {
  color: var(--lb-accent);
}

/* ---------- 悬停浮层面板（覆盖式，不推挤正文） ----------
   面板压在正文上（z 20 < rail 30），DOM 常驻、CSS 控显隐；
   进 0.18s / 出 0.16s，时长与缓动照 menu-pop 配方 */
.rail-panel {
  position: absolute;
  /* 悬浮式面板：与竖排、顶栏、窗口底部各留 8px，四角 26px 连续曲率 */
  top: 8px;
  bottom: 8px;
  left: 68px;
  width: 340px;  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-xl);
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-2);
  opacity: 0;
  visibility: hidden;
  transform: translateX(-8px);
  pointer-events: none;
  /* 压过阅读页标题栏（sv-top 20）与阅读态弹层（批注 300 / 书批注 330 / 法内搜索 420）——
     用户反馈文档标题曾遮挡面板；仅让位于全局对话框与拖拽遮罩（500/600） */
  z-index: 450;
}

.rail-panel.open {
  opacity: 1;
  visibility: visible;
  transform: translateX(0);
  pointer-events: auto;
}

/* 笔记面板：Finder 式图标网格需要更宽的横向空间（文档库面板维持 340px 不变） */
.rail-panel.wide {
  width: 400px;
}

@media (prefers-reduced-motion: no-preference) {
  .rail-panel {
    transition:
      opacity 0.16s cubic-bezier(0.25, 0.1, 0.25, 1),
      transform 0.16s cubic-bezier(0.25, 0.1, 0.25, 1),
      visibility 0s linear 0.16s; /* 隐藏等过渡收完再切，淡出不被截断 */
  }

  .rail-panel.open {
    transition:
      opacity 0.18s cubic-bezier(0.25, 0.1, 0.25, 1),
      transform 0.18s cubic-bezier(0.25, 0.1, 0.25, 1),
      visibility 0s;
  }
}

/* 全区阅读：隐藏竖排 */
.body.rail-off .rail {
  display: none;
}

/* ---------- 库方向空态（浏览界面已收进悬停面板） ---------- */
.lib-home {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.lib-home-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--lb-text);
}

.lib-home-line {
  margin-top: 8px;
  font-size: 13px;
  color: var(--lb-muted);
}

/* ---------- 笔记编辑区 ---------- */
.notes-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--lb-panel);
}

.notes-empty {
  align-items: center;
  justify-content: center;
  text-align: center;
}

.notes-empty-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--lb-text);
}

.notes-empty-line {
  margin-top: 8px;
  font-size: 13px;
  color: var(--lb-muted);
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
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  color: #fff;
  font-size: 18px;
  font-family: var(--lb-serif);
}
</style>
