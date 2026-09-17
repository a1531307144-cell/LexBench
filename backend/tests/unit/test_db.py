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
    assert "articles_fts" in tables
    assert "chunks_fts" in tables
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
    conn.close()


def test_init_is_idempotent(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)
    init_db(db)  # 重复初始化不报错、不重复执行
    conn = sqlite3.connect(db)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
    rows = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    assert rows == 0
    conn.close()


def test_init_creates_parent_directory(tmp_path):
    db = tmp_path / "nested" / "dir" / "test.db"
    init_db(db)
    assert db.exists()
