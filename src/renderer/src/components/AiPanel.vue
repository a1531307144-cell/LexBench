<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import ConfirmModal from './ConfirmModal.vue'
import type { AiProgress } from '@shared/ipc'
import type { AiCitation, AiMessageRow, AiTask } from '@shared/types'

const props = defineProps<{
  /** 当前打开的法条 id（法条模式才渲染本面板） */
  articleId: number
}>()

const emit = defineEmits<{
  /** 点击引用跳转到对应法条（复用 App 打开法条的链路） */
  'open-article': [id: number]
  error: [message: string]
  notice: [message: string]
  /** 「AI 设置」/「去设置」→ App 打开设置对话框 */
  'open-settings': []
}>()

// ---------- 流式任务状态 ----------
const busy = ref(false)
/** 已发起、等待首字（尚无 delta） */
const pending = ref(false)
const streamText = ref('')
const streamTask = ref<AiTask | null>(null)
const streamErr = ref('')
const citations = ref<AiCitation[]>([])
/** 用户点了「停止」：忽略后续 delta，但保留已生成内容 */
const stopped = ref(false)
/** 当前进行中的任务 id；为空表示没有任务，进度事件一律丢弃（防止旧任务串台） */
const activeTaskId = ref<string | null>(null)

// ---------- 面板状态 ----------
const history = ref<AiMessageRow[]>([])
/** 未配置模型档案时的黄色提示（文案由主进程给出） */
const configMsg = ref('')
const question = ref('')
const expandedId = ref<number | null>(null)
const pendingDel = ref<AiMessageRow | null>(null)

let unsubscribe: (() => void) | null = null
let seq = 0

const taskNames: Record<AiTask, string> = { explain: '解读本条', cases: '找案例', followup: '追问' }

/** 流式回答：marked 渲染 + DOMPurify 消毒（与 NotePanel 预览同款，禁裸 v-html） */
const streamHtml = computed(() =>
  streamText.value.trim() ? DOMPurify.sanitize(marked.parse(streamText.value) as string) : ''
)

const delMessage = computed(() => (pendingDel.value ? '确定删除这条问答记录？此操作不可撤销。' : ''))

function taskName(t: AiTask): string {
  return taskNames[t] ?? '回答'
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

function newTaskId(): string {
  seq += 1
  return `ai-${Date.now()}-${seq}`
}

/** 未配置档案：主进程按约定给出的文案（「尚未配置」「请先填写」）→ 面板内提示 + 去设置 */
function isConfigError(msg: string): boolean {
  return msg.includes('尚未配置') || msg.includes('未配置') || msg.includes('请先填写')
}

// ---------- 历史 ----------

async function loadHistory(): Promise<void> {
  try {
    history.value = await window.lexbench.ai.history(props.articleId)
  } catch (e) {
    emit('error', errText(e))
  }
}

/** 归档记录里的 citations 为 JSON 字符串；解析失败按空处理 */
function parseCites(json: string): AiCitation[] {
  try {
    const arr: unknown = JSON.parse(json || '[]')
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (c): c is AiCitation =>
        !!c && typeof c === 'object' && typeof (c as AiCitation).title === 'string'
    )
  } catch {
    return []
  }
}

function openCite(c: AiCitation): void {
  if (c.articleId !== null && c.articleId !== undefined) emit('open-article', c.articleId)
}

function toggleExpand(id: number): void {
  expandedId.value = expandedId.value === id ? null : id
}

/**
 * 纯文本摘要（沿用 NotePanel 的思路：临时 textarea 解码实体，再只剥行首 markdown 结构标记）
 */
