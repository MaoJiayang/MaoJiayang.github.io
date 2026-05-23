#!/usr/bin/env node
/**
 * build.js - 为 commands.json 中的每条指令生成 embedding 向量
 *
 * 使用方法:
 *   CF_ACCOUNT_ID=xxxx CF_API_TOKEN=xxxx node build.js
 *
 * 需要环境变量:
 *   CF_ACCOUNT_ID  - Cloudflare 账号 ID（在 CF Dashboard 右下角可以找到）
 *   CF_API_TOKEN   - Cloudflare API Token（需要 Workers AI 的 Run 权限）
 *
 * 输出: embeddings.json（提交到仓库，CF Pages 部署时自动打包进 functions/search.js）
 *
 * 运行环境: Node.js 18+（使用内置 fetch）
 */

'use strict';

const { readFileSync, writeFileSync } = require('fs');
const { createHash } = require('crypto');

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const MODEL = '@cf/baai/bge-m3';
const BATCH_SIZE = 20;      // CF AI API 单次最多支持的文本数
const BATCH_DELAY_MS = 250; // 批次之间的延迟，避免触发速率限制

if (!ACCOUNT_ID || !API_TOKEN) {
    console.error('错误：请设置环境变量 CF_ACCOUNT_ID 和 CF_API_TOKEN');
    console.error('  CF_ACCOUNT_ID=xxxx CF_API_TOKEN=xxxx node build.js');
    process.exit(1);
}

// ---- 文本预处理 ----

/** 去除 Markdown 标记，提取纯文本（用于 embedding） */
function stripMd(md) {
    if (!md) return '';
    return md
        .replace(/\*\*(.*?)\*\*/g, '$1')    // **bold** → bold
        .replace(/`([^`]+)`/g, '$1')        // `code` → code
        .replace(/^[-•]\s*/gm, '')          // 列表符号
        .replace(/[①②③④⑤⑥⑦⑧⑨]/g, '')  // 带圈数字
        .replace(/\n+/g, ' ')
        .trim();
}

/**
 * 构建用于 embedding 的搜索文本
 * 拼接顺序：标题 > 指令别名 > 描述 > note 纯文本
 */
function buildSearchText(cmd) {
    return [
        cmd.title,
        cmd.commands.join(' '),
        cmd.description,
        stripMd(cmd.note),
    ].filter(Boolean).join(' ');
}

// ---- CF AI API ----

/**
 * 调用 CF Workers AI API 批量生成 embeddings
 * @param {string[]} texts
 * @returns {Promise<number[][]>} 每条文本对应一个浮点数向量
 */
async function embedBatch(texts) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
        },
        // qwen3-embedding 支持 documents/queries 非对称接口，但对短文本技术命令效果存疑；
        // 当前统一用 text 字段，如需启用非对称模式可改为 { documents: texts }
        body: JSON.stringify({ text: texts }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`CF AI API HTTP ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    if (!data.success) {
        throw new Error(`CF AI API 失败: ${JSON.stringify(data.errors)}`);
    }

    return data.result.data; // float[][]
}

// ---- 编码工具 ----

/**
 * 将 number[] 编码为 Float32 字节流再转 base64
 * @param {number[]} vec
 * @returns {string}
 */
function vecToBase64(vec) {
    const f32 = new Float32Array(vec);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

// ---- 哈希工具 ----

/**
 * 计算文本的 SHA256 哈希，用于增量构建时比对内容是否变化
 * @param {string} text
 * @returns {string}
 */
function hashText(text) {
    return createHash('sha256').update(text).digest('hex');
}

// ---- 主流程 ----

async function main() {
    const commands = JSON.parse(readFileSync('commands.json', 'utf8'));

    // 尝试加载已有 embeddings，构建 id → { hash, emb } 查找表
    const existingMap = new Map();
    try {
        const existing = JSON.parse(readFileSync('embeddings.json', 'utf8'));
        if (existing.model === MODEL) {
            for (const e of existing.entries) {
                if (e.hash && e.emb) {
                    existingMap.set(e.id, { hash: e.hash, emb: e.emb });
                }
            }
        } else if (existing.entries && existing.entries.length > 0) {
            console.log(`模型已变更（${existing.model} → ${MODEL}），将全量重建`);
        }
    } catch (_) { /* 首次构建，无缓存 */ }

    // 逐条计算搜索文本哈希，与缓存比对
    const resultMap = new Map();  // id → { hash, emb }
    const toEmbed = [];           // { id, text, hash }

    for (const cmd of commands) {
        const text = buildSearchText(cmd);
        const hash = hashText(text);
        const cached = existingMap.get(cmd.id);

        if (cached && cached.hash === hash) {
            resultMap.set(cmd.id, cached);
        } else {
            toEmbed.push({ id: cmd.id, text, hash });
        }
    }

    const reused = commands.length - toEmbed.length;
    console.log(`共 ${commands.length} 条指令，${reused} 条复用缓存，${toEmbed.length} 条需重新嵌入`);

    // 批量嵌入仅处理需要更新的
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + BATCH_SIZE);
        const end = Math.min(i + BATCH_SIZE, toEmbed.length);

        console.log(`  嵌入第 ${i + 1}–${end} 条（共 ${toEmbed.length} 条）...`);
        const vectors = await embedBatch(batch.map(b => b.text));

        for (let j = 0; j < batch.length; j++) {
            resultMap.set(batch[j].id, {
                hash: batch[j].hash,
                emb: vecToBase64(vectors[j]),
            });
        }

        if (end < toEmbed.length) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
    }

    // 按 commands.json 的顺序输出
    const entries = commands.map(cmd => {
        const r = resultMap.get(cmd.id);
        return { id: cmd.id, hash: r.hash, emb: r.emb };
    });

    const output = { model: MODEL, dims: 1024, entries };
    writeFileSync('embeddings.json', JSON.stringify(output));
    console.log(`完成，已写入 embeddings.json（${entries.length} 条指令，每条 ${output.dims} 维）`);
}

main().catch(err => {
    console.error('构建失败:', err.message);
    process.exit(1);
});
