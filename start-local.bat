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

:: Node.js check
node --version >nul 2>&1
if errorlevel 1 (
    echo [error] Node.js not found - install from https://nodejs.org
    goto done
)

:: Unified server (frontend + bridge + auth proxy)
echo [start] Unified server :24007
start "SE-Server" cmd /k "cd /d %~dp0 && node server.js 24007"

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

:done
echo.
echo   Terminal : http://localhost:24007/terminal.html
echo   Commands : http://localhost:24007/commands.html
echo.
echo   server.js handles frontend + TCP bridge + auth proxy in one process.
echo   Change port: node server.js PORT   or   set PORT=XXXX in .env
echo.
