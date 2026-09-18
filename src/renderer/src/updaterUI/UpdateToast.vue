<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue'

const state = reactive({
  phase: 'idle' as 'idle' | 'checking' | 'offered' | 'downloading' | 'ready',
  version: '',
  percent: 0,
  transient: '' // 手动检查的一次性提示（几秒后消失）
})

let transientTimer: ReturnType<typeof setTimeout> | undefined

function showTransient(msg: string): void {
  state.transient = msg
  clearTimeout(transientTimer)
  transientTimer = setTimeout(() => {
    state.transient = ''
  }, 3500)
}

function onStatus(s: {
  type: string
  version?: string
  percent?: number
  manual?: boolean
}): void {
  if (s.type === 'checking') {
    if (state.phase === 'idle') state.phase = 'checking'
  } else if (s.type === 'available') {
    // 只提示，等用户决定是否下载
    state.version = s.version ?? ''
    state.phase = 'offered'
  } else if (s.type === 'downloading') {
    state.phase = 'downloading'
    state.percent = s.percent ?? 0
  } else if (s.type === 'downloaded') {
    state.version = s.version ?? ''
    state.phase = 'ready'
  } else if (s.type === 'not-available') {
    if (s.manual) showTransient('当前已是最新版本')
    if (state.phase === 'checking') state.phase = 'idle'
  } else if (s.type === 'error') {
    if (state.phase === 'checking') state.phase = 'idle'
    if (state.phase === 'downloading') {
      state.phase = state.version ? 'offered' : 'idle'
      showTransient('下载更新失败，请稍后重试')
    } else if (s.manual) {
      showTransient('检查更新失败，请稍后重试')
    }
    // 自动检查失败：完全静默
  }
}

/** 提示框点「下载安装」 */
function download(): void {
  state.phase = 'downloading'
  state.percent = 0
  void window.lexbench.update.download()
}

function install(): void {
  void window.lexbench.update.install()
}

function later(): void {
  state.phase = 'idle'
}

onMounted(() => {
  window.lexbench.update.onStatus(onStatus)
})

onBeforeUnmount(() => clearTimeout(transientTimer))
</script>

<template>
  <transition name="up">
    <div v-if="state.phase === 'offered'" class="update-card">
      <div class="update-title">🎉 发现新版本 v{{ state.version }}</div>
      <p class="update-text">是否现在下载？下载完成后你可以选择立即重启安装，或退出软件时自动安装。</p>
      <div class="update-btns">
        <button class="ub plain" @click="later">忽略</button>
        <button class="ub primary" @click="download">下载安装</button>
      </div>
    </div>
  </transition>

  <transition name="up">
    <div v-if="state.phase === 'ready'" class="update-card">
      <div class="update-title">🎉 新版本 v{{ state.version }} 已就绪</div>
      <p class="update-text">退出软件时会自动安装；也可以立即重启完成升级。</p>
      <div class="update-btns">
        <button class="ub plain" @click="later">稍后</button>
        <button class="ub primary" @click="install">重启安装</button>
      </div>
    </div>
  </transition>

  <transition name="up">
    <div v-if="state.phase === 'downloading'" class="update-card mini">
      <span class="dl-text">正在下载新版本 {{ state.version }}… {{ state.percent }}%</span>
      <div class="dl-bar"><div class="dl-fill" :style="{ width: state.percent + '%' }"></div></div>
    </div>
  </transition>

  <transition name="up">
    <div v-if="state.transient" class="update-card mini">{{ state.transient }}</div>
  </transition>
</template>

<style scoped>
.update-card {
  position: fixed;
  right: 22px;
  bottom: 22px;
  width: 320px;
  background: #fff;
  border: 1px solid #e6e6ef;
  border-radius: 12px;
  box-shadow: 0 12px 36px rgba(24, 28, 55, 0.2);
  padding: 16px 18px;
  z-index: 90;
}

.update-card.mini {
  width: auto;
  max-width: 340px;
  padding: 10px 14px;
}

.update-title {
  font-size: 14px;
  font-weight: 600;
  color: #24242e;
}

.update-text {
  margin: 6px 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: #7c7c92;
}

.update-btns {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.ub {
  padding: 6px 14px;
  border-radius: 7px;
  font-size: 13px;
  border: 1px solid transparent;
}

.ub.plain {
  background: #f2f3f8;
  color: #5c5c74;
}

.ub.plain:hover {
  background: #e8e9f2;
}

.ub.primary {
  background: linear-gradient(135deg, #9c3428, #c0483a);
  color: #fff;
}

.dl-text {
  font-size: 12px;
  color: #5c5c74;
}

.dl-bar {
  margin-top: 7px;
  height: 4px;
  border-radius: 2px;
  background: #ececf3;
  overflow: hidden;
}

.dl-fill {
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #9c3428, #c0483a);
  transition: width 0.3s ease;
}

.up-enter-active,
.up-leave-active {
  transition: all 0.22s ease;
}

.up-enter-from,
.up-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
