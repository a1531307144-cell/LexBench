<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmModal from './ConfirmModal.vue'
import type { DocGroupRow, DocumentRow, DocType } from '@shared/types'

const props = defineProps<{ documents: DocumentRow[]; groups: DocGroupRow[] }>()

const emit = defineEmits<{
  open: [id: number]
  /** 删除走 App 的 ConfirmModal（不使用原生 confirm） */
  remove: [doc: DocumentRow]
  /** 一键标记已复查（needs_review → parsed） */
  'mark-reviewed': [id: number]
  /** 分类文件夹增删改 / 文档改归属后：App 据此重取分组与文档 */
  'groups-changed': []
  /** 拖动排序后：App 据此重取文档列表（新的 sort_order 在库里） */
  'docs-changed': []
  error: [message: string]
}>()

const typeNames: Record<string, string> = {
  statute: '法规',
  case: '案例',
  book: '书籍',
  other: '资料'
}

/** 类型分类过滤：全部 / 法规 / 案例 / 书籍 / 资料（与导入时可选类型一致） */
type Filter = 'all' | DocType
const typeFilter = ref<Filter>('all')

/** 分类文件夹筛选：'all'=该类型下不筛文件夹，number=只看该文件夹 */
const groupFilter = ref<'all' | number>('all')

const TYPE_ORDER: DocType[] = ['statute', 'case', 'book', 'other']

/** 各类型计数（0 计数的分类不出现在过滤条里） */
const counts = computed(() => {
  const c: Record<string, number> = {}
  for (const d of props.documents) c[d.doc_type] = (c[d.doc_type] ?? 0) + 1
  return c
})

const filters = computed(() => {
  const list: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: props.documents.length }
  ]
  for (const t of TYPE_ORDER) {
    const n = counts.value[t] ?? 0
    if (n > 0) list.push({ key: t, label: typeNames[t], count: n })
  }
  return list
})

/** 当前类型下的文档（typeFilter=all 即全部） */
const typeDocs = computed(() =>
  typeFilter.value === 'all'
    ? props.documents
    : props.documents.filter((d) => d.doc_type === typeFilter.value)
)

const filtered = computed(() =>
  groupFilter.value === 'all'
    ? typeDocs.value
    : typeDocs.value.filter((d) => d.group_id === groupFilter.value)
)

// ---------- 分类文件夹：筛选 / 新建 / 改名 / 删除 ----------

/** 分类行：仅具体类型 + 该类型下有文档时出现（含只有「未分类」文档、尚无任何文件夹的情形） */
const showGroupBar = computed(() => typeFilter.value !== 'all' && typeDocs.value.length > 0)

/** 当前类型下的分类文件夹（与本组件展示的类型严格对应） */
const typeGroups = computed(() =>
  typeFilter.value === 'all' ? [] : props.groups.filter((g) => g.doc_type === typeFilter.value)
)

/** 正在内联新建（输入框） */
const creating = ref(false)
const createName = ref('')
/** 正在内联改名的文件夹 id */
const renamingId = ref<number | null>(null)
const renameName = ref('')
/** 待确认删除的文件夹（走 ConfirmModal） */
const pendingGroupDelete = ref<DocGroupRow | null>(null)
/** 正在为该文档选择文件夹（行内 select） */
const moveDocId = ref<number | null>(null)

const groupDeleteMessage = computed(() =>
  pendingGroupDelete.value
    ? `删除分类「${pendingGroupDelete.value.name}」？其中 ${pendingGroupDelete.value.doc_count} 篇文档将移入「未分类」，不会删除文档。`
    : ''
)

