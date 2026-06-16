@echo off
setlocal enabledelayedexpansion
echo ========================================
echo   Build WebView2 webview.exe
echo ========================================

set VCVARS=
for %%d in (BuildTools Community Professional Enterprise) do (
  for %%e in ("Program Files (x86)" "Program Files") do (
    if exist "C:\%%~e\Microsoft Visual Studio\2022\%%d\VC\Auxiliary\Build\vcvarsall.bat" (
      set "VCVARS=C:\%%~e\Microsoft Visual Studio\2022\%%d\VC\Auxiliary\Build\vcvarsall.bat"
    )
  )
)

if "%VCVARS%"=="" (
  echo [ERROR] Visual Studio 2022 not found
  exit /b 1
)

echo   vcvars: %VCVARS%
call "%VCVARS%" x64 >nul 2>&1

if not exist "dist" mkdir dist

rem Find WebView2 SDK
set WV2_INC=
for /d %%p in (libs\Microsoft.Web.WebView2.*) do set "WV2_INC=%%p\build\native\include"
if "%WV2_INC%"=="" (
  echo [ERROR] WebView2 SDK not found. Run: nuget install Microsoft.Web.WebView2 -OutputDirectory libs
  exit /b 1
)

cl /EHsc /O2 /MT /std:c++17 /utf-8 /I webview\include /I "%WV2_INC%" ^
  webview\webview.cc webview\app.cc ^
  /link user32.lib ole32.lib shell32.lib comctl32.lib ^
  /SUBSYSTEM:WINDOWS ^
  /OUT:dist\webview.exe

if %ERRORLEVEL% equ 0 (
  echo   Build OK: dist\webview.exe
) else (
  echo   Build FAILED!
  exit /b 1
)
