/**
 * server.js — 伊卡洛斯虚空终端 统一本地服务器
 *
 * 合并前端静态服务 + TCP 桥接 + 认证代理，一个进程同时服务 dev 和 EXE 两种场景。
 *
 * Dev 模式: 当前目录有 terminal.html → 直接服务项目文件（改代码立刻生效）
 * EXE 模式: 当前目录无 terminal.html → 从 CF Pages 同步前端到缓存目录
 *
 * 用法:
 *   node server.js [端口]
 *   SE_HOST=... SE_PORT=... SE_AUTH_KEY=... node server.js
 *   CF_PAGES_DOMAIN=atomickitty17th.pages.dev node server.js
 */

'use strict';

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

var PORT = parseInt(process.argv[2], 10) || parseInt(process.env.PORT, 10) || 24007;
var PORT_MAX = PORT + 10;  // 端口被占用时自动递增尝试的上限

const SE_HOST = process.env.SE_HOST || '183.131.51.12';
const SE_PORT = parseInt(process.env.SE_PORT, 10) || 10086;
const SE_AUTH_KEY = process.env.SE_AUTH_KEY || '12345';
const CF_DOMAIN = process.env.CF_PAGES_DOMAIN || 'atomickitty17th.pages.dev';
const CF_ORIGIN = 'https://' + CF_DOMAIN;
const TIMEOUT = 15000;

// SEA 兼容：打包后 __dirname 不可靠，统一用 process.cwd()（Dev 下用户始终从项目根启动）
const APP_DIR = process.cwd();

// ========== 模式检测 ==========

const IS_DEV = (function () {
  try { fs.accessSync(path.join(APP_DIR, 'terminal.html')); return true; } catch (_) { return false; }
})();

const CACHE_DIR = IS_DEV ? APP_DIR : path.join(
  process.env.LOCALAPPDATA || process.env.USERPROFILE || APP_DIR,
  'SE-Terminal', 'www'
);

console.log('[server] 模式: ' + (IS_DEV ? 'Dev（本地文件）' : 'EXE（缓存: ' + CACHE_DIR + '）'));

// ========== 前端文件列表（用于 EXE 模式同步） ==========

const FRONTEND_FILES = [
  'terminal.html',
  'terminal.css',
  'commands.html',
  'version.json',
  'version-check.js',
  'items_catalog.json',
  'commands.json',
  'config.json',
  'command-autocomplete.js',
  'command-executor.js',
  'js/se-bridge.js',
  'js/ui.js',
  'js/warehouse.js',
  'js/trade.js',
  'js/hangar.js',
  'js/shipyard.js',
  'js/settings.js',
  'icons/sprite.css',
  'icons/sprite.webp',
  'icons/mapping.json',
  'icons/tea.jpg',
];

// ========== TCP 帧协议 ==========

function buildFrame(json) {
  const data = Buffer.from(json, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

function readFrame(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('读取超时')); }, timeoutMs);
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const length = buf.readInt32BE(0);
        const total = 4 + length;
        if (buf.length >= total) {
          cleanup();
          resolve(buf.slice(4, total).toString('utf-8'));
        }
      }
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('连接关闭')); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

// ---- PUA 字符清洗（与 CF Worker cleanPUA 行为一致）----
function cleanPUA(obj) {
  if (typeof obj === 'string') return obj.replace(/[-]/g, '');
  if (Array.isArray(obj)) return obj.map(cleanPUA);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = cleanPUA(v);
    return out;
  }
  return obj;
}

function tcpRequest(host, port, authKey, steamId, command, password, customPath) {
  return new Promise((resolve) => {
    const innerBody = JSON.stringify({
      steamId,
      command,
      gamePassword: password,
      forcePlayerOnline: false,
      dontSendToGameScreen: true,
    });

    const requestJson = JSON.stringify({
      path: customPath || '/command',
      bodyJson: innerBody,
      authKey,
    });

    const socket = new net.Socket();
    socket.setTimeout(TIMEOUT);

    socket.connect(port, host, () => {
      socket.write(buildFrame(requestJson));

      readFrame(socket, TIMEOUT)
        .then((json) => {
          try {
            const raw = JSON.parse(json);
            const cleaned = cleanPUA(raw);
            if (cleaned.code !== undefined) { resolve(cleaned); return; }
            if (cleaned.success === true) {
              let body = cleaned.bodyJson || '';
              try { const p = JSON.parse(body); body = typeof p === 'string' ? p : JSON.stringify(p); } catch (_) {}
              resolve({ code: 200, msg: body, data: null });
              return;
            }
            if (cleaned.success === false) {
              resolve({ code: 400, msg: cleaned.errorMessage || '未知错误', data: null });
              return;
            }
            resolve({ code: 500, msg: '无法解析响应', data: null });
          } catch (_) {
            resolve({ code: 500, msg: 'SE服务器响应异常', data: null });
          }
        })
        .catch((err) => {
          resolve({ code: 500, msg: 'TCP 读取失败: ' + err.message, data: null });
        })
        .finally(() => socket.destroy());
    });

    socket.on('error', (err) => {
      resolve({ code: 500, msg: 'TCP 连接失败: ' + err.message, data: null });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ code: 500, msg: 'TCP 连接超时', data: null });
    });
  });
}

