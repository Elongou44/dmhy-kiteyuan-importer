#!/usr/bin/env node
/**
 * 纸鸢网盘 MCP 的本地 Mock 服务端（零依赖），用于离线联调脚本。
 *
 * 启动：
 *   node tools/mock-mcp-server.mjs                 # http://127.0.0.1:8787/api/v1/mcp
 *   node tools/mock-mcp-server.mjs --port 9000
 *
 * 模拟行为开关（环境变量）：
 *   MOCK_MODE=normal    正常返回（默认）
 *   MOCK_MODE=sse       tools/call 使用 text/event-stream 返回（验证脚本的 SSE 解析）
 *   MOCK_MODE=unbound   返回「未绑定邀请码」业务错误（result.isError = true）
 *   MOCK_MODE=biz       不设置 isError，只返回失败文案（验证脚本的兜底判断）
 *   MOCK_MODE=deep      模拟真实服务端：失败放在 items[].error 且不置 isError
 *   MOCK_MODE=hashlen   返回「磁力哈希长度非法」（验证脚本的排查提示）
 *   MOCK_MODE=expired   所有请求返回 401（验证 token 失效提示）
 *   MOCK_MODE=stricty   必须先 initialize（否则 tools/call 返回 -32002），验证握手回退逻辑
 *   MOCK_MODE=flaky     前 2 次 tools/call 返回 JSON-RPC 错误，第 3 次成功（验证手动重试）
 *
 * 鉴权：任何非空 Bearer token 均可（Mock 不校验具体值）。
 */

import http from 'node:http';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(getArg('--port', process.env.PORT || 8787));
const MODE = getArg('--mode', process.env.MOCK_MODE || 'normal');
const PATH = '/api/v1/mcp';

const PROTOCOL_VERSION = '2025-11-25';
const serverInfo = { name: 'Mock-MagnetFlow', version: '0.0.1-mock' };

const tasks = new Map();
let initialized = false;
let flakyCounter = 0;
let seq = 0;

const tools = [
  { name: 'magnet_task_add', description: '将磁力链接转存到纸鸢网盘', inputSchema: { type: 'object', properties: { magnet: { type: 'string' } }, required: ['magnet'] } },
  { name: 'magnet_task_list', description: '查询磁力转存任务列表', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'task_get_status', description: '按任务 ID 查询任务状态', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } } },
  { name: 'storage_get_status', description: '查询网盘空间与积分状态', inputSchema: { type: 'object', properties: {} } },
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

// 真实服务端（Golang-MagnetFlow）风格：业务结果放在 items 里，失败用 items[].error 表示，
// 两种情况都不设置 result.isError（见 tools/mcp-probe.mjs 的实测输出）。
function handleToolCall(name, params) {
  if (name === 'magnet_task_add') {
    if (MODE === 'deep') {
      return { isError: false, ...textResult({ items: [{ error: 'invalid magnet link' }] }) };
    }
    const magnet = String(params?.magnet || '');
    // 与真实纸鸢一致：只接受 40 位 hex 的 BTIH，Base32（32 位）会报「磁力哈希长度非法」
    if (!/^magnet:\?xt=urn:btih:[0-9a-f]{40}(&|$)/i.test(magnet)) {
      return {
        isError: false,
        ...textResult({ items: [{ error: '磁力哈希长度非法：invalid magnet hash length' }] }),
      };
    }
    const hash = (magnet.match(/urn:btih:([0-9a-z]+)/i) || [])[1].toLowerCase();
    const existing = [...tasks.values()].find((t) => t.hash === hash);
    if (existing) {
      return {
        isError: false,
        ...textResult({ items: [{ error: 'task already exists', id: existing.task_id }] }),
      };
    }
    seq += 1;
    const task = {
      task_id: `mock-task-${String(seq).padStart(3, '0')}`,
      hash,
      status: 'pending',
      name: `mock-${seq}`,
      source_url: magnet,
    };
    tasks.set(task.task_id, task);
    return {
      isError: false,
      ...textResult({ items: [{ id: task.task_id, magnet_hash: hash, source_url: magnet, status: 'pending' }] }),
    };
  }
  if (name === 'magnet_task_list') {
    return {
      isError: false,
      ...textResult({
        items: [...tasks.values()].map((t) => ({
          id: t.task_id,
          magnet_hash: t.hash,
          source_url: t.source_url,
          status: t.status,
        })),
        limit: 50,
        offset: 0,
      }),
    };
  }
  if (name === 'task_get_status') {
    const task = tasks.get(String(params?.task_id || ''));
    return task
      ? { isError: false, ...textResult(task) }
      : { isError: true, ...textResult({ message: 'task not found' }) };
  }
  if (name === 'storage_get_status') {
    return {
      isError: false,
      ...textResult({
        user_id: 'mock-user',
        points: 1234,
        storage_limit_bytes: 1099511627776,
        storage_used_bytes: 13743895347,
        storage_available_bytes: 1085767732429,
      }),
    };
  }
  return { isError: true, ...textResult({ message: `unknown tool: ${name}` }) };
}

