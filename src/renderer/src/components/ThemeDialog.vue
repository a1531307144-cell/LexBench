<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { APP_THEMES } from '@shared/themes'
import { activeThemeId, setTheme } from '../composables/useTheme'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ 'update:visible': [v: boolean] }>()

const lightThemes = APP_THEMES.filter((t) => t.group === 'light')
const darkThemes = APP_THEMES.filter((t) => t.group === 'dark')

const currentName = computed(
  () => APP_THEMES.find((t) => t.id === activeThemeId.value)?.name ?? ''
)

function close(): void {
  emit('update:visible', false)
}

function choose(id: string): void {
  // 点选即时生效并持久化；对话框保持打开，方便来回比对
  setTheme(id)
}

function onKeydown(e: KeyboardEvent): void {
  if (props.visible && e.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg-fade">
      <div v-if="visible" class="th-mask" @click.self="close">
        <div class="th-dialog" role="dialog" aria-label="外观主题">
          <div class="th-head">
            <div>
              <div class="th-title">外观主题</div>
              <div class="th-sub">选一套配色，立即生效并保存到本机</div>
            </div>
            <button class="th-close" title="关闭" @click="close">✕</button>
          </div>

          <div class="th-body">
            <div class="th-group-title">浅色</div>
            <div class="th-grid">
              <button
                v-for="t in lightThemes"
                :key="t.id"
                class="th-card"
                :class="{ on: activeThemeId === t.id }"
                :style="{ background: t.swatches[2] }"
                :aria-pressed="activeThemeId === t.id"
                :title="`使用「${t.name}」配色`"
                @click="choose(t.id)"
              >
                <span class="th-name" :style="{ color: t.vars['--lb-text'] }">{{ t.name }}</span>
                <span class="th-bars">
                  <i class="th-bar lg" :style="{ background: t.swatches[0] }"></i>
                  <i class="th-bar" :style="{ background: t.swatches[1], borderColor: t.vars['--lb-border'] }"></i>
                  <i class="th-bar sm" :style="{ background: t.vars['--lb-chip'] }"></i>
                </span>
                <span v-if="activeThemeId === t.id" class="th-check">✓</span>
              </button>
            </div>

            <div class="th-group-title dark">深色</div>
            <div class="th-grid">
              <button
                v-for="t in darkThemes"
                :key="t.id"
                class="th-card"
                :class="{ on: activeThemeId === t.id }"
                :style="{ background: t.swatches[2] }"
                :aria-pressed="activeThemeId === t.id"
                :title="`使用「${t.name}」配色`"
                @click="choose(t.id)"
              >
                <span class="th-name" :style="{ color: t.vars['--lb-text'] }">{{ t.name }}</span>
                <span class="th-bars">
                  <i class="th-bar lg" :style="{ background: t.swatches[0] }"></i>
                  <i class="th-bar" :style="{ background: t.swatches[1], borderColor: t.vars['--lb-border-strong'] }"></i>
                  <i class="th-bar sm" :style="{ background: t.vars['--lb-chip'] }"></i>
                </span>
                <span v-if="activeThemeId === t.id" class="th-check">✓</span>
              </button>
            </div>
          </div>

          <div class="th-foot">
            <span class="th-hint">当前主题：{{ currentName }}</span>
            <button class="th-done" @click="close">完成</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.th-mask {
  position: fixed;
  inset: 0;
  background: var(--lb-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 440;
}

.th-dialog {
  width: 600px;
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

.th-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 12px;
  flex-shrink: 0;
}

.th-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--lb-text);
}

.th-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--lb-muted);
}

.th-close {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--lb-radius-xs);
  background: var(--lb-chip);
  color: var(--lb-muted);
  font-size: 13px;
  flex-shrink: 0;
}

.th-close:hover {
  color: var(--lb-text);
}

.th-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 20px 4px;
}

.th-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--lb-muted);
  margin: 4px 0 8px;
}

.th-group-title.dark {
  margin-top: 16px;
}

.th-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

/* 主题卡：卡面直接用该主题自身的底色/文字色预览，不随当前主题变化 */
.th-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 11px 12px 12px;
  border: 2px solid var(--lb-border);
  border-radius: var(--lb-radius-s);
  text-align: left;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.th-card:hover {
  border-color: var(--lb-accent-2);
  transform: translateY(-1px);
  box-shadow: var(--lb-shadow-1);
}

.th-card.on {
  border-color: var(--lb-accent);
}

.th-name {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.th-bars {
  display: flex;
  align-items: center;
  gap: 5px;
}

.th-bar {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 1px solid transparent;
  border-radius: 5px;
}

.th-bar.lg {
  width: 34px;
}

.th-bar.sm {
  opacity: 0.75;
}

.th-check {
  position: absolute;
  top: 7px;
  right: 8px;
  width: 17px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--lb-accent);
  color: var(--lb-on-accent);
  font-size: 10px;
  line-height: 1;
}

.th-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--lb-border);
  flex-shrink: 0;
}

.th-hint {
  font-size: 12px;
  color: var(--lb-muted);
}

.th-done {
  height: 34px;
  padding: 0 20px;
  border: 1px solid var(--lb-accent);
  border-radius: var(--lb-radius-s);
  background: var(--lb-grad);
  color: var(--lb-on-accent);
  font-size: 13px;
}

.th-done:hover {
  filter: brightness(1.06);
}
</style>
