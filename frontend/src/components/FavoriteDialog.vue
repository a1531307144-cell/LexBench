<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, type TopicRow } from '../api'

const props = defineProps<{
  modelValue: boolean
  articleId: number
  articleLabel: string
}>()

const emit = defineEmits<{ 'update:modelValue': [v: boolean]; done: [] }>()

const topics = ref<TopicRow[]>([])
const selected = ref<number | null>(null)
const creating = ref(false)
const newName = ref('')
const busy = ref(false)
const message = ref('')

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    message.value = ''
    creating.value = false
    newName.value = ''
    busy.value = false
    try {
      topics.value = await api.topics()
      selected.value = topics.value.length ? topics.value[0].id : null
      if (!topics.value.length) creating.value = true
    } catch (e) {
      message.value = e instanceof Error ? e.message : String(e)
    }
  },
)

async function confirm() {
  if (busy.value) return
  busy.value = true
  message.value = ''
  try {
    let topicId = selected.value
    if (creating.value) {
      const name = newName.value.trim()
      if (!name) throw new Error('请填写专题名称')
      const t = await api.createTopic(name)
      topicId = t.id
    }
    if (topicId == null) throw new Error('请选择或新建专题')
    const resp = await api.addFavorite(topicId, props.articleId)
    message.value =
      resp.status === 'duplicate' ? '该法条已在此专题中' : `已收藏 ${props.articleLabel}`
    await new Promise((r) => setTimeout(r, 500))
    emit('done')
    emit('update:modelValue', false)
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function close() {
  if (busy.value) return
  emit('update:modelValue', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="mask" @click.self="close">
      <div class="dialog">
        <div class="dialog-head">
          <span>收藏 {{ articleLabel }}</span>
          <button class="close-btn" @click="close">✕</button>
        </div>

        <div class="dialog-body">
          <div v-if="!creating">
            <label
              v-for="t in topics"
              :key="t.id"
              class="topic-option"
              :class="{ checked: selected === t.id }"
            >
              <input v-model="selected" type="radio" :value="t.id" />
              <span class="opt-name">{{ t.name }}</span>
              <span class="opt-meta">{{ t.item_count }} 条 · {{ t.note_count }} 记</span>
            </label>
            <button class="new-topic-btn" @click="creating = true">+ 新建专题</button>
          </div>

          <div v-else class="create-area">
            <input
              v-model="newName"
              type="text"
              placeholder="专题名称（如：离婚财产分割）"
              @keydown.enter.prevent="confirm"
            />
            <button v-if="topics.length" class="new-topic-btn" @click="creating = false">
              ‹ 选择已有专题
            </button>
          </div>

          <p v-if="message" class="msg">{{ message }}</p>
        </div>

        <div class="dialog-foot">
          <button class="btn" @click="close">取消</button>
          <button class="btn primary" :disabled="busy" @click="confirm">
            {{ busy ? '收藏中…' : '★ 收藏' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(38, 35, 30, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.dialog {
  width: 420px;
  max-width: calc(100vw - 40px);
  background: var(--panel);
  border-radius: 12px;
  overflow: hidden;
}

.dialog-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}

.close-btn {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 14px;
}

.dialog-body {
  padding: 16px 20px;
  max-height: 50vh;
  overflow-y: auto;
}

.topic-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 8px;
  cursor: pointer;
  font-size: 14px;
}

.topic-option.checked {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.topic-option input {
  accent-color: var(--accent);
}

.opt-name {
  flex: 1;
  font-family: var(--serif);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.opt-meta {
  font-size: 11px;
  color: var(--muted);
}

.new-topic-btn {
  width: 100%;
  padding: 9px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: none;
  color: var(--muted);
  font-size: 13px;
}

.new-topic-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.create-area {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.create-area input {
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}

.create-area input:focus {
  border-color: var(--accent);
}

.msg {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--accent);
  text-align: center;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}

.btn {
  height: 34px;
  padding: 0 18px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--panel);
  font-size: 13px;
}

.btn.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.btn.primary:disabled {
  opacity: 0.5;
}
</style>
