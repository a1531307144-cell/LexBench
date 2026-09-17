# -*- mode: python ; coding: utf-8 -*-
"""LexBench 桌面版打包配置（PyInstaller，onedir 模式）。

构建入口见 scripts/build_desktop.ps1 —— 在不含用户名的中性路径下构建，
避免本机绝对路径（含用户名）被编译进二进制（隐私要求）。
"""
import importlib.util
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

SRC = Path(SPECPATH).resolve().parent  # spec 位于 <src>\scripts\，构建根为其上级

hiddenimports = collect_submodules("uvicorn")
datas = [
    (str(SRC / "frontend" / "dist"), "frontend_dist"),
    (str(SRC / "VERSION"), "."),
    # 数据库迁移 SQL：connection.py 运行时从 __file__ 旁读取，
    # 目标路径必须与 PYZ 内模块相对位置一致（app/db/migrations）
    (str(SRC / "backend" / "app" / "db" / "migrations"), "app/db/migrations"),
]
binaries = []

# pywebview 的 Windows 后端依赖 pythonnet / .NET 互操作，需完整收集
for pkg in ("webview", "pythonnet", "clr_loader"):
    pkg_datas, pkg_bins, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_bins
    hiddenimports += pkg_hidden

# starlette 的表单解析在运行时才导入 python-multipart，静态分析发现不了
hiddenimports += [m for m in ("multipart", "python_multipart") if importlib.util.find_spec(m)]

# jieba 分词词典是包内数据文件
datas += collect_data_files("jieba")

a = Analysis(
    [str(SRC / "desktop.py")],
    pathex=[str(SRC / "backend")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pip"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="LexBench",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=str(SRC / "scripts" / "lexbench.ico"),
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="LexBench",
)
