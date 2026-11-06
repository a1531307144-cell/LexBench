// PDF 原件 Blob 缓存：平行视图可以把同一篇 PDF 开在多个窗口，避免每个窗口都走一遍 IPC
// 并把整份文件复制多份。缓存的是 Blob 本体；各窗口仍各自创建/回收 blob URL（跳页要用新 URL）。
// 放在独立模块（不是 <script setup> 顶层）才能跨组件实例共享。

const MAX_CACHED_PDFS = 6

const cache = new Map<number, Blob>()

export function getCachedPdfBlob(documentId: number): Blob | null {
  const blob = cache.get(documentId)
  if (!blob) return null
  // LRU：命中后移到队尾
  cache.delete(documentId)
  cache.set(documentId, blob)
  return blob
}

export function cachePdfBlob(documentId: number, blob: Blob): void {
  cache.delete(documentId)
  cache.set(documentId, blob)
  while (cache.size > MAX_CACHED_PDFS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 文档被删除时清掉（可选；LRU 本身也会淘汰） */
export function dropCachedPdfBlob(documentId: number): void {
  cache.delete(documentId)
}
