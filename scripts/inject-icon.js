/**
 * 给 portable EXE 外壳注入图标（解决文件管理器中的图标问题）
 * 先 PNG → ICO，再用 rcedit 注入
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pngToIco = require('png-to-ico').default;

const exe = path.join(__dirname, '..', 'dist-electron', '虚空终端.exe');
const pngPath = path.join(__dirname, '..', 'icons', 'favicon.png');
const icoPath = path.join(__dirname, '..', 'icons', 'favicon.ico');

async function main() {
  if (!fs.existsSync(exe)) {
    console.log('[icon] 未找到便携版 EXE，跳过');
    return;
  }

  // PNG → ICO
  const pngBuf = fs.readFileSync(pngPath);
  const icoBuf = await pngToIco(pngBuf);
  fs.writeFileSync(icoPath, icoBuf);
  console.log('[icon] favicon.ico 已生成');

  // rcedit 注入
  const rcedit = path.join(
    process.env.LOCALAPPDATA,
    'electron-builder', 'Cache', 'rcedit', '2.0.0', 'rcedit-x64.exe'
  );
  execSync(`"${rcedit}" "${exe}" --set-icon "${icoPath}"`, { stdio: 'inherit' });
  console.log('[icon] 便携版 EXE 图标注入成功');
}

main().catch(err => {
  console.error('[icon] 失败:', err.message);
  process.exit(1);
});
