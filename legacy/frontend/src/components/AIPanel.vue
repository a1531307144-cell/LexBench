<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api, type AIMessage } from '../api'

const props = defineProps<{ articleId: number; articleLabel: string }>()
const emit = defineEmits<{ 'open-article': [id: number]; 'open-settings': [] }>()

const messages = ref<AIMessage[]>([])
const busy = ref<'' | 'explain' | 'cases' | 'followup'>('')
const question = ref('')
const error = ref('')
const needConfig = ref(false)
const listEl = ref<HTMLElement | null>(null)

const actionNames: Record<string, string> = {
  explain: 'AI 解读',
  cases: '相关案例',
  followup: '追问',
}

watch(() => props.articleId, loadHistory, { immediate: true })

async function loadHistory() {
  error.value = ''
  needConfig.value = false
  try {
    messages.value = await api.aiHistory(props.articleId)
  } catch {
    messages.value = []
  }
}

async function run(action: 'explain' | 'cases') {
  if (busy.value) return
  busy.value = action
  error.value = ''
  needConfig.value = false
  try {
    const msg =
      action === 'explain'
        ? await api.aiExplain(props.articleId)
        : await api.aiCases(props.articleId)
    messages.value.push(msg)
    await reveal(msg)
  } catch (e) {
    handleError(e)
  } finally {
    busy.value = ''
  }
}

async function ask() {
  const q = question.value.trim()
  if (!q || busy.value) return
  busy.value = 'followup'
  error.value = ''
  needConfig.value = false
  try {
    const msg = await api.aiFollowup({ article_id: props.articleId, question: q })
    messages.value.push(msg)
    question.value = ''
    await reveal(msg)
  } catch (e) {
    handleError(e)
  } finally {
    busy.value = ''
  }
}

function handleError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  if (/未配置|API Key|接口地址/.test(msg)) needConfig.value = true
  error.value = msg
}

