import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { join } from 'path'

/**
 * 数据库层：Electron 内置 node:sqlite（同步 API、单连接全局共享），
 * 语义对齐 legacy 的 sqlite3.connect(check_same_thread=False) + Row factory。
 * - initDb()：打开 userData/lexbench.db，按 PRAGMA user_version 顺序跑迁移
 * - getDb()：取连接（未初始化时自动初始化，调用方无需关心注册时序）
 * - getFilesDir()：userData/files 原件存储目录（自动创建）
 * - getSetting/setSetting：settings 表键值对（UPSERT）
 * 注意：node:sqlite 的 run() 返回 { changes, lastInsertRowid }，两者均可能为
 * bigint——调用方取 lastInsertRowid 时建议 Number() 收窄。
 */

// 以下三段迁移 SQL 与 legacy/backend/app/db/migrations/ 的 001~003 文件**逐字一致**（含注释），
// 不得改写：表结构必须与旧版完全相同，未来才能把旧 Python 版的 data/lexbench.db 直接迁过来。
const MIGRATION_001_INIT = `-- 001_init: M1 基础表 —— documents / articles / chunks / settings + FTS5 索引表
-- (M2 将新增 topics / topic_items / notes；M3 新增 ai_messages)

CREATE TABLE IF NOT EXISTS documents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    doc_type      TEXT NOT NULL DEFAULT 'other',   -- statute | case | other
    category      TEXT NOT NULL DEFAULT '',        -- 部门法分类，如"民法典"、"劳动法"
    file_hash     TEXT NOT NULL UNIQUE,
    original_path TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'parsed',  -- parsed | needs_review
    article_count INTEGER NOT NULL DEFAULT 0,
    imported_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    article_label TEXT NOT NULL,                   -- "第一千零七十七条"
    article_no   INTEGER NOT NULL,                 -- 1077
    branch       TEXT NOT NULL DEFAULT '',         -- 编
    chapter      TEXT NOT NULL DEFAULT '',         -- 章
    section      TEXT NOT NULL DEFAULT '',         -- 节
    content      TEXT NOT NULL,
    order_index  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_doc ON articles(document_id, order_index);
CREATE INDEX IF NOT EXISTS idx_articles_no  ON articles(article_no);

CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    content     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, seq);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 全文索引表：content 列存 jieba 切词后的文本（空格分隔），检索时查询词同样切词
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    article_id UNINDEXED,
    content
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    content
);
`

const MIGRATION_002_RESEARCH = `-- 002_research: M2 研究工作台 —— topics / topic_items / notes
-- 设计对应：专题收藏（多对多）、Markdown 笔记（可关联法条）

CREATE TABLE IF NOT EXISTS topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_name ON topics(name);

CREATE TABLE IF NOT EXISTS topic_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,                        -- 收藏顺序，专题浏览/导出按此排序
    added_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(topic_id, article_id)                         -- 同一专题内不重复收藏
);
CREATE INDEX IF NOT EXISTS idx_topic_items_topic ON topic_items(topic_id, order_index);

CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    article_id  INTEGER REFERENCES articles(id) ON DELETE SET NULL,  -- 可空；法条被删时笔记保留、仅解除关联
    content_md  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_article ON notes(article_id);
`

const MIGRATION_003_AI = `-- 003_ai: M3 AI 助手 —— ai_messages（按条文/专题分组保存对话历史）
-- 密钥不在此表：ai_base_url / ai_api_key / ai_model 存于 settings 表（本地 data/，不入库）

CREATE TABLE IF NOT EXISTS ai_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id  INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    topic_id    INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,                     -- explain | cases | followup
    question    TEXT NOT NULL DEFAULT '',
    answer_md   TEXT NOT NULL,
    citations   TEXT NOT NULL DEFAULT '[]',        -- JSON: [{article_id, title, label}]
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    CHECK (article_id IS NOT NULL OR topic_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_article ON ai_messages(article_id, id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_topic ON ai_messages(topic_id, id);
`

/** version 对应迁移文件名的数字前缀：user_version >= N 表示第 N 个迁移已执行 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: MIGRATION_001_INIT },
  { version: 2, sql: MIGRATION_002_RESEARCH },
  { version: 3, sql: MIGRATION_003_AI }
]

/** 全局唯一连接（单例） */
let db: DatabaseSync | null = null
/** getFilesDir() 的懒缓存路径 */
let filesDir: string | null = null

/**
 * 按 user_version 增量执行迁移（对齐 legacy connection.py 的 init_db 逻辑）。
 * 每个迁移包在事务里执行，schema 与 user_version 同进同退，避免半迁移状态。
 */
function migrate(conn: DatabaseSync): void {
  const row = conn.prepare('PRAGMA user_version').get() as
    | { user_version: number | bigint }
    | undefined
  const current = row ? Number(row.user_version) : 0
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    conn.exec('BEGIN')
    try {
      conn.exec(m.sql)
      conn.exec(`PRAGMA user_version = ${m.version}`)
      conn.exec('COMMIT')
    } catch (err) {
      conn.exec('ROLLBACK')
      throw err
    }
  }
}

/** 初始化数据库连接并跑迁移；幂等，重复调用直接返回 */
export function initDb(): void {
  if (db) return
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true }) // 父目录不存在时自动创建
  db = new DatabaseSync(join(userData, 'lexbench.db'))
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
}

/** 取全局数据库连接；尚未 initDb 时自动初始化（SQLite 是同步 API，直接返回连接） */
export function getDb(): DatabaseSync {
  if (!db) initDb()
  return db as DatabaseSync
}

/** 原件存储目录：userData/files（导入时把原始文件拷到这里），不存在则自动创建 */
export function getFilesDir(): string {
  if (!filesDir) {
    filesDir = join(app.getPath('userData'), 'files')
    mkdirSync(filesDir, { recursive: true })
  }
  return filesDir
}

/** 读 settings 表单个键值；未设置时返回 undefined */
export function getSetting(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value
}

/** 写 settings 表（UPSERT：存在则覆盖） */
export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}
