<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ArticleDetail, DocumentDetail } from '../api'
import AIPanel from './AIPanel.vue'

type ReaderState =
  | { type: 'article'; data: ArticleDetail }
  | { type: 'document'; data: DocumentDetail }
  | null

const props = defineProps<{
  state: ReaderState
  loading: boolean
  topicNav?: { prev: { id: number; label: string } | null; next: { id: number; label: string } | null } | null
}>()
const emit = defineEmits<{
  'open-article': [id: number]
  favorite: [articleId: number]
  'save-content': [articleId: number, content: string]
  'open-settings': []
}>()

const editing = ref(false)
const draft = ref('')
const saving = ref(false)

watch(
  () => props.state,
  () => {
    document.querySelector('.reader-pane')?.scrollTo({ top: 0 })
    editing.value = false
  },
)

const pager = computed(() => {
  if (props.topicNav) return props.topicNav
  if (props.state?.type === 'article') {
    return { prev: props.state.data.prev, next: props.state.data.next }
  }
  return null
})

function paragraphs(content: string): string[] {
  return content.split('\n').filter((p) => p.trim())
}

function go(id: number) {
  emit('open-article', id)
}

function startEdit() {
  if (props.state?.type !== 'article') return
  draft.value = props.state.data.content
  editing.value = true
}

async function saveEdit() {
  if (props.state?.type !== 'article' || saving.value) return
  const content = draft.value.trim()
  if (!content) return
  saving.value = true
  try {
    emit('save-content', props.state.data.id, content)
  } finally {
    saving.value = false
  }
}

const typeNames: Record<string, string> = {
  statute: '法规',
  case: '案例',
  other: '资料',
}
</script>

<template>
  <div class="reader">
    <div v-if="loading" class="reader-empty">加载中…</div>

    <div v-else-if="!state" class="reader-empty">
      <div class="welcome">
        <div class="welcome-seal">法</div>
        <p class="welcome-title">LexBench · 法研台</p>
        <p class="welcome-sub">本地法律检索与研究工作台</p>
        <div class="welcome-tips">
          <p>· 输入 <b>民法典 1077</b> 直接定位《民法典》第一千零七十七条</p>
          <p>· 输入 <b>离婚 冷静期</b> 全文搜索所有已导入文档</p>
          <p>· 把 docx / pdf / txt 拖进窗口即可导入（仓库 samples/ 有内置示例）</p>
          <p>· 阅读、检索时点 ★ 收藏到专题，右栏同步记笔记</p>
          <p>· 打开任意法条，用 AI 解读 / 找案例 / 追问（需先在「AI 设置」配置）</p>
        </div>
      </div>
    </div>

    <!-- 法条模式 -->
    <article v-else-if="state.type === 'article'" class="article">
      <div class="crumb">
        <span>{{ state.data.title }}</span>
        <span v-if="state.data.branch"> › {{ state.data.branch }}</span>
        <span v-if="state.data.chapter"> › {{ state.data.chapter }}</span>
        <span v-if="state.data.section"> › {{ state.data.section }}</span>
      </div>
      <div class="article-head">
        <h1 class="article-label">{{ state.data.label }}</h1>
        <div class="article-ops">
          <button
            class="fav-btn"
            title="收藏到专题"
            @click="emit('favorite', state.data.id)"
          >
            ★ 收藏
          </button>
          <button v-if="!editing" class="edit-btn" title="手动修正条文内容" @click="startEdit">
            修正
          </button>
        </div>
      </div>

      <div v-if="editing" class="edit-area">
        <textarea v-model="draft" rows="10"></textarea>
        <div class="edit-ops">
          <span class="edit-hint">修正解析错误的条文内容，保存后全文索引同步更新</span>
          <button class="edit-cancel" @click="editing = false">取消</button>
          <button class="edit-save" :disabled="saving || !draft.trim()" @click="saveEdit">
            {{ saving ? '保存中…' : '保存修正' }}
          </button>
        </div>
      </div>
      <div v-else class="article-body">
        <p v-for="(p, i) in paragraphs(state.data.content)" :key="i">{{ p }}</p>
      </div>

      <div class="article-foot">
        <span v-if="state.data.category" class="foot-chip">{{ state.data.category }}</span>
        <span class="foot-chip">法规</span>
      </div>

      <AIPanel
        :article-id="state.data.id"
        :article-label="state.data.label"
        @open-article="emit('open-article', $event)"
        @open-settings="emit('open-settings')"
      />

      <div v-if="pager" class="pager">
        <button v-if="pager.prev" class="pager-btn" @click="go(pager.prev.id)">
          ← {{ pager.prev.label }}
        </button>
        <span v-else class="pager-spacer"></span>
        <button v-if="pager.next" class="pager-btn" @click="go(pager.next.id)">
          {{ pager.next.label }} →
        </button>
      </div>
    </article>

    <!-- 文档模式 -->
    <article v-else class="doc">
      <div class="doc-head">
        <h1 class="doc-title">{{ state.data.title }}</h1>
        <div class="doc-meta">
          <span class="foot-chip">{{ typeNames[state.data.doc_type] || state.data.doc_type }}</span>
          <span v-if="state.data.category" class="foot-chip">{{ state.data.category }}</span>
          <span v-if="state.data.status === 'needs_review'" class="foot-chip warn">需人工复查</span>
          <span class="doc-count" v-if="state.data.doc_type === 'statute'">
            共 {{ state.data.articles.length }} 条
          </span>
          <span v-else class="doc-count">共 {{ state.data.chunks.length }} 段</span>
        </div>
      </div>

      <template v-if="state.data.doc_type === 'statute'">
        <div v-for="a in state.data.articles" :key="a.id" class="doc-article" @click="go(a.id)">
          <div class="doc-article-label">{{ a.article_label }}</div>
          <p class="doc-article-content">
            {{ a.content.split('\n')[0].slice(0, 120) }}{{ a.content.length > 120 ? '…' : '' }}
          </p>
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
  color: var(--muted);
}

