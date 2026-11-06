// 平行视图布局：纯数据模块（无 DOM），主进程写入前校验、渲染层派生窗口矩形。
//
// 几何模型：所有 rect 都是在工作区画布里的归一化坐标（0..1）。
// - 分屏模式：窗口矩形由 noteRatio + rowRatios + 固定网格规则派生，保证无重叠无缝隙；
// - 浮动态：窗口矩形就是用户拖出来的位置，允许重叠。
// 两种模式共用同一份 panes 与 rect，切换模式不丢窗口。
//
// 网格规则（文档窗数量 n）：0 -> 空；1 -> 满宽；2 -> 左右两列；3 -> 上一下二；
// 4 -> 2×2；5+ -> 两列顺序排，末行不足时该窗跨列。

import type { PaneRect, ParallelLayout, ParallelPane } from './types'

export const PARALLEL_LAYOUT_VERSION = 1 as const
/** 技术保护上限（产品语义是数量不限；这里只防病态 JSON/渲染卡死） */
export const MAX_PARALLEL_PANES = 24
export const DEFAULT_NOTE_RATIO = 0.42
export const MIN_NOTE_RATIO = 0.25
export const MAX_NOTE_RATIO = 0.7
/** 分屏行高的相对下限（极端多窗时按均分兜底） */
export const MIN_ROW_RATIO = 0.04
/** 两列行的列宽下限 */
export const MIN_COL_RATIO = 0.18
export const MAX_COL_RATIO = 0.82

const EPS = 1e-6

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function clampRect(raw: unknown, fallback: PaneRect): PaneRect {
  if (!isObj(raw)) return { ...fallback }
  const w = clamp(num(raw.w, fallback.w), 0.05, 1)
  const h = clamp(num(raw.h, fallback.h), 0.05, 1)
  const x = clamp(num(raw.x, fallback.x), 0, 1 - w)
  const y = clamp(num(raw.y, fallback.y), 0, 1 - h)
  return { x, y, w, h }
}

/** 文档窗数量 -> 每行的列数 */
export function splitRowsFor(docCount: number): number[] {
  const n = Math.max(0, Math.floor(docCount))
  if (n <= 0) return []
  if (n === 1) return [1]
  if (n === 2) return [2]
  if (n === 3) return [1, 2]
  if (n === 4) return [2, 2]
  const rows: number[] = []
  let left = n
  while (left > 0) {
    const take = Math.min(2, left)
    rows.push(take)
    left -= take
  }
  return rows
}

/** 行高归一化：长度不匹配/非法时按均分兜底，并保证和为 1 */
export function normalizeRowRatios(raw: unknown, rowCount: number): number[] {
  if (rowCount <= 0) return []
  const list = Array.isArray(raw) ? raw : []
  const parsed =
    list.length === rowCount
      ? list.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN))
      : []
  const valid = parsed.length === rowCount && parsed.every((v) => v > 0)
  if (!valid) return Array.from({ length: rowCount }, () => 1 / rowCount)
  const floor = Math.min(MIN_ROW_RATIO, 0.9 / rowCount)
  const floored = parsed.map((v) => Math.max(v, floor))
  const total = floored.reduce((a, b) => a + b, 0)
  return floored.map((v) => v / total)
}

/** 列宽归一化：长度不匹配/非法时按 0.5 均分兜底 */
export function normalizeColRatios(raw: unknown, rowCount: number): number[] {
  if (rowCount <= 0) return []
  const list = Array.isArray(raw) ? raw : []
  return Array.from({ length: rowCount }, (_, i) => {
    const v = list[i]
    return typeof v === 'number' && Number.isFinite(v)
      ? clamp(v, MIN_COL_RATIO, MAX_COL_RATIO)
      : 0.5
  })
}

export function createDefaultLayout(notePaneId = 'note'): ParallelLayout {
  return {
    v: PARALLEL_LAYOUT_VERSION,
    mode: 'split',
    noteRatio: DEFAULT_NOTE_RATIO,
    rowRatios: [],
    colRatios: [],
    panes: [
      {
        id: notePaneId || 'note',
        kind: 'note',
        rect: { x: 0, y: 0, w: DEFAULT_NOTE_RATIO, h: 1 },
        z: 0
      }
    ]
  }
}

