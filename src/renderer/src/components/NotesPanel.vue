<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ImportOutlineDialog from './ImportOutlineDialog.vue'
import type { NoteGroupRow, OutlineListRow, StarredArticleRow } from '@shared/types'

/**
 * 笔记浮层面板：搜索 + 自定义分类（配方照抄文档库分类文件夹）+ 笔记列表 + 星标入口。
 * 分类增删改/排序直接走 IPC 后 emit groups-changed（同 DocLibrary 模式）；
 * 星标条目点击直达文档库阅读（App 负责打开；本面板只报 id）。
 */
const emit = defineEmits<{
  (e: 'open', id: number): void
  (e: 'create', groupId: number | null): void
  (e: 'openStarred', payload: { documentId: number; orderIndex: number }): void
  (e: 'error', err: unknown): void
  /** 分类增删改/排序后父级刷新（计数与列表都要重取） */
  (e: 'groups-changed'): void
  /** 导入成功后父级刷新笔记列表 */
  (e: 'imported'): void
}>()

const props = defineProps<{
  /** 由父级维护的列表（打开/新建/改名后刷新） */
  notes: OutlineListRow[]
  activeId: number | null
  /** 笔记自建分类（App 维护） */
  noteGroups: NoteGroupRow[]
}>()

const keyword = ref('')
const starred = ref<StarredArticleRow[]>([])
const starredOpen = ref(false)
/** 通用大纲导入对话框（阶段3） */
const importOpen = ref(false)

// ---------- 分类（groupFilter：undefined=全部 / null=未分类 / id=该分类） ----------
const groupFilter = ref<number | null | undefined>(undefined)
const creating = ref(false)
const createName = ref('')
const renamingId = ref<number | null>(null)
const renameName = ref('')

const inGroup = computed<OutlineListRow[]>(() => {
  const list =
    groupFilter.value === undefined
      ? props.notes
      : groupFilter.value === null
        ? props.notes.filter((n) => n.group_id === null)
        : props.notes.filter((n) => n.group_id === groupFilter.value)
  const kw = keyword.value.trim()
  // 列表本就不大，客户端过滤免一次 IPC 往返
  return kw ? list.filter((n) => n.title.includes(kw)) : list
})

const uncategorizedCount = computed(() => props.notes.filter((n) => n.group_id === null).length)

async function confirmCreate(): Promise<void> {
  const name = createName.value.trim()
  creating.value = false
  createName.value = ''
  if (!name) return
  try {
    const g = await window.lexbench.noteGroups.create(name)
    groupFilter.value = g.id
    emit('groups-changed')
  } catch (e) {
    emit('error', e)
  }
}

function startRename(g: NoteGroupRow): void {
  renamingId.value = g.id
  renameName.value = g.name
}

async function confirmRename(g: NoteGroupRow): Promise<void> {
  renamingId.value = null
  const name = renameName.value.trim()
  if (!name || name === g.name) return
  try {
    await window.lexbench.noteGroups.rename(g.id, name)
    emit('groups-changed')
  } catch (e) {
    emit('error', e)
  }
}

async function removeGroup(g: NoteGroupRow): Promise<void> {
  try {
    await window.lexbench.noteGroups.remove(g.id)
    if (groupFilter.value === g.id) groupFilter.value = undefined
    emit('groups-changed')
  } catch (e) {
    emit('error', e)
  }
}

// 拖动排序（配方同 DocLibrary 分类拖动）
const draggingGroupId = ref<number | null>(null)
const dragOverId = ref<number | null>(null)
const dragOverAfter = ref(false)

function onGroupDragStart(g: NoteGroupRow, e: DragEvent): void {
  draggingGroupId.value = g.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(g.id))
  }
}

