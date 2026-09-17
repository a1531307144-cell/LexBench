import importlib
import socket
import sys

import pytest

from app.core import config
from app.desktop import (
    acquire_single_instance,
    pick_port,
    port_is_free,
    running_from_unextracted_zip,
)


def _occupy(port: int) -> socket.socket:
    s = socket.socket()
    s.bind(("127.0.0.1", port))
    s.listen(1)
    return s


def test_pick_port_skips_occupied_port():
    s = _occupy(18788)
    try:
        assert not port_is_free(18788)
        assert pick_port(18788, attempts=5) == 18789
    finally:
        s.close()


def test_pick_port_returns_none_when_all_busy():
    s = _occupy(18801)
    try:
        assert pick_port(18801, attempts=1) is None
    finally:
        s.close()


def test_pick_port_returns_start_when_free():
    assert pick_port(18802, attempts=5) == 18802


@pytest.mark.skipif(sys.platform != "win32", reason="Windows 命名互斥体")
def test_single_instance_lock_second_call_fails():
    assert acquire_single_instance() is True
    assert acquire_single_instance() is False


def test_zip_preview_detection():
    import tempfile
    from pathlib import Path

    temp_dir = Path(tempfile.gettempdir())
    # zip 工具的临时解压特征目录 → 拦截
    for tool_dir in ("Rar$EXa0.123", "Temp1_LexBench.zip", "7zO4567", "BANDIZIPTEMP"):
        assert running_from_unextracted_zip(temp_dir / tool_dir / "LexBench") is True
    # 用户主动解压到 Temp 普通文件夹 / 正常位置 → 放行
    assert running_from_unextracted_zip(temp_dir / "LexBench") is False
    assert running_from_unextracted_zip(Path("D:/Apps/LexBench")) is False


def test_frozen_config_points_to_exe_dir(tmp_path, monkeypatch):
    """打包后：数据落在 exe 旁的 data/，前端产物取自解包目录。"""
    exe_dir = tmp_path / "LexBench"
    bundle = tmp_path / "bundle"
    exe_dir.mkdir()
    bundle.mkdir()
    (bundle / "VERSION").write_text("9.9.9", encoding="utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe_dir / "LexBench.exe"))
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle), raising=False)
    try:
        cfg = importlib.reload(config)
        assert cfg.FROZEN is True
        assert cfg.APP_DIR == exe_dir
        assert cfg.DATA_DIR == exe_dir / "data"
        assert cfg.DB_PATH == exe_dir / "data" / "lexbench.db"
        assert cfg.FRONTEND_DIST == bundle / "frontend_dist"
        assert cfg.VERSION == "9.9.9"
    finally:
        monkeypatch.undo()
        importlib.reload(config)
    assert config.FROZEN is False
    assert config.VERSION == "0.2.0"
