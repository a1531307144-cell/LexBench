@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ============================================
echo   LexBench · 法研台（桌面窗口版）
echo ============================================

rem ---- 选择 Python ----
set PYCMD=
where py >nul 2>nul
if %errorlevel%==0 (
    set PYCMD=py -3
) else (
    where python >nul 2>nul
    if %errorlevel%==0 set PYCMD=python
)
if "%PYCMD%"=="" (
    echo [LexBench] 未找到 Python，请先安装 Python 3.10 或更高版本：https://www.python.org/downloads/
    pause
    exit /b 1
)

rem ---- 首次运行：建虚拟环境 + 装依赖 ----
if not exist .venv\Scripts\python.exe (
    echo [LexBench] 首次运行：创建虚拟环境...
    %PYCMD% -m venv .venv
    if errorlevel 1 (
        echo [LexBench] 创建虚拟环境失败
        pause
        exit /b 1
    )
    echo [LexBench] 安装依赖（约 1-2 分钟，仅首次）...
    .venv\Scripts\pip.exe install -r backend\requirements.txt -r backend\requirements-desktop.txt --disable-pip-version-check -q
)

rem ---- 确保窗口组件已安装（升级/重建环境后补装） ----
.venv\Scripts\python.exe -c "import webview" >nul 2>nul
if errorlevel 1 (
    echo [LexBench] 补装窗口组件（仅一次）...
    .venv\Scripts\pip.exe install -r backend\requirements-desktop.txt --disable-pip-version-check -q
)

echo [LexBench] 正在打开软件窗口...
echo [LexBench] 数据保存在 data\ 目录；关闭本窗口即退出（日志见 desktop.log）

.venv\Scripts\python.exe desktop.py
if errorlevel 1 pause
