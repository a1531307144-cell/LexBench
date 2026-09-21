<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmModal from './ConfirmModal.vue'
import type { AiProfileRow } from '@shared/types'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  'update:visible': [v: boolean]
  /** 所有失败进 App 全局错误条 */
  error: [message: string]
  /** 正向提示（保存成功等），走 App 消息条 */
  notice: [text: string]
}>()

const profiles = ref<AiProfileRow[]>([])
/** null = 新建档案；否则为被编辑档案 id */
const editingId = ref<number | null>(null)
const fName = ref('')
const fBaseUrl = ref('')
const fModel = ref('')
const fApiKey = ref('')

const busy = ref(false)
const busyKind = ref<'load' | 'save' | 'test' | 'active' | 'delete'>('load')
/** 表单内失败提示 */
const note = ref('')
/** 测试连接成功的回复文本 */
const testOk = ref('')
const pendingDel = ref<AiProfileRow | null>(null)

const editing = computed(() => editingId.value !== null)
const delMessage = computed(() =>
  pendingDel.value ? `确定删除档案「${pendingDel.value.name}」？此操作不可撤销。` : ''
)

// 每次打开：重取档案列表并复位表单
watch(
  () => props.visible,
  (open) => {
    if (!open) return
    resetForm()
    void load()
  }
)

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

function fail(msg: string): void {
  note.value = msg
  emit('error', msg)
}

async function load(): Promise<void> {
  busy.value = true
  busyKind.value = 'load'
  try {
    profiles.value = await window.lexbench.ai.listProfiles()
  } catch (e) {
    profiles.value = []
    fail(errText(e))
  } finally {
    busy.value = false
  }
}

function resetForm(): void {
  editingId.value = null
  fName.value = ''
  fBaseUrl.value = ''
  fModel.value = ''
  fApiKey.value = ''
  note.value = ''
  testOk.value = ''
}

function editProfile(p: AiProfileRow): void {
  editingId.value = p.id
  fName.value = p.name
  fBaseUrl.value = p.base_url
  fModel.value = p.model
  // 编辑时留空 = 保留原密钥（主进程按此约定处理）
  fApiKey.value = ''
  note.value = ''
  testOk.value = ''
}

function close(): void {
  if (busy.value) return
  emit('update:visible', false)
}

/** 表单校验：三项必填 */
function validate(): string {
  if (!fName.value.trim()) return '请填写档案名称'
  if (!fBaseUrl.value.trim()) return '请填写接口地址'
  if (!fModel.value.trim()) return '请填写模型名'
  return ''
}

