// 法规批注上下文：主进程只有一个「当前页是否在场」布尔值。
// 平行视图可同时挂多个法规窗，直接 setActive(false) 会让兄弟窗的右键「添加批注」消失，
// 所以这里用引用计数：第一个窗 claim 时开启，最后一个窗 release 时才关闭。

let claims = 0
let lastSent: boolean | null = null

function send(active: boolean): void {
  if (lastSent === active) return
  try {
    window.lexbench.annotations.setActive(active)
    lastSent = active
  } catch {
    // 发送失败时允许下次重试
    lastSent = null
  }
}

/** 取得一份上下文；返回释放函数（重复调用释放是安全的） */
export function claimAnnotationContext(): () => void {
  claims += 1
  if (claims === 1) send(true)
  let released = false
  return () => {
    if (released) return
    released = true
    claims = Math.max(0, claims - 1)
    if (claims === 0) send(false)
  }
}