.welcome {
  text-align: center;
}

.welcome-seal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 12px;
  background: var(--accent);
  color: #fff;
  font-family: var(--serif);
  font-size: 30px;
  margin-bottom: 16px;
}

.welcome-title {
  font-family: var(--serif);
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 6px;
}

.welcome-sub {
  color: var(--muted);
  margin: 0 0 28px;
  font-size: 13px;
  letter-spacing: 2px;
}

.welcome-tips {
  text-align: left;
  display: inline-block;
  color: var(--muted);
  font-size: 13px;
  line-height: 2.2;
}

.welcome-tips b {
  color: var(--accent);
  background: var(--accent-soft);
  padding: 0 6px;
  border-radius: 4px;
}

.crumb {
  color: var(--muted);
  font-size: 13px;
  margin-bottom: 14px;
  line-height: 1.6;
}

.article-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 20px;
}

.article-label {
  font-family: var(--serif);
  font-size: 26px;
  font-weight: 700;
  margin: 0;
  letter-spacing: 1px;
}

.article-ops {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.fav-btn {
  padding: 6px 14px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
}

.fav-btn:hover {
  background: var(--accent);
  color: #fff;
}

.edit-btn {
  padding: 6px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
}

.edit-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.edit-area textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 14px 16px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  font-family: var(--serif);
  font-size: 15px;
  line-height: 2;
  outline: none;
  background: #fffdf8;
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
  color: var(--muted);
}

.edit-cancel {
  padding: 6px 16px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--panel);
  font-size: 13px;
}

.edit-save {
  padding: 6px 16px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
}

.edit-save:disabled {
  opacity: 0.5;
}

.article-body {
  font-family: var(--serif);
  font-size: 17px;
  line-height: 2;
  color: var(--text);
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

.foot-chip {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--chip);
  color: var(--muted);
}

.foot-chip.warn {
  background: #fdf3e3;
  color: #9a6a15;
}

.pager {
  margin-top: 40px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
}

.pager-btn {
  padding: 8px 16px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--panel);
  font-size: 13px;
  font-family: var(--serif);
}

.pager-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.pager-spacer {
  width: 1px;
}

.doc-head {
  border-bottom: 1px solid var(--border);
  padding-bottom: 18px;
  margin-bottom: 8px;
}

.doc-title {
  font-family: var(--serif);
  font-size: 22px;
  font-weight: 700;
  margin: 0 0 12px;
}

.doc-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.doc-count {
  color: var(--muted);
  font-size: 12px;
}

.doc-article {
  padding: 12px 14px;
  border-radius: var(--radius);
  cursor: pointer;
}

.doc-article:hover {
  background: var(--accent-soft);
}

.doc-article-label {
  font-family: var(--serif);
  font-size: 15px;
  font-weight: 600;
  color: var(--accent);
}

.doc-article-content {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.7;
  font-family: var(--serif);
}

.doc-chunk {
  font-family: var(--serif);
  font-size: 16px;
  line-height: 2;
  padding: 10px 0;
}

.doc-chunk p {
  margin: 0 0 6px;
  text-indent: 2em;
}
</style>
