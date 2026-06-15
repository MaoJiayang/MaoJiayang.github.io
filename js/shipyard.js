/**
 * Shipyard Panel — 船厂面板（建造队列 + 模板管理 + 自动建造）
 * 依赖: UI, SeBridge（全局）
 */
var Shipyard = (function () {
  'use strict';

  var SUBTABS = ['queue', 'templates', 'autobuild'];
  var currentSubTab = 'queue';
  var queueData = null;          // { assemblyLines, pendingMissions }
  var templateData = null;       // { quotaUsed, quotaTotal, templates }
  var loading = false;

  // ========== 通用执行 ==========

  function exec(cmd, okLabel) {
    return UI.executeWithConfirm(cmd, okLabel);
  }

  // ========== 子 Tab 切换 ==========

  function switchSubTab(tab) {
    if (tab === currentSubTab) return;
    currentSubTab = tab;
    document.querySelectorAll('.st-tab[data-sy-tab]').forEach(function (el) {
      el.classList.toggle('active', el.dataset.syTab === tab);
    });
    document.querySelectorAll('.sy-section').forEach(function (el) {
      el.style.display = el.id === 'shipyard-' + tab ? 'block' : 'none';
    });
    if (tab === 'queue' && !queueData && !loading) loadAll();
    if (tab === 'templates' && !templateData && !loading) loadAll();
    if (tab === 'autobuild') { /* 仅按钮 */ }
  }

  function initSubTabs() {
    document.querySelectorAll('.st-tab[data-sy-tab]').forEach(function (el) {
      el.addEventListener('click', function () {
        switchSubTab(el.dataset.syTab);
      });
    });
  }

  // ========== 数据加载 ==========

  function loadAll() {
    if (loading) return;
    loading = true;
    renderQueue();
    renderTemplates();

    var p1 = exec('!船厂 列表', null).then(function (d) {
      queueData = d || { assemblyLines: [], pendingMissions: [] };
    }).catch(function () {
      queueData = { assemblyLines: [], pendingMissions: [] };
    });

    var p2 = exec('!模板 列表', null).then(function (d) {
      templateData = d || { quotaUsed: 0, quotaTotal: 0, templates: [] };
    }).catch(function () {
      templateData = { quotaUsed: 0, quotaTotal: 0, templates: [] };
    });

    Promise.all([p1, p2]).then(function () {
      loading = false;
      renderQueue();
      renderTemplates();
    }).catch(function () {
      loading = false;
      renderQueue();
      renderTemplates();
    });
  }

  function refreshQueue() {
    exec('!船厂 列表', null).then(function (d) {
      queueData = d || { assemblyLines: [], pendingMissions: [] };
      renderQueue();
    }).catch(function () {});
  }

  function refreshTemplates() {
    exec('!模板 列表', null).then(function (d) {
      templateData = d || { quotaUsed: 0, quotaTotal: 0, templates: [] };
      renderTemplates();
    }).catch(function () {});
  }

  // ========== 时间格式化 ==========

  /** 秒数 → mm:ss（≥1h 时 h:mm:ss） */
  function fmtTime(sec) {
    if (sec == null || isNaN(sec) || sec < 0) return '--';
    var s = Math.floor(sec);
    var m = Math.floor(s / 60);
    s = s % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + ':' + pad2(m) + ':' + pad2(s);
    }
    return m + ':' + pad2(s);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 进度条宽度百分比 */
  function pct(done, total) {
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.round((done / total) * 100));
  }

  // ========== 渲染：建造队列 ==========

  function renderQueue() {
    var container = document.getElementById('sy-queue');
    if (!container) return;

    if (!queueData && loading) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    var lines = queueData.assemblyLines || [];
    var pending = queueData.pendingMissions || [];
    var html = '';

    // 流水线
    lines.forEach(function (al) {
      var busy = al.currentMission != null;
      var type = busy ? (al.currentMission.type && al.currentMission.type.indexOf('回收') !== -1 ? '♻ 回收' : '🔧 建造') : '';
      var name = busy ? al.currentMission.gridName : '';
      var statusLabel = busy ? '执行中' : '空闲';
      var statusCls = busy ? 'sy-status-active' : 'sy-status-idle';

      html += '<div class="sy-line-card' + (busy ? '' : ' sy-idle') + '">'
        + '<div class="sy-line-header">'
        + '<span class="sy-line-title">流水线 ' + (al.index != null ? al.index : '?') + '</span>'
        + '<span class="sy-line-status ' + statusCls + '">' + statusLabel + '</span>'
        + '</div>';

      if (busy) {
        var done = al.currentMission.progressSeconds || 0;
        var total = al.currentMission.totalSeconds || 0;
        var w = pct(done, total);
        html += '<div class="sy-mission-info">'
          + '<span class="sy-mission-type">' + type + '</span>'
          + '<span class="sy-mission-name">' + UI.escHtml(name) + '</span>'
          + '</div>'
          + '<div class="sy-progress">'
          + '<span class="sy-progress-bar"><span class="sy-progress-fill" style="width:' + w + '%"></span></span>'
          + '<span class="sy-progress-text">' + fmtTime(done) + ' / ' + fmtTime(total) + '</span>'
          + '</div>';
      }
      html += '</div>';
    });

    // 排队任务
    if (pending.length > 0) {
      html += '<div class="wh-cat"><div class="wh-cat-h"><span class="arrow open">▸</span>'
        + '<span class="wh-cat-dot" style="background:var(--color-warn)"></span>'
        + '<span class="wh-cat-label">排队任务</span>'
        + '<span class="wh-cat-count">' + pending.length + ' 个</span>'
        + '</div><div class="wh-cat-body open">';

      pending.forEach(function (m) {
        var hasMsg = m.message && m.message !== 'null';
        html += '<div class="sy-pending-row">'
          + '<div class="sy-pending-info">'
          + '<span class="sy-mission-type">' + (m.type && m.type.indexOf('回收') !== -1 ? '♻ 回收' : '🔧 建造') + '</span>'
          + '<span class="sy-mission-name">' + UI.escHtml(m.gridName || '?') + '</span>'
          + (hasMsg ? '<span class="sy-mission-msg">⚠ ' + UI.escHtml(m.message) + '</span>' : '')
          + '</div>'
          + '<button class="ha-act-btn ha-act-danger" onclick="Shipyard.cancelMission(' + (m.index || 0) + ')">取消</button>'
          + '</div>';
      });
      html += '</div></div>';
    }

    container.innerHTML = html || '<div class="tr-empty">暂无建造任务</div>';
  }

  // ========== 渲染：模板 ==========

  function renderTemplates() {
    var container = document.getElementById('sy-templates');
    if (!container) return;

    if (!templateData && loading) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    var templates = templateData.templates || [];
    var used = templateData.quotaUsed || 0;
    var total = templateData.quotaTotal || 0;

    var html = '<div class="sy-quota">已用 <strong>' + used + '</strong> / ' + total + ' 个模板 <span class="sy-refresh-inline" onclick="Shipyard.loadAll()" title="刷新">↻</span></div>';

    if (templates.length === 0) {
      html += '<div class="tr-empty">暂无模板</div>';
    } else {
      templates.forEach(function (t) {
        html += '<div class="sy-template-row">'
          + '<span class="sy-template-name">' + UI.escHtml(t) + '</span>'
          + '<div class="sy-template-actions">'
          + '<button class="ha-act-btn" onclick="Shipyard.build(\'' + UI.escAttr(t) + '\')">建造</button>'
          + '<button class="ha-act-btn ha-act-danger" onclick="Shipyard.deleteTemplate(\'' + UI.escAttr(t) + '\')">删除</button>'
          + '</div>'
          + '</div>';
      });
    }

    container.innerHTML = html;
  }

  // ========== 操作 ==========

  /** 从模板建造 */
  function build(templateName) {
    exec('!船厂 建造 ' + templateName, '已下单建造 ' + templateName).then(function () {
      refreshQueue();
    }).catch(function () {});
  }

  /** 从投影建造 */
  function buildProjection() {
    exec('!船厂 建造投影', '已下单从投影建造').then(function () {
      refreshQueue();
    }).catch(function () {});
  }

  /** 回收飞船 */
  function recycle() {
    document.getElementById('dc-msg').textContent = '确定要回收飞船吗？';
    document.getElementById('dc-confirm-btn').textContent = '确认回收';
    document.getElementById('dc-confirm-btn').onclick = function () {
      UI.closeDcDialog();
      exec('!船厂 回收', '回收已提交').then(function () {
        refreshQueue();
      }).catch(function () {});
    };
    document.getElementById('dc-overlay').classList.add('show');
  }

  /** 取消排队任务 */
  function cancelMission(index) {
    document.getElementById('dc-msg').textContent = '确定要取消排队任务 #' + index + ' 吗？';
    document.getElementById('dc-confirm-btn').textContent = '取消任务';
    document.getElementById('dc-confirm-btn').onclick = function () {
      UI.closeDcDialog();
      exec('!船厂 取消 ' + index, '已取消任务 #' + index).then(function () {
        refreshQueue();
      }).catch(function () {});
    };
    document.getElementById('dc-overlay').classList.add('show');
  }

  /** 保存模板 */
  function saveTemplate() {
    UI.showPromptDialog('保存模板', '请输入模板名称', function (name) {
      exec('!模板 保存 ' + name, '模板「' + name + '」已保存').then(function () {
        refreshTemplates();
      }).catch(function () {});
    });
  }

  /** 从投影创建模板 */
  function createFromProjector() {
    UI.showPromptDialog('从投影创建模板', '请输入模板名称', function (name) {
      exec('!模板 从投影创建 ' + name, '模板「' + name + '」已创建').then(function () {
        refreshTemplates();
      }).catch(function () {});
    });
  }

  /** 删除模板 */
  function deleteTemplate(name) {
    document.getElementById('dc-msg').textContent = '确定要删除模板「' + name + '」吗？';
    document.getElementById('dc-confirm-btn').textContent = '删除模板';
    document.getElementById('dc-confirm-btn').onclick = function () {
      UI.closeDcDialog();
      exec('!模板 删除 ' + name, '模板「' + name + '」已删除').then(function () {
        refreshTemplates();
      }).catch(function () {});
    };
    document.getElementById('dc-overlay').classList.add('show');
  }

  /** 自动建造 */
  function autoBuild() {
    exec('!网格 自动建造', '自动建造已开启').catch(function () {});
  }

  // ========== Tab 激活 ==========

  function onTabActivated() {
    if (!SeBridge.hasCredentials()) return;
    if (!queueData && !templateData) loadAll();
  }

  // ========== 初始化 ==========

  function init() {
    initSubTabs();

    // 操作按钮
    var btnProj = document.getElementById('sy-build-proj');
    if (btnProj) btnProj.addEventListener('click', buildProjection);
    var btnRecycle = document.getElementById('sy-recycle');
    if (btnRecycle) btnRecycle.addEventListener('click', recycle);
    var btnSaveTpl = document.getElementById('sy-save-tpl');
    if (btnSaveTpl) btnSaveTpl.addEventListener('click', saveTemplate);
    var btnProjTpl = document.getElementById('sy-proj-tpl');
    if (btnProjTpl) btnProjTpl.addEventListener('click', createFromProjector);
    var btnAuto = document.getElementById('sy-autobuild-btn');
    if (btnAuto) btnAuto.addEventListener('click', autoBuild);
  }

  // ========== 工具函数 ==========


  return {
    init: init,
    onTabActivated: onTabActivated,
    loadAll: loadAll,
    switchSubTab: switchSubTab,
    build: build,
    buildProjection: buildProjection,
    recycle: recycle,
    cancelMission: cancelMission,
    saveTemplate: saveTemplate,
    createFromProjector: createFromProjector,
    deleteTemplate: deleteTemplate,
    autoBuild: autoBuild,
  };
})();
