$SRC = Split-Path -Parent $PSScriptRoot
$DST = Join-Path $SRC "android\app\src\main\assets\www"

New-Item -ItemType Directory -Force -Path "$DST\js", "$DST\icons" | Out-Null

Write-Host "========================================"
Write-Host "  Sync frontend to Android assets"
Write-Host "========================================"
Write-Host ""

$files = @(
    "terminal.html", "terminal.css", "commands.html",
    "version-check.js", "command-autocomplete.js", "command-executor.js",
    "items_catalog.json", "commands.json", "config.json",
    "js\se-bridge.js", "js\ui.js", "js\warehouse.js",
    "js\trade.js", "js\hangar.js", "js\shipyard.js", "js\settings.js",
    "icons\sprite.css", "icons\sprite.webp", "icons\mapping.json", "icons\tea.jpg"
)

$ok = 0
foreach ($f in $files) {
    $srcPath = Join-Path $SRC $f
    $dstPath = Join-Path $DST $f
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
