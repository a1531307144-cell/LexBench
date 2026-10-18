<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import AiPanel from './components/AiPanel.vue'
import AiSettingsDialog from './components/AiSettingsDialog.vue'

/**
 * AI 独立窗口壳（main.ts 按 ?aiWindow=1 挂载，替代主应用）：
 * 无边框 + 自绘标题栏——顶栏/品牌区/─□✕ 按钮全部照抄主窗口配方（风格延续红线）。
 * 全窗只有标题栏 + AI 面板 + 档案设置 + 轻量提示条；点引用转主窗口，本窗保持独立。
 */
const showAiSettings = ref(false)
const error = ref('')
const notice = ref('')

let errTimer: ReturnType<typeof setTimeout> | undefined
let noticeTimer: ReturnType<typeof setTimeout> | undefined

/** 自绘标题栏的窗口控制（与主窗口同一套 IPC；主进程按 sender 定位本窗） */
function winMinimize(): void {
  window.lexbench.win.minimize()
}

function winToggleMax(): void {
  window.lexbench.win.toggleMaximize()
}

function winClose(): void {
  window.lexbench.win.close()
}

function showError(e: unknown): void {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  error.value = msg || '操作失败，请稍后重试'
  clearTimeout(errTimer)
  errTimer = setTimeout(() => {
    error.value = ''
  }, 6000)
}

function setNotice(text: string): void {
  notice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 6000)
}

/** 窗内点引用：请主窗口打开对应法条（本窗不关、不跳，保持独立） */
function openArticleInMain(articleId: number): void {
  void window.lexbench.aiWindow.openArticle(articleId).catch((e) => showError(e))
}

onBeforeUnmount(() => {
  clearTimeout(errTimer)
  clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="ai-win">
    <!-- 自绘标题栏：配方逐项照抄主窗口 .topbar（同底色/分隔线/拖拽机制/─□✕ 按钮） -->
    <header class="ai-win-top">
      <div class="ai-win-brand">
        <span class="brand-mark">法</span>
        <span class="brand-name">AI 助手</span>
      </div>
      <div class="win-controls">
        <button class="wc" title="最小化" aria-label="最小化" @click="winMinimize">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="4.6" width="8" height="0.9" fill="currentColor" /></svg>
        </button>
        <button class="wc" title="最大化 / 还原" aria-label="最大化或还原" @click="winToggleMax">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.2" y="1.2" width="7.6" height="7.6" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>
        </button>
        <button class="wc wc-close" title="关闭" aria-label="关闭" @click="winClose">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" /></svg>
        </button>
      </div>
    </header>

    <Transition name="win-bar">
      <div v-if="error" class="win-bar err">
        <span class="win-bar-text">{{ error }}</span>
        <button class="win-bar-close" @click="error = ''">✕</button>
      </div>
    </Transition>
    <Transition name="win-bar">
      <div v-if="notice" class="win-bar ok">
        <span class="win-bar-text">{{ notice }}</span>
        <button class="win-bar-close" @click="notice = ''">✕</button>
      </div>
    </Transition>

    <AiPanel
      @open-article="openArticleInMain"
      @open-settings="showAiSettings = true"
      @error="showError"
      @notice="setNotice"
    />

    <AiSettingsDialog v-model:visible="showAiSettings" @error="showError" @notice="setNotice" />
  </div>
</template>

<style scoped>
.ai-win {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--lb-panel);
}

/* ---------- 自绘标题栏：配方逐项照抄主窗口（浅色导航：与无边框窗口融合） ---------- */
.ai-win-top {
  display: flex;
  align-items: center;
  gap: 18px;
  height: 54px;
  padding: 0 8px 0 20px;
  background: var(--lb-chrome);
  flex-shrink: 0;
  -webkit-app-region: drag; /* 标题栏空白处可拖动窗口（无边框窗口同主窗口机制） */
  position: relative;
}

/* 与主窗顶栏一致：底边两端 32px 渐隐 */
.ai-win-top::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(
    to right,
    transparent 0,
    rgba(0, 0, 0, 0.08) 32px,
    rgba(0, 0, 0, 0.08) calc(100% - 32px),
    transparent 100%
  );
}

/* 栏内可交互元素必须排除拖拽，否则无法点击（同主窗口 .topbar 规则） */
.ai-win-top button {
  -webkit-app-region: no-drag;
}

.ai-win-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--lb-radius-s);
  background: var(--lb-grad);
  color: #fff;
  font-family: var(--lb-serif);
  font-size: 18px;
  font-weight: 600;
}

.brand-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--lb-text);
  letter-spacing: -0.01em;
}

/* ---------- 自绘窗口控制按钮（─□✕，逐项照抄主窗口） ---------- */
.win-controls {
  display: flex;
  align-items: stretch;
  height: 100%;
  margin-left: 2px;
  flex-shrink: 0;
}

.wc {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  border: none;
  background: transparent;
  color: var(--lb-muted);
}

.wc:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--lb-text);
}

.wc:active {
  background: rgba(0, 0, 0, 0.1);
  transform: none; /* 窗口控制按钮不缩放，保持系统感 */
}

.wc.wc-close:hover {
  background: #ff3b30;
  color: #fff;
}

.wc.wc-close:active {
  background: #e03027;
  color: #fff;
}

/* AiPanel 原为中栏条文页底部形态（顶部分隔线+上边距），独立窗里抹掉并撑满可滚 */
.ai-win :deep(.ai) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 0;
  padding: 14px 16px 16px;
  border-top: none;
  display: flex;
  flex-direction: column;
}

/* 输入行钉在窗口底部，历史再长也不用滚到底才能提问 */
.ai-win :deep(.ai-ask) {
  position: sticky;
  bottom: 0;
  margin-top: auto;
  padding-top: 10px;
  background: var(--lb-panel);
}

/* 轻量提示条（配方同主窗口错误/消息条的色彩令牌） */
.win-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px;
  font-size: 12.5px;
}

.win-bar.err {
  background: var(--lb-err-bg);
  color: var(--lb-err-fg);
}

.win-bar.ok {
  background: var(--lb-ok-bg);
  color: var(--lb-ok-fg);
}

.win-bar-text {
  flex: 1;
  min-width: 0;
}

.win-bar-close {
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  font-size: 12px;
  padding: 2px 5px;
  border-radius: var(--lb-radius-xs);
}

.win-bar-close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.06);
}

.win-bar-enter-active,
.win-bar-leave-active {
  transition: opacity 0.18s ease;
}

.win-bar-enter-from,
.win-bar-leave-to {
  opacity: 0;
}
</style>
