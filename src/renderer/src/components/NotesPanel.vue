<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ImportOutlineDialog from './ImportOutlineDialog.vue'
import { flattenFolders, isSelfOrDescendant as isSelfOrAncestor, nextUntitledName } from '@shared/noteFolders'
import type { NoteGroupRow, OutlineListRow, StarredArticleRow } from '@shared/types'

/**
 * 笔记浮层面板（Finder 式图形文件夹）：
 * - 根层「我的笔记」以图标网格罗列子文件夹 + 直属笔记；点文件夹进入（返回 + 面包屑），支持嵌套。
 * - 搜索非空时切回扁平结果列表（标题命中即时算，正文命中等 IPC 摘录回填）。
 * - 文件夹/笔记均可拖拽改归属（落点：文件夹卡片 / 面包屑某段 / 网格空白）。
 * - 内联新建/重命名占一个卡片位，**失焦即提交**，空名默认「未命名文件夹」（同级重名自动加序号）。
 * - 文件夹增删改与归类直接走 IPC 后 emit groups-changed（同 DocLibrary 模式）。
 */
const emit = defineEmits<{
  (e: 'open', id: number): void
  (e: 'create', groupId: number | null): void
  /** 卡片右键删除：App 走与编辑器「⋯→删除笔记」同一套确认弹窗 */
  (e: 'remove', note: { id: number; title: string }): void
  (e: 'openStarred', payload: { documentId: number; orderIndex: number }): void
  (e: 'error', err: unknown): void
  /** 文件夹增删改/移动/重排后父级刷新（计数与列表都要重取） */
  (e: 'groups-changed'): void
  /** 笔记列表需要重取（导入成功、笔记被移动/改名后） */
  (e: 'imported'): void
}>()

const props = defineProps<{
  /** 由父级维护的列表（打开/新建/改名后刷新） */
  notes: OutlineListRow[]
  activeId: number | null
  /** 笔记自建分类（App 维护）；parent_id 非空表示嵌套在父文件夹内 */
  noteGroups: NoteGroupRow[]
}>()

const panelEl = ref<HTMLElement | null>(null)

// ---------- 搜索：标题本地命中 + 正文 IPC 摘录回填 ----------

const keyword = ref('')
/** 正文命中：id → 命中段落摘录。标题命中本地即时算；正文命中等 IPC 结果回填（列表本就不大） */
const contentHits = ref<Map<number, string>>(new Map())
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchSeq = 0

watch(keyword, (kw) => {
  clearTimeout(searchTimer)
  const seq = ++searchSeq
  const k = kw.trim()
  if (!k) {
    contentHits.value = new Map()
    return
  }
  searchTimer = setTimeout(async () => {
    try {
      const rows = await window.lexbench.outlines.list(k)
      if (seq !== searchSeq) return // 过期结果丢弃，避免旧关键词盖新关键词
      const m = new Map<number, string>()
      for (const r of rows) m.set(r.id, r.snippet ?? '')
      contentHits.value = m
    } catch (e) {
      emit('error', e)
    }
  }, 180)
})

const searching = computed(() => keyword.value.trim() !== '')

/** 搜索结果：跨文件夹扁平罗列（Finder 的搜索也是独立结果视图） */
const results = computed<OutlineListRow[]>(() => {
  const kw = keyword.value.trim()
  if (!kw) return []
  return props.notes.filter((n) => n.title.includes(kw) || contentHits.value.has(n.id))
})

/** 结果行下的正文命中摘录：标题已命中时不用重复解释 */
function snippetFor(n: OutlineListRow): string | null {
  const kw = keyword.value.trim()
  if (!kw || n.title.includes(kw)) return null
  return contentHits.value.get(n.id) ?? null
}

// ---------- 文件夹导航（面包屑栈；空数组 = 根层） ----------

/** 从根到当前文件夹的 id 栈 */
const path = ref<number[]>([])
const currentId = computed<number | null>(() =>
  path.value.length > 0 ? path.value[path.value.length - 1]! : null
)

const folderById = computed(() => new Map(props.noteGroups.map((g) => [g.id, g])))

/** 面包屑（根「我的笔记」由模板单独渲染；这里是从上到下的各级文件夹） */
const crumbs = computed(() =>
  path.value.map((id) => folderById.value.get(id)).filter((g): g is NoteGroupRow => !!g)
)

