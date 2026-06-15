/**
 * 伊卡洛斯虚空终端 — 桥接服务器
 *
 * 部署在游戏服务器上，作为所有客户端（网页/EXE/APK）的**唯一安全边界**:
 *   - 持有 SE_AUTH_KEY，所有 TCP 通信经此到 SE
 *   - 限流/封禁检查在服务端内存执行，用户不可绕过
 *   - 懒加载用户状态（从 CF D1→admin 端点），本地缓存 + 定时刷新
 *
 * 使用方式:
 *   node bridge-server.js [--config config.json]
 *   SEA 编译为 EXE 后直接双击运行
 */

// ---- 依赖 ----
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { URL } = require('url');

// ---- 默认配置 ----
const DEFAULT_CONFIG = {
  port: 10085,
  tcpPort: 10087,           // CF Function 直连 TCP 端口（绕过 CF fetch IP 限制）
  seHost: '127.0.0.1',
  sePort: 10086,
  seAuthKey: '',
  cfAdminUrl: 'https://atomickitty17th.pages.dev',
  cfAdminKey: '',
  cacheMaxIdleSec: 86400,   // 缓存淘汰：超此时长无请求即删除（1天）
};

// ---- 模式检测 ----
const IS_SEA = process.execPath.endsWith('.exe') && !process.execPath.includes('node.exe');

// ---- 命令行参数 ----
const configPath = process.argv.indexOf('--config') > -1
  ? process.argv[process.argv.indexOf('--config') + 1]
  : (IS_SEA
      ? path.join(path.dirname(process.execPath), 'config.json')
      : path.join(__dirname, 'config.json'));

// ---- 加载配置 ----
let config = Object.assign({}, DEFAULT_CONFIG);
if (fs.existsSync(configPath)) {
  try {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config = Object.assign(config, fileConfig);
    console.log('[bridge] 已加载配置: ' + configPath);
  } catch (e) {
    console.error('[bridge] 配置文件解析失败: ' + e.message + '，使用默认值');
  }
} else {
  console.warn('[bridge] 未找到配置文件 ' + configPath + '，使用默认值');
}

// 密钥必填校验
if (!config.seAuthKey) {
  console.error('[bridge] seAuthKey 未配置，请在 config.json 中设置');
  console.error('[bridge] 退出。');
  process.exit(1);
}
if (!config.cfAdminKey) {
  console.error('[bridge] cfAdminKey 未配置，无法从 CF 获取用户状态');
  console.error('[bridge] 退出。');
  process.exit(1);
}

// ---- 常量 ----
const TIMEOUT_MS = 10000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

// ---- 内存缓存 ----
// userCache: steamId → { rateLimit, banned, displayName, cachedAt, lastAccess }
const userCache = new Map();
// rateWindows: steamId → { windowStart, count }
const rateWindows = new Map();
// 最近请求日志（最多 50 条）
const recentLogs = [];
const MAX_LOGS = 50;

// 日志文件（每天一个，按日期轮转）
const LOG_DIR = IS_SEA ? path.dirname(process.execPath) : __dirname;
let logStream = null;
let logStreamDate = '';

function getLogDate() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function ensureLogStream() {
  const today = getLogDate();
  if (logStream && logStreamDate !== today) {
    try { logStream.end(); } catch (_) {}
    logStream = null;
  }
  if (!logStream) {
    logStreamDate = today;
    logStream = fs.createWriteStream(path.join(LOG_DIR, 'bridge-server-' + today + '.log'), { flags: 'a' });
    logStream.on('error', () => {});
  }
}
function closeLogStream() {
  if (logStream) { try { logStream.end(); } catch (_) {}; logStream = null; }
}

let startTime = Date.now();

// ========== TCP 帧协议 ==========

function buildFrame(json) {
  const data = Buffer.from(json, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

function readFrame(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('读取超时'));
    }, timeoutMs);

    let buf = Buffer.alloc(0);

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const length = buf.readInt32BE(0);
        const total = 4 + length;
        if (buf.length >= total) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
          resolve(buf.toString('utf-8', 4, total));
        }
      }
    }

    function onError(err) {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      reject(err);
    }

    socket.on('data', onData);
    socket.once('error', onError);
  });
}

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

/**
 * TCP 请求到 SE 服务器。永不抛异常，总是返回 { code, msg, data }。
 */
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
    socket.setTimeout(TIMEOUT_MS);

    socket.connect(port, host, () => {
      socket.write(buildFrame(requestJson));
      readFrame(socket, TIMEOUT_MS)
        .then((responseJson) => {
          let raw;
          try { raw = JSON.parse(responseJson); } catch (_) {
            return resolve({ code: 500, msg: 'SE服务器响应异常', data: null });
          }
          raw = cleanPUA(raw);
          // 归一化响应格式（兼容新旧两种 SE 插件格式）
          if (raw.code !== undefined) {
            resolve(raw);
          } else if (raw.success === true) {
            let body = raw.bodyJson || '';
            try {
              const p = JSON.parse(body);
              if (typeof p === 'object' && p !== null) {
                resolve({ code: 200, msg: p.msg || JSON.stringify(p), data: p });
              } else {
                resolve({ code: 200, msg: body, data: null });
              }
            } catch (_) {
              resolve({ code: 200, msg: body, data: null });
            }
          } else if (raw.success === false) {
            resolve({ code: 400, msg: raw.errorMessage || '未知错误', data: null });
          } else {
            resolve({ code: 500, msg: '无法解析响应', data: null });
          }
        })
        .catch((e) => {
          resolve({ code: 500, msg: 'TCP 读取失败: ' + (e.message || '未知错误'), data: null });
        })
        .finally(() => { try { socket.destroy(); } catch (_) {} });
    });

    socket.on('error', (e) => {
      resolve({ code: 500, msg: 'TCP 连接失败: ' + (e.message || '未知错误'), data: null });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ code: 500, msg: 'TCP 连接超时', data: null });
    });
  });
}

