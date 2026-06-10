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
        UI.showToast('success', r.msg || okLabel || '操作成功');
        return r.data;
      }
      // 服务器要求重复输入确认（匹配所有确认类响应）
      if (r.msg && /(?:重复输入|再次输入).*(?:确认|指令)/.test(r.msg)) {
        return new Promise(function (resolve, reject) {
          UI.showConfirmDialog(r.msg, function () {
            if (SeBridge.isRateLimited()) {
              UI.showToast('error', 'API 调用次数已用完');
              reject('RATE_LIMITED');
              return;
            }
            SeBridge.executeCommand(cmd).then(function (r2) {
              SeBridge.trackCall();
              UI.updateGauge();
              if (r2.code === 200) {
                UI.showToast('success', r2.msg || okLabel || '操作成功');
                resolve(r2.data);
              } else {
                UI.showToast('error', r2.msg || '操作失败');
                reject(r2.msg);
              }
            }).catch(reject);
          });
        });
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
    if (tab === currentSubTab) return;
    currentSubTab = tab;
    document.querySelectorAll('.tr-subtab').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tradeTab === tab);
    });
    document.querySelectorAll('.tr-section').forEach(function (el) {
      el.style.display = el.id === 'trade-' + tab ? 'block' : 'none';
    });
    if (tab === 'shop' && !bankInfo) loadShop();
    if (tab === 'market' && !marketDataCache && !marketLoading) loadMarket();
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
      html += '<div class="tr-shop-row" onclick="Trade.shopBuySell(\'' + escAttr(item.name) + '\')">'
        + iconHtml(item.name)
        + '<span class="tr-shop-name">' + escHtml(item.name) + '</span>'
        + '<span class="tr-shop-price">' + priceStr + '</span>'
        + '<span class="tr-shop-btn">' + (shopMode === 'buy' ? '购买' : '出售') + '</span>'
        + '</div>';
    });
    container.innerHTML = html;
  }

  function shopBuySell(name) {
    var mode = shopMode === 'buy' ? 'buy' : 'sell';
    // 买入：显示库存但不限量 (noCap)；卖出：库存即上限
    var isBuy = shopMode === 'buy';
    var stock = Warehouse.getStock(name);
    UI.openQSheet(mode, name, {
      stock: stock,
      noCap: isBuy,
      onConfirm: function (m, qty) {
        var cmd = shopMode === 'buy'
          ? '!采购 提交 ' + name + ' ' + qty
          : '!收购 提交 ' + name + ' ' + qty;
        var label = shopMode === 'buy' ? '已购买 ' + name : '已出售 ' + name;
        exec(cmd, label).then(function () {
          exec('!银行 余额', null).then(function (d) { bankInfo = d; renderShop(); }).catch(function () {});
          Warehouse.markStale();
        }).catch(function () {});
      }
    });
  }

  // ========== 玩家市场 ==========

  function loadMarket() {
    if (marketLoading) return;
    marketLoading = true;
    cacheMarket(null);  // 清空旧数据，防止模式切换时残留
    renderMarket();
    var cmd = marketMode === 'all' ? '!市场 列表' : '!市场 我的订单';
    exec(cmd, null).then(function (d) {
      cacheMarket(d);
      renderMarket();
    }).catch(function () { cacheMarket([]); renderMarket(); }).finally(function () { marketLoading = false; });
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

  function refreshMarket() {
    loadMarket();
  }

  /** 点击订单快捷匹配：卖单→自动购买，收单→自动出售。数量不可改（不能拆单） */
  function quickTrade(name, price, isSell, count) {
    var mode = isSell ? 'buy' : 'sell';
    UI.openQSheet(mode, name, {
      stock: 0,
      lockQty: count || 1,
      lockExtra: true,
      extraField: { label: '单价 SC', value: price, suffix: 'SC', step: 10, min: 0, max: 999999 },
      onConfirm: function (m, qty, p) {
        var cmd = isSell
          ? '!市场 自动购买 ' + name + ' ' + qty + ' ' + p
          : '!市场 自动出售 ' + name + ' ' + qty + ' ' + p;
        var label = (isSell ? '自动购买 ' : '自动出售 ') + name;
        exec(cmd, label).then(function () {
          Warehouse.markStale();
          loadMarket();
        }).catch(function () {});
      }
    });
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
      var isSell = bill.orderType === 1;    // 0=收单, 1=卖单(出)
      var tagClass = isSell ? 'sell' : 'buy';
      var tagText = isSell ? '出' : '收';
      var clickAttr = '';
      if (marketMode === 'all') {
        // 点击订单快捷匹配：卖单→自动购买，收单→自动出售
        clickAttr = ' onclick="Trade.quickTrade(\'' + escAttr(bill.itemName) + '\',' + bill.univalence + ',' + (isSell ? 1 : 0) + ',' + bill.count + ')"';
      }
      html += '<div class="tr-order-card ' + (isSell ? 'tr-order-sell' : 'tr-order-buy') + '"' + clickAttr + '>'
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
        extraField: { label: '单价 SC', value: 100, suffix: 'SC', step: 10, min: 0, max: 999999, confirmLabel: modeForQ === 'sell' ? '确认发布卖单' : '确认发布收单' },
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
    if (n >= 1e9) {
      var val = (n / 1e9).toFixed(2).replace(/\.?0+$/, '');
      return val + '<span class="wh-num-sfx num-b">B</span>';
    }
    if (n >= 1e6) {
      var val = (n / 1e6).toFixed(2).replace(/\.?0+$/, '');
      return val + '<span class="wh-num-sfx num-m">M</span>';
    }
    if (n >= 1e3) {
      var val = (n / 1e3).toFixed(2).replace(/\.?0+$/, '');
      return val + '<span class="wh-num-sfx num-k">k</span>';
    }
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
    refreshMarket: refreshMarket,
    quickTrade: quickTrade,
  };
})();
