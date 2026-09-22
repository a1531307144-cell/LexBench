// FTS 索引文本公式：把标题/条标/条号/编章节并入 content 列的分词文本
// ——搜法规名（生态环境法典）、搜条文号（第一千零七十七条 / 1077）从此可命中。
// 显示摘要仍读 articles.content 原文，不受本公式影响；FTS 表结构不变，无需迁移。

import { tokenize } from './tokenize'

export interface ArticleFtsFields {
  /** 文档标题（法规名） */
  title: string
  /** 条标原文，如「第一千零七十七条」 */
  label: string
  /** 阿拉伯条号，如 1077 */
  articleNo: number
  branch: string
  chapter: string
  section: string
  content: string
}

/** 法条类 FTS 文本：标题 + 条标 + 条号 + 编/章/节 + 正文（统一再分词） */
export function articleFtsText(a: ArticleFtsFields): string {
  return tokenize(
    [a.title, a.label, String(a.articleNo), a.branch, a.chapter, a.section, a.content]
      .filter((s) => s && s.trim())
      .join(' ')
  )
}

/** 段落类 FTS 文本：文档标题（书名/案例名）+ 正文 */
export function chunkFtsText(title: string, content: string): string {
  return tokenize([title, content].filter((s) => s && s.trim()).join(' '))
}
