/**
 * Settings Panel — 设置面板（账号 + 显示 + 关于 + 赞赏）
 * 依赖: UI, SeBridge（全局）
 */
var Settings = (function () {
  'use strict';

  var infoData = null;

  // ========== 数据加载 ==========

  function load() {
    UI.executeWithConfirm('!info myinfo', null).then(function (d) {
      infoData = d;
      render();
    }).catch(function () {});
  }

  // ========== 渲染 ==========

  function render() {
    var container = document.getElementById('st-info');
    if (!container) return;

    var html = '';
    if (infoData) {
      var rows = [
        { label: '名称', value: escHtml(infoData.displayName || '—') },
        { label: '等级', value: 'Lv.' + (infoData.level || 0) },
        { label: '经验', value: fmtNum(infoData.expCurrent) + ' / ' + fmtNum(infoData.expToNext) },
        { label: '科技等级', value: (infoData.techLevel || '—') + ' · ' + fmtNum(infoData.techPoints) + ' 点' },
        { label: '银行余额', value: fmtNum(infoData.bankBalance) + ' SC' },
        { label: '精英凭证', value: (infoData.vipDays > 0 ? infoData.vipDays + ' 天' : '—') },
      ];
      rows.forEach(function (r) {
        html += '<div class="st-row"><span class="st-label">' + r.label + '</span><span class="st-value">' + r.value + '</span></div>';
      });
    } else {
      html = '<div class="tr-empty">加载中…</div>';
    }
    container.innerHTML = html;

    // 更新全屏按钮文字
    updateFsBtn();
  }

  function updateFsBtn() {
    var btn = document.getElementById('st-fs-btn');
    if (!btn) return;
    btn.textContent = document.fullscreenElement ? '退出' : '进入';
  }

  // ========== 全屏 ==========

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    } else {
      document.exitFullscreen();
    }
    // 延迟更新按钮，等全屏状态切换完成
    setTimeout(updateFsBtn, 200);
  }

  // 监听全屏变化
  if (document.addEventListener) {
    document.addEventListener('fullscreenchange', updateFsBtn);
  }

  // ========== 断开连接 ==========

  function disconnect() {
    document.getElementById('dc-overlay').classList.add('show');
  }

  // ========== 赞赏弹窗 ==========

  function showDonate() {
    document.getElementById('donate-overlay').classList.add('show');
  }

  function hideDonate() {
    document.getElementById('donate-overlay').classList.remove('show');
  }

  // ========== Tab 激活 ==========

  function onTabActivated() {
    if (!SeBridge.hasCredentials()) return;
    if (!infoData) load();
    updateFsBtn();
    // 刷新关于卡片
    var verEl = document.getElementById('st-ver');
    if (verEl) verEl.textContent = document.getElementById('logo-hash').textContent || '—';
    var statusEl = document.getElementById('st-status');
    if (statusEl) {
      var dot = document.getElementById('conn-dot');
      statusEl.textContent = dot && dot.classList.contains('online') ? '● 在线' : dot && dot.classList.contains('offline') ? '● 离线' : '检测中';
    }
    var gaugeEl = document.getElementById('st-gauge');
    if (gaugeEl) gaugeEl.textContent = SeBridge.getRemainingCalls() + ' / ' + SeBridge.getRateLimit() + ' 次/分钟';
  }

  // ========== 初始化 ==========

  function init() {
    var fsBtn = document.getElementById('st-fs-btn');
    if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);

    var dcBtn = document.getElementById('st-disconnect');
    if (dcBtn) dcBtn.addEventListener('click', disconnect);

    var donateBtn = document.getElementById('st-donate');
    if (donateBtn) donateBtn.addEventListener('click', showDonate);

    var donateOverlay = document.getElementById('donate-overlay');
    if (donateOverlay) donateOverlay.addEventListener('click', function (e) {
      if (e.target === this) hideDonate();
    });
  }

  // ========== 工具函数 ==========

  function fmtNum(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString();
  }

  function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  return {
    init: init,
    onTabActivated: onTabActivated,
    load: load,
    toggleFullscreen: toggleFullscreen,
    showDonate: showDonate,
    hideDonate: hideDonate,
  };
})();
