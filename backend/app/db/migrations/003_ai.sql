-- 003_ai: M3 AI 助手 —— ai_messages（按条文/专题分组保存对话历史）
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