/** 祖先超过 3 层时折叠中间层级：首位 › … › 倒数第二 › 当前 */
const crumbTrail = computed<{ ellipsis: boolean; depth: number; id: number | null; name: string }[]>(
  () => {
    const items = crumbs.value.map((c, i) => ({
      ellipsis: false,
      depth: i + 1,
      id: c.id as number | null,
      name: c.name
    }))
    if (items.length <= 3) return items
    return [
      items[0]!,
      { ellipsis: true, depth: -1, id: null, name: '…' },
      items[items.length - 2]!,
      items[items.length - 1]!
    ]
  }
)

/** 当前层的子文件夹（按 sort_order，其次名称） */
const foldersHere = computed<NoteGroupRow[]>(() =>
  props.noteGroups
    .filter((g) => g.parent_id === currentId.value)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh'))
)

/** 当前层的直属笔记（更新时间倒序） */
const notesHere = computed<OutlineListRow[]>(() =>
  props.notes
    .filter((n) => n.group_id === currentId.value)
    .slice()
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
)

const isEmptyHere = computed(() => foldersHere.value.length === 0 && notesHere.value.length === 0)

function enterFolder(g: NoteGroupRow): void {
  path.value = [...path.value, g.id]
  keyword.value = ''
}

/** 面包屑回溯：depth=0 回根层；depth=i 回到第 i 层文件夹 */
function goTo(depth: number): void {
  path.value = path.value.slice(0, depth)
  keyword.value = ''
}

function goBack(): void {
  if (path.value.length > 0) path.value = path.value.slice(0, -1)
}

/** 父文件夹 id（拖拽合法性判断与面包屑落点用） */
function parentOf(id: number): number | null {
  return folderById.value.get(id)?.parent_id ?? null
}

/** candidate 是否落在 ancestor 的子树里（含自身）——禁止把文件夹拖进自己的后代 */
function isSelfOrDescendant(candidate: number, ancestor: number): boolean {
  return isSelfOrAncestor(candidate, ancestor, parentOf)
}

// 文件夹被删（子夹提升、笔记归未分类）或移走时，把失效层级从栈里退掉
watch(
  () => props.noteGroups,
  () => {
    const alive = new Set(props.noteGroups.map((g) => g.id))
    while (path.value.length > 0 && !alive.has(path.value[path.value.length - 1]!)) {
      path.value = path.value.slice(0, -1)
    }
  }
)

// ---------- 内联新建文件夹（占一个卡片位，失焦即建） ----------

const creatingFolder = ref(false)
const createName = ref('')
const createField = ref<HTMLInputElement | null>(null)
/** 本次新建是否已被 Esc 取消（输入框卸载时触发的 blur 不得再提交） */
let createCanceled = false

function startCreateFolder(): void {
  closeMenu()
  createCanceled = false
  createName.value = ''
  creatingFolder.value = true
  nextTick(() => createField.value?.focus())
}

function cancelCreateFolder(): void {
  createCanceled = true
  creatingFolder.value = false
  createName.value = ''
}

async function commitCreateFolder(): Promise<void> {
  if (!creatingFolder.value) return
  const typed = createName.value.trim()
  creatingFolder.value = false
  createName.value = ''
  const name = typed || nextUntitledName(foldersHere.value.map((f) => f.name))
  try {
    await window.lexbench.noteGroups.create(name, currentId.value)
    emit('groups-changed')
  } catch (e) {
    emit('error', e)
  }
}

function onCreateBlur(): void {
  if (createCanceled) {
    createCanceled = false
    return
  }
  void commitCreateFolder()
}

// ---------- 内联重命名（文件夹 / 笔记，失焦即提交） ----------

const renamingId = ref<number | null>(null)
/** 'folder' | 'note'：同名 id 在两个集合里可能撞车，必须带类型 */
const renamingKind = ref<'folder' | 'note'>('folder')
const renameName = ref('')
/** v-for 内的模板 ref 会被收集成数组（只有一个在渲染，其余为卸载态） */
const renameField = ref<HTMLInputElement | HTMLInputElement[] | null>(null)
let renameCanceled = false

/** 把焦点交给正在内联命名的那一格（数组/单个两种形态都兼容） */
function focusRenameField(): void {
  const raw = renameField.value
  const el = Array.isArray(raw) ? raw.find((x) => x instanceof HTMLInputElement) ?? null : raw
  el?.focus()
  el?.select()
}

/** 是否正在内联重命名该条目（folder 与 note 的 id 各自自增、会撞车，必须带 kind 比较） */
function isRenaming(kind: 'folder' | 'note', id: number): boolean {
  return renamingId.value === id && renamingKind.value === kind
}

function startRename(kind: 'folder' | 'note', id: number, name: string): void {
  closeMenu()
  renameCanceled = false
  renamingKind.value = kind
  renamingId.value = id
  renameName.value = name
  nextTick(() => focusRenameField())
}

