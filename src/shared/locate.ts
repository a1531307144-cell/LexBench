// 法条定位纯函数：查询解析 + 法规名匹配
// 逐行移植自 legacy/backend/app/services/search.py 的 parse_locate_query /
// _is_subsequence / match_documents（不含数据库部分；docs 由调用方从 documents
// 表取出 doc_type='statute' 的 id/title 后传入）

import { cn2num } from './cnnum'

/** 定位查询：hint = 去掉条号片段后的法规名提示（可为空串），article_no = 条号 */
export interface LocateQuery {
  hint: string
  article_no: number
}

// 第X条：X 允许中文数字/阿拉伯数字/零〇，允许空白间隔；全文任意位置（非仅行首）
const ARTICLE_RE = /第\s*([零〇一二三四五六七八九十百千\d]+)\s*条/
// 尾部 1~5 位阿拉伯数字（其后可跟空白）
const TRAILING_NUM_RE = /(\d{1,5})\s*$/

/**
 * 解析法条定位查询："民法典 1077" / "公司法 第51条" → (法规名提示, 条号)。
 * 优先匹配「第X条」（X 经 cn2num 解析，失败则整体定位失败），否则匹配尾部
 * 1~5 位阿拉伯数字；都无法定位（无条号）时返回 null（走全文检索）。
 */
export function parseLocateQuery(q: string): LocateQuery | null {
  const s = q.trim()
  if (!s) return null
  const m = ARTICLE_RE.exec(s)
  if (m) {
    const no = cn2num(m[1])
    if (no === null) return null
    // hint = 去掉「第X条」片段后的剩余文本（前后空白去除）
    const hint = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim()
    return { hint, article_no: no }
  }
  const t = TRAILING_NUM_RE.exec(s)
  if (t) {
    // hint = 去尾数字后的前缀
    return { hint: s.slice(0, t.index).trim(), article_no: parseInt(t[1], 10) }
  }
  return null
}

/**
 * hint 的每个字符都能按序在 title 中找到（子序列，不要求连续）。
 * 等价 Python `all(ch in it for ch in hint)` 的 iter 惰性消费语义：
 * 每个字符消费 title 到其首次出现处，找不到即失败。
 */
export function isSubsequence(hint: string, title: string): boolean {
  const it = title[Symbol.iterator]()
  for (const ch of hint) {
    let found = false
    for (const t of it) {
      if (t === ch) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

/**
 * 按法规名提示匹配法规文档 id：子串命中（原题名或去"中华人民共和国"的规范化
 * 题名）进 exact，其次子序列命中（支持"民诉法"式简写）进 fuzzy；
 * exact 排前、fuzzy 排后，组内按 id 升序。hint 为空 = 全部法规，保持原序。
 */
export function matchDocumentIds(docs: { id: number; title: string }[], hint: string): number[] {
  if (!hint) return docs.map((d) => d.id)
  const exact: number[] = []
  const fuzzy: number[] = []
  for (const d of docs) {
    const norm = d.title.replaceAll('中华人民共和国', '')
    if (d.title.includes(hint) || norm.includes(hint)) {
      exact.push(d.id)
    } else if (isSubsequence(hint, d.title)) {
      // 子序列只对原题名做（与 legacy 一致；去字不会破坏子序列，无需对 norm 再查）
      fuzzy.push(d.id)
    }
  }
  const byId = (a: number, b: number) => a - b
  exact.sort(byId)
  fuzzy.sort(byId)
  return exact.concat(fuzzy)
}
