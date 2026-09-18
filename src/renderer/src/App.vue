<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmModal from './components/ConfirmModal.vue'
import DocLibrary from './components/DocLibrary.vue'
import ImportDialog from './components/ImportDialog.vue'
import Reader from './components/Reader.vue'
import ResultList from './components/ResultList.vue'
import UpdateToast from './updaterUI/UpdateToast.vue'
import type {
  ArticleDetail,
  DocumentDetail,
  DocumentRow,
  SearchHit,
  SearchMode,
  SearchOutcome
} from '@shared/types'

/** 阅读器状态：法条模式 / 文档模式（与 Reader.vue 内声明保持同一形状） */
type ReaderState =
  | { type: 'article'; data: ArticleDetail }
  | { type: 'document'; data: DocumentDetail }
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
const showImport = ref(false)
const dropFiles = ref<ImportFileEntry[]>([])
const dragging = ref(false)
const error = ref('')
const version = ref('')
const pendingDelete = ref<DocumentRow | null>(null)

let dragDepth = 0

// 当前打开的法条 id（结果列表高亮用）
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
  readerLoading.value = true
  try {
    reader.value = { type: 'document', data: await window.lexbench.library.getDocument(id) }
  } catch (e) {
    showError(e)
  } finally {
    readerLoading.value = false
  }
}

function openResult(hit: SearchHit): void {
  if (hit.kind === 'article') void openArticle(hit.id)
  else void openDocument(hit.document_id)
}

/** 条文修正保存完成（Reader 已重取详情）：同步阅读器状态 */
function onArticleSaved(detail: ArticleDetail): void {
  reader.value = { type: 'article', data: detail }
}

function askDelete(doc: DocumentRow): void {
  pendingDelete.value = doc
}

async function confirmDelete(): Promise<void> {
  const doc = pendingDelete.value
  if (!doc) return
  try {
    await window.lexbench.library.deleteDocument(doc.id)
    if (reader.value?.type === 'document' && reader.value.data.id === doc.id) reader.value = null
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
  void window.lexbench.app
    .getVersion()
    .then((v) => {
      version.value = v
    })
    .catch(() => {})
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('drop', onDrop)
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
    </header>

    <div v-if="error" class="error-bar">
      <span class="error-text">{{ error }}</span>
      <button class="error-close" title="关闭" @click="error = ''">✕</button>
    </div>

    <main class="main">
      <aside class="side">
        <div class="tabs">
          <button class="tab" :class="{ active: tab === 'results' }" @click="tab = 'results'">
            检索<span v-if="searched" class="count">{{ results.length }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'topics' }" @click="tab = 'topics'">
            专题
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

        <div v-show="tab === 'topics'" class="tab-page">
          <div class="placeholder-card">
            <div class="ph-seal">研</div>
            <p class="ph-title">研究工作台将在 v0.4.0 到来</p>
            <p class="ph-sub">专题收藏、关联笔记与一键导出正在路上</p>
          </div>
        </div>

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
          @open-article="openArticle"
          @saved="onArticleSaved"
          @error="showError"
        />
      </section>
    </main>

    <ImportDialog
      v-model:visible="showImport"
      :initial-files="dropFiles"
      @imported="refreshDocs"
      @error="showError"
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

/* ---------- 主区布局 ---------- */
.main {
  display: flex;
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

.tab-page {
  flex: 1;
  overflow-y: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.placeholder-card {
  max-width: 260px;
  padding: 32px 28px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  text-align: center;
}

.ph-seal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: var(--lb-grad);
  color: #fff;
  font-family: var(--lb-serif);
  font-size: 22px;
  margin-bottom: 14px;
  opacity: 0.85;
}

.ph-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
  margin-bottom: 6px;
}

.ph-sub {
  font-size: 12px;
  color: var(--lb-muted);
  line-height: 1.7;
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