async function reveal(msg: AIMessage) {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight })
  document
    .querySelector(`#ai-msg-${msg.id}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'end' })
}

async function remove(id: number) {
  if (!confirm('确定删除这条 AI 问答记录？')) return
  try {
    await api.deleteAIMessage(id)
    messages.value = messages.value.filter((m) => m.id !== id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderAnswer(msg: AIMessage): string {
  let html = marked.parse(msg.answer_md, { breaks: true, async: false }) as string
  for (const c of msg.citations) {
    if (c.article_id == null || !c.cite_text) continue
    const anchor =
      `<a href="#" class="cite-link" data-article-id="${c.article_id}">` +
      `${escapeHtml(c.cite_text)}</a>`
    html = html.split(escapeHtml(c.cite_text)).join(anchor)
  }
  return DOMPurify.sanitize(html)
}

function onAnswerClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a.cite-link') as HTMLAnchorElement | null
  if (!a) return
  e.preventDefault()
  const id = Number(a.dataset.articleId)
  if (id) emit('open-article', id)
}
</script>

<template>
  <section class="ai-panel">
    <div class="ai-bar">
      <span class="ai-tag">AI</span>
      <span class="ai-title">研究助手</span>
      <span class="ai-note">问答仅存本机，按条文归档</span>
      <div class="ai-actions">
        <button class="ai-btn" :disabled="!!busy" @click="run('explain')">
          {{ busy === 'explain' ? '解读中…' : '✦ 解读本条' }}
        </button>
        <button class="ai-btn" :disabled="!!busy" @click="run('cases')">
          {{ busy === 'cases' ? '检索中…' : '⚖ 找案例' }}
        </button>
      </div>
    </div>

    <div v-if="needConfig" class="ai-tip config">
      AI 尚未配置。请先填写 OpenAI 兼容接口地址、模型名与 API Key。
      <button class="ai-tip-btn" @click="emit('open-settings')">去设置</button>
    </div>
    <div v-else-if="error" class="ai-tip err">{{ error }}</div>

    <div ref="listEl" class="ai-messages">
      <p v-if="!messages.length" class="ai-empty">
        点「解读本条」：AI 会用平实语言解释条文主旨、适用场景与实务要点；
        点「找案例」：结合本地文档库归纳适用情形。也可直接在下方追问。
      </p>

      <div v-for="m in messages" :id="`ai-msg-${m.id}`" :key="m.id" class="ai-msg">
        <div class="ai-msg-top">
          <span class="ai-msg-action" :class="m.action">{{ actionNames[m.action] }}</span>
          <span v-if="m.action === 'followup' && m.question" class="ai-msg-q" :title="m.question">
            {{ m.question.length > 30 ? m.question.slice(0, 30) + '…' : m.question }}
          </span>
          <span class="ai-msg-time">{{ m.created_at.slice(5, 16) }}</span>
          <button class="ai-msg-del" title="删除记录" @click="remove(m.id)">✕</button>
        </div>
        <div
          class="ai-msg-body markdown-body"
          v-html="renderAnswer(m)"
          @click="onAnswerClick"
        ></div>
        <div v-if="m.citations.length" class="ai-cites">
          <span class="ai-cites-label">引用：</span>
          <button
            v-for="(c, i) in m.citations"
            :key="i"
            class="ai-cite"
            :class="{ dead: c.article_id == null }"
            :disabled="c.article_id == null"
            :title="c.article_id != null ? c.title : '库内未找到该条文，仅供文字参考'"
            @click="c.article_id != null && emit('open-article', c.article_id)"
          >
            {{ c.article_id != null ? c.label : `${c.title}${c.label}（库内未收录）` }}
          </button>
        </div>
      </div>

      <div v-if="busy" class="ai-loading">AI 生成中，通常需要几秒到几十秒…</div>
    </div>

    <div class="ai-ask">
      <input
        v-model="question"
        type="text"
        :placeholder="`就「${articleLabel}」追问，如：这条的起算点怎么算？`"
        :disabled="!!busy"
        @keydown.enter="ask"
      />
      <button class="ai-ask-btn" :disabled="!question.trim() || !!busy" @click="ask">
        {{ busy === 'followup' ? '思考中…' : '追问' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ai-panel {
  margin-top: 36px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fbfaf7;
  overflow: hidden;
}

.ai-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.ai-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}

.ai-title {
  font-size: 14px;
  font-weight: 600;
  font-family: var(--serif);
}

.ai-note {
  flex: 1;
  font-size: 11px;
  color: var(--muted);
}

.ai-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.ai-btn {
  padding: 6px 14px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
}

.ai-btn:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

.ai-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ai-tip {
  margin: 10px 14px 0;
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: 12px;
  line-height: 1.8;
}

.ai-tip.config {
  background: #fdf3e3;
  color: #9a6a15;
}

.ai-tip.err {
  background: #fdecea;
  color: #8c2b23;
}

.ai-tip-btn {
  border: 1px solid #9a6a15;
  background: none;
  color: #9a6a15;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  margin-left: 6px;
}

.ai-messages {
  max-height: 420px;
  overflow-y: auto;
  padding: 12px 14px;
}

.ai-empty {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 2;
}

.ai-msg {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  margin-bottom: 10px;
}

.ai-msg-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.ai-msg-action {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}

.ai-msg-action.followup {
  background: var(--chip);
  color: var(--muted);
}

.ai-msg-q {
  font-size: 12px;
  color: var(--text);
  font-family: var(--serif);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}

.ai-msg-time {
  flex: 1;
  text-align: right;
  font-size: 11px;
  color: var(--muted);
}

.ai-msg-del {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 12px;
  padding: 0 2px;
  flex-shrink: 0;
}

.ai-msg-del:hover {
  color: #b3402f;
}

.ai-msg-body {
  font-size: 13px;
}

.ai-msg-body :deep(a.cite-link) {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dashed var(--accent);
}

.ai-msg-body :deep(a.cite-link:hover) {
  background: var(--accent-soft);
}

.ai-cites {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.ai-cites-label {
  font-size: 11px;
  color: var(--muted);
}

.ai-cite {
  padding: 2px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--panel);
  color: var(--accent);
  font-size: 11px;
  font-family: var(--serif);
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-cite:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.ai-cite.dead {
  color: var(--muted);
  cursor: default;
}

.ai-loading {
  padding: 4px 2px;
  font-size: 12px;
  color: var(--accent);
}

.ai-ask {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.ai-ask input {
  flex: 1;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  font-size: 13px;
  outline: none;
  background: #fbfaf7;
  min-width: 0;
}

.ai-ask input:focus {
  border-color: var(--accent);
  background: #fff;
}

.ai-ask-btn {
  height: 34px;
  padding: 0 18px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  flex-shrink: 0;
}

.ai-ask-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
