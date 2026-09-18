# LexBench desktop build script (one-click)
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build_desktop.ps1
# Output: dist\LexBench-<version>-windows-x64.zip (extract and run LexBench.exe)
#
# Privacy: builds under a username-free neutral path (C:\Users\Public\LexBenchBuild)
# so that no machine-local paths (C:\Users\<name>\...) get compiled into the binaries.
# NOTE: keep this file ASCII-only; PowerShell 5.1 misreads BOM-less UTF-8 as ANSI.
param(
    [string]$Version = ""
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
if (-not $Version) { $Version = (Get-Content "$repo\VERSION" -Raw).Trim() }

$build = "C:\Users\Public\LexBenchBuild"
$src = Join-Path $build "src"

Write-Host "== [1/6] Build frontend (npm run build) =="
Push-Location "$repo\frontend"
npm run build
if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
Pop-Location

Write-Host "== [2/6] Prepare neutral build directory =="
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Path $src -Force | Out-Null
robocopy $repo $src /E /NFL /NDL /NJH /NJS `
    /XD "$repo\.git" "$repo\.venv" "$repo\data" "$repo\dist" "$repo\build" "$repo\frontend\node_modules" "$repo\.pytest_cache" "$repo\.github" "$repo\docs" __pycache__ .pytest_cache node_modules .trae `
    /XF *.pyc | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

Write-Host "== [3/6] Create clean venv under neutral path and install deps =="
& "$repo\.venv\Scripts\python.exe" -m venv "$build\venv"
if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
$buildPip = "$build\venv\Scripts\pip.exe"
& $buildPip install -r "$src\backend\requirements.txt" -r "$src\backend\requirements-desktop.txt" --disable-pip-version-check -q
if ($LASTEXITCODE -ne 0) { throw "dependency install failed" }

Write-Host "== [4/6] PyInstaller packaging =="
& "$build\venv\Scripts\pyinstaller.exe" --noconfirm --clean `
    --distpath "$build\dist" --workpath "$build\build" `
    "$src\scripts\lexbench-desktop.spec"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

Write-Host "== [5/6] Binary privacy check =="
& "$build\venv\Scripts\python.exe" "$repo\scripts\check_binary_privacy.py" "$build\dist\LexBench" "$repo"
if ($LASTEXITCODE -ne 0) { throw "binary privacy check FAILED: build artifacts embed local machine info" }

Write-Host "== [6/6] Pack zip =="
$appDir = "$build\dist\LexBench"
if (Test-Path "$appDir\data") { Remove-Item -Recurse -Force "$appDir\data" }
Copy-Item "$repo\LICENSE" $appDir
$guide = [System.IO.File]::ReadAllText("$repo\scripts\START-HERE-template.txt", [System.Text.Encoding]::UTF8)
$guide = $guide.Replace("__VERSION__", $Version)
[System.IO.File]::WriteAllText("$appDir\START-HERE.txt", $guide, (New-Object System.Text.UTF8Encoding($true)))

$outDir = "$repo\dist"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$zip = "$outDir\LexBench-$Version-windows-x64.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $appDir -DestinationPath $zip
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "BUILD OK: $zip ($size MB)"
