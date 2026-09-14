#!/usr/bin/env node
/**
 * 纸鸢网盘 MCP 批量下载器：把账号里的转存文件按原目录结构下载到本地。
 *
 * 用法：
 *   node tools/download-mybt.mjs --out "E:\e盘番剧"                 # 下载全部任务
 *   node tools/download-mybt.mjs --out "E:\e盘番剧" --dry-run       # 只列出将要下载的文件与体积
 *   node tools/download-mybt.mjs --out "E:\e盘番剧" --task <任务ID>  # 只下载指定任务（可重复）
 *   node tools/download-mybt.mjs --out "E:\e盘番剧" --concurrency 4
 *
 * 特性：
 * - 递归保留网盘目录结构：<输出目录>/<任务根名称>/<子目录>/<文件>
 * - 断点续传：未完成的文件写成 xxx.part，重跑时用 HTTP Range 从断点继续
 * - 已完成文件按大小校验后跳过，可反复执行
 * - 文件名按 Windows 规则清洗，路径过长自动截断文件名部分
 * - 每个文件下载前实时获取直链（直链带时效 token，不缓存）
 */

import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';

const ENDPOINT = 'https://mybt.kiteyuan.info/api/v1/mcp';
const DEFAULT_TOKEN_FILE = '.mybt-mcp-token';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const outRoot = arg('out', '');
const tokenFile = arg('token-file', DEFAULT_TOKEN_FILE);
const concurrency = Math.max(1, Number(arg('concurrency', 3)));
const dryRun = flag('dry-run');
const taskFilter = process.argv.reduce((acc, item, index) => {
  if (item === '--task' && process.argv[index + 1]) acc.push(process.argv[index + 1]);
  return acc;
}, []);

if (!outRoot) {
  console.error('缺少 --out 参数，例如：--out "E:\\e盘番剧"');
  process.exit(2);
}

let token = (process.env.MYBT_MCP_TOKEN || '').trim();
if (!token) {
  if (!existsSync(tokenFile)) {
    console.error(
      `未找到 Token 文件：${tokenFile}\n` +
        '请用 --token-file <路径> 指定，或设置环境变量 MYBT_MCP_TOKEN，\n' +
        '也可以把 MCP Token（mybt.kiteyuan.info 的 MCP 页面生成）写入该文件后重试。'
    );
    process.exit(2);
  }
  token = readFileSync(tokenFile, 'utf8').trim();
}
let rpcId = 1;