async function testConn(): Promise<void> {
  if (busy.value) return
  note.value = ''
  testOk.value = ''
  const bad = validate()
  if (bad) {
    note.value = bad
    return
  }
  busy.value = true
  busyKind.value = 'test'
  try {
    const r = await window.lexbench.ai.test({
      id: editingId.value ?? undefined,
      baseUrl: fBaseUrl.value.trim(),
      model: fModel.value.trim(),
      apiKey: fApiKey.value.trim() || undefined
    })
    if (r.ok) testOk.value = r.reply || '（模型已响应）'
    else fail(r.error || '连接失败')
  } catch (e) {
    fail(errText(e))
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  if (busy.value) return
  note.value = ''
  testOk.value = ''
  const bad = validate()
  if (bad) {
    note.value = bad
    return
  }
  busy.value = true
  busyKind.value = 'save'
  try {
    const r = await window.lexbench.ai.saveProfile({
      id: editingId.value ?? undefined,
      name: fName.value.trim(),
      baseUrl: fBaseUrl.value.trim(),
      model: fModel.value.trim(),
      apiKey: fApiKey.value.trim() || undefined
    })
    if (!r.ok) {
      fail(r.error || '保存失败')
      return
    }
    resetForm()
    await load()
    emit('notice', '已保存')
  } catch (e) {
    fail(errText(e))
  } finally {
    busy.value = false
  }
}

async function useProfile(p: AiProfileRow): Promise<void> {
  if (busy.value || p.is_active) return
  busy.value = true
  busyKind.value = 'active'
  try {
    await window.lexbench.ai.setActive(p.id)
    await load()
  } catch (e) {
    fail(errText(e))
  } finally {
    busy.value = false
  }
}

async function confirmDel(): Promise<void> {
  const p = pendingDel.value
  pendingDel.value = null
  if (!p) return
  busy.value = true
  busyKind.value = 'delete'
  try {
    await window.lexbench.ai.deleteProfile(p.id)
    // 删的正是编辑中的档案 → 复位表单，避免把草稿存进已删除的 id
    if (editingId.value === p.id) resetForm()
    await load()
    emit('notice', '已删除')
  } catch (e) {
    fail(errText(e))
  } finally {
    busy.value = false
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.visible || busy.value || pendingDel.value) return
  if (e.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="as-mask" @click.self="close">
      <div class="as-dialog">
        <div class="as-head">
          <span class="as-title">AI 设置</span>
          <button class="as-close" :disabled="busy" @click="close">✕</button>
        </div>

        <div class="as-body">
          <div class="as-info">
            <p>支持 OpenAI 兼容接口（DeepSeek / 智谱 / 通义 / Kimi 等），填服务商给出的接口地址与模型名即可。</p>
            <p>API Key 只存本机数据库，界面仅显示掩码，不会随检索结果外发。</p>
          </div>

          <div class="as-sec">模型档案</div>
          <p v-if="!profiles.length" class="as-empty">
            尚无模型档案，请在下方新建；未配置时法条页的 AI 助手不可用。
          </p>
          <div v-for="p in profiles" :key="p.id" class="as-row">
            <div class="as-row-main">
              <div class="as-row-top">
                <span class="as-row-name">{{ p.name }}</span>
                <span v-if="p.is_active" class="as-badge">当前</span>
                <span class="as-row-model">{{ p.model }}</span>
              </div>
              <div class="as-row-sub">
                {{ p.base_url }} · {{ p.api_key_set ? p.api_key_masked : '未设置密钥' }}
              </div>
            </div>
            <div class="as-row-ops">
              <button
                v-if="!p.is_active"
                class="as-op"
                :disabled="busy"
                title="设为当前使用"
                @click="useProfile(p)"
              >
                设为当前
              </button>
              <button class="as-op" :disabled="busy" @click="editProfile(p)">编辑</button>
              <button class="as-op danger" :disabled="busy" @click="pendingDel = p">删除</button>
            </div>
          </div>

          <div class="as-sec">{{ editing ? '编辑档案' : '新建档案' }}</div>
          <label class="as-field">
            <span class="as-label">档案名称</span>
            <input v-model="fName" class="as-input" type="text" placeholder="如：DeepSeek" :disabled="busy" />
          </label>
          <label class="as-field">
            <span class="as-label">接口地址</span>
            <input
              v-model="fBaseUrl"
              class="as-input"
              type="text"
              placeholder="https://api.deepseek.com/v1"
              :disabled="busy"
            />
          </label>
          <label class="as-field">
            <span class="as-label">模型名</span>
            <input v-model="fModel" class="as-input" type="text" placeholder="deepseek-chat" :disabled="busy" />
          </label>
          <label class="as-field">
            <span class="as-label">API Key</span>
            <input
              v-model="fApiKey"
              class="as-input"
              type="password"
              autocomplete="off"
              :placeholder="editing ? '留空表示不修改' : 'sk-…'"
              :disabled="busy"
            />
          </label>

          <p v-if="testOk" class="as-ok">连接正常：{{ testOk }}</p>
          <p v-if="note" class="as-note">{{ note }}</p>
        </div>

        <div class="as-foot">
          <button class="as-btn" :disabled="busy" @click="testConn">
            {{ busy && busyKind === 'test' ? '测试中…' : '测试连接' }}
          </button>
          <span class="as-flex"></span>
          <button v-if="editing" class="as-btn" :disabled="busy" @click="resetForm">取消编辑</button>
          <button class="as-btn primary" :disabled="busy" @click="save">
            {{ busy && busyKind === 'save' ? '保存中…' : editing ? '保存修改' : '新建档案' }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmModal
      :visible="pendingDel !== null"
      title="删除模型档案"
      :message="delMessage"
      danger
      confirm-text="删除"
      @confirm="confirmDel"
      @cancel="pendingDel = null"
    />
  </Teleport>
</template>

<style scoped>
.as-mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 28, 40, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 低于 ConfirmModal(450)：内嵌确认弹窗要盖在本弹窗之上 */
  z-index: 440;
}

.as-dialog {
  width: 520px;
  max-width: calc(100vw - 40px);
  display: flex;
  flex-direction: column;
  background: var(--lb-panel);
  border-radius: var(--lb-radius-l);
  overflow: hidden;
  box-shadow: 0 12px 36px rgba(24, 28, 55, 0.2);
}

.as-flex {
  flex: 1;
}

.as-head {
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

.as-title {
  font-family: var(--lb-serif);
}

.as-close {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 5px;
}

.as-close:hover:not(:disabled) {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.as-close:disabled {
  opacity: 0.5;
  cursor: default;
}

.as-body {
  padding: 14px 20px 16px;
  overflow-y: auto;
  max-height: 62vh;
}

.as-info {
  padding: 10px 12px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: var(--lb-accent-soft);
  margin-bottom: 14px;
}

.as-info p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--lb-text);
}

.as-info p + p {
  margin-top: 4px;
}

.as-sec {
  font-size: 12px;
  color: var(--lb-muted);
  margin: 0 0 8px;
}

.as-empty {
  margin: 0 0 10px;
  padding: 12px;
  border: 1px dashed var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  font-size: 12px;
  line-height: 1.6;
  color: var(--lb-muted);
  text-align: center;
}

/* ---------- 档案行 ---------- */
.as-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  margin-bottom: 6px;
}

.as-row:hover {
  border-color: var(--lb-border-strong);
}

.as-row-main {
  flex: 1;
  min-width: 0;
}

.as-row-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.as-row-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--lb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.as-badge {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--lb-ok-bg);
  color: var(--lb-ok-fg);
}

.as-row-model {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--lb-muted);
  background: var(--lb-chip);
  padding: 1px 8px;
  border-radius: 999px;
}

