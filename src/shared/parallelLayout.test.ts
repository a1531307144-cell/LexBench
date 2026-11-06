import { describe, expect, it } from 'vitest'
import {
  MAX_PARALLEL_PANES,
  addDocPane,
  bringToFront,
  clampLayout,
  createDefaultLayout,
  deriveSplitRects,
  docPaneCount,
  normalizeRowRatios,
  parseParallelLayout,
  removePane,
  serializeParallelLayout,
  setMode,
  splitRowsFor,
  validateParallelLayout
} from './parallelLayout'
import type { ParallelLayout } from './types'

const EPS = 1e-9

function rectsDoNotOverlap(layout: ParallelLayout): boolean {
  const rs = layout.panes.map((p) => p.rect)
  for (let i = 0; i < rs.length; i += 1) {
    for (let j = i + 1; j < rs.length; j += 1) {
      const a = rs[i]!
      const b = rs[j]!
      const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (overlapW > 1e-6 && overlapH > 1e-6) return false
    }
  }
  return true
}

function buildWithDocs(n: number): ParallelLayout {
  let layout = createDefaultLayout()
  for (let i = 1; i <= n; i += 1) layout = addDocPane(layout, i)
  return layout
}

describe('parallel layout', () => {
  it('默认布局：一个笔记窗、分屏、比例在合法区间', () => {
    const layout = createDefaultLayout()
    expect(layout.v).toBe(1)
    expect(layout.mode).toBe('split')
    expect(layout.panes).toHaveLength(1)
    expect(layout.panes[0]).toMatchObject({ id: 'note', kind: 'note' })
    expect(layout.panes[0]!.rect).toEqual({ x: 0, y: 0, w: 0.42, h: 1 })
    expect(layout.rowRatios).toEqual([])
    expect(layout.colRatios).toEqual([])
  })

  it('网格规则：1 满宽、2 左右、3 上一下二、4 2×2、5+ 两列且末行跨列', () => {
    expect(splitRowsFor(0)).toEqual([])
    expect(splitRowsFor(1)).toEqual([1])
    expect(splitRowsFor(2)).toEqual([2])
    expect(splitRowsFor(3)).toEqual([1, 2])
    expect(splitRowsFor(4)).toEqual([2, 2])
    expect(splitRowsFor(5)).toEqual([2, 2, 1])
    expect(splitRowsFor(6)).toEqual([2, 2, 2])
    expect(splitRowsFor(7)).toEqual([2, 2, 2, 1])
    expect(splitRowsFor(8)).toEqual([2, 2, 2, 2])
  })

  it('分屏派生：铺满文档区、无重叠、行高和笔记宽正确', () => {
    for (let n = 1; n <= 8; n += 1) {
      const layout = buildWithDocs(n)
      expect(docPaneCount(layout)).toBe(n)
      expect(rectsDoNotOverlap(layout)).toBe(true)
      const note = layout.panes.find((p) => p.kind === 'note')!
      expect(note.rect.x).toBe(0)
      expect(note.rect.w).toBeCloseTo(layout.noteRatio, 9)
      const docs = layout.panes.filter((p) => p.kind === 'doc')
      for (const d of docs) {
        expect(d.rect.x).toBeGreaterThanOrEqual(layout.noteRatio - EPS)
        expect(d.rect.x + d.rect.w).toBeLessThanOrEqual(1 + EPS)
        expect(d.rect.y + d.rect.h).toBeLessThanOrEqual(1 + EPS)
      }
      const last = docs[docs.length - 1]!
      expect(last.rect.y + last.rect.h).toBeCloseTo(1, 9)
      expect(layout.rowRatios.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    }
  })

  it('3 个文档：第一行一个满宽，第二行两个等宽', () => {
    const layout = buildWithDocs(3)
    const docs = layout.panes.filter((p) => p.kind === 'doc')
    expect(docs[0]!.rect.y).toBe(0)
    expect(docs[0]!.rect.w).toBeCloseTo(1 - layout.noteRatio, 9)
    expect(docs[1]!.rect.y).toBeCloseTo(docs[0]!.rect.y + docs[0]!.rect.h, 9)
    expect(docs[1]!.rect.w).toBeCloseTo(docs[2]!.rect.w, 9)
    expect(docs[1]!.rect.y).toBeCloseTo(docs[2]!.rect.y, 9)
  })

  it('两列行的列宽按 colRatios 分配', () => {
    const layout = deriveSplitRects({ ...buildWithDocs(2), colRatios: [0.3] })
    const docs = layout.panes.filter((p) => p.kind === 'doc')
    const docW = 1 - layout.noteRatio
    expect(docs[0]!.rect.w).toBeCloseTo(docW * 0.3, 9)
    expect(docs[1]!.rect.w).toBeCloseTo(docW * 0.7, 9)
  })

  it('行高归一化：坏值均分，合法值夹紧并归一', () => {
    expect(normalizeRowRatios([1, 1], 2)).toEqual([0.5, 0.5])
    expect(normalizeRowRatios([0.2], 2)).toEqual([0.5, 0.5])
    expect(normalizeRowRatios(['x', 1], 2)).toEqual([0.5, 0.5])
    const out = normalizeRowRatios([0.8, 0.2], 2)
    expect(out[0]! + out[1]!).toBeCloseTo(1, 9)
    expect(out[0]).toBeCloseTo(0.8, 9)
  })

  it('宽容解析：空/坏 JSON/数组/未知版本回落默认布局', () => {
    for (const bad of [null, '', '  ', '{', '[]', 'null', '[1,2]', { v: 2 }, { v: 1, panes: 'x' }]) {
      const layout = parseParallelLayout(bad as unknown)
      expect(layout.panes).toHaveLength(1)
      expect(layout.panes[0]!.kind).toBe('note')
      expect(layout.mode).toBe('split')
    }
  })

  it('宽容解析：坏窗口被丢弃、补笔记窗、矩形夹紧', () => {
    const layout = parseParallelLayout({
      v: 1,
      mode: 'float',
      noteRatio: 9,
      rowRatios: [],
      panes: [
        { id: 'a', kind: 'doc', docId: 0 },
        { id: 'b', kind: 'doc', docId: 3, rect: { x: -1, y: 2, w: 9, h: 0 } },
        { id: 'b', kind: 'doc', docId: 4 },
        { id: 'c', kind: 'nope' }
      ]
    })
    expect(layout.noteRatio).toBeLessThanOrEqual(0.7)
    expect(layout.noteRatio).toBeGreaterThanOrEqual(0.25)
    expect(layout.panes.filter((p) => p.kind === 'note')).toHaveLength(1)
    expect(layout.panes.filter((p) => p.kind === 'doc')).toHaveLength(1)
    const doc = layout.panes.find((p) => p.kind === 'doc')!
    expect(doc.rect.x).toBeGreaterThanOrEqual(0)
    expect(doc.rect.y).toBeGreaterThanOrEqual(0)
    expect(doc.rect.x + doc.rect.w).toBeLessThanOrEqual(1 + EPS)
    expect(doc.rect.y + doc.rect.h).toBeLessThanOrEqual(1 + EPS)
  })

  it('严格校验：合法布局通过，非法布局抛错', () => {
    const good = buildWithDocs(4)
    expect(() => validateParallelLayout(serializeParallelLayout(good))).not.toThrow()

    const dup = structuredClone(good)
    dup.panes.push({ ...dup.panes[1]! })
    expect(() => validateParallelLayout(dup)).toThrow()

    const noNote = structuredClone(good)
    noNote.panes = noNote.panes.filter((p) => p.kind !== 'note')
    expect(() => validateParallelLayout(noNote)).toThrow()

    const badDoc = structuredClone(good)
    const doc = badDoc.panes.find((p) => p.kind === 'doc')!
    delete doc.docId
    expect(() => validateParallelLayout(badDoc)).toThrow()

    const badRect = structuredClone(good)
    badRect.panes[0]!.rect.w = 0
    expect(() => validateParallelLayout(badRect)).toThrow()

    const badRatio = structuredClone(good)
    badRatio.rowRatios = [2, 2]
    expect(() => validateParallelLayout(badRatio)).toThrow()

    const badCol = structuredClone(good)
    badCol.colRatios = [0.5]
    expect(() => validateParallelLayout(badCol)).toThrow()

    const tooMany = structuredClone(good)
    while (tooMany.panes.length <= MAX_PARALLEL_PANES) {
      tooMany.panes.push({ id: `x${tooMany.panes.length}`, kind: 'doc', docId: 99, rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0 })
    }
    expect(() => validateParallelLayout(tooMany)).toThrow()
  })

  it('模式切换：分屏 -> 浮动保留矩形，浮动 -> 分屏重新派生', () => {
    const split = buildWithDocs(3)
    const floating = setMode(split, 'float')
    expect(floating.mode).toBe('float')
    expect(floating.panes.map((p) => p.id)).toEqual(split.panes.map((p) => p.id))
    expect(floating.panes.map((p) => p.rect)).toEqual(split.panes.map((p) => p.rect))

    const moved = structuredClone(floating)
    moved.panes[1]!.rect = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }
    const back = setMode(moved, 'split')
    expect(back.mode).toBe('split')
    expect(back.panes[1]!.rect).not.toEqual({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 })
    expect(rectsDoNotOverlap(back)).toBe(true)
  })

  it('增删窗口：新增重排、删除重排、笔记窗不可关闭', () => {
    let layout = createDefaultLayout()
    layout = addDocPane(layout, 11, () => 'doc-a')
    layout = addDocPane(layout, 12, () => 'doc-b')
    expect(layout.panes.map((p) => p.id)).toEqual(['note', 'doc-a', 'doc-b'])
    expect(layout.panes[1]!.rect.w).toBeCloseTo((1 - layout.noteRatio) / 2, 9)

    const removed = removePane(layout, 'doc-a')
    expect(removed.panes.map((p) => p.id)).toEqual(['note', 'doc-b'])
    expect(removed.panes[1]!.rect.w).toBeCloseTo(1 - removed.noteRatio, 9)
    expect(() => removePane(layout, 'note')).toThrow()
    expect(docPaneCount(layout)).toBe(2)
  })

  it('置顶只改排序键，不改矩形', () => {
    const layout = buildWithDocs(2)
    const front = bringToFront(layout, layout.panes[1]!.id)
    const before = layout.panes[1]!
    const after = front.panes.find((p) => p.id === before.id)!
    expect(after.z).toBeGreaterThan(before.z)
    expect(after.rect).toEqual(before.rect)
  })

  it('序列化/解析往返保持稳等', () => {
    const layout = deriveSplitRects({
      ...buildWithDocs(5),
      rowRatios: [0.4, 0.3, 0.3],
      colRatios: [0.6, 0.4, 0.5]
    })
    const round = parseParallelLayout(serializeParallelLayout(layout))
    expect(round.mode).toBe(layout.mode)
    expect(round.noteRatio).toBeCloseTo(layout.noteRatio, 9)
    expect(round.panes).toHaveLength(layout.panes.length)
    expect(round.panes.map((p) => p.id)).toEqual(layout.panes.map((p) => p.id))
    expect(round.panes.map((p) => p.rect)).toEqual(layout.panes.map((p) => p.rect))
  })

  it('清洗后仍满足派生规则', () => {
    const dirty = {
      v: 1,
      mode: 'split',
      noteRatio: 0.5,
      rowRatios: [0.5, 0.5],
      panes: [
        { id: 'note', kind: 'note', rect: { x: 0, y: 0, w: 0.1, h: 1 }, z: 0 },
        { id: 'd1', kind: 'doc', docId: 1, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, z: 1 },
        { id: 'd2', kind: 'doc', docId: 2, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, z: 2 }
      ]
    }
    const clean = clampLayout(dirty as unknown as ParallelLayout)
    expect(clean.panes[0]!.rect.w).toBeCloseTo(0.5, 9)
    expect(rectsDoNotOverlap(clean)).toBe(true)
  })
})