async function callTool(name, args) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`鉴权失败 HTTP ${res.status}：请检查 Token`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
  if (json.error) throw new Error(`MCP 错误：${json.error.message || JSON.stringify(json.error)}`);
  const result = json.result || {};
  const data = result.structuredContent || {};
  if (result.isError) throw new Error(`工具返回错误：${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/* ---------------- 路径处理 ---------------- */

function sanitizeSegment(name) {
  const cleaned = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return (cleaned || 'unnamed').slice(0, 120);
}

/** 清洗后的绝对路径；过长时截断文件名部分，规避 Windows MAX_PATH */
function safeFullPath(root, relPath) {
  const segments = relPath.split(/[\\/]/).filter(Boolean).map(sanitizeSegment);
  const dirPart = path.join(root, ...segments.slice(0, -1));
  const fileName = segments[segments.length - 1] || 'unnamed';
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const full = path.join(dirPart, fileName);
  if (full.length <= 240) return full;
  const room = Math.max(30, 240 - dirPart.length - ext.length - 1);
  return path.join(dirPart, `${base.slice(0, room)}${ext}`);
}

/* ---------------- 目录遍历 ---------------- */

async function listDir(taskId, parentId) {
  const files = [];
  let pageToken = '';
  do {
    const args = { task_id: taskId, limit: 200 };
    if (parentId) args.parent_id = parentId;
    if (pageToken) args.page_token = pageToken;
    const data = await callTool('files_list_dir', args);
    files.push(...(data.files || []));
    pageToken = data.next_page_token || '';
  } while (pageToken);
  return files;
}

async function collectTask(task) {
  const rootSeg = sanitizeSegment(task.file_name);
  const isDir = task.is_dir === true || task.file_kind === 'drive#folder';
  const entries = [];

  if (!isDir) {
    entries.push({
      taskId: task.id,
      fileId: task.file_id,
      relPath: rootSeg,
      size: Number(task.file_size) || 0,
      name: `${rootSeg}`,
    });
    return entries;
  }

  async function walk(parentId, relDir) {
    const items = await listDir(task.id, parentId);
    for (const item of items) {
      const rel = `${relDir}/${item.name}`;
      if (item.kind === 'drive#folder') {
        await walk(item.id, rel);
      } else {
        entries.push({
          taskId: task.id,
          fileId: item.id,
          relPath: rel,
          size: Number(item.size) || 0,
          name: item.name,
        });
      }
    }
  }

  await walk(task.file_id, rootSeg);
  return entries;
}

/* ---------------- 下载 ---------------- */

const stats = { totalBytes: 0, doneBytes: 0, doneFiles: 0, skippedFiles: 0, failedFiles: 0, failed: [] };

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function overall() {
  const percent = stats.totalBytes ? ((stats.doneBytes / stats.totalBytes) * 100).toFixed(1) : '0.0';
  return `总进度 ${percent}%（${human(stats.doneBytes)} / ${human(stats.totalBytes)}）`;
}

async function downloadEntry(entry, attempt = 1) {
  const full = safeFullPath(outRoot, entry.relPath);
  const part = `${full}.part`;
  mkdirSync(path.dirname(full), { recursive: true });

  if (existsSync(full) && entry.size > 0 && statSync(full).size === entry.size) {
    stats.doneBytes += entry.size;
    stats.skippedFiles += 1;
    console.log(`  跳过（已存在） ${entry.relPath}`);
    return;
  }

  let start = 0;
  if (existsSync(part)) {
    start = statSync(part).size;
    if (entry.size > 0 && start > entry.size) {
      unlinkSync(part);
      start = 0;
    }
  }

  try {
    const linkData = await callTool('files_get_download_link', { task_id: entry.taskId, file_id: entry.fileId });
    const url = linkData.link || linkData.url || linkData.download_url;
    if (!url) throw new Error(`未获取到下载链接：${JSON.stringify(linkData).slice(0, 150)}`);

    const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
    const res = await fetch(url, { headers });
    if (res.status === 416 && start > 0) {
      // 断点越界：本地残留比远端大，重下
      unlinkSync(part);
      return downloadEntry(entry, attempt);
    }
    if (!res.ok && res.status !== 206) throw new Error(`下载失败 HTTP ${res.status}`);

    const resumed = res.status === 206 && start > 0;
    if (!resumed) start = 0;
    const expected = Number(res.headers.get('content-length') || 0) + start;
    const stream = createWriteStream(part, { flags: resumed ? 'a' : 'w' });

    let received = start;
    const startedAt = Date.now();
    let lastTick = Date.now();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!stream.write(Buffer.from(value))) await once(stream, 'drain');
      received += value.length;
      if (Date.now() - lastTick > 8000) {
        const speed = received - (stats.doneBytes ? 0 : 0);
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = (received - start) / Math.max(1, elapsed);
        console.log(
          `  ${entry.relPath.slice(0, 60)} ${(received / Math.max(1, expected) * 100).toFixed(1)}% ` +
            `${human(received)} ${human(rate)}/s`
        );
        lastTick = Date.now();
      }
    }
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));

    const finalSize = statSync(part).size;
    if (entry.size > 0 && finalSize !== entry.size) {
      throw new Error(`大小不符：期望 ${entry.size}，实际 ${finalSize}`);
    }
    renameSync(part, full);
    stats.doneBytes += entry.size || finalSize;
    stats.doneFiles += 1;
    console.log(`  完成 ${entry.relPath}（${human(finalSize)}）｜${overall()}`);
  } catch (err) {
    if (attempt < 3) {
      const wait = 2000 * attempt;
      console.log(`  重试(${attempt}/3) ${entry.relPath}：${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
      return downloadEntry(entry, attempt + 1);
    }
    stats.failedFiles += 1;
    stats.failed.push(`${entry.relPath}：${err.message}`);
    console.log(`  失败 ${entry.relPath}：${err.message}`);
  }
}

async function runPool(entries, workerCount) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(workerCount, entries.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      await downloadEntry(entries[index]);
    }
  });
  await Promise.all(workers);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log(`输出目录：${path.resolve(outRoot)}`);
  const taskData = await callTool('magnet_task_list', { limit: 200, offset: 0 });
  let tasks = taskData.items || [];
  if (taskFilter.length) tasks = tasks.filter((t) => taskFilter.includes(t.id));

  if (!tasks.length) {
    console.log('没有匹配的任务');
    return;
  }

  console.log(`任务 ${tasks.length} 个，正在展开目录...`);
  const entries = [];
  for (const task of tasks) {
    const list = await collectTask(task);
    const bytes = list.reduce((sum, item) => sum + item.size, 0);
    console.log(`  ${task.file_name}：${list.length} 个文件，${human(bytes)}`);
    entries.push(...list);
  }

  stats.totalBytes = entries.reduce((sum, item) => sum + item.size, 0);
  console.log(`\n合计 ${entries.length} 个文件，${human(stats.totalBytes)}`);

  if (dryRun) {
    for (const entry of entries) {
      console.log(`  [${human(entry.size).padStart(10)}] ${entry.relPath}`);
    }
    console.log('\n（--dry-run 模式，未下载）');
    return;
  }

  console.log(`\n开始下载（并发 ${concurrency}）...`);
  const startedAt = Date.now();
  await runPool(entries, concurrency);

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log('\n===== 汇总 =====');
  console.log(`完成 ${stats.doneFiles} 个，跳过 ${stats.skippedFiles} 个，失败 ${stats.failedFiles} 个`);
  console.log(`累计 ${human(stats.doneBytes)}，用时 ${(elapsed / 60).toFixed(1)} 分钟`);
  if (stats.failed.length) {
    console.log('失败列表：');
    for (const item of stats.failed) console.log(`  ${item}`);
  }
}

main().catch((err) => {
  console.error(`运行失败：${err.message}`);
  process.exit(1);
});
