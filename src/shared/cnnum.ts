// 中文数字解析：条文切分 / 法条定位 / 引用解析共用
// 逐行移植自 legacy/backend/app/core/cn2num.py（上限 9999，无"万"；解析失败返回 null）

const DIGITS: Record<string, number> = {
  '零': 0, '〇': 0,
  '一': 1, '二': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}

const UNITS: Record<string, number> = {
  '十': 10, '百': 100, '千': 1000,
}

/** 中文数字（≤9999，含零/〇占位）或阿拉伯数字字符串转 number；无法解析返回 null */
export function cn2num(s: string): number | null {
  if (!s) return null
  // Python 版的 str.isdigit 亦接受全角等 Unicode 数字；条文场景按 ASCII 处理即可
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  let total = 0
  let current = 0
  for (const ch of s) {
    if (ch in DIGITS) {
      current = DIGITS[ch]
    } else if (ch in UNITS) {
      if (current === 0) current = 1 // "十"独立成词表示 10
      total += current * UNITS[ch]
      current = 0
    } else {
      return null
    }
  }
  return total + current
}
