/**
 * Warehouse Panel — 仓库面板
 * 依赖: UI, SeBridge（全局）
 */
var Warehouse = (function () {
  'use strict';

  var warehouseData = null;
  var warehouseLoading = false;
  var warehouseOpenCat = null;
  var warehouseShowAll = false;
  var warehouseCompactNum = false;
  var PREFS_KEY = 'wh_prefs';
  var _renderTimer = null;

  // 选择模式（供交易面板复用仓库选物品）
  var selectionMode = null;         // 'sell' | 'buy' | null
  var selectionCallback = null;     // function(itemName)

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        warehouseShowAll = !!p.showAll;
        warehouseCompactNum = !!p.compact;
      }
    } catch (_) {}
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        showAll: warehouseShowAll,
        compact: warehouseCompactNum
      }));
    } catch (_) {}
  }

  var iconMap = {};
  var itemCategories = {};
  var catColors = {
    '矿石': '#7A4D00',
    '矿锭': '#C48A0A',
    '零件': '#1B6B4A',
    '弹药': '#1A3E7A',
    '工具': '#2E6BC4',
    '消耗品': '#B07AE0',
    '其他': '#253748'
  };
  var catToSaveParam = { '工具': '手持物' };

  // ========== 数据加载 ==========

  function load() {
    if (warehouseLoading) return;
    if (!SeBridge.hasCredentials()) return;
    warehouseLoading = true;
    var btn = document.getElementById('wh-refresh');
    if (btn) btn.classList.add('spinning');
    SeBridge.executeCommand('!仓库 列表').then(function(r){
      warehouseLoading = false;
      if (btn) btn.classList.remove('spinning');
      if (r.code === 200 && r.data) {
        warehouseData = { items: r.data.items || {}, steamId: r.data.steamId };
        SeBridge.trackCall();
        UI.updateGauge();
        render();
        UI.showToast('success', '库存已刷新');
      } else if (r.code === 401) {
        SeBridge.clearCredentials();
        UI.updateUserBadge();
        UI.showLoginGuide();
        UI.showToast('error', '凭据已过期，请重新登录');
      } else {
        UI.showToast('error', '仓库数据获取失败');
      }
    }).catch(function(){
      warehouseLoading = false;
      if (btn) btn.classList.remove('spinning');
      UI.showToast('error', '网络错误，请稍后重试');
    });
  }

  function hasData() { return warehouseData !== null; }

  /** 静默加载仓库数据（不弹 Toast），供交易面板等外部模块使用 */
  function ensureData() {
    if (warehouseData || warehouseLoading) return;
    if (!SeBridge.hasCredentials()) return;
    warehouseLoading = true;
    SeBridge.executeCommand('!仓库 列表').then(function(r){
      warehouseLoading = false;
      if (r.code === 200 && r.data) {
        warehouseData = { items: r.data.items || {}, steamId: r.data.steamId };
        SeBridge.trackCall();
        UI.updateGauge();
        render();
      }
    }).catch(function(){
      warehouseLoading = false;
    });
  }

  // ========== 渲染 ==========

  function getItemCategory(name) {
    for (var cat in itemCategories) {
      if (itemCategories[cat].indexOf(name) !== -1) return cat;
    }
    return '其他';
  }

  function getIcon(itemName) {
    return iconMap[itemName] || null;
  }

  function getStock(itemName) {
    if (!warehouseData || !warehouseData.items) return 0;
    return warehouseData.items[itemName] || 0;
  }

  /**
   * 统一图标渲染
   * @param {string} name  物品名
   * @param {number|string} size  'card'=32px, 'sm'=16px
   */
  function renderIcon(name, size) {
    var isSm = size === 'sm' || size === 16;
    var iconFile = iconMap[name];
    if (iconFile) {
      var el = '<span class="wh-icon si si-' + iconFile + '" title="' + UI.escAttr(name) + '"></span>';
      return isSm ? '<span class="wh-icon-wrap-sm">' + el + '</span>' : el;
    }
    var cat = getItemCategory(name);
    var color = catColors[cat] || catColors['其他'];
    var cls = 'wh-icon-fb' + (isSm ? ' wh-icon-sm' : '');
    var initial = name.charAt(0);
    return '<span class="' + cls + '" style="background:' + color + '">' + initial + '</span>';
  }

  function render() {
    var container = document.getElementById('wh-categories');
    var emptyEl = document.getElementById('wh-empty');
    var search = (document.getElementById('wh-search').value || '').toLowerCase().trim();

    // 加载中占位（防 CLS）
    if (warehouseLoading && !warehouseData) {
      var h = container.scrollHeight || 120;
      container.style.minHeight = h + 'px';
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }
    container.style.minHeight = '';

    var whItems = (warehouseData && warehouseData.items) ? warehouseData.items : {};
    var catOrder = ['矿石','矿锭','零件','弹药','工具','消耗品','其他'];
    var groups = {};
    var hasOwnedItems = Object.keys(whItems).length > 0;

    // 工具栏
    var bar = document.getElementById('wh-bar');
    if (bar) bar.style.display = SeBridge.hasCredentials() ? '' : 'none';
    var showAllBtn = document.getElementById('wh-showall-btn');
    if (showAllBtn) {
      showAllBtn.textContent = warehouseShowAll ? '隐藏未拥有' : '显示未拥有';
      showAllBtn.classList.toggle('active', warehouseShowAll);
      showAllBtn.style.display = hasOwnedItems ? '' : 'none';
    }
    var fmtBtn = document.getElementById('wh-fmt-btn');
    if (fmtBtn) fmtBtn.textContent = warehouseCompactNum ? '完整' : '简洁';

    // 按分类分组
    catOrder.forEach(function(cat){
      var catalog = itemCategories[cat];
      if (!catalog || catalog.length === 0) return;
      var items = [];
      catalog.forEach(function(name){
        if (search && name.toLowerCase().indexOf(search) === -1) return;
        var amount = whItems.hasOwnProperty(name) ? whItems[name] : 0;
        if (!warehouseShowAll && amount === 0) return;
        items.push({ name: name, amount: amount });
      });
      if (items.length === 0) return;
      items.sort(function(a,b){ return a.name.localeCompare(b.name); });
      groups[cat] = items;
    });

    // 未覆盖物品归入「其他」
    var covered = {};
    catOrder.forEach(function(cat){ (groups[cat]||[]).forEach(function(i){ covered[i.name] = true; }); });
    var uncat = [];
    Object.keys(whItems).forEach(function(name){
      if (!covered[name] && (!search || name.toLowerCase().indexOf(search) !== -1)) {
        uncat.push({ name: name, amount: whItems[name] });
      }
    });
    if (uncat.length > 0) {
      uncat.sort(function(a,b){ return a.name.localeCompare(b.name); });
      if (!groups['其他']) groups['其他'] = [];
      groups['其他'] = groups['其他'].concat(uncat);
    }

    var totalVisible = 0;
    var html = '';
    var openCat = warehouseOpenCat || (catOrder.find(function(c){ return groups[c] && groups[c].length > 0; }) || catOrder[0]);

    catOrder.forEach(function(cat){
      var items = groups[cat];
      if (!items || items.length === 0) return;
      totalVisible += items.length;
      var isOpen = cat === openCat;
      html += '<div class="wh-cat">';
      html += '<div class="wh-cat-h" onclick="Warehouse.toggle(this)">'
        + '<span class="arrow' + (isOpen ? ' open' : '') + '">▸</span>'
        + '<span class="wh-cat-dot" style="background:' + (catColors[cat] || catColors['其他']) + '"></span>'
        + '<span class="wh-cat-label">' + cat + '</span>'
        + '<span class="wh-cat-count">' + items.length + ' 种</span>'
        + '<span class="cat-spacer"></span>'
        + '<button class="wh-cat-save" onclick="event.stopPropagation();Warehouse.saveAll(\'' + cat + '\')">全部存入</button>'
        + '</div>';
      html += '<div class="wh-cat-body' + (isOpen ? ' open' : '') + '"><div class="wh-grid">';
      items.forEach(function(item){
        var compact = warehouseCompactNum;
        var amtNum = typeof item.amount === 'number' ? item.amount : parseInt(item.amount) || 0;
        var display = amtNum === 0 ? '0' : (compact ? UI.fmtNum(amtNum) : UI.fmtPrice(amtNum));
        var iconHtml = renderIcon(item.name, 'card');
        var zeroClass = item.amount === 0 ? ' zero' : '';
        html += '<div class="wh-card' + zeroClass + '" onclick="Warehouse.openCard(this,\'' + UI.escAttr(item.name) + '\',' + item.amount + ')">'
          + iconHtml
          + '<span class="wh-card-name">' + UI.escHtml(item.name) + '</span>'
          + '<span class="wh-card-amt">' + display + '</span>'
          + '</div>';
      });
      html += '</div></div></div>';
    });

    container.innerHTML = html;
    emptyEl.style.display = totalVisible === 0 ? 'block' : 'none';
    if (totalVisible === 0 && hasOwnedItems) {
      emptyEl.innerHTML = '没有匹配的物品';
    } else if (totalVisible === 0 && !hasOwnedItems) {
      emptyEl.innerHTML = '暂无物品数据<br><span style="font-size:11px;opacity:.6">点击「刷新」获取库存</span>';
    }
    renderBanner();
  }

  // ========== 分类交互 ==========

  function toggle(el) {
    var catEl = el.parentElement;
    var catName = catEl.querySelector('.wh-cat-label').textContent;
    var arrow = el.querySelector('.arrow');
    var body = catEl.querySelector('.wh-cat-body');
    var wasOpen = arrow.classList.contains('open');

    document.querySelectorAll('.wh-cat-h').forEach(function(h){
      h.querySelector('.arrow').classList.remove('open');
      var b = h.parentElement.querySelector('.wh-cat-body');
      if (b) b.classList.remove('open');
    });

    if (!wasOpen) {
      arrow.classList.add('open');
      if (body) body.classList.add('open');
      warehouseOpenCat = catName;
    } else {
      warehouseOpenCat = null;
    }
  }

  function toggleShowAll(show) {
    warehouseShowAll = typeof show === 'boolean' ? show : !warehouseShowAll;
    warehouseOpenCat = null;
    savePrefs();
    render();
  }

  function toggleNumFmt() {
    warehouseCompactNum = !warehouseCompactNum;
    savePrefs();
    var btn = document.getElementById('wh-fmt-btn');
    if (btn) btn.textContent = warehouseCompactNum ? '完整' : '简洁';
    render();
  }

  // ========== 物品操作 ==========

  function openCard(card, itemName, stock) {
    // 选择模式：回调给交易模块，不弹存入/取出
    if (selectionMode && selectionCallback) {
      selectionCallback(itemName);
      return;
    }
    UI.openQSheet('deposit', itemName, stock, function(cmd, label){
      executeAndRefresh(cmd, label);
    });
  }

  function enterSelectionMode(mode, callback) {
    selectionMode = mode;
    selectionCallback = callback;
    renderBanner();
  }

  function exitSelectionMode() {
    selectionMode = null;
    selectionCallback = null;
    renderBanner();
  }

  function renderBanner() {
    var el = document.getElementById('wh-select-banner');
    if (!el) return;
    if (selectionMode) {
      el.style.display = '';
      el.innerHTML = '<span>' + (selectionMode === 'sell' ? '点击物品选择要出售的商品' : '点击物品选择要收购的商品') + '</span>'
        + '<button onclick="Warehouse.exitSelectionMode()">取消</button>';
      el.className = 'wh-select-banner show';
    } else {
      el.style.display = 'none';
    }
  }

  function saveAll(cat) {
    var param = catToSaveParam[cat] || cat;
    executeAndRefresh('!仓库 存入全部 ' + param, '存入全部 ' + param);
  }

  function saveAllNoArg() {
    executeAndRefresh('!仓库 存入全部', '存入全部');
  }

  // ========== 按清单存取 ==========

  function listOps() {
    if (!SeBridge.hasCredentials()) { UI.showLoginGuide(); return; }

    var cached = Trade.getListData();
    if (cached) {
      var lists = extractListNames(cached);
      if (lists.length > 0) { openListOpsPicker(lists); return; }
    }
    // 无缓存则获取
    UI.executeWithConfirm('!清单 列表', null).then(function (d) {
      var lists = extractListNames(d);
      if (lists.length === 0) {
        UI.showToast('error', '暂无可用的清单，请先在合同面板创建清单');
        return;
      }
      openListOpsPicker(lists);
    }).catch(function () {
      UI.showToast('error', '获取清单列表失败');
    });
  }

  function extractListNames(d) {
    if (!d) return [];
    if (Array.isArray(d.lists)) return d.lists.map(function (l) { return typeof l === 'string' ? { name: l } : l; });
    if (Array.isArray(d)) return d.map(function (l) { return typeof l === 'string' ? { name: l } : l; });
    return [];
  }

  function openListOpsPicker(lists) {
    UI.openListPicker('按清单存取', lists, {
      onSelect: function (name) {
        showListAction(name);
      }
    });
  }

  var _listActionOverlay = null;
  var _listActionName = '';

  function showListAction(name) {
    _listActionName = name;
    if (!_listActionOverlay) {
      _listActionOverlay = UI.createOverlay('list-action-overlay',
        '<div class="sf-header">按清单存取</div>' +
        '<div style="text-align:center;margin-bottom:16px;font-size:14px;color:var(--text-primary)">' +
          '已选：<strong id="la-name"></strong>' +
        '</div>' +
        '<div class="sf-actions">' +
          '<button class="sf-cancel">取消</button>' +
          '<button id="la-withdraw" style="flex:1;padding:12px;font-size:14px;font-weight:600;border-radius:6px;border:none;cursor:pointer;font-family:inherit;background:var(--blue-200);color:var(--bg-void)">取出</button>' +
          '<button class="sf-confirm">存入</button>' +
        '</div>',
        { onBackdrop: function () { _listActionOverlay.hide(); } }
      );
      _listActionOverlay.on('.sf-cancel', 'click', function () { _listActionOverlay.hide(); });
      _listActionOverlay.on('#la-withdraw', 'click', function () {
        _listActionOverlay.hide();
        executeAndRefresh('!仓库 取出清单 ' + _listActionName, '按清单取出「' + _listActionName + '」');
      });
      _listActionOverlay.on('.sf-confirm', 'click', function () {
        _listActionOverlay.hide();
        executeAndRefresh('!仓库 存入清单 ' + _listActionName, '按清单存入「' + _listActionName + '」');
      });
    }
    document.getElementById('la-name').textContent = name;
    _listActionOverlay.show();
  }

  function executeAndRefresh(cmd, label) {
    if (!SeBridge.hasCredentials()) { UI.showLoginGuide(); return; }
    UI.executeWithConfirm(cmd, label).then(function () {
      setTimeout(load, 1500);
    }).catch(function (err) {
      if (err === 'RATE_LIMITED') return;
      setTimeout(load, 1500);
    });
  }

  // ========== 初始化 ==========

  function init() {
    loadPrefs();
    // 搜索框即时过滤
    var searchInput = document.getElementById('wh-search');
    if (searchInput) searchInput.addEventListener('input', function () {
      clearTimeout(_renderTimer);
      _renderTimer = setTimeout(render, 200);
    });
    // 加载图标和物品目录
    fetch('icons/mapping.json')
      .then(function(r){ return r.json(); })
      .then(function(m){ iconMap = m; })
      .catch(function(){ console.warn('图标映射加载失败'); });

    fetch('items_catalog.json')
      .then(function(r){ return r.json(); })
      .then(function(cat){ itemCategories = cat; })
      .catch(function(){ console.warn('items_catalog.json 加载失败'); });
  }

  function onTabActivated() {
    if (!warehouseData) load();
  }

  function markStale() {
    warehouseData = null;
  }

  // ========== 工具函数 ==========


  return {
    init: init,
    load: load,
    ensureData: ensureData,
    hasData: hasData,
    render: render,
    toggle: toggle,
    toggleShowAll: toggleShowAll,
    toggleNumFmt: toggleNumFmt,
    openCard: openCard,
    saveAll: saveAll,
    saveAllNoArg: saveAllNoArg,
    onTabActivated: onTabActivated,
    markStale: markStale,
    getIcon: getIcon,
    getStock: getStock,
    renderIcon: renderIcon,
    getCatOrder: function(){ return ['矿石','矿锭','零件','弹药','工具','消耗品','其他']; },
    getItemCategories: function(){ return itemCategories; },
    getCatColor: function(cat){ return catColors[cat] || catColors['其他']; },
    getOpenCat: function(){ return warehouseOpenCat; },
    enterSelectionMode: enterSelectionMode,
    exitSelectionMode: exitSelectionMode,
    listOps: listOps,
  };
})();
