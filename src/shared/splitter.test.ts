// splitter 单测：镜像 legacy/backend/tests/unit/test_splitter.py 的全部期望

import { describe, expect, it } from 'vitest'
import { detectDocType, splitStatute } from './splitter'

const STATUTE_PARAGRAPHS = [
  '中华人民共和国民法典',
  '第一编 总则',
  '第一章 基本规定',
  '第一条 为了保护民事主体的合法权益，调整民事关系，维护社会和经济秩序，适应中国特色社会主义发展要求，弘扬社会主义核心价值观，根据宪法，制定本法。',
  '第二条 民法调整平等主体的自然人、法人和非法人组织之间的人身关系和财产关系。',
  '第一编 物权',
  '第二章 其他规定',
  '第一百条之一 本编规定的情形，适用本编的规定。',
  '第一千零七十七条 自婚姻登记机关收到离婚登记申请之日起三十日内，任何一方不愿意离婚的，可以向婚姻登记机关撤回离婚登记申请。',
  '前款规定期间届满后三十日内，双方应当亲自到婚姻登记机关申请发给离婚证；未申请的，视为撤回离婚登记申请。',
]

describe('splitStatute', () => {
  it('基础切分：条数、首条的条号与层级', () => {
    const articles = splitStatute(STATUTE_PARAGRAPHS)
    expect(articles).toHaveLength(4)
    const first = articles[0]
    expect(first.label).toBe('第一条')
    expect(first.no).toBe(1)
    expect(first.branch).toBe('第一编 总则')
    expect(first.chapter).toBe('第一章 基本规定')
    expect(first.content.startsWith('为了保护民事主体')).toBe(true)
  })

  it('编/章切换后，后续条文继承新层级', () => {
    const articles = splitStatute(STATUTE_PARAGRAPHS)
    const last = articles[articles.length - 1]
    expect(last.branch).toBe('第一编 物权')
    expect(last.chapter).toBe('第二章 其他规定')
  })

  it('新章开始后，上一章的"节"不泄漏到本章条文', () => {
    // 如民法典离婚章无节，第四章条文不应带上第三章的节
    const paragraphs = [
      '第三章 家庭关系',
      '第一节 夫妻关系',
      '第一千零六十二条 夫妻共同财产。',
      '第四章 离婚',
      '第一千零七十七条 离婚冷静期。',
    ]
    const articles = splitStatute(paragraphs)
    expect(articles[1].chapter).toBe('第四章 离婚')
    expect(articles[1].section).toBe('')
  })

  it('续段以换行并入当前条内容', () => {
    const articles = splitStatute(STATUTE_PARAGRAPHS)
    const last = articles[articles.length - 1]
    // 第1077条两段合并，中间以换行分隔
    expect(last.content).toContain('前款规定期间届满后')
    expect(last.content.split('\n').length - 1).toBe(1)
  })

  it('"之X"变体保留在条标中，条号取主条号', () => {
    const articles = splitStatute(STATUTE_PARAGRAPHS)
    const zhi = articles[2]
    expect(zhi.label).toBe('第一百条之一')
    expect(zhi.no).toBe(100)
  })

  it('中文数字条号转换为整数', () => {
    const articles = splitStatute(STATUTE_PARAGRAPHS)
    const last = articles[articles.length - 1]
    expect(last.no).toBe(1077)
    expect(last.label).toBe('第一千零七十七条')
  })

  it('条内提及"第五百零九条"不触发切分（非行首）', () => {
    const paragraphs = [
      '第一条 内容。',
      '当事人应当依照本法第五百零九条的规定履行义务。',
    ]
    const articles = splitStatute(paragraphs)
    expect(articles).toHaveLength(1)
    expect(articles[0].content).toContain('第五百零九条')
  })

  it('阿拉伯数字条号同样识别', () => {
    const paragraphs = ['第1077条 自婚姻登记机关收到离婚登记申请之日起三十日内。']
    const articles = splitStatute(paragraphs)
    expect(articles).toHaveLength(1)
    expect(articles[0].no).toBe(1077)
  })

  it('空段落列表返回空数组', () => {
    expect(splitStatute([])).toEqual([])
  })

  it('order_index 按切分顺序回填', () => {
    const articles = splitStatute(STATUTE_PARAGRAPHS)
    articles.forEach((a, i) => expect(a.order_index).toBe(i))
  })

  // ---------- 分编层级（民法典/生态环境法典式法典；旧版吞行 + 目录丢层的回归） ----------

  it('分编标题行设为层级戳记，后续条文继承', () => {
    const paragraphs = [
      '第一编 总则',
      '第一条 甲。',
      '第二编 物权',
      '第一分编 通则',
      '第二章 一般规定',
      '第二条 乙。',
    ]
    const articles = splitStatute(paragraphs)
    expect(articles[1].subbranch).toBe('第一分编 通则')
    expect(articles[1].branch).toBe('第二编 物权')
    expect(articles[1].chapter).toBe('第二章 一般规定')
    expect(articles[0].subbranch).toBe('')
  })

  it('分编标题行不吞进上一条正文（旧版最大污染源）', () => {
    const paragraphs = [
      '第一编 总则',
      '第一条 甲。',
      '第二编 物权',
      '第一分编 通则',
      '第二条 乙。',
    ]
    const articles = splitStatute(paragraphs)
    expect(articles[0].content).toBe('甲。')
    expect(articles[0].content).not.toContain('分编')
  })

  it('新编清空分编，新分编清空章/节', () => {
    const paragraphs = [
      '第二编 物权',
      '第一分编 通则',
      '第三章 所有权',
      '第一节 一般规定',
      '第二条 乙。',
      // 新编：分编/章/节全部清掉（该编无分编，等标题到来）
      '第四编 人格权',
      '第三条 丙。',
      // 另起分编：章/节清掉
      '第二分编 所有权',
      '第四条 丁。',
    ]
    const articles = splitStatute(paragraphs)
    expect(articles[0]).toMatchObject({ subbranch: '第一分编 通则', chapter: '第三章 所有权', section: '第一节 一般规定' })
    expect(articles[1]).toMatchObject({ branch: '第四编 人格权', subbranch: '', chapter: '', section: '' })
    expect(articles[2]).toMatchObject({ subbranch: '第二分编 所有权', chapter: '', section: '' })
  })

  it('无标题的裸「第X分编」不设戳记（与编/章/节正则语义一致）', () => {
    const paragraphs = ['第一条 甲。', '第一分编', '第二条 乙。']
    const articles = splitStatute(paragraphs)
    expect(articles[0].subbranch).toBe('')
    expect(articles[1].subbranch).toBe('')
  })
})

describe('detectDocType', () => {
  it('条文起始行达到下限判为 statute', () => {
    expect(detectDocType(STATUTE_PARAGRAPHS)).toBe('statute')
  })

  it('含案号或文书特征词判为 case', () => {
    const paragraphs = [
      '北京市海淀区人民法院民事判决书',
      '（2023）京0108民初12345号',
      '裁判要旨：夫妻共同债务的认定应当……',
      '本院认为，……',
    ]
    expect(detectDocType(paragraphs)).toBe('case')
  })

  it('其余判为 other', () => {
    const paragraphs = ['关于民法典的学习笔记', '离婚冷静期制度的来龙去脉。']
    expect(detectDocType(paragraphs)).toBe('other')
  })
})