function cancelRename(): void {
  renameCanceled = true
  renamingId.value = null
  renameName.value = ''
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  const kind = renamingKind.value
  if (id === null) return
  renamingId.value = null
  const name = renameName.value.trim()
  renameName.value = ''
  if (!name) return // 空名不落库（还原原名）
  try {
    if (kind === 'folder') {
      if (name === folderById.value.get(id)?.name) return
      await window.lexbench.noteGroups.rename(id, name)
      emit('groups-changed')
    } else {
      const row = props.notes.find((n) => n.id === id)
      if (!row || name === row.title) return
      // 只改标题（独立 IPC 口）：不再 get 整树回写，否则会与编辑器 500ms 自动保存竞态、用旧树覆盖刚编辑的正文
      await window.lexbench.outlines.rename(id, name)
      emit('imported')
    }
  } catch (e) {
    emit('error', e)
  }
}

function onRenameBlur(): void {
  if (renameCanceled) {
    renameCanceled = false
    return
  }
  void commitRename()
}

// ---------- 右键菜单 ----------

interface MenuState {
  open: boolean
  x: number
  y: number
  kind: 'blank' | 'folder' | 'note'
  id: number
}

const menu = ref<MenuState>({ open: false, x: 0, y: 0, kind: 'blank', id: 0 })
const menuEl = ref<HTMLElement | null>(null)
/** 「移动到…」二级面板是否展开 */
const moveOpen = ref(false)

function openMenu(e: MouseEvent, kind: MenuState['kind'], id: number): void {
  e.preventDefault()
  e.stopPropagation()
  const host = panelEl.value
  if (!host) return
  const r = host.getBoundingClientRect()
  menu.value = { open: true, x: e.clientX - r.left, y: e.clientY - r.top, kind, id }
  moveOpen.value = false
  // 贴边翻转：量到真实尺寸后再夹回面板内，保证菜单永远完整可见
  nextTick(() => {
    const el = menuEl.value
    if (!el) return
    const mr = el.getBoundingClientRect()
    menu.value = {
      ...menu.value,
      x: Math.max(4, Math.min(menu.value.x, Math.max(4, r.width - mr.width - 6))),
      y: Math.max(4, Math.min(menu.value.y, Math.max(4, r.height - mr.height - 6)))
    }
  })
}

function closeMenu(): void {
  menu.value.open = false
  moveOpen.value = false
}

/** 菜单项缓存的 menu.id 可能已被删（数据恢复 / 另开面板改动 / 文件夹被移出当前层）：
 *  取不到就收菜单返回 null，不走非空断言把面板打崩 */
function menuFolder(): NoteGroupRow | null {
  const row = folderById.value.get(menu.value.id)
  if (!row) closeMenu()
  return row ?? null
}

function openMenuFolder(): void {
  const f = menuFolder()
  if (!f) return
  closeMenu()
  enterFolder(f)
}

function removeMenuFolder(): void {
  const f = menuFolder()
  if (f) void removeFolder(f)
}

/** 面板外或别处按下即关菜单；点菜单内部由各自 handler 先处理 */
function onDocPointerDown(e: PointerEvent): void {
  if (!menu.value.open) return
  const t = e.target as HTMLElement | null
  if (t?.closest('.np-menu')) return
  closeMenu()
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && menu.value.open) closeMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onDocKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onDocKeydown)
})

// 菜单里的动作

async function removeFolder(g: NoteGroupRow): Promise<void> {
  closeMenu()
  try {
    await window.lexbench.noteGroups.remove(g.id)
    emit('groups-changed')
  } catch (e) {
    emit('error', e)
  }
}

function removeNote(id: number): void {
  const title = props.notes.find((n) => n.id === id)?.title ?? ''
  closeMenu()
  emit('remove', { id, title })
}

/** 「移动到…」候选：根（未分类）+ 全部文件夹按层级缩进。
 *  改文件夹时直接排除自身与后代——列出来点了也移不进去，只会静默无反应 */
const moveTargets = computed<{ id: number | null; label: string; depth: number }[]>(() => {
  const all = flattenFolders(props.noteGroups)
  const blocked = new Set<number>()
  if (menu.value.open && menu.value.kind === 'folder') {
    const selfId = menu.value.id
    for (const f of all) {
      if (isSelfOrDescendant(f.id, selfId)) blocked.add(f.id)
    }
  }
  return [
    { id: null, label: '未分类（根）', depth: 0 },
    ...all
      .filter((f) => !blocked.has(f.id))
      .map((f) => ({ id: f.id as number | null, label: f.name, depth: f.depth }))
  ]
})