// ========== 用户状态缓存 ==========

/**
 * 从 CF admin 端点拉取单个用户状态
 */
async function fetchUserFromCF(steamId) {
  const url = config.cfAdminUrl + '/api/admin/user/' + encodeURIComponent(steamId);
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'X-Admin-Key': config.cfAdminKey },
      timeout: 8000,
    };

    const req = (parsed.protocol === 'https:' ? require('https') : require('http')).request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 200 && json.data) {
            resolve(json.data);
          } else {
            console.warn('[bridge] CF 查询用户 ' + steamId + ' 返回异常: ' + data);
            resolve(null);
          }
        } catch (_) {
          console.warn('[bridge] CF 查询用户 ' + steamId + ' JSON 解析失败: ' + data);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.warn('[bridge] CF 查询用户 ' + steamId + ' 网络错误: ' + e.message);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn('[bridge] CF 查询用户 ' + steamId + ' 超时');
      resolve(null);
    });

    req.end();
  });
}

/**
 * 回调 CF admin 端点写入用户同步信息
 */
async function syncUserToCF(steamId, displayName, knownIp) {
  return new Promise((resolve) => {
    const url = config.cfAdminUrl + '/api/admin/user/sync';
    const parsed = new URL(url);
    const body = JSON.stringify({
      steamId: steamId,
      displayName: displayName || '',
      knownIp: knownIp || '',
    });

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': config.cfAdminKey,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    };

    const req = (parsed.protocol === 'https:' ? require('https') : require('http')).request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (_) {
          resolve(null);
        }
      });
    });

    req.on('error', () => { resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * 获取用户状态：缓存命中直接用（不自动刷新，变更从管理界面手动触发），
 * 未命中则同步从 CF 拉取。
 */
async function getUserState(steamId) {
  const cached = userCache.get(steamId);
  if (cached) {
    cached.lastAccess = Date.now();
    // 缓存命中但 displayName 为空 → 可能上次 sync 时 D1 不可达，异步补写
    if (!cached.displayName) {
      syncUserToCF(steamId, '', '').then((cfResult) => {
        if (cfResult && cfResult.code === 200) {
          console.log('[bridge] 异步补写 D1: ' + steamId);
        }
      }).catch(() => {});
    }
    return cached;
  }

  // 未命中：同步从 CF 拉取
  const data = await fetchUserFromCF(steamId);
  if (data) {
    const entry = {
      rateLimit: data.rateLimit || 20,
      banned: data.banned === true,
      displayName: data.displayName || '',
      cachedAt: Date.now(),
      lastAccess: Date.now(),
    };
    userCache.set(steamId, entry);
    console.log('[bridge] 用户 ' + steamId + ' 已缓存 (limit=' + entry.rateLimit + ', banned=' + entry.banned + ')');
    return entry;
  }

  // CF 不可达 + 无缓存：拒绝请求
  console.warn('[bridge] CF 不可达，无法验证用户 ' + steamId + '，拒绝请求');
  return null;
}

/**
 * 后台异步刷新用户缓存（不阻塞请求）
 */
async function refreshUserCache(steamId) {
  const data = await fetchUserFromCF(steamId);
  if (data) {
    const existing = userCache.get(steamId);
    userCache.set(steamId, {
      rateLimit: data.rateLimit || 20,
      banned: data.banned === true,
      displayName: data.displayName || '',
      cachedAt: Date.now(),
      lastAccess: existing ? existing.lastAccess : Date.now(),
    });
  }
}

// ========== 限流检查 ==========

function checkRateLimit(steamId, userState) {
  const now = Date.now();
  const wStart = Math.floor(now / 60000) * 60000; // 取整到分钟

  const current = rateWindows.get(steamId);
  if (!current || current.windowStart !== wStart) {
    return { limited: false, remaining: userState.rateLimit - 1, resetSeconds: 60 };
  }

  if (current.count >= userState.rateLimit) {
    const resetSeconds = Math.ceil((wStart + 60000 - now) / 1000);
    return { limited: true, remaining: 0, resetSeconds };
  }

  return { limited: false, remaining: userState.rateLimit - current.count - 1, resetSeconds: Math.ceil((wStart + 60000 - now) / 1000) };
}

function recordCall(steamId) {
  const now = Date.now();
  const wStart = Math.floor(now / 60000) * 60000;

  const current = rateWindows.get(steamId);
  if (!current || current.windowStart !== wStart) {
    rateWindows.set(steamId, { windowStart: wStart, count: 1 });
  } else {
    current.count++;
  }
}

/**
 * 回调 CF admin 端点更新用户 attrs（限流值/封禁状态），同步到 D1。
 */
async function updateUserD1(steamId, attrs) {
  return new Promise((resolve) => {
    const url = config.cfAdminUrl + '/api/admin/user/update';
    const parsed = new URL(url);
    const body = JSON.stringify(Object.assign({ steamId }, attrs));

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': config.cfAdminKey,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    };

    const req = (parsed.protocol === 'https:' ? require('https') : require('http')).request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json && json.code === 200);
        } catch (_) { resolve(false); }
      });
    });

    req.on('error', () => { resolve(false); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ========== 缓存淘汰 ==========

function cleanupCache() {
  const now = Date.now();
  const maxIdleMs = config.cacheMaxIdleSec * 1000;

  for (const [steamId, entry] of userCache) {
    if (now - entry.lastAccess > maxIdleMs) {
      userCache.delete(steamId);
      rateWindows.delete(steamId); // 同时清理限流窗口
      console.log('[bridge] 清除过期缓存: ' + steamId);
    }
  }
}

// 每 10 分钟执行一次淘汰
setInterval(cleanupCache, 10 * 60 * 1000);

// ========== 请求日志 ==========

function addLog(steamId, path, status, elapsedMs) {
  const entry = {
    time: new Date().toISOString(),
    steamId: String(steamId),
    path,
    status,
    elapsed: elapsedMs,
  };
  recentLogs.unshift(entry);
  if (recentLogs.length > MAX_LOGS) recentLogs.pop();

  // 追加到日志文件（JSON Lines，每行一条）
  ensureLogStream();
  logStream.write(JSON.stringify(entry) + '\n');
}

// ========== HTTP 辅助方法 ==========

function jsonResponse(res, status, body) {
  const json = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  };
  // API 响应附加限流水位头（方便客户端 UI 即时更新）
  Object.assign(headers, CORS);
  res.writeHead(status, headers);
  res.end(json);
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve({ ok: true, data: JSON.parse(body) }); }
      catch (_) { resolve({ ok: false, error: '请求格式错误' }); }
    });
  });
}

