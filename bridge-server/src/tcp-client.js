/**
 * SE Torch 服务器 TCP 帧协议客户端
 * 协议: 4字节 Big-Endian 长度前缀 + UTF-8 JSON
 *
 * 配置从 ../config.json（桥接私有）读取，有默认值兜底
 */
'use strict';

const net = require('net');

let _config = null;
function loadConfig() {
  if (_config) return _config;
  try {
    _config = require('../config.json');
  } catch (_) {
    _config = {};
  }
  const se = _config.seServer || {};
  _config.seServer = {
    host: se.host || '183.131.51.12',
    port: se.port || 10086,
    authKey: se.authKey || '12345',
    timeout: se.timeout || 15000,
  };
  return _config;
}

function buildFrame(json) {
  const data = Buffer.from(json, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

function readFrame(socket, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SE服务器响应超时'));
    }, timeout);

    let buf = Buffer.alloc(0);

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const length = buf.readInt32BE(0);
        const total = 4 + length;
        if (buf.length >= total) {
          cleanup();
          const jsonStr = buf.subarray(4, total).toString('utf-8');
          resolve(jsonStr);
        }
      }
    }

    function onError(err) { cleanup(); reject(err); }
    function onClose() { cleanup(); reject(new Error('连接已关闭')); }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function connectAndSend(host, port, timeout, requestJson) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(timeout);

    sock.connect(port, host, () => {
      sock.write(buildFrame(requestJson));
      readFrame(sock, timeout)
        .then((json) => {
          sock.destroy();
          resolve(json);
        })
        .catch((err) => {
          sock.destroy();
          reject(err);
        });
    });

    sock.on('error', (err) => {
      sock.destroy();
      reject(new Error('SE服务器连接失败: ' + err.message));
    });

    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error('SE服务器连接超时'));
    });
  });
}

/**
 * 发送指令到 SE 服务器
 * @param {string} steamId 玩家 SteamID
 * @param {string} command 完整指令，如 "!银行 余额"
 * @param {string} gamePassword 游戏密码
 * @returns {{code: number, msg: string, data: object|null}}
 */
/**
 * 归一化 SE 服务器响应格式
 * 兼容旧格式 {success, errorMessage, bodyJson} 和新格式 {code, msg, data}
 */
function normalizeResponse(raw) {
  // 新格式 already standard
  if (raw.code !== undefined) return raw;
  // 旧格式兼容
  if (raw.success === true) {
    var body = raw.bodyJson || '';
    // bodyJson 可能是被 JSON 序列化过的字符串，尝试解析
    try { var parsed = JSON.parse(body); if (typeof parsed === 'string') body = parsed; else body = JSON.stringify(parsed); } catch (_) {}
    return { code: 200, msg: body, data: null };
  }
  if (raw.success === false) {
    return { code: 400, msg: raw.errorMessage || '未知错误', data: null };
  }
  return { code: 500, msg: '无法解析服务器响应', data: null };
}

function sendCommand(steamId, command, gamePassword) {
  const cfg = loadConfig();
  const se = cfg.seServer;

  const innerBody = JSON.stringify({
    steamId: steamId,
    command: command,
    gamePassword: gamePassword,
    forcePlayerOnline: false,
    dontSendToGameScreen: false,
  });

  const requestJson = JSON.stringify({
    path: '/command',
    bodyJson: innerBody,
    authKey: se.authKey,
  });

  return connectAndSend(se.host, se.port, se.timeout, requestJson)
    .then((responseJson) => {
      try {
        var raw = JSON.parse(responseJson);
        return normalizeResponse(raw);
      } catch (_) {
        return { code: 500, msg: '响应解析失败: ' + responseJson.substring(0, 200), data: null };
      }
    })
    .catch((err) => {
      if (err.message.includes('连接失败') || err.message.includes('ECONNREFUSED')) {
        return { code: 503, msg: 'SE服务器连接失败', data: null };
      }
      if (err.message.includes('超时')) {
        return { code: 504, msg: 'SE服务器响应超时', data: null };
      }
      return { code: 500, msg: err.message, data: null };
    });
}

/**
 * 检查 SE 服务器连通性
 * @returns {{reachable: boolean, latencyMs: number}}
 */
function checkConnection() {
  const cfg = loadConfig();
  const se = cfg.seServer;
  const start = Date.now();

  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(5000);

    sock.connect(se.port, se.host, () => {
      const latency = Date.now() - start;
      sock.destroy();
      resolve({ reachable: true, latencyMs: latency });
    });

    sock.on('error', () => {
      sock.destroy();
      resolve({ reachable: false, latencyMs: 0 });
    });

    sock.on('timeout', () => {
      sock.destroy();
      resolve({ reachable: false, latencyMs: 0 });
    });
  });
}

module.exports = { sendCommand, checkConnection };