// ========== 前端同步（EXE 模式） ==========

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 从远端读取 version.json 的 v 字段 */
async function fetchRemoteVersion() {
  try {
    const res = await fetch(CF_ORIGIN + '/version.json');
    if (!res.ok) return null;
    const data = await res.json();
    return data.v || null;
  } catch (_) { return null; }
}

/** 从缓存读取 version.json 的 v 字段 */
function cachedVersion() {
  try {
    const p = path.join(CACHE_DIR, 'version.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return data.v || null;
  } catch (_) { return null; }
}

/** 下载单个文件到缓存 */
async function downloadFile(file) {
  const cachePath = path.join(CACHE_DIR, file);
  const url = CF_ORIGIN + '/' + file;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  ensureDir(path.dirname(cachePath));
  var ext = path.extname(file).toLowerCase();
  var isBinary = ['.webp', '.jpg', '.jpeg', '.png', '.ico', '.woff2'].indexOf(ext) !== -1;
  if (isBinary) {
    var buf = await res.arrayBuffer();
    fs.writeFileSync(cachePath, Buffer.from(buf));
  } else {
    var text = await res.text();
    fs.writeFileSync(cachePath, text, 'utf-8');
  }
}

async function syncFrontend(forceUpdate) {
  ensureDir(CACHE_DIR);

  var force = forceUpdate || process.argv.includes('--update');
  console.log('[sync] ' + (force ? '强制更新，' : '') + '来源: ' + CF_ORIGIN);

  // 1. 先查远端版本号
  var remoteV = null;
  if (!force) {
    remoteV = await fetchRemoteVersion();
    var localV = cachedVersion();
    if (remoteV && localV && remoteV === localV) {
      console.log('[sync] 已是最新 (v=' + remoteV.slice(0, 7) + ')，跳过同步');
      return;
    }
    if (remoteV) {
      console.log('[sync] ' + (localV ? '版本更新: ' + localV.slice(0, 7) + ' → ' + remoteV.slice(0, 7) : '首次安装，全量同步'));
    }
  }

  // 2. 下载全部文件
  var updated = 0, errors = 0;
  for (var i = 0; i < FRONTEND_FILES.length; i++) {
    var file = FRONTEND_FILES[i];
    try {
      await downloadFile(file);
      updated++;
      console.log('[sync]   ' + (updated < 10 ? ' ' : '') + updated + '/' + FRONTEND_FILES.length + ' ' + file);
    } catch (e) {
      // 有缓存就沿用，否则报错
      if (fs.existsSync(path.join(CACHE_DIR, file))) {
        console.log('[sync]   ~ ' + file + ' (沿用缓存)');
      } else {
        console.warn('[sync]   ✗ ' + file + ' - ' + e.message);
        errors++;
      }
    }
  }

  console.log('[sync] 完成: ' + updated + ' 下载, ' + errors + ' 失败');
}

// ========== HTTP 路由 ==========

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(res, code, body) {
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (_) { resolve(null); }
    });
  });
}

