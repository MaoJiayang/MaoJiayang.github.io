/**
 * set-icon.js — 将 icons/favicon.svg 转换为 ICO 并注入 EXE
 *
 * 用法: node scripts/set-icon.js dist/se-terminal.exe
 * 依赖: sharp (SVG→PNG), resedit (PE 资源编辑)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit');

const SVG_PATH = path.join(__dirname, '..', 'icons', 'favicon.svg');
const ICON_SIZE = 256;

async function main() {
  const exePath = process.argv[2];
  if (!exePath) {
    console.error('用法: node scripts/set-icon.js <exe路径>');
    process.exit(1);
  }

  // 1. SVG → PNG
  console.log('[icon] 转换 ' + SVG_PATH + ' → ' + ICON_SIZE + 'x' + ICON_SIZE + ' PNG');
  const pngBuf = await sharp(SVG_PATH).resize(ICON_SIZE, ICON_SIZE).png().toBuffer();

  // 2. 包装为 RawIconItem（PNG 格式图标）
  const rawIcon = Data.RawIconItem.from(pngBuf.buffer, ICON_SIZE, ICON_SIZE, 32, pngBuf.byteOffset, pngBuf.byteLength);
  // 256px 图标需指定 width/height 为 0（ICO 标准：0 = 256）
  rawIcon.width = 0;
  rawIcon.height = 0;

  // 3. 打开 EXE 并替换图标
  console.log('[icon] 注入 ' + exePath);
  const raw = fs.readFileSync(exePath);
  const exe = NtExecutable.from(raw.buffer, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  // 获取现有的图标资源组 ID（取主图标组，通常 ID 最小）
  const iconGroupEntries = Resource.IconGroupEntry.fromEntries(res.entries);
  const mainGroup = iconGroupEntries[0];
  const iconGroupID = mainGroup ? mainGroup.id : 1;

  // 替换图标
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconGroupID, 0, [rawIcon]);

  // 4. 写回
  res.outputResource(exe);
  const newBuf = Buffer.from(exe.generate());
  fs.writeFileSync(exePath, newBuf);
  console.log('[icon] 完成');
}

main().catch((err) => {
  console.error('[icon] 失败:', err.message);
  process.exit(1);
});
