// PDF 原件 Blob 缓存：平行视图可以把同一篇 PDF 开在多个窗口，避免每个窗口都走一遍 IPC
// 并把整份文件复制多份。缓存的是 Blob 本体；各窗口仍各自创建/回收 blob URL（跳页要用新 URL）。
// 放在独立模块（不是 <script setup> 顶层）才能跨组件实例共享。

const MAX_CACHED_PDFS = 6
/** 总量上限：只按个数限制挡不住大扫描件——6 个 100MB 的 PDF 就是数百 MB 常驻 */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
/** 单个文件超过这个体量就不进缓存：开一次读一次，好过长期占着 */
const MAX_ITEM_BYTES = 96 * 1024 * 1024

const cache = new Map<number, Blob>()
let totalBytes = 0

function forget(documentId: number): void {
  const blob = cache.get(documentId)
  if (!blob) return
  cache.delete(documentId)
  totalBytes -= blob.size
  if (totalBytes < 0) totalBytes = 0
}

export function getCachedPdfBlob(documentId: number): Blob | null {
  const blob = cache.get(documentId)
  if (!blob) return null
  // LRU：命中后移到队尾
  cache.delete(documentId)
  cache.set(documentId, blob)
  return blob
}

export function cachePdfBlob(documentId: number, blob: Blob): void {
  forget(documentId)
  if (blob.size > MAX_ITEM_BYTES) return
  cache.set(documentId, blob)
  totalBytes += blob.size
  while (cache.size > MAX_CACHED_PDFS || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    forget(oldest)
  }
}

/** 文档被删除时清掉（LRU 本身也会淘汰，但强引用留着会一直占内存） */
export function dropCachedPdfBlob(documentId: number): void {
  forget(documentId)
}
