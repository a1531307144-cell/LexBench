@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ============================================
echo   LexBench · 法研台
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
    .venv\Scripts\pip.exe install -r backend\requirements.txt --disable-pip-version-check -q
)

echo [LexBench] 启动服务：http://127.0.0.1:8788
echo [LexBench] 关闭本窗口即可退出

start "LexBenchBrowser" cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:8788"
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8788 --app-dir backend
pause
