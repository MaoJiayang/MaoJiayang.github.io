/**
 * Trade Panel — 交易面板（服营商店 + 玩家市场行情 + TradeSheet）
 * 依赖: UI, SeBridge, Warehouse（全局）
 */
var Trade = (function () {
  'use strict';

  var TRADE_SUBTABS = ['shop', 'market', 'contract'];
  var currentSubTab = 'shop';
  var shopMode = 'buy';         // 'buy' | 'sell'
  var marketMode = 'mk';        // 'mk' | 'orders'
  var shopBuyData = null;       // ItemVO[]
  var shopSellData = null;
  var bankInfo = null;
  var shopLoading = false;
  var marketLoading = false;
  var marketDataCache = null;   // { acquireOrders, sellOrders } 原始数据
  var marketItems = null;       // { itemName: { sellOrders, buyOrders, ... } } 聚合数据
  var _ordersCollapsed = true;  // 订单卡片折叠状态

  // TradeSheet 状态
  var tsMode = 'buy';
  var tsItem = '';
  var tsPrice = 0;
  var tsQty = 0;
  var tsMaxQty = 0;
  var tsBuckets = [];           // [{ label, count, priceMin, priceMax }]
  var tsMaxBucket = 0;
  var _tsOrders = [];           // 当前使用的订单列表（升序或降序）
  var _tsOnConfirm = null;

  // ========== 通用执行 ==========

  function exec(cmd, okLabel) {
    return UI.executeWithConfirm(cmd, okLabel);
  }

  // ========== 图标 ==========

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

  function loadBankInfo() {
    return exec('!银行 余额', null).then(function (d) {
      bankInfo = d;
      renderInfo();
      return d;
    }).catch(function () {});
  }

  function loadShop() {
    if (shopLoading) return;
    shopLoading = true;
    renderShop();
    var p1 = loadBankInfo().then(function () { renderShop(); });
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
    } else { renderShop(); }
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
      el.addEventListener('click', function () { switchShopMode(el.dataset.shopMode); });
    });
    document.getElementById('tr-shop-search').addEventListener('input', function () { renderShop(); });
  }

  function renderInfo() {
    var row = document.getElementById('trade-info');
    if (!row) return;
    if (bankInfo) {
      row.style.display = '';
      var balBox = document.getElementById('ti-balance');
      balBox.querySelector('.tr-info-val').innerHTML = UI.fmtNum(bankInfo.balance) + ' SC';
      balBox.className = 'tr-info-box' + (bankInfo.balance > 0 ? ' good' : '');
      var odBox = document.getElementById('ti-overdraft');
      odBox.querySelector('.tr-info-val').innerHTML = bankInfo.overdraftLimit > 0 ? UI.fmtNum(bankInfo.overdraftLimit) + ' SC' : '无';
      odBox.className = 'tr-info-box' + (bankInfo.overdraftLimit > 0 ? ' good' : '');
      var vipBox = document.getElementById('ti-vip');
      vipBox.querySelector('.tr-info-val').innerHTML = bankInfo.vipDays > 0 ? bankInfo.vipDays + ' 天' : '—';
      vipBox.className = 'tr-info-box' + (bankInfo.vipDays > 0 ? ' good' : '');
    } else { row.style.display = 'none'; }
  }

  function renderShop() {
    var container = document.getElementById('trade-shop-list');
    if (!container) return;
    renderInfo();
    var data = shopMode === 'buy' ? shopBuyData : shopSellData;
    var search = (document.getElementById('tr-shop-search').value || '').toLowerCase().trim();
    if (!data && shopLoading) { container.innerHTML = '<div class="tr-empty">加载中…</div>'; return; }
    if (!data) { container.innerHTML = '<div class="tr-empty">' + (shopMode === 'buy' ? '暂无商品' : '暂无商品') + '</div>'; return; }
    var filtered = data.filter(function (item) { return !search || item.name.toLowerCase().indexOf(search) !== -1; });
    if (filtered.length === 0) { container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的物品' : (shopMode === 'buy' ? '暂无商品' : '暂无商品')) + '</div>'; return; }
    var html = '';
    filtered.forEach(function (item) {
      var priceStr = item.price != null ? UI.fmtNum(item.price) + ' SC' : '—';
      html += '<div class="tr-shop-row" onclick="Trade.shopBuySell(\'' + escAttr(item.name) + '\')">'
        + iconHtml(item.name) + '<span class="tr-shop-name">' + escHtml(item.name) + '</span>'
        + '<span class="tr-shop-price">' + priceStr + '</span>'
        + '<span class="tr-shop-btn">' + (shopMode === 'buy' ? '购买' : '出售') + '</span></div>';
    });
    container.innerHTML = html;
  }

  function shopBuySell(name) {
    var isBuy = shopMode === 'buy';
    var stock = Warehouse.getStock(name);
    UI.openQSheet(shopMode, name, {
      stock: stock, noCap: isBuy,
      onConfirm: function (m, qty) {
        var cmd = shopMode === 'buy' ? '!采购 提交 ' + name + ' ' + qty : '!收购 提交 ' + name + ' ' + qty;
        var label = shopMode === 'buy' ? '已购买 ' + name : '已出售 ' + name;
        exec(cmd, label).then(function () { loadBankInfo(); Warehouse.markStale(); Warehouse.ensureData(); }).catch(function () {});
      }
    });
  }

  // ========== 玩家市场 ==========

  function loadMarket() {
    if (marketLoading) return;
    marketLoading = true;
    renderMarket();
    exec('!市场 列表', null).then(function (d) {
      marketDataCache = d;
      marketItems = buildMarketItems(d);
      marketLoading = false;
      renderMarket();
    }).catch(function () { marketDataCache = null; marketLoading = false; renderMarket(); });
  }

  function loadMyOrders() {
    exec('!市场 我的订单', null).then(function (d) {
      if (d && (d.acquireOrders || d.sellOrders)) {
        marketDataCache = d;
      }
      renderMarket();
    }).catch(function () { renderMarket(); });
  }

  /** 客户端聚合：sellOrders + buyOrders 按 itemName 分组 */
  function buildMarketItems(d) {
    var map = {};
    if (!d) return map;
    var sellOrders = d.sellOrders || [];
    var buyOrders = d.acquireOrders || [];
    function add(map, key, order) {
      if (!map[order.itemName]) map[order.itemName] = { sellOrders: [], buyOrders: [], minSell: Infinity, maxSell: 0, totalSell: 0, minBuy: Infinity, maxBuy: 0, totalBuy: 0 };
    }
    // 卖单（我要买的货源）
    sellOrders.forEach(function (o) {
      if (!map[o.itemName]) map[o.itemName] = { sellOrders: [], buyOrders: [], minSell: Infinity, maxSell: 0, totalSell: 0, minBuy: Infinity, maxBuy: 0, totalBuy: 0 };
      map[o.itemName].sellOrders.push({ price: o.univalence, count: o.count });
      var p = o.univalence || 0;
      map[o.itemName].minSell = Math.min(map[o.itemName].minSell, p);
      map[o.itemName].maxSell = Math.max(map[o.itemName].maxSell, p);
      map[o.itemName].totalSell += o.count || 0;
    });
    // 收单（我要卖的买方）
    buyOrders.forEach(function (o) {
      if (!map[o.itemName]) map[o.itemName] = { sellOrders: [], buyOrders: [], minSell: Infinity, maxSell: 0, totalSell: 0, minBuy: Infinity, maxBuy: 0, totalBuy: 0 };
      map[o.itemName].buyOrders.push({ price: o.univalence, count: o.count });
      var p = o.univalence || 0;
      map[o.itemName].minBuy = Math.min(map[o.itemName].minBuy, p);
      map[o.itemName].maxBuy = Math.max(map[o.itemName].maxBuy, p);
      map[o.itemName].totalBuy += o.count || 0;
    });
    return map;
  }

  function getMarketItem(name) { return marketItems ? marketItems[name] : null; }

  function switchMarketMode(mode) {
    if (mode === marketMode) return;
    marketMode = mode;
    document.querySelectorAll('.tr-market-mode').forEach(function (el) {
      el.classList.toggle('active', el.dataset.marketMode === mode);
    });
    if (mode === 'orders') loadMyOrders();
    else renderMarket();
  }

  function refreshMarket() { loadMarket(); }

  function toggleOrdersCollapse() {
    _ordersCollapsed = !_ordersCollapsed;
    var body = document.getElementById('mk-orders-body');
    var toggle = document.getElementById('mk-orders-toggle');
    if (body) body.style.display = _ordersCollapsed ? 'none' : 'block';
    if (toggle) toggle.textContent = _ordersCollapsed ? '展示所有订单 ∨' : '隐藏所有订单 ∧';
  }

  function renderMarket() {
    var container = document.getElementById('trade-market-list');
    if (!container) return;

    if (!marketDataCache && marketLoading) { container.innerHTML = '<div class="tr-empty">加载中…</div>'; return; }

    if (marketMode === 'mk') {
      renderMkView(container);
    } else {
      renderOrdersView(container);
    }
  }

  // ========== 行情视图 ==========

  function renderMkView(container) {
    var search = (document.getElementById('tr-market-search').value || '').toLowerCase().trim();

    if (!marketItems || Object.keys(marketItems).length === 0) {
      container.innerHTML = '<div class="tr-empty">暂无行情数据</div>';
      return;
    }

    var names = Object.keys(marketItems).filter(function (n) {
      return !search || n.toLowerCase().indexOf(search) !== -1;
    }).sort();

    if (names.length === 0) {
      container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的物品' : '暂无行情数据') + '</div>';
      return;
    }

    var html = '';
    names.forEach(function (name) {
      var m = marketItems[name];
      var sellInfo = m.minSell < Infinity ? (UI.fmtCompact(m.minSell) + '~' + UI.fmtCompact(m.maxSell) + ' · ' + UI.fmtCompact(m.totalSell) + ' 件') : '—';
      var buyInfo = m.minBuy < Infinity ? (UI.fmtCompact(m.minBuy) + '~' + UI.fmtCompact(m.maxBuy) + ' · ' + UI.fmtCompact(m.totalBuy) + ' 件') : '—';

      html += '<div class="mk-item-row">'
        + iconHtml(name)
        + '<div class="mk-item-info">'
        + '<span class="mk-item-name">' + escHtml(name) + '</span>'
        + '<span class="mk-item-meta">卖 ' + sellInfo + '</span>'
        + '<span class="mk-item-meta">收 ' + buyInfo + '</span>'
        + '</div>'
        + '<div class="mk-item-actions">'
        + (m.totalSell > 0 ? '<button class="mk-buy-btn" onclick="Trade.openTradeSheet(\'buy\',\'' + escAttr(name) + '\')">购买</button>' : '')
        + (m.totalBuy > 0 ? '<button class="mk-sell-btn" onclick="Trade.openTradeSheet(\'sell\',\'' + escAttr(name) + '\')">出售</button>' : '')
        + '</div>'
        + '</div>';
    });

    // 折叠的订单卡片区
    html += '<div class="mk-orders-section">'
      + '<div class="mk-orders-h" id="mk-orders-toggle" onclick="Trade.toggleOrdersCollapse()">展示所有订单 ∨</div>'
      + '<div class="mk-orders-body" id="mk-orders-body" style="display:none">';
    if (marketDataCache) {
      var orders = parseOrders(marketDataCache);
      orders.forEach(function (bill) {
        var isSell = bill.orderType === 1;
        html += '<div class="tr-order-card ' + (isSell ? 'tr-order-sell' : 'tr-order-buy') + '" onclick="Trade.quickTrade(\'' + escAttr(bill.itemName) + '\',' + bill.univalence + ',' + (isSell ? 1 : 0) + ',' + bill.count + ')">'
          + '<span class="tr-order-tag ' + (isSell ? 'sell' : 'buy') + '">' + (isSell ? '出' : '收') + '</span>'
          + '<div class="tr-order-body">'
          + '<span class="tr-order-name">' + escHtml(bill.itemName) + '</span>'
          + '<span class="tr-order-price">' + UI.fmtNum(bill.univalence) + ' SC/件  ×' + UI.fmtNum(bill.count) + '</span>'
          + '<span class="tr-order-owner">' + escHtml(bill.ownerDisplayName || '') + '</span>'
          + '</div></div>';
      });
    }
    html += '</div></div>';

    container.innerHTML = html;
  }

  // ========== 我的订单视图 ==========

  function renderOrdersView(container) {
    var search = (document.getElementById('tr-market-search').value || '').toLowerCase().trim();

    if (!marketDataCache) { container.innerHTML = '<div class="tr-empty">加载中…</div>'; return; }

    var orders = parseOrders(marketDataCache);
    var filtered = orders.filter(function (bill) {
      return !search || bill.itemName.toLowerCase().indexOf(search) !== -1;
    });

    // 顶部操作栏：发布按钮
    var html = '<div class="mk-pub-bar">'
      + '<span class="mk-pub-label">发布新订单</span>'
      + '<div class="mk-pub-actions">'
      + '<button class="tr-act-btn" onclick="Trade.publishOrder(\'sell\')">卖单</button>'
      + '<button class="tr-act-btn" onclick="Trade.publishOrder(\'buy\')">收单</button>'
      + '</div>'
      + '</div>';

    if (filtered.length === 0) { html += '<div class="tr-empty">' + (search ? '没有匹配的订单' : '暂无订单') + '</div>'; container.innerHTML = html; return; }

    filtered.forEach(function (bill) {
      var isSell = bill.orderType === 1;
      html += '<div class="tr-order-card ' + (isSell ? 'tr-order-sell' : 'tr-order-buy') + '">'
        + '<span class="tr-order-tag ' + (isSell ? 'sell' : 'buy') + '">' + (isSell ? '出' : '收') + '</span>'
        + '<div class="tr-order-body">'
        + '<span class="tr-order-name">' + escHtml(bill.itemName) + '</span>'
        + '<span class="tr-order-price">' + UI.fmtNum(bill.univalence) + ' SC/件  ×' + UI.fmtNum(bill.count) + '</span>'
        + '<span class="tr-order-owner">' + escHtml(bill.ownerDisplayName || '') + '</span>'
        + '</div>'
        + '<button class="tr-order-cancel" onclick="event.stopPropagation();Trade.cancelOrder(\'' + escAttr(String(bill.id)) + '\')">撤销</button>'
        + '</div>';
    });
    container.innerHTML = html;
  }

  // ========== 旧接口（保留） ==========

  function parseOrders(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    var result = [];
    if (d.acquireOrders) result = result.concat(d.acquireOrders);
    if (d.sellOrders) result = result.concat(d.sellOrders);
    return result;
  }

  function quickTrade(name, price, isSell, count) {
    var mode = isSell ? 'buy' : 'sell';
    UI.openQSheet(mode, name, {
      stock: 0, lockQty: count || 1, lockExtra: true,
      extraField: { label: '单价 SC', value: price, suffix: 'SC', step: 10, min: 0, max: 999999 },
      onConfirm: function (m, qty, p) {
        var cmd = isSell ? '!市场 自动购买 ' + name + ' ' + qty + ' ' + p : '!市场 自动出售 ' + name + ' ' + qty + ' ' + p;
        var label = (isSell ? '自动购买 ' : '自动出售 ') + name;
        exec(cmd, label).then(function () { Warehouse.markStale(); Warehouse.ensureData(); loadMarket(); }).catch(function () {});
      }
    });
  }

  function cancelOrder(orderId) {
    document.getElementById('dc-msg').textContent = '确定要撤销订单 #' + orderId + ' 吗？';
    document.getElementById('dc-confirm-btn').textContent = '撤销';
    document.getElementById('dc-confirm-btn').onclick = function () {
      UI.closeDcDialog();
      exec('!市场 撤销订单 ' + orderId, '已撤销订单 #' + orderId).then(function () { loadMarket(); }).catch(function () {});
    };
    document.getElementById('dc-overlay').classList.add('show');
  }

  // ========== 发布订单 ==========

  function publishOrder(modeForQ) {
    Warehouse.enterSelectionMode(modeForQ, function (itemName) {
      Warehouse.exitSelectionMode();
      UI.switchTab('trade');
      // 发布视角看同方向订单（卖单参考卖单、收单参考收单），与交易视角相反
      openTradeSheet(modeForQ === 'sell' ? 'buy' : 'sell', itemName);
      // 覆盖 UI 文案：发布订单 vs 自动交易
      var isSell = modeForQ === 'sell';
      document.getElementById('ts-title').textContent = (isSell ? '发布卖单 ' : '发布收单 ') + itemName;
      document.getElementById('ts-price-label').textContent = '单价';
      document.getElementById('ts-confirm').textContent = isSell ? '确认发布卖单' : '确认发布收单';
      // 替换确认回调：发布订单而非自动交易
      _tsOnConfirm = function () {
        var cmd = '!市场 发布' + (isSell ? '卖单 ' : '收单 ') + itemName + ' ' + tsQty + ' ' + tsPrice;
        var label = (isSell ? '卖单已发布：' : '收单已发布：') + itemName;
        exec(cmd, label).then(function () { Warehouse.markStale(); Warehouse.ensureData(); loadMarket(); }).catch(function () {});
      };
    });
    UI.switchTab('warehouse');
  }

  // ========== TradeSheet ==========

  /** 计算价格分桶 */
  function buildBuckets(orders, MAX_BUCKETS) {
    MAX_BUCKETS = MAX_BUCKETS || 10;
    if (!orders || orders.length === 0) return { buckets: [], maxCount: 0, total: 0 };
    var sorted = orders.slice().sort(function (a, b) { return a.price - b.price; });
    var minP = sorted[0].price;
    var maxP = sorted[sorted.length - 1].price;
    if (minP === maxP) maxP = minP + 1; // 防止除零
    var range = (maxP - minP) / MAX_BUCKETS;
    var buckets = [];
    for (var i = 0; i < MAX_BUCKETS; i++) {
      buckets.push({ label: UI.fmtCompact(Math.round(minP + i * range)) + '~' + UI.fmtCompact(Math.round(minP + (i + 1) * range)), count: 0, priceMin: minP + i * range, priceMax: minP + (i + 1) * range });
    }
    sorted.forEach(function (o) {
      var idx = Math.min(MAX_BUCKETS - 1, Math.floor((o.price - minP) / range));
      buckets[idx].count += o.count || 0;
    });
    var maxCount = 0, total = 0;
    buckets.forEach(function (b) { maxCount = Math.max(maxCount, b.count); total += b.count; });
    return { buckets: buckets, maxCount: maxCount, total: total, minPrice: minP, maxPrice: maxP };
  }

  /** 累加高亮计算：从 best price 方向扫描，返回每个桶的高亮比例 [0,1] */
  function computeAccum(buckets, maxPrice, qty, asc) {
    var highlights = buckets.map(function () { return 0; });
    if (!qty || qty <= 0 || !buckets.length) return highlights;
    var remaining = qty;
    for (var i = 0; i < buckets.length; i++) {
      var idx = asc ? i : buckets.length - 1 - i;
      var b = buckets[idx];
      if (asc && b.priceMin > maxPrice) break;
      if (!asc && b.priceMax < maxPrice) break;
      if (b.count <= 0) continue;
      if (remaining <= 0) break;
      if (b.count >= remaining) {
        // 部分覆盖
        var pct = remaining / b.count;
        highlights[idx] = Math.max(0.25, Math.min(1, pct));
        remaining = 0;
      } else {
        highlights[idx] = 1;
        remaining -= b.count;
      }
    }
    return highlights;
  }

  /** 打开 TradeSheet（交易 / 发布订单共用） */
  function openTradeSheet(mode, itemName) {
    var mi = getMarketItem(itemName);
    var orders = [];
    if (mi) {
      orders = mode === 'buy' ? (mi.sellOrders || []) : (mi.buyOrders || []);
    }

    tsMode = mode;
    tsItem = itemName;
    _tsOrders = orders.slice().sort(function (a, b) { return mode === 'buy' ? a.price - b.price : b.price - a.price; });
    var bb = buildBuckets(orders);
    tsBuckets = bb.buckets;
    tsMaxBucket = bb.maxCount;

    // 默认值（无对手方订单时用兜底默认价 + 不设上限）
    if (orders.length > 0) {
      tsPrice = mode === 'buy' ? bb.minPrice : bb.maxPrice;
      tsMaxQty = calcMaxQtyForPrice(tsPrice, mode);
    } else {
      tsPrice = 100;
      tsMaxQty = 2147483647;  // 无对手方订单时仅做整型防御，不设实际上限
    }
    tsQty = Math.min(100, tsMaxQty);

    document.getElementById('ts-title').textContent = (mode === 'buy' ? '购买 ' : '出售 ') + itemName;
    document.getElementById('ts-stock').textContent = '仓库: ' + UI.fmtCompact(Warehouse.getStock(itemName) || 0);
    document.getElementById('ts-price-label').textContent = mode === 'buy' ? '最高单价' : '最低单价';
    document.getElementById('ts-price').value = tsPrice;
    document.getElementById('ts-qty').value = tsQty;
    document.getElementById('ts-slider').max = tsMaxQty;
    document.getElementById('ts-slider').value = tsQty;
    document.getElementById('ts-confirm').textContent = mode === 'buy' ? '确认购买' : '确认出售';

    _tsOnConfirm = function () {
      var cmd = mode === 'buy'
        ? '!市场 自动购买 ' + itemName + ' ' + tsQty + ' ' + tsPrice
        : '!市场 自动出售 ' + itemName + ' ' + tsQty + ' ' + tsPrice;
      var label = (mode === 'buy' ? '已购买 ' : '已出售 ') + itemName;
      exec(cmd, label).then(function () {
        Warehouse.markStale(); Warehouse.ensureData();
        loadMarket();
      }).catch(function () {});
    };

    renderChart();
    updateTsDisplay();
    document.getElementById('tradesheet-overlay').classList.add('show');
  }

  function closeTradeSheet() {
    document.getElementById('tradesheet-overlay').classList.remove('show');
    _tsOnConfirm = null;
  }

  function confirmTradeSheet() {
    var fn = _tsOnConfirm;
    closeTradeSheet();
    if (fn) fn();
  }

  /** 渲染柱状图 */
  function renderChart() {
    var chart = document.getElementById('ts-chart');
    if (!chart) return;

    // 无对手方订单 → 占位提示
    if (tsBuckets.length === 0) {
      chart.innerHTML = '<div class="ts-chart-empty">暂无行情参考，可自由定价</div>';
      return;
    }

    // Y轴刻度（3档：0, 50%, 100%）
    var maxFmt = UI.fmtCompact(tsMaxBucket);
    var midFmt = UI.fmtCompact(Math.round(tsMaxBucket / 2));

    var highlights = computeAccum(tsBuckets, tsPrice, tsQty, tsMode === 'buy');
    var html = '<div class="ts-chart-inner">';

    // Y轴
    html += '<div class="ts-yaxis">'
      + '<span>' + maxFmt + '</span>'
      + '<span>' + midFmt + '</span>'
      + '<span>0</span>'
      + '</div>';

    // 柱状图区域
    html += '<div class="ts-bars">';
    tsBuckets.forEach(function (b, i) {
      var h = tsMaxBucket > 0 ? Math.round((b.count / tsMaxBucket) * 100) : 0;
      var hl = highlights[i];
      var bg = hl > 0 ? 'rgba(93,221,170,' + hl.toFixed(2) + ')' : 'var(--bg-hover)';
      var pctLabel = hl > 0 && hl < 1 ? Math.round(hl * 100) + '%' : '';
      html += '<div class="ts-bar-col">'
        + '<div class="ts-bar" style="height:' + h + '%;background:' + bg + '" title="' + b.label + ': ' + UI.fmtCompact(b.count) + ' 件">'
        + (pctLabel ? '<span class="ts-bar-label">' + pctLabel + '</span>' : '')
        + '</div>'
        + '</div>';
    });
    html += '</div></div>';

    // X轴分区点（显示在柱与柱之间的间隙，justify-content: space-between 均匀分布）
    html += '<div class="ts-xaxis">';
    html += '<span>' + UI.fmtCompact(tsBuckets[0].priceMin) + '</span>';
    for (var j = 0; j < tsBuckets.length; j++) {
      html += '<span>' + UI.fmtCompact(tsBuckets[j].priceMax) + '</span>';
    }
    html += '</div>';

    chart.innerHTML = html;
  }

  /** 更新显示：总价 + 滑块填色 + 输入框 */
  function updateTsDisplay() {
    document.getElementById('ts-price').value = tsPrice;
    document.getElementById('ts-qty').value = tsQty;
    var slider = document.getElementById('ts-slider');
    slider.max = tsMaxQty;
    slider.value = Math.min(tsQty, tsMaxQty);
    // 滑块已拖动部分填色
    var pct2 = tsMaxQty > 0 ? (slider.value / tsMaxQty) * 100 : 0;
    slider.style.background = 'linear-gradient(to right, var(--jade-200) 0%, var(--jade-200) ' + pct2 + '%, var(--bg-hover) ' + pct2 + '%)';
    document.getElementById('ts-price').value = UI.fmtPrice(tsPrice);
    document.getElementById('ts-qty').value = UI.fmtPrice(tsQty);
    document.getElementById('ts-total').textContent = '预估成交 ' + UI.fmtPrice(tsPrice * tsQty) + ' SC';
  }

  /** 计算当前价格下可购买/出售的最大数量（无对手方订单时不设上限） */
  function calcMaxQtyForPrice(price, mode) {
    if (!_tsOrders || !_tsOrders.length) return 2147483647;
    var total = 0;
    for (var i = 0; i < _tsOrders.length; i++) {
      var o = _tsOrders[i];
      if (mode === 'buy' && o.price <= price) total += o.count;
      else if (mode === 'sell' && o.price >= price) total += o.count;
    }
    return total;
  }

  function onTsPriceInput() {
    var raw = document.getElementById('ts-price').value.replace(/,/g, '');
    var v = parseInt(raw, 10);
    if (isNaN(v) || v < 0) v = 0;
    tsPrice = v;
    tsMaxQty = calcMaxQtyForPrice(tsPrice, tsMode);
    if (tsQty > tsMaxQty) tsQty = tsMaxQty;
    document.getElementById('ts-slider').max = tsMaxQty;
    renderChart();
    updateTsDisplay();
  }

  function onTsQtyInput() {
    var raw = document.getElementById('ts-qty').value.replace(/,/g, '');
    var v = parseInt(raw, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > tsMaxQty) v = tsMaxQty;
    tsQty = v;
    renderChart();
    updateTsDisplay();
  }

  function adjustTsPrice(delta) {
    var step = tsPrice >= 1000 ? 100 : tsPrice >= 100 ? 10 : 1;
    tsPrice = Math.max(0, tsPrice + delta * step);
    tsMaxQty = calcMaxQtyForPrice(tsPrice, tsMode);
    if (tsQty > tsMaxQty) tsQty = tsMaxQty;
    document.getElementById('ts-slider').max = tsMaxQty;
    renderChart();
    updateTsDisplay();
  }

  function adjustTsQty(delta) {
    var step = tsQty >= 10000 ? 1000 : tsQty >= 1000 ? 100 : tsQty >= 100 ? 10 : 1;
    tsQty = Math.max(1, Math.min(tsMaxQty, tsQty + delta * step));
    renderChart();
    updateTsDisplay();
  }

  function onTsSliderInput() {
    tsQty = parseInt(document.getElementById('ts-slider').value, 10) || 0;
    renderChart();
    updateTsDisplay();
  }

  // ========== Tab 激活 ==========

  function onTabActivated() {
    if (!SeBridge.hasCredentials()) return;
    Warehouse.ensureData();
    if (!bankInfo) loadBankInfo();
    if (!shopBuyData) loadShop();
  }

  // ========== 初始化 ==========

  function init() {
    initSubTabs();
    initShop();
    initMarket();

    // TradeSheet 按钮
    document.getElementById('ts-cancel').addEventListener('click', closeTradeSheet);
    document.getElementById('ts-confirm').addEventListener('click', confirmTradeSheet);
    document.getElementById('tradesheet-overlay').addEventListener('click', function (e) {
      if (e.target === this) closeTradeSheet();
    });
    document.getElementById('ts-price').addEventListener('input', onTsPriceInput);
    document.getElementById('ts-qty').addEventListener('input', onTsQtyInput);
    document.getElementById('ts-slider').addEventListener('input', onTsSliderInput);
    document.getElementById('ts-price-sub').addEventListener('click', function () { adjustTsPrice(-1); });
    document.getElementById('ts-price-add').addEventListener('click', function () { adjustTsPrice(1); });
    document.getElementById('ts-qty-sub').addEventListener('click', function () { adjustTsQty(-1); });
    document.getElementById('ts-qty-add').addEventListener('click', function () { adjustTsQty(1); });
  }

  function initMarket() {
    document.querySelectorAll('.tr-market-mode').forEach(function (el) {
      el.addEventListener('click', function () { switchMarketMode(el.dataset.marketMode); });
    });
    document.getElementById('tr-market-search').addEventListener('input', function () { renderMarket(); });
  }

  // ========== 工具函数 ==========

  function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function escAttr(s) { return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

  return {
    init: init, onTabActivated: onTabActivated, switchSubTab: switchSubTab,
    shopBuySell: shopBuySell, cancelOrder: cancelOrder, publishOrder: publishOrder,
    refreshMarket: refreshMarket, quickTrade: quickTrade,
    openTradeSheet: openTradeSheet, closeTradeSheet: closeTradeSheet,
    confirmTradeSheet: confirmTradeSheet, toggleOrdersCollapse: toggleOrdersCollapse,
    getMarketItem: getMarketItem,
  };
})();
