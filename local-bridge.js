/**
 * local-bridge.js — 本地开发桥接服务器
 *
 * 作用：替代 CF Pages Function，接收浏览器 HTTP 请求，通过 TCP 帧协议转发到 SE 服务器。
 * 用法：node local-bridge.js [端口]
 *       SE_HOST=183.131.51.12 SE_PORT=10086 SE_AUTH_KEY=12345 node local-bridge.js
 *
 * 然后浏览器打开 http://localhost:5500/terminal.html 即可调试。
 * （terminal.html 中 SeBridge.init 需临时设 bridgeUrl: 'http://localhost:3001'）
 */

'use strict';

const net = require('net');
const http = require('http');

const PORT = parseInt(process.argv[2], 10) || 3001;
const SE_HOST = process.env.SE_HOST || '183.131.51.12';
const SE_PORT = parseInt(process.env.SE_PORT, 10) || 10086;
const SE_AUTH_KEY = process.env.SE_AUTH_KEY || '12345';
const TIMEOUT = 15000;

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
            // PUA 清洗 + 归一化——与 CF Worker 同款逻辑
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

// ========== HTTP 路由 ==========

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(res, code, body) {
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
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

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const path = url.pathname;
  const t0 = Date.now();

  // 健康检查
  if (path === '/api/health') {
    jsonResponse(res, 200, { code: 200, msg: 'local-bridge ok' });
    return;
  }

  // 指令验证（仅验证凭据是否有效）
  if (path === '/api/command/verify') {
    const body = await readBody(req);
    if (!body || !body.steamId || !body.gamePassword) {
      jsonResponse(res, 400, { code: 400, msg: '缺少必要参数' });
      return;
    }
    const result = await tcpRequest(SE_HOST, SE_PORT, SE_AUTH_KEY, body.steamId, '!info myinfo', body.gamePassword);
    const ms = Date.now() - t0;
    console.log(`[verify] steamId=${body.steamId} code=${result.code} (${ms}ms)`);
    jsonResponse(res, result.code === 200 ? 200 : 401, result);
    return;
  }

  // 指令执行
  if (path === '/api/command/execute') {
    const body = await readBody(req);
    if (!body || !body.steamId || !body.command || !body.gamePassword) {
      jsonResponse(res, 400, { code: 400, msg: '缺少必要参数' });
      return;
    }
    console.log(`[execute] steamId=${body.steamId} cmd="${body.command}"`);
    const result = await tcpRequest(SE_HOST, SE_PORT, SE_AUTH_KEY, body.steamId, body.command, body.gamePassword);
    const ms = Date.now() - t0;
    const dataPreview = typeof result.data === 'object' ? JSON.stringify(result.data).substring(0, 200) : String(result.data || 'null').substring(0, 200);
    console.log(`[execute] code=${result.code} data=${dataPreview} (${ms}ms)`);
    jsonResponse(res, 200, result);
    return;
  }

  // 世界网格
  if (path === '/api/grid/world-grids') {
    const body = await readBody(req);
    if (!body || !body.steamId || !body.gamePassword) {
      jsonResponse(res, 400, { code: 400, msg: '缺少 steamId 或 gamePassword' });
      return;
    }
    console.log(`[world-grids] steamId=${body.steamId}`);
    const result = await tcpRequest(SE_HOST, SE_PORT, SE_AUTH_KEY, body.steamId, '', body.gamePassword, '/getWorldGridsBySteamId');
    const ms = Date.now() - t0;
    console.log(`[world-grids] code=${result.code} (${ms}ms)`);
    // 与 CF Worker 一致：GridVO[] 可能在 msg 字段中
    if (result.code === 200 && !result.data && result.msg) {
      try { const p = JSON.parse(result.msg); if (Array.isArray(p)) result.data = p; } catch (_) {}
    }
    jsonResponse(res, 200, result);
    return;
  }

  // 用户同步（本地不写 D1，仅做验证）
  if (path === '/api/user/sync') {
    const body = await readBody(req);
    if (!body || !body.steamId || !body.gamePassword) {
      jsonResponse(res, 400, { code: 400, msg: '缺少 steamId 或 gamePassword' });
      return;
    }
    const result = await tcpRequest(SE_HOST, SE_PORT, SE_AUTH_KEY, body.steamId, '!info myinfo', body.gamePassword);
    const ms = Date.now() - t0;
    console.log(`[sync] steamId=${body.steamId} code=${result.code} (${ms}ms)`);
    jsonResponse(res, result.code === 200 ? 200 : 401, {
      code: result.code === 200 ? 200 : 401,
      msg: result.msg || 'ok',
      data: { steamId: String(body.steamId) },
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('═'.repeat(50));
  console.log('  伊卡洛斯虚空终端 — 本地桥接服务器');
  console.log('═'.repeat(50));
  console.log('');
  console.log(`  监听端口 : ${PORT}`);
  console.log(`  SE 服务器 : ${SE_HOST}:${SE_PORT}`);
  console.log(`  认证密钥 : ${SE_AUTH_KEY}`);
  console.log('');
  console.log('  使用方法:');
  console.log('  1. 启动静态文件服务器: start-local.bat');
  console.log('  2. 浏览器打开 http://localhost:5500/terminal.html');
  console.log('     （本地环境自动检测桥接，无需改代码）');
  console.log(`  3. 若需改桥接端口: http://localhost:5500/terminal.html?bridge-port=${PORT}`);
  console.log('');
  console.log('  所有请求将通过本桥接直连 SE 服务器，绕过 CF Function。');
  console.log('═'.repeat(50));
});
