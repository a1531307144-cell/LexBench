// 研究工作台：专题 / 收藏 / 笔记 IPC（移植自 legacy/backend/app/routers/workspace.py）
// 原则：任何条目/笔记变动都 _touch 刷新 topics.updated_at（专题列表按「最近活跃」排序）；
//       错误一律 throw new Error('中文信息')，经 IPC reject 后由渲染层错误条直接展示；
//       依赖 ./db 的 initDb()/getDb()（node:sqlite 单例连接）；事务用 BEGIN/COMMIT exec 实现，
//       与 library.ts 同构但各自自包含（不共用对方私有函数）；
//       moveTopicItem 为新能力（旧版 UI 无重排）：与相邻条互换 order_index，到顶/底原样返回

import { ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { AddItemResult, ItemMoveDirection, TopicPatch } from '../shared/ipc'
import type { NoteRow, TopicDetail, TopicItemRow, TopicRow } from '../shared/types'
import { getDb, initDb } from './db'

// ---------- 行映射（node:sqlite 的整型可能以 bigint 到达，统一 Number() 收窄） ----------

/** node:sqlite 原始行：字段值一律 unknown，经 *Row 转换函数收窄成 shared 类型 */
type DbRow = Record<string, unknown>

/** 行 → TopicRow：topics 全列 + item_count/note_count 两个子查询计数 */
function toTopicRow(row: DbRow): TopicRow {
  return {
    id: Number(row['id']),
    name: String(row['name']),
    description: String(row['description'] ?? ''),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
    item_count: Number(row['item_count']),
    note_count: Number(row['note_count'])
  }
}

/** 行 → TopicItemRow：topic_items JOIN articles/documents 后的收藏条目 */
function toTopicItemRow(row: DbRow): TopicItemRow {
  return {
    id: Number(row['id']),
    topic_id: Number(row['topic_id']),
    article_id: Number(row['article_id']),
    order_index: Number(row['order_index']),
    added_at: String(row['added_at']),
    article_label: String(row['article_label']),
    title: String(row['title']),
    category: String(row['category']),
    content: String(row['content']),
    note_count: Number(row['note_count'] ?? 0)
  }
}

/** 行 → NoteRow：article_id / article_label 可空（专题级笔记无关联条文） */
function toNoteRow(row: DbRow): NoteRow {
  return {
    id: Number(row['id']),
    topic_id: Number(row['topic_id']),
    article_id: row['article_id'] == null ? null : Number(row['article_id']),
    content_md: String(row['content_md']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
    article_label: row['article_label'] == null ? null : String(row['article_label'])
  }
}

// ---------- 内部工具 ----------

/**
 * 事务包裹：BEGIN → fn → COMMIT，异常时 ROLLBACK。
 * node:sqlite 无 .transaction() helper；事务块内全部为同步 DB 调用，单线程主进程内不会被其它 handler 打断。
 */
function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 连接已异常时放弃回滚 */
    }
    throw e
  }
}

/** 任何条目/笔记变动后刷新专题 updated_at（对应 legacy _touch） */
function touchTopic(db: DatabaseSync, topicId: number): void {
  db.prepare("UPDATE topics SET updated_at=datetime('now','localtime') WHERE id=?").run(topicId)
}

/**
 * 把法条收藏进专题，返回新条目 id（调用方负责事务与外层的重复判定）。
 * 「显式收藏」与「写笔记时自动收进来」共用这一段，避免两处各写一遍顺序号逻辑。
 */
function insertTopicItem(db: DatabaseSync, topicId: number, articleId: number): number {
  // COALESCE(MAX,-1)+1：空专题从 0 起（与 legacy 逐字同义）
  const next = db
    .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order FROM topic_items WHERE topic_id=?')
    .get(topicId) as DbRow
  const info = db
    .prepare('INSERT INTO topic_items(topic_id, article_id, order_index) VALUES(?,?,?)')
    .run(topicId, articleId, Number(next['next_order']))
  touchTopic(db, topicId)
  return Number(info.lastInsertRowid)
}

