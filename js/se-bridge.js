/**
 * SE 虚空终端 — 共享认证 & 通信模块
 *
 * 为 commands.html（指令速查表）和 terminal.html（虚空终端）提供：
 *   - 凭据管理（localStorage / sessionStorage）
 *   - 桥接 HTTP 通信（本地桥接 / CF Function 降级）
 *   - 指令执行 + 密码验证
 *   - 用户同步（/api/user/sync → D1）
 *   - 客户端限流（sessionStorage，默认 20次/分钟）
 *
 * 用法:
 *   SeBridge.init({ bridgeUrl: 'http://localhost:3001' });
 *   SeBridge.getCredentials();
 *   SeBridge.executeCommand('!银行 余额');
 *   SeBridge.syncUser(); // 登录成功后调用
 */

var SeBridge = (function () {
  'use strict';

  var CRED_KEY = 'se_credentials';
  var CALL_KEY = 'se_call_times';
  var RATE_LIMIT = 20;          // 默认每分钟调用限制
  var _bridgeUrl = '';
  var _bridgeDown = false;
  var _memCreds = null;
  var _onStatusChange = null;   // 状态变化回调（供 UI 层注册）

  // ========== 凭据管理 ==========

  function loadCredentials() {
    try {
      var raw = localStorage.getItem(CRED_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed.steamId && parsed.gamePassword) return parsed;
      }
    } catch (_) { /* 格式错误 */ }
    return null;
  }

  function saveCredentials(steamId, gamePassword, remember) {
    if (remember) {
      try {
        localStorage.setItem(CRED_KEY, JSON.stringify({ steamId: steamId, gamePassword: gamePassword }));
        _memCreds = null;
        return true;
      } catch (_) {
        return false;
      }
    }
    _memCreds = { steamId: steamId, gamePassword: gamePassword };
    return true;
  }

  function clearCredentials() {
    try { localStorage.removeItem(CRED_KEY); } catch (_) { /* */ }
    try { sessionStorage.removeItem(CALL_KEY); } catch (_) { /* */ }
    _memCreds = null;
  }

  function getCredentials() {
    if (_memCreds) return _memCreds;
    return loadCredentials();
  }

  function hasCredentials() {
    return getCredentials() !== null;
  }

  // ========== 桥接通信 ==========

  function callBridge(method, path, body) {
    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';

    var opts = { method: method, headers: headers };
    if (body) opts.body = JSON.stringify(body);

    return fetch(_bridgeUrl + path, opts)
      .then(function (r) {
        if (!r.ok) throw new Error('BRIDGE_HTTP_' + r.status);
        if (_bridgeDown && _bridgeUrl) {
          _bridgeDown = false;
          if (_onStatusChange) _onStatusChange({ bridgeOnline: true });
        }
        return r.json();
      })
      .catch(function (err) {
        if (err.message && err.message.indexOf('BRIDGE_HTTP_') === 0) throw err;

        // 网络错误 + 远程桥接 → 降级到同域 CF Function
        if (_bridgeUrl && _bridgeUrl.indexOf('localhost') === -1) {
          if (!_bridgeDown) {
            _bridgeDown = true;
            if (_onStatusChange) _onStatusChange({ bridgeOnline: false });
            console.warn('桥接服务不可用，降级到 CF Function');
          }
          var fbOpts = { method: method, headers: {} };
          if (body) { fbOpts.headers['Content-Type'] = 'application/json'; fbOpts.body = JSON.stringify(body); }
          return fetch(path, fbOpts)
            .then(function (r) {
              if (!r.ok) throw new Error('BRIDGE_HTTP_' + r.status);
              return r.json();
            })
            .catch(function () { throw new Error('BRIDGE_DOWN'); });
        }

        throw new Error('BRIDGE_DOWN');
      });
  }

  function verifyCredentials(steamId, password) {
    return callBridge('POST', '/api/command/verify', {
      steamId: steamId,
      gamePassword: password,
    });
  }

  function executeCommand(commandText) {
    var creds = getCredentials();
    if (!creds) return Promise.reject(new Error('NOT_LOGGED_IN'));
    return callBridge('POST', '/api/command/execute', {
      steamId: creds.steamId,
      command: commandText,
      gamePassword: creds.gamePassword,
    });
  }

  function checkBridgeHealth() {
    var url = _bridgeUrl ? _bridgeUrl + '/api/health' : '/api/health';
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ========== 用户同步 ==========

  function syncUser() {
    var creds = getCredentials();
    if (!creds) return Promise.reject(new Error('NOT_LOGGED_IN'));
    return callBridge('POST', '/api/user/sync', {
      steamId: creds.steamId,
      gamePassword: creds.gamePassword,
    });
  }

  // ========== 世界网格 ==========

  /** 获取玩家当前世界中的活跃网格列表（GridVO[]） */
  function getWorldGrids() {
    var creds = getCredentials();
    if (!creds) return Promise.reject(new Error('NOT_LOGGED_IN'));
    return callBridge('POST', '/api/grid/world-grids', {
      steamId: creds.steamId,
      gamePassword: creds.gamePassword,
    }).then(function (r) {
      // API 调用计入限流
      trackCall();
      return r;
    });
  }

  // ========== 客户端限流 ==========

  function loadCallTimes() {
    try {
      var raw = sessionStorage.getItem(CALL_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }

  function saveCallTimes(times) {
    try { sessionStorage.setItem(CALL_KEY, JSON.stringify(times)); } catch (_) { /* */ }
  }

  function purgeCallTimes() {
    var cutoff = Date.now() - 60000;
    var times = loadCallTimes().filter(function (t) { return t > cutoff; });
    saveCallTimes(times);
    return times;
  }

  function isRateLimited() {
    return purgeCallTimes().length >= RATE_LIMIT;
  }

  function trackCall() {
    var times = loadCallTimes();
    times.push(Date.now());
    saveCallTimes(times);
    return times.length;
  }

  function getRemainingCalls() {
    return Math.max(0, RATE_LIMIT - purgeCallTimes().length);
  }

  function getRateLimit() {
    return RATE_LIMIT;
  }

  // ========== 初始化 ==========

  function init(opts) {
    if (opts.bridgeUrl !== undefined) _bridgeUrl = opts.bridgeUrl;
    if (opts.rateLimit !== undefined) RATE_LIMIT = opts.rateLimit;
    if (opts.onStatusChange) _onStatusChange = opts.onStatusChange;

    // HTTPS 页面不能直连 HTTP 桥接（Mixed Content），自动降级
    if (_bridgeUrl && _bridgeUrl.indexOf('http://') === 0 && typeof location !== 'undefined' && location.protocol === 'https:') {
      console.warn('桥接地址为 HTTP，HTTPS 页面无法直连，已降级到 CF Function');
      _bridgeUrl = '';
    }
  }

  // ========== 公开 API ==========

  return {
    init: init,

    // 凭据
    getCredentials: getCredentials,
    hasCredentials: hasCredentials,
    saveCredentials: saveCredentials,
    clearCredentials: clearCredentials,

    // 通信
    callBridge: callBridge,
    verifyCredentials: verifyCredentials,
    executeCommand: executeCommand,
    checkBridgeHealth: checkBridgeHealth,

    // 用户同步
    syncUser: syncUser,

    // 世界网格
    getWorldGrids: getWorldGrids,

    // 限流
    isRateLimited: isRateLimited,
    trackCall: trackCall,
    getRemainingCalls: getRemainingCalls,
    getRateLimit: getRateLimit,

    // 桥接状态（只读）
    get bridgeDown() { return _bridgeDown; },
    get bridgeUrl() { return _bridgeUrl; },
  };
})();
