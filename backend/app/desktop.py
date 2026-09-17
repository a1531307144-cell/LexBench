"""桌面窗口模式：后台线程起本地服务 + pywebview 原生窗口。

源码预览：仓库根目录 `python desktop.py`；
打包入口：scripts/build_desktop.ps1（PyInstaller，入口即根目录 desktop.py）。

诊断日志写入 exe 旁的 desktop.log（用户报"打不开"时可索取）。
"""
import ctypes
import os
import socket
import tempfile
import threading
import time
import traceback
import urllib.request
from pathlib import Path

from app.core import config

_MUTEX_NAME = "LexBenchSingleInstance"
_ERROR_ALREADY_EXISTS = 183
_WEBVIEW2_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

_LOG = None


def log(msg: str) -> None:
    global _LOG
    if _LOG is None:
        try:
            _LOG = open(config.APP_DIR / "desktop.log", "a", encoding="utf-8")
        except OSError:
            _LOG = None
            return
    _LOG.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    _LOG.flush()


def acquire_single_instance() -> bool:
    """Windows 命名互斥体保证单实例：避免两个进程同时写同一个数据库。"""
    if os.name != "nt":
        return True
    ctypes.windll.kernel32.CreateMutexW(None, False, _MUTEX_NAME)
    return ctypes.windll.kernel32.GetLastError() != _ERROR_ALREADY_EXISTS


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def pick_port(start: int, attempts: int = 20) -> int | None:
    for port in range(start, start + attempts):
        if port_is_free(port):
            return port
    return None


def running_from_unextracted_zip(app_dir) -> bool:
    """未解压、直接在压缩包里双击 exe 时，zip 工具会解压到 Temp 下的特征目录
    运行（数据随临时目录消失）。只拦截这些工具特征目录——用户自己解压到
    Temp 下的普通文件夹属于合法用法，不拦。"""
    if os.name != "nt":
        return False
    app_path = Path(app_dir).resolve()
    temp = Path(tempfile.gettempdir()).resolve()
    try:
        rel = app_path.relative_to(temp)
    except ValueError:
        return False
    first = rel.parts[0] if rel.parts else ""
    return first.startswith(("Rar$", "Temp1_", "Temp2_", "7zO", "7zS", "BANDIZIPTEMP"))


def alert(message: str, title: str = "LexBench · 法研台", question: bool = False) -> bool:
    """原生消息框。question=True 时返回用户是否点了“是”。"""
    log(f"alert: {message[:80]}")
    if os.name != "nt":
        print(message)
        return False
    flags = 0x40 | (0x04 if question else 0x00)  # 图标信息 | 是否按钮
    return ctypes.windll.user32.MessageBoxW(None, message, title, flags) == 6


def wait_until_up(url: str, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status == 200:
                    return True
        except OSError:
            time.sleep(0.2)
    return False


def attach_error_logging(application) -> None:
    """把 FastAPI 未处理异常的堆栈写进 desktop.log（GUI 程序无控制台可看）。"""
    from fastapi import Request
    from fastapi.responses import JSONResponse

    @application.exception_handler(Exception)
    async def _log_exception(request: Request, exc: Exception):
        log(f"请求 {request.url.path} 处理异常:\n"
            + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
        return JSONResponse(status_code=500, content={"detail": "internal server error"})


def run() -> int:
    log(f"=== LexBench v{config.VERSION} 启动（frozen={config.FROZEN}，"
        f"app_dir={config.APP_DIR}） ===")
    if not acquire_single_instance():
        log("另一实例持有互斥体，退出")
        alert("LexBench 已在运行。\n\n请查看已打开的窗口（或检查任务栏）。")
        return 1

    if running_from_unextracted_zip(config.APP_DIR):
        alert("请先把压缩包解压到任意文件夹，再运行里面的 LexBench.exe。\n\n"
              "直接在压缩包里双击运行的话，你的文档和笔记会在关闭后丢失。")
        return 1

    port = pick_port(config.PORT)
    if port is None:
        log(f"端口 {config.PORT}~{config.PORT + 19} 全被占用")
        alert(f"本地端口 {config.PORT} 起连续 20 个均被占用，无法启动。\n\n"
              "请关闭占用端口的程序后重试。")
        return 1
    log(f"选定端口 {port}")

    log("导入服务组件...")
    import uvicorn
    from app.main import create_app

    application = create_app()
    attach_error_logging(application)
    log("create_app 完成")
    server = uvicorn.Server(uvicorn.Config(
        application, host=config.HOST, port=port,
        log_config=None, access_log=False, log_level="warning",
    ))

    def _serve():
        try:
            server.run()
        except Exception:
            log("uvicorn 线程异常:\n" + traceback.format_exc())

    threading.Thread(target=_serve, daemon=True).start()

    if not wait_until_up(f"http://{config.HOST}:{port}/api/documents"):
        server.should_exit = True
        log("服务健康检查超时（20s），放弃启动")
        alert("本地服务启动失败，请重新运行 LexBench；若反复失败请提 Issue 反馈。")
        return 1
    log("服务就绪")

    try:
        import webview
    except ImportError:
        server.should_exit = True
        log("pywebview 导入失败")
        alert("窗口组件缺失，安装包可能不完整，请重新下载。")
        return 1

    webview.create_window(
        f"LexBench · 法研台 v{config.VERSION}",
        f"http://{config.HOST}:{port}",
        width=1440, height=920, min_size=(1024, 640),
    )
    try:
        log("打开窗口")
        webview.start()
        log("窗口关闭，退出")
    except Exception:
        log("窗口创建失败:\n" + traceback.format_exc())
        if alert("窗口创建失败，通常是系统缺少 WebView2 运行时。\n\n"
                 "是否打开微软官方下载页面？（装好后重新运行 LexBench 即可）",
                 question=True):
            import webbrowser
            webbrowser.open(_WEBVIEW2_URL)
    finally:
        server.should_exit = True
        try:
            application.state.conn.close()
        except Exception:
            pass
    return 0
