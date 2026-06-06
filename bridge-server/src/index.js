/**
 * SE 指令桥接服务器
 * 接收浏览器 HTTP 请求，转换为 TCP 帧发往 SE Torch 服务器
 *
 * 启动: node src/index.js
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const tcpClient = require('./tcp-client');

// 启动时生成随机 Token，防止直接调用接口
const API_TOKEN = crypto.randomBytes(16).toString('hex');

let bridgePort = 3001;
try {
  const cfg = require('../../config.json');
  if (cfg.bridgePort) bridgePort = cfg.bridgePort;
} catch (_) { /* 使用默认值 */ }

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5501',
    'http://127.0.0.1:5501',
    'http://localhost:' + bridgePort,
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Token 校验中间件
function requireToken(req, res, next) {
  const auth = req.headers.authorization || '';
  if (auth === 'Bearer ' + API_TOKEN) return next();
  res.status(403).json({ code: 403, msg: '禁止访问', data: null });
}

// 健康检查（无需 Token）
app.get('/api/health', (_req, res) => {
  res.json({ code: 200, msg: 'ok', data: { bridge: 'running' } });
});

// 获取 Token（前端初始化时调用一次）
app.get('/api/token', (_req, res) => {
  res.json({ code: 200, msg: 'ok', data: { token: API_TOKEN } });
});

// 以下接口需要 Token
app.post('/api/command/verify', requireToken, async (req, res) => {
  const { steamId, gamePassword } = req.body || {};
  if (!steamId || !gamePassword) {
    return res.json({ code: 400, msg: '缺少 steamId 或 gamePassword', data: null });
  }
  const result = await tcpClient.sendCommand(steamId, '!银行 余额', gamePassword);
  res.json(result);
});

app.post('/api/command/execute', requireToken, async (req, res) => {
  const { steamId, command, gamePassword } = req.body || {};
  if (!steamId || !command || !gamePassword) {
    return res.json({ code: 400, msg: '缺少必要参数', data: null });
  }
  const result = await tcpClient.sendCommand(steamId, command, gamePassword);
  res.json(result);
});

app.listen(bridgePort, '127.0.0.1', () => {
  console.log('连接服务已启动: http://127.0.0.1:' + bridgePort);
  console.log('Token: ' + API_TOKEN);
  console.log('  GET  /api/token            — 获取访问令牌');
  console.log('  POST /api/command/verify   — 核验账号密码');
  console.log('  POST /api/command/execute  — 执行指令');
  console.log('  GET  /api/health           — 健康检查');
});
