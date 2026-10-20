import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** 缩放区间与吸附精度：与笔记大纲页保持一致（0.6~2.0，步进 1%） */
const MIN = 0.6
const MAX = 2

/**
 * 阅读页缩放：触控板双指捏合在 Chromium 里就是 ctrl+wheel，拦掉浏览器默认缩放后
 * 改缩放阅读内容；每篇文档的比例记住在 settings 表（换文档先读记忆值再回写）。
 */
export function usePageZoom(opts: {
  /** 当前文档的记忆键；返回 null 表示不记忆（如 PDF 交给内置阅读器自己缩放） */
  zoomKey: () => string | null
  /** 手势监听目标（滚动容器） */
  target: Ref<HTMLElement | null>
  /** 缩放变化后的回调（例如重新居中横向滚动） */
  onChange?: () => void
}): {
  pageZoom: Ref<number>
  setPageZoom: (next: number) => void
  resetZoom: () => void
} {
  const pageZoom = ref(1)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let loadSeq = 0
  /** 防抖窗口里是否还有一笔没写：落盘时机（关窗/换文档/卸载）据此决定要不要补写 */
  let pendingSave = false

  const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100))

  /** 立即写出待落盘的比例；key 显式传入是因为换文档时 zoomKey() 已是新键、旧值要写给旧键 */
  function flushSave(key: string | null = opts.zoomKey()): void {
    clearTimeout(saveTimer)
    if (!pendingSave) return
    pendingSave = false
    if (!key) return
    void window.lexbench.settings.set(key, String(pageZoom.value)).catch(() => {
      // 记忆失败只是下次回到 100%，不打扰阅读
    })
  }

  function scheduleSave(): void {
    if (!opts.zoomKey()) return
    pendingSave = true
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => flushSave(), 320)
  }

  // 关窗时渲染进程被直接销毁（onBeforeUnmount 不会跑）：把防抖里的最后一笔先交给主进程
  const unsubBeforeClose = window.lexbench.app.onBeforeClose(() => flushSave())

  function setPageZoom(next: number): void {
    const v = clamp(next)
    if (v === pageZoom.value) return
    pageZoom.value = v
    scheduleSave()
    opts.onChange?.()
  }

  function resetZoom(): void {
    if (pageZoom.value === 1) return
    pageZoom.value = 1
    scheduleSave()
    opts.onChange?.()
  }

  // 换文档：读记忆值（异步竞态用 seq 丢弃过期结果，避免慢请求盖掉新文档的比例）
  watch(
    () => opts.zoomKey(),
    async (key, oldKey) => {
      const seq = ++loadSeq
      // 换文档前把上一份还没落盘的比例写给旧键，不能直接丢掉
      flushSave(oldKey ?? null)
      if (!key) {
        pageZoom.value = 1
        opts.onChange?.()
        return
      }
      try {
        const raw = await window.lexbench.settings.get(key)
        if (seq !== loadSeq) return
        const n = raw === null ? Number.NaN : Number(raw)
        pageZoom.value = Number.isFinite(n) ? clamp(n) : 1
      } catch {
        if (seq === loadSeq) pageZoom.value = 1
      }
      opts.onChange?.()
    },
    { immediate: true }
  )

  function onWheel(ev: WheelEvent): void {
    if (!(ev.ctrlKey || ev.metaKey)) return
    ev.preventDefault()
    setPageZoom(pageZoom.value * Math.exp(-ev.deltaY * 0.0015))
  }

  // 滚动容器可能随模式切换（文字 / PDF）换上换下，跟着 ref 走
  watch(
    opts.target,
    (el, old) => {
      old?.removeEventListener('wheel', onWheel)
      el?.addEventListener('wheel', onWheel, { passive: false })
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    flushSave()
    unsubBeforeClose()
    opts.target.value?.removeEventListener('wheel', onWheel)
  })

  return { pageZoom, setPageZoom, resetZoom }
}
