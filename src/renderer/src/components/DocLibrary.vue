<script setup lang="ts">
import type { DocumentRow } from '@shared/types'

defineProps<{ documents: DocumentRow[] }>()

defineEmits<{
  open: [id: number]
  /** 删除走 App 的 ConfirmModal（不使用原生 confirm） */
  remove: [doc: DocumentRow]
  /** 一键标记已复查（needs_review → parsed） */
  'mark-reviewed': [id: number]
}>()

const typeNames: Record<string, string> = {
  statute: '法规',
  case: '案例',
  book: '书籍',
  other: '资料'
}
</script>

<template>
  <div class="library">
    <div v-if="documents.length === 0" class="empty">
      <p class="empty-title">还没有导入任何文档</p>
      <p class="empty-line">点击右上角「导入文档」，或把 docx / pdf / txt 拖进窗口</p>
    </div>

    <div v-for="d in documents" :key="d.id" class="row" @click="$emit('open', d.id)">
      <div class="row-main">
        <div class="row-title">
          {{ d.title }}
          <span v-if="d.status === 'needs_review'" class="warn-chip">需复查</span>
        </div>
        <div class="row-meta">
          <span class="type-chip" :data-type="d.doc_type">{{ typeNames[d.doc_type] || d.doc_type }}</span>
          <span v-if="d.category" class="meta-item">{{ d.category }}</span>
          <span v-if="d.doc_type === 'statute'" class="meta-item">{{ d.article_count }} 条</span>
          <span class="meta-item">{{ d.imported_at?.slice(0, 10) }}</span>
          <button
            v-if="d.status === 'needs_review'"
            class="review-btn"
            title="解析确认无误？点击标记为已复查"
            @click.stop="$emit('mark-reviewed', d.id)"
          >
            标记已复查
          </button>
        </div>
      </div>
      <button class="del-btn" title="删除" @click.stop="$emit('remove', d)">✕</button>
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
  color: var(--lb-muted);
}

.empty-title {
  font-size: 15px;
  font-family: var(--lb-serif);
  margin: 0 0 8px;
  color: var(--lb-text);
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
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 8px;
  cursor: pointer;
  background: #fbfbfe;
}

.row:hover {
  border-color: var(--lb-accent-2);
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--lb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.warn-chip {
  font-size: 11px;
  font-weight: 400;
  color: var(--lb-warn-fg);
  background: var(--lb-warn-bg);
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
  color: var(--lb-muted);
}

.type-chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  flex-shrink: 0;
}

.type-chip[data-type='statute'] {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.meta-item {
  white-space: nowrap;
}

.review-btn {
  border: none;
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  flex-shrink: 0;
}

.review-btn:hover {
  background: var(--lb-accent);
  color: #fff;
}

.del-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--lb-muted);
  font-size: 13px;
}

.del-btn:hover {
  background: var(--lb-err-bg);
  color: var(--lb-accent);
}
</style>
