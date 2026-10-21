<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GuideStep } from '../guide/guideSteps'

/**
 * 首启/回放的使用指引：聚光灯 + 说明卡。
 * 只负责「指哪里、讲什么」，切视图/开文档/建示例笔记由 App.vue 编排；
 * 高亮区可穿透点击（interactive），其余区域用透明挡板拦住，避免指引期间误操作。
 */
const props = defineProps<{
  mode: 'closed' | 'welcome' | 'tour'
  steps: GuideStep[]
  index: number
  seededCount?: number
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'skip'): void
  (e: 'next'): void
  (e: 'prev'): void
  (e: 'cta'): void
  (e: 'finish'): void
}>()

interface Hole {
  x: number
  y: number
  w: number
  h: number
}

const hole = ref<Hole | null>(null)
const tipEl = ref<HTMLElement | null>(null)
const primaryRef = ref<HTMLElement | null>(null)
const tipStyle = ref<Record<string, string>>({})
const tipReady = ref(false)
const viewport = ref({ w: 0, h: 0 })

let retryTimer: ReturnType<typeof setTimeout> | undefined
let retries = 0
let advancePending = false
/** 防止「点目标前进」与「下一步」在 260ms 窗口内叠加，连跳两步 */
let navLock = false
let navUnlockTimer: ReturnType<typeof setTimeout> | undefined
let ro: ResizeObserver | null = null
let observed: Element | null = null

const step = computed(() => (props.mode === 'tour' ? (props.steps[props.index] ?? null) : null))
const isWelcome = computed(() => props.mode === 'welcome')
const isFinish = computed(() => step.value?.id === 'finish')
const isLast = computed(() => props.index >= props.steps.length - 1)
/** 目标还没量到（异步开文档/建笔记）时，说明卡先居中，量到后再吸到目标旁 */
const showCentered = computed(() => !hole.value)

const dim = computed(() => String(step.value?.dim ?? 0.46))
const layerStyle = computed<Record<string, string>>(() => ({ '--guide-dim': dim.value }))

const holeStyle = computed<Record<string, string>>(() => {
  const h = hole.value
  if (!h) return {}
  return {
    left: `${Math.round(h.x)}px`,
    top: `${Math.round(h.y)}px`,
    width: `${Math.round(h.w)}px`,
    height: `${Math.round(h.h)}px`,
    '--guide-dim': dim.value
  }
})

/**
 * 压暗层用一整块 fixed + clip-path(evenodd) 挖洞：
 * 地图/画布这类被提升成独立合成层的区域，四块挡板可能出现「击穿」，
 * 单层裁剪能稳定盖住所有内容；被裁掉的洞不接收点击，正好让目标可交互。
 */
const dimStyle = computed<Record<string, string>>(() => {
  const h = hole.value
  if (!h) return {}
  const { w: vw, h: vh } = viewport.value
  const pts = [
    `0 0`,
    `${vw}px 0`,
    `${vw}px ${vh}px`,
    `0 ${vh}px`,
    `0 0`,
    `${h.x}px ${h.y}px`,
    `${h.x}px ${h.y + h.h}px`,
    `${h.x + h.w}px ${h.y + h.h}px`,
    `${h.x + h.w}px ${h.y}px`,
    `${h.x}px ${h.y}px`
  ].join(', ')
  return { clipPath: `polygon(evenodd, ${pts})` }
})

function clearObserve(): void {
  ro?.disconnect()
  ro = null
  observed = null
}

function observe(el: Element): void {
  if (observed === el) return
  clearObserve()
  observed = el
  ro = new ResizeObserver(() => {
    if (props.mode === 'tour') measure()
  })
  ro.observe(el)
}

function measure(): boolean {
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
  if (props.mode !== 'tour' || !step.value?.target) {
    hole.value = null
    tipReady.value = false
    clearObserve()
    return true
  }
  const el = document.querySelector(step.value.target)
  if (!el) {
    hole.value = null
    // 目标还在异步渲染：先让说明卡停在居中态，量到后再吸附
    tipReady.value = true
    return false
  }
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) {
    hole.value = null
    tipReady.value = true
    return false
  }
  const pad = 6
  const x = Math.max(0, r.left - pad)
  const y = Math.max(0, r.top - pad)
  const w = Math.min(window.innerWidth - x, r.width + pad * 2)
  const h = Math.min(window.innerHeight - y, r.height + pad * 2)
  hole.value = { x, y, w, h }
  observe(el)
  void nextTick(placeTip)
  return true
}

function scheduleMeasure(): void {
  if (props.mode !== 'tour') return
  if (retries++ > 40) {
    // 目标一直没出现（例如被删/窗口极小）：让说明卡停在居中态，别把用户卡在暗屏里
    return
  }
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    if (!measure()) scheduleMeasure()
  }, 120)
}

