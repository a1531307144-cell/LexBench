<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import ConfirmModal from './ConfirmModal.vue'
import type { ParallelViewListRow } from '@shared/types'

const props = defineProps<{
  views: ParallelViewListRow[]
  activeNoteId: number | null
}>()

const emit = defineEmits<{
  open: [noteId: number]
  create: []
  rename: [noteId: number, name: string]
  /** 重置布局（保留笔记与自定义名称） */
  reset: [noteId: number]
}>()

const keyword = ref('')
const renamingId = ref<number | null>(null)
const renameName = ref('')
const pendingReset = ref<ParallelViewListRow | null>(null)

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return props.views
  return props.views.filter(
    (v) =>
      displayName(v).toLowerCase().includes(q) || v.note_title.toLowerCase().includes(q)
  )
})

function displayName(v: ParallelViewListRow): string {
  return v.name.trim() || v.note_title
}

function subtitle(v: ParallelViewListRow): string {
  return v.name.trim() ? v.note_title : ''
}

function meta(v: ParallelViewListRow): string {
  const docs = v.doc_count > 0 ? `${v.doc_count} 篇文档` : '未添加文档'
  return `${docs} · ${v.updated_at.slice(5, 10)}`
}

function startRename(v: ParallelViewListRow): void {
  renamingId.value = v.note_id
  renameName.value = v.name.trim()
  void nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.pv-rename')
    el?.focus()
    el?.select()
  })
}

function commitRename(): void {
  const id = renamingId.value
  if (id === null) return
  renamingId.value = null
  emit('rename', id, renameName.value.trim())
}

function cancelRename(): void {
  renamingId.value = null
}

function askReset(v: ParallelViewListRow): void {
  pendingReset.value = v
}

function confirmReset(): void {
  const v = pendingReset.value
  pendingReset.value = null
  if (v) emit('reset', v.note_id)
}
</script>

<template>
  <div class="pv">
    <div class="pv-head">
      <span class="pv-title">平行视图</span>
      <button class="pv-new" title="新建一篇笔记及其平行视图" @click="emit('create')">
        ＋ 新建
      </button>
    </div>

    <div class="pv-search">
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <input v-model="keyword" class="pv-search-input" type="text" placeholder="搜索平行视图" />
    </div>

    <div class="pv-body">
      <p v-if="views.length === 0" class="pv-empty">
        还没有笔记。<br />
        点「＋ 新建」创建第一篇笔记，它会自动拥有一个平行视图。
      </p>
      <p v-else-if="filtered.length === 0" class="pv-empty">没有匹配的平行视图</p>

      <div v-else class="pv-grid">
        <div
          v-for="v in filtered"
          :key="v.note_id"
          class="pv-card"
          :class="{ on: v.note_id === activeNoteId }"
          :data-note-id="v.note_id"
          role="button"
          tabindex="0"
          :title="`${displayName(v)}（笔记：${v.note_title}）`"
          @click="renamingId === v.note_id ? undefined : emit('open', v.note_id)"
          @keydown.enter.prevent="renamingId === v.note_id ? undefined : emit('open', v.note_id)"
        >
          <span class="pv-icon" aria-hidden="true">
            <svg viewBox="0 0 64 64">
              <rect x="10" y="8" width="44" height="48" rx="5" fill="none" stroke="currentColor" stroke-width="2.4" />
              <path d="M32 12v40" stroke="currentColor" stroke-width="2.2" opacity="0.65" />
              <path d="M16 18h9M16 25h9M39 18h9M39 25h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55" />
            </svg>
          </span>

          <span class="pv-main">
            <input
              v-if="renamingId === v.note_id"
              v-model="renameName"
              class="pv-rename"
              type="text"
              placeholder="视图名称（留空则用笔记标题）"
              @click.stop
              @keydown.enter.stop.prevent="commitRename"
              @keydown.esc.stop.prevent="cancelRename"
              @blur="commitRename"
            />
            <template v-else>
              <span class="pv-name">{{ displayName(v) }}</span>
              <span v-if="subtitle(v)" class="pv-sub">{{ subtitle(v) }}</span>
              <span class="pv-date">{{ meta(v) }}</span>
            </template>
          </span>

          <span v-if="renamingId !== v.note_id" class="pv-acts">
            <button
              class="pv-act"
              data-pv-action="rename"
              title="重命名视图"
              @click.stop="startRename(v)"
            >
              ✎
            </button>
            <button
              class="pv-act"
              data-pv-action="reset"
              title="重置布局（笔记与名称保留）"
              @click.stop="askReset(v)"
            >
              ↺
            </button>
          </span>
        </div>
      </div>
    </div>

    <ConfirmModal
      :visible="pendingReset !== null"
      title="重置平行视图布局"
      :message="`将把「${pendingReset ? displayName(pendingReset) : ''}」恢复为默认的一笔记布局；笔记内容和自定义名称都会保留。`"
      confirm-text="重置布局"
      @confirm="confirmReset"
      @cancel="pendingReset = null"
    />
  </div>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.pv-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 14px 8px;
  flex-shrink: 0;
}

.pv-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
}

.pv-new {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}

.pv-new:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

/* 搜索：与笔记面板同一配方 */
.pv-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 14px 10px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel-2);
  color: var(--lb-muted);
  flex-shrink: 0;
}

.pv-search:focus-within {
  border-color: var(--lb-accent-ring);
  box-shadow: 0 0 0 3px var(--lb-accent-soft);
}

.pv-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--lb-text);
  font-size: 12px;
  outline: none;
}

.pv-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 14px;
}

.pv-empty {
  padding: 26px 12px;
  text-align: center;
  font-size: 12px;
  line-height: 1.8;
  color: var(--lb-muted);
}

.pv-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

/* 文件卡片：图标 + 名称 + 摘要，和笔记卡片同一套观感 */
.pv-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 12px 10px 10px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.15s ease;
}

.pv-card:hover {
  border-color: var(--lb-accent-2);
  box-shadow: var(--lb-shadow-1);
  transform: translateY(-1px);
}

.pv-card.on {
  border-color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.pv-icon {
  width: 30px;
  height: 30px;
  color: var(--lb-accent);
  flex-shrink: 0;
}

.pv-icon svg {
  width: 100%;
  height: 100%;
}

.pv-main {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pv-name {
  width: 100%;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--lb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pv-card.on .pv-name {
  color: var(--lb-accent);
}

.pv-sub,
.pv-date {
  font-size: 11px;
  color: var(--lb-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pv-date {
  font-size: 10.5px;
  opacity: 0.8;
}

.pv-rename {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--lb-accent-2);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
  outline: none;
}

.pv-acts {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 2px;
  opacity: 0;
}

.pv-card:hover .pv-acts,
.pv-card.on .pv-acts {
  opacity: 1;
}

.pv-act {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-muted);
  font-size: 11px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.pv-act:hover {
  color: var(--lb-accent);
  background: var(--lb-chip);
}
</style>
