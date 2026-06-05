#!/usr/bin/env node
/**
 * search-server.js - 本地语义搜索服务（开发调试用）
 *
 * 使用方法:
 *   CF_ACCOUNT_ID=xxxx CF_API_TOKEN=xxxx node search-server.js
 *
 * 然后浏览器访问 http://localhost:5500/commands.html 即可正常触发语义搜索。
 * 服务监听 5501 端口，和 python http.server 互不冲突。
 */

'use strict';

const { readFileSync } = require('fs');
const http = require('http');

const CONFIG = JSON.parse(readFileSync('config.json', 'utf8'));
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const MODEL = CONFIG.embeddingModel;
const PORT = CONFIG.searchPort || 5501;

if (!ACCOUNT_ID || !API_TOKEN) {
    console.error('错误：请设置环境变量 CF_ACCOUNT_ID 和 CF_API_TOKEN');
    console.error('  CF_ACCOUNT_ID=xxxx CF_API_TOKEN=xxxx node search-server.js');
    process.exit(1);
}

// ---- 加载 & 解码向量 ----
const embData = JSON.parse(readFileSync('embeddings.json', 'utf8'));
const cmdsData = JSON.parse(readFileSync('commands.json', 'utf8'));

function decodeEmb(b64) {
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

const decodedEmbs = embData.entries.map(e => ({ id: e.id, emb: decodeEmb(e.emb) }));
const cmdMap = Object.fromEntries(cmdsData.map(c => [c.id, c]));

function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- 嵌入查询词 ----
async function embedQuery(text) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: [text] }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`CF AI API HTTP ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    if (!data.success) {
        throw new Error(`CF AI API 失败: ${JSON.stringify(data.errors)}`);
    }

    return new Float32Array(data.result.data[0]);
}

// ---- HTTP 服务 ----
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/search') {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }

    const q = (url.searchParams.get('q') || '').trim();
    const n = Math.min(parseInt(url.searchParams.get('n') || '10', 10) || 10, 30);

    if (!q) {
        res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少参数 q' }));
        return;
    }

    const t0 = Date.now();
    console.log(`[搜索] q="${q}" n=${n}`);

    try {
        const queryEmb = await embedQuery(q);
        const embedMs = Date.now() - t0;
        const scored = decodedEmbs
            .map(({ id, emb }) => ({ id, score: cosineSim(queryEmb, emb) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, n);

        const totalMs = Date.now() - t0;
        const top3 = scored.slice(0, 3).map(r => cmdMap[r.id]?.title || r.id);
        console.log(`  → ${scored.length} 条结果，嵌入 ${embedMs}ms，总计 ${totalMs}ms`);
        console.log(`  → Top3: [${top3.join(' | ')}]`);

        const results = scored.map(r => ({
            ...cmdMap[r.id],
            score: Math.round(r.score * 10000) / 10000,
        }));

        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
    } catch (err) {
        console.error(`[搜索] 失败 (${Date.now() - t0}ms):`, err.message);
        res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}).listen(PORT, () => {
    console.log(`语义搜索服务已启动: http://localhost:${PORT}/search?q=xxx&n=5`);
    console.log(`现在浏览器打开 http://localhost:5500/commands.html 即可测试`);
});
