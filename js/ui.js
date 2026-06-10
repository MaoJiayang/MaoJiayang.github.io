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
      if (e.target.closest('#qsheet-overlay') || e.target.closest('#dc-overlay')) return;
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
  var _tapCount = 0;
  var _lastTapTime = 0;
  var _tapTimer = null;
  var _tapStep = 10;
  var _qsheetOnConfirm = null;

  // extraField 扩展（市场订单单价等）
  var qsheetExtra = null;       // { label, value, suffix, step, max }
  var qsheetExtraVal = 0;
  var _extraTapCount = 0;
  var _extraLastTap = 0;
  var _extraTapTimer = null;
  var _extraTapStep = 10;

  /**
   * openQSheet(mode, itemName, stock, onConfirm)        ← 仓库用法（向后兼容）
   * openQSheet(mode, itemName, options)                  ← 市场用法
   *   options: { stock, extraField: { label, value, suffix, step, max }, onConfirm }
   */
  function openQSheet(mode, itemName, stockOrOptions, onConfirm) {
    qsheetMode = mode;
    qsheetItem = itemName;
    _tapCount = 0;
    _tapStep = 10;

    // 判断 overload：第三个参数是对象则为 options 模式
    var isOptions = typeof stockOrOptions === 'object' && stockOrOptions !== null;
    var options = isOptions ? stockOrOptions : { stock: stockOrOptions || 0, onConfirm: onConfirm };

    qsheetStock = options.stock || 0;
    qsheetQty = 100;
    _qsheetOnConfirm = options.onConfirm || null;
    qsheetExtra = options.extraField || null;
    qsheetExtraVal = qsheetExtra ? qsheetExtra.value : 0;
    _extraTapCount = 0;
    _extraTapStep = 10;

    var depositing = mode === 'deposit';
    // 市场模式（有 extraField）或无上限标记时不限量，否则按存量限制
    var maxWithdraw = (qsheetExtra || options.noCap) ? Infinity : (depositing ? Infinity : qsheetStock);
    if (qsheetQty > maxWithdraw) qsheetQty = maxWithdraw;
    if (qsheetQty < 1) qsheetQty = 1;
    document.getElementById('qs-item').textContent = itemName;
    document.getElementById('qs-stock').textContent = qsheetExtra ? '' : ('库存 ' + qsheetStock.toLocaleString());
    document.getElementById('qs-qty').value = qsheetQty;

    // extra field
    var extraEl = document.getElementById('qs-extra');
    var confirmBtn = document.getElementById('qs-confirm');
    if (qsheetExtra) {
      extraEl.style.display = 'block';
      document.getElementById('qs-extra-label').textContent = qsheetExtra.label;
      document.getElementById('qs-extra-val').value = qsheetExtraVal;
      confirmBtn.textContent = '确认发布';
    } else {
      extraEl.style.display = 'none';
      var label;
      if (qsheetMode === 'deposit') label = '确认存入 ';
      else if (qsheetMode === 'withdraw') label = '确认取出 ';
      else if (qsheetMode === 'buy') label = '确认购买 ';
      else label = '确认出售 ';
      confirmBtn.textContent = label + qsheetQty.toLocaleString();
    }

    document.getElementById('qsheet-overlay').classList.add('show');
    updateQSheetTabs();
    updateQSheetBtns();
    updateExtraDisplay();
  }

  function closeQSheet() {
    document.getElementById('qsheet-overlay').classList.remove('show');
    clearTimeout(_tapTimer);
    clearTimeout(_extraTapTimer);
    qsheetExtra = null;
  }

  function updateQSheetDisplay() {
    document.getElementById('qs-qty').value = qsheetQty;
    if (!qsheetExtra) {
      var label;
      if (qsheetMode === 'deposit') label = '确认存入 ';
      else if (qsheetMode === 'withdraw') label = '确认取出 ';
      else if (qsheetMode === 'buy') label = '确认购买 ';
      else label = '确认出售 ';
      document.getElementById('qs-confirm').textContent = label + qsheetQty.toLocaleString();
    }
    updateQSheetBtns();
    if (qsheetExtra) updateExtraDisplay();
  }

  function updateExtraDisplay() {
    if (!qsheetExtra) return;
    document.getElementById('qs-extra-val').value = qsheetExtraVal;
    var total = qsheetQty * qsheetExtraVal;
    var el = document.getElementById('qs-extra-total');
    if (total > 0) el.textContent = '总价 ' + total.toLocaleString() + ' ' + (qsheetExtra.suffix || 'SC');
    else el.textContent = '';
    updateExtraBtns();
  }

  function updateExtraBtns() {
    var max = qsheetExtra && qsheetExtra.max ? qsheetExtra.max : 999999;
    document.getElementById('qs-extra-minus').disabled = qsheetExtraVal <= 1;
    document.getElementById('qs-extra-minus-fast').disabled = qsheetExtraVal <= 1;
    document.getElementById('qs-extra-plus').disabled = qsheetExtraVal >= max;
    document.getElementById('qs-extra-plus-fast').disabled = qsheetExtraVal >= max;
  }

  function onExtraInput() {
    var input = document.getElementById('qs-extra-val');
    var v = parseInt(input.value) || 1;
    var max = qsheetExtra && qsheetExtra.max ? qsheetExtra.max : 999999;
    qsheetExtraVal = Math.max(1, Math.min(max, v));
    input.value = qsheetExtraVal;
    updateExtraDisplay();
  }

  function adjustExtra(delta) {
    var max = qsheetExtra && qsheetExtra.max ? qsheetExtra.max : 999999;
    qsheetExtraVal = Math.max(1, Math.min(max, qsheetExtraVal + delta));
    updateExtraDisplay();
  }

  function fastAdjustExtra(deltaDir) {
    var now = Date.now();
    if (_extraLastTap && now - _extraLastTap < 600) {
      _extraTapCount++;
      _extraTapStep = Math.min(1000, 10 * Math.pow(2, _extraTapCount));
    } else { _extraTapCount = 0; _extraTapStep = 10; }
    _extraLastTap = now;
    clearTimeout(_extraTapTimer);
    _extraTapTimer = setTimeout(function(){ _extraTapCount = 0; _extraTapStep = 10; _extraLastTap = 0; }, 600);
    adjustExtra(deltaDir * _extraTapStep);
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
    var maxWithdraw = qsheetMode === 'deposit' ? Infinity : qsheetStock;
    document.getElementById('qs-minus').disabled = qsheetQty <= 1;
    document.getElementById('qs-minus-fast').disabled = qsheetQty <= 1;
    document.getElementById('qs-plus').disabled = qsheetQty >= maxWithdraw;
    document.getElementById('qs-plus-fast').disabled = qsheetQty >= maxWithdraw;
  }

  function onQtyInput() {
    var input = document.getElementById('qs-qty');
    var v = parseInt(input.value) || 1;
    var maxWithdraw = qsheetMode === 'deposit' ? Infinity : qsheetStock;
    qsheetQty = Math.max(1, Math.min(maxWithdraw, v));
    input.value = qsheetQty;
    document.getElementById('qs-confirm').textContent = (qsheetMode === 'deposit' ? '确认存入 ' : '确认取出 ') + qsheetQty.toLocaleString();
    _tapCount = 0; _tapStep = 10;
  }

  function adjustQty(delta) {
    var maxWithdraw = qsheetMode === 'deposit' ? Infinity : qsheetStock;
    qsheetQty = Math.max(1, Math.min(maxWithdraw, qsheetQty + delta));
    updateQSheetDisplay();
  }

  function fastAdjust(deltaDir) {
    var now = Date.now();
    if (_lastTapTime && now - _lastTapTime < 600) {
      _tapCount++;
      _tapStep = Math.min(1000, 10 * Math.pow(2, _tapCount));
    } else {
      _tapCount = 0;
      _tapStep = 10;
    }
    _lastTapTime = now;
    clearTimeout(_tapTimer);
    _tapTimer = setTimeout(function(){ _tapCount = 0; _tapStep = 10; _lastTapTime = 0; }, 600);
    adjustQty(deltaDir * _tapStep);
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
    _tapCount = 0; _tapStep = 10;
    updateQSheetTabs();
    updateQSheetDisplay();
  }

  function confirmQSheet() {
    if (qsheetQty < 1) qsheetQty = 1;
    if (qsheetExtra && qsheetExtraVal < 1) qsheetExtraVal = 1;
    var label = qsheetMode === 'deposit' ? '存入' : '取出';
    closeQSheet();
    if (_qsheetOnConfirm) {
      if (qsheetExtra) {
        _qsheetOnConfirm(qsheetMode, qsheetQty, qsheetExtraVal, label);
      } else {
        var cmd = qsheetMode === 'deposit'
          ? '!仓库 存入 ' + qsheetItem + ' ' + qsheetQty
          : '!仓库 取出 ' + qsheetItem + ' ' + qsheetQty;
        _qsheetOnConfirm(cmd, label);
      }
    }
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
    // Disconnect
    closeDcDialog: closeDcDialog,
    confirmDisconnect: confirmDisconnect,
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
    onExtraInput: onExtraInput,
    switchQSheetMode: switchQSheetMode,
    // Init
    init: init,
  };
})();
