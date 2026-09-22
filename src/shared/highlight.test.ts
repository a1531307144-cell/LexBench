// 高亮词条与包裹的单测：完整关键词不截短、转义安全、长词优先

import { describe, expect, it } from 'vitest'
import { buildHighlightTerms, escapeHtml, highlightText } from './highlight'

describe('buildHighlightTerms', () => {
  it('含完整原查询与空白词段（民法典 1077 → 民法典、1077 都能整词着色）', () => {
    const terms = buildHighlightTerms('民法典 1077')
    expect(terms).toContain('民法典 1077')
    expect(terms).toContain('民法典')
    expect(terms).toContain('1077')
  })

  it('含分词 token（NFKC 归一）', () => {
    const terms = buildHighlightTerms('国家利益')
    expect(terms).toContain('国家利益')
    expect(terms.every((t) => t.length > 0)).toBe(true)
  })

  it('空查询 → 空数组', () => {
    expect(buildHighlightTerms('')).toEqual([])
    expect(buildHighlightTerms('   ')).toEqual([])
  })
})

describe('highlightText', () => {
  it('整词优先：光污染整包，不被内部短词截断', () => {
    const out = highlightText('城市光污染的治理', buildHighlightTerms('光污染'))
    expect(out).toContain('<em>光污染</em>')
    expect(out.includes('<em>污染</em>')).toBe(false)
  })

  it('多段各自着色（民法典与 1077 分别包）', () => {
    const out = highlightText('民法典第1077条规定', buildHighlightTerms('民法典 1077'))
    expect(out).toContain('<em>民法典</em>')
    expect(out).toContain('<em>1077</em>')
  })

  it('HTML 转义安全（可直接 v-html）', () => {
    const out = highlightText('<script>alert("x")</script>', [])
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#x27;')
  })

  it('无词条 → 仅转义不包标签', () => {
    expect(highlightText('普通文本', [])).toBe('普通文本')
  })
})
