@echo off
echo ========================================
echo   SE Bridge Server - Build
echo ========================================
echo.

set CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe

if not exist "%CSC%" (
    echo [ERROR] csc.exe not found. Is .NET Framework 4.0+ installed?
    pause
    exit /b 1
)

echo [BUILD] Using %CSC%
echo.

%CSC% /out:BridgeServer.exe /r:System.Web.Extensions.dll /target:exe BridgeServer.cs

if errorlevel 1 (
    echo.
    echo [FAIL] Compilation error. Check the messages above.
    pause
    exit /b 1
)

echo.
echo [OK] BridgeServer.exe generated.
echo.
echo To run:
echo   BridgeServer.exe --http-port 10085 --grpc-port 10086
echo.
pause