// ========== Admin UI（内嵌 HTML） ==========

function adminPageHTML() {
  const users = [];
  for (const [steamId, entry] of userCache) {
    const rw = rateWindows.get(steamId);
    users.push({
      steamId,
      displayName: entry.displayName || '-',
      rateLimit: entry.rateLimit,
      used: rw ? rw.count : 0,
      remaining: Math.max(0, entry.rateLimit - (rw ? rw.count : 0)),
      banned: entry.banned,
      lastAccess: new Date(entry.lastAccess).toLocaleString('zh-CN'),
    });
  }
  users.sort((a, b) => b.lastAccess.localeCompare(a.lastAccess));

  const logs = recentLogs.slice(0, 20).map((l) =>
    `<tr><td>${l.time}</td><td>${l.steamId}</td><td>${l.path}</td><td>${l.status}</td><td>${l.elapsed}ms</td></tr>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>虚空终端 · 桥接管理</title>
<style>
:root { color-scheme: dark; }
body {
  margin: 0; padding: 24px;
  font-family: "Segoe UI","Microsoft YaHei",sans-serif;
  background: #0B1A14; color: #C8D6C0;
}
h1 { font-size: 20px; margin: 0 0 4px; color: #7EB897; }
.sub { font-size: 13px; color: #5A7A6A; margin-bottom: 20px; }
.cards { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
.card {
  background: #12241C; border: 1px solid #253A2E;
  border-radius: 8px; padding: 14px 20px; min-width: 120px;
}
.card .val { font-size: 24px; font-weight: bold; color: #F0D060; }
.card .lbl { font-size: 12px; color: #5A7A6A; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #1E3326; font-size: 13px; }
th { color: #7EB897; font-weight: bold; position: sticky; top: 0; background: #0B1A14; }
.banned { color: #D06060; font-weight: bold; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
.btn {
  background: #1E3A2C; color: #C8D6C0; border: 1px solid #2A4A34;
  padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;
}
.btn:hover { background: #2A5A3C; border-color: #3A6A4C; }
input {
  background: #12241C; border: 1px solid #253A2E; color: #C8D6C0;
  padding: 6px 10px; border-radius: 4px; font-size: 13px;
}
.result { font-size: 12px; color: #7EB897; margin-top: 8px; min-height: 18px; }
</style>
</head>
<body>
<h1>伊卡洛斯虚空终端 — 桥接管理</h1>
<div class="sub">运行时长: ${formatUptime((Date.now() - startTime) / 1000)} | 缓存用户: ${userCache.size} | SE: ${config.seHost}:${config.sePort}</div>

<div class="cards">
  <div class="card"><div class="val">${userCache.size}</div><div class="lbl">缓存用户</div></div>
  <div class="card"><div class="val">${recentLogs.length}</div><div class="lbl">请求记录</div></div>
  <div class="card"><div class="val">${formatUptime((Date.now() - startTime) / 1000)}</div><div class="lbl">运行时长</div></div>
</div>

<div class="actions">
  <input id="steamIdInput" placeholder="SteamID" style="width:200px">
  <input id="limitInput" placeholder="新限流值" style="width:80px" type="number" min="0">
  <button class="btn" onclick="setLimit()">设置限流</button>
  <button class="btn" onclick="clearCache()">清除过期缓存</button>
  <button class="btn" onclick="refreshAll()">刷新所有缓存</button>
  <label class="btn" style="cursor:pointer"><input type="checkbox" checked onchange="toggleAutoRefresh(this)" style="margin-right:4px">自动刷新 <span id="refreshBadge">10s</span></label>
</div>
<div class="result" id="msg"></div>

<h2>用户列表</h2>
<table>
<thead><tr><th>SteamID</th><th>显示名</th><th>配额</th><th>已用</th><th>剩余</th><th>封禁</th><th>最后活跃</th><th>操作</th></tr></thead>
<tbody>
${users.map((u) => `<tr>
  <td>${u.steamId}</td>
  <td>${u.displayName}</td>
  <td>${u.rateLimit}</td>
  <td>${u.used}</td>
  <td>${u.remaining}</td>
  <td class="${u.banned ? 'banned' : ''}">${u.banned ? '已封禁' : '正常'}</td>
  <td>${u.lastAccess}</td>
  <td>
    <button class="btn" style="padding:4px 8px;font-size:11px" onclick="refreshUser('${u.steamId}')">刷新</button>
    <button class="btn" style="padding:4px 8px;font-size:11px" onclick="toggleBanned('${u.steamId}', ${u.banned})">${u.banned ? '解封' : '封禁'}</button>
    <button class="btn" style="padding:4px 8px;font-size:11px" onclick="clearUser('${u.steamId}')">清除</button>
  </td>
</tr>`).join('\n')}
</tbody>
</table>

<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
<h2 style="margin:0">最近请求</h2>
<button class="btn" onclick="clearLogs()">清屏</button>
</div>
<table>
<thead><tr><th>时间</th><th>SteamID</th><th>路径</th><th>状态</th><th>耗时</th></tr></thead>
<tbody>${logs}</tbody>
</table>

<script>
var AUTO_REFRESH_SEC = 10;
var autoTimer = null;
var countdown = AUTO_REFRESH_SEC;
var tickTimer = null;
function startAutoRefresh() {
  countdown = AUTO_REFRESH_SEC;
  updateBadge();
  tickTimer = setInterval(function() {
    countdown--;
    updateBadge();
    if (countdown <= 0) { location.reload(); }
  }, 1000);
}
function stopAutoRefresh() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  document.getElementById('refreshBadge').textContent = 'OFF';
}
function updateBadge() { document.getElementById('refreshBadge').textContent = countdown + 's'; }
function toggleAutoRefresh(cb) {
  if (cb.checked) { startAutoRefresh(); }
  else { stopAutoRefresh(); }
}
// 默认开启
document.addEventListener('DOMContentLoaded', function() { startAutoRefresh(); });

async function api(method, url, body) {
  var opts = { method: method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  var r = await fetch(url, opts);
  return r.json();
}
function msg(text) { document.getElementById('msg').textContent = text; setTimeout(function() { document.getElementById('msg').textContent = ''; }, 3000); }
function setLimit() {
  var sid = document.getElementById('steamIdInput').value.trim();
  var lim = document.getElementById('limitInput').value;
  if (!sid || !lim) { msg('请填写 SteamID 和限流值'); return; }
  api('POST', '/admin/api/set-limit', { steamId: sid, rateLimit: parseInt(lim) }).then(function(d) { msg(d.msg); location.reload(); });
}
function clearCache() { api('POST', '/admin/api/clear-cache').then(d => { msg(d.msg); location.reload(); }); }
function refreshAll() { api('POST', '/admin/api/refresh-all').then(d => { msg(d.msg); location.reload(); }); }
function refreshUser(sid) { api('POST', '/admin/api/refresh-user', { steamId: sid }).then(d => { msg(d.msg); location.reload(); }); }
function clearUser(sid) { api('POST', '/admin/api/clear-user', { steamId: sid }).then(d => { msg(d.msg); location.reload(); }); }
function clearLogs() { api('POST', '/admin/api/clear-logs').then(d => { msg(d.msg); location.reload(); }); }
function toggleBanned(sid, cur) {
  var action = cur ? '解封' : '封禁';
  if (!confirm('确定要' + action + ' ' + sid + ' 吗？')) return;
  api('POST', '/admin/api/set-banned', { steamId: sid, banned: !cur }).then(d => { msg(d.msg); location.reload(); });
}
</script>
</body>
</html>`;
}

function formatUptime(totalSec) {
  if (totalSec < 60) return Math.floor(totalSec) + '秒';
  if (totalSec < 3600) return Math.floor(totalSec / 60) + '分' + Math.floor(totalSec % 60) + '秒';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return h + '时' + m + '分';
}

// ========== Admin API ==========

async function handleAdminAPI(pathname, body, remoteAddr) {
  // 安全：只允许本地访问
  if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
    return { status: 403, body: { code: 403, msg: '仅限本地访问' } };
  }

  if (pathname === '/admin/api/set-limit') {
    const { steamId, rateLimit } = body;
    if (!steamId || typeof rateLimit !== 'number') {
      return { status: 400, body: { code: 400, msg: '缺少参数' } };
    }
    // 1. 更新本地缓存
    const entry = userCache.get(steamId);
    if (entry) { entry.rateLimit = rateLimit; }
    else { userCache.set(steamId, { rateLimit, banned: false, displayName: '', cachedAt: Date.now(), lastAccess: Date.now() }); }

    // 2. 同步到 D1
    const d1Result = await updateUserD1(steamId, { rateLimit });
    const msg = d1Result ? '限流值已设为 ' + rateLimit + ' (D1 已同步)' : '限流值已设为 ' + rateLimit + ' (仅缓存)';
    console.log('[bridge] ADMIN set-limit ' + steamId + ' → ' + rateLimit + (d1Result ? ' [D1 OK]' : ' [D1 FAIL]'));
    addLog(steamId, 'admin:set-limit→' + rateLimit, d1Result ? 200 : 206, 0);
    return { status: 200, body: { code: 200, msg } };
  }

  if (pathname === '/admin/api/clear-cache') {
    const now = Date.now();
    const maxIdleMs = config.cacheMaxIdleSec * 1000;
    let count = 0;
    for (const [steamId, entry] of userCache) {
      if (now - entry.lastAccess > maxIdleMs) {
        userCache.delete(steamId);
        rateWindows.delete(steamId);
        count++;
      }
    }
    return { status: 200, body: { code: 200, msg: '已清除 ' + count + ' 条过期缓存' } };
  }

  if (pathname === '/admin/api/refresh-all') {
    const ids = Array.from(userCache.keys());
    for (const steamId of ids) {
      await refreshUserCache(steamId);
    }
    return { status: 200, body: { code: 200, msg: '已刷新 ' + ids.length + ' 个用户' } };
  }

  if (pathname === '/admin/api/refresh-user') {
    const { steamId } = body;
    if (!steamId) return { status: 400, body: { code: 400, msg: '缺少 steamId' } };
    await refreshUserCache(steamId);
    return { status: 200, body: { code: 200, msg: '已刷新 ' + steamId } };
  }

  if (pathname === '/admin/api/clear-user') {
    const { steamId } = body;
    if (!steamId) return { status: 400, body: { code: 400, msg: '缺少 steamId' } };
    userCache.delete(steamId);
    rateWindows.delete(steamId);
    return { status: 200, body: { code: 200, msg: '已清除 ' + steamId } };
  }

  if (pathname === '/admin/api/clear-logs') {
    recentLogs.length = 0;
    return { status: 200, body: { code: 200, msg: '日志已清屏' } };
  }

  if (pathname === '/admin/api/set-banned') {
    const { steamId, banned } = body;
    if (!steamId || typeof banned !== 'boolean') return { status: 400, body: { code: 400, msg: '缺少 steamId 或 banned' } };
    // 1. 更新本地缓存
    const entry = userCache.get(steamId);
    if (entry) { entry.banned = banned; }
    else { userCache.set(steamId, { rateLimit: 20, banned, displayName: '', cachedAt: Date.now(), lastAccess: Date.now() }); }

    // 2. 同步到 D1
    const d1Result = await updateUserD1(steamId, { banned });
    const action = banned ? '封禁' : '解封';
    const msg = steamId + (d1Result ? ' 已' + action + ' (D1 已同步)' : ' 已' + action + ' (仅缓存)');
    console.log('[bridge] ADMIN ' + action + ' ' + steamId + (d1Result ? ' [D1 OK]' : ' [D1 FAIL]'));
    addLog(steamId, 'admin:' + action, d1Result ? 200 : 206, 0);
    return { status: 200, body: { code: 200, msg } };
  }

  // 获取缓存数据（供管理界面 AJAX 用，目前内嵌 HTML 无需 AJAX）
  if (pathname === '/admin/api/status') {
    return {
      status: 200,
      body: {
        code: 200,
        msg: 'ok',
        data: {
          uptimeSeconds: (Date.now() - startTime) / 1000,
          cacheSize: userCache.size,
          recentLogs: recentLogs.slice(0, 20),
        },
      },
    };
  }

  return { status: 404, body: { code: 404, msg: '未知管理接口' } };
}

