/**
 * CF Pages Function: /api/* 统一处理
 *
 * 桥接浏览器请求到 SE Torch 服务器（原始 TCP 帧协议）
 * 协议: 4字节 Big-Endian 长度前缀 + UTF-8 JSON
 *
 * 环境变量（在 CF Dashboard → Pages → Settings → Environment variables 中配置）:
 *   SE_HOST      — SE 服务器地址
 *   SE_PORT      — SE 服务器端口
 *   SE_AUTH_KEY  — 认证密钥
 *   SE_BLACKLIST — 禁止执行指令的 SteamID，逗号分隔，如 "76561199251433037,76561198248299872"
 */
import { connect } from 'cloudflare:sockets';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 1;
const DEFAULT_AUTH_KEY = 'change-me';
const TIMEOUT_MS = 10000;

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
async function tcpRequest(host, port, authKey, steamId, command, password) {
  const innerBody = JSON.stringify({
    steamId,
    command,
    gamePassword: password,
    forcePlayerOnline: false,
    dontSendToGameScreen: false,
  });

  const requestJson = JSON.stringify({
    path: '/command',
    bodyJson: innerBody,
    authKey,
  });

  const socket = connect({ hostname: host, port }, { secureTransport: 'off' });
  const writer = socket.writable.getWriter();
  await writer.write(buildFrame(requestJson));
  writer.releaseLock();

  const responseJson = await readFrame(socket, TIMEOUT_MS);
  socket.close();

  let raw;
  try { raw = JSON.parse(responseJson); } catch (_) {
    return { code: 500, msg: 'SE服务器响应异常', data: null };
  }

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
}

function normalizePath(pathname) {
  return pathname.replace(/\/$/, '') || '/api';
}

export async function onRequestGet({ request }) {
  const path = normalizePath(new URL(request.url).pathname);

  if (path === '/api/health') {
    return Response.json({ code: 200, msg: 'ok', data: { bridge: 'cloudflare' } });
  }

  return Response.json({ code: 404, msg: '未知接口' }, { status: 404 });
}

export async function onRequestPost({ request, env }) {
  const cfg = getConfig(env);
  const path = normalizePath(new URL(request.url).pathname);

  let body;
  try { body = await request.json(); } catch (_) {
    return Response.json({ code: 400, msg: '请求格式错误' }, { status: 400 });
  }

  if (path === '/api/command/verify') {
    if (!body.steamId || !body.gamePassword) {
      return Response.json({ code: 400, msg: '缺少 steamId 或 gamePassword' }, { status: 400 });
    }
    if (cfg.blacklist.has(String(body.steamId))) {
      return Response.json({ code: 401, msg: '验证失败' }, { status: 401 });
    }
    const result = await tcpRequest(cfg.host, cfg.port, cfg.authKey, body.steamId, '!银行 余额', body.gamePassword);
    return Response.json(result);
  }

  if (path === '/api/command/execute') {
    if (!body.steamId || !body.command || !body.gamePassword) {
      return Response.json({ code: 400, msg: '缺少必要参数' }, { status: 400 });
    }
    if (cfg.blacklist.has(String(body.steamId))) {
      return Response.json({ code: 403, msg: '您的账号已被禁止使用指令执行功能' }, { status: 403 });
    }
    const result = await tcpRequest(cfg.host, cfg.port, cfg.authKey, body.steamId, body.command, body.gamePassword);
    return Response.json(result);
  }

  return Response.json({ code: 404, msg: '未知接口' }, { status: 404 });
}
