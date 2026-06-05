/**
 * CF Pages Function: /search
 *
 * 查询参数: ?q=搜索词&n=10（n 可选，默认 10，最大 30）
 *
 * 依赖：
 *   - embeddings.json（由 build.js 生成，提交到仓库）
 *   - commands.json（指令数据）
 *   - AI binding（在 CF Dashboard → Pages → Settings → Functions → AI bindings 中添加，名称填 "AI"）
 */

import embData from '../embeddings.json';
import cmdsData from '../commands.json';

// D1 日志表初始化（每次冷启动执行一次）
let dbReady = false;
async function ensureTable(db) {
    if (dbReady) return;
    await db.exec(`
        CREATE TABLE IF NOT EXISTS search_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            q TEXT NOT NULL,
            n INTEGER,
            model TEXT,
            top_score REAL,
            result_count INTEGER,
            elapsed_ms INTEGER,
            top3 TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    dbReady = true;
}

// ---- 启动时解码所有向量（每次冷启动执行一次）----

/**
 * 将 base64 编码的 Float32 字节数组解码为 Float32Array
 * @param {string} b64
 * @returns {Float32Array}
 */
function decodeEmb(b64) {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return new Float32Array(buf);
}

// 预解码，避免每次请求重复解码
const decodedEmbs = embData.entries.map(e => ({ id: e.id, emb: decodeEmb(e.emb) }));

// 指令 id → 指令对象的快速查找表
const cmdMap = Object.fromEntries(cmdsData.map(c => [c.id, c]));

// ---- 工具函数 ----

/**
 * 余弦相似度
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ---- 请求处理 ----

export async function onRequestOptions() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ request, env, waitUntil }) {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    const n = Math.min(parseInt(url.searchParams.get('n') || '10', 10) || 10, 30);

    if (!q) {
        return Response.json({ error: '缺少参数 q' }, { status: 400, headers: CORS_HEADERS });
    }

    if (!env.AI) {
        return Response.json(
            { error: 'AI binding 未配置，请在 CF Dashboard → Pages → Settings → Functions → AI bindings 中添加，名称填 "AI"' },
            { status: 503, headers: CORS_HEADERS }
        );
    }

    if (decodedEmbs.length === 0) {
        return Response.json(
            { error: 'embeddings.json 为空，请先在本地运行 node build.js 并提交结果' },
            { status: 503, headers: CORS_HEADERS }
        );
    }

    const t0 = Date.now();

    const aiResult = await env.AI.run(embData.model, { text: [q] });
    const queryEmb = new Float32Array(aiResult.data[0]);

    // 计算余弦相似度并排序
    const scored = decodedEmbs
        .map(({ id, emb }) => ({ id, score: cosineSim(queryEmb, emb) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, n);

    const elapsedMs = Date.now() - t0;
    const top3 = scored.slice(0, 3).map(r => cmdMap[r.id]?.title);

    // 异步写 D1 日志，不阻塞响应
    waitUntil((async () => {
        try {
            await ensureTable(env.LOG_DB);
            await env.LOG_DB.prepare(
                `INSERT INTO search_log (q, n, model, top_score, result_count, elapsed_ms, top3)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(q, n, embData.model, scored[0]?.score ?? null, scored.length, elapsedMs, JSON.stringify(top3)).run();
        } catch (e) {
            console.error('search_log write failed:', e?.message);
        }
    })());

    // 附带原始指令数据（score 保留 4 位小数）
    const results = scored.map(r => ({
        ...cmdMap[r.id],
        score: Math.round(r.score * 10000) / 10000,
    }));

    return Response.json(results, { headers: CORS_HEADERS });
}
