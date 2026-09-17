<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { marked } from 'marked'
import { api, type TopicDetail } from '../api'

const props = defineProps<{
  topic: TopicDetail
  currentArticleId: number
  currentArticleLabel: string
}>()

const emit = defineEmits<{
  changed: []
  'open-article': [articleId: number]
  export: [format: 'md' | 'docx']
}>()

const content = ref('')
const editingId = ref<number | null>(null)
const linkCurrent = ref(true)
const preview = ref(false)
const busy = ref(false)
const error = ref('')

const inTopic = computed(() =>
  props.topic.items.some((i) => i.article_id === props.currentArticleId),
)
const currentLinkLabel = computed(() =>
  inTopic.value ? props.currentArticleLabel : '',
)

watch(
  () => props.currentArticleId,
  () => {
    linkCurrent.value = true
  },
)

const previewHtml = computed(() =>
  marked.parse(content.value, { breaks: true, async: false }) as string,
)

function startEdit(noteId: number, md: string) {
  editingId.value = noteId
  content.value = md
  preview.value = false
  error.value = ''
}

function resetEditor() {
  editingId.value = null
  content.value = ''
  preview.value = false
  error.value = ''
}

async function save() {
  const md = content.value.trim()
  if (!md || busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (editingId.value != null) {
      await api.updateNote(editingId.value, md)
    } else {
      await api.createNote({
        topic_id: props.topic.id,
        article_id: inTopic.value && linkCurrent.value ? props.currentArticleId : null,
        content_md: md,
      })
    }
    resetEditor()
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function remove(noteId: number) {
  if (!confirm('确定删除这条笔记？')) return
  if (editingId.value === noteId) resetEditor()
  await api.deleteNote(noteId)
  emit('changed')
}

function noteExcerpt(md: string): string {
  return md.replace(/[#>*`\-]/g, '').slice(0, 60)
}
</script>

<template>
  <aside class="notes-pane">
    <div class="notes-head">
      <span class="notes-title" :title="topic.name">{{ topic.name }}</span>
      <div class="notes-actions">
        <button class="mini-btn" title="下载 Markdown 报告" @click="emit('export', 'md')">.md</button>
        <button class="mini-btn" title="下载 Word 报告" @click="emit('export', 'docx')">.docx</button>
      </div>
    </div>

    <div class="editor">
      <div class="editor-toolbar">
        <span class="editor-label">
          {{ editingId != null ? '编辑笔记' : '记思考' }}
          <em v-if="inTopic" class="link-hint">
            <label class="link-check">
              <input v-model="linkCurrent" type="checkbox" />
              关联{{ currentLinkLabel }}
            </label>
          </em>
        </span>
        <button class="mini-btn" @click="preview = !preview">
          {{ preview ? '编辑' : '预览' }}
        </button>
      </div>

      <div v-show="!preview" class="editor-main">
        <textarea
          v-model="content"
          placeholder="用 Markdown 记录思考…&#10;如：**要点**：冷静期 30 日，注意起算点"
          @keydown.ctrl.enter="save"
        ></textarea>
      </div>
      <div v-show="preview" class="preview markdown-body" v-html="previewHtml"></div>

      <div class="editor-foot">
        <span v-if="error" class="err">{{ error }}</span>
        <button v-if="editingId != null" class="mini-btn" @click="resetEditor">取消</button>
        <button class="mini-btn primary" :disabled="!content.trim() || busy" @click="save">
          {{ busy ? '保存中…' : '保存（Ctrl+Enter）' }}
        </button>
      </div>
    </div>

    <div class="notes-list">
      <p v-if="!topic.notes.length" class="empty-tip">还没有笔记。上面的编辑器里写下第一条思考。</p>
      <div v-for="n in topic.notes" :key="n.id" class="note-card" :class="{ editing: editingId === n.id }">
        <div class="note-top">
          <button
            v-if="n.article_id"
            class="note-link"
            title="跳转到该法条"
            @click="emit('open-article', n.article_id!)"
          >
            {{ topic.items.find((i) => i.article_id === n.article_id)?.label || '已关联法条' }}
          </button>
          <span v-else class="note-topic-chip">专题</span>
          <span class="note-time">{{ n.updated_at.slice(5, 16) }}</span>
          <button class="icon-btn" title="编辑" @click="startEdit(n.id, n.content_md)">✎</button>
          <button class="icon-btn del" title="删除" @click="remove(n.id)">✕</button>
        </div>
        <p class="note-text">{{ noteExcerpt(n.content_md) }}</p>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.notes-pane {
  width: 320px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.notes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.notes-title {
  font-size: 13px;
  font-weight: 600;
  font-family: var(--serif);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notes-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.mini-btn {
  padding: 3px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
}

.mini-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.mini-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.mini-btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.editor {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 0;
}

.editor-label {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

.link-hint {
  font-style: normal;
}

.link-check {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: var(--accent);
  font-size: 11px;
}

.link-check input {
  accent-color: var(--accent);
}

.editor-main {
  padding: 8px 14px 0;
}

textarea {
  width: 100%;
  height: 120px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.8;
  font-family: var(--serif);
  resize: vertical;
  outline: none;
  box-sizing: border-box;
  background: #fbfaf7;
}

textarea:focus {
  border-color: var(--accent);
  background: #fff;
}

.preview {
  height: 120px;
  overflow-y: auto;
  margin: 8px 14px 0;
  padding: 10px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  font-size: 13px;
}

.editor-foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
}

.err {
  flex: 1;
  font-size: 12px;
  color: #b3402f;
}

.notes-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  min-height: 0;
}

.empty-tip {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
  padding: 8px 6px;
}

.note-card {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 8px;
  background: #fbfaf7;
}

.note-card.editing {
  border-color: var(--accent);
}

.note-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.note-link {
  border: none;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-family: var(--serif);
  padding: 2px 8px;
  border-radius: 999px;
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.note-topic-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--chip);
  color: var(--muted);
}

.note-time {
  flex: 1;
  font-size: 11px;
  color: var(--muted);
}

.icon-btn {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 12px;
  padding: 2px 4px;
}

.icon-btn:hover {
  color: var(--accent);
}

.icon-btn.del:hover {
  color: #b3402f;
}

.note-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text);
  font-family: var(--serif);
  word-break: break-all;
}
</style>
