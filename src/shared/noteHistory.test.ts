import { describe, expect, it } from 'vitest'
import {
  anchorOf,
  initHistory,
  pushHistory,
  redoHistory,
  retitleHistory,
  retitleState,
  sameEntry,
  trimHistory,
  undoHistory,
  type HistoryEntry
} from './noteHistory'

const e = (tree: string, title = '笔记'): HistoryEntry => ({ tree, title })

describe('noteHistory', () => {
  it('init 只含当前一条；push 相同快照不增加', () => {
    const s0 = initHistory(e('A'))
    expect(anchorOf(s0)).toEqual(e('A'))
    expect(pushHistory(s0, e('A'))).toBe(s0)
  })

  it('push 追加并移动指针；重复快照去重', () => {
    const s0 = initHistory(e('A'))
    const s1 = pushHistory(s0, e('B'))
    expect(s1.index).toBe(1)
    expect(s1.entries.map((x) => x.tree)).toEqual(['A', 'B'])
    expect(pushHistory(s1, e('B'))).toBe(s1)
  })

  it('undo 先提交当前未汇总差异：首步也能撤销，并能 redo 找回', () => {
    const s0 = initHistory(e('A'))
    const res = undoHistory(s0, e('B'))
    expect(res?.target).toEqual(e('A'))
    // 当前输入 B 已被提交进栈，撤销后指针回到 A
    expect(res?.state.entries.map((x) => x.tree)).toEqual(['A', 'B'])
    expect(res?.state.index).toBe(0)
    const redo = redoHistory(res!.state, e('A'))
    expect(redo?.target).toEqual(e('B'))
    expect(redo?.state.index).toBe(1)
  })

  it('undo 到达首条时返回 null', () => {
    const s0 = initHistory(e('A'))
    expect(undoHistory(s0, e('A'))).toBeNull()
  })

  it('撤销后输入新内容再 redo：截断 redo 分支，返回 null', () => {
    let s = pushHistory(initHistory(e('A')), e('B'))
    s = pushHistory(s, e('C'))
    const undone = undoHistory(s, e('C'))
    expect(undone?.target).toEqual(e('B'))
    // 撤销到 B 后输入 D：redo 分支被截断
    expect(redoHistory(undone!.state, e('D'))).toBeNull()
    const pushed = pushHistory(undone!.state, e('D'))
    expect(pushed.entries.map((x) => x.tree)).toEqual(['A', 'B', 'D'])
    expect(pushed.index).toBe(2)
  })

  it('超过条数上限时裁掉最旧条目', () => {
    let s = initHistory(e('0'))
    for (let i = 1; i <= 5; i++) s = pushHistory(s, e(String(i)), 3)
    expect(s.entries.map((x) => x.tree)).toEqual(['3', '4', '5'])
    expect(s.index).toBe(2)
  })

  it('retitle 只改标题，不改树；不修改原数组', () => {
    const entries = [e('A', '旧'), e('B', '旧')]
    const out = retitleHistory(entries, '新')
    expect(out.map((x) => x.title)).toEqual(['新', '新'])
    expect(out.map((x) => x.tree)).toEqual(['A', 'B'])
    expect(entries[0]!.title).toBe('旧')
    expect(retitleHistory(out, '新')).toBe(out)
  })

  it('retitleState 保持指针', () => {
    const s = pushHistory(initHistory(e('A', '旧')), e('B', '旧'))
    const out = retitleState(s, '新')
    expect(out.index).toBe(1)
    expect(out.entries.map((x) => x.title)).toEqual(['新', '新'])
  })

  it('trimHistory 只裁当前指针对之前的旧条目，并同步索引', () => {
    const s = {
      entries: [e('a'.repeat(100)), e('b'.repeat(100)), e('c'.repeat(100))],
      index: 2
    }
    const out = trimHistory(s, 250)
    expect(out.entries.map((x) => x.tree.slice(0, 1))).toEqual(['b', 'c'])
    expect(out.index).toBe(1)
    // 不裁当前指针及之前的最后一条
    const atZero = { entries: s.entries, index: 0 }
    expect(trimHistory(atZero, 1)).toBe(atZero)
  })

  it('sameEntry 对 undefined 安全', () => {
    expect(sameEntry(undefined, e('A'))).toBe(false)
    expect(sameEntry(e('A'), undefined)).toBe(false)
    expect(sameEntry(e('A'), e('A'))).toBe(true)
  })
})
