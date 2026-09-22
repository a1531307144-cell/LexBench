// 检索服务：法条定位 + 全文检索（移植自 legacy/backend/app/services/search.py + routers/search.py）
// 2026-09 搜索加固后的 auto 分段管线（单通道推进，不合并）：
//   段1 定位（hint 命中限定法规 / 无 hint 全库按号）→ 段2 全文兜底 → 段3（仅 auto）
//   非空 hint 零命中时按条号全库救援。
// 劫持修复：hint 非空但匹配不到任何法规时【不再】退化全库按号（旧 search.ts:81-84）——
//   那会让「年利率 24」这类关键词查询被噪音占满且永不执行全文。
// FTS 表只读（articles_fts / chunks_fts 的写入与重建归 library.ts / reindex.ts 管）；
// 依赖 ./db 的 getDb()（node:sqlite 单例连接）与 @shared 的 locate/tokenize/ftsQuery 纯函数

import { ipcMain } from 'electron'
import type { ArticleRow, DocType, SearchHit, SearchMode, SearchOutcome } from '../shared/types'
import { buildMatchString, buildPrecisionMatch } from '@shared/ftsQuery'
import { buildHighlightTerms, highlightText } from '@shared/highlight'
import { matchDocumentIds, parseLocateQuery } from '@shared/locate'
import { queryTokens, tokenize } from '@shared/tokenize'
import { getDb } from './db'

/** 定位结果上限（legacy search_locate limit=20；配合每法只取一条的窗口排序治截断） */
const LOCATE_LIMIT = 20
/** 全文检索每类结果上限：法条、段落各 50（legacy search_fulltext limit=50） */
const FULLTEXT_LIMIT = 50
/** 摘要窗口宽度（legacy make_snippet width=80） */
const SNIPPET_WIDTH = 80
/** 摘要窗口向前回看的字符数（窗口 [hit-20, hit+width]） */
const SNIPPET_BACK = 20

// ---------- 摘要（移植自 search.py 的 make_snippet；高亮走 @shared/highlight 全局统一） ----------

/**
 * 摘要：找最长词条的首次出现位置，截取窗口 [hit-20, hit+width]，
 * 越过首尾时补 …；无命中取前 width 字（超长补 …）。
 */
function makeSnippet(content: string, terms: string[], width = SNIPPET_WIDTH): string {
  if (!content) return ''
  let hit = -1
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    hit = content.indexOf(t)
    if (hit >= 0) break
  }
  if (hit < 0) {
    const snippet = content.slice(0, width)
    return highlightText(snippet, terms) + (content.length > width ? '…' : '')
  }
  const start = Math.max(0, hit - SNIPPET_BACK)
  const end = Math.min(content.length, hit + width)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + highlightText(content.slice(start, end), terms) + suffix
}

// ---------- 法条定位（2026-09 加固：作用域上报 + 每法一条窗口排序） ----------

/** 定位结果 + 作用域（auto 管线据此决定是否进入后续阶段） */
interface LocateOutcome {
  results: SearchHit[]
  /**
   * 'hint' = 按法规名限定命中；'whole-db' = 无提示在全部法规中按号找；
   * 'none' = 解析失败，或非空 hint 零匹配（【不】再降级全库——劫持修复）
   */
  scope: 'hint' | 'whole-db' | 'none'
}

function statutesList(): Array<{ id: number; title: string }> {
  return getDb()
    .prepare("SELECT id, title FROM documents WHERE doc_type='statute' ORDER BY id")
    .all() as unknown as Array<{ id: number; title: string }>
}

/**
 * 按 docIds + 条号取条文。
 * 每法只取 order_index 最靠前的一条（ROW_NUMBER 窗口）：无 hint 的全库查询里，
 * 旧 ORDER BY document_id LIMIT 20 会被第一部法的同号条灌满、目标法被静默截断。
 */
