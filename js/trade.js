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
  var shopBuyData = null;       // ItemVO[]（买入列表）
  var shopSellData = null;      // ItemVO[]（卖出/回收列表）
  var bankInfo = null;
  var shopOpenCat = null;       // 商店当前展开的分类
  var shopLoading = false;
  var marketLoading = false;
  var marketDataCache = null;   // { acquireOrders, sellOrders } 原始数据
  var marketItems = null;       // { itemName: { sellOrders, buyOrders, ... } } 聚合数据
  var _ordersCollapsed = true;  // 订单卡片折叠状态

  // ========== 合同 & 清单面板 ==========
  var contractMode = 'public';     // 'public' | 'mine' | 'lists'
  var contractLoading = false;
  var contractData = null;         // { contracts: [...] } 或 { lists: [...] }
  var listData = null;             // 清单缓存 { lists: [...] }（供创建合同选择）
  var _listDraft = {};             // 清单构建器草稿 { itemName: qty }
  var _listBuilderVisible = false;
  var _lbOverlay = null;             // 清单构建器 overlay 实例
  var _lbOpenCat = null;             // 清单构建器当前展开的分类

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
  var _tsVvHandler = null;      // visualViewport 键盘适配
  var _tsWasFullscreen = false; // 打开前处于全屏 → 关闭后恢复

  // ========== 通用执行 ==========

  function exec(cmd, okLabel) {
    return UI.executeWithConfirm(cmd, okLabel);
  }

  // ========== 图标 ==========

  function iconHtml(name, size) {
    return Warehouse.renderIcon(name, size || 'card');
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
    if (tab === 'contract' && !contractData && !contractLoading) loadContracts();
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
      balBox.className = 'tr-info-box' + (bankInfo.balance > 0 ? ' good' : bankInfo.balance < 0 ? ' bad' : '');
      var odBox = document.getElementById('ti-overdraft');
      odBox.querySelector('.tr-info-val').innerHTML = bankInfo.overdraftLimit > 0 ? UI.fmtNum(bankInfo.overdraftLimit) + ' SC' : '无';
      odBox.className = 'tr-info-box' + (bankInfo.overdraftLimit > 0 ? ' good' : '');
      var vipBox = document.getElementById('ti-vip');
      vipBox.querySelector('.tr-info-val').innerHTML = bankInfo.vipDays > 0 ? bankInfo.vipDays + ' 天' : '—';
      vipBox.className = 'tr-info-box' + (bankInfo.vipDays > 0 ? ' good' : '');
    } else { row.style.display = 'none'; }
  }

  function toggleShopCat(hdr) {
    var body = hdr.nextElementSibling;
    if (body) {
      var isOpen = body.classList.toggle('open');
      hdr.querySelector('.arrow').classList.toggle('open', isOpen);
      shopOpenCat = isOpen ? hdr.parentElement.dataset.cat : null;
    }
  }

  function renderShop() {
    var container = document.getElementById('trade-shop-list');
    if (!container) return;
    renderInfo();
    var data = shopMode === 'buy' ? shopBuyData : shopSellData;
    var search = (document.getElementById('tr-shop-search').value || '').toLowerCase().trim();
    if (!data && shopLoading) { container.innerHTML = '<div class="tr-empty">加载中…</div>'; return; }
    if (!data || data.length === 0) { container.innerHTML = '<div class="tr-empty">暂无商品</div>'; return; }

    // 按分类分组（复用仓库的分类体系）
    var itemCategories = Warehouse.getItemCategories();
    var catOrder = Warehouse.getCatOrder();
    var groups = {};
    catOrder.forEach(function (cat) { groups[cat] = []; });

    data.forEach(function (item) {
      var found = false;
      for (var cat in itemCategories) {
        if (itemCategories[cat].indexOf(item.name) !== -1) {
          if (!search || item.name.toLowerCase().indexOf(search) !== -1) {
            groups[cat].push(item);
          }
          found = true;
          break;
        }
      }
      if (!found && (!search || item.name.toLowerCase().indexOf(search) !== -1)) {
        groups['其他'].push(item);
      }
    });

    var html = '';
    var openCat = shopOpenCat || catOrder.find(function (c) { return groups[c] && groups[c].length > 0; }) || '零件';

    catOrder.forEach(function (cat) {
      var items = groups[cat];
      if (!items || items.length === 0) return;
      var isOpen = cat === openCat;
      html += '<div class="wh-cat" data-cat="' + cat + '">'
        + '<div class="wh-cat-h" onclick="Trade.toggleShopCat(this)">'
        + '<span class="arrow' + (isOpen ? ' open' : '') + '">▸</span>'
        + '<span class="wh-cat-dot" style="background:' + Warehouse.getCatColor(cat) + '"></span>'
        + '<span class="wh-cat-label">' + cat + '</span>'
        + '<span class="wh-cat-count">' + items.length + ' 种</span>'
        + '</div>'
        + '<div class="wh-cat-body' + (isOpen ? ' open' : '') + '"><div class="wh-grid">';
      items.forEach(function (item) {
        var priceStr = item.price != null ? UI.fmtNum(item.price) + ' SC' : '—';
        html += '<div class="wh-card" onclick="Trade.shopBuySell(\'' + escAttr(item.name) + '\')">'
          + iconHtml(item.name)
          + '<span class="wh-card-name">' + escHtml(item.name) + '</span>'
          + '<span class="wh-card-amt">' + priceStr + '</span>'
          + '</div>';
      });
      html += '</div></div></div>';
    });

    if (!html) { container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的物品' : '暂无商品') + '</div>'; return; }
    container.innerHTML = html;
  }

  function shopBuySell(name) {
    var isBuy = shopMode === 'buy';
    var stock = Warehouse.getStock(name);
    UI.openQSheet(shopMode, name, {
      stock: stock, noCap: isBuy,
      onConfirm: function (m, qty) {
        var cmd = isBuy ? '!采购 提交 ' + name + ' ' + qty : '!收购 提交 ' + name + ' ' + qty;
        var label = (isBuy ? '已购买 ' : '已出售 ') + name;
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

  function refreshMarket() {
    if (marketMode === 'orders') loadMyOrders();
    else loadMarket();
  }

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
        exec(cmd, label).then(function () { Warehouse.markStale(); Warehouse.ensureData(); refreshMarket(); }).catch(function () {});
      }
    });
  }

  function cancelOrder(orderId) {
    document.getElementById('dc-msg').textContent = '确定要撤销订单 #' + orderId + ' 吗？';
    document.getElementById('dc-confirm-btn').textContent = '撤销';
    document.getElementById('dc-confirm-btn').onclick = function () {
      UI.closeDcDialog();
      exec('!市场 撤销订单 ' + orderId, '已撤销订单 #' + orderId).then(function () { refreshMarket(); }).catch(function () {});
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
        exec(cmd, label).then(function () { Warehouse.markStale(); Warehouse.ensureData(); refreshMarket(); }).catch(function () {});
      };
    });
    UI.switchTab('warehouse');
  }

  // ========== TradeSheet ==========

  /** 自适应分桶：按唯一价格聚合，>MAX_BUCKETS 时 greedy merge 相邻最近桶 */
  function buildBuckets(orders, MAX_BUCKETS) {
    MAX_BUCKETS = MAX_BUCKETS || 10;
    if (!orders || orders.length === 0) return { buckets: [], maxCount: 0, total: 0, minPrice: 0, maxPrice: 0 };

    // 按价格去重聚合
    var priceMap = {};
    orders.forEach(function (o) {
      var p = o.price;
      if (!priceMap[p]) priceMap[p] = { priceMin: p, priceMax: p, count: 0 };
      priceMap[p].count += o.count || 0;
    });
    var buckets = Object.keys(priceMap).map(Number).sort(function (a, b) { return a - b; }).map(function (p) {
      var b = priceMap[p];
      b.label = UI.fmtCompact(p);
      return b;
    });

    // >MAX_BUCKETS 时合并
    if (buckets.length > MAX_BUCKETS) {
      buckets = mergeBuckets(buckets, MAX_BUCKETS);
    }

    var maxCount = 0, total = 0, minP = Infinity, maxP = -Infinity;
    buckets.forEach(function (b) {
      maxCount = Math.max(maxCount, b.count);
      total += b.count;
      if (b.priceMin < minP) minP = b.priceMin;
      if (b.priceMax > maxP) maxP = b.priceMax;
    });
    return { buckets: buckets, maxCount: maxCount, total: total, minPrice: minP, maxPrice: maxP };
  }

  /** Greedy merge：每次合并相对差距最小的一对相邻桶，直到 ≤ target */
  function mergeBuckets(buckets, target) {
    while (buckets.length > target) {
      var bestGap = Infinity, bestIdx = -1;
      for (var i = 0; i < buckets.length - 1; i++) {
        var a = buckets[i], b = buckets[i + 1];
        var mid = (a.priceMin + b.priceMax) / 2;
        var gap = mid > 0 ? (b.priceMin - a.priceMax) / mid : 0;
        if (gap < bestGap) { bestGap = gap; bestIdx = i; }
      }
      // 合并 bestIdx 和 bestIdx+1
      var prev = buckets[bestIdx], next = buckets[bestIdx + 1];
      prev.priceMax = Math.max(prev.priceMax, next.priceMax);
      prev.count += next.count;
      prev.label = UI.fmtCompact(prev.priceMin) + '~' + UI.fmtCompact(prev.priceMax);
      buckets.splice(bestIdx + 1, 1);
    }
    return buckets;
  }

  /** 累积填充计算：桶内从下往上填满再进下一个。返回 fills(0~100)、当前桶索引、当前价 */
  function computeAccum(buckets, maxPrice, qty, asc) {
    var fills = buckets.map(function () { return 0; });
    var currentIdx = -1, currentPrice = 0;
    if (!qty || qty <= 0 || !buckets.length) return { fills: fills, currentIdx: currentIdx, currentPrice: currentPrice };
    var remaining = qty;
    for (var i = 0; i < buckets.length; i++) {
      var idx = asc ? i : buckets.length - 1 - i;
      var b = buckets[idx];
      if (asc && b.priceMin > maxPrice) break;
      if (!asc && b.priceMax < maxPrice) break;
      if (b.count <= 0) continue;
      if (remaining <= 0) break;
      if (b.count >= remaining) {
        fills[idx] = Math.round((remaining / b.count) * 100);
        currentIdx = idx;
        currentPrice = asc ? b.priceMin : b.priceMax;
        remaining = 0;
      } else {
        fills[idx] = 100;
        remaining -= b.count;
      }
    }
    return { fills: fills, currentIdx: currentIdx, currentPrice: currentPrice };
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
        refreshMarket();
      }).catch(function () {});
    };

    renderChart();
    updateTsDisplay();

    // 全屏模式下 Android 键盘不触发视口变化（已知浏览器 bug）→ 暂时退出全屏
    _tsWasFullscreen = !!document.fullscreenElement;
    if (_tsWasFullscreen) {
      document.exitFullscreen();
    }

    // iOS 键盘适配：position:fixed 不随键盘上移，用 visualViewport + transform
    if (window.visualViewport) {
      _tsVvHandler = function () {
        var kbH = window.innerHeight - window.visualViewport.height;
        var sheet = document.getElementById('tradesheet');
        if (kbH > 100) {
          sheet.style.transform = 'translateY(-' + kbH + 'px)';
        } else {
          sheet.style.transform = '';
        }
      };
      window.visualViewport.addEventListener('resize', _tsVvHandler);
      window.visualViewport.addEventListener('scroll', _tsVvHandler);
    }

    document.getElementById('tradesheet-overlay').classList.add('show');
  }

  function closeTradeSheet() {
    if (_tsVvHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', _tsVvHandler);
      window.visualViewport.removeEventListener('scroll', _tsVvHandler);
      _tsVvHandler = null;
      document.getElementById('tradesheet').style.transform = '';
    }
    document.getElementById('tradesheet-overlay').classList.remove('show');
    _tsOnConfirm = null;
    // 打开前若处于全屏 → 恢复
    if (_tsWasFullscreen) {
      _tsWasFullscreen = false;
      setTimeout(function () {
        document.documentElement.requestFullscreen().catch(function () {});
      }, 400);
    }
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

    var acc = computeAccum(tsBuckets, tsPrice, tsQty, tsMode === 'buy');
    var maxFmt = UI.fmtCompact(tsMaxBucket);
    var midFmt = UI.fmtCompact(Math.round(tsMaxBucket / 2));
    var N = tsBuckets.length;

    var html = '<div class="ts-chart-inner">';

    // Y轴（左）
    html += '<div class="ts-yaxis">'
      + '<span>' + maxFmt + '</span>'
      + '<span>' + midFmt + '</span>'
      + '<span>0</span>'
      + '</div>';

    // 柱状图 + 横轴标签（列布局：每列 bar + label）
    html += '<div class="ts-bars-wrap"><div class="ts-bars">';
    for (var i = 0; i < N; i++) {
      var b = tsBuckets[i];
      var h = tsMaxBucket > 0 ? Math.round((b.count / tsMaxBucket) * 100) : 0;
      var fill = acc.fills[i];
      var bg = fill > 0
        ? 'linear-gradient(to top, var(--jade-200) ' + fill + '%, var(--bg-hover) ' + fill + '%)'
        : 'var(--bg-hover)';
      var isCur = i === acc.currentIdx && acc.currentPrice > 0;
      var isLast = i === N - 1;
      // 标签：当前价（绿）> 末桶价 > 其余空白占位（保基线对齐）
      var lbl = '';
      if (isCur) {
        lbl = '<span class="ts-xlbl ts-xlbl-cur">' + UI.fmtCompact(acc.currentPrice) + ' SC</span>';
      } else if (isLast) {
        lbl = '<span class="ts-xlbl">' + UI.fmtCompact(b.priceMax) + ' SC</span>';
      } else {
        lbl = '<span class="ts-xlbl"></span>';  // 始终占位，首桶省略文字但保留空间
      }
      html += '<div class="ts-bar-col">'
        + '<div class="ts-bar" style="height:' + h + '%;background:' + bg + ';min-width:3px" title="' + b.label + ': ' + UI.fmtCompact(b.count) + ' 件"></div>'
        + lbl
        + '</div>';
    }
    html += '</div></div>';

    html += '</div>'; // .ts-chart-inner

    // X轴单位
    html += '<div class="ts-xunit">SC</div>';

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
    var cost = calcFillCost(tsQty, tsPrice, tsMode);
    document.getElementById('ts-total').textContent = '预估成交 ' + UI.fmtPrice(cost.total) + ' SC（均价 ' + UI.fmtCompact(cost.avgPrice) + '）';
  }

  /**
   * 分段计算成交总价：从最优价开始逐档成交直到满足数量或超出限价
   * @returns {{ total: number, avgPrice: number }}
   */
  function calcFillCost(qty, priceCap, mode) {
    if (!_tsOrders || !_tsOrders.length) return { total: priceCap * qty, avgPrice: priceCap };
    var remaining = qty;
    var total = 0;
    for (var i = 0; i < _tsOrders.length; i++) {
      var o = _tsOrders[i];
      if (mode === 'buy' && o.price > priceCap) break;   // 卖出价超出买入限价
      if (mode === 'sell' && o.price < priceCap) break;  // 买入价低于卖出限价
      var take = Math.min(remaining, o.count);
      total += take * o.price;
      remaining -= take;
      if (remaining <= 0) break;
    }
    // 订单簿耗尽仍未满：剩余部分按限价估算
    total += remaining * priceCap;
    return { total: total, avgPrice: qty > 0 ? Math.round(total / qty) : 0 };
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

  // ========== 合同 & 清单面板 ==========

  function loadContracts() {
    if (contractLoading) return;
    contractLoading = true;
    renderContracts();
    var cmd;
    if (contractMode === 'lists') {
      cmd = '!清单 列表';
    } else if (contractMode === 'mine') {
      cmd = '!合同 我的列表';
    } else {
      cmd = '!合同 列表';
    }
    exec(cmd, null).then(function (d) {
      contractData = d;
      contractLoading = false;
      // 清单数据同时缓存供创建合同使用
      if (contractMode === 'lists') listData = d;
      renderContracts();
    }).catch(function () {
      contractData = null;
      contractLoading = false;
      renderContracts();
    });
  }

  function refreshContracts() { contractData = null; loadContracts(); }

  function switchContractMode(mode) {
    if (mode === contractMode) return;
    contractMode = mode;
    document.querySelectorAll('.tr-contract-mode').forEach(function (el) {
      el.classList.toggle('active', el.dataset.contractMode === mode);
    });
    // 更新搜索框占位
    var searchEl = document.getElementById('tr-contract-search');
    if (searchEl) {
      searchEl.placeholder = mode === 'lists' ? '搜索清单…' : '搜索合同中的物品…';
    }
    // 关闭可能打开的表单
    closeListBuilder();
    document.getElementById('ct-create-contract-form').style.display = 'none';
    contractData = null;
    loadContracts();
  }

  // ========== 合同渲染 ==========

  function renderContracts() {
    var container = document.getElementById('trade-contract-list');
    if (!container) return;

    if (!contractData && contractLoading) {
      container.innerHTML = '<div class="tr-empty">加载中…</div>';
      return;
    }

    if (contractMode === 'lists') { renderLists(container); return; }

    var search = (document.getElementById('tr-contract-search').value || '').toLowerCase().trim();
    var contracts = contractData && Array.isArray(contractData.contracts) ? contractData.contracts : [];

    // "我的合同"模式显示创建按钮
    var createBtn = contractMode === 'mine' && contracts.length >= 0
      ? '<button class="ct-act-create-btn" onclick="Trade.toggleCreateContract()">+ 创建合同</button>' : '';

    if (contracts.length === 0) {
      container.innerHTML = createBtn + '<div class="tr-empty">暂无合同</div>';
      return;
    }

    var filtered = contracts;
    if (search) {
      filtered = contracts.filter(function (c) {
        if (c.ownerDisplayName && c.ownerDisplayName.toLowerCase().indexOf(search) !== -1) return true;
        if (String(c.id).indexOf(search) !== -1) return true;
        var offerItems = c.offerList && c.offerList.items ? Object.keys(c.offerList.items) : [];
        var wantItems = c.wantList && c.wantList.items ? Object.keys(c.wantList.items) : [];
        var all = offerItems.concat(wantItems);
        for (var i = 0; i < all.length; i++) {
          if (all[i].toLowerCase().indexOf(search) !== -1) return true;
        }
        return false;
      });
    }

    var html = createBtn;
    if (filtered.length === 0) {
      html += '<div class="tr-empty">' + (search ? '没有匹配的合同' : '暂无合同') + '</div>';
    } else {
      filtered.forEach(function (c) { html += renderContractCard(c); });
    }
    container.innerHTML = html;
  }

  function renderContractCard(c) {
    var creds = SeBridge.getCredentials();
    var isOwn = creds && c.ownerSteamId && String(c.ownerSteamId) === String(creds.steamId);
    var offerHtml = renderContractListDetail(c.offerList, 'offer');
    var wantHtml = renderContractListDetail(c.wantList, 'want');

    var actions = '';
    if (isOwn && contractMode === 'mine') {
      actions += '<button class="ct-act-btn ct-act-delete" onclick="Trade.deleteContract(\'' + escAttr(String(c.id)) + '\')">删除</button>';
      actions += '<button class="ct-act-btn" onclick="Trade.toggleContractPublic(\'' + escAttr(String(c.id)) + '\',' + (c.isPublic ? 'false' : 'true') + ')">' + (c.isPublic ? '设为私密' : '设为公开') + '</button>';
    }
    if (!isOwn || contractMode === 'public') {
      actions += '<button class="ct-act-btn ct-act-accept" onclick="Trade.acceptContract(\'' + escAttr(String(c.id)) + '\')">接受</button>';
    }

    return '<div class="ct-card">'
      + '<div class="ct-header">'
      + '<span class="ct-id-badge">#' + escHtml(String(c.id)) + '</span>'
      + '<span class="ct-owner">' + escHtml(c.ownerDisplayName || '未知') + '</span>'
      + (c.isPublic ? '<span class="ct-badge ct-badge-public">公开</span>' : '<span class="ct-badge ct-badge-private">私密</span>')
      + '</div>'
      + '<div class="ct-lists">'
      + '<div class="ct-list ct-list-offer"><div class="ct-list-label">付出</div>' + offerHtml + '</div>'
      + '<div class="ct-list ct-list-want"><div class="ct-list-label">索取</div>' + wantHtml + '</div>'
      + '</div>'
      + (actions ? '<div class="ct-actions">' + actions + '</div>' : '')
      + '</div>';
  }

  function renderContractListDetail(list, side) {
    if (!list) return '<div class="ct-list-empty">—</div>';
    var parts = [];
    if (list.money && list.money > 0) {
      parts.push('<span class="ct-list-item">'
        + '<span style="font-size:12px">💰</span>'
        + '<span class="ct-list-qty">' + UI.fmtCompact(list.money) + ' SC</span>'
        + '</span>');
    }
    if (list.items) {
      var names = Object.keys(list.items).sort();
      names.forEach(function (name) {
        var qty = list.items[name];
        parts.push('<span class="ct-list-item">' + Warehouse.renderIcon(name, 'sm')
          + '<span class="ct-list-qty">×' + UI.fmtCompact(qty) + '</span>'
          + '</span>');
      });
    }
    if (parts.length === 0) return '<div class="ct-list-empty">—</div>';
    return '<div class="ct-list-items">' + parts.join('') + '</div>';
  }

  function acceptContract(id) {
    UI.showConfirmDialog('接受合同 #' + id + '？\n请确保仓库物资和银行余额足够满足合同中的索取项。', function () {
      exec('!合同 接受 ' + id, '已接受合同 #' + id).then(function () { loadContracts(); }).catch(function () {});
    });
  }

  function deleteContract(id) {
    UI.showConfirmDialog('确定要删除合同 #' + id + ' 吗？', function () {
      exec('!合同 删除 ' + id, '已删除合同 #' + id).then(function () { loadContracts(); }).catch(function () {});
    });
  }

  function toggleContractPublic(id, isPublic) {
    var label = isPublic ? '公开' : '私密';
    exec('!合同 公开 ' + id + ' ' + isPublic, '合同 #' + id + ' 已设为' + label).then(function () { loadContracts(); }).catch(function () {});
  }

  // ========== 清单渲染 ==========

  function renderLists(container) {
    var search = (document.getElementById('tr-contract-search').value || '').toLowerCase().trim();
    var lists = contractData && Array.isArray(contractData.lists) ? contractData.lists : [];

    var html = '<button class="ct-act-create-btn" onclick="Trade.openListBuilder()">+ 创建清单</button>';

    if (lists.length === 0) {
      html += '<div class="tr-empty">暂无清单</div>';
    } else {
      var filtered = lists;
      if (search) {
        filtered = lists.filter(function (l) {
          if (l.name && l.name.toLowerCase().indexOf(search) !== -1) return true;
          if (l.items) {
            for (var i = 0; i < l.items.length; i++) {
              if (l.items[i].name && l.items[i].name.toLowerCase().indexOf(search) !== -1) return true;
            }
          }
          return false;
        });
      }
      if (filtered.length === 0) {
        html += '<div class="tr-empty">' + (search ? '没有匹配的清单' : '暂无清单') + '</div>';
      } else {
        filtered.forEach(function (l) { html += renderListCard(l); });
      }
    }
    container.innerHTML = html;
  }

  function renderListCard(l) {
    var parts = [];
    if (l.money && l.money > 0) {
      parts.push('<span class="ct-list-item">'
        + '<span style="font-size:12px">💰</span>'
        + '<span class="ct-list-qty">' + UI.fmtCompact(l.money) + ' SC</span>'
        + '</span>');
    }
            if (l.items) {
              l.items.forEach(function (item) {
                parts.push('<span class="ct-list-item">' + Warehouse.renderIcon(item.name, 'sm')
                  + '<span class="ct-list-qty">×' + UI.fmtCompact(item.amount) + '</span>'
                  + '</span>');
              });
            }
    var itemHtml = parts.length > 0 ? '<div class="ct-list-items">' + parts.join('') + '</div>' : '<div class="ct-list-empty">—</div>';

    return '<div class="ct-list-card">'
      + '<div class="ct-list-name">' + escHtml(l.name || '未命名') + '</div>'
      + itemHtml
      + '<div class="ct-list-actions">'
      + '<button class="ct-act-btn ct-act-delete" onclick="Trade.deleteList(\'' + escAttr(l.name || '') + '\')">删除</button>'
      + '</div>'
      + '</div>';
  }

  // ========== 清单构建器 ==========

  var LIST_BUILDER_HTML = ''
    + '<div class="lb-header">'
    + '<span class="lb-title">创建清单</span>'
    + '<span class="lb-close">&times;</span>'
    + '</div>'
    + '<div class="lb-name-row">'
    + '<input id="lb-name" type="text" placeholder="清单名称">'
    + '</div>'
    + '<input class="wh-search" id="lb-search" type="text" placeholder="搜索物品…">'
    + '<div class="lb-grid-scroll" id="lb-grid-scroll">'
    + '<div id="lb-grid"></div>'
    + '</div>'
    + '<div class="lb-cart" id="lb-cart">'
    + '<div class="lb-cart-head">清单预览</div>'
    + '<div class="lb-cart-items" id="lb-cart-items"></div>'
    + '<div class="lb-cart-money">'
    + '<label>附带转账（可选）</label>'
    + '<div class="lb-money-row">'
    + '<input id="lb-money" type="text" inputmode="numeric" value="0" placeholder="0">'
    + '<span>SC</span>'
    + '</div>'
    + '</div>'
    + '<div class="lb-cart-actions">'
    + '<button class="lb-cancel">取消</button>'
    + '<button class="lb-confirm" id="lb-confirm">确认创建</button>'
    + '</div>'
    + '</div>';

  function openListBuilder() {
    if (!Warehouse.hasData()) {
      Warehouse.ensureData();
      UI.showToast('info', '正在加载物品数据…');
      return;
    }
    _listDraft = {};
    _listBuilderVisible = true;
    _lbOpenCat = Warehouse.getOpenCat();  // 从仓库同步初始展开分类
    if (!_lbOverlay) {
      _lbOverlay = UI.createOverlay('list-builder-overlay', LIST_BUILDER_HTML, {
        onBackdrop: closeListBuilder
      });
      _lbOverlay.on('.lb-close', 'click', closeListBuilder);
      _lbOverlay.on('.lb-cancel', 'click', closeListBuilder);
      _lbOverlay.on('#lb-confirm', 'click', confirmListBuilder);
      _lbOverlay.on('#lb-search', 'input', renderListBuilderGrid);
      _lbOverlay.on('#lb-money', 'input', function () {
        var hasItems = Object.keys(_listDraft).length > 0;
        _lbOverlay.get('#lb-confirm').disabled = !hasItems;
      });
    }
    _lbOverlay.get('#lb-name').value = '';
    _lbOverlay.get('#lb-money').value = '0';
    _lbOverlay.get('#lb-search').value = '';
    renderListBuilderGrid();
    renderListBuilderCart();
    _lbOverlay.show();
    setTimeout(function () { _lbOverlay.get('#lb-name').focus(); }, 300);
  }

  function closeListBuilder() {
    _listBuilderVisible = false;
    _listDraft = {};
    if (_lbOverlay) _lbOverlay.hide();
  }

  function renderListBuilderGrid() {
    var container = _lbOverlay && _lbOverlay.get('#lb-grid');
    if (!container) return;
    var search = (_lbOverlay.get('#lb-search').value || '').toLowerCase().trim();
    var cats = Warehouse.getItemCategories();
    var catOrder = Warehouse.getCatOrder();
    var html = '';
    var anyVisible = false;

    var catIdx = 0;
    catOrder.forEach(function (cat) {
      var items = cats[cat];
      if (!items || !items.length) return;
      var visible = [];
      items.forEach(function (name) {
        if (search && name.toLowerCase().indexOf(search) === -1) return;
        visible.push(name);
      });
      if (!visible.length) return;
      // null=未设定取第一个 / ''=明确折叠 / 其他=指定分类
      var isOpen = _lbOpenCat ? cat === _lbOpenCat : (_lbOpenCat === null && catIdx === 0);
      catIdx++;
      anyVisible = true;
      html += '<div class="lb-cat-h" onclick="Trade.setListBuilderCat(\'' + escAttr(cat) + '\')">'
        + '<span class="arrow' + (isOpen ? ' open' : '') + '">▸</span>'
        + '<span class="lb-cat-dot" style="background:' + Warehouse.getCatColor(cat) + '"></span>'
        + '<span class="lb-cat-label">' + escHtml(cat) + '</span>'
        + '<span class="lb-cat-count">' + visible.length + '</span>'
        + '</div>'
        + '<div class="lb-grid"' + (isOpen ? '' : ' style="display:none"') + '>';
      visible.forEach(function (name) {
        var qty = _listDraft[name] || 0;
        var stock = Warehouse.getStock(name);
        html += '<div class="lb-card' + (qty > 0 ? ' selected' : '') + '" onclick="Trade.pickItemForList(\'' + escAttr(name) + '\')">';
        html += Warehouse.renderIcon(name, 'sm');
        html += '<span class="lb-card-name">' + escHtml(name) + '</span>';
        html += '<span class="lb-card-stock">' + UI.fmtCompact(stock) + '</span>';
        if (qty > 0) {
          html += '<span class="lb-card-badge" onclick="event.stopPropagation();Trade.pickItemForList(\'' + escAttr(name) + '\')" title="点击修改数量">'
            + UI.fmtCompact(qty) + '</span>';
          html += '<span class="lb-card-rm" onclick="event.stopPropagation();Trade.removeFromListDraft(\'' + escAttr(name) + '\')" title="移出清单">&times;</span>';
        }
        html += '</div>';
      });
      html += '</div>';
    });

    if (!anyVisible) {
      container.innerHTML = '<div class="tr-empty">' + (search ? '没有匹配的物品' : '物品数据加载中…') + '</div>';
    } else {
      container.innerHTML = html;
    }
  }

  /** 切换清单构建器中的展开分类 */
  function setListBuilderCat(cat) {
    _lbOpenCat = _lbOpenCat === cat ? '' : cat;
    renderListBuilderGrid();
  }

  function pickItemForList(name) {
    var currentQty = _listDraft[name] || 0;
    UI.openQSheet('deposit', name, {
      stock: Warehouse.getStock(name) || 999999,
      confirmLabel: '加入清单',
      onConfirm: function (mode, qty) {
        if (qty > 0) {
          _listDraft[name] = qty;
        } else {
          delete _listDraft[name];
        }
        renderListBuilderGrid();
        renderListBuilderCart();
        if (qty > 0) animateItemToCart(name);
      }
    });
    // 预填当前数量
    if (currentQty > 0) {
      document.getElementById('qs-qty').value = currentQty;
    }
  }

  function removeFromListDraft(name) {
    delete _listDraft[name];
    renderListBuilderGrid();
    renderListBuilderCart();
  }

  function updateListBuilderMoney() {
    // (已内联到工厂事件绑定中)
  }

  function renderListBuilderCart() {
    if (!_lbOverlay) return;
    var cartEl = _lbOverlay.get('#lb-cart');
    var names = Object.keys(_listDraft);
    if (names.length === 0) {
      _lbOverlay.get('#lb-cart-items').innerHTML = '<span class="lb-cart-empty">尚未选择物品，点击上方物品加入清单</span>';
      _lbOverlay.get('#lb-confirm').disabled = true;
      return;
    }
    _lbOverlay.get('#lb-confirm').disabled = false;
    var itemsHtml = '';
    names.forEach(function (name) {
      itemsHtml += '<span class="lb-cart-chip" onclick="Trade.removeFromListDraft(\'' + escAttr(name) + '\')" title="' + escAttr(name) + '">'
        + Warehouse.renderIcon(name)
        + '<span class="lb-chip-remove">×</span>'
        + '</span>';
    });
    _lbOverlay.get('#lb-cart-items').innerHTML = itemsHtml;
  }

  /** 物品飞入购物车动画（抛物线 + 弹跳感） */
  function animateItemToCart(name) {
    if (!_lbOverlay) return;
    // 在网格中找到刚加入的物品卡片
    var cards = _lbOverlay.el.querySelectorAll('.lb-card.selected');
    var sourceCard = null;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].textContent.indexOf(name) !== -1) { sourceCard = cards[i]; break; }
    }
    if (!sourceCard) return;
    var srcRect = sourceCard.getBoundingClientRect();

    // 刚加入的物品 chip 始终是最后一个
    var chips = _lbOverlay.el.querySelectorAll('.lb-cart-chip');
    var targetChip = chips.length ? chips[chips.length - 1] : null;
    var targetEl = targetChip || _lbOverlay.get('#lb-cart-items');
    var tgtRect = targetEl.getBoundingClientRect();

    // 发光小球，从卡片中心飞向购物车中心
    var dot = document.createElement('div');
    var s = 12;
    dot.style.cssText = 'position:fixed;z-index:9999;width:' + s + 'px;height:' + s + 'px;'
      + 'border-radius:50%;background:#4ade80;pointer-events:none;'
      + 'box-shadow:0 0 12px #4ade80,0 0 24px rgba(74,222,128,.4);';
    var sx = srcRect.left + srcRect.width / 2 - s / 2;
    var sy = srcRect.top + srcRect.height / 2 - s / 2;
    var ex = tgtRect.left + tgtRect.width / 2 - s / 2;
    var ey = tgtRect.top + tgtRect.height / 2 - s / 2;
    dot.style.left = sx + 'px';
    dot.style.top = sy + 'px';
    document.body.appendChild(dot);

    var dur = 480;
    var start = performance.now();

    // 抛物线控制点：弧顶在起点/终点上方的较高者再往上 70px
    var peakY = Math.min(sy, ey) - 70;
    var cy = 2 * peakY - 0.5 * sy - 0.5 * ey; // 贝塞尔控制点 Y

    function frame(now) {
      var t = Math.min((now - start) / dur, 1);
      // x：缓出（先快后慢）
      var x = sx + (ex - sx) * (1 - Math.pow(1 - t, 3));
      // y：二次贝塞尔抛物线
      var y = (1 - t) * (1 - t) * sy + 2 * (1 - t) * t * cy + t * t * ey;
      // 缩放：中间放大，末端缩小
      var scale = 1 + 0.5 * Math.sin(t * Math.PI);
      dot.style.left = x + 'px';
      dot.style.top = y + 'px';
      dot.style.transform = 'scale(' + scale + ')';
      dot.style.opacity = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;

      if (t < 1) { requestAnimationFrame(frame); }
      else { dot.remove(); }
    }
    requestAnimationFrame(frame);

    // 购物车短暂高亮反馈
    setTimeout(function () {
      var cart = _lbOverlay.get('#lb-cart');
      if (cart) {
        cart.style.transition = 'box-shadow .15s';
        cart.style.boxShadow = 'inset 0 0 24px rgba(74,222,128,.25)';
        setTimeout(function () { cart.style.boxShadow = ''; }, 200);
      }
    }, Math.round(dur * 0.7));
  }

  function confirmListBuilder() {
    if (!_lbOverlay) return;
    var name = _lbOverlay.get('#lb-name').value.trim();
    if (!name) { UI.showToast('error', '请输入清单名称'); return; }
    var names = Object.keys(_listDraft);
    if (names.length === 0) { UI.showToast('error', '请至少选择一个物品'); return; }
    var parts = names.map(function (n) { return n + '=' + _listDraft[n]; });
    var moneyVal = parseInt(_lbOverlay.get('#lb-money').value.replace(/[^\d]/g, ''), 10) || 0;
    if (moneyVal > 0) parts.push('money=' + moneyVal);
    var args = parts.join(' ');
    exec('!清单 创建 ' + name + ' "' + args + '"', '已创建清单「' + name + '」').then(function () {
      closeListBuilder();
      contractData = null;
      loadContracts();
    }).catch(function () {});
  }

  function deleteList(name) {
    UI.showConfirmDialog('确定要删除清单「' + name + '」吗？', function () {
      exec('!清单 删除 ' + name, '已删除清单「' + name + '」').then(function () {
        contractData = null;
        loadContracts();
      }).catch(function () {});
    });
  }

  // ========== 创建合同 ==========

  function toggleCreateContract() {
    // 确保有清单缓存
    if (!listData) {
      // 静默加载清单
      exec('!清单 列表', null).then(function (d) {
        listData = d;
        showCreateContractForm();
      }).catch(function () {
        UI.showToast('error', '获取清单失败');
      });
      return;
    }
    showCreateContractForm();
  }

  function showCreateContractForm() {
    var form = document.getElementById('ct-create-contract-form');
    var isOpen = form.style.display !== 'none';
    form.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      var lists = listData && Array.isArray(listData.lists) ? listData.lists : [];
      var sel1 = document.getElementById('ct-contract-list1');
      var sel2 = document.getElementById('ct-contract-list2');
      var opts = '<option value="">— 选择清单 —</option>';
      lists.forEach(function (l) {
        opts += '<option value="' + escAttr(l.name || '') + '">' + escHtml(l.name || '') + '</option>';
      });
      sel1.innerHTML = opts;
      sel2.innerHTML = opts;
      document.getElementById('ct-contract-public').checked = false;
      document.getElementById('ct-contract-preview').style.display = 'none';
      // 选择变化时预览
      sel1.onchange = updateContractPreview;
      sel2.onchange = updateContractPreview;
    }
  }

  function updateContractPreview() {
    var name1 = document.getElementById('ct-contract-list1').value;
    var name2 = document.getElementById('ct-contract-list2').value;
    var preview = document.getElementById('ct-contract-preview');
    var lists = listData && Array.isArray(listData.lists) ? listData.lists : [];
    var l1 = null, l2 = null;
    lists.forEach(function (l) { if (l.name === name1) l1 = l; if (l.name === name2) l2 = l; });
    if (!l1 && !l2) { preview.style.display = 'none'; return; }
    var text = '';
    if (l1) {
      text += '付出: ' + (l1.money > 0 ? UI.fmtCompact(l1.money) + ' SC' : '') + (l1.items && l1.items.length > 0 ? ' + ' + l1.items.length + ' 种物品' : '') + '\n';
    }
    if (l2) {
      text += '索取: ' + (l2.money > 0 ? UI.fmtCompact(l2.money) + ' SC' : '') + (l2.items && l2.items.length > 0 ? ' + ' + l2.items.length + ' 种物品' : '');
    }
    preview.textContent = text;
    preview.style.display = 'block';
  }

  function submitCreateContract() {
    var name1 = document.getElementById('ct-contract-list1').value;
    var name2 = document.getElementById('ct-contract-list2').value;
    var isPublic = document.getElementById('ct-contract-public').checked;
    if (!name1 || !name2) { UI.showToast('error', '请选择两份清单'); return; }
    var cmd = '!合同 创建 ' + name1 + ' ' + name2 + (isPublic ? ' true' : '');
    exec(cmd, '合同已创建').then(function () {
      document.getElementById('ct-create-contract-form').style.display = 'none';
      contractData = null;
      loadContracts();
    }).catch(function () {});
  }

  function initContract() {
    document.querySelectorAll('.tr-contract-mode').forEach(function (el) {
      el.addEventListener('click', function () { switchContractMode(el.dataset.contractMode); });
    });
    document.getElementById('tr-contract-search').addEventListener('input', function () { renderContracts(); });
  }

  // ========== 初始化 ==========

  function init() {
    initSubTabs();
    initShop();
    initMarket();
    initContract();

    // TradeSheet 按钮
    document.getElementById('ts-cancel').addEventListener('click', closeTradeSheet);
    document.getElementById('ts-confirm').addEventListener('click', confirmTradeSheet);
    document.getElementById('tradesheet-overlay').addEventListener('click', function (e) {
      if (e.target === this) closeTradeSheet();
    });
    document.getElementById('ts-price').addEventListener('input', onTsPriceInput);
    document.getElementById('ts-qty').addEventListener('input', onTsQtyInput);
    // 手机输入法弹窗时自动滚到可见位置
    var _tsInitH = window.innerHeight;
    var _tsFocusScroll = function () {
      var self = this;
      // Android：viewport resize → 延迟等键盘动画 → scrollIntoView
      // iOS：visualViewport resize → transform 顶卡片（由 _tsVvHandler 处理）
      setTimeout(function () {
        var nowH = window.innerHeight;
        if (nowH < _tsInitH - 100) {
          // Android 键盘已弹出（viewport 缩小）→ 滚容器
          self.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 500);
    };
    document.getElementById('ts-price').addEventListener('focus', _tsFocusScroll);
    document.getElementById('ts-qty').addEventListener('focus', _tsFocusScroll);
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
    shopBuySell: shopBuySell, toggleShopCat: toggleShopCat, cancelOrder: cancelOrder, publishOrder: publishOrder,
    refreshMarket: refreshMarket, quickTrade: quickTrade,
    openTradeSheet: openTradeSheet, closeTradeSheet: closeTradeSheet,
    confirmTradeSheet: confirmTradeSheet, toggleOrdersCollapse: toggleOrdersCollapse,
    getMarketItem: getMarketItem,
    // 合同 & 清单
    refreshContracts: refreshContracts, switchContractMode: switchContractMode,
    loadContracts: loadContracts, renderContracts: renderContracts,
    acceptContract: acceptContract, deleteContract: deleteContract,
    toggleContractPublic: toggleContractPublic,
    openListBuilder: openListBuilder, closeListBuilder: closeListBuilder,
    pickItemForList: pickItemForList, removeFromListDraft: removeFromListDraft,
    setListBuilderCat: setListBuilderCat,
    confirmListBuilder: confirmListBuilder, renderListBuilderGrid: renderListBuilderGrid,
    updateListBuilderMoney: updateListBuilderMoney,
    deleteList: deleteList, toggleCreateContract: toggleCreateContract,
    submitCreateContract: submitCreateContract,
  };
})();
