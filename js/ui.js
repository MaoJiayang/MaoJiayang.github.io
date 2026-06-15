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
  var _sidebarItems = null;
  var _tabbarTabs = null;
  var _dotEls = [];

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
    if (state === 'online') {
      var ab = SeBridge.activeBridge;
      dot.title = ab && ab.indexOf('localhost') !== -1 ? '服务在线 (本地)' : ab ? '服务在线 (桥接)' : '服务在线 (云)';
    } else {
      dot.title = state === 'offline' ? '服务离线' : '检测中';
    }
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
    var input = document.getElementById('cf-input');
    if (input) input.style.display = 'none';
    _cfOnConfirm = null;
  }

  /** 输入弹窗（替代浏览器 prompt，风格统一） */
  function showPromptDialog(title, placeholder, onConfirm) {
    document.getElementById('cf-msg').textContent = title;
    var input = document.getElementById('cf-input');
    input.value = '';
    input.placeholder = placeholder || '';
    input.style.display = '';
    _cfOnConfirm = function () {
      var val = input.value.trim();
      if (!val) return; // 空值不触发
      onConfirm(val);
    };
    document.getElementById('cf-overlay').classList.add('show');
    // 自动聚焦
    setTimeout(function () { input.focus(); }, 100);
  }

  // ========== 登录引导 ==========

  function showLoginGuide() {
    document.getElementById('login-guide').classList.add('show');
    document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
    document.getElementById('tabbar').style.display = 'none';
    document.getElementById('wh-bar').style.display = 'none';
  }

  function hideLoginGuide() {
    document.getElementById('login-guide').classList.remove('show');
    document.getElementById('tabbar').style.display = 'flex';
  }

  function showLoginErr(msg) {
    var el = document.getElementById('lg-err');
    el.textContent = msg;
    el.classList.add('show');
  }

  function onLoginSuccess(rateLimit) {
    hideLoginGuide();
    updateUserBadge();
    updateGauge();
    document.getElementById('wh-bar').style.display = '';
    fireTabCallback(currentTab);
    showToast('success', '已连接至伊卡洛斯星服务器');

    // 应用服务端下发的限流上限
    if (rateLimit) SeBridge.setRateLimit(rateLimit);

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
    (_sidebarItems || []).forEach(function(s){
      s.classList.toggle('active', s.dataset.tab === tab);
    });
    (_tabbarTabs || []).forEach(function(t){
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    var switching = !sameTab || !document.querySelector('.tab-panel.active');
    if (switching) {
      var prev = document.querySelector('.tab-panel.active');
      if (prev) prev.classList.remove('active');
      var panel = document.getElementById('panel-' + tab);
      if (panel) panel.classList.add('active');
    }
    updateTabDots();
    if (!sameTab) fireTabCallback(tab);
  }

  function updateTabDots() {
    _dotEls.forEach(function(d, i){
      d.classList.toggle('active', TAB_ORDER[i] === currentTab);
    });
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
      // 覆盖层打开时不滑动
      if (e.target.closest('#qsheet-overlay, #dc-overlay, #cf-overlay, #tradesheet-overlay, #donate-overlay')) return;
      // 输入控件中不滑动（input / textarea / range / select / contenteditable）
      var tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.target.isContentEditable) return;
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
  var _qsheetConfirmLabel = null;  // 自定义确认按钮文字
  var _sliderDragging = false;    // 拖动中暂缓格式化，防闪烁

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
    _qsheetConfirmLabel = options.confirmLabel || null;  // 自定义确认按钮文字（清单构建器等场景）
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

    // 拖动条初始范围（无上限时隐藏）
    var hasCap = isFinite(getMaxWithdraw());
    var sliderWrap = document.getElementById('qs-slider-wrap');
    if (sliderWrap) sliderWrap.style.display = hasCap ? '' : 'none';
    if (hasCap) UI.syncSlider(document.getElementById('qs-slider'), Math.min(qsheetQty, getMaxSlider()), getMaxSlider(), _lockQty > 0);

    // extra field
    var extraEl = document.getElementById('qs-extra');
    var confirmBtn = document.getElementById('qs-confirm');
    if (_qsheetConfirmLabel) {
      extraEl.style.display = 'none';
      confirmBtn.textContent = _qsheetConfirmLabel + ' ' + fmtCompact(qsheetQty);
    } else if (qsheetExtra) {
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

  /** HTML 彩色 KMB（物品数量、余额等展示区）。后缀 k=翠绿 M=金 B=紫。支持负数 */
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '0';
    if (typeof n === 'object' && n.toString) n = parseFloat(n.toString());
    if (isNaN(n)) return '0';
    var neg = n < 0;
    var abs = Math.abs(n);
    var result;
    if (abs >= 1e9) { result = (abs / 1e9).toFixed(2).replace(/\.?0+$/, '') + '<span class="num-sfx num-b">B</span>'; }
    else if (abs >= 1e6) { result = (abs / 1e6).toFixed(2).replace(/\.?0+$/, '') + '<span class="num-sfx num-m">M</span>'; }
    else if (abs >= 1e3) { result = (abs / 1e3).toFixed(2).replace(/\.?0+$/, '') + '<span class="num-sfx num-k">k</span>'; }
    else { result = abs.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
    return (neg ? '<span style="color:var(--color-error)">-</span>' : '') + result;
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

  function getMaxSlider() {
    var m = getMaxWithdraw();
    return isFinite(m) ? m : 99999;
  }

  function onQsSliderInput() {
    _sliderDragging = true;
    qsheetQty = parseInt(document.getElementById('qs-slider').value, 10) || 1;
    updateQSheetDisplay();
  }

  function onQsSliderChange() {
    _sliderDragging = false;
    updateQSheetDisplay(); // 松手后刷新为格式化显示
  }

  // ========== 显示更新 ==========

  function updateQSheetDisplay() {
    var input = document.getElementById('qs-qty');
    if (document.activeElement !== input) {
      var s = _sliderDragging ? String(qsheetQty) : fmtCompact(qsheetQty);
      // 补齐缺省小数位，防 "132M"↔"123.5M" 宽度跳变
      input.value = s.replace(/^([\d,]+)([KMBk])$/, '$1.0$2');
    }
    if (_qsheetConfirmLabel) {
      document.getElementById('qs-confirm').textContent = _qsheetConfirmLabel + ' ' + fmtCompact(qsheetQty);
    } else if (!qsheetExtra) {
      var label;
      if (qsheetMode === 'deposit') label = '确认存入 ';
      else if (qsheetMode === 'withdraw') label = '确认取出 ';
      else if (qsheetMode === 'buy') label = '确认购买 ';
      else label = '确认出售 ';
      document.getElementById('qs-confirm').textContent = label + fmtCompact(qsheetQty);
    }
    updateQSheetBtns();
    if (qsheetExtra) updateExtraDisplay();
    // 拖动条：有实际上限时显示（取出/锁定数量），无上限时隐藏（存入/无限购买）
    var sliderWrap = document.getElementById('qs-slider-wrap');
    var slider = document.getElementById('qs-slider');
    var hasCap = isFinite(getMaxWithdraw());
    if (sliderWrap) sliderWrap.style.display = hasCap ? '' : 'none';
    if (slider && hasCap) UI.syncSlider(slider, Math.min(qsheetQty, getMaxSlider()), getMaxSlider(), _lockQty > 0);
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
    // 非仓库模式（商店/市场/自定义标签）隐藏存入/取出 tabs
    if (qsheetMode === 'buy' || qsheetMode === 'sell' || _qsheetConfirmLabel) {
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
    var step = getDirStep(currentVal, dir) * (tapState.count * 5 + 10);
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
      } else if (_qsheetConfirmLabel) {
        // 自定义场景（清单构建器等）：传 mode + qty，不生成仓库指令
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
    if (!/^7656119\d{10}$/.test(steamId)) { showLoginErr('SteamID 格式错误（17位数字，7656119开头）'); return; }
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
        SeBridge.syncUser().then(function(syncR){
          var rl = (syncR && syncR.data && syncR.data.attrs && syncR.data.attrs.rateLimit) || 0;
          onLoginSuccess(rl);
        }).catch(function(){
          onLoginSuccess(0);
        });
      } else {
        showLoginErr(r.msg || '验证失败');
      }
    }).catch(function(e){
      btn.disabled = false;
      btn.textContent = '连接服务器';
      showLoginErr((e && e.message) || '连接失败，请稍后重试');
    });
  }

  // ========== 初始化 ==========

  function init() {
    // Tab 点击绑定 + 缓存
    _sidebarItems = Array.from(document.querySelectorAll('#sidebar .sitem'));
    _tabbarTabs = Array.from(document.querySelectorAll('#tabbar .tab'));
    _sidebarItems.forEach(function(s){
      s.addEventListener('click', function(){ switchTab(s.dataset.tab); });
    });
    _tabbarTabs.forEach(function(t){
      t.addEventListener('click', function(){ switchTab(t.dataset.tab); });
    });

    // 预建 dot 元素
    var dots = document.getElementById('tab-dots');
    if (dots) {
      dots.innerHTML = '';
      TAB_ORDER.forEach(function(t, i){
        var d = document.createElement('span');
        d.className = 'dot' + (i === 0 ? ' active' : '');
        dots.appendChild(d);
        _dotEls.push(d);
      });
    }

    // 滑动
    initSwipe(document.getElementById('main'));

    // QSheet 按钮
    document.getElementById('qs-minus').addEventListener('click', function(){ adjustQty(-1); });
    document.getElementById('qs-plus').addEventListener('click', function(){ adjustQty(1); });
    document.getElementById('qs-minus-fast').addEventListener('click', function(){ fastAdjust(-1); });
    document.getElementById('qs-plus-fast').addEventListener('click', function(){ fastAdjust(1); });
    document.getElementById('qs-slider').addEventListener('input', onQsSliderInput);
    document.getElementById('qs-slider').addEventListener('change', onQsSliderChange);

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
    document.getElementById('cf-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.getElementById('cf-confirm').click();
    });
    document.getElementById('cf-overlay').addEventListener('click', function(e){
      if (e.target === this) hideConfirmDialog();
    });

    // 竞速完成后立即更新连接指示灯
    SeBridge.init({ onStatusChange: function () {
      pollHealth();
    }});

    // Dots
    updateTabDots();
  }

  // ========== 工具函数 ==========

  function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function escAttr(s) { return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

  // ========== Overlay 工厂 ==========

  function createOverlay(id, innerHTML, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.id = id;
    wrap.className = 'overlay';
    wrap.innerHTML = '<div class="overlay-pane">' + innerHTML + '</div>';
    document.body.appendChild(wrap);
    if (opts.onBackdrop) {
      wrap.addEventListener('click', function (e) { if (e.target === wrap) opts.onBackdrop(); });
    }
    return {
      show: function () { wrap.classList.add('show'); if (opts.onShow) opts.onShow(); },
      hide: function () { wrap.classList.remove('show'); if (opts.onHide) opts.onHide(); },
      on: function (sel, event, fn) {
        (typeof sel === 'string' ? wrap.querySelectorAll(sel) : [sel]).forEach(function (el) {
          el.addEventListener(event, fn);
        });
      },
      get: function (sel) { return wrap.querySelector(sel); },
      el: wrap
    };
  }

  // ========== 清单选择器 ==========

  var _lpPicker = null;
  var _lpItems = [];
  var _lpOnSelect = null;
  var _lpSelected = null;
  var _lpTimer = null;

  function openListPicker(title, items, opts) {
    opts = opts || {};
    _lpItems = items || [];
    _lpOnSelect = opts.onSelect || null;
    _lpSelected = opts.selected || null;

    if (!_lpPicker) {
      _lpPicker = createOverlay('list-picker-overlay',
        '<div class="lp-header" id="lp-header"></div>' +
        '<input class="lp-search" id="lp-search" type="text" placeholder="搜索…">' +
        '<div class="lp-list" id="lp-list"></div>',
        { onBackdrop: function () { _lpPicker.hide(); } }
      );
      _lpPicker.on('#lp-search', 'input', function () {
        clearTimeout(_lpTimer);
        _lpTimer = setTimeout(renderListPicker, 200);
      });
    }

    document.getElementById('lp-header').textContent = title;
    document.getElementById('lp-search').value = '';
    renderListPicker();
    _lpPicker.show();
    setTimeout(function () { document.getElementById('lp-search').focus(); }, 150);
  }

  function renderListPicker() {
    var query = (document.getElementById('lp-search').value || '').toLowerCase().trim();
    var listEl = document.getElementById('lp-list');
    var filtered = _lpItems;
    if (query) {
      filtered = _lpItems.filter(function (item) {
        return (item.name || '').toLowerCase().indexOf(query) !== -1;
      });
    }

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="lp-empty">' + (query ? '无匹配清单' : '暂无可选清单') + '</div>';
      return;
    }

    var html = '';
    filtered.forEach(function (item) {
      var isSel = _lpSelected === item.name;
      var meta = '';
      if (item.money > 0) meta += '<span>' + fmtCompact(item.money) + ' SC</span>';
      if (item.items && item.items.length > 0) meta += '<span>' + item.items.length + ' 种物品</span>';
      html += '<div class="lp-item' + (isSel ? ' selected' : '') + '" data-lp-name="' + escAttr(item.name) + '">' +
        '<span class="lp-item-name">' + escHtml(item.name || '') + '</span>' +
        (meta ? '<span class="lp-item-meta">' + meta + '</span>' : '') +
        '</div>';
    });
    listEl.innerHTML = html;

    // 绑定点击
    var items = listEl.querySelectorAll('.lp-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        var name = this.getAttribute('data-lp-name');
        _lpSelected = name;
        if (_lpOnSelect) _lpOnSelect(name);
        _lpPicker.hide();
      });
    }
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
    showPromptDialog: showPromptDialog,
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
    // 清单选择器
    openListPicker: openListPicker,
    // Overlay 工厂
    createOverlay: createOverlay,
    // 步进逻辑
    getMagStep: getMagStep,
    fastStep: fastStep,
    // KMB 格式
    fmtCompact: fmtCompact,
    fmtNum: fmtNum,
    fmtPrice: fmtPrice,
    parseCompact: parseCompact,
    // 工具函数
    escHtml: escHtml,
    escAttr: escAttr,
    /** 统一滑块同步：设置范围、值、禁用态，并填充已拖动区域 */
    syncSlider: function (slider, value, max, disabled) {
      slider.max = max;
      slider.value = value;
      slider.disabled = !!disabled;
      var pct = max > 0 ? (value / max) * 100 : 0;
      slider.style.background = 'linear-gradient(to right, var(--jade-200) 0%, var(--jade-200) ' + pct + '%, var(--bg-hover) ' + pct + '%)';
    },
    // Init
    init: init,
  };
})();
