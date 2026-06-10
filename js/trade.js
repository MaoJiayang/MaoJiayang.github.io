/**
 * Trade Panel — 交易面板（服营商店 + 玩家市场）
 * 依赖: UI, SeBridge, Warehouse（全局）
 */
var Trade = (function () {
  'use strict';

  var TRADE_SUBTABS = ['shop', 'market', 'contract'];
  var currentSubTab = 'shop';
  var shopMode = 'buy';         // 'buy' | 'sell'
  var marketMode = 'all';       // 'all' | 'mine'
  var shopBuyData = null;       // ItemVO[]（买入列表）
  var shopSellData = null;      // ItemVO[]（卖出列表）
  var bankInfo = null;          // BankInfoVO
  var shopLoading = false;
  var marketLoading = false;

  // ========== 通用执行 ==========

  function exec(cmd, okLabel) {
    if (SeBridge.isRateLimited()) {
      UI.showToast('error', 'API 调用次数已用完');
      return Promise.reject('RATE_LIMITED');
    }
    return SeBridge.executeCommand(cmd).then(function (r) {
      SeBridge.trackCall();
      UI.updateGauge();
      if (r.code === 200) {
        if (okLabel) UI.showToast('success', okLabel);
        return r.data;
      }
      UI.showToast('error', r.msg || '指令执行失败');
      return Promise.reject(r.msg);
    });
  }

  // ========== 图标 ==========

  /** 读取 iconMap 渲染图标 HTML（映射在 warehouse.js 的 init 中已加载） */
  function iconHtml(name) {
    var iconFile = Warehouse.getIcon(name);
    if (iconFile) {
      return '<span class="wh-card-icon si si-' + iconFile + '" title="' + escAttr(name) + '"></span>';
    }
    return '<span class="wh-card-icon-fb" style="background:#253748">' + name.charAt(0) + '</span>';
  }

  // ========== 子 Tab 切换 ==========

  function switchSubTab(tab) {
    if (tab === 'contract') return; // 占位
    if (tab === currentSubTab) return;
    currentSubTab = tab;
    document.querySelectorAll('.tr-subtab').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tradeTab === tab);
    });
    document.querySelectorAll('.tr-section').forEach(function (el) {
      el.style.display = el.id === 'trade-' + tab ? 'block' : 'none';
    });
    if (tab === 'shop' && !bankInfo) loadShop();
    if (tab === 'market' && !shopBuyData) loadMarket(); // 用 shopBuyData 做简单初始化标记
  }

  function initSubTabs() {
    document.querySelectorAll('.tr-subtab').forEach(function (el) {
      el.addEventListener('click', function () {
        switchSubTab(el.dataset.tradeTab);
      });
    });
  }

  // ========== 服营商店 ==========

  function loadShop() {
    if (shopLoading) return;
    shopLoading = true;
    renderShop();

    // 并行加载余额 + 买入列表（默认模式）
    var p1 = exec('!银行 余额', null).then(function (d) { bankInfo = d; renderShop(); }).catch(function () {});
    var p2 = exec('!采购 列表', null).then(function (d) {
      shopBuyData = Array.isArray(d) ? d : (d && d.items ? d.items : []);
      renderShop();
    }).catch(function () { shopBuyData = []; renderShop(); });

    Promise.all([p1, p2]).finally(function () { shopLoading = false; renderShop(); });
  }

  function loadSellList() {
    if (!shopSellData) {
      exec('!收购 列表', null).then(function (d) {
        shopSellData = Array.isArray(d) ? d : (d && d.items ? d.items : []);
        renderShop();
      }).catch(function () { shopSellData = []; renderShop(); });
    } else {
      renderShop();
    }
  }

  function switchShopMode(mode) {
    if (mode === shopMode) return;
    shopMode = mode;
    document.querySelectorAll('.tr-shop-mode').forEach(function (el) {
      el.classList.toggle('active', el.dataset.shopMode === mode);
    });
    if (mode === 'sell' && !shopSellData) loadSellList();
    else if (mode === 'buy' && !shopBuyData) loadShop();
    else renderShop();
  }

  function initShop() {
    document.querySelectorAll('.tr-shop-mode').forEach(function (el) {
      el.addEventListener('click', function () {
        switchShopMode(el.dataset.shopMode);
      });
    });
    document.getElementById('tr-shop-search').addEventListener('input', function () { renderShop(); });
  }

  function renderShop() {
    var container = document.getElementById('trade-shop-list');
    if (!container) return;

    // 余额行
    var balEl = document.getElementById('trade-balance');
    if (balEl) {
      if (bankInfo) {
        balEl.innerHTML = '💰 余额 <strong>' + formatNum(bankInfo.balance) + ' SC</strong>';
        if (bankInfo.vipDays > 0) balEl.innerHTML += ' <span class="tr-vip">精英 ' + bankInfo.vipDays + ' 天</span>';
        balEl.style.display = '';
      } else if (shopLoading) {
        balEl.innerHTML = '💰 余额 <span style="opacity:.5">加载中…</span>';
        balEl.style.display = '';
      } else {
        balEl.style.display = 'none';
      }
    }

    var data = shopMode === 'buy' ? shopBuyData : shopSellData;
    var search = (document.getElementById('tr-shop-search').value || '').toLowerCase().trim();

    if (!data) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    var filtered = data.filter(function (item) {
      return !search || item.name.toLowerCase().indexOf(search) !== -1;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的物品' : (shopMode === 'buy' ? '暂无商品' : '暂无商品')) + '</div>';
      return;
    }

    var html = '';
    filtered.forEach(function (item) {
      var priceStr = item.price != null ? formatNum(item.price) + ' SC' : '—';
      html += '<div class="tr-shop-row" onclick="Trade.shopBuySell(\'' + escAttr(item.name) + '\',\'' + escAttr(priceStr) + '\')">'
        + iconHtml(item.name)
        + '<span class="tr-shop-name">' + escHtml(item.name) + '</span>'
        + '<span class="tr-shop-price">' + escHtml(priceStr) + '</span>'
        + '<span class="tr-shop-btn">' + (shopMode === 'buy' ? '购买' : '出售') + '</span>'
        + '</div>';
    });
    container.innerHTML = html;
  }

  function shopBuySell(name) {
    var mode = shopMode === 'buy' ? 'buy' : 'sell';
    UI.openQSheet(mode, name, {
      stock: 0,
      onConfirm: function (m, qty) {
        var cmd = shopMode === 'buy'
          ? '!购买 ' + name + ' ' + qty
          : '!出售 ' + name + ' ' + qty;
        var label = shopMode === 'buy' ? '已购买 ' + name : '已出售 ' + name;
        exec(cmd, label).then(function () {
          // 刷新余额
          exec('!银行 余额', null).then(function (d) { bankInfo = d; renderShop(); }).catch(function () {});
          // 标记仓库过期
          Warehouse.markStale();
        }).catch(function () {});
      }
    });
  }

  // ========== 玩家市场 ==========

  function loadMarket() {
    if (marketLoading) return;
    marketLoading = true;
    renderMarket();
    var cmd = marketMode === 'all' ? '!市场 列表' : '!市场 我的订单';
    exec(cmd, null).then(function (d) {
      cacheMarket(d);
      renderMarket();
    }).catch(function () { cacheMarket(null); renderMarket(); }).finally(function () { marketLoading = false; });
  }

  var marketDataCache = null;

  /** 解析 !市场 列表 返回的 { acquireOrders, sellOrders } 结构 */
  function parseOrders(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    var result = [];
    if (d.acquireOrders) result = result.concat(d.acquireOrders);
    if (d.sellOrders) result = result.concat(d.sellOrders);
    return result;
  }

  function cacheMarket(data) {
    marketDataCache = data;
  }

  function switchMarketMode(mode) {
    if (mode === marketMode) return;
    marketMode = mode;
    document.querySelectorAll('.tr-market-mode').forEach(function (el) {
      el.classList.toggle('active', el.dataset.marketMode === mode);
    });
    loadMarket();
  }

  function initMarket() {
    document.querySelectorAll('.tr-market-mode').forEach(function (el) {
      el.addEventListener('click', function () {
        switchMarketMode(el.dataset.marketMode);
      });
    });
    document.getElementById('tr-market-search').addEventListener('input', function () { renderMarket(); });
  }

  function renderMarket() {
    var container = document.getElementById('trade-market-list');
    if (!container) return;

    var search = (document.getElementById('tr-market-search').value || '').toLowerCase().trim();

    if (!marketDataCache) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    var orders = parseOrders(marketDataCache);
    var filtered = orders.filter(function (bill) {
      if (!search) return true;
      return bill.itemName.toLowerCase().indexOf(search) !== -1
        || (bill.ownerDisplayName && bill.ownerDisplayName.toLowerCase().indexOf(search) !== -1);
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的订单' : '暂无订单') + '</div>';
      return;
    }

    var html = '';
    filtered.forEach(function (bill) {
      var isSell = bill.orderType === 1;    // 0=收单, 1=卖单
      var tagClass = isSell ? 'sell' : 'buy';
      var tagText = isSell ? '卖' : '收';
      html += '<div class="tr-order-card ' + (isSell ? 'tr-order-sell' : 'tr-order-buy') + '">'
        + '<span class="tr-order-tag ' + tagClass + '">' + tagText + '</span>'
        + '<div class="tr-order-body">'
        + '<span class="tr-order-name">' + escHtml(bill.itemName) + '</span>'
        + '<span class="tr-order-price">' + formatNum(bill.univalence) + ' SC/件  ×' + formatNum(bill.count) + '</span>'
        + '<span class="tr-order-owner">' + escHtml(bill.ownerDisplayName || '') + '</span>'
        + '</div>';
      if (marketMode === 'mine') {
        html += '<button class="tr-order-cancel" onclick="event.stopPropagation();Trade.cancelOrder(\'' + escAttr(String(bill.id)) + '\')">撤销</button>';
      }
      html += '</div>';
    });
    container.innerHTML = html;
  }

  function cancelOrder(orderId) {
    document.getElementById('dc-msg').textContent = '确定要撤销订单 #' + orderId + ' 吗？';
    document.getElementById('dc-confirm-btn').textContent = '撤销';
    document.getElementById('dc-confirm-btn').onclick = function () {
      UI.closeDcDialog();
      exec('!市场 撤销订单 ' + orderId, '已撤销订单 #' + orderId).then(function () {
        loadMarket();
      }).catch(function () {});
    };
    document.getElementById('dc-overlay').classList.add('show');
  }

  function publishOrder(modeForQ) {
    // 进入仓库选择模式：用户点击物品后弹出 QSheet
    Warehouse.enterSelectionMode(modeForQ, function (itemName) {
      Warehouse.exitSelectionMode();
      UI.switchTab('trade');
      // 打开 QSheet 填数量和单价
      UI.openQSheet(modeForQ, itemName, {
        stock: 0,
        extraField: { label: '单价 SC', value: 100, suffix: 'SC', step: 10, max: 999999 },
        onConfirm: function (m, qty, price) {
          var cmd = modeForQ === 'sell'
            ? '!市场 发布卖单 ' + itemName + ' ' + qty + ' ' + price
            : '!市场 发布收单 ' + itemName + ' ' + qty + ' ' + price;
          var label = (modeForQ === 'sell' ? '卖单已发布：' : '收单已发布：') + itemName;
          exec(cmd, label).then(function () {
            Warehouse.markStale();
            loadMarket();
          }).catch(function () {});
        }
      });
    });
    UI.switchTab('warehouse');
  }

  // ========== Tab 激活 ==========

  function onTabActivated() {
    if (!SeBridge.hasCredentials()) return;
    if (!bankInfo) {
      loadShop();
    }
  }

  // ========== 初始化 ==========

  function init() {
    initSubTabs();
    initShop();
    initMarket();

    // 操作按钮事件绑定
    var pubSell = document.getElementById('trade-pub-sell');
    var pubBuy = document.getElementById('trade-pub-buy');
    if (pubSell) pubSell.addEventListener('click', function () { publishOrder('sell'); });
    if (pubBuy) pubBuy.addEventListener('click', function () { publishOrder('buy'); });
  }

  // ========== 工具函数 ==========

  function formatNum(n) {
    if (n == null) return '0';
    if (typeof n === 'object' && n.toString) n = parseFloat(n.toString());
    if (isNaN(n)) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function escAttr(s) { return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

  return {
    init: init,
    onTabActivated: onTabActivated,
    switchSubTab: switchSubTab,
    shopBuySell: shopBuySell,
    cancelOrder: cancelOrder,
    publishOrder: publishOrder,
  };
})();
