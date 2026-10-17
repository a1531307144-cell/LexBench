// 启动期修复：把旧切分吞进法条正文的「分编」标题行还原为层级戳记（settings.subbranch_repaired 门控）
//
// 背景：迁移 014 只加列（纯 SQL）；但升级前导入的法规里，「第X分编」标题行被旧版
// 切分当成续段 append 进了**上一条法条正文的最后一行**（全库实测：污染行全部在文末），
// 且该层戳记从未落库。这里按 splitter 的状态机语义回放一次：
//   - 第 i 条正文里剥出的分编行 → 第 i+1 条起 subbranch = 该标题（直到下一个分编）；
//   - 无分编行但编变了 → 清空 subbranch（新编无分编层级）；
//   - 其余沿用上一条的值。
// 成功才打标、失败不阻断启动、下次启动重试（模式同 seed.ts / reindex.ts）。
// 注意：本函数必须在 reindexFtsIfNeeded() **之前**调用——修复改动了 content，
// 若本次同时触发 FTS 重建，顺序反了会把脏内容写进索引。

import { getDb, getSetting, setSetting } from './db'

/** 分编标题行（与 splitter.SUBBRANCH_RE 同语义：第X分编 + 紧跟非空白标题） */
const SUB_LINE = /^第[零〇一二三四五六七八九十百千\d]+分编\s*\S/

interface RepairRow {
  id: number
  branch: string
  subbranch: string
  content: string
}

interface DocRow {
  id: number
}

export function repairSubbranchIfNeeded(): void {
  if (getSetting('subbranch_repaired') === '1') return
  try {
    const db = getDb()
    const docs = db
      .prepare("SELECT id FROM documents WHERE doc_type='statute' ORDER BY id")
      .all() as unknown as DocRow[]
    const selArticle = db.prepare(
      'SELECT id, branch, subbranch, content FROM articles WHERE document_id=? ORDER BY order_index'
    )
    const upd = db.prepare('UPDATE articles SET subbranch=?, content=? WHERE id=?')
    let changed = 0

    db.exec('BEGIN')
    try {
      for (const d of docs) {
        const rows = selArticle.all(d.id) as unknown as RepairRow[]
        // 上一条回放态：戳记值 / 正文里剥出的分编标题（供下一条用）
        let prevBranch: string | null = null
        let prevSub = ''
        let prevExtract: string | null = null
        for (const r of rows) {
          // 本条的 subbranch 戳记（由它之前发生的标题行决定）
          let sub = ''
          if (prevBranch !== null) {
            if (prevExtract !== null) sub = prevExtract
            else if (r.branch !== prevBranch) sub = ''
            else sub = prevSub
          }
          // 剥掉正文里的分编标题行（可能有多行，取最后一行 = 下一条生效的层级）
          let lastExtract: string | null = null
          let stripped = false
          const kept = r.content.split('\n').filter((line) => {
            if (SUB_LINE.test(line)) {
              lastExtract = line.trim()
              stripped = true
              return false
            }
            return true
          })
          const content = stripped ? kept.join('\n') : r.content
          if (sub !== r.subbranch || content !== r.content) {
            upd.run(sub, content, r.id)
            changed++
          }
          prevBranch = r.branch
          prevSub = sub
          prevExtract = lastExtract
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 已回滚/无事务 */
      }
      throw e
    }

    setSetting('subbranch_repaired', '1')
    if (changed > 0) {
      // 正文/戳记变了 → 同轮 reindex 必须重建（reindex 在本函数之后执行，见文件头注释）
      setSetting('fts_version', '0')
      console.log(`分编层级已修复：${changed} 条法条（正文剥标题 + 补戳记），本轮将重建全文索引`)
    }
  } catch (e) {
    console.warn('[repairSubbranch] 修复失败，下次启动重试：', e)
  }
}
