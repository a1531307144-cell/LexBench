<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { UpdateStatus } from '@shared/ipc'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  'update:visible': [v: boolean]
  error: [message: string]
}>()

const version = ref('')
/** 上次自动检查更新是否失败（失败时提示可能是网络问题，避免误以为没有新版） */
const lastAutoCheckFailed = ref(false)

type Phase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error' | 'dev'
const phase = ref<Phase>('idle')
const remoteVersion = ref('')
const percent = ref(0)

let unsubscribe: (() => void) | undefined

function onStatus(s: UpdateStatus): void {
  if (s.type === 'checking') {
    phase.value = 'checking'
  } else if (s.type === 'available') {
    remoteVersion.value = s.version
    phase.value = 'available'
  } else if (s.type === 'not-available') {
    // 自动检查的「无新版本」不进对话框状态，只有手动检查才显示
    if (s.manual) phase.value = 'latest'
    else if (phase.value === 'checking') phase.value = 'idle'
  } else if (s.type === 'downloading') {
    percent.value = s.percent
    phase.value = 'downloading'
  } else if (s.type === 'downloaded') {
    remoteVersion.value = s.version
    phase.value = 'ready'
  } else if (s.type === 'error') {
    // 自动检查失败：仅记在「上次自动检查」小字里，不打扰
    if (s.manual) phase.value = 'error'
    else if (phase.value === 'checking') phase.value = 'idle'
  } else if (s.type === 'dev-mode') {
    phase.value = 'dev'
  }
}

async function check(): Promise<void> {
  phase.value = 'checking'
  lastAutoCheckFailed.value = false
  try {
    await window.lexbench.update.check()
  } catch (e) {
    phase.value = 'error'
    emit('error', e instanceof Error ? e.message : String(e))
  }
}

async function download(): Promise<void> {
  phase.value = 'downloading'
  percent.value = 0
  try {
    await window.lexbench.update.download()
  } catch (e) {
    phase.value = 'error'
    emit('error', e instanceof Error ? e.message : String(e))
  }
}

async function install(): Promise<void> {
  try {
    await window.lexbench.update.install()
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}

async function loadInfo(): Promise<void> {
  phase.value = 'idle'
  percent.value = 0
  remoteVersion.value = ''
  try {
    version.value = await window.lexbench.app.getVersion()
  } catch {
    version.value = ''
  }
  try {
    const info = await window.lexbench.update.getCheckInfo()
    lastAutoCheckFailed.value = info.lastAutoCheckFailed
  } catch {
    lastAutoCheckFailed.value = false
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) void loadInfo()
  }
)

onMounted(() => {
  // 订阅更新状态；卸载时必须退订（防监听器泄漏）
  unsubscribe = window.lexbench.update.onStatus(onStatus)
})

onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div v-if="visible" class="ab-mask" @click.self="emit('update:visible', false)">
    <div class="ab-dialog">
      <div class="ab-body">
        <div class="ab-brand">
          <span class="ab-mark">法</span>
          <div>
            <div class="ab-name">法研台 <span class="ab-en">LexBench</span></div>
            <div class="ab-ver">当前版本 v{{ version || '…' }}</div>
          </div>
        </div>

        <p class="ab-desc">本地优先的个人法律研究工作台 —— 文档、笔记与配置全部保存在本机。</p>

        <!-- 更新状态区 -->
        <div class="ab-status">
          <template v-if="phase === 'checking'"><span class="ab-dot busy"></span>正在检查更新…</template>
          <template v-else-if="phase === 'latest'"><span class="ab-dot ok"></span>当前已是最新版本</template>
          <template v-else-if="phase === 'available'">
            <span class="ab-dot new"></span>发现新版本 v{{ remoteVersion }}
          </template>
          <template v-else-if="phase === 'downloading'">
            <span class="ab-dot busy"></span>正在下载 v{{ remoteVersion }} … {{ percent }}%
          </template>
          <template v-else-if="phase === 'ready'">
            <span class="ab-dot ok"></span>新版本 v{{ remoteVersion }} 已下载，可重启安装
          </template>
          <template v-else-if="phase === 'error'">
            <span class="ab-dot err"></span>检查更新失败，请稍后重试
          </template>
          <template v-else-if="phase === 'dev'">
            <span class="ab-dot"></span>开发版不检查更新（安装版会自动检查）
          </template>
          <template v-else>
            <span class="ab-dot"></span>软件启动后会自动检查一次；发现新版本时只提示，由你决定是否下载
          </template>
        </div>

        <p v-if="lastAutoCheckFailed" class="ab-warn">
          上次自动检查更新失败（可能是网络问题），可以点「检查更新」再试一次。
        </p>

        <div class="ab-dl" v-if="phase === 'downloading'">
          <div class="ab-dl-fill" :style="{ width: percent + '%' }"></div>
        </div>
      </div>

      <div class="ab-foot">
        <button class="ab-btn plain" @click="emit('update:visible', false)">关闭</button>
        <span class="ab-flex"></span>
        <button
          v-if="phase === 'available'"
          class="ab-btn primary"
          @click="download"
        >
          下载安装
        </button>
        <button v-else-if="phase === 'ready'" class="ab-btn primary" @click="install">重启安装</button>
        <button
          v-else
          class="ab-btn primary"
          :disabled="phase === 'checking' || phase === 'downloading'"
          @click="check"
        >
          {{ phase === 'checking' ? '检查中…' : '检查更新' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ab-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 440;
}

.ab-dialog {
  width: 420px;
  max-width: calc(100vw - 40px);
  background: var(--lb-panel);
  border-radius: var(--lb-radius-l);
  overflow: hidden;
  box-shadow: 0 12px 36px rgba(24, 28, 55, 0.2);
}

.ab-body {
  padding: 20px 22px 6px;
}

.ab-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ab-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: var(--lb-accent);
  color: #fff;
  font-size: 21px;
  font-weight: 700;
}

.ab-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--lb-text);
}

.ab-en {
  font-size: 12px;
  font-weight: 400;
  color: var(--lb-muted);
  margin-left: 4px;
}

.ab-ver {
  font-size: 12px;
  color: var(--lb-muted);
  margin-top: 3px;
}

.ab-desc {
  margin: 14px 0 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--lb-muted);
}

.ab-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--lb-text);
  padding: 10px 12px;
  background: var(--lb-bg);
  border-radius: var(--lb-radius-s);
}

.ab-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--lb-muted);
  flex-shrink: 0;
}

.ab-dot.ok {
  background: #34c759;
}

.ab-dot.new {
  background: var(--lb-accent);
}

.ab-dot.err {
  background: #ff3b30;
}

.ab-dot.busy {
  background: var(--lb-accent);
  animation: abPulse 1s ease-in-out infinite;
}

@keyframes abPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.ab-warn {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--lb-warn-fg);
}

.ab-dl {
  margin-top: 10px;
  height: 4px;
  border-radius: 2px;
  background: var(--lb-chip, #e8e8ed);
  overflow: hidden;
}

.ab-dl-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--lb-accent);
  transition: width 0.3s ease;
}

.ab-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 22px 18px;
}

.ab-flex {
  flex: 1;
}

.ab-btn {
  padding: 7px 16px;
  border-radius: 8px;
  font-size: 13px;
  border: 1px solid transparent;
}

.ab-btn.plain {
  background: var(--lb-chip, #e8e8ed);
  color: var(--lb-text);
}

.ab-btn.primary {
  background: var(--lb-accent);
  color: #fff;
}

.ab-btn.primary:disabled {
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .ab-dot.busy { animation: none; }
  .ab-dl-fill { transition: none; }
}
</style>