function locateByDocIds(
  docIds: number[],
  articleNo: number,
  limit = LOCATE_LIMIT
): SearchHit[] {
  if (docIds.length === 0) return []
  const db = getDb()
  const placeholders = docIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id, document_id, article_label, article_no, branch,
              chapter, section, content, order_index, title, category
       FROM (
         SELECT a.id, a.document_id, a.article_label, a.article_no, a.branch,
                a.chapter, a.section, a.content, a.order_index,
                d.title, d.category,
                ROW_NUMBER() OVER (
                  PARTITION BY a.document_id ORDER BY a.order_index
                ) AS rn
         FROM articles a JOIN documents d ON d.id = a.document_id
         WHERE a.document_id IN (${placeholders}) AND a.article_no = ?
       ) t
       WHERE rn = 1
       ORDER BY document_id
       LIMIT ?`
    )
    .all(...docIds, articleNo, limit) as unknown as Array<
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

/** 法条定位：解析查询 → 匹配法规（hint 空全返回 / hint 零匹配如实上报 none）→ 按条号取条 */
function searchLocate(query: string, limit = LOCATE_LIMIT): LocateOutcome {
  const parsed = parseLocateQuery(query)
  if (!parsed) return { results: [], scope: 'none' }
  const statutes = statutesList()
  if (statutes.length === 0) return { results: [], scope: 'none' }
  if (!parsed.hint) {
    // 无提示（「1077」「第1条」）→ 全部法规按号找
    return {
      results: locateByDocIds(statutes.map((d) => d.id), parsed.article_no, limit),
      scope: 'whole-db'
    }
  }
  const docIds = matchDocumentIds(statutes, parsed.hint)
  if (docIds.length === 0) {
    // 非空 hint 零匹配 → 不降级全库（旧行为是劫持源）；交由 auto 段3 决定是否救援
    return { results: [], scope: 'none' }
  }
  return { results: locateByDocIds(docIds, parsed.article_no, limit), scope: 'hint' }
}

// ---------- 全文检索（2026-09 加固：字面量化 MATCH + 末词前缀） ----------

/** 全文检索：两段式（精准块排前 + 模糊块补后），主进程侧做摘要高亮；返回法条与段落两类结果 */
function searchFulltext(q: string, limit = FULLTEXT_LIMIT): {
  results: SearchHit[]
  tokens: string[]
} {
  const tokens = queryTokens(q)
  if (tokens.length === 0) return { results: [], tokens }
  // 精准块：整句短语（索引侧同分词，含单字——「光污染」按 光+污染 相邻匹配，
  // 不会退化成任意「污染」）OR 全词交集；模糊块：任意词 OR + 末词前缀（打一半可搜）。
  // 块内按 bm25；合并 = 精准在前、模糊补后去重——「精准确定到相应法条」+ 召回兜底。
  const matchPrecision = buildPrecisionMatch(tokens, tokenize(q).split(' ').filter(Boolean))
  const matchLoose = buildMatchString(tokens, { prefixLast: true })
  // 高亮词条统一走 @shared/highlight（完整原查询/空白词段/分词——保证整词着色不被截短）
  const hlTerms = buildHighlightTerms(q)
  const db = getDb()
  const results: SearchHit[] = []

  interface ArticleFtsRow {
    id: number
    document_id: number
    article_label: string
    content: string
    title: string
    doc_type: DocType
    category: string
  }
  interface ChunkFtsRow {
    id: number
    document_id: number
    seq: number
    content: string
    title: string
    doc_type: DocType
    category: string
  }

  const queryArticles = (match: string, n: number): ArticleFtsRow[] =>
    db
      .prepare(
        `SELECT a.id, a.document_id, a.article_label, a.content,
                d.title, d.doc_type, d.category
         FROM articles_fts f
         JOIN articles a ON a.id = f.article_id
         JOIN documents d ON d.id = a.document_id
         WHERE articles_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(match, n) as unknown as ArticleFtsRow[]

  // 法条类：精准块满额，模糊块多取一截（余量）后去重补位，仍截到 limit
  const articleStrict = queryArticles(matchPrecision, limit)
  const seenArticle = new Set(articleStrict.map((r) => r.id))
  const articleLoose = queryArticles(matchLoose, limit * 2).filter((r) => !seenArticle.has(r.id))
  for (const r of [...articleStrict, ...articleLoose].slice(0, limit)) {
    results.push({
      kind: 'article',
      id: r.id,
      document_id: r.document_id,
      doc_type: r.doc_type,
      title: r.title,
      category: r.category,
      label: r.article_label,
      snippet: makeSnippet(r.content, hlTerms)
    })
  }

  // 段落类：chunks_fts JOIN chunks JOIN documents（案例等非法规文档），label 统一"第N段"
  const queryChunks = (match: string, n: number): ChunkFtsRow[] =>
    db
      .prepare(
        `SELECT c.id, c.document_id, c.seq, c.content,
                d.title, d.doc_type, d.category
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(match, n) as unknown as ChunkFtsRow[]

  const chunkStrict = queryChunks(matchPrecision, limit)
  const seenChunk = new Set(chunkStrict.map((r) => r.id))
  const chunkLoose = queryChunks(matchLoose, limit * 2).filter((r) => !seenChunk.has(r.id))
  for (const r of [...chunkStrict, ...chunkLoose].slice(0, limit)) {
    results.push({
      kind: 'chunk',
      id: r.id,
      document_id: r.document_id,
      doc_type: r.doc_type,
      title: r.title,
      category: r.category,
      label: `第${r.seq + 1}段`,
      snippet: makeSnippet(r.content, hlTerms)
    })
  }
  return { results, tokens }
}

// ---------- IPC 注册 ----------

export function registerSearchIpc(): void {
  // 统一检索入口：auto 分段管线（定位 → 全文兜底 → auto 全库救援）；
  // 显式 locate 免救援、显式 fulltext 纯全文；契约外 mode 按全文处理（legacy）
  ipcMain.handle('search:run', (_e, rawQ: unknown, mode: SearchMode): SearchOutcome => {
    const q = String(rawQ ?? '').trim()
    if (!q) return { mode: 'none', query: q, results: [] }

    const runFulltext = (): SearchOutcome => {
      const ft = searchFulltext(q)
      const out: SearchOutcome = { mode: 'fulltext', query: q, results: ft.results }
      if (ft.tokens.length === 0) out.emptyReason = 'no_tokens'
      return out
    }

    const parsed = parseLocateQuery(q)
    let m: 'locate' | 'fulltext'
    if (mode === 'auto') m = parsed ? 'locate' : 'fulltext'
    else if (mode === 'locate') m = 'locate'
    else m = 'fulltext'

    if (m === 'fulltext') return runFulltext()

    // 段1：定位
    const loc = searchLocate(q)
    if (loc.results.length > 0) return { mode: 'locate', query: q, results: loc.results }

    // 段2：全文兜底（locate 无结果自动降级，响应 mode 同步变化——legacy 行为）
    const ft = runFulltext()
    if (ft.results.length > 0) return { ...ft, fallback: true }

    // 段3（仅 auto）：非空 hint 连法规都没匹配上 → 按条号全库救援
    // （保住「民伐典 1077」式错字定位；「年利率 24」在段2已有全文结果，到不了这里）
    if (mode === 'auto' && parsed && loc.scope === 'none' && parsed.hint !== '') {
      const statutes = statutesList()
      const rescue = locateByDocIds(statutes.map((d) => d.id), parsed.article_no)
      if (rescue.length > 0) return { mode: 'locate', query: q, results: rescue, rescued: true }
    }

    return { ...ft, fallback: true }
  })
}
