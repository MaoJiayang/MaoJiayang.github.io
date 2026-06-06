@echo off
setlocal

echo ========================================
echo   SE Command Assistant - Local Dev
echo ========================================
echo.

:: Load .env
if exist "%~dp0.env" (
    echo [load] .env config
    for /f "usebackq eol=# tokens=1,2 delims==" %%a in ("%~dp0.env") do (
        if not "%%a"=="" set "%%a=%%b"
    )
) else (
    echo [info] .env not found, copy .env.example to .env for semantic search
)

:: Python - HTTP frontend
python --version >nul 2>&1
if errorlevel 1 (
    echo [warn] Python not found, HTTP server cannot start
    goto done
)

echo [start] HTTP frontend on :5500
start "SE-Frontend" cmd /k "cd /d %~dp0 && python -m http.server 5500"

:: Semantic search (optional)
set HAS_CF=
if defined CF_ACCOUNT_ID if defined CF_API_TOKEN set HAS_CF=1
if defined HAS_CF (
    echo [start] Semantic search on :5501
    start "SE-Search" cmd /k "cd /d %~dp0 && set CF_ACCOUNT_ID=%CF_ACCOUNT_ID% && set CF_API_TOKEN=%CF_API_TOKEN% && node search-server-local.js"
) else (
    echo [skip] Semantic search (CF_ACCOUNT_ID/CF_API_TOKEN not set)
)

:done
echo.
echo   Frontend : http://localhost:5500/commands.html
echo.
echo   Deploy to CF Pages for full functionality (search + command execution).
pause