function onGroupDragOver(g: NoteGroupRow, e: DragEvent): void {
  if (draggingGroupId.value === null || draggingGroupId.value === g.id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dragOverId.value = g.id
  dragOverAfter.value = e.clientY > rect.top + rect.height / 2
}

function onGroupDragEnd(): void {
  draggingGroupId.value = null
  dragOverId.value = null
  dragOverAfter.value = false
}

async function onGroupDrop(target: NoteGroupRow): Promise<void> {
  const dragged = draggingGroupId.value
  const after = dragOverAfter.value
  onGroupDragEnd()
  if (dragged === null || dragged === target.id) return
  const ids = props.noteGroups.map((g) => g.id)
  const from = ids.indexOf(dragged)
  if (from < 0) return
  ids.splice(from, 1)
  const targetIdx = ids.indexOf(target.id)
  ids.splice(after ? targetIdx + 1 : targetIdx, 0, dragged)
  try {
    await window.lexbench.noteGroups.reorder(ids)
    emit('groups-changed')
  } catch (e) {
    emit('error', e)
  }
}

async function refreshStarred(): Promise<void> {
  try {
    starred.value = await window.lexbench.outlines.listStarred()
  } catch (e) {
    // 星标只是入口，失败不打扰主流程
    console.error(e)
  }
}

onMounted(() => {
  void refreshStarred()
})

defineExpose({ refreshStarred })
</script>

<template>
  <div class="np">
    <div class="np-head">
      <span class="np-title">笔记</span>
      <span class="np-head-acts">
        <button class="np-import" title="从导出文件导入大纲笔记（OPML / HTML / Markdown）" @click="importOpen = true">
          导入
        </button>
        <button class="np-new" title="新建笔记（落在当前分类）" @click="$emit('create', groupFilter ?? null)">
          ＋
        </button>
      </span>
    </div>

    <ImportOutlineDialog
      v-model:visible="importOpen"
      @error="$emit('error', $event)"
      @imported="$emit('imported')"
    />

    <div class="np-search">
      <input v-model="keyword" class="np-search-input" type="text" placeholder="搜索笔记" />
    </div>

    <!-- 自定义分类（配方照抄文档库分类文件夹） -->
    <div class="np-groups">
      <button
        class="gr"
        :class="{ on: groupFilter === undefined }"
        @click="groupFilter = undefined"
      >
        <span class="gr-name">全部笔记</span>
        <span class="gr-count">{{ notes.length }}</span>
      </button>
      <button class="gr" :class="{ on: groupFilter === null }" @click="groupFilter = null">
        <span class="gr-name">未分类</span>
        <span class="gr-count">{{ uncategorizedCount }}</span>
      </button>

      <template v-for="g in noteGroups" :key="g.id">
        <input
          v-if="renamingId === g.id"
          :ref="(el) => { if (el) (el as HTMLInputElement).focus() }"
          v-model="renameName"
          class="gr-input"
          type="text"
          @click.stop
          @keydown.enter.stop.prevent="confirmRename(g)"
          @keydown.esc.stop="renamingId = null"
          @blur="renamingId = null"
        />
        <button
          v-else
          class="gr"
          draggable="true"
          :class="{
            on: groupFilter === g.id,
            dragging: draggingGroupId === g.id,
            'drop-before': dragOverId === g.id && !dragOverAfter,
            'drop-after': dragOverId === g.id && dragOverAfter
          }"
          :title="g.name"
          @click="groupFilter = g.id"
          @dragstart="onGroupDragStart(g, $event)"
          @dragover="onGroupDragOver(g, $event)"
          @drop.prevent="onGroupDrop(g)"
          @dragend="onGroupDragEnd"
        >
          <span class="gr-name">{{ g.name }}</span>
          <span v-if="groupFilter !== g.id" class="gr-count">{{ g.note_count }}</span>
          <span v-else class="gr-acts" @click.stop>
            <span class="gr-act" title="重命名" @click="startRename(g)">✎</span>
            <span class="gr-act" title="删除分类（笔记归未分类）" @click="removeGroup(g)">✕</span>
          </span>
        </button>
      </template>

      <input
        v-if="creating"
        :ref="(el) => { if (el) (el as HTMLInputElement).focus() }"
        v-model="createName"
        class="gr-input"
        type="text"
        placeholder="新分类名"
        @click.stop
        @keydown.enter.stop.prevent="confirmCreate"
        @keydown.esc.stop="creating = false"
        @blur="creating = false"
      />
      <button v-else class="gr gr-new" @click="creating = true">＋ 新建分类</button>
    </div>

    <div class="np-list">
      <p v-if="notes.length === 0" class="np-empty">还没有笔记，点右上角 ＋ 新建</p>
      <p v-else-if="inGroup.length === 0" class="np-empty">
        {{ keyword.trim() ? `没有匹配「${keyword.trim()}」的笔记` : '该分类下暂无笔记' }}
      </p>
      <button
        v-for="n in inGroup"
        :key="n.id"
        class="np-item"
        :class="{ on: n.id === activeId }"
        :title="n.title"
        @click="$emit('open', n.id)"
      >
        <span class="np-item-dot" aria-hidden="true">●</span>
        <span class="np-item-title">{{ n.title }}</span>
        <span class="np-item-date">{{ n.updated_at.slice(5, 10) }}</span>
      </button>
    </div>

    <!-- 星标法条入口：轻量临时收集，点击直达阅读 -->
    <div class="np-starred">
      <button class="np-star-toggle" :class="{ open: starredOpen }" @click="starredOpen = !starredOpen">
        <span class="np-star-mark" aria-hidden="true">☆</span>
        <span class="np-star-label">星标法条</span>
        <span v-if="starred.length > 0" class="np-star-count">{{ starred.length }}</span>
      </button>
      <div v-if="starredOpen && starred.length > 0" class="np-star-list">
        <button
          v-for="s in starred"
          :key="s.article_id"
          class="np-star-item"
          :title="`${s.doc_title} · ${s.article_label}`"
          @click="$emit('openStarred', { documentId: s.document_id, orderIndex: s.order_index })"
        >
          <span class="nsi-label">{{ s.article_label }}</span>
          <span class="nsi-doc">{{ s.doc_title }}</span>
        </button>
      </div>
      <p v-if="starredOpen && starred.length === 0" class="np-star-empty">阅读时点亮法条旁的 ☆ 即可收藏到这里</p>
    </div>
  </div>
