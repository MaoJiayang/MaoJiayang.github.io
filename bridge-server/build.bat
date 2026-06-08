@echo off
echo ========================================
echo   SE Bridge Server - 编译
echo ========================================
echo.

:: 查找 csc.exe
set CSC=

if exist "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
    set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
)

if exist "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
    set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
)

if "%CSC%"=="" (
    echo [错误] 未找到 csc.exe，请确认已安装 .NET Framework 4.0+
    pause
    exit /b 1
)

echo [编译] 使用 %CSC%
echo.

%CSC% /out:BridgeServer.exe /r:System.Web.Extensions.dll /target:exe BridgeServer.cs

if errorlevel 1 (
    echo.
    echo [失败] 编译出错，请检查错误信息
    pause
    exit /b 1
)

echo.
echo [成功] BridgeServer.exe 已生成
echo.
echo 运行方式:
echo   BridgeServer.exe --http-port 8080 --grpc-port 你的端口号
echo.
pause
