// 会话内跨笔记/跨 tab 的撤销历史缓存。
// 必须放在模块作用域（不能写在 OutlineEditor 的 <script setup> 顶层——
// <script setup> 的顶层绑定会被编译进 setup()，每个实例各一份，卸载即丢）。

import type { HistoryState } from '@shared/noteHistory'

export interface CachedNoteHistory {
  state: HistoryState
}

/** 最多保留几篇笔记的历史（LRU，Map 插入顺序即最近使用顺序） */
const MAX_CACHED_NOTES = 8
const cache = new Map<number, CachedNoteHistory>()

export function saveNoteHistory(id: number, state: HistoryState): void {
  cache.delete(id)
  cache.set(id, { state })
  while (cache.size > MAX_CACHED_NOTES) {
    const first = cache.keys().next().value
    if (first === undefined) break
    cache.delete(first)
  }
}

/** 取历史并把它移到 LRU 最新端；没有返回 null */
export function loadNoteHistory(id: number): CachedNoteHistory | null {
  const hit = cache.get(id)
  if (!hit) return null
  cache.delete(id)
  cache.set(id, hit)
  return hit
}

export function dropNoteHistory(id: number): void {
  cache.delete(id)
}
