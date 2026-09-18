// 检索服务：法条定位 + 全文检索（移植自 legacy/backend/app/services/search.py + routers/search.py）
// 原则：定位优先、全文兜底（auto 模式定位零结果自动降级，响应 mode 同步变化）；
//       FTS 表只读（articles_fts / chunks_fts 的写入与重建归 library.ts 管）；
//       依赖 ./db 的 getDb()（node:sqlite 单例连接）与 @shared 的 locate/tokenize 纯函数

import { ipcMain } from 'electron'
import type { ArticleRow, DocType, SearchHit, SearchMode, SearchOutcome } from '../shared/types'
import { matchDocumentIds, parseLocateQuery } from '@shared/locate'
import { queryTokens } from '@shared/tokenize'
import { getDb } from './db'

/** 定位结果上限（legacy search_locate limit=20） */
const LOCATE_LIMIT = 20
/** 全文检索每类结果上限：法条、段落各 50（legacy search_fulltext limit=50） */
const FULLTEXT_LIMIT = 50
/** 摘要窗口宽度（legacy make_snippet width=80） */
const SNIPPET_WIDTH = 80
/** 摘要窗口向前回看的字符数（窗口 [hit-20, hit+width]） */
const SNIPPET_BACK = 20

// ---------- 摘要与高亮（移植自 search.py 的 make_snippet / highlight） ----------

/** HTML 转义（等价 Python html.escape：& < > " ' 五个字符，& 必须最先替换） */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}

/** 正则元字符转义（等价 Python re.escape；当前 token 均为字母/数字/下划线，此步是保底） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 高亮：先转义全文，再按 token 长度降序拼正则，把命中片段包上 <em>（长词优先避免被短词截断） */
function highlight(text: string, tokens: string[]): string {
  const escaped = escapeHtml(text)
  const alts = [...new Set(tokens.filter((t) => t).map(escapeRegExp))].sort(
    (a, b) => b.length - a.length
  )
  if (alts.length === 0) return escaped
  return escaped.replace(new RegExp(alts.join('|'), 'g'), (m) => `<em>${m}</em>`)
}

/**
 * 摘要：找最长 token 的首次出现位置，截取窗口 [hit-20, hit+width]，
 * 越过首尾时补 …；无命中取前 width 字（超长补 …）。
 */
function makeSnippet(content: string, tokens: string[], width = SNIPPET_WIDTH): string {
  if (!content) return ''
  let hit = -1
  for (const t of [...tokens].sort((a, b) => b.length - a.length)) {
    hit = content.indexOf(t)
    if (hit >= 0) break
  }
  if (hit < 0) {
    const snippet = content.slice(0, width)
    return highlight(snippet, tokens) + (content.length > width ? '…' : '')
  }
  const start = Math.max(0, hit - SNIPPET_BACK)
  const end = Math.min(content.length, hit + width)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + highlight(content.slice(start, end), tokens) + suffix
}

// ---------- 法条定位（移植自 search.py 的 search_locate） ----------

