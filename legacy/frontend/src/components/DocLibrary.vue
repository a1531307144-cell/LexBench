<script setup lang="ts">
import type { DocumentRow } from '../api'

defineProps<{ documents: DocumentRow[] }>()
defineEmits<{ open: [id: number]; delete: [id: number] }>()

const typeNames: Record<string, string> = {
  statute: '法规',
  case: '案例',
  other: '资料',
}
</script>

<template>
  <div class="library">
    <div v-if="documents.length === 0" class="empty">
      <p class="empty-title">还没有导入任何文档</p>
      <p class="empty-line">点击右上角「导入文档」，或把 docx / pdf 拖进窗口</p>
    </div>

    <div
      v-for="d in documents"
      :key="d.id"
      class="row"
      @click="$emit('open', d.id)"
    >
      <div class="row-main">
        <div class="row-title">
          {{ d.title }}
          <span v-if="d.status === 'needs_review'" class="warn-chip">需复查</span>
        </div>
        <div class="row-meta">
          <span class="type-chip" :data-type="d.doc_type">{{ typeNames[d.doc_type] || d.doc_type }}</span>
          <span v-if="d.category" class="meta-item">{{ d.category }}</span>
          <span class="meta-item">{{ d.doc_type === 'statute' ? `${d.article_count} 条` : '' }}</span>
          <span class="meta-item">{{ d.imported_at?.slice(0, 10) }}</span>
        </div>
      </div>
      <button class="del-btn" title="删除" @click.stop="$emit('delete', d.id)">✕</button>
    </div>
  </div>
</template>

<style scoped>
.library {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.empty {
  padding: 48px 20px;
  text-align: center;
  color: var(--muted);
}

.empty-title {
  font-size: 15px;
  font-family: var(--serif);
  margin: 0 0 8px;
  color: var(--text);
}

.empty-line {
  font-size: 13px;
  margin: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 8px;
  cursor: pointer;
  background: #fdfcfa;
}

.row:hover {
  border-color: var(--accent);
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-title {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.warn-chip {
  font-size: 11px;
  font-weight: 400;
  color: #9a6a15;
  background: #fdf3e3;
  border-radius: 999px;
  padding: 1px 7px;
  margin-left: 6px;
  vertical-align: 1px;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  font-size: 12px;
  color: var(--muted);
}

.type-chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--chip);
  color: var(--muted);
}

.type-chip[data-type='statute'] {
  color: var(--accent);
  background: var(--accent-soft);
}

.meta-item {
  white-space: nowrap;
}

.del-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
}

.del-btn:hover {
  background: #fdecea;
  color: var(--accent);
}
</style>