/** 去掉 CF Pages 注入的 Web Analytics 脚本（localhost 下会报 CORS） */
function stripAnalytics(html) {
  return html.replace(/<!-- Cloudflare Pages Analytics -->[\s\S]*?<!-- Cloudflare Pages Analytics -->/g, '')
             .replace(/<script[^>]*cloudflareinsights\.com[^>]*><\/script>/gi, '');
}
async function proxyToCF(path, bodyObj) {
  const url = CF_ORIGIN + path;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  const data = await resp.json();
  return { status: resp.status, body: data };
}

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const apiPath = url.pathname;
  const t0 = Date.now();

  // ---- API 路由 ----

  // 健康检查
  if (apiPath === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    jsonResponse(res, 200, { code: 200, msg: 'server ok' });
    return;
  }

  // 指令验证 → 代理到 CF（D1 封禁检查 + SE 密码验证）
  if (apiPath === '/api/command/verify' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.steamId || !body.gamePassword) {
      jsonResponse(res, 400, { code: 400, msg: '缺少必要参数' });
      return;
    }
    console.log('[proxy:verify] steamId=' + body.steamId);
    try {
      const result = await proxyToCF('/api/command/verify', body);
      const ms = Date.now() - t0;
      console.log('[proxy:verify] status=' + result.status + ' code=' + (result.body.code || '?') + ' (' + ms + 'ms)');
      jsonResponse(res, result.status, result.body);
    } catch (e) {
      console.error('[proxy:verify] 失败: ' + e.message);
      jsonResponse(res, 502, { code: 502, msg: '认证服务不可达' });
    }
    return;
  }

  // 用户同步 → 代理到 CF（D1 写入）
  if (apiPath === '/api/user/sync' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.steamId || !body.gamePassword) {
      jsonResponse(res, 400, { code: 400, msg: '缺少 steamId 或 gamePassword' });
      return;
    }
    console.log('[proxy:sync] steamId=' + body.steamId);
    try {
      const result = await proxyToCF('/api/user/sync', body);
      const ms = Date.now() - t0;
      console.log('[proxy:sync] status=' + result.status + ' (' + ms + 'ms)');
      jsonResponse(res, result.status, result.body);
    } catch (e) {
      console.error('[proxy:sync] 失败: ' + e.message);
      jsonResponse(res, 502, { code: 502, msg: '认证服务不可达' });
    }
    return;
  }

  // 指令执行 → 本地 TCP 直连 SE
  if (apiPath === '/api/command/execute' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.steamId || !body.command || !body.gamePassword) {
      jsonResponse(res, 400, { code: 400, msg: '缺少必要参数' });
      return;
    }
    console.log('[execute] steamId=' + body.steamId + ' cmd="' + body.command + '"');
    const result = await tcpRequest(SE_HOST, SE_PORT, SE_AUTH_KEY, body.steamId, body.command, body.gamePassword);
    const ms = Date.now() - t0;
    const dataPreview = typeof result.data === 'object' ? JSON.stringify(result.data).substring(0, 200) : String(result.data || 'null').substring(0, 200);
    console.log('[execute] code=' + result.code + ' data=' + dataPreview + ' (' + ms + 'ms)');
    jsonResponse(res, 200, result);
    return;
  }

  // 世界网格 → 本地 TCP 直连 SE
  if (apiPath === '/api/grid/world-grids' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.steamId || !body.gamePassword) {
      jsonResponse(res, 400, { code: 400, msg: '缺少 steamId 或 gamePassword' });
      return;
    }
    console.log('[world-grids] steamId=' + body.steamId);
    const result = await tcpRequest(SE_HOST, SE_PORT, SE_AUTH_KEY, body.steamId, '', body.gamePassword, '/getWorldGridsBySteamId');
    const ms = Date.now() - t0;
    console.log('[world-grids] code=' + result.code + ' (' + ms + 'ms)');
    // 与 CF Worker 一致：GridVO[] 可能在 msg 字段中
    if (result.code === 200 && !result.data && result.msg) {
      try { const p = JSON.parse(result.msg); if (Array.isArray(p)) result.data = p; } catch (_) {}
    }
    jsonResponse(res, 200, result);
    return;
  }

  // ---- 静态文件 ----

  if (req.method === 'GET' || req.method === 'HEAD') {
    let filePath = apiPath === '/' ? '/terminal.html' : apiPath;
    // 安全：防止目录遍历
    filePath = path.normalize(filePath).replace(/^[/\\]+/, '').replace(/\.\.[/\\]/g, '');
    if (!filePath) filePath = 'terminal.html';

    const fullPath = path.join(IS_DEV ? APP_DIR : CACHE_DIR, filePath);
    // 确保解析后的路径在服务根目录内
    const serveRoot = path.resolve(IS_DEV ? APP_DIR : CACHE_DIR);
    if (path.resolve(fullPath).indexOf(serveRoot) !== 0) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    if (!fs.existsSync(fullPath)) {
      // SPA fallback: /terminal 或 /commands → .html
      if (!ext) {
        const htmlPath = fullPath + '.html';
        if (fs.existsSync(htmlPath)) {
          const content = stripAnalytics(fs.readFileSync(htmlPath, 'utf-8'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(content);
          return;
        }
      }
      res.writeHead(404, CORS);
      res.end('Not Found');
      return;
    }

    var content = fs.readFileSync(fullPath);
    // HTML 文件：去掉 CF Analytics 脚本，避免 localhost 下 CORS 报错
    if (ext === '.html') content = stripAnalytics(fs.readFileSync(fullPath, 'utf-8'));
    const headers = { 'Content-Type': mime };
    if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json') {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(content);
    return;
  }

  res.writeHead(404, CORS);
  res.end('Not Found');
});