/** 法条定位：解析查询 → 匹配法规（hint 空全返回）→ 按 article_no 精确取条 */
function searchLocate(query: string, limit = LOCATE_LIMIT): SearchHit[] {
  const parsed = parseLocateQuery(query)
  if (!parsed) return []
  const db = getDb()
  const statutes = db
    .prepare("SELECT id, title FROM documents WHERE doc_type='statute' ORDER BY id")
    .all() as unknown as Array<{ id: number; title: string }>
  let docIds = matchDocumentIds(statutes, parsed.hint)
  if (docIds.length === 0) {
    // 提示词匹配不到任何法规时，退化为在所有法规中按条号找
    docIds = statutes.map((d) => d.id)
  }
  if (docIds.length === 0) return []
  const placeholders = docIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT a.id, a.document_id, a.article_label, a.article_no, a.branch,
              a.chapter, a.section, a.content, a.order_index,
              d.title, d.category
       FROM articles a JOIN documents d ON d.id = a.document_id
       WHERE a.document_id IN (${placeholders}) AND a.article_no = ?
       ORDER BY a.document_id, a.order_index LIMIT ?`
    )
    .all(...docIds, parsed.article_no, limit) as unknown as Array<
    ArticleRow & { title: string; category: string }
  >
  return rows.map((r): SearchHit => ({
    kind: 'article',
    id: r.id,
    document_id: r.document_id,
    doc_type: 'statute',
    title: r.title,
    category: r.category,
    label: r.article_label,
    branch: r.branch,
    chapter: r.chapter,
    section: r.section,
    content: r.content,
    order_index: r.order_index
  }))
}

// ---------- 全文检索（移植自 search.py 的 search_fulltext） ----------

/** 全文检索：FTS5 OR 匹配 + bm25 排序，主进程侧做摘要高亮；返回法条与段落两类结果 */
function searchFulltext(q: string, limit = FULLTEXT_LIMIT): SearchHit[] {
  const tokens = queryTokens(q)
  if (tokens.length === 0) return []
  // OR 匹配 + bm25 排序：多关键词部分命中也召回（如"离婚 冷静期"——
  // 第1077条原文并不含"冷静期"，AND 会漏掉它），命中期越多排越前。
  // FTS5 内置 rank（即 bm25()，越小越相关）；MATCH 词不加引号，与 legacy 一致
  const match = tokens.join(' OR ')
  const db = getDb()
  const results: SearchHit[] = []

  // 法条类：articles_fts JOIN articles JOIN documents
  const articleRows = db
    .prepare(
      `SELECT a.id, a.document_id, a.article_label, a.content,
              d.title, d.doc_type, d.category
       FROM articles_fts f
       JOIN articles a ON a.id = f.article_id
       JOIN documents d ON d.id = a.document_id
       WHERE articles_fts MATCH ?
       ORDER BY rank LIMIT ?`
    )
    .all(match, limit) as unknown as Array<{
    id: number
    document_id: number
    article_label: string
    content: string
    title: string
    doc_type: DocType
    category: string
  }>
  for (const r of articleRows) {
    results.push({
      kind: 'article',
      id: r.id,
      document_id: r.document_id,
      doc_type: r.doc_type,
      title: r.title,
      category: r.category,
      label: r.article_label,
      snippet: makeSnippet(r.content, tokens)
    })
  }

  // 段落类：chunks_fts JOIN chunks JOIN documents（案例等非法规文档），label 统一"第N段"
  const chunkRows = db
    .prepare(
      `SELECT c.id, c.document_id, c.seq, c.content,
              d.title, d.doc_type, d.category
       FROM chunks_fts f
       JOIN chunks c ON c.id = f.chunk_id
       JOIN documents d ON d.id = c.document_id
       WHERE chunks_fts MATCH ?
       ORDER BY rank LIMIT ?`
    )
    .all(match, limit) as unknown as Array<{
    id: number
    document_id: number
    seq: number
    content: string
    title: string
    doc_type: DocType
    category: string
  }>
  for (const r of chunkRows) {
    results.push({
      kind: 'chunk',
      id: r.id,
      document_id: r.document_id,
      doc_type: r.doc_type,
      title: r.title,
      category: r.category,
      label: `第${r.seq + 1}段`,
      snippet: makeSnippet(r.content, tokens)
    })
  }
  return results
}

// ---------- IPC 注册 ----------

export function registerSearchIpc(): void {
  // 统一检索入口：auto 归一（解析出条号走定位，否则走全文）→ 定位零结果自动降级全文
  ipcMain.handle('search:run', (_e, rawQ: unknown, mode: SearchMode): SearchOutcome => {
    const q = String(rawQ ?? '').trim()
    if (!q) return { mode: 'none', query: q, results: [] }
    // 模式归一（对应 legacy 路由：auto 依解析结果二选一；契约外取值按全文处理）
    let m: 'locate' | 'fulltext'
    if (mode === 'auto') m = parseLocateQuery(q) ? 'locate' : 'fulltext'
    else if (mode === 'locate') m = 'locate'
    else m = 'fulltext'
    let results: SearchHit[] = []
    if (m === 'locate') {
      results = searchLocate(q)
      if (results.length === 0) m = 'fulltext' // 定位无结果 → 降级全文（响应 mode 同步变化）
    }
    if (m === 'fulltext') results = searchFulltext(q)
    return { mode: m, query: q, results }
  })
}
