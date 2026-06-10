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
    if (btn) { btn.textContent = '刷新中…'; btn.disabled = true; }
    SeBridge.executeCommand('!仓库 列表').then(function(r){
      warehouseLoading = false;
      if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
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
      if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
      UI.showToast('error', '网络错误，请稍后重试');
    });
  }

  function hasData() { return warehouseData !== null; }

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

  function renderCardIcon(itemName) {
    var iconFile = iconMap[itemName];
    var cat = getItemCategory(itemName);
    var color = catColors[cat] || catColors['其他'];
    var initial = itemName.charAt(0);
    if (iconFile) {
      return '<span class="wh-card-icon si si-' + iconFile + '" title="' + escAttr(itemName) + '"></span>';
    }
    return '<span class="wh-card-icon-fb" style="background:' + color + '">' + initial + '</span>';
  }

  function fmtNum(n, compact) {
    if (!compact) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    if (n >= 1e9)      return (n / 1e9).toFixed(1).replace(/\.0$/, '');
    if (n >= 1e6)      return (n / 1e6).toFixed(1).replace(/\.0$/, '');
    if (n >= 1e3)      return (n / 1e3).toFixed(1).replace(/\.0$/, '');
    return n.toLocaleString();
  }

  function render() {
    var container = document.getElementById('wh-categories');
    var emptyEl = document.getElementById('wh-empty');
    var search = (document.getElementById('wh-search').value || '').toLowerCase().trim();

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
        var display = amtNum === 0 ? '0' : fmtNum(amtNum, compact);
        var suffixHtml = '';
        if (compact && amtNum >= 1000) {
          var cls = amtNum >= 1e9 ? 'num-b' : amtNum >= 1e6 ? 'num-m' : 'num-k';
          var sfx = cls === 'num-b' ? 'B' : cls === 'num-m' ? 'M' : 'k';
          suffixHtml = '<span class="wh-num-sfx ' + cls + '">' + sfx + '</span>';
        }
        var iconHtml = renderCardIcon(item.name);
        var zeroClass = item.amount === 0 ? ' zero' : '';
        html += '<div class="wh-card' + zeroClass + '" onclick="Warehouse.openCard(this,\'' + escAttr(item.name) + '\',' + item.amount + ')">'
          + iconHtml
          + '<span class="wh-card-name">' + escHtml(item.name) + '</span>'
          + '<span class="wh-card-amt">' + escHtml(display) + suffixHtml + '</span>'
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

  function executeAndRefresh(cmd, label) {
    if (!SeBridge.hasCredentials()) { UI.showLoginGuide(); return; }
    if (SeBridge.isRateLimited()) { UI.showToast('error', '调用次数已用完，请稍后再试'); return; }
    SeBridge.executeCommand(cmd).then(function(r){
      SeBridge.trackCall();
      UI.updateGauge();
      if (r.code === 200) {
        UI.showToast('success', '「' + label + '」指令已发送');
        setTimeout(load, 1500);
      } else {
        UI.showToast('error', r.msg || '指令执行失败');
      }
    }).catch(function(){
      UI.showToast('error', '网络错误');
    });
  }

  // ========== 初始化 ==========

  function init() {
    loadPrefs();
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

  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function escAttr(s) { return String(s).replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

  return {
    init: init,
    load: load,
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
    enterSelectionMode: enterSelectionMode,
    exitSelectionMode: exitSelectionMode,
  };
})();
