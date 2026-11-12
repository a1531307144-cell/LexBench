// 关窗前冲刷登记表
//
// 主进程关窗时只发一条 app:before-close，渲染层回 app:flushDone 才真正关闭。
// 笔记编辑器 / 平行视图直接由 App 持有 ref 冲刷；阅读进度这类「500ms 防抖 + 卸载兜底」
// 的组件不行——窗口关闭时 Vue 不会执行 onBeforeUnmount，防抖定时器随渲染进程一起消失。
// 因此这些组件自注册一个同步冲刷函数，App 在回 flushDone 之前统一 await。

type FlushFn = () => void | Promise<void>

const flushers = new Set<FlushFn>()

/** 注册关窗冲刷；返回注销函数（组件卸载时调用） */
export function registerBeforeCloseFlush(fn: FlushFn): () => void {
  flushers.add(fn)
  return () => {
    flushers.delete(fn)
  }
}

/** 依次执行所有登记项；单个失败不影响其它项（关窗不能被一个错误卡死） */
export async function runBeforeCloseFlushes(): Promise<void> {
  await Promise.allSettled([...flushers].map((fn) => Promise.resolve().then(fn)))
}