.as-row-sub {
  margin-top: 4px;
  font-size: 11px;
  color: var(--lb-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.as-row-ops {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.as-op {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: 6px;
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 12px;
}

.as-op:hover:not(:disabled) {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.as-op.danger:hover:not(:disabled) {
  border-color: #b3352a;
  color: #b3352a;
}

.as-op:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---------- 表单 ---------- */
.as-field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.as-label {
  width: 66px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--lb-muted);
  text-align: right;
}

.as-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-s);
  background: #fbfbfe;
  color: var(--lb-text);
  font-size: 13px;
  outline: none;
}

.as-input:focus {
  border-color: var(--lb-accent-2);
  background: #fff;
}

.as-input:disabled {
  opacity: 0.6;
}

.as-ok {
  margin: 10px 0 0;
  padding: 8px 12px;
  border-radius: var(--lb-radius-s);
  background: var(--lb-ok-bg);
  color: var(--lb-ok-fg);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.as-note {
  margin: 10px 0 0;
  padding: 8px 12px;
  border-radius: var(--lb-radius-s);
  background: var(--lb-err-bg);
  color: var(--lb-err-fg);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.as-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.as-btn {
  height: 36px;
  padding: 0 18px;
  border-radius: var(--lb-radius-s);
  border: 1px solid var(--lb-border-strong);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
}

.as-btn:hover:not(:disabled) {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.as-btn.primary {
  border-color: var(--lb-accent);
  background: var(--lb-grad);
  color: #fff;
}

.as-btn.primary:hover:not(:disabled) {
  filter: brightness(1.06);
  color: #fff;
}

.as-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