/** 名称校验：trim 后为空抛错；返回 trim 后的名称 */
function requireTopicName(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name) throw new Error('专题名称不能为空')
  return name
}

/** 重名检测（idx_topics_name 唯一索引的前置显式检查）；excludeId 用于改名时排除自身 */
function topicNameTaken(db: DatabaseSync, name: string, excludeId?: number): boolean {
  const row =
    excludeId === undefined
      ? db.prepare('SELECT 1 FROM topics WHERE name=?').get(name)
      : db.prepare('SELECT 1 FROM topics WHERE name=? AND id<>?').get(name, excludeId)
  return row !== undefined
}

/** 专题存在性校验（对应 legacy _get_topic 的 404 语义） */
function requireTopic(db: DatabaseSync, topicId: number): void {
  const row = db.prepare('SELECT id FROM topics WHERE id=?').get(topicId)
  if (row === undefined) throw new Error('专题不存在')
}

/** 法条存在性校验 */
function requireArticle(db: DatabaseSync, articleId: number): void {
  const row = db.prepare('SELECT id FROM articles WHERE id=?').get(articleId)
  if (row === undefined) throw new Error('法条不存在')
}

/** TopicRow 查询主体：topics 全列 + item/note 两个子查询计数（列表与新建回读共用） */
const TOPIC_COUNTS_SQL =
  'SELECT t.*,' +
  ' (SELECT COUNT(*) FROM topic_items i WHERE i.topic_id = t.id) AS item_count,' +
  ' (SELECT COUNT(*) FROM notes n WHERE n.topic_id = t.id) AS note_count' +
  ' FROM topics t'

// ---------- IPC 注册 ----------