function placeTip(): void {
  const tip = tipEl.value
  if (!tip) return
  const h = hole.value
  if (!h) {
    tipReady.value = true
    return
  }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = 16
  const gap = 14
  const tw = tip.offsetWidth
  const th = tip.offsetHeight
  const flip: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  const can: Record<string, boolean> = {
    top: h.y >= th + gap + margin,
    bottom: vh - (h.y + h.h) >= th + gap + margin,
    left: h.x >= tw + gap + margin,
    right: vw - (h.x + h.w) >= tw + gap + margin
  }
  let p = step.value?.placement ?? 'bottom'
  if (!can[p]) {
    const alt = flip[p]
    if (alt && can[alt]) p = alt
    else {
      const fit = ['bottom', 'top', 'right', 'left'].find((k) => can[k])
      p = fit ?? 'bottom'
    }
  }
  let x = 0
  let y = 0
  if (p === 'top') {
    x = h.x + h.w / 2 - tw / 2
    y = h.y - th - gap
  } else if (p === 'left') {
    x = h.x - tw - gap
    y = h.y + h.h / 2 - th / 2
  } else if (p === 'right') {
    x = h.x + h.w + gap
    y = h.y + h.h / 2 - th / 2
  } else {
    x = h.x + h.w / 2 - tw / 2
    y = h.y + h.h + gap
  }
  // 顶部 64px 留给顶栏：说明卡不要压住窗口拖动区/品牌与检索框
  const minTop = 64
  x = Math.min(Math.max(margin, x), Math.max(margin, vw - tw - margin))
  y = Math.min(Math.max(minTop, y), Math.max(minTop, vh - th - margin))
  tipStyle.value = { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` }
  tipReady.value = true
}

function nav(action: 'next' | 'prev' | 'finish' | 'cta'): void {
  if (props.mode !== 'tour' || navLock) return
  navLock = true
  // 若这一步的编排失败（例如示例笔记没建出来），1.5s 后允许重试，别把用户锁死
  clearTimeout(navUnlockTimer)
  navUnlockTimer = setTimeout(() => {
    navLock = false
  }, 1500)
  emit(action)
}

function resetMeasure(): void {
  clearTimeout(retryTimer)
  clearTimeout(navUnlockTimer)
  retries = 0
  advancePending = false
  navLock = false
  clearObserve()
  hole.value = null
  tipStyle.value = {}
  tipReady.value = false
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
  if (props.mode === 'tour') {
    void nextTick(() => {
      if (!measure()) scheduleMeasure()
    })
  }
}

function onResize(): void {
  if (props.mode === 'tour') {
    if (!measure()) scheduleMeasure()
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t instanceof HTMLElement ? t : null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function onKeydown(ev: KeyboardEvent): void {
  if (props.mode === 'closed') return
  if (ev.key === 'Escape') {
    ev.preventDefault()
    ev.stopPropagation()
    emit('skip')
    return
  }
  if (isWelcome.value) return
  if (isTypingTarget(ev.target)) return
  const active = document.activeElement
  const onGuideControl =
    active instanceof HTMLElement && !!active.closest('.guide-tip, .guide-card')
  // 按钮自己的 Enter/空格由浏览器处理，避免双触发；但方向键要留给指引导航
  if (onGuideControl && (ev.key === 'Enter' || ev.key === ' ')) return
  if (ev.key === 'ArrowRight' || ev.key === 'Enter') {
    ev.preventDefault()
    ev.stopPropagation()
    if (isLast.value) emit('finish')
    else emit('next')
  } else if (ev.key === 'ArrowLeft') {
    ev.preventDefault()
    ev.stopPropagation()
    if (props.index > 0) emit('prev')
  }
}

/** 点高亮目标本身前进（用于「文档库 / 笔记」这类点一下就能继续的步骤） */
function onDocClick(ev: MouseEvent): void {
  const s = step.value
  if (props.mode !== 'tour' || !s?.advanceOnTargetClick || !s.target) return
  const t = ev.target
  if (!(t instanceof Element)) return
  if (t.closest('.guide-tip, .guide-card, .guide-dim, .guide-scrim')) return
  if (!t.closest(s.target)) return
  if (advancePending) return
  advancePending = true
  setTimeout(() => {
    advancePending = false
    nav('next')
  }, 260)
}

function onScroll(): void {
  if (props.mode === 'tour' && hole.value) measure()
}

watch([() => props.mode, () => props.index], async () => {
  resetMeasure()
  await nextTick()
  const active = document.activeElement
  const focusFree =
    !active ||
    active === document.body ||
    active === document.documentElement ||
    (active instanceof HTMLElement && !!active.closest('.guide-tip, .guide-card'))
  if (focusFree) primaryRef.value?.focus()
})

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onScroll, true)
  document.addEventListener('click', onDocClick, true)
  resetMeasure()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', onScroll, true)
  document.removeEventListener('click', onDocClick, true)
  clearTimeout(retryTimer)
  clearTimeout(navUnlockTimer)
  clearObserve()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="mode !== 'closed'" class="guide-layer" :style="layerStyle" @click.stop>
      <!-- 欢迎卡：首次启动 -->
      <template v-if="isWelcome">
        <div class="guide-scrim" @click.stop></div>
        <section
          class="guide-card guide-welcome"
          role="dialog"
          aria-modal="true"
          aria-labelledby="guide-welcome-title"
          @click.stop
        >
          <div class="guide-brand">
            <span class="guide-mark">法</span>
            <div>
              <div class="guide-name">法研台 <span>LexBench</span></div>
              <div class="guide-tagline">本地优先的个人法律研究工作台</div>
            </div>
          </div>
          <h2 id="guide-welcome-title">欢迎使用</h2>
          <p class="guide-copy">
            文档、笔记与 API 密钥都保存在本机。用文档库读法条，用大纲和导图整理研究，需要时再叫出 AI 助手。
          </p>
          <ul class="guide-points">
            <li v-if="seededCount && seededCount > 0">
              <span class="guide-tick">✓</span>已预置 {{ seededCount }} 部常用法律与司法解释
            </li>
            <li><span class="guide-tick">✓</span>全部数据留在本机，不上传云端</li>
            <li><span class="guide-tick">✓</span>9 步快速上手，大约 2 分钟</li>
          </ul>
          <div class="guide-actions">
            <button ref="primaryRef" class="guide-btn primary" @click="emit('start')">开始快速上手</button>
            <button class="guide-btn plain" @click="emit('skip')">跳过</button>
          </div>
          <p class="guide-esc">按 Esc 也可以跳过</p>
        </section>
      </template>

      <!-- 完成卡 -->
      <template v-else-if="isFinish">
        <div class="guide-scrim" @click.stop></div>
        <section
          class="guide-card guide-finish"
          role="dialog"
          aria-modal="true"
          aria-labelledby="guide-finish-title"
          @click.stop
        >
          <span class="guide-check">✓</span>
          <h2 id="guide-finish-title">{{ step?.title }}</h2>
          <p class="guide-copy">{{ step?.body }}</p>
          <div class="guide-actions center">
            <button ref="primaryRef" class="guide-btn primary" @click="nav('finish')">完成</button>
          </div>
        </section>
      </template>

      <!-- 分步说明 -->
      <template v-else>
        <div class="guide-dim" :style="dimStyle" @click.stop></div>
        <template v-if="hole">
          <div class="guide-hole" :style="holeStyle"></div>
          <div v-if="!step?.interactive" class="guide-catcher" :style="holeStyle" @click.stop></div>
        </template>

        <section
          ref="tipEl"
          class="guide-tip"
          :class="{ ready: tipReady, center: showCentered }"
          :style="showCentered ? {} : tipStyle"
          role="dialog"
          aria-modal="true"
          aria-labelledby="guide-step-title"
          @click.stop
        >
          <div class="guide-tip-head">
            <span class="guide-kicker">使用指引</span>
            <span class="guide-count">{{ index + 1 }} / {{ steps.length }}</span>
          </div>
          <h3 id="guide-step-title">{{ step?.title }}</h3>
          <p class="guide-copy">{{ step?.body }}</p>
          <div class="guide-dots" aria-hidden="true">
            <i v-for="(s, i) in steps" :key="s.id" :class="{ on: i === index }"></i>
          </div>
          <div class="guide-actions">
            <button class="guide-btn text" @click="emit('skip')">跳过指引</button>
            <span class="guide-spacer"></span>
            <button v-if="index > 0" class="guide-btn plain" @click="nav('prev')">上一步</button>
            <button
              v-if="step?.cta"
              ref="primaryRef"
              class="guide-btn primary"
              @click="nav('cta')"
            >
              {{ step.cta }}
            </button>
            <button
              v-else
              ref="primaryRef"
              class="guide-btn primary"
              @click="nav(isLast ? 'finish' : 'next')"
            >
              {{ isLast ? '完成' : '下一步' }}
            </button>
          </div>
        </section>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.guide-layer {
  position: fixed;
  inset: 0;
  z-index: 1190;
  pointer-events: none;
  font-family: inherit;
}

.guide-scrim {
  position: absolute;
  inset: 0;
  z-index: 1198;
  pointer-events: auto;
  background: rgba(15, 17, 23, var(--guide-dim, 0.46));
}

.guide-dim {
  position: fixed;
  inset: 0;
  z-index: 1199;
  pointer-events: auto;
  background: rgba(15, 17, 23, var(--guide-dim, 0.46));
  transition: clip-path 0.24s ease;
}

.guide-hole {
  position: fixed;
  z-index: 1200;
  pointer-events: none;
  border: 2px solid rgba(0, 113, 227, 0.92);
  border-radius: 12px;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.2);
  transition:
    left 0.24s ease,
    top 0.24s ease,
    width 0.24s ease,
    height 0.24s ease;
}

.guide-catcher {
  position: fixed;
  z-index: 1201;
  pointer-events: auto;
}

.guide-tip {
  position: fixed;
  z-index: 1210;
  width: 336px;
  max-width: calc(100vw - 32px);
  padding: 15px 18px 14px;
  box-sizing: border-box;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-l);
  corner-shape: var(--lb-corner-shape);
  background: var(--lb-panel);
  box-shadow: var(--lb-shadow-3);
  opacity: 0;
  pointer-events: auto;
  transition:
    left 0.18s ease,
    top 0.18s ease,
    opacity 0.18s ease;
}

.guide-tip.ready {
  opacity: 1;
}

.guide-tip.center {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

.guide-tip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.guide-kicker {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--lb-accent);
}

.guide-count {
  font-size: 11px;
  color: var(--lb-muted);
  font-variant-numeric: tabular-nums;
}

.guide-tip h3,
.guide-card h2 {
  margin: 7px 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--lb-text);
  line-height: 1.45;
}

.guide-copy {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--lb-muted);
  white-space: pre-line;
}

.guide-tip .guide-copy {
  min-height: 46px;
}

.guide-dots {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 12px;
}

.guide-dots i {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--lb-border-strong);
  transition:
    width 0.16s ease,
    background 0.16s ease;
}

.guide-dots i.on {
  width: 16px;
  background: var(--lb-accent);
}

.guide-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.guide-actions.center {
  justify-content: center;
  margin-top: 18px;
}

.guide-spacer {
  flex: 1;
}

.guide-btn {
  height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
}

.guide-btn.primary {
  background: var(--lb-accent);
  color: #fff;
}

.guide-btn.primary:hover {
  filter: brightness(1.05);
}

.guide-btn.plain {
  background: var(--lb-chip);
  color: var(--lb-text);
}

.guide-btn.plain:hover {
  border-color: var(--lb-accent-2);
  color: var(--lb-accent);
}

.guide-btn.text {
  padding: 0 2px;
  background: none;
  color: var(--lb-muted);
  font-size: 12px;
}

.guide-btn.text:hover {
  color: var(--lb-text);
}

.guide-card {
  position: fixed;
  z-index: 1210;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 430px;
  max-width: calc(100vw - 40px);
  box-sizing: border-box;
  padding: 24px 24px 20px;
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius-xl);
  corner-shape: var(--lb-corner-shape);
  background: var(--lb-panel);
  box-shadow: var(--lb-shadow-3);
  pointer-events: auto;
}

.guide-welcome h2 {
  margin: 18px 0 6px;
  font-size: 21px;
  font-weight: 600;
  color: var(--lb-text);
}

.guide-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.guide-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: var(--lb-radius-s);
  background: var(--lb-accent);
  color: #fff;
  font-size: 23px;
  font-weight: 700;
  font-family: var(--lb-serif);
}

.guide-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--lb-text);
}

.guide-name span {
  margin-left: 4px;
  font-size: 12px;
  font-weight: 400;
  color: var(--lb-muted);
}

.guide-tagline {
  margin-top: 3px;
  font-size: 12px;
  color: var(--lb-muted);
}

.guide-welcome .guide-copy {
  margin-top: 2px;
}

.guide-points {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 14px 0 20px;
  padding: 12px 14px;
  border-radius: var(--lb-radius-s);
  background: var(--lb-bg);
  list-style: none;
  font-size: 12.5px;
  color: var(--lb-text);
}

.guide-points li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.guide-tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-size: 10px;
  flex-shrink: 0;
}

.guide-welcome .guide-actions {
  margin-top: 0;
}

.guide-esc {
  margin: 12px 0 0;
  font-size: 11px;
  color: var(--lb-muted);
}

.guide-finish {
  text-align: center;
  width: 400px;
}

.guide-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  margin-bottom: 2px;
  border-radius: 50%;
  background: var(--lb-accent-soft);
  color: var(--lb-accent);
  font-size: 20px;
}

.guide-finish h2 {
  margin: 10px 0 8px;
  font-size: 19px;
  font-weight: 600;
  color: var(--lb-text);
}

@media (prefers-reduced-motion: reduce) {
  .guide-hole,
  .guide-tip,
  .guide-dots i {
    transition: none;
  }
}
</style>
