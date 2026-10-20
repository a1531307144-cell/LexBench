import { describe, expect, it } from 'vitest'
import { flattenFolders, isSelfOrDescendant, nextUntitledName } from './noteFolders'

describe('nextUntitledName', () => {
  it('同级空闲时直接用基础名', () => {
    expect(nextUntitledName([])).toBe('未命名文件夹')
    expect(nextUntitledName(['甲', '乙'])).toBe('未命名文件夹')
  })

  it('重名时从 2 开始递增到第一个空位', () => {
    expect(nextUntitledName(['未命名文件夹'])).toBe('未命名文件夹 2')
    expect(nextUntitledName(['未命名文件夹', '未命名文件夹 2'])).toBe('未命名文件夹 3')
    // 中间空位优先补上（删掉 2 之后新建应拿回 2）
    expect(nextUntitledName(['未命名文件夹', '未命名文件夹 3'])).toBe('未命名文件夹 2')
  })

  it('支持自定义基础名', () => {
    expect(nextUntitledName([], '未命名')).toBe('未命名')
    expect(nextUntitledName(['未命名'], '未命名')).toBe('未命名 2')
  })
})

describe('flattenFolders', () => {
  const rows = [
    { id: 1, name: '甲', parent_id: null },
    { id: 2, name: '甲-1', parent_id: 1 },
    { id: 3, name: '甲-1-1', parent_id: 2 },
    { id: 4, name: '乙', parent_id: null }
  ]

  it('父在前、子紧随，depth 从 1 起', () => {
    expect(flattenFolders(rows)).toEqual([
      { id: 1, name: '甲', depth: 1 },
      { id: 2, name: '甲-1', depth: 2 },
      { id: 3, name: '甲-1-1', depth: 3 },
      { id: 4, name: '乙', depth: 1 }
    ])
  })

  it('孤儿按根层处理，不会整支消失', () => {
    expect(flattenFolders([{ id: 9, name: '孤儿', parent_id: 404 }])).toEqual([
      { id: 9, name: '孤儿', depth: 1 }
    ])
  })

  it('成环时截断，保证终止', () => {
    const out = flattenFolders([
      { id: 1, name: '甲', parent_id: 2 },
      { id: 2, name: '乙', parent_id: 1 }
    ])
    expect(out).toHaveLength(2)
    expect(new Set(out.map((r) => r.id))).toEqual(new Set([1, 2]))
  })

  it('maxDepth 之外的整支不上屏', () => {
    expect(flattenFolders(rows, 1).map((r) => r.id)).toEqual([1, 4])
    expect(flattenFolders(rows, 2).map((r) => r.id)).toEqual([1, 2, 4])
  })
})

describe('isSelfOrDescendant', () => {
  const parent = (id: number): number | null =>
    ({ 1: null, 2: 1, 3: 2, 4: null })[id] ?? null

  it('拦住拖进自己', () => {
    expect(isSelfOrDescendant(1, 1, parent)).toBe(true)
  })

  it('拦住拖进自己的后代', () => {
    expect(isSelfOrDescendant(3, 1, parent)).toBe(true)
    expect(isSelfOrDescendant(2, 1, parent)).toBe(true)
  })

  it('旁支/根层放行', () => {
    expect(isSelfOrDescendant(4, 1, parent)).toBe(false)
    expect(isSelfOrDescendant(1, 4, parent)).toBe(false)
  })

  it('成环数据也能终止', () => {
    const loop = (id: number): number | null => ({ 1: 2, 2: 1 })[id] ?? null
    expect(isSelfOrDescendant(1, 99, loop)).toBe(false)
  })
})
