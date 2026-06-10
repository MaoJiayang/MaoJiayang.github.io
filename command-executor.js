/**
 * SE 指令执行模块
 * 提供登录管理、连接检测、执行按钮、结果展示
 *
 * 依赖: SeBridge (se-bridge.js, 共享认证+通信层)
 *       AcModule (command-autocomplete.js, 指令补全)
 * 用法: CmdExec.init({ qInput, remoteBridgeUrl })
 */
var CmdExec = (function () {
  'use strict';

  var _q = null;
  var _gaugeTimer = null;

  // ========== 历史记录 ==========

  var HIST_KEY = 'se_cmd_history';
  var MAX_HIST = 30;
  var _histIdx = -1;
  var _histSaved = '';
  var _histNav = false;

  function pushHistory(cmd) {
    var hist = getHistory();
    if (hist.length > 0 && hist[0] === cmd) return;
    hist.unshift(cmd);
    if (hist.length > MAX_HIST) hist.length = MAX_HIST;
    try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch (_) {}
  }

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch (_) { return []; }
  }

  function clearHistory() {
    try { localStorage.removeItem(HIST_KEY); } catch (_) {}
    _histIdx = -1;
    _histSaved = '';
  }

  // ========== 按钮可见性 ==========

  function canExecute(val) {
    var t = val.trim();
    if (!t) return false;
    if (t.charCodeAt(0) === 0xFF01) t = '!' + t.slice(1);
    if (!t.startsWith('!')) return false;

    var spaceIdx = t.indexOf(' ');
    if (spaceIdx === -1 || spaceIdx === t.length - 1) return false;

    var cmdPrefix = t.slice(0, spaceIdx);
    if (cmdPrefix.length < 2) return false;

    var matches = AcModule.getMatches(cmdPrefix);
    return matches && matches.length > 0;
  }

  function updateExecButton() {
    var btn = document.getElementById('exec-btn');
    if (!btn) return;
    var val = _q ? _q.value : '';
    if (canExecute(val)) {
      btn.classList.add('show');
    } else {
      btn.classList.remove('show');
      btn.classList.remove('executing');
      btn.disabled = false;
    }
  }

  // ========== 执行处理 ==========

  function handleExecute() {
    var val = _q ? _q.value.trim() : '';
    if (!val || !canExecute(val)) return;
    if (val.charCodeAt(0) === 0xFF01) val = '!' + val.slice(1);

    if (!SeBridge.hasCredentials()) {
      showLoginModal();
      return;
    }

    if (SeBridge.isRateLimited()) {
      showToast('error', '每分钟调用次数已用完，请稍后再试');
      return;
    }

    var btn = document.getElementById('exec-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.classList.add('executing');

    SeBridge.executeCommand(val)
      .then(function (result) {
        btn.disabled = false;
        btn.classList.remove('executing');
        updateExecButton();

        if (result.code === 200) {
          SeBridge.trackCall();
          pushHistory(val);
          showToast('success', '指令已发送，请在游戏内查看结果');
        } else if (result.code === 401) {
          showToast('error', '账号或密码错误，请重新登录');
          SeBridge.clearCredentials();
          updateCredLabel();
          updateRateGauge();
          showLoginModal();
        } else if (result.code === 400) {
          showToast('error', result.msg || '指令执行失败');
        } else {
          showToast('error', result.msg || '连接失败，请稍后重试');
        }
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.classList.remove('executing');
        updateExecButton();

        if (err.message === 'NOT_LOGGED_IN') {
          showLoginModal();
        } else if (err.message === 'BRIDGE_DOWN') {
          showToast('error', '连接服务未启动，请先运行 start-local.bat');
        } else {
          showToast('error', '请求失败: ' + err.message);
        }
      });
  }

  // ========== 提示条 ==========

  var _toastTimer = null;

  function showToast(type, message) {
    var el = document.getElementById('exec-result');
    if (!el) return;

    clearTimeout(_toastTimer);
    el.className = type;

    var icon = el.querySelector('.exec-result-icon');
    if (icon) {
      icon.textContent = type === 'success' ? '' : type === 'warning' ? '' : '';
    }

    var body = el.querySelector('.exec-result-body');
    if (body) body.textContent = message;

    el.classList.remove('hide');
    el.classList.add('show');

    _toastTimer = setTimeout(function () {
      el.classList.remove('show');
      el.classList.add('hide');
    }, 4000);
  }

  // ========== 登录弹窗 ==========

  function showLoginModal() {
    var modal = document.getElementById('login-modal');
    if (!modal) return;

    var creds = SeBridge.getCredentials();
    document.getElementById('login-steamid').value = creds ? creds.steamId : '';
    document.getElementById('login-password').value = creds ? creds.gamePassword : '';
    document.getElementById('login-error').classList.add('hide');
    updateClearBtn();
    modal.classList.remove('hide');
    modal.classList.add('show');
    document.getElementById('login-steamid').focus();
  }

  function hideLoginModal() {
    var modal = document.getElementById('login-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.classList.add('hide');
  }

  function updateClearBtn() {
    var btn = document.getElementById('login-clear');
    if (!btn) return;
    // 仅当有 localStorage 持久化凭据时才显示清除按钮
    try {
      var raw = localStorage.getItem('se_credentials');
      if (raw && JSON.parse(raw).steamId) {
        btn.classList.remove('hide');
      } else {
        btn.classList.add('hide');
      }
    } catch (_) {
      btn.classList.add('hide');
    }
  }

  function handleLoginSubmit() {
    var steamId = document.getElementById('login-steamid').value.trim();
    var password = document.getElementById('login-password').value.trim();
    var remember = document.getElementById('login-remember').checked;
    var errEl = document.getElementById('login-error');
    var submitBtn = document.getElementById('login-submit');

    if (!steamId) {
      errEl.textContent = '请输入 SteamID（在游戏中输入 !info myinfo 获取）';
      errEl.classList.remove('hide');
      return;
    }
    if (!password) {
      errEl.textContent = '请输入游戏密码';
      errEl.classList.remove('hide');
      return;
    }

    // 按钮 loading 态
    submitBtn.disabled = true;
    submitBtn.textContent = '正在验证...';

    SeBridge.verifyCredentials(steamId, password)
      .then(function (result) {
        submitBtn.disabled = false;
        submitBtn.textContent = '确认';

        if (result.code === 200) {
          var ok = SeBridge.saveCredentials(steamId, password, remember);
          if (!ok) {
            showToast('warning', '当前浏览器不支持缓存，登录仅本次有效');
            // 仍然允许登录（凭据在内存中）
          }

          hideLoginModal();
          showToast('success', '登录成功');
          updateCredLabel();
          updateRateGauge();
          pollHealth();

          // 异步同步用户到 D1（不阻塞 UI）
          SeBridge.syncUser().catch(function () {});

          if (_pendingExecute) {
            _pendingExecute = false;
            handleExecute();
          }
        } else {
          errEl.textContent = result.msg || '验证失败，请稍后重试';
          errEl.classList.remove('hide');
        }
      })
      .catch(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = '确认';
        errEl.textContent = '连接服务未启动，请先运行 start-local.bat';
        errEl.classList.remove('hide');
      });
  }

  var _pendingExecute = false;

  // ========== 状态栏 ==========

  var _healthTimer = null;

  function updateBridgeLabel(online) {
    var dot = document.getElementById('conn-dot');
    var text = document.getElementById('bridge-label');
    if (!dot || !text) return;
    if (online === true) {
      dot.className = 'conn-dot online';
      if (SeBridge.bridgeUrl && SeBridge.bridgeUrl.indexOf('localhost') === -1) {
        text.textContent = '服务在线(桥接)';
      } else {
        text.textContent = '服务在线(云)';
      }
    } else if (online === false) {
      dot.className = 'conn-dot offline';
      text.textContent = '服务离线';
    } else {
      dot.className = 'conn-dot';
      text.textContent = '检测中';
    }
  }

  function updateCredLabel() {
    var el = document.getElementById('cred-indicator');
    if (!el) return;
    if (SeBridge.hasCredentials()) {
      el.textContent = '已登录';
      el.classList.add('has-creds');
    } else {
      el.textContent = '未登录';
      el.classList.remove('has-creds');
    }
  }

  function updateRateGauge() {
    var el = document.getElementById('rate-gauge');
    if (!el) return;
    if (!SeBridge.hasCredentials()) {
      el.classList.add('hide');
      return;
    }

    var remain = SeBridge.getRemainingCalls();
    var limit = SeBridge.getRateLimit();
    var pct = (remain / limit) * 100;

    var fill = document.getElementById('gauge-fill');
    var text = document.getElementById('rate-text');
    if (fill) {
      fill.style.width = pct + '%';
      fill.className = 'gauge-fill' + (pct <= 20 ? ' low' : pct <= 50 ? ' mid' : '');
    }
    if (text) text.textContent = remain + '/' + limit;

    el.classList.remove('hide');
  }

  function pollHealth() {
    SeBridge.checkBridgeHealth().then(function (result) {
      updateBridgeLabel(result !== null ? result.code === 200 : false);
    });
  }

  function startHealthPolling() {
    pollHealth();
    _healthTimer = setInterval(pollHealth, 30000);
  }

  // ========== 初始化 ==========

  function init(ctx) {
    _q = ctx.qInput;

    // 初始化 SeBridge（桥接地址）
    SeBridge.init({
      bridgeUrl: ctx.remoteBridgeUrl || '',
      onStatusChange: function (st) {
        updateBridgeLabel(st.bridgeOnline);
      },
    });

    _q.addEventListener('input', function () { updateExecButton(); });

    _q.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (canExecute(_q.value)) {
          e.preventDefault();
          handleExecute();
        }
        return;
      }

      if (e.key === 'Enter') {
        var acPanel = document.getElementById('ac-panel');
        if (acPanel && acPanel.classList.contains('show')) return;
        if (canExecute(_q.value)) {
          e.preventDefault();
          handleExecute();
          return;
        }
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        var hist = getHistory();
        if (hist.length === 0) return;
        _histNav = true;
        if (_histIdx === -1) { _histSaved = _q.value; _histIdx = 0; }
        else if (_histIdx < hist.length - 1) { _histIdx++; }
        _q.value = hist[_histIdx];
        _q.dispatchEvent(new Event('input', { bubbles: true }));
        _histNav = false;
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        var hist = getHistory();
        if (_histIdx === -1) return;
        _histNav = true;
        if (_histIdx > 0) { _histIdx--; _q.value = hist[_histIdx]; }
        else { _histIdx = -1; _q.value = _histSaved; }
        _q.dispatchEvent(new Event('input', { bubbles: true }));
        _histNav = false;
        return;
      }
    });

    var execBtn = document.getElementById('exec-btn');
    if (execBtn) {
      execBtn.addEventListener('click', function () {
        if (!SeBridge.hasCredentials()) {
          _pendingExecute = true;
          showLoginModal();
        } else {
          handleExecute();
        }
      });
    }

    var credLabel = document.getElementById('cred-indicator');
    if (credLabel) {
      credLabel.addEventListener('click', function () {
        _pendingExecute = false;
        showLoginModal();
      });
    }

    // 登录弹窗事件
    var modalClose = document.getElementById('modal-close');
    if (modalClose) modalClose.addEventListener('click', hideLoginModal);
    var loginSubmit = document.getElementById('login-submit');
    if (loginSubmit) loginSubmit.addEventListener('click', handleLoginSubmit);
    var loginClear = document.getElementById('login-clear');
    if (loginClear) {
      loginClear.addEventListener('click', function () {
        SeBridge.clearCredentials();
        updateClearBtn();
        updateCredLabel();
        updateRateGauge();
        document.getElementById('login-steamid').value = '';
        document.getElementById('login-password').value = '';
        showToast('success', '已退出登录');
      });
    }
    var modalOverlay = document.getElementById('login-modal');
    if (modalOverlay) {
      modalOverlay.addEventListener('click', function (e) {
        if (e.target === modalOverlay) hideLoginModal();
      });
    }
    var pwdInput = document.getElementById('login-password');
    if (pwdInput) {
      pwdInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') handleLoginSubmit();
      });
    }

    // Toast 关闭
    var resultDismiss = document.querySelector('#exec-result .exec-result-dismiss');
    if (resultDismiss) {
      resultDismiss.addEventListener('click', function () {
        var el = document.getElementById('exec-result');
        if (el) { el.classList.remove('show'); el.classList.add('hide'); }
      });
    }

    updateCredLabel();
    updateRateGauge();

    // 延迟 3 秒启动后台任务
    setTimeout(function () {
      startHealthPolling();
      _gaugeTimer = setInterval(updateRateGauge, 5000);
    }, 3000);
  }

  return {
    init: init,
    canExecute: canExecute,
    getHistory: getHistory,
    pushHistory: pushHistory,
    clearHistory: clearHistory,
    get _histNav() { return _histNav; },
  };
})();
