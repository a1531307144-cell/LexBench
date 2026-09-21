<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
const searching = ref(false)
const searched = ref(false)
const lastQuery = ref('') // 最近一次检索实际使用的词（展示用，不随输入框实时变化）
const lastMode = ref<SearchOutcome['mode']>('none')
const results = ref<SearchHit[]>([])
const tab = ref<'results' | 'topics' | 'library'>('results')
const documents = ref<DocumentRow[]>([])
const reader = ref<ReaderState>(null)
const readerLoading = ref(false)
/** 进入书籍阅读模式前的 Tab（返回时恢复） */
const preReaderTab = ref<'results' | 'topics' | 'library'>('results')
const showImport = ref(false)
/** 数据备份/恢复对话框（v0.5.0 数据包） */
const showBackup = ref(false)
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

async function doSearch(): Promise<void> {
  const q = query.value.trim()
  if (!q || searching.value) return
  searching.value = true
  tab.value = 'results'
  try {
    const out = await window.lexbench.search.run(q, modeSel.value)
    lastQuery.value = out.query
    lastMode.value = out.mode
    results.value = out.results
    searched.value = true
    // 法条定位命中 → 直接打开第一条法条进阅读器
    if (out.mode === 'locate' && out.results[0]?.kind === 'article') {
      await openArticle(out.results[0].id)
    }
  } catch (e) {
    showError(e)
  } finally {
    searching.value = false
  }
}