</template>

<style scoped>
.np {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 10px 8px 8px;
}

/* ---------- 头部：标题 + 新建 ---------- */
.np-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 6px 8px 10px;
  flex-shrink: 0;
}

.np-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--lb-text);
}

.np-head-acts {
  display: flex;
  align-items: center;
  gap: 6px;
}

.np-import {
  padding: 4px 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  font-size: 12px;
  color: var(--lb-text);
}

.np-import:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.np-new {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: var(--lb-chip);
  color: var(--lb-text);
  font-size: 15px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.np-new:hover {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
}

/* ---------- 搜索框（配方同 .search-group:focus-within 的简化版） ---------- */
.np-search {
  flex-shrink: 0;
  padding: 0 2px 10px;
}

.np-search-input {
  width: 100%;
  padding: 7px 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  font-size: 13px;
  color: var(--lb-text);
  transition:
    border-color 0.25s ease,
    box-shadow 0.25s ease;
}

.np-search-input::placeholder {
  color: var(--lb-muted);
}

.np-search-input:focus {
  outline: none;
  border-color: rgba(0, 113, 227, 0.55);
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
}

/* ---------- 分类（配方照抄 DocLibrary .group-row） ---------- */
.np-groups {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--lb-border);
}

.gr {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px 6px 12px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: transparent;
  color: var(--lb-text);
  font-size: 13px;
  text-align: left;
  cursor: grab;
}

.gr:hover {
  background: #f0f0f6;
}

.gr.on {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-weight: 600;
}

.gr.dragging {
  opacity: 0.45;
}

.gr.drop-before {
  box-shadow: inset 0 2px 0 var(--lb-accent);
}

.gr.drop-after {
  box-shadow: inset 0 -2px 0 var(--lb-accent);
}

.gr-new {
  padding-left: 12px;
  color: var(--lb-muted);
  font-size: 12px;
}

.gr-new:hover {
  color: var(--lb-accent);
}

.gr-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gr-count {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 400;
  color: var(--lb-muted);
}

.gr-acts {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
}

.gr-act {
  font-size: 11px;
  color: var(--lb-muted);
  padding: 2px 4px;
  border-radius: var(--lb-radius-micro);
}

.gr-act:hover {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.gr-input {
  width: 100%;
  padding: 5px 10px;
  border: 1px solid rgba(0, 113, 227, 0.55);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  font-size: 13px;
  color: var(--lb-text);
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
}

.gr-input:focus {
  outline: none;
}

/* ---------- 笔记列表 ---------- */
.np-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 8px;
  padding-bottom: 8px;
}

.np-empty {
  padding: 20px 10px;
  font-size: 12px;
  color: var(--lb-muted);
  text-align: center;
  line-height: 1.6;
}

.np-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: transparent;
  color: var(--lb-text);
  font-size: 13px;
  text-align: left;
}

.np-item:hover {
  background: #f0f0f6;
}

.np-item.on {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-weight: 600;
}

.np-item-dot {
  flex-shrink: 0;
  font-size: 7px;
  color: rgba(0, 0, 0, 0.25);
}

.np-item.on .np-item-dot {
  color: var(--lb-accent);
}

.np-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.np-item-date {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--lb-muted);
  font-weight: 400;
}

/* ---------- 星标法条入口 ---------- */
.np-starred {
  flex-shrink: 0;
  border-top: 1px solid var(--lb-border);
  padding-top: 6px;
}

.np-star-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: transparent;
  color: var(--lb-text);
  font-size: 13px;
  text-align: left;
}

.np-star-toggle:hover {
  background: #f0f0f6;
}

.np-star-mark {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--lb-warn-fg);
}

.np-star-label {
  flex: 1;
}

.np-star-count {
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--lb-radius-full);
  background: var(--lb-chip);
  font-size: 11px;
  text-align: center;
}

.np-star-list {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0 4px;
}

.np-star-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 5px 10px 5px 32px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: transparent;
  text-align: left;
  font-size: 12px;
}

.np-star-item:hover {
  background: #f0f0f6;
}

.nsi-label {
  flex-shrink: 0;
  color: var(--lb-text);
  font-family: var(--lb-serif);
}

.nsi-doc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--lb-muted);
  font-size: 11px;
}

.np-star-empty {
  padding: 6px 10px 8px 32px;
  font-size: 11px;
  color: var(--lb-muted);
}
</style>
