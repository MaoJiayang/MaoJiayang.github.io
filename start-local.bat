@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   SE Command Assistant - Local Dev
echo ========================================
echo.

:: Load .env
if exist "%~dp0.env" (
    echo [load] .env config
    for /f "tokens=1,* delims==" %%a in ('type "%~dp0.env" 2^>nul ^| findstr /r /v "^[  ]*$" ^| findstr /r /v "^#"') do (
        echo   set %%a=%%b
        set "%%a=%%b"
    )
) else (
    echo [info] .env not found
)

:: Python HTTP frontend
python --version >nul 2>&1
if errorlevel 1 (
    echo [warn] Python not found, trying py launcher...
    py --version >nul 2>&1
    if errorlevel 1 (
        echo [error] Python not available
        goto done
    )
    set PYTHON=py
) else (
    set PYTHON=python
)

echo [start] HTTP frontend :5500
start "SE-Frontend" cmd /k "cd /d %~dp0 && !PYTHON! -m http.server 5500"

:: Semantic search (optional)
if defined CF_ACCOUNT_ID (
    if defined CF_API_TOKEN (
        echo [start] Semantic search :5501
        start "SE-Search" cmd /k "cd /d %~dp0 && node search-server-local.js"
    ) else (
        echo [skip] Semantic search - CF_API_TOKEN not set
    )
) else (
    echo [skip] Semantic search - CF_ACCOUNT_ID not set
)

:: Local bridge (optional)
if defined SE_HOST (
    if defined SE_PORT (
        echo [start] Local bridge :3001
        start "SE-Bridge" cmd /k "cd /d %~dp0 && node local-bridge.js 3001"
    ) else (
        echo [skip] Local bridge - SE_PORT not set
    )
) else (
    echo [skip] Local bridge - SE_HOST not set
)

:done
echo.
echo   Frontend : http://localhost:5500/commands.html
echo   Terminal : http://localhost:5500/terminal.html
echo.
echo   Local debug: auto-detects localhost, health-race picks bridge.
echo   To change bridge port: ?bridge-port=3002 in URL or edit .env.
echo.