function notePane(layout: ParallelLayout): ParallelPane | undefined {
  return layout.panes.find((p) => p.kind === 'note')
}

function docPanes(layout: ParallelLayout): ParallelPane[] {
  return layout.panes.filter((p) => p.kind === 'doc')
}

function maxZ(layout: ParallelLayout): number {
  return layout.panes.reduce((m, p) => Math.max(m, num(p.z, 0)), 0)
}

function nextDocId(layout: ParallelLayout): string {
  const ids = new Set(layout.panes.map((p) => p.id))
  let seq = docPanes(layout).length + 1
  let id = `doc-${seq}`
  while (ids.has(id)) {
    seq += 1
    id = `doc-${seq}`
  }
  return id
}

/**
 * 按分屏规则重新派生所有窗口矩形。panes 顺序即文档窗排列顺序。
 * 返回新布局，不修改入参。
 */
export function deriveSplitRects(layout: ParallelLayout): ParallelLayout {
  const noteRatio = clamp(num(layout.noteRatio, DEFAULT_NOTE_RATIO), MIN_NOTE_RATIO, MAX_NOTE_RATIO)
  const docs = docPanes(layout)
  const rows = splitRowsFor(docs.length)
  const ratios = normalizeRowRatios(layout.rowRatios, rows.length)
  const colRatios = normalizeColRatios(layout.colRatios, rows.length)
  const docWidth = 1 - noteRatio

  const rectById = new Map<string, PaneRect>()
  const note = notePane(layout)
  if (note) rectById.set(note.id, { x: 0, y: 0, w: noteRatio, h: 1 })

  let cursor = 0
  let y = 0
  for (let r = 0; r < rows.length; r += 1) {
    const cols = rows[r]!
    const h = ratios[r] ?? 1 / rows.length
    const firstW = cols === 2 ? docWidth * colRatios[r]! : docWidth
    for (let c = 0; c < cols; c += 1) {
      const pane = docs[cursor]
      cursor += 1
      if (!pane) break
      const x = noteRatio + (c === 0 ? 0 : firstW)
      const w = cols === 2 ? (c === 0 ? firstW : docWidth - firstW) : docWidth
      rectById.set(pane.id, { x, y, w, h })
    }
    y += h
  }

  return {
    ...layout,
    noteRatio,
    rowRatios: ratios,
    colRatios,
    panes: layout.panes.map((p) => ({ ...p, rect: rectById.get(p.id) ?? p.rect }))
  }
}

/** 切换分屏/浮动态：分屏 -> 浮动先把派生矩形固化；浮动 -> 分屏重新按比例派生 */
export function setMode(layout: ParallelLayout, mode: 'split' | 'float'): ParallelLayout {
  if (layout.mode === mode) return layout
  if (mode === 'float') {
    return { ...deriveSplitRects(layout), mode: 'float' }
  }
  return deriveSplitRects({ ...layout, mode: 'split' })
}

/** 曲线化浮动态新窗口的位置：从左上依次错开，避免完全叠死 */
function cascadeRect(index: number): PaneRect {
  const offset = 0.035 * (index % 6)
  const w = 0.56
  const h = 0.62
  return {
    x: clamp(0.14 + offset, 0, 1 - w),
    y: clamp(0.1 + offset, 0, 1 - h),
    w,
    h
  }
}

