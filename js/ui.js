/**
 * UI Kit — 伊卡洛斯虚空终端共享 UI 模块
 * Toast / Modal / BottomSheet / Tabs / Swipe / Topbar
 * 依赖: SeBridge（全局）
 */
var UI = (function () {
  'use strict';

  var TAB_ORDER = ['warehouse','trade','shipyard','hangar','settings'];
  var currentTab = 'warehouse';
  var _tabCallbacks = {};
  var toastTimer = null;

  // ========== Toast ==========

  function showToast(type, msg) {
    var el = document.getElementById('toast');
    clearTimeout(toastTimer);
    el.className = type + ' show';
    document.getElementById('toast-body').textContent = msg;
    toastTimer = setTimeout(hideToast, 3500);
  }

  function hideToast() {
    var el = document.getElementById('toast');
    el.classList.remove('show');
  }

  // ========== Topbar 状态 ==========

  function setConnDot(state) {
    var dot = document.getElementById('conn-dot');
    dot.className = 'conn-dot' + (state ? ' ' + state : '');
    dot.title = state === 'online' ? '服务在线' : state === 'offline' ? '服务离线' : '检测中';
  }

  function pollHealth() {
    SeBridge.checkBridgeHealth().then(function(r){
      setConnDot(r !== null && r.code === 200 ? 'online' : 'offline');
    }).catch(function(){
      setConnDot('offline');
    });
  }

  function updateGauge() {
    var bar = document.getElementById('gauge-bar');
    if (!SeBridge.hasCredentials()) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'inline-block';
    var remain = SeBridge.getRemainingCalls();
    var limit = SeBridge.getRateLimit();
    var pct = (remain / limit) * 100;
    var fill = document.getElementById('gauge-fill');
    fill.style.width = pct + '%';
    fill.className = 'gauge-fill' + (pct <= 20 ? ' low' : pct <= 50 ? ' mid' : '');
  }

  function updateUserBadge() {
    var el = document.getElementById('user-badge');
    if (SeBridge.hasCredentials()) {
      el.textContent = '已连接';
      el.classList.add('logged-in');
    } else {
      el.textContent = '未登录';
      el.classList.remove('logged-in');
    }
    updateGauge();
  }

  function handleUserBadgeClick() {
    if (SeBridge.hasCredentials()) {
      document.getElementById('dc-overlay').classList.add('show');
    } else {
      showLoginGuide();
    }
  }

  // ========== 全屏切换 ==========

  function toggleFullscreen() {
    // 点过全屏后隐藏气泡
    var bubble = document.getElementById('fs-bubble');
    if (bubble) bubble.classList.remove('show');
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    } else {
      document.exitFullscreen();
    }
  }

  function showFsBubble() {
    var bubble = document.getElementById('fs-bubble');
    if (!bubble) return;
    bubble.classList.add('show');
    setTimeout(function () { bubble.classList.remove('show'); }, 5000);
  }

  // ========== 断开确认弹窗 ==========

  function closeDcDialog() {
    document.getElementById('dc-overlay').classList.remove('show');
  }

  function confirmDisconnect() {
    closeDcDialog();
    SeBridge.clearCredentials();
    updateUserBadge();
    showLoginGuide();
    showToast('success', '已断开连接');
  }

  // ========== 指令确认弹窗 ==========

  var _cfOnConfirm = null;

  function showConfirmDialog(msg, onConfirm) {
    document.getElementById('cf-msg').textContent = msg;
    _cfOnConfirm = onConfirm;
    document.getElementById('cf-overlay').classList.add('show');
  }

  function hideConfirmDialog() {
    document.getElementById('cf-overlay').classList.remove('show');
    _cfOnConfirm = null;
  }

  // ========== 登录引导 ==========

  function showLoginGuide() {
    document.getElementById('login-guide').style.display = 'flex';
    document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
    document.getElementById('tabbar').style.display = 'none';
    document.getElementById('wh-bar').style.display = 'none';
  }

  function hideLoginGuide() {
    document.getElementById('login-guide').style.display = 'none';
    document.getElementById('tabbar').style.display = 'flex';
  }

  function showLoginErr(msg) {
    var el = document.getElementById('lg-err');
    el.textContent = msg;
    el.classList.add('show');
  }

  function onLoginSuccess() {
    hideLoginGuide();
    updateUserBadge();
    updateGauge();
    document.getElementById('wh-bar').style.display = '';
    fireTabCallback(currentTab);
    showToast('success', '已连接至伊卡洛斯星服务器');

    // 首次登录引导全屏
    if (!localStorage.getItem('fs_guide_shown')) {
      setTimeout(function () {
        showToast('info', '⚙ 设置 → 全屏模式，沉浸体验虚空终端');
      }, 3000);
      localStorage.setItem('fs_guide_shown', '1');
    }
  }

  // ========== Tab 系统 ==========

  function switchTab(tab) {
    var sameTab = tab === currentTab;
    currentTab = tab;
    document.querySelectorAll('#sidebar .sitem').forEach(function(s){
      s.classList.toggle('active', s.dataset.tab === tab);
    });
    document.querySelectorAll('#tabbar .tab').forEach(function(t){
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    var switching = !sameTab || !document.querySelector('.tab-panel.active');
    if (switching) {
      document.querySelectorAll('.tab-panel').forEach(function(p){
        p.classList.remove('active');
      });
      var panel = document.getElementById('panel-' + tab);
      if (panel) panel.classList.add('active');
    }
    updateTabDots();
    if (!sameTab) fireTabCallback(tab);
  }

  function updateTabDots() {
    var dots = document.getElementById('tab-dots');
    if (!dots) return;
    var html = '';
    TAB_ORDER.forEach(function(t){
      html += '<span class="dot' + (t === currentTab ? ' active' : '') + '"></span>';
    });
    dots.innerHTML = html;
  }

  function onTabChange(tab, fn) {
    _tabCallbacks[tab] = fn;
  }

  function fireTabCallback(tab) {
    if (_tabCallbacks[tab]) _tabCallbacks[tab]();
  }

  function getCurrentTab() { return currentTab; }

  // ========== 滑动切换 ==========

  function initSwipe(container) {
    var startX = 0, startY = 0, swiping = false;

    container.addEventListener('touchstart', function(e){
      if (e.target.closest('#qsheet-overlay') || e.target.closest('#dc-overlay') || e.target.closest('#cf-overlay') || e.target.closest('#tradesheet-overlay')) return;
      if (e.target.closest('.wh-grid') || e.target.closest('.wh-cat-body') ||
          e.target.closest('.sem-card-body') || e.target.closest('.ac-card-body') ||
          e.target.closest('.hist-card-body')) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = true;
    }, { passive: true });

    container.addEventListener('touchend', function(e){
      if (!swiping) return;
      swiping = false;
      var dx = (e.changedTouches[0] || e.touches[0]).clientX - startX;
      var dy = (e.changedTouches[0] || e.touches[0]).clientY - startY;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
      var idx = TAB_ORDER.indexOf(currentTab);
      if (dx < 0 && idx < TAB_ORDER.length - 1) switchTab(TAB_ORDER[idx + 1]);
      else if (dx > 0 && idx > 0) switchTab(TAB_ORDER[idx - 1]);
    });
  }

  // ========== 数量输入 Bottom Sheet ==========

  var qsheetMode = 'deposit';
  var qsheetItem = '';
  var qsheetStock = 0;
  var qsheetQty = 100;
  var _qsheetOnConfirm = null;

  // extraField 扩展（市场订单单价等）
  var qsheetExtra = null;       // { label, value, suffix, step, max }
  var qsheetExtraVal = 0;
  var _lockQty = 0;            // >0 表示数量锁定
  var _lockExtra = false;      // 单价锁定
  var _noCap = false;          // 数量无上限（服营商店买入等）
  var _maxQty = 0;             // >0 表示数量上限（市场拆单用）

  /**
   * openQSheet(mode, itemName, stock, onConfirm)        ← 仓库用法（向后兼容）
   * openQSheet(mode, itemName, options)                  ← 市场用法
   *   options: { stock, lockQty, extraField: { label, value, suffix, step, min, max }, onConfirm }
   */
  function openQSheet(mode, itemName, stockOrOptions, onConfirm) {
    qsheetMode = mode;
    qsheetItem = itemName;
    _qtyTap.count = 0; _qtyTap.last = 0;
    _extraTap.count = 0; _extraTap.last = 0;

    // 判断 overload：第三个参数是对象则为 options 模式
    var isOptions = typeof stockOrOptions === 'object' && stockOrOptions !== null;
    var options = isOptions ? stockOrOptions : { stock: stockOrOptions || 0, onConfirm: onConfirm };

    qsheetStock = options.stock || 0;
    _lockQty = options.lockQty || 0;
    _lockExtra = options.lockExtra === true;
    _noCap = options.noCap === true;
    qsheetQty = _lockQty > 0 ? _lockQty : 100;
    _qsheetOnConfirm = options.onConfirm || null;
    qsheetExtra = options.extraField || null;
    qsheetExtraVal = qsheetExtra ? qsheetExtra.value : 0;
    var depositing = mode === 'deposit';
    // 锁定数量（不可拆分）或以存量/无限量限制
    var maxWithdraw = getMaxWithdraw();
    if (qsheetQty > maxWithdraw) qsheetQty = maxWithdraw;
    if (qsheetQty < 1) qsheetQty = 1;
    document.getElementById('qs-item').textContent = itemName;
    if (_lockQty > 0) {
      document.getElementById('qs-stock').textContent = '数量不可拆分';
    } else if (qsheetExtra) {
      document.getElementById('qs-stock').textContent = '';
    } else {
      document.getElementById('qs-stock').textContent = '库存 ' + fmtCompact(qsheetStock);
    }
    document.getElementById('qs-qty').value = fmtCompact(qsheetQty);

    // extra field
    var extraEl = document.getElementById('qs-extra');
    var confirmBtn = document.getElementById('qs-confirm');
    if (qsheetExtra) {
      extraEl.style.display = 'block';
      document.getElementById('qs-extra-label').textContent = qsheetExtra.label;
      document.getElementById('qs-extra-val').value = fmtCompact(qsheetExtraVal);
      confirmBtn.textContent = qsheetExtra.confirmLabel || (qsheetMode === 'buy' ? '确认购买' : '确认出售');
    } else {
      extraEl.style.display = 'none';
      var label;
      if (qsheetMode === 'deposit') label = '确认存入 ';
      else if (qsheetMode === 'withdraw') label = '确认取出 ';
      else if (qsheetMode === 'buy') label = '确认购买 ';
      else label = '确认出售 ';
      confirmBtn.textContent = label + fmtCompact(qsheetQty);
    }

    document.getElementById('qsheet-overlay').classList.add('show');
    updateQSheetTabs();
    updateQSheetBtns();
    updateExtraDisplay();
  }

  function closeQSheet() {
    document.getElementById('qsheet-overlay').classList.remove('show');
    clearTimeout(_qtyTap.timer);
    clearTimeout(_extraTap.timer);
    qsheetExtra = null;
  }

  // ========== KMB 格式 & 步长 ==========

  /** 纯文本 KMB（图表标签、输入框等不渲染 HTML 的场景） */
  function fmtCompact(n) {
    if (n == null || isNaN(n)) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'k';
    return Number(n).toLocaleString();
  }

  /** HTML 彩色 KMB（物品数量、余额等展示区）。后缀 k=翠绿 M=金 B=紫 */
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '0';
    if (typeof n === 'object' && n.toString) n = parseFloat(n.toString());
    if (isNaN(n)) return '0';
    if (n >= 1e9) { var v = (n / 1e9).toFixed(2).replace(/\.?0+$/, ''); return v + '<span class="num-sfx num-b">B</span>'; }
    if (n >= 1e6) { var v = (n / 1e6).toFixed(2).replace(/\.?0+$/, ''); return v + '<span class="num-sfx num-m">M</span>'; }
    if (n >= 1e3) { var v = (n / 1e3).toFixed(2).replace(/\.?0+$/, ''); return v + '<span class="num-sfx num-k">k</span>'; }
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  /** 完整逗号分隔数字（价格专用，不用 KMB） */
  function fmtPrice(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString();
  }

  function parseCompact(s) {
    s = String(s).trim().toUpperCase();
    var m = s.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!m) return NaN;
    var v = parseFloat(m[1]);
    var u = (m[2] || '').replace(/\s/g, '');
    if (u === 'B') v *= 1e9;
    else if (u === 'M') v *= 1e6;
    else if (u === 'K') v *= 1e3;
    return Math.round(v);
  }

  /** 根据数值量级返回步长：≥1B→1B, ≥1M→1M, ≥1K→1K, 否则→1 */
  function getMagStep(v) {
    if (v >= 1e9) return 1e9;
    if (v >= 1e6) return 1e6;
    if (v >= 1e3) return 1e3;
    return 1;
  }

  /** 当前 QSheet 数量上限（统一入口，避免各处重复计算时遗漏 noCap） */
  function getMaxWithdraw() {
    if (_lockQty > 0) return _lockQty;
    if (_noCap || qsheetExtra) return Infinity;
    if (qsheetMode === 'deposit') return Infinity;
    return qsheetStock;
  }

  // ========== 显示更新 ==========

  function updateQSheetDisplay() {
    var input = document.getElementById('qs-qty');
    if (document.activeElement !== input) {
      input.value = fmtCompact(qsheetQty);
    }
    if (!qsheetExtra) {
      var label;
      if (qsheetMode === 'deposit') label = '确认存入 ';
      else if (qsheetMode === 'withdraw') label = '确认取出 ';
      else if (qsheetMode === 'buy') label = '确认购买 ';
      else label = '确认出售 ';
      document.getElementById('qs-confirm').textContent = label + fmtCompact(qsheetQty);
    }
    updateQSheetBtns();
    if (qsheetExtra) updateExtraDisplay();
  }

  function updateExtraDisplay() {
    if (!qsheetExtra) return;
    var input = document.getElementById('qs-extra-val');
    if (document.activeElement !== input) {
      input.value = fmtCompact(qsheetExtraVal);
    }
    var total = qsheetQty * qsheetExtraVal;
    var el = document.getElementById('qs-extra-total');
    if (total > 0) el.textContent = '总价 ' + fmtCompact(total) + ' ' + (qsheetExtra.suffix || 'SC');
    else el.textContent = '';
    updateExtraBtns();
  }

  // ========== 输入焦点切换 ==========

  function onQtyFocus() {
    var input = document.getElementById('qs-qty');
    input.value = qsheetQty;
    fitFontSize(input);
  }
  function onQtyBlur() {
    var input = document.getElementById('qs-qty');
    input.value = fmtCompact(qsheetQty);
    input.style.fontSize = '';
  }
  function onExtraFocus() {
    var input = document.getElementById('qs-extra-val');
    input.value = qsheetExtraVal;
    fitFontSize(input);
  }
  function onExtraBlur() {
    var input = document.getElementById('qs-extra-val');
    input.value = fmtCompact(qsheetExtraVal);
    input.style.fontSize = '';
  }

  function updateExtraBtns() {
    var min = qsheetExtra && qsheetExtra.min != null ? qsheetExtra.min : 0;
    var max = qsheetExtra && qsheetExtra.max ? qsheetExtra.max : 999999;
    if (_lockExtra) {
      document.getElementById('qs-extra-minus').disabled = true;
      document.getElementById('qs-extra-minus-fast').disabled = true;
      document.getElementById('qs-extra-plus').disabled = true;
      document.getElementById('qs-extra-plus-fast').disabled = true;
      document.getElementById('qs-extra-val').readOnly = true;
      return;
    }
    document.getElementById('qs-extra-val').readOnly = false;
    document.getElementById('qs-extra-minus').disabled = qsheetExtraVal <= min;
    document.getElementById('qs-extra-minus-fast').disabled = qsheetExtraVal <= min;
    document.getElementById('qs-extra-plus').disabled = qsheetExtraVal >= max;
    document.getElementById('qs-extra-plus-fast').disabled = qsheetExtraVal >= max;
  }

  function onExtraInput() {
    if (_lockExtra) return;
    var input = document.getElementById('qs-extra-val');
    input.value = input.value.replace(/[^\d.kKmMbB]/g, '');
    fitFontSize(input);
    var v = parseCompact(input.value);
    if (isNaN(v)) v = 0;
    var min = qsheetExtra && qsheetExtra.min != null ? qsheetExtra.min : 0;
    var max = qsheetExtra && qsheetExtra.max ? qsheetExtra.max : 999999;
    qsheetExtraVal = Math.max(min, Math.min(max, v));
    _extraTap.count = 0;
    updateExtraDisplay();
  }

  function adjustExtra(delta) {
    if (_lockExtra) return;
    var step = getDirStep(qsheetExtraVal, delta);
    if (Math.abs(delta) < step) delta = delta > 0 ? step : -step;
    var min = qsheetExtra && qsheetExtra.min != null ? qsheetExtra.min : 0;
    var max = qsheetExtra && qsheetExtra.max ? qsheetExtra.max : 999999;
    qsheetExtraVal = Math.max(min, Math.min(max, qsheetExtraVal + delta));
    updateExtraDisplay();
  }

  function fastAdjustExtra(deltaDir) {
    if (_lockExtra) return;
    var step = fastStep(qsheetExtraVal, deltaDir, _extraTap);
    adjustExtra(deltaDir * step);
  }

  function updateQSheetTabs() {
    var tabsEl = document.getElementById('qs-tabs');
    var tabDep = document.getElementById('qs-tab-deposit');
    var tabWdr = document.getElementById('qs-tab-withdraw');
    // 非仓库模式（商店/市场）隐藏存入/取出 tabs
    if (qsheetMode === 'buy' || qsheetMode === 'sell') {
      tabsEl.style.display = 'none';
      return;
    }
    tabsEl.style.display = '';
    tabDep.classList.toggle('active', qsheetMode === 'deposit');
    tabWdr.classList.toggle('active', qsheetMode === 'withdraw');
    tabWdr.disabled = qsheetStock === 0;
  }

  function updateQSheetBtns() {
    if (_lockQty > 0) {
      document.getElementById('qs-minus').disabled = true;
      document.getElementById('qs-minus-fast').disabled = true;
      document.getElementById('qs-plus').disabled = true;
      document.getElementById('qs-plus-fast').disabled = true;
      document.getElementById('qs-qty').readOnly = true;
      return;
    }
    document.getElementById('qs-qty').readOnly = false;
    var maxWithdraw = getMaxWithdraw();
    var stepDown = getDirStep(qsheetQty, -1);
    var stepUp = getDirStep(qsheetQty, 1);
    document.getElementById('qs-minus').disabled = qsheetQty <= 1;
    document.getElementById('qs-minus-fast').disabled = qsheetQty <= 1;
    document.getElementById('qs-plus').disabled = qsheetQty + stepUp > maxWithdraw;
    document.getElementById('qs-plus-fast').disabled = qsheetQty + stepUp > maxWithdraw;
  }

  function fitFontSize(input) {
    var len = input.value.length;
    if (len <= 7) input.style.fontSize = '';
    else if (len <= 9) input.style.fontSize = '14px';
    else if (len <= 12) input.style.fontSize = '12px';
    else input.style.fontSize = '10px';
  }

  function onQtyInput() {
    if (_lockQty > 0) return;
    var input = document.getElementById('qs-qty');
    // 过滤非法字符（只允许数字、小数点、K/M/B）
    input.value = input.value.replace(/[^\d.kKmMbB]/g, '');
    fitFontSize(input);
    var v = parseCompact(input.value);
    if (isNaN(v) || v < 1) v = 1;
    qsheetQty = Math.max(1, Math.min(getMaxWithdraw(), v));
    _qtyTap.count = 0;
    updateQSheetDisplay();
  }

  function adjustQty(delta) {
    if (_lockQty > 0) return;
    var step = getDirStep(qsheetQty, delta);
    if (Math.abs(delta) < step) delta = delta > 0 ? step : -step;
    qsheetQty = Math.max(1, Math.min(getMaxWithdraw(), qsheetQty + delta));
    updateQSheetDisplay();
  }

  /** 通用步长：上行用当前量级，下行用低一级量级（允许跨边界） */
  function getDirStep(val, dir) {
    if (dir < 0) val = Math.max(0, val - 1);
    return getMagStep(val);
  }

  /** 通用快速步进：tapState = { count, last, timer }，dir >0 上行 <0 下行 */
  function fastStep(currentVal, dir, tapState) {
    var now = Date.now();
    if (tapState.last && now - tapState.last < 600) {
      tapState.count++;
    } else {
      tapState.count = 0;
    }
    tapState.last = now;
    var step = getDirStep(currentVal, dir) * (tapState.count + 1);
    clearTimeout(tapState.timer);
    tapState.timer = setTimeout(function(){ tapState.count = 0; tapState.last = 0; }, 600);
    return step;
  }

  var _qtyTap = { count: 0, last: 0, timer: null };
  var _extraTap = { count: 0, last: 0, timer: null };

  function fastAdjust(deltaDir) {
    if (_lockQty > 0) return;
    var step = fastStep(qsheetQty, deltaDir, _qtyTap);
    adjustQty(deltaDir * step);
  }

  function switchQSheetMode(mode) {
    if (mode === qsheetMode) return;
    // 非仓库模式不允许切换
    if (qsheetMode !== 'deposit' && qsheetMode !== 'withdraw') return;
    if (mode === 'withdraw' && qsheetStock === 0) return;
    qsheetMode = mode;
    qsheetQty = 100;
    var maxWithdraw = mode === 'deposit' ? Infinity : qsheetStock;
    if (qsheetQty > maxWithdraw) qsheetQty = maxWithdraw;
    if (qsheetQty < 1) qsheetQty = 1;
    _qtyTap.count = 0;
    updateQSheetTabs();
    updateQSheetDisplay();
  }

  function confirmQSheet() {
    if (qsheetQty < 1) qsheetQty = 1;
    // 保存状态——closeQSheet 会清空 qsheetExtra
    var extra = qsheetExtra;
    var extraVal = qsheetExtraVal;
    if (extra && extraVal < (extra.min != null ? extra.min : 0)) extraVal = (extra.min != null ? extra.min : 0);
    closeQSheet();
    if (_qsheetOnConfirm) {
      if (extra) {
        // 市场：传 mode + qty + extraVal
        _qsheetOnConfirm(qsheetMode, qsheetQty, extraVal);
      } else if (qsheetMode === 'buy' || qsheetMode === 'sell') {
        // 商店买入/卖出：传 mode + qty
        _qsheetOnConfirm(qsheetMode, qsheetQty);
      } else {
        // 仓库存入/取出：传完整指令
        var cmd = qsheetMode === 'deposit'
          ? '!仓库 存入 ' + qsheetItem + ' ' + qsheetQty
          : '!仓库 取出 ' + qsheetItem + ' ' + qsheetQty;
        var label = qsheetMode === 'deposit' ? '存入' : '取出';
        _qsheetOnConfirm(cmd, label);
      }
    }
  }

  // ========== 统一指令执行（含二次确认） ==========

  /**
   * 执行一条指令，自动处理二次确认弹窗。船厂/船坞等后续面板共用此入口。
   * @param {string} cmd - 完整指令文本
   * @param {string|null} okLabel - 成功时的 Toast 文案（null 表示静默）
   * @returns {Promise} resolve(r.data) | reject('RATE_LIMITED' | msg)
   */
  function executeWithConfirm(cmd, okLabel) {
    if (SeBridge.isRateLimited()) {
      UI.showToast('error', '指令调用已达上限，' + SeBridge.getResetSeconds() + ' 秒后恢复');
      return Promise.reject('RATE_LIMITED');
    }
    return SeBridge.executeCommand(cmd).then(function (r) {
      SeBridge.trackCall();
      UI.updateGauge();
      if (r.msg && /(?:重复输入|再次输入).*(?:确认|指令)/.test(r.msg)) {
        return new Promise(function (resolve, reject) {
          UI.showConfirmDialog(r.msg, function () {
            if (SeBridge.isRateLimited()) {
              UI.showToast('error', '指令调用已达上限，' + SeBridge.getResetSeconds() + ' 秒后恢复');
              reject('RATE_LIMITED');
              return;
            }
            SeBridge.executeCommand(cmd).then(function (r2) {
              SeBridge.trackCall();
              UI.updateGauge();
              if (r2.code === 200) {
                if (okLabel) UI.showToast('success', r2.msg || okLabel);
                resolve(r2.data);
              } else {
                UI.showToast('error', r2.msg || '操作失败');
                reject(r2.msg);
              }
            }).catch(reject);
          });
        });
      }
      if (r.code === 200) {
        if (okLabel) UI.showToast('success', r.msg || okLabel);
        return r.data;
      }
      UI.showToast('error', r.msg || '指令执行失败');
      return Promise.reject(r.msg);
    });
  }

  // ========== 初始化 ==========

  // ========== 登录流程 ==========

  function handleLogin() {
    var steamId = document.getElementById('lg-steamid').value.trim();
    var pwd = document.getElementById('lg-pwd').value.trim();
    var remember = document.getElementById('lg-remember').checked;
    var btn = document.getElementById('lg-submit');

    if (!steamId) { showLoginErr('请输入 SteamID'); return; }
    if (!pwd) { showLoginErr('请输入游戏密码'); return; }

    btn.disabled = true;
    btn.textContent = '正在验证…';
    var errEl = document.getElementById('lg-err');
    errEl.classList.remove('show');

    SeBridge.verifyCredentials(steamId, pwd).then(function(r){
      btn.disabled = false;
      btn.textContent = '连接服务器';
      if (r.code === 200) {
        SeBridge.saveCredentials(steamId, pwd, remember);
        SeBridge.syncUser().catch(function(){});
        onLoginSuccess();
      } else {
        showLoginErr(r.msg || '验证失败');
      }
    }).catch(function(){
      btn.disabled = false;
      btn.textContent = '连接服务器';
      showLoginErr('连接失败，请稍后重试');
    });
  }

  // ========== 初始化 ==========

  function init() {
    // Tab 点击绑定
    document.querySelectorAll('#sidebar .sitem').forEach(function(s){
      s.addEventListener('click', function(){ switchTab(s.dataset.tab); });
    });
    document.querySelectorAll('#tabbar .tab').forEach(function(t){
      t.addEventListener('click', function(){ switchTab(t.dataset.tab); });
    });

    // 滑动
    initSwipe(document.getElementById('main'));

    // QSheet 按钮
    document.getElementById('qs-minus').addEventListener('click', function(){ adjustQty(-1); });
    document.getElementById('qs-plus').addEventListener('click', function(){ adjustQty(1); });
    document.getElementById('qs-minus-fast').addEventListener('click', function(){ fastAdjust(-1); });
    document.getElementById('qs-plus-fast').addEventListener('click', function(){ fastAdjust(1); });

    // QSheet extra 按钮
    document.getElementById('qs-extra-minus').addEventListener('click', function(){ adjustExtra(-1); });
    document.getElementById('qs-extra-plus').addEventListener('click', function(){ adjustExtra(1); });
    document.getElementById('qs-extra-minus-fast').addEventListener('click', function(){ fastAdjustExtra(-1); });
    document.getElementById('qs-extra-plus-fast').addEventListener('click', function(){ fastAdjustExtra(1); });

    // QSheet tab 切换
    document.getElementById('qs-tab-deposit').addEventListener('click', function(){ switchQSheetMode('deposit'); });
    document.getElementById('qs-tab-withdraw').addEventListener('click', function(){ switchQSheetMode('withdraw'); });

    // QSheet 遮罩关闭
    document.getElementById('qsheet-overlay').addEventListener('click', function(e){
      if (e.target === this) closeQSheet();
    });

    // 指令确认弹窗
    document.getElementById('cf-cancel').addEventListener('click', hideConfirmDialog);
    document.getElementById('cf-confirm').addEventListener('click', function(){
      var fn = _cfOnConfirm;
      hideConfirmDialog();
      if (fn) fn();
    });
    document.getElementById('cf-overlay').addEventListener('click', function(e){
      if (e.target === this) hideConfirmDialog();
    });

    // Dots
    updateTabDots();
  }

  return {
    // Toast
    showToast: showToast,
    hideToast: hideToast,
    // Topbar
    setConnDot: setConnDot,
    pollHealth: pollHealth,
    updateGauge: updateGauge,
    updateUserBadge: updateUserBadge,
    handleUserBadgeClick: handleUserBadgeClick,
    toggleFullscreen: toggleFullscreen,
    // Disconnect
    closeDcDialog: closeDcDialog,
    confirmDisconnect: confirmDisconnect,
    showConfirmDialog: showConfirmDialog,
    hideConfirmDialog: hideConfirmDialog,
    executeWithConfirm: executeWithConfirm,
    // Login
    handleLogin: handleLogin,
    showLoginGuide: showLoginGuide,
    hideLoginGuide: hideLoginGuide,
    showLoginErr: showLoginErr,
    onLoginSuccess: onLoginSuccess,
    // Tabs
    switchTab: switchTab,
    updateTabDots: updateTabDots,
    onTabChange: onTabChange,
    getCurrentTab: getCurrentTab,
    // QSheet
    openQSheet: openQSheet,
    closeQSheet: closeQSheet,
    confirmQSheet: confirmQSheet,
    onQtyInput: onQtyInput,
    onQtyFocus: onQtyFocus,
    onQtyBlur: onQtyBlur,
    onExtraInput: onExtraInput,
    onExtraFocus: onExtraFocus,
    onExtraBlur: onExtraBlur,
    switchQSheetMode: switchQSheetMode,
    // KMB 格式
    fmtCompact: fmtCompact,
    fmtNum: fmtNum,
    fmtPrice: fmtPrice,
    // Init
    init: init,
  };
})();
