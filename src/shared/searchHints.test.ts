// searchHints 单测：随机取样的边界与确定性

import { describe, expect, it } from 'vitest'
import { MID_HINTS, RESULT_HINTS, TOPBAR_HINTS, pickDistinct } from './searchHints'

describe('pickDistinct', () => {
  it('取样数量与池内容一致且互不相同', () => {
    const got = pickDistinct(TOPBAR_HINTS, 2)
    expect(got).toHaveLength(2)
    expect(got[0]).not.toBe(got[1])
    for (const g of got) expect(TOPBAR_HINTS).toContain(g)
  })

  it('count 超过池大小时返回整池（去重后不多取）', () => {
    const got = pickDistinct(MID_HINTS, 99)
    expect(got).toHaveLength(MID_HINTS.length)
    expect(new Set(got).size).toBe(MID_HINTS.length)
  })

  it('相同 rng 序列可复现相同结果', () => {
    const seq = () => 0.5
    expect(pickDistinct(RESULT_HINTS, 2, seq)).toEqual(pickDistinct(RESULT_HINTS, 2, seq))
  })

  it('count 为 0 或空池返回空数组', () => {
    expect(pickDistinct(TOPBAR_HINTS, 0)).toEqual([])
    expect(pickDistinct([], 3)).toEqual([])
  })

  it('结果池对象按引用原样返回', () => {
    const [h] = pickDistinct(RESULT_HINTS, 1)
    expect(RESULT_HINTS).toContain(h)
  })
})