function summary(md: string, max = 80): string {
  const ta = document.createElement('textarea')
  ta.innerHTML = md || ''
  const plain = (ta.value || md || '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^(\s*)[-*+]\s+/, '$1')
        .replace(/^(\s*)\d+\.\s+/, '$1')
        .replace(/^\s*(```|~~~).*$/, '')
    )
    .filter((l) => l.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? plain.slice(0, max) + '…' : plain
}

function renderMd(md: string): string {
  return DOMPurify.sanitize(marked.parse(md || '') as string)
}

async function confirmDel(): Promise<void> {
  const m = pendingDel.value
  pendingDel.value = null
  if (!m) return
  try {
    await window.lexbench.ai.deleteMessage(m.id)
    if (expandedId.value === m.id) expandedId.value = null
    await loadHistory()
    emit('notice', '已删除该条问答记录')
  } catch (e) {
    emit('error', errText(e))
  }
}

// ---------- 任务执行 ----------

function abort(): void {
  const tid = activeTaskId.value
  activeTaskId.value = null
  busy.value = false
  pending.value = false
  if (tid) void window.lexbench.ai.cancel(tid).catch(() => {})
}

function resetStream(): void {
  streamText.value = ''
  streamTask.value = null
  streamErr.value = ''
  citations.value = []
  stopped.value = false
}

/** 失败收尾：部分内容已生成时保留，错误就地展示；未配置档案走黄色提示条 */
function finishFail(msg: string): void {
  activeTaskId.value = null
  busy.value = false
  pending.value = false
  if (isConfigError(msg)) {
    streamTask.value = null
    streamText.value = ''
    configMsg.value = msg
    return
  }
  streamErr.value = msg
  emit('error', msg)
}

/** 完成收尾：重取历史（归档消息带引用），并把本次归档的引用挂到回答下方 */
async function finishOk(messageId?: number): Promise<void> {
  activeTaskId.value = null
  busy.value = false
  pending.value = false
  await loadHistory()
  if (messageId !== undefined) {
    const m = history.value.find((x) => x.id === messageId)
    if (m) citations.value = parseCites(m.citations)
  }
}

async function startTask(task: AiTask): Promise<void> {
  if (busy.value || !props.articleId) return
  const q = question.value.trim()
  if (task === 'followup' && !q) return
  resetStream()
  configMsg.value = ''
  const tid = newTaskId()
  activeTaskId.value = tid
  busy.value = true
  pending.value = true
  streamTask.value = task
  try {
    const res = await window.lexbench.ai.run({
      taskId: tid,
      task,
      articleId: props.articleId,
      question: task === 'followup' ? q : undefined
    })
    // 期间已被停止 / 切条：丢弃本次结果
    if (activeTaskId.value !== tid) return
    if (!res.ok) {
      finishFail(res.error || 'AI 任务发起失败')
      return
    }
    // 发起成功才清空输入（失败时保留问题，便于重试）
    if (task === 'followup') question.value = ''
  } catch (e) {
    if (activeTaskId.value !== tid) return
    finishFail(errText(e))
  }
}

function stop(): void {
  if (!activeTaskId.value) return
  busy.value = false
  pending.value = false
  stopped.value = true
  void window.lexbench.ai.cancel(activeTaskId.value).catch(() => {})
}

/** 流式进度：只认当前任务 id，避免并行/过期任务串台 */
function onProgress(p: AiProgress): void {
  if (!activeTaskId.value || p.taskId !== activeTaskId.value) return
  if (p.error) {
    finishFail(p.error)
    return
  }
  if (p.delta && !stopped.value) {
    pending.value = false
    streamText.value += p.delta
  }
  if (p.done) void finishOk(p.messageId)
}

// 切换条文：取消进行中的任务、清空流式状态、重取该条历史
watch(
  () => props.articleId,
  () => {
    abort()
    resetStream()
    configMsg.value = ''
    question.value = ''
    expandedId.value = null
    void loadHistory()
  },
  { immediate: true }
)

onMounted(() => {
  unsubscribe = window.lexbench.ai.onProgress(onProgress)
})

onBeforeUnmount(() => {
  // 卸载必须退订，避免监听器泄漏（并取消仍在跑的任务）
  unsubscribe?.()
  unsubscribe = null
  abort()
})
</script>

<template>
  <section class="ai">
    <div class="ai-head">
      <span class="ai-title">✦ AI 研究助手</span>
      <span class="ai-sub">问答仅存本机，按条文归档</span>
      <span class="ai-flex"></span>
      <button class="ai-mini" title="配置模型档案" @click="emit('open-settings')">AI 设置</button>
    </div>

    <div v-if="configMsg" class="ai-warn">
      <span class="ai-warn-msg">{{ configMsg }}</span>
      <button class="ai-warn-btn" @click="emit('open-settings')">去设置</button>
    </div>

    <div class="ai-ops">
      <button class="ai-btn" :disabled="busy" @click="startTask('explain')">✦ 解读本条</button>
      <button class="ai-btn" :disabled="busy" @click="startTask('cases')">⚖ 找案例</button>
      <span class="ai-flex"></span>
      <button v-if="busy" class="ai-btn stop" @click="stop">停止</button>
    </div>

    <!-- 流式回答 -->
    <div v-if="busy || streamText || streamErr" class="ai-answer">
      <div class="ai-answer-head">
        <span class="ai-task-tag">{{ streamTask ? taskName(streamTask) : '回答' }}</span>
        <span v-if="stopped" class="ai-stopped">已停止</span>
      </div>
      <p v-if="pending && !streamText" class="ai-wait">生成中…</p>
      <div v-else class="ai-md" v-html="streamHtml"></div>
      <p v-if="streamErr" class="ai-err">{{ streamErr }}</p>

      <div v-if="citations.length" class="ai-cites">
        <span class="ai-cites-label">引用：</span>
        <button
          v-for="(c, i) in citations"
          :key="i"
          class="ai-cite"
          :class="{ plain: c.articleId === null }"
          :disabled="c.articleId === null"
          :title="c.articleId === null ? '库内未收录，无法跳转' : '打开该条文'"
          @click="openCite(c)"
        >
          《{{ c.title }}》{{ c.label }}<template v-if="c.articleId === null">（库内未收录）</template>
        </button>
      </div>
    </div>

    <!-- 历史问答（按条文归档，切换条文即换一批） -->
    <div class="ai-history">
      <div class="ai-sec">历史问答<span class="ai-count">{{ history.length }}</span></div>
      <p v-if="!history.length" class="ai-empty">本条暂无问答记录</p>
      <div v-for="m in history" :key="m.id" class="ai-card">
        <div class="ai-card-head">
          <span class="ai-hcard-tag">{{ taskName(m.action) }}</span>
          <span class="ai-time">{{ m.created_at.slice(5, 16) }}</span>
          <span class="ai-flex"></span>
          <button class="ai-act" title="展开/收起全文" @click="toggleExpand(m.id)">
            {{ expandedId === m.id ? '收起' : '展开' }}
          </button>
          <button class="ai-act" title="删除" @click="pendingDel = m">✕</button>
        </div>
        <p v-if="m.question" class="ai-q">问：{{ summary(m.question) }}</p>
        <p v-if="expandedId !== m.id" class="ai-a">答：{{ summary(m.answer_md, 120) }}</p>
        <div v-else class="ai-full">
          <div class="ai-md" v-html="renderMd(m.answer_md)"></div>
          <div v-if="parseCites(m.citations).length" class="ai-cites">
            <span class="ai-cites-label">引用：</span>
            <button
              v-for="(c, i) in parseCites(m.citations)"
              :key="i"
              class="ai-cite"
              :class="{ plain: c.articleId === null }"
              :disabled="c.articleId === null"
              :title="c.articleId === null ? '库内未收录，无法跳转' : '打开该条文'"
              @click="openCite(c)"
            >
              《{{ c.title }}》{{ c.label }}<template v-if="c.articleId === null">（库内未收录）</template>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 追问输入 -->
    <div class="ai-ask">
      <input
        v-model="question"
        class="ai-input"
        type="text"
        placeholder="就本条继续追问，Enter 发送"
        :disabled="busy"
        @keydown.enter.prevent="startTask('followup')"
      />
      <button class="ai-send" :disabled="busy || !question.trim()" @click="startTask('followup')">
        {{ busy ? '生成中…' : '发送' }}
      </button>
    </div>

    <ConfirmModal
      :visible="pendingDel !== null"
      title="删除问答记录"
      :message="delMessage"
      danger
      confirm-text="删除"
      @confirm="confirmDel"
      @cancel="pendingDel = null"
    />
  </section>
</template>

<style scoped>
.ai {
  margin-top: 34px;
  padding-top: 18px;
  border-top: 1px solid var(--lb-border);
}

.ai-flex {
  flex: 1;
}

/* ---------- 头部 ---------- */
.ai-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.ai-title {
  font-family: var(--lb-serif);
  font-size: 15px;
  font-weight: 600;
  color: var(--lb-text);
}

.ai-sub {
  font-size: 12px;
  color: var(--lb-muted);
}

.ai-mini {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 999px;
  background: var(--lb-panel);
  color: var(--lb-muted);
  font-size: 12px;
  flex-shrink: 0;
}

.ai-mini:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

/* ---------- 未配置提示 ---------- */
.ai-warn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--lb-radius-s);
  background: var(--lb-warn-bg);
  color: var(--lb-warn-fg);
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 10px;
}

.ai-warn-msg {
  flex: 1;
  min-width: 0;
}

.ai-warn-btn {
  flex-shrink: 0;
  height: 26px;
  padding: 0 12px;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-size: 12px;
}

.ai-warn-btn:hover {
  background: rgba(154, 106, 21, 0.1);
}

/* ---------- 操作 ---------- */
.ai-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.ai-btn {
  height: 32px;
  padding: 0 16px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
}

.ai-btn:hover:not(:disabled) {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.ai-btn.stop {
  border-color: var(--lb-accent);
  color: var(--lb-accent);
}

.ai-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---------- 流式回答 ---------- */
.ai-answer {
  padding: 12px 14px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: #fbfbfe;
  margin-bottom: 14px;
}

.ai-answer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.ai-task-tag {
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
}

.ai-stopped {
  font-size: 11px;
  color: var(--lb-muted);
}

.ai-wait {
  margin: 2px 0;
  font-size: 13px;
  color: var(--lb-muted);
}

.ai-err {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--lb-err-fg);
  word-break: break-word;
}

/* Markdown 渲染（与 NotePanel 预览同款排版） */
.ai-md {
  font-size: 13px;
  line-height: 1.9;
  color: var(--lb-text);
  word-break: break-word;
}

.ai-md :deep(h1),
.ai-md :deep(h2),
.ai-md :deep(h3),
.ai-md :deep(h4) {
  margin: 10px 0 6px;
  font-size: 14px;
  color: var(--lb-text);
}

.ai-md :deep(p) {
  margin: 0 0 8px;
}

.ai-md :deep(ul),
.ai-md :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.ai-md :deep(blockquote) {
  margin: 0 0 8px;
  padding: 4px 10px;
  border-left: 3px solid var(--lb-accent-2);
  background: var(--lb-accent-soft);
  color: var(--lb-muted);
}

.ai-md :deep(code) {
  background: var(--lb-chip);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}

.ai-md :deep(pre) {
  background: var(--lb-chip);
  padding: 8px 10px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0 0 8px;
}

.ai-md :deep(a) {
  color: var(--lb-accent);
}

/* ---------- 引用 ---------- */
.ai-cites {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--lb-border);
}

.ai-cites-label {
  font-size: 12px;
  color: var(--lb-muted);
}

.ai-cite {
  padding: 2px 10px;
  border: none;
  border-radius: 999px;
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-size: 12px;
  font-family: var(--lb-serif);
}

.ai-cite:hover:not(:disabled) {
  filter: brightness(0.96);
}

.ai-cite.plain {
  background: var(--lb-chip);
  color: var(--lb-muted);
  cursor: default;
}

/* ---------- 历史 ---------- */
.ai-history {
  margin-bottom: 12px;
}

.ai-sec {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--lb-muted);
  margin-bottom: 8px;
}

.ai-count {
  display: inline-block;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--lb-chip);
  font-size: 11px;
  text-align: center;
}

.ai-empty {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--lb-muted);
  padding: 10px 0;
}

.ai-card {
  padding: 10px 12px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 8px;
}

.ai-card:hover {
  border-color: var(--lb-border-strong);
}

.ai-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-hcard-tag {
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
}

.ai-time {
  font-size: 11px;
  color: var(--lb-muted);
}

.ai-act {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 5px;
  flex-shrink: 0;
}

.ai-act:hover {
  color: var(--lb-accent);
  background: var(--lb-chip);
}

.ai-q,
.ai-a {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--lb-muted);
  word-break: break-word;
}

.ai-q {
  color: var(--lb-text);
}

.ai-full {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--lb-border);
}

/* ---------- 追问输入 ---------- */
.ai-ask {
  display: flex;
  gap: 8px;
}

.ai-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: #fbfbfe;
  color: var(--lb-text);
  font-size: 13px;
  outline: none;
}

.ai-input:focus {
  border-color: var(--lb-accent-2);
  background: #fff;
}

.ai-input:disabled {
  opacity: 0.6;
}

.ai-send {
  height: 34px;
  padding: 0 18px;
  border: 1px solid var(--lb-accent);
  border-radius: var(--lb-radius-s);
  background: var(--lb-grad);
  color: #fff;
  font-size: 13px;
  flex-shrink: 0;
}

.ai-send:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
