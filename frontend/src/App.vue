<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import {
  api,
  type ArticleDetail,
  type DocumentDetail,
  type DocumentRow,
  type SearchResult,
  type TopicDetail,
  type TopicRow,
} from './api'
import DocLibrary from './components/DocLibrary.vue'
import FavoriteDialog from './components/FavoriteDialog.vue'
import ImportDialog from './components/ImportDialog.vue'
import NotePanel from './components/NotePanel.vue'
import Reader from './components/Reader.vue'
import ResultList from './components/ResultList.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import TopicPanel from './components/TopicPanel.vue'

type ReaderState =
  | { type: 'article'; data: ArticleDetail }
  | { type: 'document'; data: DocumentDetail }
  | null

const query = ref('')
const searching = ref(false)
const searched = ref(false)
const searchMode = ref('')
const results = ref<SearchResult[]>([])
const tab = ref<'results' | 'topics' | 'library'>('results')
const documents = ref<DocumentRow[]>([])
const reader = ref<ReaderState>(null)
const readerLoading = ref(false)
const showImport = ref(false)
const showSettings = ref(false)
const dropFiles = ref<File[]>([])
const dragging = ref(false)
const error = ref('')

const topics = ref<TopicRow[]>([])
const activeTopic = ref<TopicDetail | null>(null)
const showFav = ref(false)
const favArticleId = ref(0)
const favArticleLabel = ref('')

let dragDepth = 0

const currentArticle = computed(() =>
  reader.value?.type === 'article' ? reader.value.data : null,
)

const topicNav = computed(() => {
  const t = activeTopic.value
  const a = currentArticle.value
  if (!t || !a) return null
  const idx = t.items.findIndex((i) => i.article_id === a.id)
  if (idx === -1) return null
  const toBrief = (i?: TopicDetail['items'][number]) =>
    i ? { id: i.article_id, label: i.label } : null
  return {
    prev: toBrief(t.items[idx - 1]),
    next: toBrief(t.items[idx + 1]),
  }
})

async function refreshDocs() {
  try {
    documents.value = await api.documents()
  } catch (e) {
    error.value = String(e)
  }
}

async function refreshTopics() {
  try {
    topics.value = await api.topics()
  } catch (e) {
    error.value = String(e)
  }
}

async function refreshActiveTopic() {
  if (!activeTopic.value) return
  try {
    activeTopic.value = await api.topicDetail(activeTopic.value.id)
  } catch {
    activeTopic.value = null
  }
  await refreshTopics()
}

