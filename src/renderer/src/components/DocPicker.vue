<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DocumentRow } from '@shared/types'

const props = defineProps<{
  visible: boolean
  documents: DocumentRow[]
  title?: string
}>()

const emit = defineEmits<{
  close: []
  select: [documentId: number]
}>()

const keyword = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const typeNames: Record<string, string> = {
  statute: '法规',
  case: '案例',
  book: '书籍',
  other: '资料'
}

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return props.documents
  return props.documents.filter(
    (d) => d.title.toLowerCase().includes(q) || (d.category ?? '').toLowerCase().includes(q)
  )
})

function pick(id: number): void {
  emit('select', id)
}

function close(): void {
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (props.visible && e.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// 每次打开重新聚焦搜索框
watch(
  () => props.visible,
  (v) => {
    if (!v) return
    keyword.value = ''
    void nextTick(() => inputEl.value?.focus())
  }
)
</script>

<template>
  <div v-if="visible" class="dp-mask" @click.self="close">
    <div class="dp-card" role="dialog" aria-label="选择文档">
      <div class="dp-head">
        <span class="dp-title">{{ title || '选择文档' }}</span>
        <button class="dp-close" title="关闭" @click="close">✕</button>
      </div>
      <input
        ref="inputEl"
        v-model="keyword"
        class="dp-search"
        type="text"
        placeholder="搜索文档标题或分类…"
      />
      <div class="dp-list">
        <p v-if="filtered.length === 0" class="dp-empty">
          {{ documents.length ? '没有匹配的文档' : '文档库还是空的，先导入一些文档' }}
        </p>
        <button
          v-for="d in filtered"
          :key="d.id"
          class="dp-item"
          :title="d.title"
          @click="pick(d.id)"
        >
          <span class="dp-item-title">{{ d.title }}</span>
          <span class="dp-item-meta">
            <i class="dp-chip" :data-type="d.doc_type">{{ typeNames[d.doc_type] || d.doc_type }}</i>
            <span v-if="d.category">{{ d.category }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dp-mask {
  position: absolute;
  inset: 0;
  z-index: 150;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lb-overlay-soft);
}

.dp-card {
  width: min(420px, calc(100% - 32px));
  max-height: min(70%, 520px);
  display: flex;
  flex-direction: column;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-3);
  overflow: hidden;
}

.dp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.dp-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
}

.dp-close {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 12px;
}

.dp-search {
  margin: 10px 14px 6px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel-2);
  color: var(--lb-text);
  font-size: 13px;
  outline: none;
}

.dp-search:focus {
  border-color: var(--lb-accent-ring);
  box-shadow: 0 0 0 3px var(--lb-accent-soft);
}

.dp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px 12px;
}

.dp-empty {
  padding: 26px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--lb-muted);
}

.dp-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: var(--lb-radius-s);
  background: transparent;
  text-align: left;
}

.dp-item:hover {
  border-color: var(--lb-accent-2);
  background: var(--lb-accent-soft);
}

.dp-item-title {
  font-size: 13px;
  color: var(--lb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dp-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--lb-muted);
}

.dp-chip {
  font-style: normal;
  padding: 0 6px;
  border-radius: var(--lb-radius-full);
  background: var(--lb-chip);
}
</style>
