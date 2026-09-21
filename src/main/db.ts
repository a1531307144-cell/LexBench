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

const MIGRATION_004_READING = `-- 004_reading: 阅读模式 —— book_notes（划选批注，锚定段落与字符区间）
-- 阅读进度不建表：settings 表存 reading_progress:<docId> JSON（paraIndex + 更新时间）

CREATE TABLE IF NOT EXISTS book_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content_md  TEXT NOT NULL,                   -- 批注（想法）
    quote       TEXT NOT NULL DEFAULT '',        -- 划选的原文（引用）
    para_index  INTEGER NOT NULL DEFAULT -1,     -- 段落序号（= chunks.seq，渲染定位用）
    quote_start INTEGER NOT NULL DEFAULT 0,      -- 段内字符偏移（含）
    quote_end   INTEGER NOT NULL DEFAULT 0,      -- 段内字符偏移（不含）
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_book_notes_doc ON book_notes(document_id, para_index);
`

const MIGRATION_005_READING_V2 = `-- 005_reading_v2: 批注锚点升级为「起止锚点」，支持跨段划选
-- v0.4.0 未发布、book_notes 是新表，直接重建（单段三列 → 起止四列）

DROP TABLE IF EXISTS book_notes;

CREATE TABLE IF NOT EXISTS book_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content_md   TEXT NOT NULL,                  -- 批注（想法）
    quote        TEXT NOT NULL DEFAULT '',       -- 划选原文（跨段按 \\n 拼接，展示/导出用）
    start_para   INTEGER NOT NULL DEFAULT -1,    -- 起始段落（= chunks.seq）
    start_offset INTEGER NOT NULL DEFAULT 0,     -- 起段内字符偏移（含）
    end_para     INTEGER NOT NULL DEFAULT -1,    -- 结束段落（= chunks.seq）
    end_offset   INTEGER NOT NULL DEFAULT 0,     -- 止段内字符偏移（不含）
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_book_notes_doc ON book_notes(document_id, start_para);
`

const MIGRATION_006_FILE_EXT = `-- 006_file_ext: documents 记录原始扩展名（.pdf 的书籍走「页面阅读模式」，其余走文字模式）

ALTER TABLE documents ADD COLUMN file_ext TEXT NOT NULL DEFAULT '';
`

const MIGRATION_007_DOC_GROUPS = `-- 007_doc_groups: 用户自建分类文件夹（每个文档类型下可各自建组）
-- documents.category 保留为组名的冗余副本（导出/兼容用），group_id 为权威关联；
-- 现有 category 文本一次性转成分组并回填，老数据不丢。

CREATE TABLE IF NOT EXISTS doc_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_type   TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(doc_type, name)
);

ALTER TABLE documents ADD COLUMN group_id INTEGER REFERENCES doc_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_documents_group ON documents(group_id);

INSERT OR IGNORE INTO doc_groups(doc_type, name)
    SELECT DISTINCT doc_type, category FROM documents WHERE category <> '';
UPDATE documents SET group_id = (
    SELECT g.id FROM doc_groups g
    WHERE g.doc_type = documents.doc_type AND g.name = documents.category
) WHERE category <> '';
`

const MIGRATION_008_GROUP_ORDER = `-- 008_group_order: 分类文件夹支持拖动排序（sort_order 越小越靠前）

ALTER TABLE doc_groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE doc_groups SET sort_order = id;
`

const MIGRATION_009_AI_PROFILES = `-- 009_ai_profiles: 多个 AI 模型档案（接口地址 / 模型 / API Key），可切换
-- 密钥只存本机数据库（数据包迁移时会随包带走，属用户自己的凭据）；界面只显示掩码

CREATE TABLE IF NOT EXISTS ai_profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    base_url   TEXT NOT NULL DEFAULT '',
    api_key    TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    is_active  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`

const MIGRATION_010_AI_PROTOCOL = `-- 010_ai_protocol: 每个 AI 档案可选接口协议（openai = /chat/completions；anthropic = /v1/messages）

ALTER TABLE ai_profiles ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai';
`

// 011_ai_protocol_guess：把地址明显指向 Anthropic 入口的档案改判为 anthropic 协议。
// 在只有一种协议时，用户照样会把 …/api/anthropic 填进「接口地址」，结果被按 OpenAI 调用，
// 收到的是「200 + {"code":500,"msg":"404 NOT_FOUND"}」这种看不懂的报错。迁移里一次纠正，
// 用户升级后无需自己去点一下协议开关。
const MIGRATION_011_AI_PROTOCOL_GUESS = `-- 011_ai_protocol_guess

UPDATE ai_profiles SET protocol = 'anthropic'
  WHERE protocol = 'openai' AND lower(base_url) LIKE '%/anthropic%';
`

/** version 对应迁移文件名的数字前缀：user_version >= N 表示第 N 个迁移已执行 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: MIGRATION_001_INIT },
  { version: 2, sql: MIGRATION_002_RESEARCH },
  { version: 3, sql: MIGRATION_003_AI },
  { version: 4, sql: MIGRATION_004_READING },
  { version: 5, sql: MIGRATION_005_READING_V2 },
  { version: 6, sql: MIGRATION_006_FILE_EXT },
  { version: 7, sql: MIGRATION_007_DOC_GROUPS },
  { version: 8, sql: MIGRATION_008_GROUP_ORDER },
  { version: 9, sql: MIGRATION_009_AI_PROFILES },
  { version: 10, sql: MIGRATION_010_AI_PROTOCOL },
  { version: 11, sql: MIGRATION_011_AI_PROTOCOL_GUESS }
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

/** 关闭并清空单例连接（数据包导入替换数据库文件前调用；之后 getDb() 会重开新文件） */
export function closeDb(): void {
  if (db) {
    try {
      db.close()
    } catch {
      /* 连接已异常时放弃关闭 */
    }
    db = null
  }
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
