// 启动期 FTS 全量重建（settings.fts_version 门控）——2026-09 搜索加固
// 动机：①索引公式升级（标题/条标/条号/编章节并入 content），存量行必须按新公式重写；
//       ②旧库/legacy 数据包的 jieba 时代索引与当前 Intl.Segmenter 查询分词失配 → 系统性零命中。
// 模式照 seed.ts：成功才打标、失败不阻断启动、下次启动重试；数据包导入换库重启后
// settings 随库带入，版本不符自动触发。迁移仍是纯 SQL（migrate 不做 JS 重建）。

import { articleFtsText, chunkFtsText } from '@shared/ftsContent'
import { getDb, getSetting, setSetting } from './db'

/** 索引公式版本；公式变更时 +1，触发一次性全量重建 */
const FTS_VERSION = '3'

interface ArticleIndexRow {
  id: number
  article_label: string
  article_no: number
  branch: string
  subbranch: string
  chapter: string
  section: string
  content: string
  title: string
}

interface ChunkIndexRow {
  id: number
  content: string
  title: string
}

function tx(db: ReturnType<typeof getDb>, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已回滚/无事务 */
    }
    throw e
  }
}

export function reindexFtsIfNeeded(): void {
  if (getSetting('fts_version') === FTS_VERSION) return
  try {
    const db = getDb()
    let indexedArticles = 0
    let indexedChunks = 0
    // 清空 + 全量回填放进**同一个事务**：中途失败会整体回滚到旧索引，
    // 不会让本次会话带着「只建了一半」的索引继续跑（表现为部分法条搜不到）。
    tx(db, () => {
      db.exec('DELETE FROM articles_fts')
      db.exec('DELETE FROM chunks_fts')

      const articles = db
        .prepare(
          `SELECT a.id, a.article_label, a.article_no, a.branch, a.subbranch, a.chapter, a.section, a.content, d.title
           FROM articles a JOIN documents d ON d.id = a.document_id
           ORDER BY a.id`
        )
        .all() as unknown as ArticleIndexRow[]
      const insArticle = db.prepare('INSERT INTO articles_fts(article_id, content) VALUES(?,?)')
      for (const r of articles) {
        insArticle.run(
          r.id,
          articleFtsText({
            title: r.title,
            label: r.article_label,
            articleNo: r.article_no,
            branch: r.branch,
            subbranch: r.subbranch,
            chapter: r.chapter,
            section: r.section,
            content: r.content
          })
        )
      }

      const chunks = db
        .prepare(
          `SELECT c.id, c.content, d.title
           FROM chunks c JOIN documents d ON d.id = c.document_id
           ORDER BY c.id`
        )
        .all() as unknown as ChunkIndexRow[]
      const insChunk = db.prepare('INSERT INTO chunks_fts(chunk_id, content) VALUES(?,?)')
      for (const r of chunks) insChunk.run(r.id, chunkFtsText(r.title, r.content))

      setSetting('fts_version', FTS_VERSION)
      indexedArticles = articles.length
      indexedChunks = chunks.length
    })

    if (indexedArticles + indexedChunks > 0) {
      console.log(`全文索引已按新公式重建：${indexedArticles} 条法条 + ${indexedChunks} 段`)
    }
  } catch (e) {
    console.warn('[reindex] FTS 重建失败，下次启动重试：', e)
  }
}
