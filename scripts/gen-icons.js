/**
 * 从 favicon.svg 生成 favicon.png + favicon.ico（electron-builder 用）
 */
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'icons', 'favicon.svg');
const pngPath = path.join(__dirname, '..', 'icons', 'favicon.png');
const icoPath = path.join(__dirname, '..', 'icons', 'favicon.ico');

async function main() {
  // SVG → PNG (256x256)
  const pngBuf = await sharp(svgPath).resize(256, 256).png().toBuffer();
  fs.writeFileSync(pngPath, pngBuf);
  console.log('[icon] favicon.png 已生成');

  // PNG → ICO
  const icoBuf = await pngToIco(pngBuf);
  fs.writeFileSync(icoPath, icoBuf);
  console.log('[icon] favicon.ico 已生成');
}

main().catch(err => {
  console.error('[icon] 生成失败:', err.message);
  process.exit(1);
});
