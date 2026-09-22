<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ConfirmModal from './ConfirmModal.vue'
import type { ExportFormat, TopicDetail, TopicItemRow, TopicRow } from '@shared/types'
import type { ItemMoveDirection, TopicPatch } from '@shared/ipc'
import { shortLawName } from '@shared/lawName'

const props = defineProps<{
  /** 专题列表（App 维护，带 item_count/note_count 计数） */
  topics: TopicRow[]
  /** 当前打开的专题详情；null = 列表态 */
  active: TopicDetail | null
  /** 当前阅读器打开的法条 id（详情条目高亮用） */
  selectedId: number
}>()

const emit = defineEmits<{
  create: [name: string, description: string]
  open: [id: number]
  back: []
  /** 改名/改描述（修复旧版 #12：显式入口，不再依赖隐蔽的双击） */
  rename: [id: number, patch: TopicPatch]
  remove: [id: number]
  removeItem: [topicId: number, articleId: number]
  /** 专题内条目上移/下移（修复旧版 #16：不可排序） */
  move: [topicId: number, articleId: number, dir: ItemMoveDirection]
  openArticle: [id: number]
  exportTopic: [format: ExportFormat]
  /** 请求把焦点送到中栏的专题检索条（左栏「＋ 添加法条」用） */
  focusSearch: []
}>()

// ---------- 列表态：内联新建表单 ----------
const creating = ref(false)
const newName = ref('')
const newDesc = ref('')

function toggleCreate(): void {
  creating.value = !creating.value
  newName.value = ''
  newDesc.value = ''
}

function submitCreate(): void {
  const name = newName.value.trim()
  if (!name) return
  emit('create', name, newDesc.value.trim())
  creating.value = false
  newName.value = ''
  newDesc.value = ''
}

// ---------- 详情态：改名/改描述表单 ----------
const editing = ref(false)
const editName = ref('')
const editDesc = ref('')

function startEdit(): void {
  if (!props.active) return
  editName.value = props.active.name
  editDesc.value = props.active.description
  editing.value = true
}

function submitEdit(): void {
  if (!props.active) return
  const name = editName.value.trim()
  if (!name) return
  emit('rename', props.active.id, { name, description: editDesc.value.trim() })
  editing.value = false
}

// 切换专题 / 返回列表时退出编辑态
watch(
  () => props.active?.id ?? 0,
  () => {
    editing.value = false
  }
)

// ---------- 详情态：条目列表 ----------
// 后端按 order_index 返回，这里再稳妥排一次并暴露给序号/上下移判断
const sortedItems = computed<TopicItemRow[]>(() =>
  props.active ? [...props.active.items].sort((a, b) => a.order_index - b.order_index) : []
)

