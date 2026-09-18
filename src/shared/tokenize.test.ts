import { describe, expect, it } from 'vitest'

import { queryTokens, tokenize } from './tokenize'

describe('tokenize（建索引切词）', () => {
  it('中文短语按词切开、空格拼接', () => {
    expect(tokenize('离婚冷静期')).toBe('离婚 冷静 期')
    expect(tokenize('夫妻共同债务的认定与清偿')).toBe('夫妻 共同 债务 的 认定 与 清偿')
  })

  it('混合中英数：字母数字段整体保留', () => {
    expect(tokenize('民法典第1077条')).toBe('民法 典 第 1077 条')
    expect(tokenize('user_id 与 contract_no')).toBe('user_id 与 contract_no')
  })

  it('标点与空白不入索引', () => {
    expect(tokenize('夫妻、共同债务。')).toBe('夫妻 共同 债务')
    expect(tokenize('   ')).toBe('')
  })

  it('空串返回空串', () => {
    expect(tokenize('')).toBe('')
  })
})

describe('queryTokens（查询切词）', () => {
  it('仅保留 ≥2 字词，保持出现顺序', () => {
    expect(queryTokens('离婚 冷静期')).toEqual(['离婚', '冷静'])
    expect(queryTokens('民法典第1077条')).toEqual(['民法', '1077'])
  })

  it('去重且保持首次出现顺序', () => {
    expect(queryTokens('离婚 离婚 冷静')).toEqual(['离婚', '冷静'])
  })

  it('全为单字时降级为单字匹配（同样去重、保序）', () => {
    expect(queryTokens('民 法')).toEqual(['民', '法'])
    expect(queryTokens('好 好 学 习')).toEqual(['好', '学', '习'])
  })

  it('空串与纯标点返回空数组', () => {
    expect(queryTokens('')).toEqual([])
    expect(queryTokens('   ')).toEqual([])
    expect(queryTokens('。，！')).toEqual([])
  })

  it('同一输入 tokenize 与 queryTokens 的词集合一致（≥2 字时）', () => {
    const inputs = ['夫妻共同债务的认定与清偿', 'user_id 与 contract_no 关联', '民法典第1077条']
    for (const text of inputs) {
      // 从索引侧结果推导期望集合：过滤单字后去重，应与查询侧完全一致
      const fromIndex = [...new Set(tokenize(text).split(' ').filter((w) => w.length >= 2))]
      expect(new Set(queryTokens(text))).toEqual(new Set(fromIndex))
    }
  })
})
