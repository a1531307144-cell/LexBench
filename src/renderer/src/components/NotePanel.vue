<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import ConfirmModal from './ConfirmModal.vue'
import type { ExportFormat, NoteRow, TopicDetail } from '@shared/types'

const props = defineProps<{
  /** 当前打开的专题详情（App 维护，笔记增删改后经 changed 事件刷新） */
  topic: TopicDetail
  /** 阅读器当前打开的法条 id（仅法条模式渲染本栏，故不会为 null 传进来） */
  currentArticleId: number | null
  currentArticleLabel: string
}>()

const emit = defineEmits<{
  /** 笔记发生增删改，App 刷新专题详情与列表计数 */
  changed: []
  'open-article': [id: number]
  export: [format: ExportFormat]
  error: [message: string]
}>()

const content = ref('')
const editingId = ref<number | null>(null)
const linkCurrent = ref(true)
const preview = ref(false)
const busy = ref(false)
const savedHint = ref(false)
const pendingDel = ref<NoteRow | null>(null)

let savedTimer: ReturnType<typeof setTimeout> | undefined

// 当前法条已收藏进本专题时才提供「关联」复选框
const linkedIds = computed(() => new Set(props.topic.items.map((it) => it.article_id)))
const canLink = computed(
  () => props.currentArticleId !== null && linkedIds.value.has(props.currentArticleId)
)

// 预览：marked 渲染 + DOMPurify 消毒（修复旧版 #9 裸 v-html）
const previewHtml = computed(() => {
  if (!preview.value || !content.value.trim()) return ''
  return DOMPurify.sanitize(marked.parse(content.value) as string)
})

// 切换法条时默认勾选关联（仅影响新建笔记；编辑已有笔记不改变其关联）
watch(
  () => props.currentArticleId,
  () => {
    if (editingId.value === null) linkCurrent.value = true
  }
)

// 换了专题必须清空编辑态，避免把草稿误存到别的专题的笔记上
watch(
  () => props.topic.id,
  () => resetForm()
)

function resetForm(): void {
  content.value = ''
  editingId.value = null
  preview.value = false
  linkCurrent.value = true
}

function startEditNote(n: NoteRow): void {
  editingId.value = n.id
  content.value = n.content_md
  preview.value = false
}

async function saveNote(): Promise<void> {
  const md = content.value.trim()
  if (!md || busy.value) return
  busy.value = true
  try {
    if (editingId.value === null) {
      const articleId = canLink.value && linkCurrent.value ? props.currentArticleId : null
      await window.lexbench.workspace.createNote(props.topic.id, articleId, md)
    } else {
      await window.lexbench.workspace.updateNote(editingId.value, md)
    }
    resetForm()
    emit('changed')
    savedHint.value = true
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => (savedHint.value = false), 2500)
  } catch (e) {
    // 失败保留草稿，错误进 App 错误条
    emit('error', errText(e))
  } finally {
    busy.value = false
  }
}

async function confirmDel(): Promise<void> {
  const n = pendingDel.value
  if (!n) return
  pendingDel.value = null
  try {
    await window.lexbench.workspace.deleteNote(n.id)
    if (editingId.value === n.id) resetForm()
    emit('changed')
  } catch (e) {
    emit('error', errText(e))
  }
}

/**
 * 笔记纯文本摘要（修复旧版 #17）：先用临时 textarea 解码 HTML 实体（textarea 是 RCDATA，
 * 标签不会被解析执行、正文原样保留），再只剥行首的 markdown 结构标记——
 * 标题井号 / 引用符 / 列表符 / 围栏行，绝不碰正文里的连字符与日期。
 */
