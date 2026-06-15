/**
 * SE 虚空终端 — 共享认证 & 通信模块
 *
 * 为 commands.html（指令速查表）和 terminal.html（虚空终端）提供：
 *   - 凭据管理（localStorage / sessionStorage）
 *   - 桥接 HTTP 通信（本地桥接 / CF Function 降级）
 *   - 指令执行 + 密码验证
 *   - 用户同步（/api/user/sync → D1）
 *   - 限流显示（配额值从服务端获取，客户端不作强制拦截）
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
  var RATE_LIMIT = 20;          // 默认每分钟调用限制（syncUser 后由服务端覆盖）
  var _rateRemaining = 20;      // 当前窗口剩余次数（由健康检查/响应头更新）
  var _rateResetSeconds = 0;    // 距离窗口重置的秒数
  var _bridgeUrl = '';          // 配置的桥接地址（候选）
  var _activeBridge = null;     // 竞速选出的实际使用的桥接（null=未选, ''=CF）
  var _bridgeDown = false;
  var _memCreds = null;
  var _onStatusChange = null;   // 状态变化回调（供 UI 层注册）
  var _authUrl = '';             // 认证端点（健康竞速候选1），''=同源 CF

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

  /** 向两个候选端点同时发送 health check，选最快的那个 */
  function resolveBridge() {
    if (_activeBridge !== null) return Promise.resolve(_activeBridge);

    console.log('[SeBridge] 桥接竞速中...');
    return new Promise(function (resolve) {
      var done = false;
      function pick(url) {
        if (!done && url !== null) {
          done = true;
          _activeBridge = url;
          console.log('[SeBridge] 竞速结果: ' + (url || 'CF Function'));
          if (_onStatusChange) _onStatusChange({ bridgeOnline: true, activeBridge: url });
          resolve(url);
        }
      }

      // 候选1: CF Function / 认证端点（_authUrl 为空时走同域相对路径）
      fetch((_authUrl || '') + '/api/health')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { pick(d && d.code === 200 ? '' : null); })
        .catch(function () {});

      // 候选2: 桥接服务器（如果配置了）
      if (_bridgeUrl) {
        fetch(_bridgeUrl + '/api/health')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { pick(d && d.code === 200 ? _bridgeUrl : null); })
          .catch(function () { pick(null); });  // 报错 → 直接出局
      }

      // 超时兜底（2 秒后若尚未选定，CF 胜出）
      setTimeout(function () { pick(''); }, 2000);
    });
  }

  function callBridge(method, path, body) {
    // 桥接尚未选定 → 等待竞速完成
    if (_activeBridge === null) {
      return resolveBridge().then(function () {
        return callBridge(method, path, body);
      });
    }

    var url = _activeBridge + path;
    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';

    var opts = { method: method, headers: headers };
    if (body) opts.body = JSON.stringify(body);

    return fetch(url, opts)
      .then(function (r) {
        // 从响应头读取限流信息（bridge-server 在 200/429 响应中均会带）
        var remaining = r.headers.get('X-RateLimit-Remaining');
        var reset = r.headers.get('X-RateLimit-Reset');
        if (remaining !== null) _rateRemaining = parseInt(remaining, 10);
        if (reset !== null) _rateResetSeconds = parseInt(reset, 10);

        return r.json().then(function (data) {
          if (!r.ok) {
            var err = new Error(data.msg || ('HTTP ' + r.status));
            err.httpStatus = r.status;
            throw err;
          }
          if (_bridgeDown && _activeBridge) {
            _bridgeDown = false;
            if (_onStatusChange) _onStatusChange({ bridgeOnline: true });
          }
          return data;
        });
      })
      .catch(function (err) {
        if (err.message && err.message.indexOf('BRIDGE_HTTP_') === 0) throw err;

        // 网络错误 + 非本地桥接 → 降级到同域 CF Function
        if (_activeBridge && _activeBridge.indexOf('localhost') === -1) {
          if (!_bridgeDown) {
            _bridgeDown = true;
            if (_onStatusChange) _onStatusChange({ bridgeOnline: false });
            console.warn('[SeBridge] 桥接不可用，降级到 CF Function');
          }
          var fbOpts = { method: method, headers: {} };
          if (body) { fbOpts.headers['Content-Type'] = 'application/json'; fbOpts.body = JSON.stringify(body); }
          return fetch(path, fbOpts)
            .then(function (r) {
              var remaining = r.headers.get('X-RateLimit-Remaining');
              var reset = r.headers.get('X-RateLimit-Reset');
              if (remaining !== null) _rateRemaining = parseInt(remaining, 10);
              if (reset !== null) _rateResetSeconds = parseInt(reset, 10);
              return r.json().then(function (data) {
                if (!r.ok) {
                  var err = new Error(data.msg || ('HTTP ' + r.status));
                  err.httpStatus = r.status;
                  throw err;
                }
                return data;
              });
            })
            .catch(function (e) { if (e.httpStatus) throw e; throw new Error('BRIDGE_DOWN'); });
        }

        throw new Error('BRIDGE_DOWN');
      });
  }

  /** 认证请求，与指令请求走同一个竞速选出的桥接 */
  function callAuth(method, path, body) {
    if (_activeBridge === null) {
      return resolveBridge().then(function () {
        return callAuth(method, path, body);
      });
    }
    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    var opts = { method: method, headers: headers };
    if (body) opts.body = JSON.stringify(body);
    return fetch(_activeBridge + path, opts).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) {
          var err = new Error(data.msg || ('HTTP ' + r.status));
          err.httpStatus = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  function verifyCredentials(steamId, password) {
    return callAuth('POST', '/api/command/verify', {
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

  /**
   * 桥接健康检查，同时更新用户配额状态。
   * @param {string} [steamId] - 可选，传入则查询该用户的限流配额
   */
  function checkBridgeHealth(steamId) {
    var base = _activeBridge !== null ? _activeBridge : '';
    var healthUrl = base + '/api/health';
    if (steamId) healthUrl += '?steamId=' + encodeURIComponent(steamId);
    return fetch(healthUrl)
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (data) {
        if (data && data.data && data.data.rateLimit) {
          var rl = data.data.rateLimit;
          _rateRemaining = rl.remaining;
          _rateResetSeconds = rl.resetSeconds;
          if (rl.limit) RATE_LIMIT = rl.limit;
        }
        return data;
      })
      .catch(function () { return null; });
  }

  // ========== 用户同步 ==========

  function syncUser() {
    var creds = getCredentials();
    if (!creds) return Promise.reject(new Error('NOT_LOGGED_IN'));
    return callAuth('POST', '/api/user/sync', {
      steamId: creds.steamId,
      gamePassword: creds.gamePassword,
    }).then(function (r) {
      // 同步服务端返回的限流配额
      if (r.data && r.data.attrs && typeof r.data.attrs.rateLimit === 'number') {
        RATE_LIMIT = r.data.attrs.rateLimit;
        _rateRemaining = Math.max(0, RATE_LIMIT - 1); // 同步刚消耗了一次
      }
      return r;
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
    });
  }

  // ========== 客户端限流显示（服务端强制，客户端仅展示） ==========

  /** @deprecated 服务端强制执行限流，客户端不再拦截，始终返回 false */
  function isRateLimited() {
    return false;
  }

  /** @deprecated 服务端计数，客户端不再需要 */
  function trackCall() {
    // no-op
  }

  function getRemainingCalls() {
    return _rateRemaining;
  }

  function getResetSeconds() {
    return _rateResetSeconds;
  }

  function getRateLimit() {
    return RATE_LIMIT;
  }

  function setRateLimit(n) {
    if (typeof n === 'number' && n > 0) RATE_LIMIT = n;
  }

  /** 手动更新限流状态（供 UI 层在特殊场景下使用） */
  function updateRateState(remaining, limit, resetSeconds) {
    if (typeof remaining === 'number') _rateRemaining = remaining;
    if (typeof limit === 'number') RATE_LIMIT = limit;
    if (typeof resetSeconds === 'number') _rateResetSeconds = resetSeconds;
  }

  // ========== 初始化 ==========

  function init(opts) {
    // 桥接地址：显式指定 > URL参数 > 本地自动检测 > 同域 CF Function
    if (opts.bridgeUrl) {
      _bridgeUrl = opts.bridgeUrl;
    } else if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      var qs = new URLSearchParams(location.search);
      _bridgeUrl = 'http://localhost:' + (qs.get('bridge-port') || '24007');
      console.log('[SeBridge] 本地环境，自动桥接至 ' + _bridgeUrl);
    }
    // 否则 _bridgeUrl 保持 ''（走同域 CF Function）

    // 认证端点：显式指定 > 本地自动检测（指回 CF Pages） > 同域
    if (opts.authUrl) {
      _authUrl = opts.authUrl;
    } else if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      _authUrl = 'https://atomickitty17th.pages.dev';
      console.log('[SeBridge] 本地环境，认证走 ' + _authUrl);
    }
    // 否则 _authUrl 保持 ''（同域 CF）

    if (opts.rateLimit !== undefined) RATE_LIMIT = opts.rateLimit;
    _rateRemaining = RATE_LIMIT;
    if (opts.onStatusChange) _onStatusChange = opts.onStatusChange;

    // HTTPS 页面不能直连 HTTP 桥接（Mixed Content），自动降级
    if (_bridgeUrl && _bridgeUrl.indexOf('http://') === 0 && typeof location !== 'undefined' && location.protocol === 'https:') {
      console.warn('[SeBridge] 桥接地址为 HTTP，HTTPS 页面无法直连，已降级到 CF Function');
      _bridgeUrl = '';
    }

    // 预热：有桥接候选时后台竞速 health check，无候选直连 CF
    if (_bridgeUrl) {
      resolveBridge();
    } else {
      _activeBridge = '';
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

    // 限流（服务端强制，客户端仅展示）
    isRateLimited: isRateLimited,
    trackCall: trackCall,
    getRemainingCalls: getRemainingCalls,
    getResetSeconds: getResetSeconds,
    getRateLimit: getRateLimit,
    setRateLimit: setRateLimit,
    updateRateState: updateRateState,

    // 桥接状态（只读）
    get bridgeDown() { return _bridgeDown; },
    get bridgeUrl() { return _bridgeUrl; },
    get activeBridge() { return _activeBridge; },
    get authUrl() { return _authUrl; },
  };
})();
