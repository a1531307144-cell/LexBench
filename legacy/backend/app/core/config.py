import os
import sys
from pathlib import Path

# PyInstaller 打包后 sys.frozen 为 True（桌面版 exe 运行时）
FROZEN = bool(getattr(sys, "frozen", False))

if FROZEN:
    # exe 所在目录 = 应用根目录，用户数据（data/）存旁边（便携式）
    APP_DIR = Path(sys.executable).resolve().parent
    # PyInstaller 解包资源目录（frontend_dist、VERSION 在这里）
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
    REPO_ROOT = APP_DIR
    FRONTEND_DIST = BUNDLE_DIR / "frontend_dist"
    VERSION_FILE = BUNDLE_DIR / "VERSION"
else:
    REPO_ROOT = Path(__file__).resolve().parents[3]
    APP_DIR = REPO_ROOT
    BUNDLE_DIR = REPO_ROOT
    FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
    VERSION_FILE = REPO_ROOT / "VERSION"

VERSION = VERSION_FILE.read_text(encoding="utf-8").strip() if VERSION_FILE.exists() else "0.0.0"

DATA_DIR = Path(os.environ.get("LEXBENCH_DATA_DIR", str(APP_DIR / "data")))
DB_PATH = DATA_DIR / "lexbench.db"
FILES_DIR = DATA_DIR / "files"

HOST = os.environ.get("LEXBENCH_HOST", "127.0.0.1")
PORT = int(os.environ.get("LEXBENCH_PORT", "8788"))
