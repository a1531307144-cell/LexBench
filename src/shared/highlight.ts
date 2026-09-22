// 关键词高亮（全搜索面统一）：词条构造 + 转义 + 长度优先 <em> 包裹
// 原则：完整呈现用户输入的关键词——分词会截短（「光污染」→「污染」、「民法典 1077」
// 的单字段被丢），词条必须并入原查询、空白词段与 NFKC/去空格变体；展示层配色走 --lb-hit

import { queryTokens } from './tokenize'

/** HTML 转义（& 最先；& < > " ' 五字符）——高亮结果直接 v-html，安全由它保证 */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}

/** 正则元字符转义 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 高亮词条：完整原查询 + NFKC 归一 + 去空格变体 + 按空白切出的词段 + 分词 token。
 * 「民法典 1077」→ 含「民法典」「1077」两个可整词着色的段；「光污染」→ 含整词。
 */
export function buildHighlightTerms(q: string): string[] {
  const raw = (q ?? '').trim()
  if (!raw) return []
  const nfkc = raw.normalize('NFKC')
  const parts = nfkc.split(/\s+/).filter(Boolean)
  return [...new Set([raw, nfkc, nfkc.replace(/\s+/g, ''), ...parts, ...queryTokens(nfkc)])]
}

/**
 * 转义全文后按词条（长度优先，长词整包不被短词截断）包 <em>——
 * 返回可直接 v-html 的安全 HTML；无词条时返回转义后的原文。
 */
export function highlightText(text: string, terms: string[]): string {
  const escaped = escapeHtml(text)
  const alts = [...new Set(terms.filter((t) => t.length > 0).map(escapeRegExp))].sort(
    (a, b) => b.length - a.length
  )
  if (alts.length === 0) return escaped
  return escaped.replace(new RegExp(alts.join('|'), 'g'), (m) => `<em>${m}</em>`)
}
