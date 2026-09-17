<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, type AISettings } from '../api'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const masked = ref('')
const keySet = ref(false)
const saving = ref(false)
const testing = ref(false)
const message = ref('')
const messageKind = ref<'ok' | 'err'>('ok')

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    message.value = ''
    apiKey.value = ''
    try {
      const s: AISettings = await api.aiSettings()
      baseUrl.value = s.base_url
      model.value = s.model
      masked.value = s.api_key_masked
      keySet.value = s.api_key_set
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), 'err')
    }
  },
)

function show(text: string, kind: 'ok' | 'err') {
  message.value = text
  messageKind.value = kind
}

async function save() {
  if (saving.value) return
  saving.value = true
  message.value = ''
  try {
    const body: { base_url: string; model: string; api_key?: string } = {
      base_url: baseUrl.value.trim(),
      model: model.value.trim(),
    }
    if (apiKey.value.trim()) body.api_key = apiKey.value.trim()
    await api.saveAISettings(body)
    show('已保存', 'ok')
    apiKey.value = ''
    const s = await api.aiSettings()
    masked.value = s.api_key_masked
    keySet.value = s.api_key_set
  } catch (e) {
    show(e instanceof Error ? e.message : String(e), 'err')
  } finally {
    saving.value = false
  }
}

async function testConn() {
  if (testing.value) return
  testing.value = true
  message.value = ''
  try {
    const r = await api.testAI()
    show(`连接正常：${r.reply}`, 'ok')
  } catch (e) {
    show(e instanceof Error ? e.message : String(e), 'err')
  } finally {
    testing.value = false
  }
}

function close() {
  if (saving.value || testing.value) return
  emit('update:modelValue', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="mask" @click.self="close">
      <div class="dialog">
        <div class="dialog-head">
          <span>AI 助手设置</span>
          <button class="close-btn" @click="close">✕</button>
        </div>

        <div class="dialog-body">
          <p class="hint">
            支持 OpenAI 兼容协议（DeepSeek / 通义 / Kimi / OpenAI 等）。
            API Key 仅保存在本机数据库（data/ 目录），不会上传 GitHub、不写入日志。
          </p>

          <label class="field">
            <span class="field-label">接口地址 base_url</span>
            <input
              v-model="baseUrl"
              type="text"
              placeholder="如：https://api.deepseek.com/v1"
            />
          </label>

          <label class="field">
            <span class="field-label">模型名</span>
            <input v-model="model" type="text" placeholder="如：deepseek-chat" />
          </label>

          <label class="field">
            <span class="field-label">
              API Key
              <em v-if="keySet" class="key-state">已配置（{{ masked }}）</em>
            </span>
            <input
              v-model="apiKey"
              type="password"
              autocomplete="off"
              :placeholder="keySet ? '留空表示不修改' : 'sk-…'"
            />
          </label>

          <p v-if="message" class="msg" :class="messageKind">{{ message }}</p>
        </div>

        <div class="dialog-foot">
          <button class="btn" :disabled="testing" @click="testConn">
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <button class="btn primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
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
  z-index: 60;
}

.dialog {
  width: 460px;
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
}

.hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
  background: var(--chip);
  border-radius: var(--radius);
  padding: 8px 12px;
}

.field {
  display: block;
  margin-bottom: 14px;
}

.field-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
  margin-bottom: 6px;
}

.key-state {
  font-size: 11px;
  color: var(--muted);
  font-weight: 400;
}

.field input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.field input:focus {
  border-color: var(--accent);
}

.msg {
  margin: 4px 0 0;
  font-size: 13px;
  text-align: center;
}

.msg.ok {
  color: var(--accent);
}

.msg.err {
  color: #b3402f;
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

.btn:disabled {
  opacity: 0.5;
}

.btn.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
</style>
