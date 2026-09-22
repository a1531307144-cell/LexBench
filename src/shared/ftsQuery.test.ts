// FTS5 MATCH 构造单测：字面量化（AND/OR/NOT 不炸语法）+ 末词前缀

import { describe, expect, it } from 'vitest'
import { buildMatchString, buildPrecisionMatch } from './ftsQuery'

describe('buildMatchString', () => {
  it('每个 token 双引号包裹并以 OR 连接', () => {
    expect(buildMatchString(['离婚', '冷静期'])).toBe('"离婚" OR "冷静期"')
  })

  it('大写 AND/OR/NOT 被字面量化（不再产生 fts5 语法错误）', () => {
    expect(buildMatchString(['合同', 'AND', '违约'])).toBe('"合同" OR "AND" OR "违约"')
    expect(buildMatchString(['OR'])).toBe('"OR"')
    expect(buildMatchString(['NOT'])).toBe('"NOT"')
  })

  it('token 内的双引号加倍（字面量化转义）', () => {
    expect(buildMatchString(['a"b'])).toBe('"a""b"')
  })

  it('prefixLast 给末词加 *（要求 ≥2 字）', () => {
    expect(buildMatchString(['冷静', '期满'], { prefixLast: true })).toBe('"冷静" OR "期满"*')
    expect(buildMatchString(['民法', '典'], { prefixLast: true })).toBe('"民法" OR "典"')
  })

  it('默认不加前缀', () => {
    expect(buildMatchString(['冷静'], { prefixLast: false })).toBe('"冷静"')
    expect(buildMatchString(['冷静'])).toBe('"冷静"')
  })

  it('空列表/全空串 → 空串；空串 token 被过滤', () => {
    expect(buildMatchString([])).toBe('')
    expect(buildMatchString(['', ''])).toBe('')
    expect(buildMatchString(['', '甲'])).toBe('"甲"')
  })
})

describe('buildPrecisionMatch', () => {
  it('短语优先：整句按索引侧分词成相邻词串（光污染 → "光 污染"）', () => {
    expect(buildPrecisionMatch(['污染'], ['光', '污染'])).toBe('"光 污染"')
  })

  it('多词时附带全词交集（AND 组）', () => {
    expect(buildPrecisionMatch(['国家', '利益'], ['国家', '利益'])).toBe(
      '"国家 利益" OR ("国家" AND "利益")'
    )
  })

  it('单 token 且无短语 → 直接字面量化', () => {
    expect(buildPrecisionMatch(['海商法'], [])).toBe('"海商法"')
  })

  it('短语中的引号转义、空词过滤', () => {
    expect(buildPrecisionMatch([], ['a"b', ''])).toBe('"a""b"')
  })

  it('空输入 → 空串', () => {
    expect(buildPrecisionMatch([], [])).toBe('')
  })
})
