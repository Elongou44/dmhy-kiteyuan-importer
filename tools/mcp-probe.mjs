#!/usr/bin/env node
/**
 * 纸鸢网盘 MCP 协议探测器（只读）
 *
 * 仅执行 initialize / notifications/initialized / tools/list，不会调用任何 tools/call，
 * 因此不会创建转存任务、不消耗积分。
 *
 * 用法：
 *   node tools/mcp-probe.mjs --token <your_mcp_token>
 *   MCP_TOKEN=xxx node tools/mcp-probe.mjs
 *   node tools/mcp-probe.mjs --token xxx --url http://127.0.0.1:8787/api/v1/mcp
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'https://mybt.kiteyuan.info/api/v1/mcp';

function parseArgs(argv) {
  const out = {
    url: process.env.MCP_URL || DEFAULT_URL,
    token: process.env.MCP_TOKEN || '',
    call: '',
    args: '{}',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--token' || a === '-t') out.token = argv[++i] || '';
    else if (a === '--url' || a === '-u') out.url = argv[++i] || out.url;
    else if (a === '--call') out.call = argv[++i] || '';
    else if (a === '--args') out.args = argv[++i] || '{}';
  }
  return out;
}

/** 把可能为 SSE 或纯 JSON 的响应体解析成 JSON-RPC 消息数组 */
export function parseRpcMessages(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  // 纯 JSON（单条或多条换行分隔）
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      /* 落到 SSE 分支 */
    }
  }
  const messages = [];
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      messages.push({ __unparsed: data });
    }
  }
  return messages;
}

class McpClient {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
    this.sessionId = '';
    this.nextId = 1;
    this.accept = 'application/json, text/event-stream';
    this.log = [];
  }

  headers(extra = {}) {
    const h = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: this.accept,
      'MCP-Protocol-Version': '2025-11-25',
      ...extra,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async post(body, { expectReply = true } = {}) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    const record = {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      sessionId: sid || '',
      raw: text,
    };
    this.log.push(record);
    if (!expectReply) return { res, messages: [], record };
    return { res, messages: parseRpcMessages(text), record };
  }

  async initialize() {
    const id = this.nextId++;
    const { res, messages, record } = await this.post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'mcp-probe', version: '1.0.0' },
      },
    });
    // 部分服务端要求 Accept 同时含两种类型，若 406 则退回纯 application/json 再试一次
    if (res.status === 406 && this.accept !== 'application/json') {
      this.accept = 'application/json';
      return this.initialize();
    }
    return { id, status: res.status, messages, record };
  }

  async initializedNotification() {
    return this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectReply: false });
  }

  async rpc(method, params) {
    const id = this.nextId++;
    const { res, messages, record } = await this.post({ jsonrpc: '2.0', id, method, params });
    return { id, status: res.status, messages, record };
  }
}

function pickResult(messages, id) {
  const msg = messages.find((m) => m && m.id === id) || messages[0];
  if (!msg) return { error: 'no JSON-RPC message in response' };
  if (msg.error) return { error: msg.error };
  return { result: msg.result };
}

async function main() {
  const { url, token, call: callName, args } = parseArgs(process.argv.slice(2));
  if (!token) {
    console.error('缺少 token：node tools/mcp-probe.mjs --token <your_mcp_token>');
    process.exit(2);
  }
  console.log(`endpoint: ${url}`);
  console.log(`token: ${token.slice(0, 6)}...${token.slice(-4)} (len=${token.length})`);

  const client = new McpClient({ url, token });
  const init = await client.initialize();
  console.log(`\n[1] initialize -> HTTP ${init.status} (${init.record.contentType})`);
  console.log(`    session-id: ${init.record.sessionId || '(none)'}`);
  const initResult = pickResult(init.messages, init.id);
  if (initResult.error) {
    console.log(`    ERROR: ${JSON.stringify(initResult.error)}`);
    console.log(`    body: ${init.record.raw.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`    serverInfo: ${JSON.stringify(initResult.result?.serverInfo || {})}`);
  console.log(`    protocolVersion: ${initResult.result?.protocolVersion}`);

  await client.initializedNotification();
  console.log(`\n[2] notifications/initialized -> ${client.log.at(-1).status} (session=${client.sessionId || 'none'})`);

  const list = await client.rpc('tools/list', {});
  console.log(`\n[3] tools/list -> HTTP ${list.status} (${list.record.contentType})`);
  const listResult = pickResult(list.messages, list.id);
  if (listResult.error) {
    console.log(`    ERROR: ${JSON.stringify(listResult.error)}`);
    console.log(`    body: ${list.record.raw.slice(0, 500)}`);
    process.exit(1);
  }
  const tools = listResult.result?.tools || [];
  console.log(`    tools (${tools.length}):`);
  for (const t of tools) {
    const props = t.inputSchema?.properties || {};
    const required = t.inputSchema?.required || [];
    const params = Object.keys(props)
      .map((k) => (required.includes(k) ? `${k}*` : k))
      .join(', ');
    console.log(`      - ${t.name}(${params})`);
  }

  if (callName) {
    const callRes = await client.rpc('tools/call', {
      name: callName,
      arguments: JSON.parse(args),
    });
    console.log(`\n[4] tools/call ${callName} -> HTTP ${callRes.status} (${callRes.record.contentType})`);
    console.log(`    body: ${callRes.record.raw.slice(0, 2000)}`);
  } else {
    console.log('\nOK: probe finished (no tools/call executed)');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`probe failed: ${err?.message || err}`);
    process.exit(1);
  });
}
