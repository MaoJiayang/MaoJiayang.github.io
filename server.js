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

const PORT = parseInt(process.argv[2], 10) || parseInt(process.env.PORT, 10) || 24007;
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
  'js/se-bridge.js',
  'js/ui.js',
  'js/warehouse.js',
  'js/trade.js',
  'js/hangar.js',
  'js/shipyard.js',
  'js/settings.js',
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

/** 加载本地缓存的 ETag 清单: { "terminal.html": "abc123", ... } */
function loadManifest() {
  const p = path.join(CACHE_DIR, 'cache-manifest.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return {}; }
}

function saveManifest(manifest) {
  fs.writeFileSync(path.join(CACHE_DIR, 'cache-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

async function syncFrontend(forceUpdate) {
  ensureDir(CACHE_DIR);

  const force = forceUpdate || process.argv.includes('--update');
  console.log('[sync] ' + (force ? '强制更新' : '增量同步') + '，来源: ' + CF_ORIGIN);

  const manifest = force ? {} : loadManifest();
  let updated = 0, skipped = 0, errors = 0;

  for (const file of FRONTEND_FILES) {
    const cachePath = path.join(CACHE_DIR, file);
    const url = CF_ORIGIN + '/' + file;

    try {
      // 有缓存 → HEAD 拿 ETag，对比本地记录
      if (!force && fs.existsSync(cachePath)) {
        try {
          const headRes = await fetch(url, { method: 'HEAD' });
          if (headRes.ok) {
            const newEtag = headRes.headers.get('etag') || '';
            const oldEtag = manifest[file] || '';
            if (newEtag && oldEtag === newEtag) {
              skipped++;
              continue;  // ETag 未变，跳过
            }
          }
        } catch (_) {
          // HEAD 失败（无网络）→ 使用缓存，跳过
          skipped++;
          continue;
        }
      }

      // 无缓存 / ETag 变化 / 强制更新 → GET 下载
      const getRes = await fetch(url);
      if (!getRes.ok) {
        if (fs.existsSync(cachePath)) { skipped++; continue; }
        console.warn('[sync] 下载失败 (' + getRes.status + '): ' + file);
        errors++;
        continue;
      }
      const content = await getRes.text();
      ensureDir(path.dirname(cachePath));
      fs.writeFileSync(cachePath, content, 'utf-8');

      // 记录 ETag
      const etag = getRes.headers.get('etag') || '';
      if (etag) manifest[file] = etag;

      updated++;
      console.log('[sync] 更新: ' + file);
    } catch (e) {
      if (fs.existsSync(cachePath)) {
        skipped++; // 有缓存，网络不可达 → 使用缓存
      } else {
        console.warn('[sync] 错误: ' + file + ' - ' + e.message);
        errors++;
      }
    }
  }

  saveManifest(manifest);
  console.log('[sync] 完成: ' + updated + ' 更新, ' + skipped + ' 跳过, ' + errors + ' 失败');

  // 首次无缓存时检查关键文件
  const critical = ['terminal.html', 'js/se-bridge.js'];
  for (const f of critical) {
    if (!fs.existsSync(path.join(CACHE_DIR, f))) {
      console.warn('[sync] 警告: 关键文件缺失 ' + f + '，前端可能无法正常加载');
    }
  }
}

// ========== HTTP 路由 ==========

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
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

/** 代理请求到 CF Pages，透传请求体，返回响应 */
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
          const content = fs.readFileSync(htmlPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(content);
          return;
        }
      }
      res.writeHead(404, CORS);
      res.end('Not Found');
      return;
    }

    const content = fs.readFileSync(fullPath);
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

async function start() {
  if (!IS_DEV) {
    await syncFrontend(process.argv.includes('--update'));
  }

  // 监听 server 错误（如端口占用），防止未捕获异常导致闪退
  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error('  ✗ 端口 ' + PORT + ' 已被占用');
      console.error('    请关闭已运行的终端程序，或将以下地址手动粘贴到浏览器:');
      console.error('    http://localhost:' + PORT + '/terminal.html');
      console.error('');
    } else {
      console.error('  服务器错误: ' + err.message);
    }
    console.error('  按回车键退出...');
    process.stdin.resume();
    process.stdin.once('data', function () { process.exit(1); });
  });

  server.listen(PORT, function () {
    console.log('═'.repeat(50));
    console.log('  伊卡洛斯虚空终端 — ' + (IS_DEV ? '开发模式' : '桌面版'));
    console.log('═'.repeat(50));
    console.log('');
    console.log('  监听端口 : ' + PORT);
    console.log('  认证代理 : ' + CF_ORIGIN + '/api/*');
    console.log('  SE 服务器 : ' + SE_HOST + ':' + SE_PORT);
    console.log('  服务目录 : ' + (IS_DEV ? APP_DIR : CACHE_DIR));
    console.log('');
    console.log('  按 Ctrl+C 退出');
    console.log('═'.repeat(50));

    // 自动打开浏览器（Windows: start 不加引号，URL 不含特殊字符所以安全）
    var targetUrl = 'http://localhost:' + PORT + '/terminal.html';
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
  });
}

start().catch(function (err) {
  console.error('启动失败: ' + (err && err.message ? err.message : err));
  console.error('按回车键退出...');
  process.stdin.resume();
  process.stdin.once('data', function () { process.exit(1); });
});