/** 移动后目标位置（判断「移动到…」里是否要打勾） */
const menuItemCurrentGroup = computed<number | null>(() => {
  if (menu.value.kind === 'note') return props.notes.find((n) => n.id === menu.value.id)?.group_id ?? null
  if (menu.value.kind === 'folder') return parentOf(menu.value.id)
  return currentId.value
})

async function moveTo(target: number | null): Promise<void> {
  const { kind, id } = menu.value
  closeMenu()
  try {
    if (kind === 'note') {
      await window.lexbench.outlines.setGroup(id, target)
      emit('imported')
    } else if (kind === 'folder') {
      if (isSelfOrDescendant(target ?? -1, id)) return // 不可移进自身/后代
      await window.lexbench.noteGroups.move(id, target)
      emit('groups-changed')
    }
  } catch (e) {
    emit('error', e)
  }
}

// ---------- 拖拽改归属 ----------

const dragging = ref<{ kind: 'folder' | 'note'; id: number } | null>(null)
/** 落点：文件夹卡片 */
const dropFolderId = ref<number | null>(null)
/** 落点：面包屑第 depth 段（0=根） */
const dropCrumbDepth = ref<number | null>(null)
/** 落点：网格空白区 */
const dropBlank = ref(false)

function clearDrag(): void {
  dragging.value = null
  dropFolderId.value = null
  dropCrumbDepth.value = null
  dropBlank.value = false
}

function startDrag(kind: 'folder' | 'note', id: number, e: DragEvent): void {
  dragging.value = { kind, id }
  closeMenu()
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', `${kind}:${id}`)
  }
}

/** 拖到某层是否合法：文件夹不能拖进自身或自己的后代 */
function canDropInto(kind: 'folder' | 'note', id: number, target: number | null): boolean {
  if (kind === 'note') return true
  if (target === null) return true
  return !isSelfOrDescendant(target, id)
}

function onFolderDragOver(g: NoteGroupRow, e: DragEvent): void {
  const d = dragging.value
  if (!d || (d.kind === 'folder' && d.id === g.id) || !canDropInto(d.kind, d.id, g.id)) return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropFolderId.value = g.id
  dropBlank.value = false
  dropCrumbDepth.value = null
}

function onFolderDragLeave(g: NoteGroupRow): void {
  if (dropFolderId.value === g.id) dropFolderId.value = null
}

/** 面包屑离开：仅当离开的正是当前高亮的那一段才清掉 */
function clearCrumbDrop(depth: number): void {
  if (dropCrumbDepth.value === depth) dropCrumbDepth.value = null
}

function onCrumbDragOver(depth: number, e: DragEvent): void {
  const d = dragging.value
  if (!d) return
  const target = depth === 0 ? null : path.value[depth - 1] ?? null
  if (!canDropInto(d.kind, d.id, target)) return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropCrumbDepth.value = depth
  dropFolderId.value = null
  dropBlank.value = false
}

function onBlankDragOver(e: DragEvent): void {
  const d = dragging.value
  if (!d) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropBlank.value = true
  dropFolderId.value = null
  dropCrumbDepth.value = null
}

/** 统一落点执行：target=目标文件夹（null=根/未分类） */
async function applyDrop(target: number | null): Promise<void> {
  const d = dragging.value
  clearDrag()
  if (!d) return
  if (!canDropInto(d.kind, d.id, target)) return
  try {
    if (d.kind === 'note') {
      if (target === (props.notes.find((n) => n.id === d.id)?.group_id ?? null)) return
      await window.lexbench.outlines.setGroup(d.id, target)
      emit('imported')
    } else {
      if (target === parentOf(d.id)) return
      await window.lexbench.noteGroups.move(d.id, target)
      emit('groups-changed')
    }
  } catch (e) {
    emit('error', e)
  }
}

function dropOnFolder(g: NoteGroupRow): void {
  void applyDrop(g.id)
}

function dropOnCrumb(depth: number): void {
  void applyDrop(depth === 0 ? null : path.value[depth - 1] ?? null)
}

function dropOnBlank(): void {
  void applyDrop(currentId.value)
}

// ---------- 星标法条入口（保留既有能力） ----------

