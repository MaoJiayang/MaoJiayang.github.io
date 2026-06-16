/**
 * embed-webview.js — 将 dist\webview.exe base64 编码注入 server.js
 *
 * 用法: node scripts/embed-webview.js
 *
 * 在 server.js 中查找 /@@WEBVIEW_BIN@@/ 标记并替换为 base64 字符串。
 * 标记不存在时自动追加到文件末尾。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.join(__dirname, '..');
const SERVER_JS = path.join(PROJECT_DIR, 'server.js');
const WEBVIEW_EXE = path.join(PROJECT_DIR, 'dist', 'webview.exe');
const MARKER = 'const WEBVIEW_BIN = \'\';';  // 占位标记

function main() {
  if (!fs.existsSync(WEBVIEW_EXE)) {
    console.error('错误: 找不到 ' + WEBVIEW_EXE + '，请先运行 build-webview.bat');
    process.exit(1);
  }

  const bin = fs.readFileSync(WEBVIEW_EXE);
  const b64 = bin.toString('base64');
  const sizeKB = (bin.length / 1024).toFixed(0);
  console.log('[embed] webview.exe: ' + sizeKB + 'KB → base64: ' + (b64.length / 1024).toFixed(0) + 'KB');

  let serverJs = fs.readFileSync(SERVER_JS, 'utf-8');

  if (serverJs.includes(MARKER)) {
    // 替换占位标记
    serverJs = serverJs.replace(MARKER, "const WEBVIEW_BIN = '" + b64 + "';");
    console.log('[embed] 已替换占位标记');
  } else {
    // 替换已有的 WEBVIEW_BIN（非空值，重新构建时更新）
    var re = /const WEBVIEW_BIN = '[^']*';/;
    if (re.test(serverJs)) {
      serverJs = serverJs.replace(re, "const WEBVIEW_BIN = '" + b64 + "';");
      console.log('[embed] 已更新现有 WEBVIEW_BIN');
    } else {
      console.error('[embed] 找不到占位标记或现有 WEBVIEW_BIN，请手动添加 const WEBVIEW_BIN = \'\';');
      process.exit(1);
    }
  }

  fs.writeFileSync(SERVER_JS, serverJs, 'utf-8');
  console.log('[embed] 完成');
}

main();