/** 点击文件夹行的 ✕：填入待删除目标，弹出确认框（此前缺失该函数导致删除入口无响应） */
function askRemoveGroup(g: DocGroupRow): void {
  pendingGroupDelete.value = g
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

/** 内联输入框出现后立即取焦（函数 ref） */
function focusOn(el: unknown): void {
  if (el instanceof HTMLInputElement) void nextTick(() => el.focus())
}

/** 收起所有内联编辑器（切换类型 / 打开另一个编辑器时调用，避免多个输入框并存） */
function cancelEditors(): void {
  creating.value = false
  createName.value = ''
  renamingId.value = null
  renameName.value = ''
  moveDocId.value = null
}

// 切换类型：文件夹筛选与内联编辑器都要归位（不同类型各有各的文件夹）
watch(typeFilter, () => {
  groupFilter.value = 'all'
  cancelEditors()
})

function startCreate(): void {
  cancelEditors()
  createName.value = ''
  creating.value = true
}

async function confirmCreate(): Promise<void> {
  if (typeFilter.value === 'all') return
  const name = createName.value.trim()
  creating.value = false
  if (!name) return // 空名不发请求（主进程也会拒绝）
  try {
    const g = await window.lexbench.groups.create(typeFilter.value, name)
    createName.value = ''
    groupFilter.value = g.id // 新建后自动选中
    emit('groups-changed')
  } catch (e) {
    emit('error', errText(e))
  }
}

function startRename(g: DocGroupRow): void {
  cancelEditors()
  renameName.value = g.name
  renamingId.value = g.id
}

async function confirmRename(g: DocGroupRow): Promise<void> {
  const name = renameName.value.trim()
  renamingId.value = null
  if (!name || name === g.name) return
  try {
    await window.lexbench.groups.rename(g.id, name)
    emit('groups-changed')
  } catch (e) {
    emit('error', errText(e))
  }
}

async function confirmRemoveGroup(): Promise<void> {
  const g = pendingGroupDelete.value
  if (!g) return
  try {
    await window.lexbench.groups.remove(g.id)
    if (groupFilter.value === g.id) groupFilter.value = 'all'
    emit('groups-changed')
  } catch (e) {
    emit('error', errText(e))
  } finally {
    pendingGroupDelete.value = null
  }
}

/** 该文档类型下的全部分组（移动菜单用） */
function groupsOfType(t: DocType): DocGroupRow[] {
  return props.groups.filter((g) => g.doc_type === t)
}

function onMoveChange(d: DocumentRow, e: Event): void {
  void moveDoc(d, (e.target as HTMLSelectElement).value)
}

// ---------- 文件夹拖动排序 ----------

const draggingGroupId = ref<number | null>(null)
const dragOverId = ref<number | null>(null)
const dragOverAfter = ref(false)

// ---------- 文档拖动排序（同一套手感，作用在右侧的文档卡片上）----------
const draggingDocId = ref<number | null>(null)
const dragOverDocId = ref<number | null>(null)
const dragOverDocAfter = ref(false)

function onDocDragStart(d: DocumentRow, e: DragEvent): void {
  draggingDocId.value = d.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(d.id))
  }
}

function onDocDragOver(d: DocumentRow, e: DragEvent): void {
  if (draggingDocId.value === null || draggingDocId.value === d.id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverDocId.value = d.id
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dragOverDocAfter.value = e.clientY > rect.top + rect.height / 2
}

function onDocDragEnd(): void {
  draggingDocId.value = null
  dragOverDocId.value = null
  dragOverDocAfter.value = false
}

/** 放下：把被拖的文档插到目标卡片前/后，按本文件夹内的新顺序整体重排 */
async function onDocDrop(d: DocumentRow): Promise<void> {
  const dragged = draggingDocId.value
  const after = dragOverDocAfter.value
  onDocDragEnd()
  if (dragged === null || dragged === d.id) return
  const before = filtered.value.map((x) => x.id)
  const ids = [...before]
  const from = ids.indexOf(dragged)
  if (from < 0) return
  ids.splice(from, 1)
  const targetIdx = ids.indexOf(d.id)
  if (targetIdx < 0) return
  ids.splice(after ? targetIdx + 1 : targetIdx, 0, dragged)
  if (ids.join(',') === before.join(',')) return
  try {
    await window.lexbench.library.reorder(ids)
    emit('docs-changed')
  } catch (e) {
    emit('error', errText(e))
  }
}

function onGroupDragStart(g: DocGroupRow, e: DragEvent): void {
  draggingGroupId.value = g.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(g.id))
  }
}

