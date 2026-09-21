<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AiPanel from './AiPanel.vue'
import type { ArticleDetail, DocumentDetail } from '@shared/types'

/** 阅读器状态：法条 / 文档 / 书籍沉浸阅读（书籍由 ReadingView 渲染，这里仅为类型对齐与兜底） */
type ReaderState =
  | { type: 'article'; data: ArticleDetail }
  | { type: 'document'; data: DocumentDetail }
  | { type: 'book'; data: DocumentDetail; focusPara?: number }
  | null

const props = defineProps<{
  state: ReaderState
  loading: boolean
  /** 专题模式翻页 override：传值（含首尾 null）时优先于法条自身前后条（App 传专题顺序相邻条） */
  navPrev?: { id: number; label: string } | null
  navNext?: { id: number; label: string } | null
}>()

const emit = defineEmits<{
  'open-article': [id: number]
  /** 条文修正已保存并重取详情，App 用它同步阅读器状态 */
  saved: [detail: ArticleDetail]
  /** ★ 收藏：App 打开 FavoriteDialog */
  favorite: []
  error: [message: string]
  /** AI 面板正向提示（走 App 消息条） */
  notice: [message: string]
  /** AI 面板「去设置」→ App 打开 AI 设置对话框 */
  'open-settings': []
}>()

const editing = ref(false)
const draft = ref('')
// saving 真实覆盖 updateArticle + getArticle 两次请求（修复旧版 #1）
const saving = ref(false)

// 阅读对象切换（id 变化）时滚回顶部并退出编辑态；保存后同条刷新不打断
watch(
  () => props.state,
  (next, prev) => {
    if (readerKey(next) === readerKey(prev)) return
    document.querySelector('.reader-pane')?.scrollTo({ top: 0 })
    editing.value = false
  }
)

function readerKey(s: ReaderState): string {
  if (!s) return ''
  if (s.type === 'article') return `article:${s.data.article.id}`
  return `${s.type}:${s.data.id}`
}

const pager = computed(() => {
  if (props.state?.type !== 'article') return null
  // 专题 override：navPrev/navNext 任一传值（含 null=到头）即按专题顺序翻页；未传则走法条自身前后条
  if (props.navPrev !== undefined || props.navNext !== undefined) {
    return { prev: props.navPrev ?? null, next: props.navNext ?? null }
  }
  return { prev: props.state.data.prev, next: props.state.data.next }
})

function paragraphs(content: string): string[] {
  return content.split('\n').filter((p) => p.trim())
}

/** 文档模式条文预览：首行前 120 字 */
function firstLine(content: string): string {
  const line = content.split('\n')[0] ?? ''
  return line.length > 120 ? line.slice(0, 120) + '…' : line
}

function startEdit(): void {
  if (props.state?.type !== 'article') return
  draft.value = props.state.data.article.content
  editing.value = true
}

