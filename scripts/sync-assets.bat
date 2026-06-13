@echo off
setlocal enabledelayedexpansion
echo ========================================
echo   Sync frontend to Android assets
echo ========================================
echo.

set SRC=%~dp0..
set DST=%~dp0..\android\app\src\main\assets\www

if not exist "%DST%" mkdir "%DST%"
if not exist "%DST%\js" mkdir "%DST%\js"
if not exist "%DST%\icons" mkdir "%DST%\icons"

REM 核心文件
copy /y "%SRC%\terminal.html"  "%DST%\" >nul 2>&1 && echo   terminal.html
copy /y "%SRC%\terminal.css"   "%DST%\" >nul 2>&1 && echo   terminal.css
copy /y "%SRC%\commands.html"  "%DST%\" >nul 2>&1 && echo   commands.html
copy /y "%SRC%\version-check.js"  "%DST%\" >nul 2>&1 && echo   version-check.js
copy /y "%SRC%\command-autocomplete.js"  "%DST%\" >nul 2>&1 && echo   command-autocomplete.js
copy /y "%SRC%\command-executor.js"  "%DST%\" >nul 2>&1 && echo   command-executor.js
copy /y "%SRC%\items_catalog.json"  "%DST%\" >nul 2>&1 && echo   items_catalog.json
copy /y "%SRC%\commands.json"  "%DST%\" >nul 2>&1 && echo   commands.json
copy /y "%SRC%\config.json"  "%DST%\" >nul 2>&1 && echo   config.json

REM JS
copy /y "%SRC%\js\se-bridge.js"  "%DST%\js\" >nul 2>&1 && echo   js/se-bridge.js
copy /y "%SRC%\js\ui.js"         "%DST%\js\" >nul 2>&1 && echo   js/ui.js
copy /y "%SRC%\js\warehouse.js"  "%DST%\js\" >nul 2>&1 && echo   js/warehouse.js
copy /y "%SRC%\js\trade.js"      "%DST%\js\" >nul 2>&1 && echo   js/trade.js
copy /y "%SRC%\js\hangar.js"     "%DST%\js\" >nul 2>&1 && echo   js/hangar.js
copy /y "%SRC%\js\shipyard.js"   "%DST%\js\" >nul 2>&1 && echo   js/shipyard.js
copy /y "%SRC%\js\settings.js"   "%DST%\js\" >nul 2>&1 && echo   js/settings.js

REM Icons
copy /y "%SRC%\icons\sprite.css"  "%DST%\icons\" >nul 2>&1 && echo   icons/sprite.css
copy /y "%SRC%\icons\sprite.webp" "%DST%\icons\" >nul 2>&1 && echo   icons/sprite.webp
copy /y "%SRC%\icons\mapping.json" "%DST%\icons\" >nul 2>&1 && echo   icons/mapping.json
copy /y "%SRC%\icons\tea.jpg"     "%DST%\icons\" >nul 2>&1 && echo   icons/tea.jpg

echo.
echo   Done. Assets synced to android/app/src/main/assets/www/
echo.
