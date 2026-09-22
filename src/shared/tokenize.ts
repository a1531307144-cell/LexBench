// 分词：统一用运行时内置 Intl.Segmenter 替代旧版 jieba（索引与查询必须走同一实现）
// 注意：JS 正则的 \w 只匹配 ASCII，而 legacy Python 的 ^\w+$（re.UNICODE）含中文；
// 故等价改写为 Unicode 属性 [\p{L}\p{N}_]（字母/数字/下划线），保证中文词不被过滤

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

// 词形段：由 Unicode 字母/数字/下划线组成（对应 legacy _TOKEN_RE 的 Unicode 语义）
const TOKEN_RE = /^[\p{L}\p{N}_]+$/u

/** 建索引用：切词后保留词形段，空格拼接（配合 FTS5 unicode61 按空格分 token）；
 *  入口 NFKC 归一——全角「１０７７」与半角「1077」切成同一 token */
export function tokenize(text: string): string {
  const words: string[] = []
  for (const { segment, isWordLike } of segmenter.segment((text ?? '').normalize('NFKC'))) {
    if (isWordLike && TOKEN_RE.test(segment)) words.push(segment)
  }
  return words.join(' ')
}

/** 查询用：仅保留 ≥2 字词并去重；全为单字时降级为单字匹配（语义对应 legacy _query_tokens） */
export function queryTokens(q: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  const s = (q ?? '').trim().normalize('NFKC')
  for (const { segment, isWordLike } of segmenter.segment(s)) {
    const t = segment.trim()
    if (isWordLike && t && t.length >= 2 && !seen.has(t) && TOKEN_RE.test(t)) {
      seen.add(t)
      tokens.push(t)
    }
  }
  if (tokens.length > 0) return tokens
  // 降级：全是单字（或无词）时保留单字匹配，同样去重、保持顺序
  for (const { segment, isWordLike } of segmenter.segment(s)) {
    const t = segment.trim()
    if (isWordLike && t && !seen.has(t) && TOKEN_RE.test(t)) {
      seen.add(t)
      tokens.push(t)
    }
  }
  return tokens
}