/** 条文纯文本摘要：压平空白取前 40 字 */
function brief(content: string): string {
  const s = content.replace(/\s+/g, ' ').trim()
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

// ---------- 删除/移出确认（ConfirmModal，替代原生 confirm） ----------
const pendingDelTopic = ref<TopicRow | null>(null)
const pendingDelItem = ref<TopicItemRow | null>(null)

const topicDelMessage = computed(() =>
  pendingDelTopic.value
    ? `确定删除专题「${pendingDelTopic.value.name}」？其中 ${pendingDelTopic.value.item_count} 条收藏与 ${pendingDelTopic.value.note_count} 则笔记将一并删除，此操作不可撤销。`
    : ''
)

const itemDelMessage = computed(() => {
  const it = pendingDelItem.value
  if (!it) return ''
  // 移出会连同该条下的笔记一起删，必须说清楚，别让用户以为笔记还在
  return it.note_count > 0
    ? `「${it.article_label}」下有 ${it.note_count} 则笔记，移出专题会连同这些笔记一并删除，此操作不可撤销。`
    : `确定将「${it.article_label}」移出本专题？`
})

function confirmDelTopic(): void {
  const row = pendingDelTopic.value
  if (!row) return
  pendingDelTopic.value = null
  emit('remove', row.id)
}

function confirmDelItem(): void {
  const it = pendingDelItem.value
  if (!it) return
  pendingDelItem.value = null
  emit('removeItem', it.topic_id, it.article_id)
}
</script>

<template>
  <div class="tp">
    <!-- 列表态 -->
    <template v-if="!active">
      <div class="tp-head">
        <span class="tp-htitle">研究工作台</span>
        <button class="tp-add" @click="toggleCreate">{{ creating ? '取消' : '＋ 新建' }}</button>
      </div>

      <div v-if="creating" class="tp-create">
        <input
          v-model="newName"
          class="tp-in"
          type="text"
          placeholder="专题名称（必填）"
          @keydown.enter="submitCreate"
        />
        <input
          v-model="newDesc"
          class="tp-in"
          type="text"
          placeholder="一句话描述（可选）"
          @keydown.enter="submitCreate"
        />
        <div class="tp-create-ops">
          <span class="tp-flex"></span>
          <button class="tp-btn" @click="creating = false">取消</button>
          <button class="tp-btn primary" :disabled="!newName.trim()" @click="submitCreate">
            创建
          </button>
        </div>
      </div>

      <div v-if="!topics.length && !creating" class="tp-empty">
        <div class="tp-empty-seal">研</div>
        <p class="tp-empty-title">还没有研究专题</p>
        <p class="tp-empty-sub">点「＋ 新建」建立第一个专题，<br />或阅读法条时点「★ 收藏」</p>
      </div>

      <div class="tp-list">
        <div v-for="row in topics" :key="row.id" class="tp-row" @click="emit('open', row.id)">
          <div class="tp-row-main">
            <div class="tp-row-name">{{ row.name }}</div>
            <p class="tp-row-desc" :class="{ none: !row.description }">
              {{ row.description || '（无描述）' }}
            </p>
            <span class="tp-row-meta">{{ row.item_count }} 条 · {{ row.note_count }} 记</span>
          </div>
          <button class="tp-x" title="删除专题" @click.stop="pendingDelTopic = row">✕</button>
        </div>
      </div>
    </template>

    <!-- 详情态 -->
    <template v-else>
      <div class="tp-head">
        <button class="tp-back" @click="emit('back')">‹ 返回</button>
        <span class="tp-flex"></span>
        <button class="tp-ghost" title="修改名称 / 描述" @click="startEdit">✎</button>
      </div>

      <div class="tp-dhead">
        <div class="tp-dname">{{ active.name }}</div>
        <p v-if="active.description" class="tp-ddesc">{{ active.description }}</p>
      </div>

      <div v-if="editing" class="tp-edit">
        <input v-model="editName" class="tp-in" type="text" placeholder="专题名称（必填）" />
        <input
          v-model="editDesc"
          class="tp-in"
          type="text"
          placeholder="一句话描述（可选）"
          @keydown.enter="submitEdit"
        />
        <div class="tp-create-ops">
          <span class="tp-flex"></span>
          <button class="tp-btn" @click="editing = false">取消</button>
          <button class="tp-btn primary" :disabled="!editName.trim()" @click="submitEdit">
            保存
          </button>
        </div>
      </div>

      <div class="tp-ops">
        <span class="tp-row-meta">{{ active.items.length }} 条 · {{ active.notes.length }} 记</span>
        <span class="tp-flex"></span>
        <button class="tp-mini" title="导出 Markdown 报告" @click="emit('exportTopic', 'md')">
          .md
        </button>
        <button class="tp-mini" title="导出 Word 报告" @click="emit('exportTopic', 'docx')">
          .docx
        </button>
        <button class="tp-mini primary" title="去中栏的检索条搜索法条" @click="emit('focusSearch')">
          ＋ 添加法条
        </button>
      </div>

      <div class="tp-list">
        <div v-if="!sortedItems.length" class="tp-empty small">
          <p class="tp-empty-title">尚未收藏条文</p>
          <p class="tp-empty-sub">
            在中栏的检索条里搜法条，点「＋」加入本专题；读法条时也可以点「★ 收藏」
          </p>
        </div>
        <div
          v-for="(it, i) in sortedItems"
          :key="it.id"
          class="tp-item"
          :class="{ active: it.article_id === selectedId }"
          @click="emit('openArticle', it.article_id)"
        >
          <span class="tp-idx">{{ it.order_index + 1 }}</span>
          <div class="tp-item-main">
            <div class="tp-item-l1">
              <span class="tp-item-label">{{ it.article_label }}</span>
              <span v-if="it.note_count > 0" class="tp-item-notes">{{ it.note_count }} 记</span>
            </div>
            <!-- 法规名单独占一行：库里最长 40 字，跟条号挤一行只会被截成
                 「最高人民法院关于适用《…」，「（一）」「（二）」根本分不出来。
                 这里显示智能简称，悬停给出全名 -->
            <p class="tp-item-doc" :title="it.title">{{ shortLawName(it.title) }}</p>
            <p class="tp-item-sum">{{ brief(it.content) }}</p>
          </div>
          <div class="tp-item-ops" @click.stop>
            <button
              class="tp-arr"
              :disabled="i === 0"
              title="上移"
              @click="emit('move', it.topic_id, it.article_id, 'up')"
            >
              ↑
            </button>
            <button
              class="tp-arr"
              :disabled="i === sortedItems.length - 1"
              title="下移"
              @click="emit('move', it.topic_id, it.article_id, 'down')"
            >
              ↓
            </button>
            <button class="tp-arr danger" title="移出专题" @click="pendingDelItem = it">✕</button>
          </div>
        </div>
      </div>
    </template>

    <ConfirmModal
      :visible="pendingDelTopic !== null"
      title="删除专题"
      :message="topicDelMessage"
      danger
      confirm-text="删除"
      @confirm="confirmDelTopic"
      @cancel="pendingDelTopic = null"
    />

    <ConfirmModal
      :visible="pendingDelItem !== null"
      title="移出专题"
      :message="itemDelMessage"
      danger
      confirm-text="移出"
      @confirm="confirmDelItem"
      @cancel="pendingDelItem = null"
    />
  </div>
</template>

<style scoped>
.tp {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* ---------- 头栏 ---------- */
.tp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px 10px;
  flex-shrink: 0;
}

.tp-htitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
}

