(function () {
    var VERSION_URL = '/version.json';
    var CHECK_MS = 5 * 60 * 1000;       // 轮询间隔：5 分钟
    var DISMISS_MS = 60 * 60 * 1000;    // 点取消后的冷却：1 小时

    var currentVersion = null;
    var lastDismissed = 0;

    // 读取本地存储的版本号
    try {
        currentVersion = localStorage.getItem('__site_v__');
        lastDismissed = parseInt(localStorage.getItem('__site_v_dismiss__') || '0', 10);
    } catch (_) { /* 无痕模式等 localStorage 不可用场景 */ }

    // ---------- 获取远程版本 ----------
    function fetchRemoteVersion() {
        return fetch(VERSION_URL + '?t=' + Date.now())
            .then(function (r) {
                if (!r.ok) {
                    console.warn('[版本检测] 获取 version.json 失败，HTTP ' + r.status);
                    return null;
                }
                return r.json();
            })
            .then(function (d) { return d ? d.v : null; })
            .catch(function (err) {
                console.warn('[版本检测] 请求 version.json 出错: ' + err.message);
                return null;
            });
    }

    // ---------- 弹窗 ----------
    function showPrompt(newVersion) {
        // 防止重复弹窗
        if (document.getElementById('__upgrade_modal__')) return;
        lastDismissed = 0;
        try { localStorage.removeItem('__site_v_dismiss__'); } catch (_) {}

        var overlay = document.createElement('div');
        overlay.id = '__upgrade_modal__';
        overlay.innerHTML =
            '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9998;display:flex;align-items:center;justify-content:center">' +
            '<div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;padding:1.5rem 2rem;max-width:360px;width:90%;box-shadow:0 8px 24px rgba(0,0,0,0.2);text-align:center">' +
            '<p style="font-size:15px;color:var(--text-main);margin-bottom:0.75rem;line-height:1.6">页面有更新，建议刷新以获取最新内容</p>' +
            '<p style="font-size:12px;color:var(--text-muted);margin-bottom:1.25rem">' + newVersion.slice(0, 7) + '</p>' +
            '<div style="display:flex;gap:0.75rem;justify-content:center">' +
            '<button id="__upgrade_confirm__" style="padding:0.5rem 1.25rem;border-radius:6px;border:none;background:var(--accent);color:#fff;font-size:14px;cursor:pointer;font-family:inherit">刷新</button>' +
            '<button id="__upgrade_cancel__" style="padding:0.5rem 1.25rem;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-size:14px;cursor:pointer;font-family:inherit">取消</button>' +
            '</div></div></div>';

        overlay.querySelector('#__upgrade_confirm__').addEventListener('click', function () {
            try {
                localStorage.setItem('__site_v__', newVersion);
                localStorage.removeItem('__site_v_dismiss__');
            } catch (_) {}
            location.reload();
        });

        overlay.querySelector('#__upgrade_cancel__').addEventListener('click', function () {
            overlay.remove();
            lastDismissed = Date.now();
            try { localStorage.setItem('__site_v_dismiss__', String(lastDismissed)); } catch (_) {}
        });

        document.body.appendChild(overlay);
    }

    // ---------- 检测版本 ----------
    function check() {
        fetchRemoteVersion().then(function (remoteV) {
            if (!remoteV) return;

            // 首访：记录当前版本
            if (!currentVersion) {
                currentVersion = remoteV;
                try { localStorage.setItem('__site_v__', remoteV); } catch (_) {}
                return;
            }

            // 版本一致，无需更新
            if (remoteV === currentVersion) return;

            // 版本不同，但用户在冷却期
            if (Date.now() - lastDismissed < DISMISS_MS) return;

            showPrompt(remoteV);
        });
    }

    // ---------- 启动 ----------
    // 切回页面时立即检查
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') check();
    });

    // 定时轮询
    setInterval(check, CHECK_MS);

    // 首屏加载后立即取一次远程版本（静默，仅记录）
    fetchRemoteVersion().then(function (v) {
        if (v && !currentVersion) {
            currentVersion = v;
            try { localStorage.setItem('__site_v__', v); } catch (_) {}
        }
    });
})();
