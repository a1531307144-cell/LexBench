import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

DATA_DIR = Path(os.environ.get("LEXBENCH_DATA_DIR", REPO_ROOT / "data"))
DB_PATH = DATA_DIR / "lexbench.db"
FILES_DIR = DATA_DIR / "files"

HOST = os.environ.get("LEXBENCH_HOST", "127.0.0.1")
PORT = int(os.environ.get("LEXBENCH_PORT", "8788"))