const starred = ref<StarredArticleRow[]>([])
const starredOpen = ref(false)
/** 通用大纲导入对话框 */
const importOpen = ref(false)

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
  <div ref="panelEl" class="np">
    <!-- 顶部导航：根层标题 / 子层「返回 + 面包屑」，右侧动作常驻 -->
    <div class="np-nav">
      <button v-if="path.length > 0" class="np-back" title="返回上一层" @click="goBack">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M10 3.5L5.5 8L10 12.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <div v-if="path.length > 0" class="np-crumbs">
        <button
          class="np-crumb"
          :class="{ 'drop-target': dropCrumbDepth === 0 }"
          title="我的笔记"
          @click="goTo(0)"
          @dragover="onCrumbDragOver(0, $event)"
          @dragleave="clearCrumbDrop(0)"
          @drop.prevent="dropOnCrumb(0)"
        >
          我的笔记
        </button>
        <template v-for="(c, i) in crumbTrail" :key="c.ellipsis ? 'e' + i : 'c' + c.id">
          <svg class="np-crumb-sep" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M3.5 1.5L6.5 5L3.5 8.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span v-if="c.ellipsis" class="np-crumb-ellipsis">…</span>
          <span v-else-if="c.depth === path.length" class="np-crumb cur" :title="c.name">{{ c.name }}</span>
          <button
            v-else
            class="np-crumb"
            :class="{ 'drop-target': dropCrumbDepth === c.depth }"
            :title="c.name"
            @click="goTo(c.depth)"
            @dragover="onCrumbDragOver(c.depth, $event)"
            @dragleave="clearCrumbDrop(c.depth)"
            @drop.prevent="dropOnCrumb(c.depth)"
          >
            {{ c.name }}
          </button>
        </template>
      </div>
      <span v-else class="np-title">我的笔记</span>

      <span class="np-nav-acts">
        <button class="np-icon-btn" title="从导出文件导入大纲笔记（OPML / HTML / Markdown）" @click="importOpen = true">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 10.5V2.5M8 2.5L5 5.5M8 2.5L11 5.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M2.5 9.5v2.5a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5V9.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button class="np-icon-btn" title="新建笔记（落在当前文件夹）" @click="$emit('create', currentId)">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
        <button class="np-icon-btn" title="新建文件夹" @click="startCreateFolder">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 4.5v6M5 7.5h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <path
              d="M1.8 5.2a1 1 0 011-1h2.4l1.1 1.2h6a1 1 0 011 1v5.2a1 1 0 01-1 1H2.8a1 1 0 01-1-1z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
          </svg>
        </button>
      </span>
    </div>

    <ImportOutlineDialog
      v-model:visible="importOpen"
      @error="$emit('error', $event)"
      @imported="$emit('imported')"
    />

    <!-- 搜索行：非空即切扁平结果列表 -->
    <div class="np-search">
      <svg class="np-search-icon" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
        <circle cx="5.4" cy="5.4" r="3.9" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path d="M8.4 8.4L11.4 11.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <input v-model="keyword" class="np-search-input" type="text" placeholder="搜索笔记" />
      <button v-if="searching" class="np-search-clear" title="清空搜索" @click="keyword = ''">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M2 2l6 6M8 2l-6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <div
      class="np-body"
      :class="{ 'drop-blank': dropBlank }"
      @contextmenu.self.prevent="openMenu($event, 'blank', 0)"
      @dragover.self="onBlankDragOver"
      @drop.self.prevent="dropOnBlank"
    >
      <!-- 搜索结果（跨文件夹扁平列表） -->
      <template v-if="searching">
        <p class="np-results-hint">找到 {{ results.length }} 条</p>
        <p v-if="results.length === 0" class="np-empty">没有匹配「{{ keyword.trim() }}」的笔记</p>
        <button
          v-for="n in results"
          :key="'r' + n.id"
          class="np-item"
          :class="{ on: n.id === activeId }"
          :title="n.title"
          @click="$emit('open', n.id)"
        >
          <span class="np-item-dot" aria-hidden="true">●</span>
          <span class="np-item-main">
            <span class="np-item-title">{{ n.title }}</span>
            <span v-if="snippetFor(n)" class="np-item-snippet">{{ snippetFor(n) }}</span>
          </span>
          <span class="np-item-date">{{ n.updated_at.slice(5, 10) }}</span>
        </button>
      </template>

      <!-- 图标网格：文件夹在前、笔记在后 -->
      <template v-else>
        <div
          class="np-grid"
          @contextmenu.self.prevent="openMenu($event, 'blank', 0)"
          @dragover.self="onBlankDragOver"
          @drop.self.prevent="dropOnBlank"
        >
          <!-- 内联新建：占一个卡片位 -->
          <div v-if="creatingFolder" class="np-card creating">
            <span class="np-icon">
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <path
                  d="M6 16a4 4 0 014-4h12l5 6h27a4 4 0 014 4v30a4 4 0 01-4 4H10a4 4 0 01-4-4z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                />
              </svg>
            </span>
            <input
              ref="createField"
              v-model="createName"
              class="np-card-input"
              type="text"
              placeholder="未命名文件夹"
              @click.stop
              @keydown.enter.stop.prevent="commitCreateFolder"
              @keydown.esc.stop="cancelCreateFolder"
              @blur="onCreateBlur"
            />
          </div>

          <!-- 文件夹卡片 -->
          <div
            v-for="f in foldersHere"
            :key="'f' + f.id"
            class="np-card"
            role="button"
            tabindex="0"
            :draggable="!isRenaming('folder', f.id)"
            :class="{
              'drag-over': dropFolderId === f.id,
              dragging: dragging?.kind === 'folder' && dragging.id === f.id
            }"
            @click="isRenaming('folder', f.id) || enterFolder(f)"
            @keydown.enter.prevent="enterFolder(f)"
            @keydown.space.prevent="enterFolder(f)"
            @contextmenu.prevent="openMenu($event, 'folder', f.id)"
            @dragstart="startDrag('folder', f.id, $event)"
            @dragover="onFolderDragOver(f, $event)"
            @dragleave="onFolderDragLeave(f)"
            @drop.prevent.stop="dropOnFolder(f)"
            @dragend="clearDrag"
          >
            <span class="np-icon" :class="{ open: dropFolderId === f.id }">
              <svg v-if="dropFolderId === f.id" viewBox="0 0 64 64" aria-hidden="true">
                <path
                  d="M6 18a4 4 0 014-4h12l5 6h27a4 4 0 014 4v6H6z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linejoin="round"
                />
                <path
                  d="M6 24h52l-5 24a4 4 0 01-4 3H11a4 4 0 01-4-3z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linejoin="round"
                />
              </svg>
              <svg v-else viewBox="0 0 64 64" aria-hidden="true">
                <path
                  d="M6 16a4 4 0 014-4h12l5 6h27a4 4 0 014 4v30a4 4 0 01-4 4H10a4 4 0 01-4-4z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <input
              v-if="renamingId === f.id && renamingKind === 'folder'"
              ref="renameField"
              v-model="renameName"
              class="np-card-input"
              type="text"
              @click.stop
              @keydown.enter.stop.prevent="commitRename"
              @keydown.esc.stop="cancelRename"
              @blur="onRenameBlur"
            />
            <template v-else>
              <span class="np-label" :title="f.name">{{ f.name }}</span>
              <span class="np-sub">{{ f.note_count }} 项</span>
            </template>
          </div>

          <!-- 笔记卡片 -->
          <div
            v-for="n in notesHere"
            :key="'n' + n.id"
            class="np-card"
            role="button"
            tabindex="0"
            :draggable="!isRenaming('note', n.id)"
            :data-note-id="n.id"
            :class="{
              selected: n.id === activeId,
              dragging: dragging?.kind === 'note' && dragging.id === n.id
            }"
            :title="n.title"
            @click="isRenaming('note', n.id) || $emit('open', n.id)"
            @keydown.enter.prevent="$emit('open', n.id)"
            @keydown.space.prevent="$emit('open', n.id)"
            @contextmenu.prevent="openMenu($event, 'note', n.id)"
            @dragstart="startDrag('note', n.id, $event)"
            @dragend="clearDrag"
          >
            <span class="np-icon">
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <path
                  d="M18 6h20l10 10v42H18z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linejoin="round"
                />
                <path d="M38 6v10h10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" />
                <path
                  d="M25 27h16M25 34h16M25 41h11"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </span>
            <input
              v-if="renamingId === n.id && renamingKind === 'note'"
              ref="renameField"
              v-model="renameName"
              class="np-card-input"
              type="text"
              @click.stop
              @keydown.enter.stop.prevent="commitRename"
              @keydown.esc.stop="cancelRename"
              @blur="onRenameBlur"
            />
            <span v-else class="np-label">{{ n.title }}</span>
          </div>
        </div>

        <!-- 空态：根层无笔记 / 文件夹内为空 -->
        <div v-if="isEmptyHere" class="np-empty-box">
          <svg class="np-empty-art" viewBox="0 0 96 96" aria-hidden="true">
            <path
              d="M16 26a4 4 0 014-4h16l6 7h30a4 4 0 014 4v38a4 4 0 01-4 4H20a4 4 0 01-4-4z"
              fill="none"
              stroke="currentColor"
              stroke-width="2.6"
              stroke-linejoin="round"
            />
            <path
              d="M34 20h18l9 9v38H34z"
              fill="var(--lb-chip)"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linejoin="round"
            />
            <path d="M52 20v9h9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" />
          </svg>
          <p class="np-empty-title">{{ path.length > 0 ? '这个文件夹是空的' : '还没有笔记' }}</p>
          <p class="np-empty-hint">
            {{
              path.length > 0
                ? '把笔记拖进来，或右键空白处「新建笔记」'
                : '点右上角 ＋ 新建笔记，或右键空白处新建文件夹'
            }}
          </p>
        </div>
      </template>
    </div>

    <!-- 右键菜单 -->
    <Transition name="menu-pop">
      <div
        v-if="menu.open"
        ref="menuEl"
        class="np-menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @contextmenu.prevent
      >
        <template v-if="menu.kind === 'blank'">
          <button class="np-menu-item" @click="startCreateFolder">新建文件夹</button>
          <button class="np-menu-item" @click="closeMenu(); $emit('create', currentId)">新建笔记</button>
        </template>

        <template v-else-if="menu.kind === 'folder'">
          <button class="np-menu-item" @click="openMenuFolder()">打开</button>
          <button class="np-menu-item" @click="startRename('folder', menu.id, folderById.get(menu.id)?.name ?? '')">
            重命名
          </button>
          <button class="np-menu-item" @click="moveOpen = !moveOpen">
            <span>移动到…</span>
            <span class="np-menu-arrow">›</span>
          </button>
          <div class="np-menu-sep"></div>
          <button class="np-menu-item danger" @click="removeMenuFolder()">删除</button>
        </template>

        <template v-else>
          <button class="np-menu-item" @click="closeMenu(); $emit('open', menu.id)">打开</button>
          <button
            class="np-menu-item"
            @click="startRename('note', menu.id, notes.find((n) => n.id === menu.id)?.title ?? '')"
          >
            重命名
          </button>
          <button class="np-menu-item" @click="moveOpen = !moveOpen">
            <span>移动到…</span>
            <span class="np-menu-arrow">›</span>
          </button>
          <div class="np-menu-sep"></div>
          <button class="np-menu-item danger" @click="removeNote(menu.id)">删除</button>
        </template>

        <!-- 二级：移动目标（根 + 各文件夹，缩进体现嵌套） -->
        <div v-if="moveOpen" class="np-submenu">
          <button
            v-for="t in moveTargets"
            :key="'m' + (t.id ?? 'root')"
            class="np-menu-item"
            :style="{ paddingLeft: 11 + Math.min(t.depth, 5) * 12 + 'px' }"
            @click="moveTo(t.id)"
          >
            <span class="np-menu-label">{{ t.label }}</span>
            <span v-if="menuItemCurrentGroup === t.id" class="np-menu-check">✓</span>
          </button>
        </div>
      </div>
    </Transition>

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
      <p v-if="starredOpen && starred.length === 0" class="np-star-empty">
        阅读时点亮法条旁的 ☆ 即可收藏到这里
      </p>
    </div>
  </div>
