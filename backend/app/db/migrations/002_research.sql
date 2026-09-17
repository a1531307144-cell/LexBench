-- 002_research: M2 研究工作台 —— topics / topic_items / notes
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