/** 新增文档窗；分屏模式立即重排行，浮动态给一个错开的初始矩形 */
export function addDocPane(
  layout: ParallelLayout,
  docId: number,
  idFactory?: (layout: ParallelLayout) => string
): ParallelLayout {
  if (!Number.isInteger(docId) || docId <= 0) throw new Error('文档 id 不正确')
  if (layout.panes.length >= MAX_PARALLEL_PANES) throw new Error('平行视图窗口过多')
  const id = idFactory ? idFactory(layout) : nextDocId(layout)
  if (layout.panes.some((p) => p.id === id)) throw new Error('平行视图窗口 id 重复')
  const pane: ParallelPane = {
    id,
    kind: 'doc',
    docId,
    rect: layout.mode === 'float' ? cascadeRect(docPanes(layout).length) : { x: 0, y: 0, w: 0.5, h: 1 },
    z: maxZ(layout) + 1
  }
  const next: ParallelLayout = { ...layout, panes: [...layout.panes, pane] }
  return layout.mode === 'split' ? deriveSplitRects(next) : next
}

/** 关闭文档窗（笔记窗不可关闭） */
export function removePane(layout: ParallelLayout, paneId: string): ParallelLayout {
  const target = layout.panes.find((p) => p.id === paneId)
  if (!target) return layout
  if (target.kind === 'note') throw new Error('笔记窗不能关闭')
  const next: ParallelLayout = { ...layout, panes: layout.panes.filter((p) => p.id !== paneId) }
  return layout.mode === 'split' ? deriveSplitRects(next) : next
}

/** 浮动态置顶：只调整排序键，不写 CSS z-index */
export function bringToFront(layout: ParallelLayout, paneId: string): ParallelLayout {
  if (!layout.panes.some((p) => p.id === paneId)) return layout
  const top = maxZ(layout) + 1
  return {
    ...layout,
    panes: layout.panes.map((p) => (p.id === paneId ? { ...p, z: top } : p))
  }
}

/** 宽容清洗：坏窗口丢弃、补笔记窗、矩形/比例夹紧、未知字段丢弃 */
export function clampLayout(raw: ParallelLayout): ParallelLayout {
  const mode: 'split' | 'float' = raw.mode === 'float' ? 'float' : 'split'
  const noteRatio = clamp(num(raw.noteRatio, DEFAULT_NOTE_RATIO), MIN_NOTE_RATIO, MAX_NOTE_RATIO)
  const seen = new Set<string>()
  const panes: ParallelPane[] = []

  const incoming = Array.isArray(raw.panes) ? raw.panes : []
  for (const item of incoming) {
    if (!isObj(item)) continue
    const kind = item.kind === 'doc' ? 'doc' : item.kind === 'note' ? 'note' : null
    if (!kind) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || seen.has(id)) continue
    if (kind === 'note' && panes.some((p) => p.kind === 'note')) continue
    const docId = kind === 'doc' ? Math.floor(num(item.docId, 0)) : undefined
    if (kind === 'doc' && (!docId || docId <= 0)) continue
    if (panes.length >= MAX_PARALLEL_PANES) break
    seen.add(id)
    panes.push({
      id,
      kind,
      ...(docId ? { docId } : {}),
      rect: clampRect(item.rect, kind === 'note' ? { x: 0, y: 0, w: noteRatio, h: 1 } : cascadeRect(panes.length)),
      z: num(item.z, 0),
      ...(item.pinned === true ? { pinned: true } : {})
    })
  }

  if (!panes.some((p) => p.kind === 'note')) {
    panes.unshift({
      id: 'note',
      kind: 'note',
      rect: { x: 0, y: 0, w: noteRatio, h: 1 },
      z: 0
    })
  }

  const rowCount = splitRowsFor(docPanes({ ...raw, panes }).length).length
  const base: ParallelLayout = {
    v: PARALLEL_LAYOUT_VERSION,
    mode,
    noteRatio,
    rowRatios: normalizeRowRatios(raw.rowRatios, rowCount),
    colRatios: normalizeColRatios(raw.colRatios, rowCount),
    panes
  }
  return mode === 'split' ? deriveSplitRects(base) : base
}

/** 宽容解析（读取存档用）：任何坏数据回落到默认布局 */
export function parseParallelLayout(raw: unknown): ParallelLayout {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return createDefaultLayout()
    try {
      parsed = JSON.parse(raw)
    } catch {
      return createDefaultLayout()
    }
  }
  if (!isObj(parsed) || parsed.v !== PARALLEL_LAYOUT_VERSION) return createDefaultLayout()
  return clampLayout(parsed as unknown as ParallelLayout)
}

