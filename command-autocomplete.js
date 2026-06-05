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

    /** 加载指令数据并构建 Trie */
    function setData(data) {
        _commandsData = data;
    }

    /** 构建 Trie 前缀树（仅 ! 开头的别名） */
    function buildTrie() {
        _trieRoot = { children: new Map(), results: [] };
        if (!_commandsData) return;
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
        var acModeTag = document.getElementById('ac-mode-tag');
        var acGhost = document.getElementById('ac-ghost');

        // 状态
        var currentAcResults = [];
        var currentAcHlIndex = -1;
        var acSemTimer = null;
        var _acJustFilled = false;
        var _acCorrection = false;

        // ====== 模式控制 ======

        function showAcMode() {
            acModeTag.classList.add('show');
            q.classList.add('ac-mode');
        }

        function hideAcMode() {
            acModeTag.classList.remove('show');
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
            var match = currentAcResults[idx].alias;
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

        function fillAcCommand(cmd) {
            q.value = cmd.alias + ' ';
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
                    + '<div class="ac-card-h">⌨️ 指令补全'
                    + '<button id="ac-close">×</button>'
                    + '</div><div class="ac-card-body"><div class="ac-nores">没有匹配的指令</div></div></div>';
                acPanel.classList.add('show');
                return;
            }
            if (!_acCorrection) showAcMode();
            var isMobile = window.matchMedia('(max-width: 768px)').matches;
            var maxItems = isMobile ? 6 : 10;
            var headerText = _acCorrection ? '💡 你是不是想找' : '⌨️ 指令补全';
            var items = results.slice(0, maxItems).map(function (r, i) {
                var secLabel = SECTION_META[r.cmd.section] ? SECTION_META[r.cmd.section].label : r.cmd.section;
                var desc = r.cmd.description || '';
                if (desc.length > 65) desc = desc.slice(0, 65) + '…';
                return '<div class="ac-item' + (i === hlIndex ? ' hl' : '') + '" data-index="' + i + '" data-id="' + esc(r.cmd.id) + '">'
                    + '<div class="ac-item-title">' + esc(r.cmd.title) + '<span class="ac-item-sec">' + secLabel + '</span></div>'
                    + '<div class="ac-item-cmd"><code class="cmd">' + esc(r.alias) + '</code></div>'
                    + (desc ? '<div class="ac-item-desc">' + esc(desc) + '</div>' : '')
                    + '</div>';
            }).join('');
            acPanel.innerHTML = '<div class="ac-card">'
                + '<div class="ac-card-h">' + headerText
                + '<button id="ac-close">×</button>'
                + '</div><div class="ac-card-body">' + items + '</div></div>';
            acPanel.classList.add('show');
            var hlEl = acPanel.querySelector('.hl');
            if (hlEl) hlEl.scrollIntoView({ block: 'nearest' });
            document.getElementById('ac-close').onclick = function (e) {
                e.stopPropagation();
                hideAcPanel();
            };
            acPanel.querySelectorAll('.ac-item').forEach(function (el) {
                el.addEventListener('click', function () {
                    var id = el.dataset.id;
                    var match = currentAcResults.find(function (r) { return r.cmd.id === id; });
                    if (match) fillAcCommand(match);
                });
            });
            if (prefix !== undefined) updateGhost(prefix);
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
            currentAcResults = getMatches(prefix);
            _acCorrection = false;
            if (currentAcResults.length > 0) {
                currentAcHlIndex = 0;
                renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
            } else {
                // 前缀无匹配时，检查是否"已输入完整指令 + 参数"
                var lastSpace = prefix.lastIndexOf(' ');
                var paramMatch = false;
                if (lastSpace > 0) {
                    var basePrefix = prefix.slice(0, lastSpace);
                    var baseResults = getMatches(basePrefix);
                    if (baseResults.some(function (r) { return r.alias.toLowerCase() === basePrefix.toLowerCase(); })) {
                        // 用户输入了完整指令 + 参数，视为已匹配，不纠错
                        currentAcResults = baseResults.filter(function (r) { return r.alias.toLowerCase() === basePrefix.toLowerCase(); });
                        currentAcHlIndex = 0;
                        showAcMode();
                        renderAcPanel(currentAcResults, currentAcHlIndex, prefix);
                        paramMatch = true;
                    }
                }
                if (!paramMatch) {
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

        acModeTag.addEventListener('click', function (e) {
            e.stopPropagation();
            exitAcMode();
        });

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
        buildTrie: buildTrie,
        getMatches: getMatches,
        init: init
    };
})();