function onGroupDragOver(g: DocGroupRow, e: DragEvent): void {
  if (draggingGroupId.value === null || draggingGroupId.value === g.id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverId.value = g.id
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dragOverAfter.value = e.clientY > rect.top + rect.height / 2
}

function onGroupDragEnd(): void {
  draggingGroupId.value = null
  dragOverId.value = null
  dragOverAfter.value = false
}

/** 放下：把被拖的文件夹插到目标行的前/后，按新顺序整体重排 */
async function onGroupDrop(g: DocGroupRow): Promise<void> {
  const dragged = draggingGroupId.value
  const after = dragOverAfter.value
  onGroupDragEnd()
  if (dragged === null || dragged === g.id) return
  const before = typeGroups.value.map((x) => x.id)
  const ids = [...before]
  const from = ids.indexOf(dragged)
  if (from < 0) return
  ids.splice(from, 1)
  const targetIdx = ids.indexOf(g.id)
  if (targetIdx < 0) return
  ids.splice(after ? targetIdx + 1 : targetIdx, 0, dragged)
  if (ids.join(',') === before.join(',')) return
  try {
    await window.lexbench.groups.reorder(ids)
    emit('groups-changed')
  } catch (e) {
    emit('error', errText(e))
  }
}

/**
 * 「移动到…」下拉的收起：点页面其它任何地方、或按 Esc 都应关闭。
 * 此前只有「再点一次 ⇄ / 选一项 / 切类型」才会关，而文档库是 v-show（切视图不卸载），
 * 于是下拉会一直常驻在列表里。
 */
function onDocMouseDown(e: MouseEvent): void {
  if (moveDocId.value === null) return
  const t = e.target as HTMLElement | null
  if (t?.closest('.move-select') || t?.closest('.move-btn')) return
  moveDocId.value = null
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && moveDocId.value !== null) moveDocId.value = null
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('keydown', onDocKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('keydown', onDocKeydown)
})

/** 移动文档到文件夹：'none'=移出，''=未选择（占位项，忽略），其余为分组 id */
async function moveDoc(d: DocumentRow, value: string): Promise<void> {
  moveDocId.value = null
  if (value === '') return
  const gid = value === 'none' ? null : Number(value)
  if (gid !== null && Number.isNaN(gid)) return
  if (gid === d.group_id) return
  try {
    await window.lexbench.library.setDocumentGroup(d.id, gid)
    emit('groups-changed')
  } catch (e) {
    emit('error', errText(e))
  }
}
</script>

