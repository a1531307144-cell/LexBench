// statuteToc 单测：从 articles 戳记推导目录的迁移语义

import { describe, expect, it } from 'vitest'
import { buildStatuteToc, type StatuteHeadingFields } from './statuteToc'

/** 便捷构造：按序给出每条的 编/章/节，order_index 自动回填 */
function makeArticles(rows: Array<[branch: string, chapter: string, section: string]>): StatuteHeadingFields[] {
  return rows.map(([branch, chapter, section], order_index) => ({
    branch,
    chapter,
    section,
    order_index
  }))
}

describe('buildStatuteToc', () => {
  it('空数组返回空目录', () => {
    expect(buildStatuteToc([])).toEqual([])
  })

  it('平铺法规（无编/章/节）返回空目录', () => {
    expect(buildStatuteToc(makeArticles([['', '', ''], ['', '', ''], ['', '', '']]))).toEqual([])
  })

  it('仅章层级：连续相同戳记只发一条', () => {
    const toc = buildStatuteToc(
      makeArticles([
        ['', '第一章　总则', ''],
        ['', '第一章　总则', ''],
        ['', '第一章　总则', ''],
        ['', '第一章　总则', '']
      ])
    )
    expect(toc).toEqual([{ level: 'chapter', title: '第一章　总则', orderIndex: 0 }])
  })

  it('完整三级：新编清章/节、新章清节，空串不发条目', () => {
    const toc = buildStatuteToc(
      makeArticles([
        ['第一编 总则', '第一章 基本规定', '第一节 一般规定'],
        ['第一编 总则', '第一章 基本规定', '第一节 一般规定'],
        ['第一编 总则', '第一章 基本规定', '第二节 特别规定'],
        // 新编：章/节被清空 —— 不发空标题，等正文标题到来
        ['第二编 物权', '', ''],
        ['第二编 物权', '第二章 所有权', ''],
        ['第二编 物权', '第二章 所有权', '']
      ])
    )
    expect(toc).toEqual([
      { level: 'branch', title: '第一编 总则', orderIndex: 0 },
      { level: 'chapter', title: '第一章 基本规定', orderIndex: 0 },
      { level: 'section', title: '第一节 一般规定', orderIndex: 0 },
      { level: 'section', title: '第二节 特别规定', orderIndex: 2 },
      { level: 'branch', title: '第二编 物权', orderIndex: 3 },
      { level: 'chapter', title: '第二章 所有权', orderIndex: 4 }
    ])
  })

  it('首条同时带三层时，按 编→章→节 层级序发出且共享同一 orderIndex', () => {
    const toc = buildStatuteToc(makeArticles([['第一编 总则', '第一章 基本规定', '第一节 一般规定']]))
    expect(toc.map((e) => e.level)).toEqual(['branch', 'chapter', 'section'])
    expect(toc.every((e) => e.orderIndex === 0)).toBe(true)
  })

  it('标题原文逐字保留（含全角空格）', () => {
    const toc = buildStatuteToc(makeArticles([['', '第一章　总则', ''], ['', '第二章　自然人', '']]))
    expect(toc[0].title).toBe('第一章　总则')
    expect(toc[1].title).toBe('第二章　自然人')
  })

  it('同层同名标题再次出现（隔章后复现）仍按迁移发出', () => {
    const toc = buildStatuteToc(
      makeArticles([
        ['', '第一章 总则', ''],
        ['', '第二章 分则', ''],
        ['', '第一章 总则', ''] // 理论上罕见，但迁移语义必须如实反映戳记
      ])
    )
    expect(toc).toHaveLength(3)
  })
})