.tp-add {
  padding: 5px 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
}

.tp-add:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.tp-back {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 13px;
  padding: 4px 8px;
  border-radius: var(--lb-radius-s);
}

.tp-back:hover {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.tp-ghost {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 13px;
  padding: 4px 8px;
  border-radius: var(--lb-radius-s);
}

.tp-ghost:hover {
  color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.tp-flex {
  flex: 1;
}

/* ---------- 内联表单（新建 / 改名共用） ---------- */
.tp-create,
.tp-edit {
  margin: 0 16px 10px;
  padding: 10px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: #fbfbfe;
  flex-shrink: 0;
}

.tp-in {
  display: block;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  font-size: 13px;
  color: var(--lb-text);
  outline: none;
  background: #fff;
}

.tp-in + .tp-in {
  margin-top: 8px;
}

.tp-in:focus {
  border-color: var(--lb-accent-2);
}

.tp-create-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.tp-btn {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}

.tp-btn.primary {
  border-color: var(--lb-accent);
  background: var(--lb-grad);
  color: #fff;
}

.tp-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---------- 空态 ---------- */
.tp-empty {
  padding: 40px 20px;
  text-align: center;
  flex-shrink: 0;
}

.tp-empty.small {
  padding: 30px 16px;
}

.tp-empty-seal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--lb-grad);
  color: #fff;
  font-family: var(--lb-serif);
  font-size: 20px;
  margin-bottom: 12px;
  opacity: 0.85;
}

.tp-empty-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--lb-text);
  margin-bottom: 6px;
}

.tp-empty-sub {
  font-size: 12px;
  color: var(--lb-muted);
  line-height: 1.8;
}

/* ---------- 列表态：专题行 ---------- */
.tp-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 0 10px 14px;
}

