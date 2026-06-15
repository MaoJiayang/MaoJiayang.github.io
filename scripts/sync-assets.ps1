$SRC = Split-Path -Parent $PSScriptRoot
$DST = Join-Path $SRC "android\app\src\main\assets\www"

New-Item -ItemType Directory -Force -Path "$DST\js", "$DST\icons" | Out-Null

Write-Host "========================================"
Write-Host "  Sync frontend to Android assets"
Write-Host "========================================"
Write-Host ""

# 从唯一真相源 frontend-files.json 读取文件列表
$manifestPath = Join-Path $SRC "frontend-files.json"
$files = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$ok = 0
foreach ($f in $files) {
    $srcPath = Join-Path $SRC $f
    $dstPath = Join-Path $DST $f
    $dstDir = Split-Path -Parent $dstPath
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    if (Test-Path $srcPath) {
        Copy-Item $srcPath $dstPath -Force
        Write-Host "  $f"
        $ok++
    } else {
        Write-Host "  [MISSING] $f" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  Done. $ok files synced to android/app/src/main/assets/www/"