// ========== HTTP 服务器 ==========

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const remoteAddr = req.socket.remoteAddress || '';

  // ---- 管理界面 ----
  if (req.method === 'GET' && pathname === '/admin') {
    const html = adminPageHTML();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  // ---- Admin API ----
  if (req.method === 'POST' && pathname.startsWith('/admin/api/')) {
    const b = await readRequestBody(req);
    if (!b.ok) { jsonResponse(res, 400, { code: 400, msg: b.error }); return; }
    const result = await handleAdminAPI(pathname, b.data, remoteAddr);
    jsonResponse(res, result.status, result.body);
    return;
  }

  // ---- 健康检查 ----
  if (req.method === 'GET' && pathname === '/api/health') {
    const body = {
      code: 200,
      msg: 'bridge ok',
      data: {
        bridge: 'ok',
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        cacheSize: userCache.size,
      },
    };

    // 可选：返回特定用户的限流配额
    const steamId = url.searchParams.get('steamId');
    if (steamId) {
      const userState = await getUserState(steamId);
      if (userState) {
        const rateInfo = checkRateLimit(steamId, userState);
        body.data.rateLimit = {
          remaining: rateInfo.remaining,
          limit: userState.rateLimit,
          resetSeconds: rateInfo.resetSeconds,
        };
      }
      // CF 不可达时省略 rateLimit 字段（健康检查本身不拒绝）
    }

    jsonResponse(res, 200, body);
    return;
  }

  // ---- API 路由 ----
  if (req.method === 'POST') {
    const b = await readRequestBody(req);
    if (!b.ok) { jsonResponse(res, 400, { code: 400, msg: b.error }); return; }
    const body = b.data;
    const steamId = String(body.steamId || '');
    const t0 = Date.now();

    // --- /api/command/verify ---
    if (pathname === '/api/command/verify') {
      if (!body.steamId || !body.gamePassword) {
        jsonResponse(res, 400, { code: 400, msg: '缺少 steamId 或 gamePassword' });
        return;
      }
      // SteamID 格式校验（公共个人账户 17 位 7656119 开头）
      if (!/^7656119\d{10}$/.test(String(body.steamId))) {
        jsonResponse(res, 400, { code: 400, msg: 'SteamID 格式错误' });
        return;
      }
      const result = await tcpRequest(config.seHost, config.sePort, config.seAuthKey,
        body.steamId, '!info myinfo', body.gamePassword);

      // SE 验证成功后写缓存（含 displayName），失败不缓存保持缓存干净
      if (result.code === 200) {
        const displayName = (result.data && result.data.displayName) || '';
        const existing = userCache.get(steamId);
        userCache.set(steamId, {
          rateLimit: existing ? existing.rateLimit : 20,
          banned: existing ? existing.banned : false,
          displayName: displayName || (existing ? existing.displayName : ''),
          cachedAt: Date.now(),
          lastAccess: Date.now(),
        });
        console.log('[bridge] verify 缓存用户 ' + steamId + ' (displayName=' + displayName + ')');
      }

      addLog(steamId, 'verify', result.code, Date.now() - t0);
      jsonResponse(res, result.code === 200 ? 200 : (result.code === 400 ? 400 : 500), result);
      return;
    }

    // --- /api/user/sync ---
    if (pathname === '/api/user/sync') {
      if (!body.steamId) {
        jsonResponse(res, 400, { code: 400, msg: '缺少 steamId' });
        return;
      }

      // sync 不调 SE。verify 已验证过密码。
      // 有 displayName → UPSERT D1；无 displayName → 读 D1
      const cached = userCache.get(steamId);
      let displayName = cached ? cached.displayName : '';

      // 有 displayName = 刚 verify 过 → 直接 UPSERT D1（省去 fetchUserFromCF 的延迟）
      if (displayName) {
        const cfResult = await syncUserToCF(steamId, displayName, '');
        if (cfResult && cfResult.code === 200 && cfResult.data && cfResult.data.attrs) {
          const attrs = cfResult.data.attrs;
          userCache.set(steamId, {
            rateLimit: attrs.rateLimit || 20,
            banned: attrs.banned === true,
            displayName: attrs.displayName || displayName,
            cachedAt: Date.now(),
            lastAccess: Date.now(),
          });
          console.log('[bridge] sync ' + steamId + ' D1 回写完成 (limit=' + attrs.rateLimit + ')');
          addLog(steamId, 'sync', 200, Date.now() - t0);
          jsonResponse(res, 200, {
            code: 200, msg: 'ok',
            data: { attrs: { rateLimit: attrs.rateLimit || 20, banned: attrs.banned === true, displayName: attrs.displayName || displayName } },
          });
          return;
        }
        console.warn('[bridge] sync ' + steamId + ' D1 回写失败，用缓存值');
      }

      // 无 displayName → 从 D1 拉状态（老用户 / 缓存丢失 / 桥接刚重启）
      const cfData = await fetchUserFromCF(steamId);
      if (cfData && !cfData.notFound) {
        const updated = {
          rateLimit: cfData.rateLimit || 20,
          banned: cfData.banned === true,
          displayName: cfData.displayName || '',
          cachedAt: Date.now(),
          lastAccess: Date.now(),
        };
        userCache.set(steamId, updated);
        console.log('[bridge] sync ' + steamId + ' D1 有记录 (limit=' + updated.rateLimit + ')');
        addLog(steamId, 'sync', 200, Date.now() - t0);
        jsonResponse(res, 200, {
          code: 200, msg: 'ok',
          data: { attrs: { rateLimit: updated.rateLimit, banned: updated.banned, displayName: updated.displayName } },
        });
        return;
      }

      // 兜底：D1 不可达 → 写默认缓存 + 异步补注册
      if (!cached) {
        userCache.set(steamId, { rateLimit: 20, banned: false, displayName: '', cachedAt: Date.now(), lastAccess: Date.now() });
      }
      syncUserToCF(steamId, displayName, '').catch(() => {});
      const fallback = cached || { rateLimit: 20, banned: false, displayName: '' };
      addLog(steamId, 'sync', 200, Date.now() - t0);
      jsonResponse(res, 200, {
        code: 200, msg: 'ok',
        data: { attrs: { rateLimit: fallback.rateLimit, banned: fallback.banned, displayName: fallback.displayName } },
      });
      return;
    }

    // --- /api/command/execute ---
    if (pathname === '/api/command/execute') {
      if (!body.steamId || !body.command || !body.gamePassword) {
        jsonResponse(res, 400, { code: 400, msg: '缺少必要参数' });
        return;
      }

      // 1. 查用户状态（含封禁检查）
      const userState = await getUserState(steamId);
      if (!userState) {
        // CF 不可达且无缓存 → 拒绝请求，不放行未验证用户
        addLog(steamId, 'execute', 503, Date.now() - t0);
        jsonResponse(res, 503, { code: 503, msg: '服务暂不可用，请稍后重试' });
        return;
      }
      if (userState.banned) {
        addLog(steamId, 'execute', 403, Date.now() - t0);
        jsonResponse(res, 403, { code: 403, msg: '您的账号已被禁用' });
        return;
      }

      // 2. 限流检查
      const rateCheck = checkRateLimit(steamId, userState);
      if (rateCheck.limited) {
        addLog(steamId, 'execute', 429, Date.now() - t0);
        res.writeHead(429, Object.assign({
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetSeconds),
        }, CORS));
        res.end(JSON.stringify({ code: 429, msg: '请求过于频繁，请等待 ' + rateCheck.resetSeconds + ' 秒' }));
        return;
      }

      // 3. 执行指令
      const result = await tcpRequest(config.seHost, config.sePort, config.seAuthKey,
        body.steamId, body.command, body.gamePassword);

      // 4. 记录调用
      recordCall(steamId);
      addLog(steamId, 'execute', result.code, Date.now() - t0);

      // 5. 附加限流信息到响应头
      const headers = Object.assign({
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(rateCheck.resetSeconds),
      }, CORS);
      const respJson = JSON.stringify(result);
      res.writeHead(result.code === 200 ? 200 : (result.code > 0 ? result.code : 500), headers);
      res.end(respJson);
      return;
    }

    // --- /api/grid/world-grids ---
    if (pathname === '/api/grid/world-grids') {
      if (!body.steamId || !body.gamePassword) {
        jsonResponse(res, 400, { code: 400, msg: '缺少 steamId 或 gamePassword' });
        return;
      }

      const userState = await getUserState(steamId);
      if (!userState) {
        addLog(steamId, 'world-grids', 503, Date.now() - t0);
        jsonResponse(res, 503, { code: 503, msg: '服务暂不可用，请稍后重试' });
        return;
      }
      if (userState.banned) {
        addLog(steamId, 'world-grids', 403, Date.now() - t0);
        jsonResponse(res, 403, { code: 403, msg: '您的账号已被禁用' });
        return;
      }

      const rateCheck = checkRateLimit(steamId, userState);
      if (rateCheck.limited) {
        addLog(steamId, 'world-grids', 429, Date.now() - t0);
        res.writeHead(429, Object.assign({
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetSeconds),
        }, CORS));
        res.end(JSON.stringify({ code: 429, msg: '请求过于频繁，请等待 ' + rateCheck.resetSeconds + ' 秒' }));
        return;
      }

      const result = await tcpRequest(config.seHost, config.sePort, config.seAuthKey,
        body.steamId, '', body.gamePassword, '/getWorldGridsBySteamId');

      // 服务端将 GridVO[] 序列化到 msg 字段，解析为 data
      if (result.code === 200 && result.msg) {
        try {
          const parsed = JSON.parse(result.msg);
          if (Array.isArray(parsed)) {
            result.data = parsed;
          }
        } catch (_) { /* msg 不是 JSON，保持原样 */ }
      }

      recordCall(steamId);
      addLog(steamId, 'world-grids', result.code, Date.now() - t0);

      const gridHeaders = Object.assign({
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(rateCheck.resetSeconds),
      }, CORS);
      const gridJson = JSON.stringify(result);
      res.writeHead(result.code === 200 ? 200 : 500, gridHeaders);
      res.end(gridJson);
      return;
    }

    // 未知 POST 路径
    jsonResponse(res, 404, { code: 404, msg: '未知接口' });
    return;
  }

  // 未知请求
  jsonResponse(res, 404, { code: 404, msg: '未知接口' });
});