// ========== 启动 ==========

/** 检查已占用端口上是否跑着我们的服务，是则复用，打开浏览器直接退出 */
async function reuseIfOurs(port) {
  try {
    var resp = await fetch('http://localhost:' + port + '/api/health');
    var data = await resp.json();
    if (data && data.code === 200) {
      console.log('  端口 ' + port + ' 已有运行中的终端，直接复用。');
      return true;
    }
  } catch (_) {}
  return false;
}

function tryListen(port) {
  return new Promise(function (resolve, reject) {
    server.once('error', function (err) {
      if (err.code === 'EADDRINUSE') reject(err);
      else {
        console.error('  服务器错误: ' + err.message);
        reject(err);
      }
    });
    server.listen(port, function () {
      resolve(port);
    });
  });
}

function openBrowser(port) {
  var targetUrl = 'http://localhost:' + port + '/terminal.html';
  if (process.platform === 'win32') {
    exec('start ' + targetUrl, function (err) {
      if (err) console.log('  请手动打开: ' + targetUrl);
    });
  } else if (process.platform === 'darwin') {
    exec('open "' + targetUrl + '"', function (err) {
      if (err) console.log('  请手动打开: ' + targetUrl);
    });
  } else {
    exec('xdg-open "' + targetUrl + '"', function (err) {
      if (err) console.log('  请手动打开: ' + targetUrl);
    });
  }
}

async function start() {
  if (!IS_DEV) {
    await syncFrontend(process.argv.includes('--update'));
  }

  // 尝试启动，端口被占用时先检查是否可复用，否则自动递增
  var started = false;
  for (var p = PORT; p <= PORT_MAX; p++) {
    try {
      var actualPort = await tryListen(p);
      started = true;
      console.log('═'.repeat(50));
      console.log('  伊卡洛斯虚空终端 — ' + (IS_DEV ? '开发模式' : '桌面版'));
      console.log('═'.repeat(50));
      console.log('');
      console.log('  ★ 运行时请勿关闭此窗口 ★');
      console.log('');
      console.log('  监听端口 : ' + actualPort);
      if (actualPort !== PORT) console.log('  （原端口 ' + PORT + ' 已被占用，自动切换）');
      console.log('  认证代理 : ' + CF_ORIGIN + '/api/*');
      console.log('  SE 服务器 : ' + SE_HOST + ':' + SE_PORT);
      console.log('  服务目录 : ' + (IS_DEV ? APP_DIR : CACHE_DIR));
      console.log('');
      console.log('  按 Ctrl+C 退出');
      console.log('═'.repeat(50));

      openBrowser(actualPort);
      break;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        // 端口被占用 → 检查是否是自己的旧实例，是则复用
        if (await reuseIfOurs(p)) {
          openBrowser(p);
          process.exit(0);
          return;
        }
        console.log('  端口 ' + p + ' 已被占用，尝试 ' + (p + 1) + '...');
      } else {
        console.error('启动失败: ' + (err && err.message ? err.message : err));
        console.error('按回车键退出...');
        process.stdin.resume();
        process.stdin.once('data', function () { process.exit(1); });
        return;
      }
    }
  }

  if (!started) {
    console.error('');
    console.error('  ✗ 端口 ' + PORT + ' 到 ' + PORT_MAX + ' 全部被占用');
    console.error('    请关闭后重试，或手动打开: http://localhost:' + PORT + '/terminal.html');
    console.error('');
    console.error('按回车键退出...');
    process.stdin.resume();
    process.stdin.once('data', function () { process.exit(1); });
  }
}

start().catch(function (err) {
  console.error('启动失败: ' + (err && err.message ? err.message : err));
  console.error('按回车键退出...');
  process.stdin.resume();
  process.stdin.once('data', function () { process.exit(1); });
});
