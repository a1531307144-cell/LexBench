import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def connect(db_path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def _pending_migrations(version: int):
    for sql_file in sorted(MIGRATIONS_DIR.glob("*.sql")):
        file_version = int(sql_file.name.split("_", 1)[0])
        if file_version > version:
            yield file_version, sql_file


def init_db(db_path) -> None:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = connect(db_path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        for file_version, sql_file in _pending_migrations(version):
            conn.executescript(sql_file.read_text(encoding="utf-8"))
            conn.execute(f"PRAGMA user_version = {file_version}")
            conn.commit()
    finally:
        conn.close()