async function doSearch() {
  const q = query.value.trim()
  if (!q || searching.value) return
  searching.value = true
  error.value = ''
  tab.value = 'results'
  try {
    const resp = await api.search(q)
    results.value = resp.results
    searchMode.value = resp.mode
    searched.value = true
    if (resp.mode === 'locate' && resp.results.length > 0 && resp.results[0].kind === 'article') {
      await openArticle(resp.results[0].id)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    searching.value = false
  }
}

async function openArticle(id: number) {
  readerLoading.value = true
  try {
    reader.value = { type: 'article', data: await api.article(id) }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    readerLoading.value = false
  }
}

async function openDocument(id: number) {
  readerLoading.value = true
  try {
    reader.value = { type: 'document', data: await api.documentDetail(id) }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    readerLoading.value = false
  }
}

function openResult(r: SearchResult) {
  if (r.kind === 'article') openArticle(r.id)
  else openDocument(r.document_id)
}

async function deleteDocument(id: number) {
  if (!confirm('确定删除该文档？其法条与索引将一并移除。')) return
  await api.deleteDocument(id)
  await refreshDocs()
  if (reader.value?.type === 'document' && reader.value.data.id === id) {
    reader.value = null
  }
}

async function openTopic(id: number) {
  try {
    activeTopic.value = await api.topicDetail(id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function backToTopics() {
  activeTopic.value = null
}

async function createTopic(name: string, description: string) {
  try {
    const t = await api.createTopic(name, description)
    await refreshTopics()
    await openTopic(t.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function renameTopic(id: number, name: string) {
  try {
    await api.updateTopic(id, { name })
    await refreshActiveTopic()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function deleteTopic(id: number) {
  try {
    await api.deleteTopic(id)
    if (activeTopic.value?.id === id) activeTopic.value = null
    await refreshTopics()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function removeItem(articleId: number) {
  if (!activeTopic.value) return
  await api.removeFavorite(activeTopic.value.id, articleId)
  await refreshActiveTopic()
}

function exportTopic(format: 'md' | 'docx') {
  if (!activeTopic.value) return
  window.open(api.exportTopicUrl(activeTopic.value.id, format), '_blank')
}

function openFavorite(articleId: number) {
  const a = currentArticle.value
  favArticleId.value = articleId
  favArticleLabel.value = a && a.id === articleId ? a.label : ''
  showFav.value = true
}

async function onFavDone() {
  await refreshActiveTopic()
}

async function saveContent(articleId: number, content: string) {
  try {
    await api.updateArticle(articleId, content)
    await openArticle(articleId)
    await refreshActiveTopic()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function onDragEnter(e: DragEvent) {
  if (e.dataTransfer?.types.includes('Files')) {
    dragDepth++
    dragging.value = true
  }
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(e: DragEvent) {
  dragDepth = 0
  dragging.value = false
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
    /\.(docx|pdf|txt|doc)$/i.test(f.name),
  )
  if (files.length) {
    dropFiles.value = files
    showImport.value = true
  }
}

onMounted(() => {
  refreshDocs()
  refreshTopics()
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    onDrop(e)
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragleave', onDragLeave)
})

const selectedId = () => (reader.value?.type === 'article' ? reader.value.data.id : 0)
</script>

<template>
  <div class="shell">
    <header class="header">
      <div class="brand">
        <span class="seal">法</span>
        <span class="brand-name">LexBench <em>法研台</em></span>
      </div>
      <div class="search-wrap">
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
      <button class="import-btn" @click="showSettings = true">AI 设置</button>
      <button class="import-btn" @click="showImport = true">导入文档</button>
    </header>

    <div v-if="error" class="error-bar">{{ error }}</div>

    <main class="main">
      <aside class="side">
        <div class="tabs">
          <button
            class="tab"
            :class="{ active: tab === 'results' }"
            @click="tab = 'results'"
          >
            检索
            <span v-if="searched" class="count">{{ results.length }}</span>
          </button>
          <button
            class="tab"
            :class="{ active: tab === 'topics' }"
            @click="tab = 'topics'"
          >
            专题
            <span class="count">{{ topics.length }}</span>
          </button>
          <button
            class="tab"
            :class="{ active: tab === 'library' }"
            @click="tab = 'library'"
          >
            文档库
            <span class="count">{{ documents.length }}</span>
          </button>
        </div>

        <ResultList
          v-show="tab === 'results'"
          :results="results"
          :mode="searchMode"
          :searched="searched"
          :searching="searching"
          :query="query"
          :selected-id="selectedId()"
          :has-docs="documents.length > 0"
          @select="openResult"
        />

        <TopicPanel
          v-show="tab === 'topics'"
          :topics="topics"
          :topic="activeTopic"
          :current-article-id="selectedId()"
          @create="createTopic"
          @open="openTopic"
          @back="backToTopics"
          @open-article="openArticle"
          @remove-item="removeItem"
          @delete-topic="deleteTopic"
          @rename-topic="renameTopic"
          @export="exportTopic"
        />

        <DocLibrary
          v-show="tab === 'library'"
          :documents="documents"
          @open="openDocument"
          @delete="deleteDocument"
        />
      </aside>

      <section class="reader-pane">
        <Reader
          :state="reader"
          :loading="readerLoading"
          :topic-nav="topicNav"
          @open-article="openArticle"
          @favorite="openFavorite"
          @save-content="saveContent"
          @open-settings="showSettings = true"
        />
      </section>

      <NotePanel
        v-if="activeTopic"
        :topic="activeTopic"
        :current-article-id="selectedId()"
        :current-article-label="currentArticle?.label ?? ''"
        @changed="refreshActiveTopic"
        @open-article="openArticle"
        @export="exportTopic"
      />
    </main>

    <ImportDialog v-model="showImport" :initial-files="dropFiles" @uploaded="refreshDocs" />

    <SettingsDialog v-model="showSettings" />

    <FavoriteDialog
      v-model="showFav"
      :article-id="favArticleId"
      :article-label="favArticleLabel"
      @done="onFavDone"
    />

    <div v-if="dragging" class="drag-overlay">
      <div class="drag-hint">松开鼠标，导入法律文档</div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 20px;
  height: 58px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.seal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 600;
}

.brand-name {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.brand-name em {
  font-family: var(--serif);
  color: var(--accent);
  margin-left: 4px;
}

.search-wrap {
  display: flex;
  flex: 1;
  max-width: 680px;
  margin: 0 auto;
}

.search-input {
  flex: 1;
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--border-strong);
  border-right: none;
  border-radius: var(--radius) 0 0 var(--radius);
  font-size: 14px;
  outline: none;
  background: #fbfaf7;
}

.search-input:focus {
  border-color: var(--accent);
  background: #fff;
}

.search-btn {
  height: 38px;
  padding: 0 22px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 0 var(--radius) var(--radius) 0;
  font-size: 14px;
}

.search-btn:hover {
  background: var(--accent-hover);
}

.search-btn:disabled {
  opacity: 0.6;
}

.import-btn {
  height: 38px;
  padding: 0 18px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--panel);
  color: var(--text);
  font-size: 14px;
  flex-shrink: 0;
}

.import-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.error-bar {
  padding: 8px 20px;
  background: #fdecea;
  color: #8c2b23;
  font-size: 13px;
}

.main {
  display: flex;
  flex: 1;
  min-height: 0;
}

.side {
  width: 340px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.tab {
  flex: 1;
  padding: 11px 0;
  background: none;
  border: none;
  font-size: 14px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
}

.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.count {
  display: inline-block;
  min-width: 18px;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--chip);
  font-size: 12px;
  text-align: center;
}

.reader-pane {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.drag-overlay {
  position: fixed;
  inset: 0;
  background: rgba(38, 35, 30, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.drag-hint {
  padding: 28px 48px;
  border: 2px dashed rgba(255, 255, 255, 0.8);
  border-radius: 14px;
  color: #fff;
  font-size: 18px;
  font-family: var(--serif);
}
</style>
