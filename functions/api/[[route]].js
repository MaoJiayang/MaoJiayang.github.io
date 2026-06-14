/**
 * CF Pages Function: /api/* 统一处理
 *
 * 桥接浏览器请求到 SE Torch 服务器（原始 TCP 帧协议）
 * 协议: 4字节 Big-Endian 长度前缀 + UTF-8 JSON
 *
 * 环境变量（在 CF Dashboard → Pages → Settings → Environment variables 中配置）:
 *   SE_HOST       — SE 服务器地址
 *   SE_PORT       — SE 服务器端口
 *   SE_AUTH_KEY   — 认证密钥
 *   SE_BLACKLIST  — 禁止执行指令的 SteamID，逗号分隔，如 "76561199251433037,76561198248299872"
 *   SE_ADMIN_KEY  — (Phase 1 新增) 管理密钥，供 bridge-server 调用 admin 端点
 */
import { connect } from 'cloudflare:sockets';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 1;
const DEFAULT_AUTH_KEY = 'change-me';
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

/** 递归清除所有字符串值中的 Unicode 私有使用区字符（U+E000~U+F8FF） */
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

/** 从 known_ip JSON 数组中取最新 IP */
function latestIp(knownIpJson) {
  try {
    var ips = JSON.parse(knownIpJson || '[]');
    return (Array.isArray(ips) && ips.length > 0) ? ips[0] : '';
  } catch (_) { return ''; }
}