export function registerWorkspaceIpc(): void {
  // 启动建库/迁移（连接、迁移策略都在 ./db 内）
  initDb()

  // 专题列表：带两个子查询计数，最近活跃在前
  ipcMain.handle('workspace:listTopics', (): TopicRow[] => {
    const rows = getDb()
      .prepare(TOPIC_COUNTS_SQL + ' ORDER BY t.updated_at DESC, t.id DESC')
      .all() as unknown as DbRow[]
    return rows.map(toTopicRow)
  })

  // 新建专题：空名/重名在写入前显式校验（先查后插，单线程同步无竞态）
  ipcMain.handle('workspace:createTopic', (_e, name: string, description?: string): TopicRow => {
    const db = getDb()
    const trimmed = requireTopicName(name)
    const desc = String(description ?? '').trim() // legacy 同步 trim description
    if (topicNameTaken(db, trimmed)) throw new Error('已存在同名专题')
    const info = db.prepare('INSERT INTO topics(name, description) VALUES(?,?)').run(trimmed, desc)
    // 回读完整 TopicRow（新专题计数必为 0，但统一走同一条带计数的 SQL 保证形状一致）
    const row = db.prepare(TOPIC_COUNTS_SQL + ' WHERE t.id=?').get(Number(info.lastInsertRowid)) as DbRow
    return toTopicRow(row)
  })

  // 编辑专题（名称/描述字段级更新，None 跳过；改名查重排除自身）；无论改没改都 _touch（legacy 语义）
  ipcMain.handle('workspace:updateTopic', (_e, id: number, patch: TopicPatch): void => {
    const db = getDb()
    requireTopic(db, id)
    const p = (patch ?? {}) as TopicPatch
    if (p.name !== undefined) {
      const name = requireTopicName(p.name)
      if (topicNameTaken(db, name, id)) throw new Error('已存在同名专题')
      db.prepare('UPDATE topics SET name=? WHERE id=?').run(name, id)
    }
    if (p.description !== undefined) {
      db.prepare('UPDATE topics SET description=? WHERE id=?').run(String(p.description ?? '').trim(), id)
    }
    touchTopic(db, id)
  })

  // 删除专题：FK 级联删 topic_items / notes（PRAGMA foreign_keys=ON 已在 initDb 开启）
  ipcMain.handle('workspace:deleteTopic', (_e, id: number): void => {
    const info = getDb().prepare('DELETE FROM topics WHERE id=?').run(id)
    if (Number(info.changes) === 0) throw new Error('专题不存在')
  })

  // 专题详情：收藏条目（JOIN 法条/文档，按 order_index）+ 笔记（LEFT JOIN 法条标签，最近更新在前）
  ipcMain.handle('workspace:getTopic', (_e, id: number): TopicDetail => {
    const db = getDb()
    const topic = db.prepare('SELECT id, name, description FROM topics WHERE id=?').get(id) as
      | DbRow
      | undefined
    if (!topic) throw new Error('专题不存在')
    const items = db
      .prepare(
        'SELECT ti.id, ti.topic_id, ti.article_id, ti.order_index, ti.added_at,' +
          ' a.article_label, a.content, d.title, d.category,' +
          ' (SELECT COUNT(*) FROM notes n WHERE n.topic_id=ti.topic_id AND n.article_id=ti.article_id)' +
          ' AS note_count' +
          ' FROM topic_items ti JOIN articles a ON a.id = ti.article_id' +
          ' JOIN documents d ON d.id = a.document_id' +
          ' WHERE ti.topic_id=? ORDER BY ti.order_index'
      )
      .all(id) as unknown as DbRow[]
    const notes = db
      .prepare(
        'SELECT n.id, n.topic_id, n.article_id, n.content_md, n.created_at, n.updated_at,' +
          ' a.article_label FROM notes n LEFT JOIN articles a ON a.id = n.article_id' +
          ' WHERE n.topic_id=? ORDER BY n.updated_at DESC, n.id DESC'
      )
      .all(id) as unknown as DbRow[]
    return {
      id: Number(topic['id']),
      name: String(topic['name']),
      description: String(topic['description'] ?? ''),
      items: items.map(toTopicItemRow),
      notes: notes.map(toNoteRow)
    }
  })

  // 收藏法条进专题：重复收藏幂等返回 duplicate（不 touch）；新条目排到末尾并 touch
  ipcMain.handle('workspace:addTopicItem', (_e, topicId: number, articleId: number): AddItemResult => {
    const db = getDb()
    requireTopic(db, topicId)
    requireArticle(db, articleId)
    const existing = db
      .prepare('SELECT id FROM topic_items WHERE topic_id=? AND article_id=?')
      .get(topicId, articleId) as DbRow | undefined
    if (existing) return { status: 'duplicate', itemId: Number(existing['id']) }
    return withTransaction(db, (): AddItemResult => ({
      status: 'added',
      itemId: insertTopicItem(db, topicId, articleId)
    }))
  })

  // 移出收藏：按 (topic_id, article_id) 定位，删后 touch
  ipcMain.handle('workspace:removeTopicItem', (_e, topicId: number, articleId: number): void => {
    const db = getDb()
    requireTopic(db, topicId)
    const info = db
      .prepare('DELETE FROM topic_items WHERE topic_id=? AND article_id=?')
      .run(topicId, articleId)
    if (Number(info.changes) === 0) throw new Error('该法条不在此专题中')
    touchTopic(db, topicId)
  })

  // 收藏条目上移/下移：事务内与相邻条互换 order_index；order_index 无唯一约束，直接两次 UPDATE 即可；
  // 已到顶/底时原样返回（未发生任何变更，不 touch，避免无操作把专题顶到列表最前）
  ipcMain.handle(
    'workspace:moveTopicItem',
    (_e, topicId: number, articleId: number, direction: ItemMoveDirection): void => {
      if (direction !== 'up' && direction !== 'down') throw new Error('direction 仅支持 up / down')
      const db = getDb()
      withTransaction(db, () => {
        const current = db
          .prepare('SELECT id, order_index FROM topic_items WHERE topic_id=? AND article_id=?')
          .get(topicId, articleId) as DbRow | undefined
        if (!current) throw new Error('该法条不在此专题中')
        const cur = Number(current['order_index'])
        // up 取上一条（order_index 比本条小的最大者），down 取下一条（比本条大的最小者）
        const neighbor = (
          direction === 'up'
            ? db
                .prepare(
                  'SELECT id, order_index FROM topic_items WHERE topic_id=? AND order_index<?' +
                    ' ORDER BY order_index DESC LIMIT 1'
                )
                .get(topicId, cur)
            : db
                .prepare(
                  'SELECT id, order_index FROM topic_items WHERE topic_id=? AND order_index>?' +
                    ' ORDER BY order_index ASC LIMIT 1'
                )
                .get(topicId, cur)
        ) as DbRow | undefined
        if (!neighbor) return // 已到顶/底
        db.prepare('UPDATE topic_items SET order_index=? WHERE id=?').run(cur, Number(neighbor['id']))
        db.prepare('UPDATE topic_items SET order_index=? WHERE id=?').run(
          Number(neighbor['order_index']),
          Number(current['id'])
        )
        touchTopic(db, topicId)
      })
    }
  )

  // 新建笔记：必须挂专题；article_id 可空（专题级笔记），给了就必须真实存在；内容 trim 后为空拒绝；
  // 返回完整 NoteRow（含 LEFT JOIN 的 article_label——legacy 只回裸行，新 UI 卡片需要条文标签，此处按新契约补齐）
  ipcMain.handle(
    'workspace:createNote',
    (_e, topicId: number, articleId: number | null, contentMd: string): NoteRow => {
      const db = getDb()
      requireTopic(db, topicId)
      const aid = articleId == null ? null : Number(articleId)
      if (aid !== null) requireArticle(db, aid)
      const content = String(contentMd ?? '').trim()
      if (!content) throw new Error('笔记内容为空')
      // 笔记挂在哪条法条上，那条法条就必须在专题里——否则笔记会悬在一条列表里并不
      // 存在的法条上（专题显示「0 条 · 1 记」，导出时掉到文末），历史上就是这么坏的。
      // 这里在同一事务内补齐，界面不可能再出现这种孤儿笔记。
      const noteId = withTransaction(db, () => {
        if (aid !== null) {
          const inTopic = db
            .prepare('SELECT 1 FROM topic_items WHERE topic_id=? AND article_id=?')
            .get(topicId, aid)
          if (!inTopic) insertTopicItem(db, topicId, aid)
        }
        const info = db
          .prepare('INSERT INTO notes(topic_id, article_id, content_md) VALUES(?,?,?)')
          .run(topicId, aid, content)
        touchTopic(db, topicId)
        return Number(info.lastInsertRowid)
      })
      const row = db
        .prepare(
          'SELECT n.id, n.topic_id, n.article_id, n.content_md, n.created_at, n.updated_at,' +
            ' a.article_label FROM notes n LEFT JOIN articles a ON a.id = n.article_id WHERE n.id=?'
        )
        .get(noteId) as DbRow
      return toNoteRow(row)
    }
  )

  // 编辑笔记：先查存在性（对应 legacy 404 先于 422），只改 content_md + updated_at；touch 所在专题
  ipcMain.handle('workspace:updateNote', (_e, noteId: number, contentMd: string): void => {
    const db = getDb()
    const note = db.prepare('SELECT topic_id FROM notes WHERE id=?').get(noteId) as
      | DbRow
      | undefined
    if (!note) throw new Error('笔记不存在')
    const content = String(contentMd ?? '').trim()
    if (!content) throw new Error('笔记内容为空')
    db.prepare("UPDATE notes SET content_md=?, updated_at=datetime('now','localtime') WHERE id=?").run(
      content,
      noteId
    )
    touchTopic(db, Number(note['topic_id']))
  })

  // 删除笔记：删后 touch 所在专题
  ipcMain.handle('workspace:deleteNote', (_e, noteId: number): void => {
    const db = getDb()
    const note = db.prepare('SELECT topic_id FROM notes WHERE id=?').get(noteId) as
      | DbRow
      | undefined
    if (!note) throw new Error('笔记不存在')
    db.prepare('DELETE FROM notes WHERE id=?').run(noteId)
    touchTopic(db, Number(note['topic_id']))
  })
}
