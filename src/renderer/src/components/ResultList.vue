<script setup lang="ts">
import type { SearchHit, SearchOutcome } from '@shared/types'

defineProps<{
  results: SearchHit[]
  mode: SearchOutcome['mode']
  searched: boolean
  searching: boolean
  query: string
  selectedId: number
  hasDocs: boolean
}>()

defineEmits<{ select: [hit: SearchHit] }>()

const typeNames: Record<string, string> = {
  statute: '法规',
  case: '案例',
  other: '资料'
}
</script>

<template>
  <div class="result-list">
    <div v-if="!searched" class="empty">
      <template v-if="hasDocs">
        <p class="empty-title">开始检索</p>
        <p class="empty-line">试试：<code>民法典 1077</code>（法条定位）或 <code>离婚 冷静期</code>（全文搜索）</p>
      </template>
      <template v-else>
        <p class="empty-title">文档库还是空的</p>
        <p class="empty-line">点击右上角「导入文档」，或直接把 docx / pdf / txt 文件拖进窗口</p>
      </template>
    </div>

    <div v-else-if="searching" class="empty">检索中…</div>

    <div v-else-if="results.length === 0" class="empty">
      <p class="empty-title">没有找到相关内容</p>
      <p class="empty-line">换个说法试试：用更短的关键词，或检查法条序号是否写对</p>
    </div>

    <template v-else>
      <div class="mode-line">
        <span v-if="mode === 'locate'" class="mode-chip locate">法条定位</span>
        <span v-else-if="mode === 'fulltext'" class="mode-chip">全文搜索</span>
        <span class="mode-text">“{{ query }}”</span>
      </div>
      <div
        v-for="r in results"
        :key="r.kind + '-' + r.id"
        class="item"
        :class="{ selected: r.kind === 'article' && r.id === selectedId }"
        @click="$emit('select', r)"
      >
        <div class="item-head">
          <span class="item-title">{{ r.title }}</span>
          <span class="item-type" :data-type="r.doc_type">{{ typeNames[r.doc_type] || r.doc_type }}</span>
        </div>
        <div class="item-label">{{ r.label }}</div>
        <!-- snippet 由主进程 HTML 转义后生成（来源可信），em 为关键词高亮 -->
        <div v-if="r.snippet" class="item-snippet" v-html="r.snippet"></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.result-list {
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
  line-height: 1.8;
}

.empty-line code {
  background: var(--lb-chip);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--lb-accent);
}

.mode-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 10px;
  color: var(--lb-muted);
  font-size: 12px;
}

.mode-chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  flex-shrink: 0;
}

.mode-chip.locate {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
}

.mode-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item {
  padding: 12px 14px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 8px;
  cursor: pointer;
  background: #fbfbfe;
}

.item:hover {
  border-color: var(--lb-accent-2);
}

.item.selected {
  border-color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.item-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.item-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--lb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-type {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--lb-chip);
  color: var(--lb-muted);
}

.item-type[data-type='statute'] {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.item-label {
  margin-top: 4px;
  font-family: var(--lb-serif);
  font-size: 14px;
  color: var(--lb-text);
}

.item-snippet {
  margin-top: 6px;
  font-size: 13px;
  color: var(--lb-muted);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.item-snippet :deep(em) {
  font-style: normal;
  font-weight: 600;
  color: var(--lb-accent-2);
}
</style>
