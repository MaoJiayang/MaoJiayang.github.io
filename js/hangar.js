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
    document.querySelectorAll('.ha-subtab').forEach(function (el) {
      el.classList.toggle('active', el.dataset.haTab === tab);
    });
    document.querySelectorAll('.ha-section').forEach(function (el) {
      el.style.display = el.id === 'hangar-' + tab ? 'block' : 'none';
    });
    if (tab === 'my' && !hangarData && !loading) loadHangar();
    if (tab === 'world' && !worldGrids && !loading) loadWorldGrids();
    if (tab === 'market') { /* 占位 */ }
  }

  function initSubTabs() {
    document.querySelectorAll('.ha-subtab').forEach(function (el) {
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

    if (!hangarData || loading) {
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

    container.innerHTML = html;
  }

  function renderGridRow(full, isUnsynced) {
    var label = showName(full);
    return '<div class="ha-grid-row">'
      + '<span class="ha-grid-icon">🚀</span>'
      + '<div class="ha-grid-info">'
      + '<span class="ha-grid-name" data-full="' + escAttr(full) + '" onclick="Hangar.tapName(this)">' + escHtml(label) + '</span>'
      + (isUnsynced ? '<span class="ha-grid-badge">仅本服</span>' : '')
      + '</div>'
      + '<div class="ha-row-actions">'
      + '<button class="ha-act-btn" onclick="Hangar.checkPos(\'' + escAttr(full) + '\')" title="GPS 推送">📍</button>'
      + '<button class="ha-act-btn" onclick="Hangar.loadNear(\'' + escAttr(full) + '\')">就近</button>'
      + '<button class="ha-act-btn" onclick="Hangar.loadLocal(\'' + escAttr(full) + '\')">原地</button>'
      + '<button class="ha-act-btn ha-act-danger" onclick="Hangar.loadForceLocal(\'' + escAttr(full) + '\')" title="强制原地（无碰撞检测）">强制</button>'
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

    if (!worldGrids || loading) {
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
        + '<span class="ha-grid-icon">🚀</span>'
        + '<div class="ha-world-info">'
        + '<span class="ha-world-name" data-full="' + escAttr(dn) + '" onclick="Hangar.tapName(this)">' + escHtml(label) + '</span>'
        + '<span class="ha-world-meta">PCU ' + (g.pcu || 0) + ' · ' + (g.blocksCount || 0) + ' 方块 · ' + formatNum(g.price) + ' SC</span>'
        + '</div>'
        + '<button class="ha-world-save" onclick="Hangar.saveRemote(\'' + escAttr(dn) + '\')">保存到船坞</button>'
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

    // 保存按钮
    var saveBtn = document.getElementById('ha-save');
    if (saveBtn) saveBtn.addEventListener('click', saveShip);

    updateSortBtn();
  }

  // ========== 工具函数 ==========

  function formatNum(n) {
    if (n == null) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, '') + 'k';
    return Number(n).toLocaleString();
  }

  function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function escAttr(s) { return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

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
  };
})();