async function saveEdit(): Promise<void> {
  if (props.state?.type !== 'article' || saving.value) return
  const content = draft.value.trim()
  if (!content) return
  saving.value = true
  try {
    await window.lexbench.library.updateArticle(props.state.data.article.id, content)
    const detail = await window.lexbench.library.getArticle(props.state.data.article.id)
    editing.value = false
    emit('saved', detail)
  } catch (e) {
    emit('error', errText(e))
  } finally {
    saving.value = false
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

const typeNames: Record<string, string> = {
  statute: '法规',
  case: '案例',
  book: '书籍',
  other: '资料'
}
</script>

<template>
  <div class="reader">
    <div v-if="loading" class="reader-empty">加载中…</div>

    <!-- 空态欢迎页 -->
    <div v-else-if="!state" class="reader-empty">
      <div class="welcome">
        <div class="welcome-seal">法</div>
        <p class="welcome-title">LexBench · 法研台</p>
        <p class="welcome-sub">本地法律检索与研究工作台</p>
        <div class="welcome-tips">
          <p>· 输入 <b>民法典 1077</b> 直接定位《民法典》第一千零七十七条</p>
          <p>· 输入 <b>离婚 冷静期</b> 全文搜索所有已导入文档</p>
          <p>· 把 docx / pdf / txt 拖进窗口，或点右上角「导入文档」建库</p>
          <p>· 阅读时点 <b>★ 收藏</b>，把法条收进研究专题并随手记笔记</p>
        </div>
      </div>
    </div>

    <!-- 法条模式 -->
    <article v-else-if="state.type === 'article'" class="article">
      <div class="crumb">
        <span>{{ state.data.article.title }}</span>
        <template v-if="state.data.article.branch">
          <span class="crumb-sep">›</span><span>{{ state.data.article.branch }}</span>
        </template>
        <template v-if="state.data.article.chapter">
          <span class="crumb-sep">›</span><span>{{ state.data.article.chapter }}</span>
        </template>
        <template v-if="state.data.article.section">
          <span class="crumb-sep">›</span><span>{{ state.data.article.section }}</span>
        </template>
      </div>
      <div class="article-head">
        <h1 class="article-label">{{ state.data.article.label }}</h1>
        <div v-if="!editing" class="head-ops">
          <button class="ghost-btn" title="收藏到研究专题" @click="emit('favorite')">★ 收藏</button>
          <button class="ghost-btn" title="手动修正条文内容" @click="startEdit">修正</button>
        </div>
      </div>

      <div v-if="editing" class="edit-area">
        <textarea v-model="draft" rows="10" :disabled="saving"></textarea>
        <div class="edit-ops">
          <span class="edit-hint">修正解析错误的条文内容，保存后全文索引同步更新</span>
          <button class="edit-cancel" :disabled="saving" @click="editing = false">取消</button>
          <button class="edit-save" :disabled="saving || !draft.trim()" @click="saveEdit">
            {{ saving ? '保存中…' : '保存修正' }}
          </button>
        </div>
      </div>
      <div v-else class="article-body">
        <p v-for="(p, i) in paragraphs(state.data.article.content)" :key="i">{{ p }}</p>
      </div>

      <div class="article-foot">
        <span v-if="state.data.article.category" class="chip">{{ state.data.article.category }}</span>
        <!-- 旧版此处硬编码「法规」chip（缺陷 #5）；getArticle 未返回 doc_type，宁缺勿错 -->
      </div>

      <div v-if="pager && (pager.prev || pager.next)" class="pager">
        <button v-if="pager.prev" class="pager-btn" @click="emit('open-article', pager.prev.id)">
          ← {{ pager.prev.label }}
        </button>
        <span v-else class="pager-spacer"></span>
        <button v-if="pager.next" class="pager-btn" @click="emit('open-article', pager.next.id)">
          {{ pager.next.label }} →
        </button>
      </div>

      <!-- AI 研究助手：正文下方按条文归档问答；引用可点击跳转 -->
      <AiPanel
        :article-id="state.data.article.id"
        @open-article="emit('open-article', $event)"
        @error="emit('error', $event)"
        @notice="emit('notice', $event)"
        @open-settings="emit('open-settings')"
      />
    </article>

    <!-- 文档模式 -->
    <article v-else-if="state.type === 'document'" class="doc">
      <div class="doc-head">
        <h1 class="doc-title">{{ state.data.title }}</h1>
        <div class="doc-meta">
          <span class="chip type-chip" :data-type="state.data.doc_type">
            {{ typeNames[state.data.doc_type] || state.data.doc_type }}
          </span>
          <span v-if="state.data.category" class="chip">{{ state.data.category }}</span>
          <span v-if="state.data.status === 'needs_review'" class="chip warn">需人工复查</span>
          <span class="doc-count">
            {{ state.data.doc_type === 'statute' ? `共 ${state.data.articles.length} 条` : `共 ${state.data.chunks.length} 段` }}
          </span>
        </div>
      </div>

      <template v-if="state.data.doc_type === 'statute'">
        <div
          v-for="a in state.data.articles"
          :key="a.id"
          class="doc-article"
          @click="emit('open-article', a.id)"
        >
          <div class="doc-article-label">{{ a.article_label }}</div>
          <p class="doc-article-content">{{ firstLine(a.content) }}</p>
        </div>
      </template>
      <template v-else>
        <div v-for="c in state.data.chunks" :key="c.id" class="doc-chunk">
          <p v-for="(p, i) in paragraphs(c.content)" :key="i">{{ p }}</p>
        </div>
      </template>
    </article>
  </div>
</template>

<style scoped>
.reader {
  max-width: 780px;
  margin: 0 auto;
  padding: 36px 44px 60px;
  min-height: 100%;
}

.reader-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  color: var(--lb-muted);
}

/* ---------- 欢迎页 ---------- */
.welcome {
  text-align: center;
}

.welcome-seal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  border-radius: 14px;
  background: var(--lb-grad);
  color: #fff;
  font-family: var(--lb-serif);
  font-size: 28px;
  margin-bottom: 16px;
  box-shadow: 0 6px 16px rgba(0, 113, 227, 0.22);
}