<template>
  <div class="library">
    <div v-if="documents.length === 0" class="empty">
      <p class="empty-title">还没有导入任何文档</p>
      <p class="empty-line">点击右上角「导入文档」，或把 docx / pdf / txt 拖进窗口</p>
    </div>

    <!-- 类型过滤条（横跨两列） -->
    <div v-if="documents.length > 0" class="filter-row">
      <button
        v-for="f in filters"
        :key="f.key"
        class="filter-chip"
        :class="{ on: typeFilter === f.key }"
        :data-type="f.key"
        @click="typeFilter = f.key"
      >
        {{ f.label }}<span class="filter-count">{{ f.count }}</span>
      </button>
    </div>

    <!-- 左：分类文件夹列 ｜ 右：该文件夹下的文件 -->
    <div v-if="documents.length > 0" class="lib-split">
      <div class="folder-col">
        <button
          class="group-row"
          :class="{ on: groupFilter === 'all' }"
          @click="groupFilter = 'all'"
        >
          <span class="gr-name">全部</span>
          <span class="gr-count">{{ typeDocs.length }}</span>
        </button>

        <template v-for="g in typeGroups" :key="g.id">
          <input
            v-if="renamingId === g.id"
            :ref="focusOn"
            v-model="renameName"
            class="group-input"
            type="text"
            @click.stop
            @keydown.enter.stop.prevent="confirmRename(g)"
            @keydown.esc.stop="renamingId = null"
            @blur="renamingId = null"
          />
          <button
            v-else
            class="group-row"
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
            <span v-if="groupFilter !== g.id" class="gr-count">{{ g.doc_count }}</span>
            <span v-else class="chip-acts" @click.stop>
              <span class="chip-act" title="重命名" @click="startRename(g)">✎</span>
              <span class="chip-act" title="删除分类" @click="askRemoveGroup(g)">✕</span>
            </span>
          </button>
        </template>

        <input
          v-if="creating"
          :ref="focusOn"
          v-model="createName"
          class="group-input"
          type="text"
          placeholder="新文件夹名"
          @click.stop
          @keydown.enter.stop.prevent="confirmCreate"
          @keydown.esc.stop="creating = false"
          @blur="creating = false"
        />
        <button v-else class="group-row new-row" @click="startCreate">＋ 新建</button>
      </div>

      <div class="doc-col">
        <p v-if="filtered.length === 0" class="doc-empty">该文件夹下暂无文档</p>

        <div
          v-for="d in filtered"
          :key="d.id"
          class="doc-card"
          draggable="true"
          :class="{
            'drop-before': dragOverDocId === d.id && !dragOverDocAfter,
            'drop-after': dragOverDocId === d.id && dragOverDocAfter
          }"
          @click="$emit('open', d.id)"
          @dragstart="onDocDragStart(d, $event)"
          @dragover="onDocDragOver(d, $event)"
          @drop.prevent="onDocDrop(d)"
          @dragend="onDocDragEnd"
        >
          <div class="doc-title">
            {{ d.title }}
            <span v-if="d.status === 'needs_review'" class="warn-chip">需复查</span>
          </div>
          <div class="doc-meta">
            <span class="type-chip" :data-type="d.doc_type">{{ typeNames[d.doc_type] || d.doc_type }}</span>
            <span v-if="d.doc_type === 'statute'" class="meta-item">{{ d.article_count }} 条</span>
            <span class="meta-item">{{ d.imported_at?.slice(0, 10) }}</span>
          </div>
          <div class="doc-acts" @click.stop>
            <button
              v-if="d.status === 'needs_review'"
              class="review-btn"
              title="解析确认无误？点击标记为已复查"
              @click="$emit('mark-reviewed', d.id)"
            >
              标记已复查
            </button>
            <span class="acts-space"></span>
            <button
              class="move-btn"
              title="移动到分类文件夹"
              @click="cancelEditors(); moveDocId = moveDocId === d.id ? null : d.id"
            >
              ⇄
            </button>
            <button class="del-btn" title="删除" @click="$emit('remove', d)">✕</button>
          </div>
          <select
            v-if="moveDocId === d.id"
            class="move-select"
            :value="''"
            @click.stop
            @mousedown.stop
            @change="onMoveChange(d, $event)"
          >
            <option value="">移动到…</option>
            <option value="none">移出文件夹</option>
            <option v-for="g in groupsOfType(d.doc_type)" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </div>
      </div>
    </div>

    <ConfirmModal
      :visible="pendingGroupDelete !== null"
      title="删除分类"
      :message="groupDeleteMessage"
      danger
      confirm-text="删除"
      @confirm="confirmRemoveGroup"
      @cancel="pendingGroupDelete = null"
    />
  </div>
</template>

<style scoped>
.library {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 12px 10px 0 12px;
}

.empty {
  padding: 48px 20px;
  text-align: center;
  color: var(--lb-muted);
}

/* ---------- 类型过滤条（横跨两列，不滚动） ---------- */
.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 10px;
  flex-shrink: 0;
}

/* ---------- 左：分类文件夹列 ｜ 右：该文件夹下的文件 ---------- */
.lib-split {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 8px;
}

.folder-col {
  flex: 0 0 104px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-bottom: 10px;
}

