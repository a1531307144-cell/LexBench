// 法条定位纯函数单元测试：parseLocateQuery 镜像 legacy/backend/tests/unit/test_query_parse.py
// 的全部期望值；另补 isSubsequence / matchDocumentIds 的子序列与排序语义
import { describe, expect, it } from 'vitest'

import { isSubsequence, matchDocumentIds, parseLocateQuery } from './locate'

describe('parseLocateQuery', () => {
  describe('可定位（镜像 legacy 参数化用例）', () => {
    it.each([
      ['民法典 1077', '民法典', 1077],
      ['公司法 第51条', '公司法', 51],
      ['婚姻家庭编解释一 69', '婚姻家庭编解释一', 69],
      ['民法典1077', '民法典', 1077],
      ['民法典第一千零七十七条', '民法典', 1077],
      ['第1077条', '', 1077],
      ['1077', '', 1077],
      ['民法典 第1077条', '民法典', 1077],
    ])('%s → hint=%s / no=%i', (query, hint, no) => {
      expect(parseLocateQuery(query)).toEqual({ hint, article_no: no })
    })
  })

  describe('可定位（补充边界）', () => {
    it('「第X条」内部允许空白间隔', () => {
      expect(parseLocateQuery('民法典 第 1077 条')).toEqual({ hint: '民法典', article_no: 1077 })
    })
    it('「第X条」优先于尾部数字', () => {
      // 若先走尾数字会解析出 999，正确行为是「第51条」命中、999 留在 hint
      expect(parseLocateQuery('第51条 999')).toEqual({ hint: '999', article_no: 51 })
    })
    it('「第X条」后的剩余文本保留在 hint 中', () => {
      expect(parseLocateQuery('公司法 第51条第一款')).toEqual({
        hint: '公司法 第一款',
        article_no: 51,
      })
    })
    it('尾数字限 1~5 位，超长只取末 5 位（与 legacy 正则一致）', () => {
      expect(parseLocateQuery('123456')).toEqual({ hint: '1', article_no: 23456 })
    })
  })

  describe('解析加宽（2026-09 搜索加固）', () => {
    it('尾部「N条」可无「第」（民法典1077条）', () => {
      expect(parseLocateQuery('民法典1077条')).toEqual({ hint: '民法典', article_no: 1077 })
    })
    it('尾部杂符剥除后再解析（民法典1077。/ ？/ 、）', () => {
      expect(parseLocateQuery('民法典1077。')).toEqual({ hint: '民法典', article_no: 1077 })
      expect(parseLocateQuery('民法典 1077？')).toEqual({ hint: '民法典', article_no: 1077 })
      expect(parseLocateQuery('民法典1077条。')).toEqual({ hint: '民法典', article_no: 1077 })
    })
    it('尾部「N年」剥除后再解析（民法典1077年）', () => {
      expect(parseLocateQuery('民法典1077年')).toEqual({ hint: '民法典', article_no: 1077 })
    })
    it('NFKC 归一：全角数字/全角空格（第１０７７条、民法典　１０７７）', () => {
      expect(parseLocateQuery('第１０７７条')).toEqual({ hint: '', article_no: 1077 })
      expect(parseLocateQuery('民法典　１０７７')).toEqual({ hint: '民法典', article_no: 1077 })
    })
    it('纯标点查询 → null', () => {
      expect(parseLocateQuery('。，！')).toBeNull()
      expect(parseLocateQuery('  ')).toBeNull()
    })
  })

  describe('不可定位 → null（镜像 legacy 参数化用例）', () => {
    it.each(['离婚 冷静期', '民法典', '', '劳动法加班费'])('%s → null', (query) => {
      expect(parseLocateQuery(query)).toBeNull()
    })
    it('纯空白 → null', () => {
      expect(parseLocateQuery('   ')).toBeNull()
    })
  })
})

describe('isSubsequence', () => {
  it('hint 每个字符按序出现在 title 中即命中（不要求连续）', () => {
    expect(isSubsequence('民诉法', '中华人民共和国民事诉讼法')).toBe(true)
    expect(isSubsequence('民事诉讼法', '民事诉讼法')).toBe(true)
    // 非连续子串但为子序列："民…法"被"事诉讼"隔开
    expect(isSubsequence('民法', '中华人民共和国民事诉讼法')).toBe(true)
  })
  it('乱序或缺字不命中', () => {
    expect(isSubsequence('诉民法', '中华人民共和国民事诉讼法')).toBe(false)
    expect(isSubsequence('民诉法', '民法典')).toBe(false)
  })
  it('空 hint 恒命中（Python all(空) 语义）', () => {
    expect(isSubsequence('', '民法典')).toBe(true)
  })
})

describe('matchDocumentIds', () => {
  const LAWS = [
    { id: 1, title: '中华人民共和国民法典' },
    { id: 2, title: '中华人民共和国民事诉讼法' },
    { id: 3, title: '中华人民共和国公司法' },
  ]

  it('hint 为空 → 全部法规，保持原序', () => {
    expect(matchDocumentIds(LAWS, '')).toEqual([1, 2, 3])
  })
  it('子串命中进 exact（原题名或去"中华人民共和国"的规范化题名）', () => {
    expect(matchDocumentIds(LAWS, '民法典')).toEqual([1])
    expect(matchDocumentIds(LAWS, '公司法')).toEqual([3])
  })
  it('"民诉法"式简写 → 仅子序列命中进 fuzzy', () => {
    expect(matchDocumentIds(LAWS, '民诉法')).toEqual([2])
  })
  it('exact 排前、fuzzy 排后', () => {
    // "民法"：民法典 子串命中(exact)；民事诉讼**法**、公司**法** 都是子序列命中(fuzzy)
    // ——短 hint 误召回子序列是 legacy 既有的宽松语义（backend-spec §4 已记录），原样保留
    expect(matchDocumentIds(LAWS, '民法')).toEqual([1, 2, 3])
  })
  it('组内按 id 升序：输入乱序时输出仍有序', () => {
    const docs = [
      { id: 3, title: '中华人民共和国公司法（2023修订）' },
      { id: 1, title: '中华人民共和国公司法' },
    ]
    expect(matchDocumentIds(docs, '公司法')).toEqual([1, 3])
  })
  it('去国名归一化让跨删除边界的子串进 exact（而非仅 fuzzy）', () => {
    // hint 跨"中华人民共和国"删除边界：两题名均非子串命中；
    // 但规范化后 doc 2 为子串 → exact，doc 1 仅子序列 → fuzzy，故 [2, 1]
    const docs = [
      { id: 1, title: '有关适用的《中华人民共和国民法典》规定' },
      { id: 2, title: '最高人民法院关于适用《中华人民共和国民事诉讼法》的解释' },
    ]
    expect(matchDocumentIds(docs, '适用《民')).toEqual([2, 1])
  })
  it('无任何命中 → 空数组', () => {
    expect(matchDocumentIds(LAWS, '刑法')).toEqual([])
  })
  it('「之一/之N」尾缀重试：hint 带之一时剥尾再匹配（fallback-only）', () => {
    // 「之一」属于条文表达式不该污染法规名——parse 保留 legacy hint，匹配层兜住
    expect(matchDocumentIds(LAWS, '民法典之一')).toEqual([1])
    expect(matchDocumentIds(LAWS, '公司法之二')).toEqual([3])
  })
  it('之一重试不覆盖成功匹配', () => {
    // 「民法典」本身就命中，无需也不会走重试
    expect(matchDocumentIds(LAWS, '民法典')).toEqual([1])
  })
})