</template>

<style scoped>
.np {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 10px 8px 12px;
}

/* ---------- 顶部导航：返回 + 面包屑 / 根标题 ---------- */
.np-nav {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 6px 0 8px;
}

.np-title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--lb-text);
}

.np-back {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: transparent;
  color: var(--lb-text);
}

.np-back:hover {
  background: var(--lb-chip);
}

.np-crumbs {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
}

.np-crumb {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 96px;
  padding: 2px 6px;
  margin: 0 1px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: transparent;
  color: var(--lb-muted);
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

.np-crumb:hover {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.np-crumb.cur {
  color: var(--lb-text);
  font-weight: 600;
  cursor: default;
}

.np-crumb.drop-target {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  box-shadow: inset 0 0 0 1px var(--lb-accent);
  cursor: move;
}

.np-crumb-ellipsis,
.np-crumb-sep {
  flex: 0 0 auto;
  color: var(--lb-muted);
  margin: 0 1px;
}

.np-nav-acts {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.np-icon-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: transparent;
  color: var(--lb-text);
}

.np-icon-btn:hover {
  background: var(--lb-chip);
}

.np-icon-btn:active {
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
}

/* ---------- 搜索行 ---------- */
.np-search {
  position: relative;
  flex: 0 0 auto;
  padding: 0 2px 10px;
}

.np-search-input {
  width: 100%;
  padding: 7px 30px 7px 30px;
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

.np-search-icon {
  position: absolute;
  left: 12px;
  top: 11px;
  color: var(--lb-muted);
  pointer-events: none;
}

.np-search-clear {
  position: absolute;
  right: 9px;
  top: 9px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lb-radius-full);
  background: transparent;
  color: var(--lb-muted);
}

.np-search-clear:hover {
  background: var(--lb-chip);
  color: var(--lb-text);
}

/* ---------- 内容区（网格 / 结果列表 / 空态） ---------- */
.np-body {
  container-type: inline-size;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 2px;
  border-radius: var(--lb-radius-s);
}

/* 拖拽到空白区 = 移入当前层 */
.np-body.drop-blank,
.np-grid.drop-blank {
  outline: 2px dashed var(--lb-accent);
  outline-offset: -3px;
  background: var(--lb-accent-soft);
}

/* ---------- 图标网格 ---------- */
.np-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 2px 0 12px;
  border-radius: var(--lb-radius-s);
}

@container (max-width: 360px) {
  .np-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@container (max-width: 300px) {
  .np-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .np-icon svg {
    width: 72px;
    height: 72px;
  }
}

.np-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 4px 10px;
  border: none;
  border-radius: var(--lb-radius-s);
  background: transparent;
  cursor: default;
  transition:
    background 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.16s ease,
    opacity 0.16s ease;
}

.np-card:hover {
  background: var(--lb-accent-soft);
  box-shadow: var(--lb-shadow-1);
}

.np-card.selected {
  background: var(--lb-hit);
  box-shadow: inset 0 0 0 1.5px var(--lb-accent);
}

.np-card.selected .np-label {
  color: var(--lb-accent);
  font-weight: 600;
}

.np-card.selected .np-icon {
  color: var(--lb-accent);
}

.np-card.drag-over {
  background: var(--lb-accent-soft);
  outline: 2px dashed var(--lb-accent);
  outline-offset: -2px;
}

.np-card.drag-over .np-label {
  color: var(--lb-accent);
}

.np-card.dragging {
  opacity: 0.45;
  transform: scale(0.96);
  box-shadow: var(--lb-shadow-2);
}

/* 正在内联命名的那一格 */
.np-card.creating {
  background: var(--lb-accent-soft);
}

.np-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  color: var(--lb-muted);
}

