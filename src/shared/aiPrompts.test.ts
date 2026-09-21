// AI 提示词与引用解析单测（纯函数层）
import { describe, expect, it } from 'vitest'

import { cn2num } from './cnnum'
import {
  CONTEXT_BUDGET,
  HISTORY_LIMIT,
  buildCasesPrompt,
  buildExplainPrompt,
  buildFollowupMessages,
  parseCitations,
  renderContext
} from './aiPrompts'

const ARTICLE = {
  title: '中华人民共和国民法典',
  label: '第一千零七十七条',
  content: '自婚姻登记机关收到离婚登记申请之日起三十日内，任何一方不愿意离婚的，可以向婚姻登记机关撤回离婚登记申请。'
}

describe('renderContext', () => {
  it('逐项渲染《法规名》+条文，空数组返回空串', () => {
    expect(renderContext([])).toBe('')
    const out = renderContext([{ title: '民法典', label: '第一千零七十六条', content: '夫妻双方自愿离婚的…' }])
    expect(out).toContain('《民法典》第一千零七十六条')
    expect(out).toContain('夫妻双方自愿离婚的…')
  })

  it('超预算时截断并加省略号，且总长受预算约束', () => {
    const long = '甲'.repeat(5000)
    const out = renderContext([{ title: '民法典', label: '第一条', content: long }], CONTEXT_BUDGET)
    expect(out.length).toBeLessThanOrEqual(CONTEXT_BUDGET + 40)
    expect(out.endsWith('…')).toBe(true)
  })

  it('多条目按预算逐条放，放不下的不再收', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      title: '民法典',
      label: `第${i + 1}条`,
      content: '乙'.repeat(300)
    }))
    const out = renderContext(items, 600)
    const count = out.split('\n\n').length
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(items.length)
  })
})

describe('buildExplainPrompt', () => {
  it('包含三段式要求、目标法条与材料', () => {
    const p = buildExplainPrompt(ARTICLE, '《民法典》第一千零七十六条\n夫妻双方自愿离婚的…')
    expect(p).toContain('条文主旨')
    expect(p).toContain('适用场景')
    expect(p).toContain('实务要点')
    expect(p).toContain(`《${ARTICLE.title}》${ARTICLE.label}`)
    expect(p).toContain('【材料】')
  })
})

describe('buildCasesPrompt', () => {
  it('有材料：要求结合本地材料、不得虚构', () => {
    const p = buildCasesPrompt(ARTICLE, '《示例案例》第3段\n虚构演示案例')
    expect(p).toContain('不要虚构')
    expect(p).toContain('【材料】')
  })

  it('无材料：如实说明并提示库内无材料', () => {
    const p = buildCasesPrompt(ARTICLE, '   ')
    expect(p).toContain('暂未检索到相关案例材料')
    expect(p).not.toContain('【材料】')
  })
})

describe('buildFollowupMessages', () => {
  it('只带最近 HISTORY_LIMIT 条历史，并夹带当前条文与问题', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `第${i}条消息`
    }))
    const msgs = buildFollowupMessages(history, ARTICLE, '冷静期怎么起算？')
    expect(msgs.length).toBe(HISTORY_LIMIT + 1)
    expect(msgs[0].content).toContain(`第${10 - HISTORY_LIMIT}条消息`)
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('【当前条文】')
    expect(last.content).toContain('冷静期怎么起算？')
  })

  it('无当前条文时只带问题', () => {
    const msgs = buildFollowupMessages([], null, '什么是不可抗力？')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('什么是不可抗力？')
  })

  it('历史超长被截断（用户 400 / 助手 800）', () => {
    const msgs = buildFollowupMessages(
      [
        { role: 'user', content: '甲'.repeat(1000) },
        { role: 'assistant', content: '乙'.repeat(2000) }
      ],
      null,
      '继续'
    )
    expect(msgs[0].content.length).toBe(400)
    expect(msgs[1].content.length).toBe(800)
  })
})

describe('parseCitations', () => {
  it('抓取《法规名》第X条，中文数字转条号，去重保序', () => {
    const answer =
      '依据《中华人民共和国民法典》第一千零七十七条，冷静期为三十日；另见《中华人民共和国民法典》第1076条、' +
      '《中华人民共和国民法典》第一千零七十七条（重复）。'
    const cites = parseCitations(answer, cn2num)
    expect(cites.map((c) => [c.name, c.articleNo])).toEqual([
      ['中华人民共和国民法典', 1077],
      ['中华人民共和国民法典', 1076]
    ])
    expect(cites[0].citeText).toBe('《中华人民共和国民法典》第一千零七十七条')
  })

  it('忽略不合规写法（套书名号、无条号、名字过长）', () => {
    const cites = parseCitations('见《《嵌套》》第一条，以及《民法典》，还有一段普通文字。', cn2num)
    expect(cites).toEqual([])
  })

  it('条号无法解析时记 0（保留引用但不可跳转）', () => {
    const cites = parseCitations('参见《某规定》第一百条。', () => null)
    expect(cites).toHaveLength(1)
    expect(cites[0].articleNo).toBe(0)
  })

  it('「万」量级条号不匹配（与 legacy 正则一致，仅支持到千位）', () => {
    expect(parseCitations('参见《某规定》第十万条。', cn2num)).toEqual([])
  })
})