function getConfig(env) {
  return {
    host: env.SE_HOST || DEFAULT_HOST,
    port: parseInt(env.SE_PORT || DEFAULT_PORT, 10),
    authKey: env.SE_AUTH_KEY || DEFAULT_AUTH_KEY,
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

/**
 * 发送 TCP 帧到 SE 服务器，返回归一化后的响应
 */
async function tcpRequest(host, port, authKey, steamId, command, password, customPath) {
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

  let socket;
  try {
    socket = connect({ hostname: host, port }, { secureTransport: 'off' });
    const writer = socket.writable.getWriter();
    await writer.write(buildFrame(requestJson));
    writer.releaseLock();

    const responseJson = await readFrame(socket, TIMEOUT_MS);

    let raw;
    try { raw = JSON.parse(responseJson); } catch (_) {
      return { code: 500, msg: 'SE服务器响应异常', data: null };
    }

    raw = cleanPUA(raw);

    // 归一化响应格式（兼容新旧两种 SE 插件格式）
    if (raw.code !== undefined) return raw;
    if (raw.success === true) {
      let body = raw.bodyJson || '';
      try { const p = JSON.parse(body); body = typeof p === 'string' ? p : JSON.stringify(p); } catch (_) {}
      return { code: 200, msg: body, data: null };
    }
    if (raw.success === false) {
      return { code: 400, msg: raw.errorMessage || '未知错误', data: null };
    }
    return { code: 500, msg: '无法解析响应', data: null };
  } catch (e) {
    return { code: 500, msg: 'TCP 连接失败: ' + (e.message || '未知错误'), data: null };
  } finally {
    if (socket) {
      try { socket.close(); } catch (_) { /* 忽略关闭错误 */ }
    }
  }
}

function normalizePath(pathname) {
  return pathname.replace(/\/$/, '') || '/api';
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

/**
 * /api/user/sync — 验证游戏密码 + 记录/更新用户
 * 入参: { steamId, gamePassword }
 * 返回: { code, msg, data: { steamId, loginAt, knownIp, attrs } }
 */
async function handleUserSync(body, env, cfg, request) {
  if (!body.steamId || !body.gamePassword) {
    return Response.json({ code: 400, msg: '缺少 steamId 或 gamePassword' }, { status: 400 });
  }
  if (cfg.blacklist.has(String(body.steamId))) {
    return Response.json({ code: 401, msg: '验证失败' }, { status: 401 });
  }
  const banCheck = await checkBanned(body.steamId, env.LOG_DB);
  if (banCheck) return banCheck;

  // 通过 SE 服务器验证密码（改用 myinfo 可获得玩家名称）
  const result = await tcpRequest(cfg.host, cfg.port, cfg.authKey, body.steamId, '!info myinfo', body.gamePassword);

  if (result.code !== 200) {
    return Response.json(result);
  }

  // 验证通过 → 写入 D1
  try {
    await ensureUserTable(env.LOG_DB);
    const now = new Date().toISOString();
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const defaultAttrs = JSON.stringify({ rateLimit: 20, banned: false });
    const displayName = (result.data && result.data.displayName) || '';

    // 合并 known_ip 数组：新 IP 插到头部，去重，截 10 条
    const existing = await env.LOG_DB.prepare(
      'SELECT steam_id, attrs, known_ip FROM users WHERE steam_id = ?'
    ).bind(String(body.steamId)).first();

    var mergedIp;
    if (existing) {
      var ips = [];
      try { ips = JSON.parse(existing.known_ip || '[]'); } catch (_) { ips = []; }
      if (!Array.isArray(ips)) ips = [];
      ips = ips.filter(function (v) { return v !== ip; });
      ips.unshift(ip);
      if (ips.length > 10) ips = ips.slice(0, 10);
      mergedIp = JSON.stringify(ips);

      await env.LOG_DB.prepare(
        'UPDATE users SET known_ip = ?, login_at = ? WHERE steam_id = ?'
      ).bind(mergedIp, now, String(body.steamId)).run();
    } else {
      mergedIp = JSON.stringify([ip]);
      await env.LOG_DB.prepare(
        'INSERT INTO users (steam_id, attrs, known_ip, login_at, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(String(body.steamId), defaultAttrs, mergedIp, now, now).run();
    }

    // 读取当前 attrs，检查 displayName 是否需要更新
    if (existing && displayName) {
      const attrs = JSON.parse(existing.attrs || '{}');
      if (attrs.displayName !== displayName) {
        attrs.displayName = displayName;
        await env.LOG_DB.prepare(
          'UPDATE users SET attrs = ? WHERE steam_id = ?'
        ).bind(JSON.stringify(attrs), String(body.steamId)).run();
      }
    }

    // 读取更新后的记录
    const row = await env.LOG_DB.prepare(
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
    console.error('user/sync D1 write failed:', e?.message);
    // D1 写入失败不影响登录，仍然返回成功
    return Response.json({ code: 200, msg: 'ok（用户记录未保存）', data: { steamId: String(body.steamId) } });
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
    return new Response(JSON.stringify({ code: 200, msg: 'ok', data: { bridge: 'cloudflare' } }), {
      headers: {
        'Content-Type': 'application/json',
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

  if (path === '/api/command/verify') {
    if (!body.steamId || !body.gamePassword) {
      return Response.json({ code: 400, msg: '缺少 steamId 或 gamePassword' }, { status: 400 });
    }
    if (cfg.blacklist.has(String(body.steamId))) {
      return Response.json({ code: 401, msg: '验证失败' }, { status: 401 });
    }
    const banCheck = await checkBanned(body.steamId, env.LOG_DB);
    if (banCheck) return banCheck;
    const result = await tcpRequest(cfg.host, cfg.port, cfg.authKey, body.steamId, '!info myinfo', body.gamePassword);
    return Response.json(result);
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
    const result = await tcpRequest(cfg.host, cfg.port, cfg.authKey, body.steamId, body.command, body.gamePassword);
    return Response.json(result);
  }

  if (path === '/api/user/sync') {
    return handleUserSync(body, env, cfg, request);
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
    const result = await tcpRequest(cfg.host, cfg.port, cfg.authKey, body.steamId, '', body.gamePassword, '/getWorldGridsBySteamId');
    // 服务端将 GridVO[] 序列化到 msg 字段，解析为 data
    if (result.code === 200 && result.msg) {
      try {
        const parsed = JSON.parse(result.msg);
        if (Array.isArray(parsed)) {
          result.data = parsed;
        }
      } catch (_) { /* msg 不是 JSON，保持原样 */ }
    }
    return Response.json(result);
  }

  return Response.json({ code: 404, msg: '未知接口' }, { status: 404 });
}
