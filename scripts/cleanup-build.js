/**
 * electron-builder afterPack 钩子：删除非中文 locales，节省 ~46MB
 */
exports.default = async function (context) {
  const fs = require('fs');
  const path = require('path');

  // 打包输出目录
  const localesDir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return;

  const keep = ['zh-CN.pak', 'en-US.pak'];
  const files = fs.readdirSync(localesDir);
  let removed = 0;
  for (const f of files) {
    if (!keep.includes(f)) {
      fs.unlinkSync(path.join(localesDir, f));
      removed++;
    }
  }
  console.log(`[cleanup] 已删除 ${removed} 个非中文 locale，保留 ${keep.join(', ')}`);
};