.welcome-title {
  font-family: var(--lb-serif);
  font-size: 19px;
  font-weight: 600;
  color: var(--lb-text);
  margin: 0 0 6px;
  letter-spacing: 0.02em;
}

.welcome-sub {
  color: var(--lb-muted);
  margin: 0 0 28px;
  font-size: 13px;
  letter-spacing: 0.4px;
}

.welcome-tips {
  text-align: left;
  display: inline-block;
  color: var(--lb-muted);
  font-size: 13px;
  line-height: 2.2;
}

.welcome-tips b {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
  padding: 0 6px;
  border-radius: 4px;
}

/* ---------- 法条模式 ---------- */
.crumb {
  color: var(--lb-muted);
  font-size: 13px;
  margin-bottom: 14px;
  line-height: 1.6;
}

.crumb-sep {
  margin: 0 6px;
}

.article-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 20px;
}

.article-label {
  font-family: var(--lb-serif);
  font-size: 24px;
  font-weight: 600;
  color: var(--lb-text);
  margin: 0;
  letter-spacing: 0.01em;
}

.ghost-btn {
  padding: 6px 14px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 999px;
  background: var(--lb-panel);
  color: var(--lb-muted);
  font-size: 13px;
  flex-shrink: 0;
}

.ghost-btn:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.head-ops {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.edit-area textarea {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--lb-accent-2);
  border-radius: var(--lb-radius-s);
  font-family: var(--lb-serif);
  font-size: 15px;
  line-height: 2;
  outline: none;
  background: #fffdf8;
  color: var(--lb-text);
  resize: vertical;
}

.edit-ops {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.edit-hint {
  flex: 1;
  font-size: 12px;
  color: var(--lb-muted);
}

.edit-cancel {
  padding: 6px 16px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
}

.edit-save {
  padding: 6px 16px;
  border: 1px solid var(--lb-accent);
  border-radius: var(--lb-radius-s);
  background: var(--lb-grad);
  color: #fff;
  font-size: 13px;
}

.edit-cancel:disabled,
.edit-save:disabled {
  opacity: 0.5;
  cursor: default;
}

.article-body {
  font-family: var(--lb-serif);
  font-size: 17px;
  line-height: 2;
  color: var(--lb-text);
}

.article-body p {
  margin: 0 0 4px;
  text-indent: 2em;
}

.article-foot {
  margin-top: 24px;
  display: flex;
  gap: 8px;
}

.chip {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
}

.chip.warn {
  background: var(--lb-warn-bg);
  color: var(--lb-warn-fg);
}

.pager {
  margin-top: 40px;
  padding-top: 18px;
  border-top: 1px solid var(--lb-border);
  display: flex;
  justify-content: space-between;
}

.pager-btn {
  padding: 8px 16px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  font-size: 13px;
  font-family: var(--lb-serif);
  color: var(--lb-text);
}

.pager-btn:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.pager-spacer {
  width: 1px;
}

/* ---------- 文档模式 ---------- */
.doc-head {
  border-bottom: 1px solid var(--lb-border);
  padding-bottom: 18px;
  margin-bottom: 8px;
}

.doc-title {
  font-family: var(--lb-serif);
  font-size: 22px;
  font-weight: 600;
  color: var(--lb-text);
  margin: 0 0 12px;
  letter-spacing: 0.01em;
}

.doc-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.type-chip[data-type='statute'] {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.doc-count {
  color: var(--lb-muted);
  font-size: 12px;
}

.doc-article {
  padding: 12px 14px;
  border-radius: var(--lb-radius-s);
  cursor: pointer;
}

.doc-article:hover {
  background: var(--lb-accent-soft);
}

.doc-article-label {
  font-family: var(--lb-serif);
  font-size: 15px;
  font-weight: 600;
  color: var(--lb-accent);
}

.doc-article-content {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--lb-muted);
  line-height: 1.7;
  font-family: var(--lb-serif);
}

.doc-chunk {
  font-family: var(--lb-serif);
  font-size: 16px;
  line-height: 2;
  padding: 10px 0;
  color: var(--lb-text);
}

.doc-chunk p {
  margin: 0 0 6px;
  text-indent: 2em;
}
</style>