.doc-col {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 2px;
  padding-bottom: 12px;
}

.doc-empty {
  margin: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--lb-muted);
}

/* 分类文件夹：竖排列表，不加外框（一行一个，向下堆叠） */
.group-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 0 2px;
}

.group-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px 6px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--lb-text);
  font-size: 13px;
  text-align: left;
  cursor: grab;
}

/* 拖动排序：被拖行半透明，目标行上/下沿显示插入位置 */
.group-row.dragging {
  opacity: 0.45;
}

.group-row.drop-before {
  box-shadow: inset 0 2px 0 var(--lb-accent);
}

.group-row.drop-after {
  box-shadow: inset 0 -2px 0 var(--lb-accent);
}

.group-row:hover {
  background: #f0f0f6;
}

.group-row.on {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-weight: 600;
}

.group-row.new-row {
  padding-left: 12px;
  color: var(--lb-muted);
  font-size: 12px;
}

.group-row.new-row:hover {
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
  color: var(--lb-muted);
  font-weight: 400;
}

.chip-acts {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 3px;
}

.chip-act {
  font-size: 11px;
  line-height: 1;
  padding: 1px 2px;
  border-radius: 4px;
  opacity: 0.7;
}

.chip-act:hover {
  opacity: 1;
  background: rgba(156, 52, 40, 0.14);
}


/* 内联新建 / 改名输入框（竖排列表里占满一行） */
.group-input {
  width: 100%;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--lb-accent-2);
  border-radius: 6px;
  background: #fff;
  color: var(--lb-text);
  font-size: 13px;
  outline: none;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid var(--lb-border);
  border-radius: 999px;
  background: #fff;
  color: var(--lb-muted);
  font-size: 12px;
}

.filter-chip:hover {
  border-color: var(--lb-accent-2, #0077ed);
  color: var(--lb-text);
}

.filter-chip.on {
  border-color: var(--lb-accent);
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-weight: 600;
}

.filter-count {
  font-size: 11px;
  opacity: 0.75;
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

/* 文件卡片（窄列：标题两行截断 + 一行元信息 + 一行操作） */
.doc-card {
  padding: 8px 9px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  cursor: pointer;
  background: var(--lb-panel);
}

/* 悬停上浮 + 渐次进入（Apple 手感） */
@media (prefers-reduced-motion: no-preference) {
  .doc-card {
    transition:
      border-color 0.12s ease,
      transform 0.12s ease,
      box-shadow 0.12s ease;
    animation: lb-doc-in 0.16s ease both;
  }

  .doc-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.07);
  }

  .doc-card:nth-child(1) { animation-delay: 0ms; }
  .doc-card:nth-child(2) { animation-delay: 30ms; }
  .doc-card:nth-child(3) { animation-delay: 60ms; }
  .doc-card:nth-child(4) { animation-delay: 90ms; }
  .doc-card:nth-child(5) { animation-delay: 120ms; }
  .doc-card:nth-child(6) { animation-delay: 150ms; }
  .doc-card:nth-child(7) { animation-delay: 180ms; }
  .doc-card:nth-child(8) { animation-delay: 210ms; }
}

@keyframes lb-doc-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 拖动排序时的插入位置指示（与左侧文件夹同一套视觉） */
.doc-card.drop-before {
  box-shadow: inset 0 2px 0 var(--lb-accent);
}

.doc-card.drop-after {
  box-shadow: inset 0 -2px 0 var(--lb-accent);
}

.doc-card:hover {
  border-color: var(--lb-accent-2);
}

.doc-title {
  font-weight: 600;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--lb-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.doc-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--lb-muted);
}

.doc-acts {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
}

.acts-space {
  flex: 1;
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

.move-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--lb-muted);
  font-size: 13px;
}

.move-btn:hover {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
}

.move-select {
  flex-shrink: 0;
  max-width: 118px;
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--lb-accent-2);
  border-radius: 6px;
  background: #fff;
  color: var(--lb-text);
  font-size: 12px;
  outline: none;
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
