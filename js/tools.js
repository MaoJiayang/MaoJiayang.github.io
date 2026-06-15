/**
 * Tools Panel — 工具面板（战斗、网格操作、安全区、任务、信息查询）
 * 依赖: UI, SeBridge（全局）
 */
var Tools = (function () {
  'use strict';

  // ========== 当前挑战列表（可扩展） ==========

  var CHALLENGES = [
    { id: 'ch1', label: 'CH 1', group: 'ch' },
    { id: 'ch2', label: 'CH 2', group: 'ch' },
    { id: 'ch3', label: 'CH 3', group: 'ch' },
    { id: 'ls1', label: 'LS 1', group: 'ls' },
  ];

  // ========== 通用指令执行 ==========

  /**
   * 通用执行：限流检查 + 二次确认 + Toast
   * @param {string} cmd   完整指令
   * @param {string} label Toast 成功文案
   */
  function exec(cmd, label) {
    if (!SeBridge.hasCredentials()) { UI.showLoginGuide(); return; }
    UI.executeWithConfirm(cmd, label).catch(function () {});
  }

  // ========== 战斗 - 挑战选择器 ==========

  var _chOverlay = null;

  function openChallengePicker() {
    if (!SeBridge.hasCredentials()) { UI.showLoginGuide(); return; }

    if (!_chOverlay) {
      _chOverlay = UI.createOverlay('challenge-overlay',
        '<div class="tl-ch-header">选择挑战级别</div>' +
        '<div id="tl-ch-groups"></div>',
        { onBackdrop: function () { _chOverlay.hide(); } }
      );

      // 按 group 分组渲染按钮
      var groupsEl = _chOverlay.get('#tl-ch-groups');
      var groups = {};
      CHALLENGES.forEach(function (c) {
        if (!groups[c.group]) groups[c.group] = [];
        groups[c.group].push(c);
      });

      var groupLabels = { ch: '标准挑战', ls: '合作挑战' };
      Object.keys(groups).forEach(function (group) {
        var label = groupLabels[group] || '';
        if (label) {
          var lblEl = document.createElement('div');
          lblEl.className = 'tl-ch-group-label';
          lblEl.textContent = label;
          groupsEl.appendChild(lblEl);
        }
        var grid = document.createElement('div');
        grid.className = 'tl-ch-grid';
        groups[group].forEach(function (c) {
          var btn = document.createElement('button');
          btn.className = 'tl-ch-btn';
          btn.textContent = c.label;
          btn.addEventListener('click', function () {
            _chOverlay.hide();
            var cmd = '!挑战 ' + c.id;
            exec(cmd, c.label);
          });
          grid.appendChild(btn);
        });
        groupsEl.appendChild(grid);
      });
    }

    _chOverlay.show();
  }

  // ========== 战斗 - 决斗 ==========

  function duel(smallShip) {
    var cmd = smallShip ? '!决斗 匹配 true' : '!决斗 匹配';
    exec(cmd, '决斗匹配');
  }

  // ========== 网格操作 - 降落 ==========

  function promptLanding() {
    if (!SeBridge.hasCredentials()) { UI.showLoginGuide(); return; }
    UI.showPromptDialog('请输入降落高度 (0~100)', '例: 50', function (val) {
      var h = parseInt(val, 10);
      if (isNaN(h) || h < 0 || h > 100) {
        UI.showToast('error', '高度必须在 0~100 之间');
        return;
      }
      exec('!网格 降落 ' + h, '降落指令已发送');
    });
  }

  // ========== 投票重启 ==========

  function voteRestart() {
    if (!SeBridge.hasCredentials()) { UI.showLoginGuide(); return; }
    UI.showConfirmDialog('确定要发起投票重启吗？这将影响全服玩家。', function () {
      exec('!投票重启', '投票重启已发起');
    });
  }

  // ========== 全服任务 - 交付 ==========

  function openMissionDelivery() {
    if (!SeBridge.hasCredentials()) { UI.showLoginGuide(); return; }
    // 跳转仓库面板，进入交付选择模式
    Warehouse.enterSelectionMode('deposit', function (itemName) {
      Warehouse.exitSelectionMode();
      // 弹出 QSheet 选数量，确认时执行交付指令
      UI.openQSheet('deposit', '任务交付: ' + itemName, {
        stock: Warehouse.getStock(itemName) || 999999,
        confirmLabel: '交付',
        onConfirm: function (mode, qty) {
          exec('!任务 交付 ' + itemName + ' ' + qty, '已交付 ' + qty + ' 个 ' + itemName);
        }
      });
    });
    UI.switchTab('warehouse');
  }

  // ========== 分类折叠 ==========

  function toggle(hdrEl) {
    var catEl = hdrEl.parentElement;
    var arrow = hdrEl.querySelector('.arrow');
    var body = catEl.querySelector('.tl-cat-body');
    var wasOpen = arrow.classList.contains('open');

    // 关闭其他分类
    document.querySelectorAll('#panel-tools .tl-cat-h').forEach(function (h) {
      h.querySelector('.arrow').classList.remove('open');
      var b = h.parentElement.querySelector('.tl-cat-body');
      if (b) b.classList.remove('open');
    });

    if (!wasOpen) {
      arrow.classList.add('open');
      if (body) body.classList.add('open');
    }
  }

  // ========== Tab 激活 ==========

  function onTabActivated() {
    // 无懒加载数据，仅占位
  }

  // ========== 初始化 ==========

  function init() {
    // 所有按钮通过 HTML onclick 绑定，无需额外操作
  }

  return {
    init: init,
    onTabActivated: onTabActivated,
    toggle: toggle,
    exec: exec,
    openChallengePicker: openChallengePicker,
    duel: duel,
    promptLanding: promptLanding,
    voteRestart: voteRestart,
    openMissionDelivery: openMissionDelivery,
  };
})();
