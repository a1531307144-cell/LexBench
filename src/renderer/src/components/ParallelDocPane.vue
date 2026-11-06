<script setup lang="ts">
import type { DocumentDetail, ParallelPane } from '@shared/types'
import ReadingView from './ReadingView.vue'
import StatuteReadingView from './StatuteReadingView.vue'

defineProps<{
  pane: ParallelPane
  detail: DocumentDetail | null
  error: string
  loading: boolean
  narrow: boolean
  active: boolean
  persist: boolean
}>()

const emit = defineEmits<{
  close: []
  error: [err: unknown]
  notice: [text: string]
  'doc-changed': []
  'toggle-rail': []
}>()
</script>

<template>
  <div class="pd">
    <div v-if="error" class="pd-state">
      <p class="pd-state-title">文档打开失败</p>
      <p class="pd-state-line">{{ error }}</p>
      <button class="pd-btn" @click="emit('close')">关闭窗口</button>
    </div>
    <div v-else-if="!detail" class="pd-state">
      <p class="pd-state-line">{{ loading ? '正在打开文档…' : '未选择文档' }}</p>
      <button v-if="!loading" class="pd-btn" @click="emit('close')">关闭窗口</button>
    </div>
    <StatuteReadingView
      v-else-if="detail.doc_type === 'statute'"
      :key="detail.id"
      :doc="detail"
      :embedded="true"
      :narrow="narrow"
      :pane-active="active"
      :persist-progress="persist"
      :persist-zoom="persist"
      @back="emit('close')"
      @error="emit('error', $event)"
      @notice="emit('notice', $event)"
      @doc-changed="emit('doc-changed')"
      @toggle-rail="emit('toggle-rail')"
    />
    <ReadingView
      v-else
      :key="detail.id"
      :doc="detail"
      :embedded="true"
      :narrow="narrow"
      :pane-active="active"
      :persist-progress="persist"
      :persist-zoom="persist"
      @back="emit('close')"
      @error="emit('error', $event)"
      @notice="emit('notice', $event)"
      @toggle-rail="emit('toggle-rail')"
    />
  </div>
</template>

<style scoped>
.pd {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.pd-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  text-align: center;
}

.pd-state-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
}

.pd-state-line {
  font-size: 12px;
  line-height: 1.7;
  color: var(--lb-muted);
  max-width: 340px;
  word-break: break-word;
}

.pd-btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}
</style>