.np-icon svg {
  width: 64px;
  height: 64px;
}

.np-icon.open {
  color: var(--lb-accent);
}

.np-label {
  min-height: 30px;
  font-size: 11px;
  line-height: 15px;
  text-align: center;
  color: var(--lb-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.np-sub {
  font-size: 10px;
  line-height: 14px;
  color: var(--lb-muted);
}

.np-card-input {
  box-sizing: border-box;
  width: 100%;
  height: 20px;
  padding: 2px 4px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  font-size: 11px;
  line-height: 15px;
  text-align: center;
  color: var(--lb-text);
}

.np-card-input::placeholder {
  color: var(--lb-muted);
}

.np-card-input:focus {
  outline: none;
  border-color: var(--lb-accent);
  box-shadow: 0 0 0 2px var(--lb-accent-soft);
}

/* ---------- 空态 ---------- */
.np-empty-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  padding: 32px 20px;
  text-align: center;
}

.np-empty-art {
  width: 96px;
  height: 96px;
  color: var(--lb-border-strong);
  opacity: 0.9;
}

.np-empty-title {
  margin: 14px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--lb-text);
}

.np-empty-hint {
  max-width: 240px;
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--lb-muted);
}

/* ---------- 搜索结果列表（复用既有行配方） ---------- */
.np-results-hint {
  padding: 0 10px 8px;
  margin: 0;
  font-size: 12px;
  color: var(--lb-muted);
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

.np-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.np-item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 正文命中摘录：解释这条为什么被搜出来 */
.np-item-snippet {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 400;
  color: var(--lb-muted);
}

.np-item-date {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--lb-muted);
  font-weight: 400;
}

/* ---------- 右键菜单（配方同 .ol-menu） ---------- */
.np-menu {
  position: absolute;
  z-index: 460;
  min-width: 180px;
  padding: 5px;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  box-shadow: var(--lb-shadow-2);
}

.np-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 7px 11px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--lb-text);
  font-size: 13px;
  text-align: left;
}

.np-menu-item:hover {
  background: var(--lb-chip);
}

.np-menu-item.danger {
  color: var(--lb-err-fg);
}

.np-menu-item.danger:hover {
  background: var(--lb-err-bg);
}

.np-menu-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--lb-border);
}

.np-menu-arrow {
  color: var(--lb-muted);
  font-size: 13px;
}

.np-menu-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.np-menu-check {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--lb-accent);
}

.np-submenu {
  margin-top: 3px;
  padding-top: 3px;
  border-top: 1px solid var(--lb-border);
  max-height: 260px;
  overflow-y: auto;
}

.menu-pop-enter-active {
  transition:
    opacity 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
    transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.menu-pop-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.98);
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
