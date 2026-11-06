<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { OutlineListRow } from '@shared/types'

const props = defineProps<{
  visible: boolean
  notes: OutlineListRow[]
}>()

const emit = defineEmits<{
  'update:visible': [v: boolean]
  /** 新建一篇空白笔记，再打开它的平行视图 */
  create: []
  /** 用现有笔记创建（打开对应平行视图） */
  existing: [noteId: number]
}>()

const step = ref<'choose' | 'pick'>('choose')
/** 先直接展示现有笔记；搜索是额外的可选操作 */
const searchOpen = ref(false)
const keyword = ref('')
const searchEl = ref<HTMLInputElement | null>(null)

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return props.notes
  return props.notes.filter((n) => n.title.toLowerCase().includes(q))
})

function close(): void {
  emit('update:visible', false)
}

function chooseNew(): void {
  close()
  emit('create')
}

function chooseExisting(): void {
  step.value = 'pick'
  searchOpen.value = false
  keyword.value = ''
}

function toggleSearch(): void {
  searchOpen.value = !searchOpen.value
  if (!searchOpen.value) {
    keyword.value = ''
    return
  }
  void nextTick(() => searchEl.value?.focus())
}

function pick(noteId: number): void {
  close()
  emit('existing', noteId)
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.visible || e.key !== 'Escape') return
  if (step.value === 'pick') {
    if (searchOpen.value) {
      searchOpen.value = false
      keyword.value = ''
    } else {
      step.value = 'choose'
    }
  } else {
    close()
  }
}

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    step.value = 'choose'
    searchOpen.value = false
    keyword.value = ''
  }
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <!-- 不用 Transition：对话框可能在 enter 过渡未结束时被关闭，残留的遮罩会吃掉整个窗口的指针事件 -->
    <div v-if="visible" class="pc-mask" @click.self="close">
        <div class="pc-dialog" role="dialog" aria-label="创建平行视图">
          <div class="pc-head">
            <div>
              <div class="pc-title">创建平行视图</div>
              <div class="pc-sub">
                {{ step === 'choose' ? '每篇笔记对应一个平行视图' : '选择一篇现有笔记' }}
              </div>
            </div>
            <button class="pc-close" title="关闭" @click="close">✕</button>
          </div>

          <div v-if="step === 'choose'" class="pc-body pc-choices">
            <button class="pc-option" data-pc-option="new" @click="chooseNew">
              <span class="pc-option-icon">
                <svg viewBox="0 0 48 48" aria-hidden="true">
                  <rect x="10" y="6" width="28" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="2.2" />
                  <path d="M24 15v18M15 24h18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
                </svg>
              </span>
              <span class="pc-option-main">
                <span class="pc-option-title">新建笔记</span>
                <span class="pc-option-desc">先创建一篇空白笔记，再在里面摆放文档窗</span>
              </span>
            </button>

            <button class="pc-option" data-pc-option="existing" @click="chooseExisting">
              <span class="pc-option-icon">
                <svg viewBox="0 0 48 48" aria-hidden="true">
                  <rect x="8" y="9" width="14" height="30" rx="3" fill="none" stroke="currentColor" stroke-width="2.2" />
                  <rect x="26" y="9" width="14" height="30" rx="3" fill="none" stroke="currentColor" stroke-width="2.2" opacity="0.65" />
                  <path d="M13 16h4M13 21h4M31 16h4M31 21h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity="0.6" />
                </svg>
              </span>
              <span class="pc-option-main">
                <span class="pc-option-title">从现有笔记创建</span>
                <span class="pc-option-desc">选择一篇已有笔记，打开它对应的平行视图</span>
              </span>
            </button>
          </div>

          <div v-else class="pc-body pc-pick">
            <div class="pc-pick-bar">
              <button class="pc-back" title="返回" @click="step = 'choose'">← 返回</button>
              <span class="pc-pick-title">选择现有笔记</span>
              <button
                class="pc-search-toggle"
                :class="{ on: searchOpen }"
                data-pc-search-toggle
                :title="searchOpen ? '关闭搜索' : '搜索笔记（可选）'"
                @click="toggleSearch"
              >
                ⌕ {{ searchOpen ? '关闭搜索' : '搜索' }}
              </button>
            </div>
            <div v-if="searchOpen" class="pc-search">
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.3" />
                <path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
              <input
                ref="searchEl"
                v-model="keyword"
                class="pc-search-input"
                type="text"
                placeholder="搜索笔记标题…"
              />
            </div>
            <div class="pc-note-list">
              <p v-if="notes.length === 0" class="pc-empty">还没有笔记，请先新建一篇。</p>
              <p v-else-if="filtered.length === 0" class="pc-empty">没有匹配的笔记</p>
              <button
                v-for="n in filtered"
                :key="n.id"
                class="pc-note"
                :data-note-id="n.id"
                @click="pick(n.id)"
              >
                <span class="pc-note-title">{{ n.title }}</span>
                <span class="pc-note-date">{{ n.updated_at.slice(5, 10) }}</span>
              </button>
            </div>
          </div>
        </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pc-mask {
  position: fixed;
  inset: 0;
  z-index: 460;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lb-overlay);
}

.pc-dialog {
  width: 480px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
  background: var(--lb-panel);
  border-radius: var(--lb-radius-xl);
  corner-shape: var(--lb-corner-shape);
  box-shadow: var(--lb-shadow-3);
  overflow: hidden;
}

.pc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 10px;
  flex-shrink: 0;
}

.pc-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--lb-text);
}

.pc-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--lb-muted);
}

.pc-close {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 13px;
}

.pc-body {
  flex: 1;
  min-height: 0;
  padding: 4px 20px 20px;
}

.pc-choices {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pc-option {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 16px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  background: var(--lb-panel);
  text-align: left;
}

.pc-option:hover {
  border-color: var(--lb-accent-2);
  background: var(--lb-accent-soft);
}

.pc-option-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  color: var(--lb-accent);
}

.pc-option-icon svg {
  width: 100%;
  height: 100%;
}

.pc-option-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.pc-option-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
}

.pc-option-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--lb-muted);
}

.pc-pick {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.pc-pick-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  flex-shrink: 0;
}

.pc-pick-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--lb-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pc-search-toggle {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  color: var(--lb-muted);
  font-size: 12px;
  flex-shrink: 0;
}

.pc-search-toggle:hover,
.pc-search-toggle.on {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.pc-search-toggle.on {
  background: var(--lb-accent-soft);
}

.pc-back {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
  flex-shrink: 0;
}

.pc-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  margin-bottom: 8px;
  padding: 0 10px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel-2);
  color: var(--lb-muted);
  flex-shrink: 0;
}

.pc-search:focus-within {
  border-color: var(--lb-accent-ring);
  box-shadow: 0 0 0 3px var(--lb-accent-soft);
}

.pc-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--lb-text);
  font-size: 12px;
  outline: none;
}

.pc-note-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  max-height: min(52vh, 420px);
}

.pc-empty {
  padding: 28px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--lb-muted);
}

.pc-note {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--lb-radius-s);
  background: transparent;
  text-align: left;
}

.pc-note:hover {
  border-color: var(--lb-accent-2);
  background: var(--lb-accent-soft);
}

.pc-note-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--lb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pc-note-date {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--lb-muted);
}
</style>