function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    initialized = true;
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo,
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools });
  }
  if (method === 'tools/call') {
    if (MODE === 'stricty' && !initialized) {
      return rpcError(id, -32002, 'Session not initialized: send initialize first');
    }
    if (MODE === 'unbound') {
      return rpcResult(id, { isError: true, ...textResult({ message: '请先绑定邀请码后再使用 MCP 服务' }) });
    }
    if (MODE === 'biz') {
      // 不设置 isError，只返回失败文案（验证脚本的兜底判定）
      return rpcResult(id, { isError: false, ...textResult({ message: '转存失败：积分不足' }) });
    }
    if (MODE === 'hashlen') {
      // 模拟纸鸢对 Base32 哈希的报错，验证脚本的排查提示
      return rpcResult(id, {
        isError: false,
        ...textResult({ items: [{ error: '磁力哈希长度非法：invalid magnet hash length' }] }),
      });
    }
    if (MODE === 'flaky') {
      flakyCounter += 1;
      if (flakyCounter <= 2) {
        return rpcError(id, -32603, 'Internal error: temporary upstream failure');
      }
    }
    return rpcResult(id, handleToolCall(params?.name, params?.arguments));
  }
  if (method === 'notifications/initialized') return null;
  return rpcError(id ?? null, -32601, `Method not found: ${method}`);
}

function send(res, status, body, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== PATH) {
    return send(res, 404, JSON.stringify({ message: 'not found' }));
  }
  if (req.method === 'GET' || req.method === 'DELETE') {
    return send(res, 405, JSON.stringify({ message: 'method not allowed (mock)' }));
  }
  if (req.method !== 'POST') {
    return send(res, 405, JSON.stringify({ message: 'method not allowed' }));
  }
  const auth = req.headers.authorization || '';
  if (MODE === 'expired' || !/^Bearer\s+\S+/.test(auth)) {
    return send(res, 401, JSON.stringify({ message: 'unauthorized (mock): invalid or missing token' }));
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return send(res, 400, JSON.stringify({ message: 'invalid json' }));
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    const out = [];
    for (const msg of messages) {
      if (msg.id === undefined) {
        handleMessage(msg); // 通知类，无响应
        continue;
      }
      const reply = handleMessage(msg);
      if (reply) out.push(reply);
    }
    if (out.length === 0) return send(res, 202, '');

    const useSse = MODE === 'sse' && messages.some((m) => m.method === 'tools/call');
    if (useSse) {
      const body = out.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('');
      return send(res, 200, body, 'text/event-stream');
    }
    const body = out.length === 1 ? JSON.stringify(out[0]) : JSON.stringify(out);
    return send(res, 200, body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock MCP server listening: http://127.0.0.1:${PORT}${PATH}`);
  console.log(`mode: ${MODE}`);
});
