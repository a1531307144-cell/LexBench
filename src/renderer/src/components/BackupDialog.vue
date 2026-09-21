<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmModal from './ConfirmModal.vue'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  'update:visible': [v: boolean]
  /** 所有失败进 App 全局错误条 */
  error: [message: string]
  /** 正向提示（导入完成暂不重启等），走 App 消息条 */
  notice: [text: string]
}>()

const busy = ref(false)
const busyKind = ref<'export' | 'import' | 'restart'>('export')
/** 导出成功后的保存路径（弹窗内绿色提示展示） */
const exportedPath = ref('')
/** 导出成功的绿色提示展示期内暂禁关闭（数秒后可关），避免误触看不到路径 */
const locked = ref(false)
/** 导入前的覆盖警告确认弹窗 */
const confirmImport = ref(false)
/** 导入完成、暂存写入完毕，需重启软件生效 */
const needsRestart = ref(false)

let unlockTimer: ReturnType<typeof setTimeout> | undefined

const busyText = computed(() => {
  if (busyKind.value === 'export') return '正在导出数据包，原件较多时需要稍等，请勿关闭软件…'
  if (busyKind.value === 'restart') return '正在重启软件…'
  return '正在导入数据包，数据量较大时需要稍等，请勿关闭软件…'
})

// 每次打开复位状态，避免残留上一次的提示/重启态
watch(
  () => props.visible,
  (open) => {
    if (!open) return
    busy.value = false
    busyKind.value = 'export'
    exportedPath.value = ''
    locked.value = false
    confirmImport.value = false
    needsRestart.value = false
    clearTimeout(unlockTimer)
  }
)

function close(): void {
  if (busy.value || locked.value) return
  emit('update:visible', false)
}

// ---------- 导出 ----------

async function doExport(): Promise<void> {
  if (busy.value) return
  busy.value = true
  busyKind.value = 'export'
  try {
    const r = await window.lexbench.backup.exportAll()
    if (r.canceled) return
    exportedPath.value = r.path ?? ''
    if (exportedPath.value) {
      locked.value = true
      clearTimeout(unlockTimer)
      unlockTimer = setTimeout(() => {
        locked.value = false
      }, 4000)
    }
  } catch (e) {
    emit('error', errText(e))
  } finally {
    busy.value = false
  }
}

// ---------- 导入 ----------

function askImport(): void {
  if (busy.value) return
  confirmImport.value = true
}

async function doImport(): Promise<void> {
  confirmImport.value = false
  if (busy.value) return
  busy.value = true
  busyKind.value = 'import'
  try {
    const r = await window.lexbench.backup.importAll()
    if (r.canceled) return
    if (r.needsRestart) {
      needsRestart.value = true
    } else {
      // 边界兜底：极少数情况下主进程无需重启即已生效，直接提示并关闭
      emit('notice', '数据包已导入，重启软件后生效')
      emit('update:visible', false)
    }
  } catch (e) {
    emit('error', errText(e))
  } finally {
    busy.value = false
  }
}

// ---------- 重启生效 ----------

async function restartNow(): Promise<void> {
  if (busy.value) return
  busy.value = true
  busyKind.value = 'restart'
  try {
    await window.lexbench.app.relaunch()
    // 主进程即将退出重启，保持 busy 阻塞重复点击
  } catch (e) {
    busy.value = false
    emit('error', errText(e))
  }
}

/** 稍后重启：走 App 消息条提醒数据已导入 */
function restartLater(): void {
  emit('notice', '数据包已导入，重启软件后生效')
  emit('update:visible', false)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.visible || busy.value || locked.value || confirmImport.value) return
  if (e.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(unlockTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg-fade">
      <div v-if="visible" class="bd-mask" @click.self="close">
        <div class="bd-dialog">
        <div class="bd-head">
          <span class="bd-title">数据备份</span>
          <button class="bd-close" :disabled="busy || locked" @click="close">✕</button>
        </div>

        <div class="bd-body">
          <template v-if="!needsRestart">
            <div class="bd-info">
              <p>数据包 = 数据库 + 全部文档原件 + AI 配置，换电脑迁移与日常备份两用。</p>
              <p>数据包为明文文件，请妥善保管，避免泄露。</p>
            </div>

            <p v-if="exportedPath" class="bd-tip-ok">已导出到 {{ exportedPath }}</p>

            <p v-if="busy" class="bd-busy">{{ busyText }}</p>

            <div class="bd-actions">
              <button class="bd-btn primary" :disabled="busy" @click="doExport">
                {{ busy && busyKind === 'export' ? '导出中…' : '导出数据包' }}
              </button>
              <button class="bd-btn" :disabled="busy" @click="askImport">
                {{ busy && busyKind === 'import' ? '导入中…' : '导入数据包' }}
              </button>
            </div>
          </template>

          <template v-else>
            <p class="bd-restart-msg">导入完成，重启软件生效。</p>
            <div class="bd-actions">
              <button class="bd-btn" :disabled="busy" @click="restartLater">稍后</button>
              <button class="bd-btn primary" :disabled="busy" @click="restartNow">
                {{ busy ? '重启中…' : '立即重启' }}
              </button>
            </div>
          </template>
        </div>
      </div>
      </div>
    </Transition>

    <ConfirmModal
      :visible="confirmImport"
      title="导入数据包"
      message="导入将覆盖当前全部数据。当前数据会先自动备份到本机 backups 目录，可随时找回。确定继续？"
      danger
      confirm-text="确定继续"
      @confirm="doImport"
      @cancel="confirmImport = false"
    />
  </Teleport>
</template>

<style scoped>
.bd-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 需低于 ConfirmModal(450)：内嵌的导入确认弹窗要盖在本弹窗之上 */
  z-index: 440;
}

.bd-dialog {
  width: 420px;
  max-width: calc(100vw - 40px);
  display: flex;
  flex-direction: column;
  background: var(--lb-panel);
  border-radius: var(--lb-radius-l);
  overflow: hidden;
  box-shadow: 0 12px 36px rgba(24, 28, 55, 0.2);
}

.bd-head {
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

.bd-title {
  font-family: var(--lb-serif);
}

.bd-close {
  border: none;
  background: none;
  color: var(--lb-muted);
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 5px;
}

.bd-close:hover:not(:disabled) {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.bd-close:disabled {
  opacity: 0.5;
  cursor: default;
}

.bd-body {
  padding: 16px 20px 20px;
}

.bd-info {
  padding: 10px 12px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  background: var(--lb-accent-soft);
  margin-bottom: 14px;
}

.bd-info p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--lb-text);
}

.bd-info p + p {
  margin-top: 4px;
}

.bd-tip-ok {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--lb-radius-s);
  background: var(--lb-ok-bg);
  color: var(--lb-ok-fg);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}

.bd-busy {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--lb-warn-fg);
}

.bd-restart-msg {
  margin: 4px 0 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--lb-text);
}

.bd-actions {
  display: flex;
  gap: 10px;
}

.bd-btn {
  flex: 1;
  height: 36px;
  padding: 0 16px;
  border-radius: var(--lb-radius-s);
  border: 1px solid var(--lb-border-strong);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
}

.bd-btn:hover:not(:disabled) {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.bd-btn.primary {
  border-color: var(--lb-accent);
  background: var(--lb-grad);
  color: #fff;
}

.bd-btn.primary:hover:not(:disabled) {
  filter: brightness(1.06);
  color: #fff;
}

.bd-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
