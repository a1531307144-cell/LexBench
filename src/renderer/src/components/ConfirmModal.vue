<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    visible: boolean
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    /** 危险操作（如删除）使用红色确认键 */
    danger?: boolean
  }>(),
  {
    confirmText: '确认',
    cancelText: '取消',
    danger: false
  }
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

function confirm(): void {
  emit('confirm')
}

function cancel(): void {
  emit('cancel')
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.visible) return
  if (e.key === 'Escape') cancel()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <transition name="cm-fade">
      <div v-if="visible" class="cm-mask" @click.self="cancel">
        <div class="cm-dialog">
          <div class="cm-title">{{ title }}</div>
          <p class="cm-message">{{ message }}</p>
          <div class="cm-btns">
            <button class="cm-btn" @click="cancel">{{ cancelText }}</button>
            <button class="cm-btn confirm" :class="{ danger }" @click="confirm">
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.cm-mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 28, 40, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 450;
}

.cm-dialog {
  width: 400px;
  max-width: calc(100vw - 60px);
  background: var(--lb-panel);
  border-radius: var(--lb-radius-l);
  padding: 20px 22px;
  box-shadow: 0 12px 36px rgba(24, 28, 55, 0.2);
}

.cm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--lb-text);
}

.cm-message {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--lb-muted);
}

.cm-btns {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.cm-btn {
  height: 34px;
  padding: 0 18px;
  border-radius: var(--lb-radius-s);
  border: 1px solid var(--lb-border-strong);
  background: var(--lb-panel);
  color: var(--lb-text);
  font-size: 13px;
}

.cm-btn:hover {
  background: #f2f3f8;
}

.cm-btn.confirm {
  border-color: var(--lb-accent);
  background: var(--lb-grad);
  color: #fff;
}

.cm-btn.confirm:hover {
  filter: brightness(1.06);
}

/* 危险操作：更深的红色确认键 */
.cm-btn.confirm.danger {
  border-color: #a52f21;
  background: #b3352a;
}

.cm-btn.confirm.danger:hover {
  background: #9c2f24;
  filter: none;
}

.cm-fade-enter-active,
.cm-fade-leave-active {
  transition: opacity 0.18s ease;
}

.cm-fade-enter-from,
.cm-fade-leave-to {
  opacity: 0;
}
</style>