function onModeChange(e: Event): void {
  modeSel.value = (e.target as HTMLSelectElement).value as SearchMode
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
    if (
      (reader.value?.type === 'document' || reader.value?.type === 'book') &&
      reader.value.data.id === doc.id
    ) {
      reader.value = null
      tab.value = preReaderTab.value
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
  void refreshDocs()
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
  clearTimeout(noticeTimer)
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
          <select class="mode-select" :value="modeSel" title="检索模式" @change="onModeChange">
            <option value="auto">自动</option>
            <option value="locate">法条定位</option>
            <option value="fulltext">全文搜索</option>
          </select>
          <input
            v-model="query"
            class="search-input"
            type="text"
            placeholder="法条定位（如：民法典 1077）或关键词检索（如：离婚 冷静期）"
            @keydown.enter="doSearch"
          />
          <button class="search-btn" :disabled="searching" @click="doSearch">
            {{ searching ? '检索中…' : '检 索' }}
          </button>
        </div>
      </div>
      <button class="top-btn" @click="showImport = true">导入文档</button>
      <button class="top-btn" title="导出/导入数据包（换电脑与备份）" @click="showBackup = true">
        数据
      </button>
    </header>

    <div v-if="error" class="error-bar">
      <span class="error-text">{{ error }}</span>
      <button class="error-close" title="关闭" @click="error = ''">✕</button>
    </div>

    <!-- 全局消息条：成功/提示反馈（导出、收藏等），6 秒自动消失，也可手动关闭 -->
    <div v-if="notice" class="error-bar notice" :data-kind="notice.kind">
      <span class="error-text">{{ notice.text }}</span>
      <button class="error-close" title="关闭" @click="notice = null">✕</button>
    </div>

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
        <div class="tabs">
          <button class="tab" :class="{ active: tab === 'results' }" @click="tab = 'results'">
            检索<span v-if="searched" class="count">{{ results.length }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'topics' }" @click="tab = 'topics'">
            专题<span class="count">{{ topics.length }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'library' }" @click="tab = 'library'">
            文档库<span class="count">{{ documents.length }}</span>
          </button>
        </div>

        <ResultList
          v-show="tab === 'results'"
          :results="results"
          :mode="lastMode"
          :searched="searched"
          :searching="searching"
          :query="lastQuery"
          :selected-id="selectedId"
          :has-docs="documents.length > 0"
          @select="openResult"
        />

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
        />

        <DocLibrary
          v-show="tab === 'library'"
          :documents="documents"
          @open="openDocument"
          @remove="askDelete"
          @mark-reviewed="markReviewed"
        />
      </aside>

      <section class="reader-pane">
        <Reader
          :state="reader"
          :loading="readerLoading"
          :nav-prev="topicNeighbors ? topicNeighbors.prev : undefined"
          :nav-next="topicNeighbors ? topicNeighbors.next : undefined"
          @open-article="openArticle"
          @saved="onArticleSaved"
          @favorite="openFavorite"
          @error="showError"
        />
      </section>

      <!-- 右栏笔记：仅打开专题且阅读器为法条模式时出现（与旧版一致的动态三栏） -->
      <NotePanel
        v-if="activeTopic && reader?.type === 'article'"
        :topic="activeTopic"
        :current-article-id="reader.data.article.id"
        :current-article-label="reader.data.article.label"
        @changed="onNotesChanged"
        @open-article="openArticle"
        @export="exportTopic"
        @error="showError"
      />
    </main>

    <ImportDialog
      v-model:visible="showImport"
      :initial-files="dropFiles"
      @imported="refreshDocs"
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
/* 视觉令牌：全应用共用，组件内一律引用这些变量 */
:root {
  --lb-bg: #f7f7fb;
  --lb-panel: #ffffff;
  --lb-text: #24242e;
  --lb-muted: #7c7c92;
  --lb-border: #e6e6ef;
  --lb-border-strong: #dcdce8;
  --lb-accent: #9c3428;
  --lb-accent-2: #c0483a;
  --lb-grad: linear-gradient(135deg, #9c3428, #c0483a);
  --lb-accent-soft: #f7ecea;
  --lb-chip: #f0f0f6;
  --lb-warn-bg: #fdf3e3;
  --lb-warn-fg: #9a6a15;
  --lb-err-bg: #fdecea;
  --lb-err-fg: #8c2b23;
  --lb-ok-bg: #e8f5ec;
  --lb-ok-fg: #22763a;
  --lb-radius-s: 7px;
  --lb-radius-l: 12px;
  --lb-serif: 'Songti SC', 'STSong', 'SimSun', Georgia, 'Times New Roman', serif;
}
</style>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--lb-bg);
}

/* ---------- 顶栏 ---------- */
.topbar {
  display: flex;
  align-items: center;
  gap: 20px;
  height: 58px;
  padding: 0 20px;
  background: var(--lb-panel);
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
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

.search-group {
  display: flex;
  width: 100%;
  max-width: 720px;
}

.mode-select {
  height: 38px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-right: none;
  border-radius: var(--lb-radius-s) 0 0 var(--lb-radius-s);
  background: #fbfbfe;
  color: var(--lb-muted);
  font-size: 13px;
  outline: none;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  height: 38px;
  padding: 0 14px;
  border: 1px solid var(--lb-border-strong);
  border-right: none;
  background: #fbfbfe;
  font-size: 14px;
  color: var(--lb-text);
  outline: none;
  min-width: 0;
}

.search-group:focus-within .mode-select,
.search-group:focus-within .search-input {
  border-color: var(--lb-accent-2);
  background: #fff;
}

.search-btn {
  height: 38px;
  padding: 0 22px;
  border: none;
  border-radius: 0 var(--lb-radius-s) var(--lb-radius-s) 0;
  background: var(--lb-grad);
  color: #fff;
  font-size: 14px;
  flex-shrink: 0;
}

.search-btn:hover {
  filter: brightness(1.06);
}

.search-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.top-btn {
  height: 38px;
  padding: 0 18px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 14px;
  flex-shrink: 0;
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

.tabs {
  display: flex;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.tab {
  flex: 1;
  padding: 11px 0;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  font-size: 14px;
  color: var(--lb-muted);
}

.tab.active {
  color: var(--lb-accent);
  border-bottom-color: var(--lb-accent);
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
