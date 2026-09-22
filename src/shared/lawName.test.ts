import { describe, expect, it } from 'vitest'
import { shortLawName } from './lawName'

describe('shortLawName', () => {
  it('压掉国名前缀', () => {
    expect(shortLawName('中华人民共和国民法典')).toBe('民法典')
    expect(shortLawName('中华人民共和国劳动合同法')).toBe('劳动合同法')
  })

  it('「适用《主体》后缀」取主体做主名', () => {
    expect(shortLawName('最高人民法院关于适用《中华人民共和国民法典》物权编的解释（一）')).toBe(
      '民法典·物权编的解释（一）'
    )
  })

  it('压掉「若干问题」', () => {
    expect(
      shortLawName('最高人民法院关于适用《中华人民共和国涉外民事关系法律适用法》若干问题的解释（二）')
    ).toBe('涉外民事关系法律适用法·解释（二）')
    expect(shortLawName('最高人民法院关于适用《中华人民共和国公司法》若干问题的规定（一）')).toBe(
      '公司法·规定（一）'
    )
  })

  it('机关名后的「人民法院」也压掉', () => {
    expect(shortLawName('最高人民法院关于人民法院民事执行中查封、扣押、冻结财产的规定')).toBe(
      '民事执行中查封、扣押、冻结财产的规定'
    )
  })

  it('起首泛动词压掉', () => {
    expect(shortLawName('最高人民法院关于审理劳动争议案件适用法律问题的解释（一）')).toBe(
      '劳动争议案件适用法律问题的解释（一）'
    )
  })

  it('没有可压的套话时原样返回，绝不返回空', () => {
    expect(shortLawName('中华人民共和国人民法院组织法')).toBe('人民法院组织法') // 「人民法院」后非民事/刑事/行政/执行，不误删
    expect(shortLawName('某某地方性法规')).toBe('某某地方性法规')
    expect(shortLawName('')).toBe('')
    expect(shortLawName('   ')).toBe('')
  })

  // 这条才是这个函数存在的理由：库内最长的两个名字，列表里此前截成同一个样子
  it('同部法规的不同解释，简称必须能区分', () => {
    const one = shortLawName('最高人民法院关于适用《中华人民共和国涉外民事关系法律适用法》若干问题的解释（一）')
    const two = shortLawName('最高人民法院关于适用《中华人民共和国涉外民事关系法律适用法》若干问题的解释（二）')
    expect(one).not.toBe(two)
    expect(one).toContain('（一）')
    expect(two).toContain('（二）')
  })

  it('库内最长的法规名压完仍显著变短，且能放进专题左栏', () => {
    // 左栏一行约放得下 24 个汉字；超过这个长度就还会被截断
    const longest = [
      '最高人民法院关于适用《中华人民共和国涉外民事关系法律适用法》若干问题的解释（一）',
      '最高人民法院关于适用《中华人民共和国涉外民事关系法律适用法》若干问题的解释（二）',
      '最高人民法院关于修改后的民事诉讼法施行时未结案件适用法律若干问题的规定',
      '最高人民法院关于适用《中华人民共和国民事诉讼法》执行程序若干问题的解释',
      '最高人民法院关于审理涉外民商事案件适用国际条约和国际惯例若干问题的解释',
      '最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释',
      '最高人民法院关于适用《中华人民共和国民法典》婚姻家庭编的解释（一）',
      '国务院关于实施《中华人民共和国公司法》注册资本登记管理制度的规定'
    ]
    for (const full of longest) {
      const short = shortLawName(full)
      expect(short.length).toBeLessThan(full.length)
      expect(short.length).toBeLessThanOrEqual(24)
    }
    // 且两两不重复（否则列表里还是会混淆）
    const shorts = longest.map(shortLawName)
    expect(new Set(shorts).size).toBe(longest.length)
  })
})