// ========== 启动 ==========

server.listen(config.port, () => {
  console.log('[bridge] 伊卡洛斯虚空终端 · 桥接服务已启动');
  console.log('[bridge] 端口: ' + config.port);
  console.log('[bridge] SE 服务器: ' + config.seHost + ':' + config.sePort);
  console.log('[bridge] CF 管理端点: ' + config.cfAdminUrl);
  console.log('[bridge] 管理界面: http://localhost:' + config.port + '/admin');
  console.log('[bridge] 淘汰空闲: ' + config.cacheMaxIdleSec + 's');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('[bridge] 端口 ' + config.port + ' 已被占用');
  }
  console.error('[bridge] HTTP 启动失败: ' + e.message);
  process.exit(1);
});

// ========== CF TCP 监听（网页端专用，绕过 Cloudflare fetch IP 限制） ==========

/**
 * 处理 CF Function 通过 TCP 直连发来的指令帧。
 * CF 已查好 D1 用户状态附带在帧中，桥接直接使用无需回调查 CF。
 */
async function handleCfTcpFrame(frame) {
  const steamId = String(frame.steamId || '');
  const t0 = Date.now();
  const pathLabel = frame.path || '/command';
  const isSync = frame.type === 'sync';

  // 1. 校验 authKey
  if (frame.authKey !== config.cfAdminKey) {
    addLog(steamId, 'cf-tcp', 401, Date.now() - t0);
    return { code: 401, msg: '鉴权失败', data: null };
  }

  // 2. SteamID 格式校验（与 HTTP verify 一致）
  if (!/^7656119\d{10}$/.test(steamId)) {
    addLog(steamId, 'cf-tcp', 400, Date.now() - t0);
    return { code: 400, msg: 'SteamID 格式错误', data: null };
  }

  // 3. 获取用户状态：优先缓存，其次兜底懒加载
  //    SE 验证前不写缓存，防止坏 ID 污染
  let userState = userCache.get(steamId);
  if (!userState) {
    console.log('[bridge] [兜底] CF 用户 ' + steamId + ' 缓存未命中，懒加载');
    userState = await getUserState(steamId);
    if (!userState) {
      addLog(steamId, 'cf-' + pathLabel, 503, Date.now() - t0);
      console.warn('[bridge] CF TCP: ' + steamId + ' 兜底懒加载也失败，拒绝');
      return { code: 503, msg: '服务暂不可用', data: null };
    }
    console.log('[bridge] [兜底] ' + steamId + ' 懒加载成功');
  }

  // 4. 封禁检查
  if (userState.banned) {
    addLog(steamId, 'cf-' + pathLabel, 403, Date.now() - t0);
    return { code: 403, msg: '您的账号已被禁用', data: null };
  }

  // 5. 限流检查
  const rateCheck = checkRateLimit(steamId, userState);
  if (rateCheck.limited) {
    addLog(steamId, 'cf-' + pathLabel, 429, Date.now() - t0);
    return { code: 429, msg: '请求过于频繁，请等待 ' + rateCheck.resetSeconds + ' 秒', data: null };
  }

  // 6. sync 类型：不调 SE，纯 D1 读/写
  if (isSync) {
    const cached = userCache.get(steamId);
    const displayName = cached ? cached.displayName : '';

    // 有 displayName = 刚 verify 过 → 直接 UPSERT D1（跳过 fetchUserFromCF）
    if (displayName) {
      const cfResult = await syncUserToCF(steamId, displayName, '');
      if (cfResult && cfResult.code === 200 && cfResult.data && cfResult.data.attrs) {
        const attrs = cfResult.data.attrs;
        userCache.set(steamId, {
          rateLimit: attrs.rateLimit || 20,
          banned: attrs.banned === true,
          displayName: attrs.displayName || displayName,
          cachedAt: Date.now(),
          lastAccess: Date.now(),
        });
        console.log('[bridge] CF sync ' + steamId + ' D1 回写完成 (limit=' + attrs.rateLimit + ')');
        addLog(steamId, 'cf-sync', 200, Date.now() - t0);
        return { code: 200, msg: 'ok', data: { attrs: { rateLimit: attrs.rateLimit || 20, banned: false, displayName: attrs.displayName || displayName } } };
      }
    }

    // 无 displayName → 从 D1 拉状态
    const cfData = await fetchUserFromCF(steamId);
    if (cfData && !cfData.notFound) {
      const updated = {
        rateLimit: cfData.rateLimit || 20,
        banned: cfData.banned === true,
        displayName: cfData.displayName || displayName,
        cachedAt: Date.now(),
        lastAccess: Date.now(),
      };
      userCache.set(steamId, updated);
      addLog(steamId, 'cf-sync', 200, Date.now() - t0);
      return { code: 200, msg: 'ok', data: { attrs: { rateLimit: updated.rateLimit, banned: updated.banned, displayName: updated.displayName } } };
    }

    // 兜底：D1 不可达 → 写入默认缓存 + 异步补注册
    if (!cached) {
      userCache.set(steamId, { rateLimit: 20, banned: false, displayName: '', cachedAt: Date.now(), lastAccess: Date.now() });
    }
    syncUserToCF(steamId, displayName, '').catch(() => {});
    const fallback = cached || { rateLimit: 20, banned: false, displayName: '' };
    addLog(steamId, 'cf-sync', 200, Date.now() - t0);
    return { code: 200, msg: 'ok', data: { attrs: { rateLimit: fallback.rateLimit, banned: fallback.banned, displayName: fallback.displayName } } };
  }

  // 7. 非 sync：执行指令到 SE
  const result = await tcpRequest(config.seHost, config.sePort, config.seAuthKey,
    steamId, frame.command || '', frame.gamePassword || '', frame.path);

  // 8. SE 成功后写缓存（含 displayName 从 SE 响应取，rateLimit/banned 从 CF userState 取）
  if (result.code === 200) {
    const seDisplayName = (result.data && result.data.displayName) || '';
    const cfUserState = (frame.userState && typeof frame.userState.rateLimit === 'number') ? frame.userState : null;
    const existing = userCache.get(steamId);
    userCache.set(steamId, {
      rateLimit: cfUserState ? cfUserState.rateLimit || 20 : (existing ? existing.rateLimit : 20),
      banned: cfUserState ? cfUserState.banned === true : (existing ? existing.banned : false),
      displayName: seDisplayName || (existing ? existing.displayName : ''),
      cachedAt: Date.now(),
      lastAccess: Date.now(),
    });
    console.log('[bridge] CF verify 缓存用户 ' + steamId + ' (displayName=' + seDisplayName + ')');
  }

  // 9. 特殊处理 world-grids
  if (frame.path === '/getWorldGridsBySteamId' && result.code === 200 && result.msg) {
    try {
      const parsed = JSON.parse(result.msg);
      if (Array.isArray(parsed)) result.data = parsed;
    } catch (_) {}
  }

  recordCall(steamId);
  addLog(steamId, 'cf-' + (frame.type === 'sync' ? 'sync' : pathLabel), result.code, Date.now() - t0);
  return result;
}

