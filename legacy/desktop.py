"""LexBench 桌面版启动入口（源码预览与 PyInstaller 打包共用）。"""
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))


def main() -> int:
    from app.desktop import run
    return run()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        # GUI 程序无控制台，未捕获异常必须落日志文件，否则用户报障无从排查
        from app.desktop import log
        log("未捕获异常:\n" + traceback.format_exc())
        raise
