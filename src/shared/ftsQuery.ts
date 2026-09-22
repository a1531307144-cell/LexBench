// FTS5 MATCH 串构造：token 一律双引号字面量化 + 可选末词前缀
// 实测（node:sqlite）：裸词 AND/OR/NOT 会抛 fts5 syntax error，加引号即安全；
// "tok"* 前缀语法合法且能命中更长 token（民* 命中 民法典）

export interface MatchOptions {
  /** 给最后一个 token 加 * 前缀（用户正打到一半的词也能命中）；要求该词 ≥2 字 */
  prefixLast?: boolean
}

/**
 * 把查询 token 列表拼成 MATCH 表达式：每个 token 双引号包裹（内部 " 加倍），
 * 以 OR 连接（部分命中也召回，沿用 legacy 语义）。
 * prefixLast 时且末词长度 ≥2 → 追加 `*`。空列表返回空串。
 */
export function buildMatchString(tokens: string[], opts: MatchOptions = {}): string {
  const list = tokens.filter((t) => t.length > 0)
  if (list.length === 0) return ''
  const quoted = list.map((t) => `"${t.replaceAll('"', '""')}"`)
  if (opts.prefixLast) {
    const i = list.length - 1
    if (list[i].length >= 2) quoted[i] = `${quoted[i]}*`
  }
  return quoted.join(' OR ')
}

/**
 * 精准层 MATCH：整句短语 OR（全 token 交集）——「精准搜索」那一段。
 * - 短语 = 原查询按【索引侧同一分词】（tokenize，含单字）切词后的相邻词串，
 *   一词不差地连着出现才命中（「光污染」→ "光 污染"，不会退化成任意「污染」）。
 * - 交集 = queryTokens 的全部 ≥2 字词同时出现（≥2 词时才需要，避免与短语重复）。
 * 两段以 OR 相连：字面词组 或 全词齐活 任一满足即入精准块；都靠 loose（任意词）兜底。
 */
export function buildPrecisionMatch(tokens: string[], phraseWords: string[]): string {
  const parts: string[] = []
  const phrase = phraseWords
    .filter((w) => w.length > 0)
    .map((w) => w.replaceAll('"', '""'))
    .join(' ')
  if (phrase) parts.push(`"${phrase}"`)
  const quoted = tokens.filter((t) => t.length > 0).map((t) => `"${t.replaceAll('"', '""')}"`)
  if (quoted.length >= 2) parts.push(`(${quoted.join(' AND ')})`)
  else if (quoted.length === 1 && !phrase) parts.push(quoted[0])
  return parts.join(' OR ')
}
