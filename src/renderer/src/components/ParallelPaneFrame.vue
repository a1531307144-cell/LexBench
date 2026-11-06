<script setup lang="ts">
import type { ParallelPane } from '@shared/types'

const props = withDefaults(
  defineProps<{
    pane: ParallelPane
    title: string
    active?: boolean
    floating?: boolean
    showHeader?: boolean
    closable?: boolean
    maximized?: boolean
    allowSource?: boolean
    /** 浮动态常驻置顶 */
    pinned?: boolean
  }>(),
  {
    active: false,
    floating: false,
    showHeader: true,
    closable: false,
    maximized: false,
    allowSource: false,
    pinned: false
  }
)

const emit = defineEmits<{
  activate: []
  close: []
  maximize: []
  'move-start': [ev: PointerEvent]
  /** dir: n/e/s/w/ne/nw/se/sw */
  'resize-start': [ev: PointerEvent, dir: string]
  'pick-source': []
  'toggle-pin': []
}>()

function onHeadDown(ev: PointerEvent): void {
  if (!props.floating || props.maximized) return
  emit('move-start', ev)
}

function onResizeDown(ev: PointerEvent, dir: string): void {
  if (!props.floating || props.maximized) return
  emit('resize-start', ev, dir)
}

const RESIZE_DIRS = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const
</script>

<template>
  <section
    class="ws-pane"
    :class="{ active, floating, maximized }"
    :data-pane-id="pane.id"
    :data-pane-kind="pane.kind"
    @pointerdown.capture="emit('activate')"
    @focusin="emit('activate')"
    @wheel.passive="emit('activate')"
  >
    <header v-if="showHeader" class="ws-pane-head" @pointerdown="onHeadDown">
      <span class="ws-pane-grip" aria-hidden="true">⠿</span>
      <span class="ws-pane-title" :title="title">{{ title }}</span>
      <div class="ws-pane-acts">
        <button
          v-if="allowSource"
          class="ws-pa"
          title="更换文档"
          @pointerdown.stop
          @click.stop="emit('pick-source')"
        >
          ⇄
        </button>
        <button
          v-if="floating"
          class="ws-pa pin"
          :class="{ on: pinned }"
          :title="pinned ? '取消常驻置顶' : '常驻置顶（不随选中态下沉）'"
          @pointerdown.stop
          @click.stop="emit('toggle-pin')"
        >
          📌
        </button>
        <button
          v-if="floating"
          class="ws-pa"
          :title="maximized ? '还原窗口' : '最大化窗口'"
          @pointerdown.stop
          @click.stop="emit('maximize')"
        >
          {{ maximized ? '❐' : '⛶' }}
        </button>
        <button
          v-if="closable"
          class="ws-pa close"
          title="关闭窗口"
          @pointerdown.stop
          @click.stop="emit('close')"
        >
          ✕
        </button>
      </div>
    </header>
    <div class="ws-pane-body">
      <slot></slot>
    </div>
    <template v-if="floating && !maximized">
      <div
        v-for="dir in RESIZE_DIRS"
        :key="dir"
        class="ws-rz"
        :class="`rz-${dir}`"
        :data-resize="dir"
        title="拖动调整窗口大小"
        @pointerdown.stop="onResizeDown($event, dir)"
      ></div>
    </template>
  </section>
</template>

<style scoped>
.ws-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
  background: var(--lb-panel);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
}

/* 窗口级 z-index 由 ParallelWorkspace 按「常驻 > 选中 > 普通」分配：
   它会让窗内 position:fixed 的搜索框/工具栏跟随所属窗口一起抬层（这正是需要的）。
   仍不要用 transform/filter/contain：那会改变 fixed 的包含块，浮层会错位。 */
.ws-pane.active {
  border-color: var(--lb-accent-2);
}

.ws-pane.floating {
  position: absolute;
  box-shadow: var(--lb-shadow-2);
}

.ws-pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px 0 10px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--lb-border);
  background: var(--lb-panel-2);
  user-select: none;
}

.ws-pane.floating .ws-pane-head {
  cursor: grab;
}

.ws-pane.floating .ws-pane-head:active {
  cursor: grabbing;
}

.ws-pane-grip {
  color: var(--lb-muted);
  font-size: 12px;
  letter-spacing: -1px;
  flex-shrink: 0;
}

/* 分屏模式下窗头不可拖，隐藏抓握点，避免误导 */
.ws-pane:not(.floating) .ws-pane-grip {
  display: none;
}

.ws-pane-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--lb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-pane-acts {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.ws-pa {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--lb-muted);
  font-size: 12px;
  line-height: 1;
}

.ws-pa:hover {
  background: var(--lb-hover);
  color: var(--lb-text);
}

.ws-pa.close:hover {
  background: var(--lb-err-bg);
  color: var(--lb-err-fg);
}

.ws-pa.pin {
  font-size: 10px;
  filter: grayscale(1);
  opacity: 0.65;
}

.ws-pa.pin.on {
  background: var(--lb-accent-soft);
  filter: none;
  opacity: 1;
}

.ws-pane-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  overflow: hidden;
}

.ws-pane-body > * {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* 浮动窗四边 + 四角都可缩放，命中区比视觉线宽，避免"拖不动" */
.ws-rz {
  position: absolute;
  z-index: 6;
  touch-action: none;
}

.ws-rz:hover {
  background: color-mix(in srgb, var(--lb-accent) 18%, transparent);
}

.rz-n,
.rz-s {
  left: 12px;
  right: 12px;
  height: 7px;
  cursor: ns-resize;
}

.rz-n {
  top: -1px;
}

.rz-s {
  bottom: -1px;
}

.rz-e,
.rz-w {
  top: 12px;
  bottom: 12px;
  width: 7px;
  cursor: ew-resize;
}

.rz-e {
  right: -1px;
}

.rz-w {
  left: -1px;
}

.rz-ne,
.rz-nw,
.rz-se,
.rz-sw {
  width: 14px;
  height: 14px;
}

.rz-ne {
  top: -1px;
  right: -1px;
  cursor: nesw-resize;
}

.rz-nw {
  top: -1px;
  left: -1px;
  cursor: nwse-resize;
}

.rz-se {
  right: -1px;
  bottom: -1px;
  cursor: nwse-resize;
}

.rz-sw {
  left: -1px;
  bottom: -1px;
  cursor: nesw-resize;
}

/* 右下角保留可见抓握纹，提示窗口可缩放 */
.rz-se::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 6px;
  height: 6px;
  border-right: 1px solid var(--lb-muted);
  border-bottom: 1px solid var(--lb-muted);
  opacity: 0.6;
}
</style>
