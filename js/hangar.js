/**
 * Hangar Panel — 船坞面板（我的船坞 + 世界网格 + 舰船市场占位）
 * 依赖: UI, SeBridge（全局）
 */
var Hangar = (function () {
  'use strict';

  var SUBTABS = ['my', 'world', 'market'];
  var currentSubTab = 'my';
  var hangarData = null;        // { grids: string[], unsyncedGrids: string[] }
  var worldGrids = null;        // GridVO[]
  var loading = false;
  var showFullName = false;     // 名称显示切换
  var _worldSortIdx = 0;        // 世界网格排序索引：0=名称↑,1=名称↓,2=PCU↑...7=价值↓

  // ========== 舰船市场 ==========
  var shipMarketLoading = false;
  var shipMarketData = null;     // { availableCoupons, couponValue, serverShips, playerShips }
  var _shipMarketSortIdx = 0;   // 0=名称↑,1=名称↓,2=售价↑,3=售价↓,4=估价↑,5=估价↓

  // ========== 通用执行 ==========

  function exec(cmd, okLabel) {
    return UI.executeWithConfirm(cmd, okLabel);
  }

  // ========== 名称处理 ==========

  /** 从全名中提取 [...] 内的短名，若无则返回原值 */
  function shortName(full) {
    if (!full) return '';
    var m = full.match(/\[([^\]]+)\]/);
    return m ? m[1] : full;
  }

  /** 根据 showFullName 切换返回显示用的名称 */
  function showName(full) {
    return showFullName ? (full || '') : shortName(full);
  }

  /** 用双引号包裹名称（含空格时指令解析需要） */
  function q(name) {
    return '"' + (name || '') + '"';
  }

  function toggleNameFmt() {
    showFullName = !showFullName;
    updateNameToggleBtn();
    renderMy();
    renderWorld();
  }

  /** 点击名称切换单行短名/全名 */
  function tapName(el) {
    var full = el.getAttribute('data-full') || '';
    if (!full) return;
    var showingFull = el.textContent === full;
    el.textContent = showingFull ? shortName(full) : full;
  }

  function updateNameToggleBtn() {
    var btn = document.getElementById('ha-name-toggle');
    if (btn) btn.textContent = showFullName ? '简洁' : '完整';
  }

  // ========== 子 Tab 切换 ==========

  function switchSubTab(tab) {
    if (tab === currentSubTab) return;
    currentSubTab = tab;
    document.querySelectorAll('.st-tab[data-ha-tab]').forEach(function (el) {
      el.classList.toggle('active', el.dataset.haTab === tab);
    });
    document.querySelectorAll('.ha-section').forEach(function (el) {
      el.style.display = el.id === 'hangar-' + tab ? 'block' : 'none';
    });
    if (tab === 'my' && !hangarData && !loading) loadHangar();
    if (tab === 'world' && !worldGrids && !loading) loadWorldGrids();
    if (tab === 'market' && !shipMarketData && !shipMarketLoading) loadShipMarket();
  }

  function initSubTabs() {
    document.querySelectorAll('.st-tab[data-ha-tab]').forEach(function (el) {
      el.addEventListener('click', function () {
        switchSubTab(el.dataset.haTab);
      });
    });
  }

  // ========== 数据加载 ==========

  function loadHangar() {
    if (loading) return;
    loading = true;
    renderMy();
    exec('!网格 列表', null).then(function (d) {
      hangarData = d;
      loading = false;
      renderMy();
    }).catch(function () {
      hangarData = { grids: [], unsyncedGrids: [] };
      loading = false;
      renderMy();
    });
  }

  function loadWorldGrids() {
    if (loading) return;
    loading = true;
    renderWorld();
    SeBridge.getWorldGrids().then(function (r) {
      loading = false;
      if (r.code === 200 && r.data) {
        worldGrids = r.data;
      } else if (r.code === 200 && r.msg) {
        // 服务端将 GridVO[] 序列化到 msg 字段
        try { var p = JSON.parse(r.msg); if (Array.isArray(p)) worldGrids = p; } catch (_) { worldGrids = []; }
      } else {
        worldGrids = [];
      }
      renderWorld();
    }).catch(function () {
      worldGrids = [];
      loading = false;
      renderWorld();
    });
  }

  // ========== 渲染：我的船坞（列表形式） ==========

  function renderMy() {
    var container = document.getElementById('ha-grids');
    if (!container) return;

    var search = (document.getElementById('ha-search') && document.getElementById('ha-search').value || '').toLowerCase().trim();

    if (!hangarData && loading) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    // 搜索匹配全名或短名
    var allGrids = (hangarData.grids || []).concat(hangarData.unsyncedGrids || []);
    var filtered = allGrids.filter(function (name) {
      if (!search) return true;
      return name.toLowerCase().indexOf(search) !== -1
        || shortName(name).toLowerCase().indexOf(search) !== -1;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的船舶' : '暂无保存的船舶') + '</div>';
      return;
    }

    var syncedFiltered = (hangarData.grids || []).filter(function (n) { return filtered.indexOf(n) !== -1; });
    var unsyncedFiltered = (hangarData.unsyncedGrids || []).filter(function (n) { return filtered.indexOf(n) !== -1; });

    var html = '';

    // 未同步排前面（提醒玩家及时同步）
    if (unsyncedFiltered.length > 0) {
      html += '<div class="wh-cat"><div class="wh-cat-h"><span class="arrow open">▸</span>'
        + '<span class="wh-cat-dot" style="background:var(--color-warn)"></span>'
        + '<span class="wh-cat-label">未同步船舶</span>'
        + '<span class="wh-cat-count">' + unsyncedFiltered.length + ' 艘</span>'
        + '</div><div class="wh-cat-body open">';
      unsyncedFiltered.forEach(function (name) {
        html += renderGridRow(name, true);
      });
      html += '</div></div>';
    }

    if (syncedFiltered.length > 0) {
      html += '<div class="wh-cat"><div class="wh-cat-h"><span class="arrow open">▸</span>'
        + '<span class="wh-cat-dot" style="background:var(--jade-200)"></span>'
        + '<span class="wh-cat-label">已同步船舶</span>'
        + '<span class="wh-cat-count">' + syncedFiltered.length + ' 艘</span>'
        + '</div><div class="wh-cat-body open">';
      syncedFiltered.forEach(function (name) {
        html += renderGridRow(name, false);
      });
      html += '</div></div>';
    }

    container.innerHTML = html;
  }

  function renderGridRow(full, isUnsynced) {
    var label = showName(full);
    return '<div class="ha-grid-row">'
      + '<div class="ha-grid-top">'
      + '<span class="ha-grid-icon">🚀</span>'
      + '<span class="ha-grid-name" data-full="' + UI.escAttr(full) + '" onclick="Hangar.tapName(this)">' + UI.escHtml(label) + '</span>'
      + (isUnsynced ? '<span class="ha-grid-badge">仅本服</span>' : '')
      + '</div>'
      + '<div class="ha-row-actions">'
      + '<button class="ha-act-btn" onclick="Hangar.checkPos(\'' + UI.escAttr(full) + '\')" title="GPS 推送">📍</button>'
      + '<button class="ha-act-btn" onclick="Hangar.loadNear(\'' + UI.escAttr(full) + '\')">就近</button>'
      + '<button class="ha-act-btn" onclick="Hangar.loadLocal(\'' + UI.escAttr(full) + '\')">原地</button>'
      + '<button class="ha-act-btn ha-act-danger" onclick="Hangar.loadForceLocal(\'' + UI.escAttr(full) + '\')" title="强制原地（无碰撞检测）">强制</button>'
      + '</div>'
      + '</div>';
  }

  // ========== 加载操作 ==========

  function checkPos(name) {
    UI.showToast('success', 'GPS 已发送，请在游戏中查看');
    exec('!网格 船坞位置 ' + q(name), null).catch(function () {});
  }

  function loadNear(name) {
    exec('!网格 加载 ' + q(name), '正在取出 ' + shortName(name)).then(function () {
      loadHangar();
    }).catch(function () {});
  }

  function loadLocal(name) {
    exec('!网格 原地加载 ' + q(name), '正在原地取出 ' + shortName(name)).then(function () {
      loadHangar();
    }).catch(function () {});
  }

  function loadForceLocal(name) {
    exec('!网格 原地加载 ' + q(name) + ' false true', '强制原地加载 ' + shortName(name)).then(function () {
      loadHangar();
    }).catch(function () {});
  }

  // ========== 保存飞船 ==========

  function saveShip() {
    exec('!网格 保存', '已保存飞船').then(function () {
      loadHangar();
    }).catch(function () {});
  }

  // ========== 渲染：世界网格 ==========

  function renderWorld() {
    var container = document.getElementById('ha-world-grids');
    if (!container) return;

    var search = (document.getElementById('ha-world-search') && document.getElementById('ha-world-search').value || '').toLowerCase().trim();

    if (!worldGrids && loading) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    var filtered = (worldGrids || []).filter(function (g) {
      if (!search) return true;
      var dn = g.displayName || '';
      return dn.toLowerCase().indexOf(search) !== -1
        || shortName(dn).toLowerCase().indexOf(search) !== -1;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的网格' : '暂无活跃网格') + '</div>';
      return;
    }

    var html = '';
    applyWorldSort(filtered).forEach(function (g) {
      var dn = g.displayName || '未命名';
      var label = showName(dn);
      html += '<div class="ha-world-row">'
        + '<div class="ha-world-top">'
        + '<span class="ha-grid-icon">🚀</span>'
        + '<div class="ha-world-info">'
        + '<span class="ha-world-name" data-full="' + UI.escAttr(dn) + '" onclick="Hangar.tapName(this)">' + UI.escHtml(label) + '</span>'
        + '<span class="ha-world-meta">PCU ' + (g.pcu || 0) + ' · ' + (g.blocksCount || 0) + ' 方块 · ' + UI.fmtCompact(g.price) + ' SC</span>'
        + '</div>'
        + '</div>'
        + '<div class="ha-row-actions">'
        + '<button class="ha-world-save" onclick="Hangar.saveRemote(\'' + UI.escAttr(dn) + '\')">保存到船坞</button>'
        + '</div>'
        + '</div>';
    });
    container.innerHTML = html;
  }

  function saveRemote(name) {
    exec('!网格 保存 ' + q(name), '正在保存 ' + shortName(name)).then(function () {
      UI.showToast('success', '「' + shortName(name) + '」已保存到船坞');
      loadHangar();
    }).catch(function () {});
  }

  // ========== Tab 激活 ==========

  function onTabActivated() {
    if (!SeBridge.hasCredentials()) return;
    if (!hangarData) loadHangar();
  }

  // ========== 初始化 ==========

  // ========== 世界网格排序 ==========

  var SORT_KEYS = [
    { key: 'name', label: '名称' },
    { key: 'pcu',  label: 'PCU' },
    { key: 'blocks', label: '方块' },
    { key: 'price', label: '价值' },
  ];

  function cycleWorldSort() {
    _worldSortIdx = (_worldSortIdx + 1) % (SORT_KEYS.length * 2);
    updateSortBtn();
    renderWorld();
  }

  function updateSortBtn() {
    var btn = document.getElementById('ha-sort-btn');
    if (!btn) return;
    var asc = _worldSortIdx % 2 === 0;
    var entry = SORT_KEYS[Math.floor(_worldSortIdx / 2)];
    btn.textContent = entry.label + ' ' + (asc ? '↑' : '↓');
  }

  function applyWorldSort(list) {
    if (!list || !list.length) return list;
    var asc = _worldSortIdx % 2 === 0;
    var key = SORT_KEYS[Math.floor(_worldSortIdx / 2)].key;
    return list.slice().sort(function (a, b) {
      var va, vb;
      switch (key) {
        case 'name': va = (a.displayName || '').toLowerCase(); vb = (b.displayName || '').toLowerCase(); break;
        case 'pcu':  va = a.pcu || 0; vb = b.pcu || 0; break;
        case 'blocks': va = a.blocksCount || 0; vb = b.blocksCount || 0; break;
        case 'price': va = a.price || 0; vb = b.price || 0; break;
        default: return 0;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
  }

  // ========== 舰船市场 ==========

  var SHIP_SORT_KEYS = [
    { key: 'name', label: '名称' },
    { key: 'price', label: '售价' },
    { key: 'valuation', label: '估价' },
  ];

  function loadShipMarket() {
    if (shipMarketLoading) return;
    shipMarketLoading = true;
    renderShipMarket();
    exec('!网格 市场', null).then(function (d) {
      shipMarketData = d;
      shipMarketLoading = false;
      renderShipMarket();
    }).catch(function () {
      shipMarketData = null;
      shipMarketLoading = false;
      renderShipMarket();
    });
  }

  function renderShipMarket() {
    var container = document.getElementById('hm-content');
    if (!container) return;

    if (!shipMarketData && shipMarketLoading) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    // 离线 / 加载失败
    if (!shipMarketData) {
      container.innerHTML = '<div class="hm-offline">'
        + '<div class="hm-offline-icon">🔌</div>'
        + '<div class="hm-offline-text">舰船市场需要您在游戏中在线</div>'
        + '<div class="hm-offline-hint">请登录游戏后再试</div>'
        + '<button class="hm-retry-btn" onclick="Hangar.loadShipMarket()">重试</button>'
        + '</div>';
      document.getElementById('hm-coupon').style.display = 'none';
      return;
    }

    renderShipMarketCoupon();

    var search = (document.getElementById('hm-search').value || '').toLowerCase().trim();
    var serverShips = (shipMarketData.serverShips || []).slice();
    var playerShips = (shipMarketData.playerShips || []).slice();

    var filteredServer = search ? serverShips.filter(function (s) { return (s.shipName || '').toLowerCase().indexOf(search) !== -1; }) : serverShips;
    var filteredPlayer = search ? playerShips.filter(function (s) { return (s.shipName || '').toLowerCase().indexOf(search) !== -1; }) : playerShips;

    var html = '';
    if (filteredServer.length > 0) {
      html += '<div class="wh-cat"><div class="wh-cat-h" onclick="var b=this.parentElement.querySelector(\'.wh-cat-body\');var a=this.querySelector(\'.arrow\');b.classList.toggle(\'open\');a.classList.toggle(\'open\')">'
        + '<span class="arrow open">▸</span>'
        + '<span class="wh-cat-dot" style="background:var(--jade-200)"></span>'
        + '<span class="wh-cat-label">服营舰船</span>'
        + '<span class="wh-cat-count">' + filteredServer.length + ' 艘</span>'
        + '</div><div class="wh-cat-body open">';
      applyShipSort(filteredServer).forEach(function (s) { html += renderShipCard(s, 'server'); });
      html += '</div></div>';
    }
    if (filteredPlayer.length > 0) {
      html += '<div class="wh-cat"><div class="wh-cat-h" onclick="var b=this.parentElement.querySelector(\'.wh-cat-body\');var a=this.querySelector(\'.arrow\');b.classList.toggle(\'open\');a.classList.toggle(\'open\')">'
        + '<span class="arrow open">▸</span>'
        + '<span class="wh-cat-dot" style="background:var(--blue-200)"></span>'
        + '<span class="wh-cat-label">玩家舰船</span>'
        + '<span class="wh-cat-count">' + filteredPlayer.length + ' 艘</span>'
        + '</div><div class="wh-cat-body open">';
      applyShipSort(filteredPlayer).forEach(function (s) { html += renderShipCard(s, 'player'); });
      html += '</div></div>';
    }
    if (!html) {
      container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的舰船' : '暂无舰船在售') + '</div>';
      return;
    }
    container.innerHTML = html;
  }

  function renderShipMarketCoupon() {
    var couponEl = document.getElementById('hm-coupon');
    if (!couponEl) return;
    var coupons = shipMarketData.availableCoupons || 0;
    var value = shipMarketData.couponValue || 0;
    if (coupons <= 0) { couponEl.style.display = 'none'; return; }
    couponEl.style.display = '';
    couponEl.innerHTML = '<div class="hm-coupon-bar">'
      + '<span class="hm-coupon-icon">🎟️</span>'
      + '<span class="hm-coupon-info">可用折扣券 <strong>' + coupons + '</strong> 张，每张抵扣 <strong>' + UI.fmtCompact(value) + ' SC</strong></span>'
      + '</div>';
  }

  function renderShipCard(ship, type) {
    var priceAfterCoupon = ship.sellPrice;
    var couponInfo = '';
    if (type === 'server' && shipMarketData.availableCoupons > 0 && shipMarketData.couponValue > 0) {
      var discount = Math.min(shipMarketData.availableCoupons * shipMarketData.couponValue, ship.sellPrice);
      priceAfterCoupon = Math.max(0, ship.sellPrice - discount);
      if (discount > 0) {
        couponInfo = '<span class="hm-price-after">券后 ' + UI.fmtCompact(priceAfterCoupon) + ' SC</span>';
      }
    }
    // 可选描述（后端可能尚未同步该字段）
    var descHtml = '';
    if (ship.description && String(ship.description).trim()) {
      descHtml = '<div class="hm-ship-desc" onclick="var n=this.nextElementSibling;var a=this.querySelector(\'.hm-desc-arrow\');var o=n.style.display===\'none\';n.style.display=o?\'\':\'none\';a.classList.toggle(\'open\',o);this.classList.toggle(\'open\',o)">'
        + '<span class="hm-desc-arrow">▸</span>'
        + '<span class="hm-desc-label">简介</span>'
        + '</div>'
        + '<div class="hm-ship-desc-body" style="display:none">'
        + UI.escHtml(String(ship.description).trim())
        + '</div>';
    }
    return '<div class="hm-ship-card">'
      + '<div class="hm-ship-top">'
      + '<span class="hm-ship-icon">🚀</span>'
      + '<div class="hm-ship-info">'
      + '<span class="hm-ship-name">' + UI.escHtml(ship.shipName || '未命名') + '</span>'
      + '<span class="hm-ship-id">#' + UI.escHtml(String(ship.id)) + '</span>'
      + '</div>'
      + '</div>'
      + '<div class="hm-ship-meta">'
      + '<span class="hm-ship-val">估价 ' + UI.fmtCompact(ship.valuation || 0) + ' SC</span>'
      + '<span class="hm-ship-arrow">→</span>'
      + '<span class="hm-ship-price">售价 ' + UI.fmtCompact(ship.sellPrice || 0) + ' SC</span>'
      + couponInfo
      + '</div>'
      + descHtml
      + '<div class="hm-ship-actions">'
      + '<button class="hm-buy-btn" onclick="Hangar.buyShip(\'' + UI.escAttr(String(ship.id)) + '\',\'' + UI.escAttr(ship.shipName || '') + '\')">购买</button>'
      + '</div>'
      + '</div>';
  }

  function buyShip(id, name) {
    var ship = findShipById(id);
    if (!ship) return;
    var finalPrice = ship.sellPrice;
    var couponNote = '';
    if (shipMarketData.availableCoupons > 0 && shipMarketData.couponValue > 0) {
      var maxDiscount = Math.min(shipMarketData.availableCoupons * shipMarketData.couponValue, ship.sellPrice);
      finalPrice = Math.max(0, ship.sellPrice - maxDiscount);
      if (maxDiscount > 0) {
        couponNote = '\n折扣券: ' + shipMarketData.availableCoupons + ' 张 × ' + UI.fmtCompact(shipMarketData.couponValue) + ' SC = -' + UI.fmtCompact(maxDiscount) + ' SC';
      }
    }
    UI.showConfirmDialog(
      '购买舰船「' + name + '」？\n售价: ' + UI.fmtCompact(ship.sellPrice) + ' SC' + couponNote + '\n最终价格: ' + UI.fmtCompact(finalPrice) + ' SC',
      function () {
        exec('!网格 购买 ' + id, '已购买「' + name + '」').then(function () { loadShipMarket(); loadHangar(); }).catch(function () {});
      }
    );
  }

  function sellShip() {
    UI.showPromptDialog('出售飞船', '请输入出售价格（SC）', function (val) {
      var p = parseInt(val, 10);
      if (isNaN(p) || p < 0) { UI.showToast('error', '请输入有效价格'); return; }
      UI.showConfirmDialog(
        '确定以 ' + UI.fmtCompact(p) + ' SC 出售瞄准的飞船？',
        function () {
          exec('!网格 出售 ' + p + ' ""', '已上架飞船').then(function () {
            loadHangar(); loadShipMarket();
          }).catch(function () {});
        }
      );
    });
  }

  function findShipById(id) {
    var all = (shipMarketData.serverShips || []).concat(shipMarketData.playerShips || []);
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].id) === String(id)) return all[i];
    }
    return null;
  }

  function cycleShipSort() {
    _shipMarketSortIdx = (_shipMarketSortIdx + 1) % (SHIP_SORT_KEYS.length * 2);
    updateShipSortBtn();
    renderShipMarket();
  }

  function updateShipSortBtn() {
    var btn = document.getElementById('hm-sort-btn');
    if (!btn) return;
    var asc = _shipMarketSortIdx % 2 === 0;
    var entry = SHIP_SORT_KEYS[Math.floor(_shipMarketSortIdx / 2)];
    btn.textContent = entry.label + ' ' + (asc ? '↑' : '↓');
  }

  function applyShipSort(list) {
    if (!list || !list.length) return list;
    var asc = _shipMarketSortIdx % 2 === 0;
    var key = SHIP_SORT_KEYS[Math.floor(_shipMarketSortIdx / 2)].key;
    return list.slice().sort(function (a, b) {
      var va, vb;
      if (key === 'name') { va = (a.shipName || '').toLowerCase(); vb = (b.shipName || '').toLowerCase(); }
      else if (key === 'price') { va = a.sellPrice || 0; vb = b.sellPrice || 0; }
      else if (key === 'valuation') { va = a.valuation || 0; vb = b.valuation || 0; }
      else return 0;
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
  }

  function initShipMarket() {
    var sortBtn = document.getElementById('hm-sort-btn');
    if (sortBtn) sortBtn.addEventListener('click', cycleShipSort);
    var searchInput = document.getElementById('hm-search');
    if (searchInput) searchInput.addEventListener('input', function () { renderShipMarket(); });
  }

  // ========== 初始化 ==========

  function init() {
    initSubTabs();

    // 名称切换按钮
    var nameToggle = document.getElementById('ha-name-toggle');
    if (nameToggle) nameToggle.addEventListener('click', toggleNameFmt);

    // 搜索
    var searchInput = document.getElementById('ha-search');
    if (searchInput) searchInput.addEventListener('input', function () { renderMy(); });
    var worldSearch = document.getElementById('ha-world-search');
    if (worldSearch) worldSearch.addEventListener('input', function () { renderWorld(); });

    // 排序按钮
    var sortBtn = document.getElementById('ha-sort-btn');
    if (sortBtn) sortBtn.addEventListener('click', cycleWorldSort);

    // 工具栏按钮
    var saveBtn = document.getElementById('ha-save');
    if (saveBtn) saveBtn.addEventListener('click', saveShip);
    var sellBtn = document.getElementById('ha-sell');
    if (sellBtn) sellBtn.addEventListener('click', sellShip);

    updateSortBtn();

    // 舰船市场
    initShipMarket();
  }

  // ========== 工具函数 ==========


  return {
    init: init,
    onTabActivated: onTabActivated,
    switchSubTab: switchSubTab,
    load: loadHangar,
    loadWorldGrids: loadWorldGrids,
    toggleNameFmt: toggleNameFmt,
    tapName: tapName,
    checkPos: checkPos,
    loadNear: loadNear,
    loadLocal: loadLocal,
    loadForceLocal: loadForceLocal,
    saveShip: saveShip,
    saveRemote: saveRemote,
    // 舰船市场
    loadShipMarket: loadShipMarket,
    buyShip: buyShip, sellShip: sellShip,
  };
})();