function noteSummary(md: string): string {
  const ta = document.createElement('textarea')
  ta.innerHTML = md
  const plain = (ta.value || md)
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '') // 行首标题井号
        .replace(/^\s{0,3}>\s?/, '') // 行首引用符
        .replace(/^(\s*)[-*+]\s+/, '$1') // 行首无序列表符
        .replace(/^(\s*)\d+\.\s+/, '$1') // 行首有序列表符
        .replace(/^\s*(```|~~~).*$/, '') // 围栏代码块标记行
    )
    .filter((l) => l.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 60 ? plain.slice(0, 60) + '…' : plain
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

const delMessage = computed(() => (pendingDel.value ? '确定删除这条笔记？此操作不可撤销。' : ''))

onBeforeUnmount(() => clearTimeout(savedTimer))
</script>

<template>
  <aside class="np">
    <div class="np-head">
      <span class="np-title" :title="topic.name">{{ topic.name }}</span>
      <span class="np-flex"></span>
      <button class="np-mini" title="导出 Markdown 报告" @click="emit('export', 'md')">.md</button>
      <button class="np-mini" title="导出 Word 报告" @click="emit('export', 'docx')">.docx</button>
    </div>

    <!-- 笔记表单：新建 / 编辑共用 -->
    <div class="np-form">
      <div class="np-form-bar">
        <button class="np-tab" :class="{ on: !preview }" @click="preview = false">编辑</button>
        <button class="np-tab" :class="{ on: preview }" @click="preview = true">预览</button>
        <span v-if="editingId !== null" class="np-editing-tag">编辑已有笔记</span>
        <span class="np-flex"></span>
        <span v-if="savedHint" class="np-saved">已保存</span>
      </div>

      <label v-if="editingId === null && canLink" class="np-link">
        <input v-model="linkCurrent" type="checkbox" />
        关联〔{{ currentArticleLabel }}〕
      </label>

      <textarea
        v-if="!preview"
        v-model="content"
        class="np-textarea"
        rows="6"
        placeholder="记下思考、案例线索、适用要点……"
        :disabled="busy"
        @keydown.ctrl.enter.prevent="saveNote"
      ></textarea>
      <div v-else class="np-preview">
        <div v-if="previewHtml" class="np-preview-body" v-html="previewHtml"></div>
        <p v-else class="np-preview-empty">暂无内容可预览</p>
      </div>

      <div class="np-form-foot">
        <span class="np-hint">Ctrl+Enter 保存</span>
        <span class="np-flex"></span>
        <button v-if="editingId !== null" class="np-btn" :disabled="busy" @click="resetForm">
          取消
        </button>
        <button
          class="np-btn primary"
          :disabled="busy || !content.trim()"
          @click="saveNote"
        >
          {{ busy ? '保存中…' : editingId !== null ? '保存修改' : '保存笔记' }}
        </button>
      </div>
    </div>

    <!-- 笔记卡片列表（updated_at DESC 由后端保证） -->
    <div class="np-list">
      <div v-if="!topic.notes.length" class="np-empty">
        <p class="np-empty-title">暂无笔记</p>
        <p class="np-empty-sub">在上方写下你对本专题的思考</p>
      </div>
      <div v-for="n in topic.notes" :key="n.id" class="np-card">
        <div class="np-card-head">
          <button
            v-if="n.article_id"
            class="np-chip link"
            title="打开关联条文"
            @click="emit('open-article', n.article_id)"
          >
            {{ n.article_label }}
          </button>
          <span v-else class="np-chip">专题</span>
          <span class="np-flex"></span>
          <span class="np-time">{{ n.updated_at.slice(5, 16) }}</span>
          <button class="np-act" title="编辑" @click="startEditNote(n)">✎</button>
          <button class="np-act" title="删除" @click="pendingDel = n">✕</button>
        </div>
        <p class="np-sum">{{ noteSummary(n.content_md) }}</p>
      </div>
    </div>

    <ConfirmModal
      :visible="pendingDel !== null"
      title="删除笔记"
      :message="delMessage"
      danger
      confirm-text="删除"
      @confirm="confirmDel"
      @cancel="pendingDel = null"
    />
  </aside>
</template>

<style scoped>
.np {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--lb-panel);
  border-left: 1px solid var(--lb-border);
}

.np-flex {
  flex: 1;
}

/* ---------- 头栏 ---------- */
.np-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.np-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
  font-family: var(--lb-serif);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.np-mini {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
  flex-shrink: 0;
}

.np-mini:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

/* ---------- 笔记表单 ---------- */
.np-form {
  padding: 10px 14px 12px;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.np-form-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}

.np-tab {
  padding: 4px 12px;
  border: none;
  border-radius: 999px;
  background: none;
  color: var(--lb-muted);
  font-size: 12px;
}

.np-tab.on {
  background: var(--lb-chip);
  color: var(--lb-accent);
  font-weight: 600;
}

.np-editing-tag {
  font-size: 11px;
  color: var(--lb-warn-fg);
  background: var(--lb-warn-bg);
  padding: 1px 8px;
  border-radius: 999px;
  margin-left: 4px;
}

.np-saved {
  font-size: 12px;
  color: var(--lb-ok-fg);
}

.np-link {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--lb-muted);
  margin-bottom: 8px;
  cursor: pointer;
}

.np-link input {
  accent-color: var(--lb-accent);
}

.np-textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  font-size: 13px;
  line-height: 1.8;
  color: var(--lb-text);
  outline: none;
  background: #fbfbfe;
  resize: vertical;
  min-height: 110px;
}

.np-textarea:focus {
  border-color: var(--lb-accent-2);
  background: #fff;
}

.np-preview {
  min-height: 110px;
  max-height: 260px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: #fbfbfe;
}

.np-preview-body {
  font-size: 13px;
  line-height: 1.8;
  color: var(--lb-text);
  word-break: break-word;
}

.np-preview-body :deep(h1),
.np-preview-body :deep(h2),
.np-preview-body :deep(h3),
.np-preview-body :deep(h4) {
  margin: 10px 0 6px;
  font-size: 14px;
  color: var(--lb-text);
}

.np-preview-body :deep(p) {
  margin: 0 0 8px;
}

.np-preview-body :deep(ul),
.np-preview-body :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.np-preview-body :deep(blockquote) {
  margin: 0 0 8px;
  padding: 4px 10px;
  border-left: 3px solid var(--lb-accent-2);
  background: var(--lb-accent-soft);
  color: var(--lb-muted);
}

.np-preview-body :deep(code) {
  background: var(--lb-chip);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}

.np-preview-body :deep(pre) {
  background: var(--lb-chip);
  padding: 8px 10px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0 0 8px;
}

.np-preview-body :deep(a) {
  color: var(--lb-accent);
}

.np-preview-empty {
  font-size: 12px;
  color: var(--lb-muted);
}

.np-form-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.np-hint {
  font-size: 11px;
  color: var(--lb-muted);
}

.np-btn {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}

.np-btn.primary {
  border-color: var(--lb-accent);
  background: var(--lb-grad);
  color: #fff;
}

.np-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---------- 笔记列表 ---------- */
.np-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 10px 14px 16px;
}

.np-empty {
  padding: 30px 10px;
  text-align: center;
}

.np-empty-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--lb-text);
  margin-bottom: 6px;
}

.np-empty-sub {
  font-size: 12px;
  color: var(--lb-muted);
}

.np-card {
  padding: 10px 12px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 8px;
}

.np-card:hover {
  border-color: var(--lb-border-strong);
}

.np-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.np-chip {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  flex-shrink: 0;
}

.np-chip.link {
  border: none;
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  cursor: pointer;
}

.np-chip.link:hover {
  background: var(--lb-accent-soft);
  filter: brightness(0.97);
}

.np-time {
  font-size: 11px;
  color: var(--lb-muted);
  flex-shrink: 0;
}

.np-act {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 12px;
  padding: 2px 5px;
  border-radius: 5px;
  flex-shrink: 0;
  visibility: hidden;
}

.np-card:hover .np-act {
  visibility: visible;
}

.np-act:hover {
  color: var(--lb-accent);
  background: var(--lb-chip);
}

.np-sum {
  margin: 7px 0 0;
  font-size: 12px;
  color: var(--lb-muted);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
</style>
