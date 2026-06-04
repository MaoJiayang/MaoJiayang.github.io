#!/usr/bin/env node
/**
 * test-search.js - 本地模拟线上语义搜索
 *
 * 使用方法:
 *   CF_ACCOUNT_ID=xxxx CF_API_TOKEN=xxxx node test-search.js "搜索词"
 *   CF_ACCOUNT_ID=xxxx CF_API_TOKEN=xxxx node test-search.js "保存飞船" 5
 *
 * 环境变量（与 build.js 相同）:
 *   CF_ACCOUNT_ID  - Cloudflare 账号 ID
 *   CF_API_TOKEN   - Cloudflare API Token（需 Workers AI Run 权限）
 */

'use strict';

const { readFileSync } = require('fs');

const CONFIG = JSON.parse(readFileSync('config.json', 'utf8'));
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const MODEL = CONFIG.embeddingModel;

if (!ACCOUNT_ID || !API_TOKEN) {
    console.error('错误：请设置环境变量 CF_ACCOUNT_ID 和 CF_API_TOKEN');
    console.error('  CF_ACCOUNT_ID=xxxx CF_API_TOKEN=xxxx node test-search.js "搜索词"');
    process.exit(1);
}

const query = process.argv[2];
if (!query) {
    console.error('错误：请提供搜索词');
    console.error('  node test-search.js "搜索词" [返回条数]');
    process.exit(1);
}

const topN = parseInt(process.argv[3] || '10', 10) || 10;

// ---- 加载数据 ----

let embData, cmdsData;
try {
    embData = JSON.parse(readFileSync('embeddings.json', 'utf8'));
} catch (_) {
    console.error('错误：未找到 embeddings.json，请先运行 node build.js 生成');
    process.exit(1);
}
try {
    cmdsData = JSON.parse(readFileSync('commands.json', 'utf8'));
} catch (_) {
    console.error('错误：未找到 commands.json');
    process.exit(1);
}

// ---- 解码向量 ----

function decodeEmb(b64) {
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

const decodedEmbs = embData.entries.map(e => ({ id: e.id, emb: decodeEmb(e.emb) }));
const cmdMap = Object.fromEntries(cmdsData.map(c => [c.id, c]));

// ---- 余弦相似度 ----

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

// ---- 主流程 ----

async function main() {
    console.log(`搜索: "${query}"（返回最多 ${topN} 条）\n`);

    const queryEmb = await embedQuery(query);

    const scored = decodedEmbs
        .map(({ id, emb }) => ({ id, score: cosineSim(queryEmb, emb) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);

    if (scored.length === 0) {
        console.log('无匹配结果');
        return;
    }

    const SECTION_NAMES = {
        hangar: '🚁 存取飞船', shipmarket: '🛒 买卖飞船', storage: '📦 存取物资',
        build: '🏗️ 建造飞船', trade: '💱 服营商店', pmarket: '🏪 玩家市场',
        combat: '⚔️ 战斗活动', mission: '📋 全服任务', finance: '💰 财务管理',
        info: '🔍 查询信息', grid: '🛸 网格 & 状态', list: '📝 清单 & 合同',
        lcd: '🖥️ LCD 注入', safe: '🛡️ 精英工程师',
    };

    for (const r of scored) {
        const cmd = cmdMap[r.id];
        if (!cmd) continue;
        const section = SECTION_NAMES[cmd.section] || cmd.section;
        console.log(`  ${(r.score * 100).toFixed(1)}%  [${section}]  ${cmd.title}`);
        console.log(`       ${cmd.commands.join('  ')}`);
        console.log(`       ${cmd.description}`);
        console.log();
    }
}

main().catch(err => {
    console.error('搜索失败:', err.message);
    process.exit(1);
});