/** 严格校验（主进程写入前用）：不合法直接抛错，避免把脏布局存进库 */
export function validateParallelLayout(raw: unknown): ParallelLayout {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('并行布局数据格式不正确')
    }
  }
  if (!isObj(parsed)) throw new Error('并行布局数据格式不正确')
  if (parsed.v !== PARALLEL_LAYOUT_VERSION) throw new Error('并行布局版本不支持')
  if (parsed.mode !== 'split' && parsed.mode !== 'float') throw new Error('并行布局模式不正确')

  const noteRatio = parsed.noteRatio
  if (typeof noteRatio !== 'number' || !Number.isFinite(noteRatio)) throw new Error('并行布局数据格式不正确')
  if (noteRatio < MIN_NOTE_RATIO - EPS || noteRatio > MAX_NOTE_RATIO + EPS) {
    throw new Error('并行布局笔记窗比例超出范围')
  }
  if (!Array.isArray(parsed.panes) || parsed.panes.length === 0) throw new Error('并行布局数据格式不正确')
  if (parsed.panes.length > MAX_PARALLEL_PANES) throw new Error('平行视图窗口过多')
  if (!Array.isArray(parsed.rowRatios)) throw new Error('并行布局数据格式不正确')
  if (!Array.isArray(parsed.colRatios)) throw new Error('并行布局数据格式不正确')

  const ids = new Set<string>()
  let notes = 0
  let docs = 0
  for (const item of parsed.panes) {
    if (!isObj(item)) throw new Error('并行布局数据格式不正确')
    if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('并行布局窗口 id 不正确')
    if (ids.has(item.id)) throw new Error('并行布局窗口 id 重复')
    ids.add(item.id)
    if (item.kind === 'note') {
      notes += 1
      if (item.docId !== undefined) throw new Error('并行布局笔记窗不应带文档 id')
    } else if (item.kind === 'doc') {
      docs += 1
      if (!Number.isInteger(item.docId) || (item.docId as number) <= 0) {
        throw new Error('并行布局文档 id 不正确')
      }
    } else {
      throw new Error('并行布局窗口类型不正确')
    }
    if (!isObj(item.rect)) throw new Error('并行布局窗口矩形不正确')
    const r = item.rect
    const vals = [r.x, r.y, r.w, r.h]
    if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error('并行布局窗口矩形不正确')
    }
    if ((r.w as number) <= 0 || (r.h as number) <= 0) throw new Error('并行布局窗口尺寸不正确')
    if ((r.x as number) < -EPS || (r.y as number) < -EPS) throw new Error('并行布局窗口位置不正确')
    if ((r.x as number) + (r.w as number) > 1 + EPS || (r.y as number) + (r.h as number) > 1 + EPS) {
      throw new Error('并行布局窗口超出画布')
    }
  }
  if (notes !== 1) throw new Error('并行布局必须且只能有一个笔记窗')

  const rows = splitRowsFor(docs).length
  if (parsed.rowRatios.length !== rows) throw new Error('并行布局行比例数量不正确')
  if (parsed.colRatios.length !== rows) throw new Error('并行布局列比例数量不正确')
  if (rows > 0) {
    let sum = 0
    for (const v of parsed.rowRatios) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error('并行布局行比例不正确')
      sum += v
    }
    if (Math.abs(sum - 1) > 0.001) throw new Error('并行布局行比例之和不为 1')
    for (const v of parsed.colRatios) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('并行布局列比例不正确')
      if (v < MIN_COL_RATIO - EPS || v > MAX_COL_RATIO + EPS) throw new Error('并行布局列比例超出范围')
    }
  }

  return clampLayout(parsed as unknown as ParallelLayout)
}

export function serializeParallelLayout(layout: ParallelLayout): string {
  return JSON.stringify(clampLayout(layout))
}

/** 文档窗数量（UI 快捷判断） */
export function docPaneCount(layout: ParallelLayout): number {
  return docPanes(layout).length
}
