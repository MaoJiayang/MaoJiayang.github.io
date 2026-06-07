/**
 * command-autocomplete.js - 指令自动补全模块
 * 依赖：commands.html 中的样式、DOM 结构和 SECTION_META、esc()、filter()
 * 由 AcModule.init(ctx) 在 initSearch() 内初始化
 */
var AcModule = (function () {
    'use strict';

    // ====== 数据层（模块级，与页面生命周期无关）======

    var _commandsData = null;
    var _trieRoot = null;
    var _items = null;
    var _itemCmdIds = null;

    /** 加载指令数据并构建 Trie */
    function setData(data) {
        _commandsData = data;
    }

    /** 加载物品名称，从已加载的指令数据中自动推导物品指令 ID */
    function setItemConfig(items) {
        _items = items;
        _itemCmdIds = new Set();
        if (_commandsData) {
            _commandsData.forEach(function (cmd) {
                if (cmd.params && cmd.params.some(function (p) { return p.autocomplete === 'items'; })) {
                    _itemCmdIds.add(cmd.id);
                }
            });
        }
    }

    /** 构建 Trie 前缀树（仅 ! 开头的别名） */
    function buildTrie() {
        _trieRoot = { children: new Map(), results: [] };
        if (!_commandsData) return;
        // 插入指令别名路径
        _commandsData.forEach(function (cmd) {
            cmd.commands.forEach(function (alias) {
                if (!alias.startsWith('!')) return;
                var node = _trieRoot;
                var lower = alias.toLowerCase();
                for (var i = 0; i < lower.length; i++) {
                    var c = lower[i];
                    if (!node.children.has(c)) {
                        node.children.set(c, { children: new Map(), results: [] });
                    }
                    node = node.children.get(c);
                    node.results.push({ cmd: cmd, alias: alias });
                }
            });
        });
        // 物品补全不再预建 Trie 路径，改为查询时通过 getParamContext 动态匹配
    }

    /** Trie 前缀查找 */
    function getMatches(prefix) {
        if (!_trieRoot) return [];
        var node = _trieRoot;
        var lower = prefix.toLowerCase();
        for (var i = 0; i < lower.length; i++) {
            if (!node.children.has(lower[i])) return [];
            node = node.children.get(lower[i]);
        }
        return node.results.slice().sort(function (a, b) {
            return a.alias.length - b.alias.length;
        });
    }

    /** 物品名子串匹配（前缀无结果时的回退） */
    function matchItemsBySubstring(query) {
        if (!_items || !query) return [];
        var lower = query.toLowerCase();
        return _items.filter(function (name) {
            return name.toLowerCase().indexOf(lower) !== -1;
        });
    }

    /**
     * 解析当前输入所处的参数上下文
     * @param {string} raw 原始输入
     * @returns {Object|null} { cmd, alias, paramIndex, param, partial } 或 null
     */
    function getParamContext(raw) {
        var t = raw.replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
        if (!t.startsWith('!') && !t.startsWith('！')) return null;

        var endsWithSpace = /\s$/.test(t);
        var parts = t.trim().split(/\s+/);
        if (parts.length === 0) return null;

        // 从最长到最短尝试匹配指令前缀
        for (var i = parts.length; i >= 1; i--) {
            var cmdPrefix = parts.slice(0, i).join(' ');
            var allMatches = getMatches(cmdPrefix);
            if (allMatches.length === 0) continue;

            // 多个匹配时，筛选别名完全等于前缀的那条（解决 "!仓库 存入" vs "!仓库 存入清单" 前缀重叠）
            var matches = allMatches;
            if (matches.length > 1) {
                var lowerPrefix = cmdPrefix.toLowerCase();
                var exact = matches.filter(function (m) { return m.alias.toLowerCase() === lowerPrefix; });
                if (exact.length === 1) matches = exact;
            }

            if (matches.length === 1) {
                var cmd = matches[0].cmd;
                var params = cmd.params || [];
                if (params.length === 0) return null;

                var typedParts = parts.length - i;
                var paramIndex, partial;

                // 还在输入指令本身，未进入参数区
                if (typedParts === 0 && !endsWithSpace) return null;

                if (endsWithSpace || typedParts === 0) {
                    // 指令后跟空格 → 准备输入下一个参数
                    paramIndex = typedParts;
                    partial = '';
                } else {
                    // 正在输入某个参数值
                    paramIndex = typedParts - 1;
                    partial = parts[parts.length - 1];
                }

                if (paramIndex >= params.length) {
                    paramIndex = params.length - 1;
                    partial = parts[parts.length - 1];
                }

                return {
                    cmd: cmd,
                    alias: matches[0].alias,
                    paramIndex: paramIndex,
                    param: params[paramIndex],
                    partial: partial || ''
                };
            }
        }
        return null;
    }

    // ====== 运行时（每个 initSearch() 调用初始化一次）======

    /**
     * @param {Object} ctx
     * @param {HTMLInputElement} ctx.q
     * @param {HTMLElement} ctx.semPanel
     * @param {HTMLElement} ctx.searchWrap
     * @param {Object} ctx.SECTION_META
     * @param {Function} ctx.esc
     * @param {Function} ctx.filter
     * @param {Function} ctx.scheduleSemanticSearch
     * @param {string} ctx.SEARCH_URL
     * @param {Object} ctx.semTimerRef  - { current: number|null } 引用，用于 clearTimeout
     */
    function init(ctx) {
        var q = ctx.q;
        var semPanel = ctx.semPanel;
        var searchWrap = ctx.searchWrap;
        var SECTION_META = ctx.SECTION_META;
        var esc = ctx.esc;
        var filter = ctx.filter;
        var scheduleSemanticSearch = ctx.scheduleSemanticSearch;
        var SEARCH_URL = ctx.SEARCH_URL;
        var semTimerRef = ctx.semTimerRef;

        // DOM 引用
        var acPanel = document.getElementById('ac-panel');
        var acGhost = document.getElementById('ac-ghost');

        // 状态
        var currentAcResults = [];
        var currentAcHlIndex = -1;
        var acSemTimer = null;
        var _acJustFilled = false;
        var _acCorrection = false;

        // ====== 模式控制 ======

        function showAcMode() {
            q.classList.add('ac-mode');
        }

        function hideAcMode() {
            q.classList.remove('ac-mode');
        }

        function hideAcPanel() {
            acPanel.classList.remove('show');
            hideAcMode();
            hideGhost();
            currentAcHlIndex = -1;
            currentAcResults = [];
        }

        function exitAcMode() {
            hideAcPanel();
            q.focus();
        }

        // ====== 虚影 ======

        function hideGhost() {
            acGhost.innerHTML = '';
            q.style.color = '';
            q.style.caretColor = '';
        }

        function updateGhost(typedPrefix) {
            if (!typedPrefix || currentAcResults.length === 0) {
                acGhost.innerHTML = '';
                return;
            }
            if (_acCorrection) {
                var idx = currentAcHlIndex >= 0 ? currentAcHlIndex : 0;
                var fix = currentAcResults[idx].alias;
                acGhost.innerHTML =
                    '<span class="ghost-err-box">' + esc(typedPrefix) + '</span>' +
                    '<span class="ghost-arrow">→</span>' +
                    '<span class="ghost-fix-box">' + esc(fix) + '</span>';
                return;
            }
            var idx = currentAcHlIndex >= 0 ? currentAcHlIndex : 0;
            var r = currentAcResults[idx];
            var match = r.type === 'item' ? r.alias + ' ' + r.itemName : r.alias;
            if (match.toLowerCase().startsWith(typedPrefix.toLowerCase())) {
                var remaining = match.slice(typedPrefix.length);
                acGhost.innerHTML =
                    '<span class="ghost-typed">' + esc(typedPrefix) + '</span>' +
                    '<span class="ghost-hint">' + esc(remaining) + '</span>';
            } else {
                acGhost.innerHTML = '<span class="ghost-typed">' + esc(typedPrefix) + '</span>';
            }
        }

        // ====== 触发判断 ======

        function getAutocompletePrefix(raw) {
            var t = raw.replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
            if (t.startsWith('!') || t.startsWith('！')) {
                return '!' + t.slice(1);
            }
            return null;
        }

        // ====== 填入命令 ======

        function fillAcCommand(result) {
            q.value = result.type === 'item'
                ? result.alias + ' ' + result.itemName + ' '
                : result.alias + ' ';
            _acJustFilled = true;
            hideAcPanel();
            q.focus();
            q.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // ====== 面板渲染 ======

        function renderAcPanel(results, hlIndex, prefix) {
            if (!results || results.length === 0) {
                hideAcMode();
                hideGhost();
                acPanel.innerHTML = '<div class="ac-card">'
                    + '<div class="ac-card-h">指令补全'
                    + '<span class="ac-card-actions"><button id="ac-hist" title="最近执行">最近</button><button id="ac-close">×</button></span>'
                    + '</div><div class="ac-card-body"><div class="ac-nores">没有匹配的指令</div></div></div>';
                acPanel.classList.add('show');
                return;
            }
            if (!_acCorrection) showAcMode();
            var isItem = results.length > 0 && results[0].type === 'item';
            var isMobile = window.matchMedia('(max-width: 768px)').matches;
            var maxItems = isMobile ? 6 : 10;
            var headerText = _acCorrection ? '💡 你是不是想找' : (isItem ? '📦 物品补全' : '⌨️ 指令补全');
            var items = results.slice(0, maxItems).map(function (r, i) {
                if (isItem) {
                    return '<div class="ac-item' + (i === hlIndex ? ' hl' : '') + '" data-index="' + i + '">'
                        + '<div class="ac-item-title">' + esc(r.itemName) + '</div>'
                        + '<div class="ac-item-cmd"><code class="cmd">' + esc(r.alias + ' ' + r.itemName) + '</code></div>'
                        + '</div>';
                }
                var secLabel = SECTION_META[r.cmd.section] ? SECTION_META[r.cmd.section].label : r.cmd.section;
                var desc = r.cmd.description || '';
                if (desc.length > 65) desc = desc.slice(0, 65) + '…';
                return '<div class="ac-item' + (i === hlIndex ? ' hl' : '') + '" data-index="' + i + '">'
                    + '<div class="ac-item-title">' + esc(r.cmd.title) + '<span class="ac-item-sec">' + secLabel + '</span></div>'
                    + '<div class="ac-item-cmd"><code class="cmd">' + esc(r.alias) + '</code></div>'
                    + (desc ? '<div class="ac-item-desc">' + esc(desc) + '</div>' : '')
                    + '</div>';
            }).join('');
            acPanel.innerHTML = '<div class="ac-card">'
                + '<div class="ac-card-h">' + headerText
                + '<span class="ac-card-actions"><button id="ac-hist" title="最近执行">最近</button><button id="ac-close">×</button></span>'
                + '</div><div class="ac-card-body">' + items + '</div></div>';
            acPanel.classList.add('show');
            document.getElementById('ac-close').onclick = function (e) {
                e.stopPropagation();
                hideAcPanel();
            };
            // 将读取 DOM 和滚动延迟到下一帧，避免写-读布局抖动
            var _prefix = prefix;
            requestAnimationFrame(function () {
                var hlEl = acPanel.querySelector('.hl');
                if (hlEl) hlEl.scrollIntoView({ block: 'nearest' });
                acPanel.querySelectorAll('.ac-item').forEach(function (el) {
                    el.addEventListener('click', function () {
                        var index = parseInt(el.dataset.index);
                        var match = currentAcResults[index];
                        if (match) fillAcCommand(match);
                    });
                });
                if (_prefix !== undefined) updateGhost(_prefix);
            });
        }

        // ====== 语义纠错搜索 ======

        function scheduleAcSemanticSearch(prefix) {
            clearTimeout(acSemTimer);
            var query = prefix.replace(/^!/, '').trim();
            if (!query || query.length < 2) return;
            acSemTimer = setTimeout(function () {
                if (!acPanel.classList.contains('show')) return;
                fetch(SEARCH_URL + '?q=' + encodeURIComponent(query) + '&n=5')
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (results) {
                        if (!results || !acPanel.classList.contains('show')) return;
                        var semResults = results.filter(function (r) {
                            return r.commands.some(function (c) { return c.startsWith('!'); });
                        });
                        if (semResults.length === 0) {
                            hideAcMode();
                            hideGhost();
                            acPanel.innerHTML = '<div class="ac-card">'
                                + '<div class="ac-card-h">⌨️ 指令补全'
                                + '<button id="ac-close">×</button>'
                                + '</div><div class="ac-card-body"><div class="ac-nores">没有匹配的指令</div></div></div>';
                            acPanel.classList.add('show');
                            return;
                        }
                        _acCorrection = true;
                        currentAcResults = semResults.map(function (sr) {
                            var alias = sr.commands.find(function (c) { return c.startsWith('!'); }) || sr.commands[0];
                            return { cmd: sr, alias: alias };
                        });
                        currentAcHlIndex = 0;
                        q.classList.add('ac-mode');
                        renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
                    })
                    .catch(function () {});
            }, 600);
        }

        // ====== 补全入口 ======

        function updateAutocomplete(input) {
            if (_acJustFilled) {
                _acJustFilled = false;
                hideGhost();
                return;
            }
            var prefix = getAutocompletePrefix(input);
            if (!prefix) {
                hideAcPanel();
                return;
            }
            clearTimeout(semTimerRef.current);
            clearTimeout(acSemTimer);
            searchWrap.classList.remove('sem-loading');
            semPanel.classList.remove('show');

            // 参数感知：检测当前是否在输入物品名称参数
            var paramCtx = getParamContext(input);
            if (paramCtx && !paramCtx.ambiguous) {
                var p = paramCtx.param;
                if (p.autocomplete === 'items') {
                    _acCorrection = false;
                    if (paramCtx.partial.length >= 1) {
                        var matchedItems = matchItemsBySubstring(paramCtx.partial);
                        if (matchedItems.length > 0) {
                            currentAcResults = matchedItems.slice(0, 20).map(function (name) {
                                return { cmd: paramCtx.cmd, alias: paramCtx.alias, type: 'item', itemName: name };
                            });
                            currentAcHlIndex = 0;
                            showAcMode();
                            renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
                            return;
                        }
                    }
                    // 空格后无输入 → 展示常用物品提示
                    if (paramCtx.partial.length === 0) {
                        currentAcResults = _items.slice(0, 20).map(function (name) {
                            return { cmd: paramCtx.cmd, alias: paramCtx.alias, type: 'item', itemName: name };
                        });
                        currentAcHlIndex = -1;
                        showAcMode();
                        renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
                        return;
                    }
                }
            }

            currentAcResults = getMatches(prefix);
            _acCorrection = false;
            if (currentAcResults.length > 0) {
                currentAcHlIndex = 0;
                renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
            } else {
                // 前缀无匹配 → 尝试物品名子串匹配（保留旧逻辑作为回退）
                var lastSpace = prefix.lastIndexOf(' ');
                var subItemMatch = false;
                if (lastSpace > 0) {
                    var itemQuery = prefix.slice(lastSpace + 1);
                    if (itemQuery.length >= 1) {
                        var basePrefix = prefix.slice(0, lastSpace);
                        var baseResults = getMatches(basePrefix);
                        if (baseResults.length > 0 && _itemCmdIds && _itemCmdIds.has(baseResults[0].cmd.id)) {
                            var subItems = matchItemsBySubstring(itemQuery);
                            if (subItems.length > 0) {
                                var cmdForItem = baseResults[0].cmd;
                                currentAcResults = subItems.slice(0, 20).map(function (name) {
                                    return { cmd: cmdForItem, alias: baseResults[0].alias, type: 'item', itemName: name };
                                });
                                currentAcHlIndex = 0;
                                showAcMode();
                                renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
                                subItemMatch = true;
                            }
                        }
                    }
                }
                // 子串无匹配 → 检查是否"有效路径 + 参数"
                var paramMatch = false;
                if (!subItemMatch && lastSpace > 0) {
                    var basePrefix2 = prefix.slice(0, lastSpace);
                    var baseResults2 = getMatches(basePrefix2);
                    if (baseResults2.length > 0) {
                        currentAcResults = baseResults2;
                        currentAcHlIndex = 0;
                        showAcMode();
                        renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
                        paramMatch = true;
                    }
                }
                if (!subItemMatch && !paramMatch) {
                    // 参数上下文已识别 → 直接展示匹配指令，不触发语义搜索
                    if (paramCtx && !paramCtx.ambiguous) {
                        currentAcResults = [{ cmd: paramCtx.cmd, alias: paramCtx.alias }];
                        currentAcHlIndex = 0;
                        showAcMode();
                        renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
                        return;
                    }
                    hideAcMode();
                    hideGhost();
                    acPanel.innerHTML = '<div class="ac-card">'
                        + '<div class="ac-card-h">⌨️ 指令补全'
                        + '<button id="ac-close">×</button>'
                        + '</div><div class="ac-card-body"><div class="ac-nores ac-searching">正在搜索…</div></div></div>';
                    acPanel.classList.add('show');
                    scheduleAcSemanticSearch(prefix);
                }
            }
        }

        // ====== 高亮导航 ======

        function updateAcHighlight(newIndex) {
            var prefix = getAutocompletePrefix(q.value);
            var items = acPanel.querySelectorAll('.ac-item');
            items.forEach(function (el, i) {
                el.classList.toggle('hl', i === newIndex);
            });
            var hlEl = items[newIndex];
            if (hlEl) hlEl.scrollIntoView({ block: 'nearest' });
            updateGhost(prefix);
        }

        // ====== 绑定事件 ======

        q.addEventListener('keydown', function (e) {
            if (!acPanel.classList.contains('show')) return;
            switch (e.key) {
                case 'Tab':
                    e.preventDefault();
                    if (currentAcHlIndex >= 0 && currentAcHlIndex < currentAcResults.length) {
                        fillAcCommand(currentAcResults[currentAcHlIndex]);
                    }
                    break;
                case 'Enter':
                    if (currentAcHlIndex >= 0 && currentAcHlIndex < currentAcResults.length) {
                        e.preventDefault();
                        fillAcCommand(currentAcResults[currentAcHlIndex]);
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    hideAcPanel();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (currentAcResults.length > 0) {
                        currentAcHlIndex = (currentAcHlIndex - 1 + currentAcResults.length) % currentAcResults.length;
                        updateAcHighlight(currentAcHlIndex);
                    }
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    if (currentAcResults.length > 0) {
                        currentAcHlIndex = (currentAcHlIndex + 1) % currentAcResults.length;
                        updateAcHighlight(currentAcHlIndex);
                    }
                    break;
            }
        });

        // 点击绿框纠正文字 → 上字
        acGhost.addEventListener('click', function (e) {
            var fixBox = e.target.closest('.ghost-fix-box');
            if (!fixBox || currentAcResults.length === 0) return;
            var idx = currentAcHlIndex >= 0 ? currentAcHlIndex : 0;
            fillAcCommand(currentAcResults[idx]);
        });

        // ====== 公开 API ======

        return {
            updateAutocomplete: updateAutocomplete,
            getPrefix: getAutocompletePrefix,
            hide: hideAcPanel
        };
    }

    return {
        setData: setData,
        setItemConfig: setItemConfig,
        buildTrie: buildTrie,
        getMatches: getMatches,
        init: init
    };
})();
