import sqlite3

from app.db.connection import init_db


def test_init_creates_schema_and_sets_version(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)
    conn = sqlite3.connect(db)
    tables = {
        r[0]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"documents", "articles", "chunks", "settings"} <= tables
    assert {"topics", "topic_items", "notes"} <= tables
    assert "ai_messages" in tables
    assert "articles_fts" in tables
    assert "chunks_fts" in tables
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 3
    conn.close()


def test_init_is_idempotent(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)
    init_db(db)  # 重复初始化不报错、不重复执行
    conn = sqlite3.connect(db)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 3
    rows = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    assert rows == 0
    conn.close()


def test_m1_database_upgrades_to_v2_without_data_loss(tmp_path):
    """U7：M1 旧库（user_version=1）逐级升级到最新版，已有数据完好。"""
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
            doc_type TEXT NOT NULL DEFAULT 'other', category TEXT NOT NULL DEFAULT '',
            file_hash TEXT NOT NULL UNIQUE, original_path TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'parsed', article_count INTEGER NOT NULL DEFAULT 0,
            imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            article_label TEXT NOT NULL, article_no INTEGER NOT NULL,
            branch TEXT NOT NULL DEFAULT '', chapter TEXT NOT NULL DEFAULT '',
            section TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
            order_index INTEGER NOT NULL
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
        """
    )
    conn.execute(
        "INSERT INTO documents(title, file_hash) VALUES('旧文档', 'h1')"
    )
    conn.execute(
        "INSERT INTO articles(document_id, article_label, article_no, content, order_index)"
        " VALUES(1, '第一条', 1, '旧内容', 0)"
    )
    conn.execute("INSERT INTO settings(key, value) VALUES('k', 'v')")
    conn.commit()
    conn.close()

    init_db(db)  # 应用 002 迁移

    conn = sqlite3.connect(db)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 3
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
    assert conn.execute("SELECT content FROM articles").fetchone()[0] == "旧内容"
    assert conn.execute("SELECT value FROM settings WHERE key='k'").fetchone()[0] == "v"
    tables = {
        r[0]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"topics", "topic_items", "notes", "ai_messages"} <= tables
    conn.close()


def test_init_creates_parent_directory(tmp_path):
    db = tmp_path / "nested" / "dir" / "test.db"
    init_db(db)
    assert db.exists()
