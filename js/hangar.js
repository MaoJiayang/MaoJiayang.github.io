/**
 * Hangar Panel — 船坞面板（我的船坞 + 世界网格 + 舰船市场占位）
 * 依赖: UI, SeBridge, Warehouse（全局）
 */
var Hangar = (function () {
  'use strict';

  var SUBTABS = ['my', 'world', 'market'];
  var currentSubTab = 'my';
  var hangarData = null;        // { grids: string[], unsyncedGrids: string[] }
  var worldGrids = null;        // GridVO[]
  var loading = false;

  // ========== 通用执行 ==========

  function exec(cmd, okLabel) {
    return UI.executeWithConfirm(cmd, okLabel);
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

  // ========== 渲染：我的船坞 ==========

  function renderMy() {
    var container = document.getElementById('ha-grids');
    if (!container) return;

    var search = (document.getElementById('ha-search') && document.getElementById('ha-search').value || '').toLowerCase().trim();

    if (!hangarData || loading) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    var allGrids = (hangarData.grids || []).concat(hangarData.unsyncedGrids || []);
    var filtered = allGrids.filter(function (name) {
      return !search || name.toLowerCase().indexOf(search) !== -1;
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
        + '</div><div class="wh-cat-body open"><div class="wh-grid">';
      syncedFiltered.forEach(function (name) {
        html += renderGridCard(name, false);
      });
      html += '</div></div></div>';
    }

    if (unsyncedFiltered.length > 0) {
      html += '<div class="wh-cat"><div class="wh-cat-h"><span class="arrow open">▸</span>'
        + '<span class="wh-cat-dot" style="background:var(--color-warn)"></span>'
        + '<span class="wh-cat-label">未同步船舶</span>'
        + '<span class="wh-cat-count">' + unsyncedFiltered.length + ' 艘</span>'
        + '</div><div class="wh-cat-body open"><div class="wh-grid">';
      unsyncedFiltered.forEach(function (name) {
        html += renderGridCard(name, true);
      });
      html += '</div></div></div>';
    }

    container.innerHTML = html;
  }

  function renderGridCard(name, isUnsynced) {
    return '<div class="ha-grid-card" onclick="Hangar.showLoadOptions(this,\'' + escAttr(name) + '\')">'
      + '<span class="ha-grid-icon">🚀</span>'
      + '<div class="ha-grid-info">'
      + '<span class="ha-grid-name">' + escHtml(name) + '</span>'
      + (isUnsynced ? '<span class="ha-grid-badge">仅本服</span>' : '')
      + '</div>'
      + '<span class="ha-grid-btn">加载</span>'
      + '<div class="ha-load-actions" style="display:none"></div>'
      + '</div>';
  }

  // ========== 加载选项面板 ==========

  var _activeLoadCard = null;

  function showLoadOptions(card, name) {
    // 关闭之前打开的选项面板
    if (_activeLoadCard && _activeLoadCard !== card) {
      var oldActions = _activeLoadCard.querySelector('.ha-load-actions');
      if (oldActions) oldActions.style.display = 'none';
    }
    _activeLoadCard = card;
    var actions = card.querySelector('.ha-load-actions');
    if (!actions) return;
    var isOpen = actions.style.display !== 'none';
    if (isOpen) {
      actions.style.display = 'none';
      return;
    }
    actions.innerHTML = ''
      + '<button class="ha-load-btn" onclick="event.stopPropagation();Hangar.checkPos(\'' + escAttr(name) + '\')">📍 查看保存位置</button>'
      + '<button class="ha-load-btn" onclick="event.stopPropagation();Hangar.loadNear(\'' + escAttr(name) + '\')">就近加载</button>'
      + '<button class="ha-load-btn" onclick="event.stopPropagation();Hangar.loadLocal(\'' + escAttr(name) + '\')">原地加载</button>'
      + '<button class="ha-load-btn ha-load-danger" onclick="event.stopPropagation();Hangar.loadForceLocal(\'' + escAttr(name) + '\')">强制原地</button>';
    actions.style.display = 'flex';
  }

  /** 📍 查看保存位置 */
  function checkPos(name) {
    UI.showToast('success', 'GPS 已发送，请在游戏中查看');
    exec('!网格 船坞位置 ' + name, null).catch(function () {});
    closeLoadOptions();
  }

  /** 就近加载 */
  function loadNear(name) {
    closeLoadOptions();
    exec('!网格 加载 ' + name, '正在取出 ' + name).then(function () {
      loadHangar();
    }).catch(function () {});
  }

  /** 原地加载 */
  function loadLocal(name) {
    closeLoadOptions();
    exec('!网格 原地加载 ' + name, '正在原地取出 ' + name).then(function () {
      loadHangar();
    }).catch(function () {});
  }

  /** 强制原地（无碰撞检测，危险） */
  function loadForceLocal(name) {
    closeLoadOptions();
    exec('!网格 原地加载 ' + name + ' false true', '强制原地加载 ' + name).then(function () {
      loadHangar();
    }).catch(function () {});
  }

  function closeLoadOptions() {
    if (_activeLoadCard) {
      var actions = _activeLoadCard.querySelector('.ha-load-actions');
      if (actions) actions.style.display = 'none';
      _activeLoadCard = null;
    }
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
      return !search || (g.displayName && g.displayName.toLowerCase().indexOf(search) !== -1);
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的网格' : '暂无活跃网格') + '</div>';
      return;
    }

    var html = '';
    filtered.forEach(function (g) {
      html += '<div class="ha-world-card">'
        + '<span class="ha-grid-icon">🚀</span>'
        + '<div class="ha-world-info">'
        + '<span class="ha-world-name">' + escHtml(g.displayName || '未命名') + '</span>'
        + '<span class="ha-world-meta">PCU ' + (g.pcu || 0) + ' · ' + (g.blocksCount || 0) + ' 方块 · ' + formatNum(g.price) + ' SC</span>'
        + '</div>'
        + '<button class="ha-world-save" onclick="event.stopPropagation();Hangar.saveRemote(\'' + escAttr(g.displayName || '') + '\')">保存到船坞</button>'
        + '</div>';
    });
    container.innerHTML = html;
  }

  /** 远程保存：发 !网格 保存 <name> */
  function saveRemote(name) {
    exec('!网格 保存 ' + name, '正在保存 ' + name).then(function () {
      UI.showToast('success', '「' + name + '」已保存到船坞');
      loadHangar();
    }).catch(function () {});
  }

  // ========== Tab 激活 ==========

  function onTabActivated() {
    if (!SeBridge.hasCredentials()) return;
    if (!hangarData) loadHangar();
  }

  // ========== 初始化 ==========

  function init() {
    initSubTabs();

    // 搜索
    var searchInput = document.getElementById('ha-search');
    if (searchInput) searchInput.addEventListener('input', function () { renderMy(); });
    var worldSearch = document.getElementById('ha-world-search');
    if (worldSearch) worldSearch.addEventListener('input', function () { renderWorld(); });

    // 保存按钮
    var saveBtn = document.getElementById('ha-save');
    if (saveBtn) saveBtn.addEventListener('click', saveShip);
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
    showLoadOptions: showLoadOptions,
    checkPos: checkPos,
    loadNear: loadNear,
    loadLocal: loadLocal,
    loadForceLocal: loadForceLocal,
    saveShip: saveShip,
    saveRemote: saveRemote,
  };
})();
