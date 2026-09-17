<script setup lang="ts">
import { ref } from 'vue'
import type { TopicDetail, TopicRow } from '../api'

const props = defineProps<{
  topics: TopicRow[]
  topic: TopicDetail | null
  currentArticleId: number
}>()

const emit = defineEmits<{
  create: [name: string, description: string]
  open: [id: number]
  back: []
  'open-article': [articleId: number]
  'remove-item': [articleId: number]
  'delete-topic': [id: number]
  'rename-topic': [id: number, name: string]
  export: [format: 'md' | 'docx']
}>()

const newName = ref('')
const newDesc = ref('')
const creating = ref(false)
const renaming = ref(false)
const renameValue = ref('')

function submitCreate() {
  const name = newName.value.trim()
  if (!name) return
  emit('create', name, newDesc.value.trim())
  newName.value = ''
  newDesc.value = ''
  creating.value = false
}

function startRename() {
  renameValue.value = props.topic?.name ?? ''
  renaming.value = true
}

function submitRename() {
  const name = renameValue.value.trim()
  if (props.topic && name) emit('rename-topic', props.topic.id, name)
  renaming.value = false
}

function confirmDelete(id: number) {
  if (confirm('确定删除该专题？其中的收藏与笔记将一并删除。')) emit('delete-topic', id)
}

function excerpt(content: string): string {
  const first = content.split('\n')[0]
  return first.length > 40 ? first.slice(0, 40) + '…' : first
}
</script>

<template>
  <!-- 专题列表态 -->
  <div v-if="!topic" class="topic-list-pane">
    <div class="pane-head">
      <span>研究专题</span>
      <button class="mini-btn" @click="creating = !creating">{{ creating ? '取消' : '+ 新建' }}</button>
    </div>

    <form v-if="creating" class="create-form" @submit.prevent="submitCreate">
      <input v-model="newName" type="text" placeholder="专题名称（如：离婚财产分割）" autofocus />
      <input v-model="newDesc" type="text" placeholder="一句话描述（可选）" />
      <button type="submit" class="mini-btn primary">创建</button>
    </form>

    <div class="scroll-area">
      <p v-if="!topics.length" class="empty-tip">
        还没有专题。检索到法条后点 ★ 收藏，即可建立自己的研究方向。
      </p>
      <div
        v-for="t in topics"
        :key="t.id"
        class="topic-row"
        @click="emit('open', t.id)"
      >
        <div class="topic-main">
          <span class="topic-name">{{ t.name }}</span>
          <span class="topic-desc" v-if="t.description">{{ t.description }}</span>
        </div>
        <div class="topic-side">
          <span class="topic-meta">{{ t.item_count }} 条 · {{ t.note_count }} 记</span>
          <button class="icon-btn del" title="删除专题" @click.stop="confirmDelete(t.id)">✕</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 专题详情态：收藏列表 -->
  <div v-else class="topic-detail-pane">
    <div class="pane-head">
      <button class="mini-btn" @click="emit('back')">‹ 返回</button>
      <span class="pane-title" :title="topic.name">{{ topic.name }}</span>
      <div class="pane-actions">
        <button class="mini-btn" title="下载 Markdown 报告" @click="emit('export', 'md')">导出 .md</button>
        <button class="mini-btn" title="下载 Word 报告" @click="emit('export', 'docx')">导出 .docx</button>
      </div>
    </div>

    <div v-if="renaming" class="create-form">
      <input v-model="renameValue" type="text" @keydown.enter="submitRename" />
      <div class="form-row">
        <button class="mini-btn primary" @click="submitRename">保存</button>
        <button class="mini-btn" @click="renaming = false">取消</button>
      </div>
    </div>
    <p v-else-if="topic.description" class="topic-desc-line" @dblclick="startRename" title="双击重命名专题">
      {{ topic.description }}
    </p>
    <p v-else class="topic-desc-line muted" @dblclick="startRename" title="双击重命名专题">
      {{ topic.name }}（双击此处重命名）
    </p>

    <div class="scroll-area">
      <p v-if="!topic.items.length" class="empty-tip">
        专题还是空的。检索或阅读法条时点 ★ 即可收藏到本专题。
      </p>
      <div
        v-for="item in topic.items"
        :key="item.item_id"
        class="item-row"
        :class="{ active: item.article_id === currentArticleId }"
        @click="emit('open-article', item.article_id)"
      >
        <div class="item-label">
          <span class="item-no">{{ item.order_index + 1 }}</span>
          {{ item.label }}
        </div>
        <div class="item-title">{{ item.title }}</div>
        <p class="item-excerpt">{{ excerpt(item.content) }}</p>
        <button
          class="icon-btn del item-del"
          title="移出专题"
          @click.stop="emit('remove-item', item.article_id)"
        >
          ✕
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.topic-list-pane,
.topic-detail-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.pane-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--serif);
}

.pane-actions {
  display: flex;
  gap: 6px;
}

.mini-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  flex-shrink: 0;
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

.create-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.create-form input {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}

.create-form input:focus {
  border-color: var(--accent);
}

.form-row {
  display: flex;
  gap: 8px;
}

.scroll-area {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  min-height: 0;
}

.empty-tip {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.8;
  padding: 14px 6px;
}

.topic-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius);
  cursor: pointer;
}

.topic-row:hover {
  background: var(--accent-soft);
}

.topic-main {
  min-width: 0;
}

.topic-name {
  display: block;
  font-size: 14px;
  font-weight: 600;
  font-family: var(--serif);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topic-desc {
  display: block;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.topic-side {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.topic-meta {
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

.icon-btn.del:hover {
  color: #b3402f;
}

.topic-desc-line {
  margin: 0;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  cursor: default;
  flex-shrink: 0;
}

.topic-desc-line.muted {
  opacity: 0.7;
}

.item-row {
  position: relative;
  padding: 10px 30px 10px 12px;
  border-radius: var(--radius);
  cursor: pointer;
  border: 1px solid transparent;
}

.item-row:hover {
  background: var(--accent-soft);
}

.item-row.active {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.item-label {
  font-family: var(--serif);
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
}

.item-no {
  display: inline-block;
  width: 20px;
  color: var(--muted);
  font-weight: 400;
  font-size: 12px;
}

.item-title {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}

.item-excerpt {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  font-family: var(--serif);
}

.item-del {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0;
}

.item-row:hover .item-del {
  opacity: 1;
}
</style>