/**
 * 启动 CF 专用 TCP 监听器。
 * 复用现有 TCP 帧协议（4B BE 长度 + UTF-8 JSON）。
 */
function startCfTcpListener() {
  const tcpServer = net.createServer((socket) => {
    socket.setTimeout(TIMEOUT_MS);

    readFrame(socket, TIMEOUT_MS)
      .then(async (json) => {
        let frame;
        try { frame = JSON.parse(json); } catch (_) {
          socket.end(buildFrame(JSON.stringify({ code: 400, msg: '帧格式错误', data: null })));
          return;
        }
        const response = await handleCfTcpFrame(frame);
        try { socket.end(buildFrame(JSON.stringify(response))); } catch (_) {}
      })
      .catch((e) => {
        console.warn('[bridge] CF TCP 读取失败: ' + (e.message || ''));
        try { socket.destroy(); } catch (_) {}
      });
  });

  tcpServer.on('error', (e) => {
    console.error('[bridge] CF TCP 端口 ' + config.tcpPort + ' 错误: ' + e.message);
  });

  tcpServer.listen(config.tcpPort, () => {
    console.log('[bridge] CF TCP 端口: ' + config.tcpPort);
  });
}

// 退出时关闭日志文件
process.on('exit', closeLogStream);
process.on('SIGINT', () => { closeLogStream(); process.exit(0); });
process.on('SIGTERM', () => { closeLogStream(); process.exit(0); });

// 启动 CF TCP 监听器
startCfTcpListener();
