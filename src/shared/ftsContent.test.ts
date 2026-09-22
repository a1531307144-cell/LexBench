// FTS 索引文本公式单测：标题/条标/条号/编章节确实进了索引文本，
// 且查询侧 token 能在索引文本里找到（index-vs-query 一致性）

import { describe, expect, it } from 'vitest'
import { articleFtsText, chunkFtsText } from './ftsContent'
import { queryTokens, tokenize } from './tokenize'

describe('articleFtsText', () => {
  const base = {
    title: '中华人民共和国海商法',
    label: '第一千零七十七条',
    articleNo: 1077,
    branch: '',
    chapter: '第四章 海上货物运输合同',
    section: '',
    content: '托运人应当按照约定的数量交付货物。'
  }

  it('条号（阿拉伯数字）进索引文本', () => {
    expect(articleFtsText(base).split(' ')).toContain('1077')
  })

  it('按 标题→条标→条号→编章节→正文 顺序拼接后统一再分词', () => {
    const expected = tokenize(
      [base.title, base.label, '1077', base.chapter, base.content].filter((s) => s.trim()).join(' ')
    )
    expect(articleFtsText(base)).toBe(expected)
  })

  it('查询侧法名 token 能在索引文本中找到（搜法规名可命中）', () => {
    const text = new Set(articleFtsText(base).split(' '))
    for (const tok of queryTokens('海商法')) expect(text.has(tok)).toBe(true)
  })

  it('查询侧条号 token 能在索引文本中找到（搜 1077 可命中）', () => {
    const text = new Set(articleFtsText(base).split(' '))
    for (const tok of queryTokens('1077')) expect(text.has(tok)).toBe(true)
  })

  it('空编/章节字段被过滤，不产生多余分词', () => {
    const text = articleFtsText({ ...base, branch: '', chapter: '  ', section: '' })
    expect(text).not.toContain('  ')
  })
})

describe('chunkFtsText', () => {
  it('文档标题并入段落索引（搜书名/案例名可命中）', () => {
    const text = new Set(chunkFtsText('鼠肝与虫臂的管制', '法理学与生命伦理探究').split(' '))
    for (const tok of queryTokens('鼠肝')) expect(text.has(tok)).toBe(true)
  })

  it('标题为空时只剩正文', () => {
    expect(chunkFtsText('', '离婚冷静期制度')).toBe(tokenize('离婚冷静期制度'))
  })
})