.tp-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 6px 10px 12px;
  border-radius: var(--lb-radius-s);
  cursor: pointer;
}

/* Apple 手感：悬停底色平滑 + 列表渐次进入 */
@media (prefers-reduced-motion: no-preference) {
  .tp-row {
    transition: background 0.12s ease;
    animation: lb-tp-in 0.16s ease both;
  }

  .tp-row:nth-child(1) { animation-delay: 0ms; }
  .tp-row:nth-child(2) { animation-delay: 30ms; }
  .tp-row:nth-child(3) { animation-delay: 60ms; }
  .tp-row:nth-child(4) { animation-delay: 90ms; }
  .tp-row:nth-child(5) { animation-delay: 120ms; }
  .tp-row:nth-child(6) { animation-delay: 150ms; }
}

@keyframes lb-tp-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.tp-row:hover {
  background: var(--lb-accent-soft);
}

.tp-row-main {
  flex: 1;
  min-width: 0;
}

.tp-row-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--lb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tp-row-desc {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--lb-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tp-row-desc.none {
  opacity: 0.6;
}

.tp-row-meta {
  display: inline-block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--lb-muted);
  background: var(--lb-chip);
  padding: 1px 8px;
  border-radius: 999px;
}

.tp-x {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 5px;
  flex-shrink: 0;
  visibility: hidden;
}

.tp-row:hover .tp-x {
  visibility: visible;
}

.tp-x:hover {
  color: var(--lb-err-fg);
  background: var(--lb-err-bg);
}

/* ---------- 详情态头区 ---------- */
.tp-dhead {
  padding: 0 16px 8px;
  flex-shrink: 0;
}

.tp-dname {
  font-family: var(--lb-serif);
  font-size: 18px;
  font-weight: 700;
  color: var(--lb-text);
  line-height: 1.4;
  word-break: break-all;
}

.tp-ddesc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--lb-muted);
  line-height: 1.6;
}

.tp-ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 10px;
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

/* 左栏只有 340px：计数与按钮谁都不许折行，挤不下就整行下沉 */
.tp-ops .tp-row-meta,
.tp-ops .tp-mini {
  white-space: nowrap;
}

.tp-mini {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}

.tp-mini:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.tp-mini.primary {
  border-color: var(--lb-accent);
  color: var(--lb-accent);
}

/* ---------- 详情态：条目行 ---------- */
.tp-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 6px 10px 10px;
  border-radius: var(--lb-radius-s);
  cursor: pointer;
  border: 1px solid transparent;
}

.tp-item:hover {
  background: var(--lb-accent-soft);
}

.tp-item.active {
  background: var(--lb-accent-soft);
  border-color: var(--lb-accent-2);
}

.tp-idx {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
}

.tp-item.active .tp-idx {
  background: var(--lb-grad);
  color: #fff;
}

.tp-item-main {
  flex: 1;
  min-width: 0;
}

.tp-item-l1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.tp-item-label {
  font-family: var(--lb-serif);
  font-size: 13px;
  font-weight: 600;
  color: var(--lb-accent);
  flex-shrink: 0;
}

/* 法规名独占一行：跟条号挤一行时，40 字的名字只会被截成「最高人民法院关于适用《…」，
   同一部法规的（一）（二）根本分不出来。这里显示简称，全名走 title 悬停 */
.tp-item-doc {
  display: block;
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--lb-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* 该条法条在本专题下的笔记条数 */
.tp-item-notes {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-size: 10.5px;
  line-height: 15px;
}

.tp-item-sum {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--lb-muted);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tp-item-ops {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.tp-arr {
  width: 22px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--lb-muted);
  font-size: 12px;
  line-height: 1;
}

.tp-arr:hover:not(:disabled) {
  color: var(--lb-accent);
  background: var(--lb-chip);
}

.tp-arr:disabled {
  opacity: 0.3;
  cursor: default;
}

.tp-arr.danger:hover:not(:disabled) {
  color: var(--lb-err-fg);
  background: var(--lb-err-bg);
}
</style>
