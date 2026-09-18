-- 001_init: M1 基础表 —— documents / articles / chunks / settings + FTS5 索引表
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
