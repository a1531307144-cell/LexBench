// cn2num 单元测试：镜像 legacy/backend/tests/unit/test_cn2num.py 的全部期望值
import { describe, expect, it } from 'vitest'

import { cn2num } from './cnnum'

describe('cn2num', () => {
  describe('中文数字（≤9999，含零/〇占位）', () => {
    it.each([
      ['一', 1],
      ['九', 9],
      ['十', 10],
      ['十一', 11],
      ['十三', 13],
      ['二十', 20],
      ['二十一', 21],
      ['五十', 50],
      ['一百', 100],
      ['一百零一', 101],
      ['一百二十', 120],
      ['一百二十一', 121],
      ['一百零八', 108],
      ['二百零五', 205],
      ['一千', 1000],
      ['一千零一', 1001],
      ['一千零七十七', 1077],
      ['一千零八十', 1080],
      ['一千二百六十', 1260],
      ['二千零五', 2005],
      ['九千九百九十九', 9999],
      ['〇', 0], // "第〇条"不应出现，但零值容错
      ['零', 0],
    ])('%s → %i', (cn, expected) => {
      expect(cn2num(cn)).toBe(expected)
    })
  })

  describe('阿拉伯数字直接透传', () => {
    it('纯数字串按 parseInt 解析', () => {
      expect(cn2num('1077')).toBe(1077)
      expect(cn2num('51')).toBe(51)
    })
  })

  describe('非法输入返回 null', () => {
    it('空串 / 混入非数字字符', () => {
      expect(cn2num('')).toBeNull()
      expect(cn2num('abc')).toBeNull()
      expect(cn2num('一百X')).toBeNull()
    })
  })
})
