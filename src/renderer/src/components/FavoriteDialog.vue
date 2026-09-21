<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TopicRow } from '@shared/types'

const props = defineProps<{
  visible: boolean
  articleId: number
  articleLabel: string
}>()

const emit = defineEmits<{
  'update:visible': [v: boolean]
  /** 收藏成功（added 与 duplicate 均算成功），App 据此刷新专题计数并用消息条提示（修复旧版 #15：不再 500ms 假延迟） */
  done: [payload: { topicName: string; duplicate: boolean }]
  error: [message: string]
}>()

const topics = ref<TopicRow[]>([])
const mode = ref<'pick' | 'new'>('pick')
const selected = ref<number | null>(null)
const newName = ref('')
const busy = ref(false)
const note = ref('')
const newInput = ref<HTMLInputElement | null>(null)

// 打开时拉取专题列表并复位状态；库中无专题直接进入新建态
watch(
  () => props.visible,
  async (open) => {
    if (!open) return
    mode.value = 'pick'
    selected.value = null
    newName.value = ''
    note.value = ''
    try {
      topics.value = await window.lexbench.workspace.listTopics()
    } catch (e) {
      topics.value = []
      emit('error', errText(e))
    }
    if (topics.value.length) {
      selected.value = topics.value[0].id
    } else {
      mode.value = 'new'
      void nextTick(() => newInput.value?.focus())
    }
  }
)

function pickTopic(id: number): void {
  mode.value = 'pick'
  selected.value = id
  note.value = ''
}

function startNew(): void {
  mode.value = 'new'
  note.value = ''
  void nextTick(() => newInput.value?.focus())
}

function close(): void {
  if (busy.value) return
  emit('update:visible', false)
}

/** 收藏：选已有专题直接收藏；新建态先建专题再收藏（重名等失败留在对话框内提示，不产生孤儿专题） */
async function favorite(): Promise<void> {
  if (busy.value) return
  note.value = ''
  busy.value = true
  try {
    if (mode.value === 'new') {
      const name = newName.value.trim()
      if (!name) {
        note.value = '请输入专题名称'
        return
      }
      const t = await window.lexbench.workspace.createTopic(name)
      const r = await window.lexbench.workspace.addTopicItem(t.id, props.articleId)
      emit('done', { topicName: t.name, duplicate: r.status === 'duplicate' })
      emit('update:visible', false)
    } else {
      const target = topics.value.find((t) => t.id === selected.value)
      if (!target) {
        note.value = '请先选择一个专题'
        return
      }
      const r = await window.lexbench.workspace.addTopicItem(target.id, props.articleId)
      // 成功即时关闭，提示交给 App 的消息条
      emit('done', { topicName: target.name, duplicate: r.status === 'duplicate' })
      emit('update:visible', false)
    }
  } catch (e) {
    note.value = errText(e)
    emit('error', errText(e))
  } finally {
    busy.value = false
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.visible || busy.value) return
  if (e.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg-fade">
      <div v-if="visible" class="fd-mask" @click.self="close">
        <div class="fd-dialog">
        <div class="fd-head">
          <span class="fd-title">收藏 {{ articleLabel }}</span>
          <button class="fd-close" :disabled="busy" @click="close">✕</button>
        </div>

        <div class="fd-body">
          <div
            v-for="t in topics"
            :key="t.id"
            class="fd-opt"
            :class="{ on: mode === 'pick' && selected === t.id }"
            @click="pickTopic(t.id)"
          >
            <span class="fd-radio"></span>
            <span class="fd-opt-name">{{ t.name }}</span>
            <span class="fd-opt-meta">{{ t.item_count }} 条 · {{ t.note_count }} 记</span>
          </div>

          <div class="fd-opt new" :class="{ on: mode === 'new' }" @click="startNew">
            <span class="fd-radio"></span>
            <input
              v-if="mode === 'new'"
              ref="newInput"
              v-model="newName"
              class="fd-in"
              type="text"
              placeholder="新专题名称（必填），Enter 直接收藏"
              :disabled="busy"
              @click.stop
              @keydown.enter.prevent="favorite"
            />
            <span v-else class="fd-opt-name">＋ 新建专题</span>
          </div>

          <p v-if="note" class="fd-note">{{ note }}</p>
        </div>

        <div class="fd-foot">
          <button class="fd-btn" :disabled="busy" @click="close">取消</button>
          <button class="fd-btn primary" :disabled="busy" @click="favorite">
            {{ busy ? '收藏中…' : '★ 收藏' }}
          </button>
        </div>
      </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fd-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
}

.fd-dialog {
  width: 420px;
  max-width: calc(100vw - 40px);
  display: flex;
  flex-direction: column;
  background: var(--lb-panel);
  border-radius: var(--lb-radius-l);
  overflow: hidden;
  box-shadow: 0 12px 36px rgba(24, 28, 55, 0.2);
}

.fd-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  font-size: 15px;
  font-weight: 600;
  color: var(--lb-text);
  border-bottom: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.fd-title {
  font-family: var(--lb-serif);
}

.fd-close {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 5px;
}

.fd-close:hover:not(:disabled) {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.fd-body {
  padding: 14px 20px;
  overflow-y: auto;
  max-height: 320px;
}

.fd-opt {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 6px;
  cursor: pointer;
  min-height: 38px;
}

.fd-opt:hover {
  border-color: var(--lb-accent-2);
  background: var(--lb-accent-soft);
}

.fd-opt.on {
  border-color: var(--lb-accent);
  background: var(--lb-accent-soft);
}

.fd-radio {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.5px solid var(--lb-border-strong);
  flex-shrink: 0;
}

.fd-opt.on .fd-radio {
  border-color: var(--lb-accent);
  background: radial-gradient(circle, var(--lb-accent) 0 4.5px, transparent 5px);
}

.fd-opt-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--lb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fd-opt-meta {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--lb-muted);
  background: var(--lb-chip);
  padding: 1px 8px;
  border-radius: 999px;
}

.fd-in {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--lb-accent-2);
  border-radius: 6px;
  font-size: 13px;
  color: var(--lb-text);
  outline: none;
  background: #fff;
}

.fd-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--lb-warn-fg);
  line-height: 1.6;
}

.fd-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.fd-btn {
  height: 36px;
  padding: 0 20px;
  border-radius: var(--lb-radius-s);
  border: 1px solid var(--lb-border-strong);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
}

.fd-btn.primary {
  border-color: var(--lb-accent);
  background: var(--lb-grad);
  color: #fff;
}

.fd-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
