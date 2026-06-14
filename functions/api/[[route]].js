/**
 * CF Pages Function: /api/* 统一处理
 *
 * D1 操作（封禁/同步）+ 转发到服务端桥接。CF 查好 D1 用户状态后通过
 * TCP 帧协议直连桥接（绕过 CF fetch 裸 IP 限制），桥接统一处理限流与 SE 通信。
 *
 * 环境变量（在 CF Dashboard → Pages → Settings → Environment variables 中配置）:
 *   SE_BLACKLIST  — 禁止执行指令的 SteamID，逗号分隔
 *   SE_ADMIN_KEY  — 管理密钥，供 bridge-server 调用 admin 端点
 *   BRIDGE_URL    — 服务端桥接地址（设置后启用桥接路径）
 *   BRIDGE_TCP_PORT — 桥接 TCP 端口（默认 10087）
 */
import { connect } from 'cloudflare:sockets';

const TIMEOUT_MS = 10000;

// ---- D1 用户表初始化 ----

let userTableReady = false;
async function ensureUserTable(db) {
  if (userTableReady) return;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      steam_id    TEXT PRIMARY KEY,
      attrs       TEXT DEFAULT '{}',
      known_ip    TEXT,
      login_at    TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `).run();
  // 兼容旧表：无 known_ip 列时自动新增
  try { await db.prepare('ALTER TABLE users ADD COLUMN known_ip TEXT').run(); } catch (_) {}
  userTableReady = true;
}

/**
 * 检查用户是否被禁用（读取 D1 users.attrs.banned 字段）
 * 返回 null 表示正常，返回 Response 表示已被禁用需直接返回给客户端
 */
async function checkBanned(steamId, db) {
  if (!db) return null;  // 无 D1 绑定时跳过检查
  try {
    await ensureUserTable(db);
    const row = await db.prepare(
      'SELECT attrs FROM users WHERE steam_id = ?'
    ).bind(String(steamId)).first();
    if (!row) return null;  // 无记录，放行
    const attrs = JSON.parse(row.attrs || '{}');
    if (attrs.banned === true) {
      return Response.json({ code: 403, msg: '您的账号已被禁用' }, { status: 403 });
    }
  } catch (_) { /* D1 查询失败不阻塞登录 */ }
  return null;
}

function getConfig(env) {
  return {
    blacklist: new Set(
      (env.SE_BLACKLIST || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    ),
  };
}

function buildFrame(json) {
  const data = new TextEncoder().encode(json);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setInt32(0, data.length, false); // Big-Endian
  return new Uint8Array([...len, ...data]);
}

async function readFrame(socket, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const reader = socket.readable.getReader();
    let buf = new Uint8Array(0);

    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('连接已关闭');

      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0);
      merged.set(value, buf.length);
      buf = merged;

      if (buf.length >= 4) {
        const view = new DataView(buf.buffer);
        const length = view.getInt32(0, false); // Big-Endian
        const total = 4 + length;
        if (buf.length >= total) {
          reader.releaseLock();
          return new TextDecoder().decode(buf.slice(4, total));
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function normalizePath(pathname) {
  return pathname.replace(/\/$/, '') || '/api';
}

// ---- 桥接 TCP 通信 ----

/**
 * 从 D1 查用户状态，供 TCP 帧附带传给桥接。
 * bridge-server 收到后直接使用，无需再跨境 HTTP 回调 CF。
 */
async function getUserStateForBridge(steamId, env) {
  try {
    const db = env.LOG_DB;
    if (!db) return null;
    await ensureUserTable(db);
    const row = await db.prepare(
      'SELECT attrs FROM users WHERE steam_id = ?'
    ).bind(String(steamId)).first();
    if (!row) return { rateLimit: 20, banned: false, displayName: '' };
    const attrs = JSON.parse(row.attrs || '{}');
    return {
      rateLimit: attrs.rateLimit || 20,
      banned: attrs.banned === true,
      displayName: attrs.displayName || '',
    };
  } catch (_) {
    return null;  // D1 故障时由桥接自行兜底
  }
}

/**
 * 通过 TCP 帧协议直连桥接服务器，附带 userState。
 * 使用 connect() + buildFrame/readFrame 与桥接通信。
 */
async function tcpToBridge(host, port, authKey, steamId, command, password, customPath, userState) {
  let socket;
  try {
    const frame = {
      authKey,
      steamId,
      command,
      gamePassword: password,
      path: customPath || '/command',
      userState,
    };
    const requestJson = JSON.stringify(frame);

    socket = connect({ hostname: host, port }, { secureTransport: 'off' });
    const writer = socket.writable.getWriter();
    await writer.write(buildFrame(requestJson));
    writer.releaseLock();

    const responseJson = await readFrame(socket, TIMEOUT_MS);

    let raw;
    try { raw = JSON.parse(responseJson); } catch (_) {
      return { code: 500, msg: '桥接响应异常', data: null };
    }
    // 桥接直接返回归一化后的 { code, msg, data }，无需再处理
    return raw;
  } catch (e) {
    return { code: 500, msg: '桥接 TCP 失败: ' + (e.message || '未知错误'), data: null };
  } finally {
    if (socket) { try { socket.close(); } catch (_) {} }
  }
}

// ---- Admin 端点鉴权 ----

/**
 * 验证管理密钥（用于 bridge-server 调用 admin 端点）
 * 从 X-Admin-Key 请求头读取，与 CF Dashboard 环境变量 SE_ADMIN_KEY 比对
 * 失败返回 401 Response，成功返回 null
 */
function checkAdminKey(request, env) {
  const expected = env.SE_ADMIN_KEY;
  if (!expected) {
    // 未配置 SE_ADMIN_KEY 时拒绝所有 admin 请求
    return Response.json({ code: 401, msg: '管理端点未启用' }, { status: 401 });
  }
  const provided = request.headers.get('X-Admin-Key') || '';
  if (provided !== expected) {
    return Response.json({ code: 401, msg: '鉴权失败' }, { status: 401 });
  }
  return null;  // 通过
}

/** 从 known_ip JSON 数组中取最新 IP */
function latestIp(knownIpJson) {
  try {
    var ips = JSON.parse(knownIpJson || '[]');
    return (Array.isArray(ips) && ips.length > 0) ? ips[0] : '';
  } catch (_) { return ''; }
}

// ---- Admin 端点 ----

/**
 * GET /api/admin/user/:steamId
 * 供 bridge-server 查询单个用户的限流/封禁/displayName
 * 用户不存在时返回默认值 + notFound:true
 */
async function getAdminUser(steamId, env) {
  try {
    const db = env.LOG_DB;
    if (!db) {
      return Response.json({ code: 502, msg: 'D1 未绑定' }, { status: 502 });
    }
    await ensureUserTable(db);
    const row = await db.prepare(
      'SELECT attrs FROM users WHERE steam_id = ?'
    ).bind(String(steamId)).first();

    if (!row) {
      return Response.json({
        code: 200,
        msg: 'ok',
        data: { steamId: String(steamId), rateLimit: 20, banned: false, displayName: '', notFound: true },
      });
    }

    const attrs = JSON.parse(row.attrs || '{}');
    return Response.json({
      code: 200,
      msg: 'ok',
      data: {
        steamId: String(steamId),
        rateLimit: attrs.rateLimit || 20,
        banned: attrs.banned === true,
        displayName: attrs.displayName || '',
      },
    });
  } catch (e) {
    console.error('admin/user GET failed:', e?.message);
    return Response.json({ code: 502, msg: 'D1 查询失败' }, { status: 502 });
  }
}

/**
 * POST /api/admin/user/sync
 * 供 bridge-server 在用户登录成功后回调，写入/更新 D1 用户记录
 * Body: { steamId, displayName, knownIp }
 */
async function handleAdminSync(body, env) {
  if (!body.steamId) {
    return Response.json({ code: 400, msg: '缺少 steamId' }, { status: 400 });
  }

  try {
    const db = env.LOG_DB;
    if (!db) {
      return Response.json({ code: 502, msg: 'D1 未绑定' }, { status: 502 });
    }
    await ensureUserTable(db);

    const now = new Date().toISOString();
    const ip = body.knownIp || '';
    const displayName = body.displayName || '';
    const defaultAttrs = JSON.stringify({ rateLimit: 20, banned: false });

    const existing = await db.prepare(
      'SELECT steam_id, attrs, known_ip FROM users WHERE steam_id = ?'
    ).bind(String(body.steamId)).first();

    var mergedIp;
    if (existing) {
      var ips = [];
      try { ips = JSON.parse(existing.known_ip || '[]'); } catch (_) { ips = []; }
      if (!Array.isArray(ips)) ips = [];
      if (ip) {
        ips = ips.filter(function (v) { return v !== ip; });
        ips.unshift(ip);
        if (ips.length > 10) ips = ips.slice(0, 10);
      }
      mergedIp = JSON.stringify(ips);

      await db.prepare(
        'UPDATE users SET known_ip = ?, login_at = ? WHERE steam_id = ?'
      ).bind(mergedIp, now, String(body.steamId)).run();

      // 检查 displayName 是否需要更新
      if (displayName) {
        const attrs = JSON.parse(existing.attrs || '{}');
        if (attrs.displayName !== displayName) {
          attrs.displayName = displayName;
          await db.prepare(
            'UPDATE users SET attrs = ? WHERE steam_id = ?'
          ).bind(JSON.stringify(attrs), String(body.steamId)).run();
        }
      }
    } else {
      mergedIp = ip ? JSON.stringify([ip]) : '[]';
      const attrsToWrite = displayName
        ? JSON.stringify({ rateLimit: 20, banned: false, displayName: displayName })
        : defaultAttrs;
      await db.prepare(
        'INSERT INTO users (steam_id, attrs, known_ip, login_at, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(String(body.steamId), attrsToWrite, mergedIp, now, now).run();
    }

    // 读取更新后的记录
    const row = await db.prepare(
      'SELECT steam_id, attrs, known_ip, login_at, created_at FROM users WHERE steam_id = ?'
    ).bind(String(body.steamId)).first();

    return Response.json({
      code: 200,
      msg: 'ok',
      data: {
        steamId: row.steam_id,
        loginAt: row.login_at,
        knownIp: latestIp(row.known_ip),
        attrs: JSON.parse(row.attrs || '{}'),
      },
    });
  } catch (e) {
    console.error('admin/user/sync D1 write failed:', e?.message);
    return Response.json({ code: 502, msg: 'D1 写入失败' }, { status: 502 });
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  // Admin 端点：查询用户状态
  if (path.startsWith('/api/admin/user/')) {
    const authErr = checkAdminKey(request, env);
    if (authErr) return authErr;
    const steamId = path.replace('/api/admin/user/', '');
    if (!steamId) {
      return Response.json({ code: 400, msg: '缺少 steamId' }, { status: 400 });
    }
    return getAdminUser(steamId, env);
  }

  if (path === '/api/health') {
    const bridgeUrl = env.BRIDGE_URL || '';
    const steamId = url.searchParams.get('steamId') || '';
    const healthPath = steamId ? '/api/health?steamId=' + steamId : '/api/health';

    let bridgeStatus = { bridge: 'not-configured' };
    if (bridgeUrl) {
      try {
        const resp = await fetch(bridgeUrl + healthPath);
        if (resp.ok) {
          const data = await resp.json();
          bridgeStatus = { bridge: 'ok', rateLimit: data.data && data.data.rateLimit || undefined };
        } else {
          bridgeStatus = { bridge: 'down' };
        }
      } catch (_) {
        bridgeStatus = { bridge: 'down' };
      }
    }

    return Response.json({
      code: 200,
      msg: bridgeStatus.bridge === 'down' ? 'degraded' : 'ok',
      data: Object.assign({ cfFunction: 'ok' }, bridgeStatus),
    }, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  return new Response(JSON.stringify({ code: 404, msg: '未知接口' }), {
    status: 404,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestPost({ request, env }) {
  const cfg = getConfig(env);
  const path = normalizePath(new URL(request.url).pathname);

  let body;
  try { body = await request.json(); } catch (_) {
    return Response.json({ code: 400, msg: '请求格式错误' }, { status: 400 });
  }

  // Admin 端点：回写用户同步信息到 D1
  if (path === '/api/admin/user/sync') {
    const authErr = checkAdminKey(request, env);
    if (authErr) return authErr;
    return handleAdminSync(body, env);
  }

  // ---- 所有指令路径统一转发到桥接 ----

  const bridgeHost = env.SE_HOST || '183.131.51.12';
  const bridgeTcpPort = parseInt(env.BRIDGE_TCP_PORT || '10087', 10);
  const bridgeAuthKey = env.SE_ADMIN_KEY || '';

  if (path === '/api/command/verify') {
    if (!body.steamId || !body.gamePassword) {
      return Response.json({ code: 400, msg: '缺少 steamId 或 gamePassword' }, { status: 400 });
    }
    if (cfg.blacklist.has(String(body.steamId))) {
      return Response.json({ code: 401, msg: '验证失败' }, { status: 401 });
    }
    const banCheck = await checkBanned(body.steamId, env.LOG_DB);
    if (banCheck) return banCheck;
    const result = await tcpToBridge(bridgeHost, bridgeTcpPort, bridgeAuthKey,
      body.steamId, '!info myinfo', body.gamePassword, null, null);
    return Response.json(result, { status: result.code === 200 ? 200 : (result.code > 0 ? result.code : 500) });
  }

  if (path === '/api/command/execute') {
    if (!body.steamId || !body.command || !body.gamePassword) {
      return Response.json({ code: 400, msg: '缺少必要参数' }, { status: 400 });
    }
    if (cfg.blacklist.has(String(body.steamId))) {
      return Response.json({ code: 403, msg: '您的账号已被禁止使用指令执行功能' }, { status: 403 });
    }
    const banCheck2 = await checkBanned(body.steamId, env.LOG_DB);
    if (banCheck2) return banCheck2;

    const userState = await getUserStateForBridge(body.steamId, env);
    const result = await tcpToBridge(bridgeHost, bridgeTcpPort, bridgeAuthKey,
      body.steamId, body.command, body.gamePassword, null, userState);
    return Response.json(result, { status: result.code === 200 ? 200 : (result.code > 0 ? result.code : 500) });
  }

  if (path === '/api/user/sync') {
    if (!body.steamId || !body.gamePassword) {
      return Response.json({ code: 400, msg: '缺少 steamId 或 gamePassword' }, { status: 400 });
    }
    if (cfg.blacklist.has(String(body.steamId))) {
      return Response.json({ code: 401, msg: '验证失败' }, { status: 401 });
    }
    const banCheck = await checkBanned(body.steamId, env.LOG_DB);
    if (banCheck) return banCheck;
    // 桥接处理 TCP 验证 + 回调 CF admin 写 D1
    const result = await tcpToBridge(bridgeHost, bridgeTcpPort, bridgeAuthKey,
      body.steamId, '!info myinfo', body.gamePassword, null, null);
    return Response.json(result, { status: result.code === 200 ? 200 : (result.code > 0 ? result.code : 500) });
  }

  if (path === '/api/grid/world-grids') {
    if (!body.steamId || !body.gamePassword) {
      return Response.json({ code: 400, msg: '缺少 steamId 或 gamePassword' }, { status: 400 });
    }
    if (cfg.blacklist.has(String(body.steamId))) {
      return Response.json({ code: 403, msg: '账号已被禁用' }, { status: 403 });
    }
    const banCheck3 = await checkBanned(body.steamId, env.LOG_DB);
    if (banCheck3) return banCheck3;
    const userState = await getUserStateForBridge(body.steamId, env);
    const result = await tcpToBridge(bridgeHost, bridgeTcpPort, bridgeAuthKey,
      body.steamId, '', body.gamePassword, '/getWorldGridsBySteamId', userState);
    return Response.json(result, { status: result.code === 200 ? 200 : (result.code > 0 ? result.code : 500) });
  }

  return Response.json({ code: 404, msg: '未知接口' }, { status: 404 });
}
