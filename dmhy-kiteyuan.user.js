// ==UserScript==
// @name         dmhy → 纸鸢网盘 一键转存
// @name:zh-CN   动漫花园 → 纸鸢网盘 一键转存
// @namespace    https://github.com/Elongou44/dmhy-kiteyuan-importer
// @version      1.0.0
// @description  在动漫花园(dmhy)资源列表的每条资源旁添加「纸鸢」转存与「复制」磁力按钮，点击即通过 MCP 将磁力链接转存到纸鸢网盘（Token 在本机配置，不写入脚本）
// @author       Elongou44
// @license      MIT
// @match        https://share.dmhy.org/topics/list*
// @match        http://share.dmhy.org/topics/list*
// @match        http://127.0.0.1:8788/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      mybt.kiteyuan.info
// @connect      share.dmhy.org
// @connect      127.0.0.1
// @connect      localhost
// @noframes
// @run-at       document-idle
// ==/UserScript==

/**
 * 工作方式
 * 1. 在 dmhy 列表页为每条资源注入一个按钮（磁力图标旁）；
 * 2. 点击后取出该行的磁力链接（行内没有磁力时回退到详情页解析）；
 * 3. 通过纸鸢网盘 MCP endpoint 调用 magnet_task_add 完成转存。
 *
 * 关于 MCP 调用次数：服务端是无状态的（响应中不带 Mcp-Session-Id），
 * 因此默认「直接 tools/call」，仅在服务端要求握手时（返回 session/initialize 类错误）
 * 才补做 initialize + notifications/initialized 后重试一次，避免多余请求。
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 配置
   * ------------------------------------------------------------------ */

  const STORE_KEYS = {
    endpoint: 'ky_mcp_endpoint',
    token: 'ky_mcp_token',
    protocol: 'ky_mcp_protocol_version',
    timeout: 'ky_mcp_timeout_ms',
    keepTrackers: 'ky_magnet_keep_trackers',
  };

  const DEFAULT_CONFIG = {
    // 推荐 endpoint（原始路由为 https://mybt.kiteyuan.info/mcp）
    endpoint: 'https://mybt.kiteyuan.info/api/v1/mcp',
    // 不内置任何 Token：Token 属于隐私凭据，只保存在本机脚本存储（GM_setValue）中，
    // 首次使用请点击页面上的转存按钮按提示填写，或用脚本菜单「设置 MCP Token」。
    token: '',
    protocol: '2025-11-25',
    timeout: 60000,
    // 是否保留 magnet 里的 tr= 跟踪器参数；默认丢弃（纸鸢会自行处理 tracker，且原链接常长达上千字符）
    keepTrackers: false,
  };

  const TOOL_ADD_MAGNET = 'magnet_task_add';
  const LOG_PREFIX = '[dmhy→纸鸢]';
  const BTN_CLASS = 'ky-import-btn';
  const COPY_BTN_CLASS = 'ky-copy-btn';
  const BTN_GROUP_CLASS = 'ky-btn-group';

  /** 读取配置：优先脚本管理器的 GM 存储，若管理器未注入同步 API 则回退 localStorage */
  function gmGetValue(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (err) {
      warn('读取配置失败，回退 localStorage', err);
    }
    try {
      const raw = localStorage.getItem(`dmhy-ky.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function gmSetValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (err) {
      warn('保存配置失败，回退 localStorage', err);
    }
    try {
      localStorage.setItem(`dmhy-ky.${key}`, JSON.stringify(value));
    } catch (err) {
      warn('保存配置失败', err);
    }
  }

  let configCache = null;

  function readConfig() {
    if (configCache) return configCache;
    const num = Number(gmGetValue(STORE_KEYS.timeout, DEFAULT_CONFIG.timeout));
    configCache = {
      endpoint: String(gmGetValue(STORE_KEYS.endpoint, DEFAULT_CONFIG.endpoint) || '').trim(),
      token: String(gmGetValue(STORE_KEYS.token, DEFAULT_CONFIG.token) || '').trim(),
      protocol: String(gmGetValue(STORE_KEYS.protocol, DEFAULT_CONFIG.protocol) || '').trim(),
      timeout: Number.isFinite(num) && num > 0 ? num : DEFAULT_CONFIG.timeout,
      keepTrackers: Boolean(gmGetValue(STORE_KEYS.keepTrackers, DEFAULT_CONFIG.keepTrackers)),
    };
    return configCache;
  }

  /** 配置写入后清空缓存，让下次读取立刻生效 */
  function invalidateConfigCache() {
    configCache = null;
  }

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  /* ------------------------------------------------------------------ *
   * 错误类型
   * ------------------------------------------------------------------ */

  class ImportError extends Error {
    constructor(code, message, detail) {
      super(message);
      this.name = 'ImportError';
      this.code = code;
      this.detail = detail;
    }
  }

  const isSessionError = (message) =>
    /session|initializ|not\s*connected|handshake|-32002/i.test(String(message || ''));

  const isAlreadyExists = (message) =>
    /已存在|已提交|重复|duplicate|already\s*exist/i.test(String(message || ''));

  const isInviteRequired = (message) => /邀请码|invite/i.test(String(message || ''));

  const isTokenInvalid = (message) =>
    /token|unauthor|未授权|鉴权|认证|401/i.test(String(message || ''));

  /* ------------------------------------------------------------------ *
   * MCP 客户端（Streamable HTTP）
   * ------------------------------------------------------------------ */

  /** 兼容 Tampermonkey / 脚本猫的 GM_xmlhttpRequest，以及 GM4 风格的 GM.xmlHttpRequest */
  function gmRequest(options) {
    const timeout = options.timeout || DEFAULT_CONFIG.timeout;
    const params = {
      method: options.method,
      url: options.url,
      headers: options.headers,
      data: options.data,
      timeout,
    };
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          ...params,
          onload: (res) => resolve(res),
          onerror: () => reject(new ImportError('NETWORK', '网络请求失败（请检查网络或站点是否可访问）')),
          ontimeout: () => reject(new ImportError('TIMEOUT', `请求超时（>${Math.round(timeout / 1000)}s）`)),
          onabort: () => reject(new ImportError('ABORT', '请求被中止')),
        });
      });
    }
    if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
      // GM4 返回 Promise<Response>，字段与回调版一致
      return Promise.resolve(GM.xmlHttpRequest(params)).catch((err) => {
        throw new ImportError('NETWORK', `网络请求失败：${(err && err.message) || err}`);
      });
    }
    return Promise.reject(
      new ImportError('NO_GM_API', '当前脚本管理器不支持跨域请求（GM_xmlhttpRequest），请使用脚本猫或 Tampermonkey')
    );
  }

  /** 兼容纯 JSON、JSON 数组与 SSE（text/event-stream）三种响应体 */
  function parseRpcMessages(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (err) {
        warn('响应不是合法 JSON，尝试按 SSE 解析', err.message);
      }
    }
    const messages = [];
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        messages.push(JSON.parse(data));
      } catch (err) {
        warn('无法解析 SSE data 段', data.slice(0, 200));
      }
    }
    return messages;
  }

  const mcpState = {
    sessionId: '',
    initialized: false,
    nextId: 1,
    serverInfo: null,
  };

  function buildHeaders(config) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': config.protocol,
      Authorization: `Bearer ${config.token}`,
    };
    if (mcpState.sessionId) headers['Mcp-Session-Id'] = mcpState.sessionId;
    return headers;
  }

  function readHeader(res, name) {
    const headers = res.responseHeaders || '';
    const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
    const match = headers.match(re);
    return match ? match[1].trim() : '';
  }

  async function mcpRpc(method, params, options = {}) {
    const config = readConfig();
    if (!config.token) {
      throw new ImportError('NO_TOKEN', '尚未配置 MCP Token（脚本菜单 → 设置 MCP Token）');
    }
    const isNotification = options.notification === true;
    const payload = isNotification
      ? { jsonrpc: '2.0', method, params: params || {} }
      : { jsonrpc: '2.0', id: mcpState.nextId++, method, params: params || {} };

    const res = await gmRequest({
      method: 'POST',
      url: config.endpoint,
      headers: buildHeaders(config),
      data: JSON.stringify(payload),
      timeout: config.timeout,
    });

    const sessionId = readHeader(res, 'Mcp-Session-Id');
    if (sessionId) mcpState.sessionId = sessionId;

    if (isNotification) return { ok: true, status: res.status };

    const bodyText = res.responseText || '';
    if (res.status === 401 || res.status === 403) {
      throw new ImportError('TOKEN_INVALID', `服务端返回 HTTP ${res.status}${bodyText ? '：' + bodyText.slice(0, 160) : ''}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ImportError('HTTP_ERROR', `HTTP ${res.status}${bodyText ? '：' + bodyText.slice(0, 160) : ''}`);
    }

    const messages = parseRpcMessages(bodyText);
    if (!messages.length) {
      throw new ImportError('BAD_RESPONSE', '服务端未返回 JSON-RPC 消息');
    }
    const message = messages.find((m) => m && m.id === payload.id) || messages[0];
    if (message.error) {
      throw new ImportError('RPC_ERROR', message.error.message || JSON.stringify(message.error), message.error);
    }
    return { ok: true, status: res.status, result: message.result };
  }

  async function mcpEnsureInitialized(force) {
    if (mcpState.initialized && !force) return;
    const config = readConfig();
    const result = await mcpRpc('initialize', {
      protocolVersion: config.protocol,
      capabilities: {},
      clientInfo: { name: 'dmhy-kiteyuan-userscript', version: '1.0.0' },
    });
    mcpState.serverInfo = (result.result && result.result.serverInfo) || null;
    mcpState.initialized = true;
    try {
      await mcpRpc('notifications/initialized', {}, { notification: true });
    } catch (err) {
      warn('notifications/initialized 发送失败（不影响后续调用）', err.message);
    }
    log('MCP 握手完成', mcpState.serverInfo || '');
  }

  async function mcpCallTool(name, args) {
    try {
      return await mcpRpc('tools/call', { name, arguments: args });
    } catch (err) {
      if (err.code === 'RPC_ERROR' && isSessionError(err.message)) {
        log('服务端要求先握手，补做 initialize 后重试');
        mcpState.initialized = false;
        await mcpEnsureInitialized(true);
        return mcpRpc('tools/call', { name, arguments: args });
      }
      throw err;
    }
  }

  /** tools/call 结果拆包：优先 structuredContent，其次 content[].text */
  function unwrapToolResult(result) {
    if (!result) return {};
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      return result.structuredContent;
    }
    const textItem = (result.content || []).find((item) => item && item.type === 'text');
    if (textItem && typeof textItem.text === 'string') {
      try {
        const parsed = JSON.parse(textItem.text);
        return parsed && typeof parsed === 'object' ? parsed : { message: textItem.text };
      } catch (err) {
        return { message: textItem.text };
      }
    }
    return {};
  }

  /**
   * 在返回数据中按 key 名称做深层查找（含数组），例如真实服务端返回：
   *   成功 { items: [{ id: 'xxxx-uuid', magnet_hash: '...', status: 'pending' }] }
   *   失败 { items: [{ error: 'invalid task_id', task_id: '...' }] }
   * 两种结构都没有 isError 标记，因此必须逐层找 error / id。
   */
  function findDeepString(data, keys, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 5) return '';
    if (Array.isArray(data)) {
      for (const item of data) {
        const found = findDeepString(item, keys, depth + 1);
        if (found) return found;
      }
      return '';
    }
    for (const key of keys) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    for (const value of Object.values(data)) {
      if (value && typeof value === 'object') {
        const found = findDeepString(value, keys, depth + 1);
        if (found) return found;
      }
    }
    return '';
  }

  function pickMessage(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    return findDeepString(data, ['message', 'msg', 'error', 'detail', 'reason', 'description']);
  }

  function extractTaskId(data) {
    return findDeepString(data, ['task_id', 'taskId', 'id']);
  }

  /** 部分实现不设置 result.isError，而是把失败信息放在业务字段里 */
  function detectBusinessError(data) {
    if (!data || typeof data !== 'object') return '';
    const deepError = findDeepString(data, ['error']);
    if (deepError) return deepError;
    if (data.success === false) return pickMessage(data) || '服务端返回失败状态';
    if (typeof data.code === 'number' && data.code !== 0 && data.code !== 200) {
      return pickMessage(data) || `服务端返回 code=${data.code}`;
    }
    return '';
  }

  const looksLikeErrorText = (text) =>
    /失败|错误|异常|不允许|未绑定|未授权|无权限|积分不足|空间不足|已满|黑名单|invalid|denied|forbidden|unauthor|error|fail/i.test(
      String(text || '')
    );

  async function submitMagnet(magnet) {
    const call = await mcpCallTool(TOOL_ADD_MAGNET, { magnet });
    const result = call.result || {};
    const data = unwrapToolResult(result);
    const message = pickMessage(data) || pickMessage(result);
    const taskId = extractTaskId(data);
    const businessError = detectBusinessError(data);
    if (result.isError || businessError) {
      throw new ImportError('TOOL_ERROR', businessError || message || '转存失败', data);
    }
    // 兜底：既没有任务 ID，返回文案又像错误，则按失败处理，避免把拒绝当成成功
    if (!taskId && message && looksLikeErrorText(message)) {
      throw new ImportError('TOOL_ERROR', message, data);
    }
    return { taskId, data, message };
  }

  /* ------------------------------------------------------------------ *
   * 页面提示
   * ------------------------------------------------------------------ */

  const TOAST_ID = 'ky-toast-host';

  function ensureToastHost() {
    let host = document.getElementById(TOAST_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = TOAST_ID;
    host.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
      'max-width:360px',
      'font-size:13px',
      'line-height:1.5',
    ].join(';');
    document.body.appendChild(host);
    return host;
  }

  function toast(type, text, timeout = 6000) {
    const host = ensureToastHost();
    const item = document.createElement('div');
    const palette = {
      success: ['#0f5132', '#d1e7dd', '#badbcc'],
      error: ['#842029', '#f8d7da', '#f5c2c7'],
      info: ['#055160', '#cff4fc', '#b6effb'],
      loading: ['#333333', '#f8f9fa', '#dee2e6'],
    }[type] || ['#333333', '#f8f9fa', '#dee2e6'];
    item.style.cssText = [
      'padding:8px 12px',
      'border-radius:6px',
      'box-shadow:0 4px 12px rgba(0,0,0,.15)',
      `color:${palette[0]}`,
      `background:${palette[1]}`,
      `border:1px solid ${palette[2]}`,
      'white-space:pre-wrap',
      'word-break:break-word',
    ].join(';');
    item.textContent = `${LOG_PREFIX} ${text}`;
    host.appendChild(item);
    if (timeout > 0) {
      setTimeout(() => item.remove(), timeout);
    }
    return item;
  }

  /* ------------------------------------------------------------------ *
   * dmhy 页面注入
   * ------------------------------------------------------------------ */

  const BTN_STYLE = `
.${BTN_GROUP_CLASS} {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  white-space: nowrap;
  vertical-align: middle;
}
.${BTN_CLASS},
.${COPY_BTN_CLASS} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  margin: 0;
  padding: 1px 8px;
  font-size: 12px;
  line-height: 18px;
  font-family: inherit;
  color: #fff !important;
  border-radius: 3px;
  cursor: pointer;
  vertical-align: middle;
  text-decoration: none !important;
  white-space: nowrap;
  transition: background-color .15s ease;
}
.${BTN_CLASS} {
  /* 固定最小宽度：转存各状态文案长度不同，避免切换时按钮与相邻复制按钮跳动 */
  min-width: 64px;
  background: #3d8fd9;
  border: 1px solid #2f7fd1;
}
.${BTN_CLASS}:hover { background: #2f7fd1; }
.${BTN_CLASS}[data-state="loading"] { background: #8a94a0; border-color: #7d8894; cursor: progress; }
.${BTN_CLASS}[data-state="success"] { background: #3f9c66; border-color: #35875a; cursor: default; }
.${BTN_CLASS}[data-state="error"] { background: #d9534f; border-color: #c9433f; }
.${BTN_CLASS}[data-state="error"]:hover { background: #c9433f; }
.${COPY_BTN_CLASS} {
  min-width: 52px;
  background: #6c757d;
  border: 1px solid #5f676e;
}
.${COPY_BTN_CLASS}:hover { background: #5f676e; }
.${COPY_BTN_CLASS}[data-state="loading"] { background: #8a94a0; border-color: #7d8894; cursor: progress; }
.${COPY_BTN_CLASS}[data-state="done"] { background: #3f9c66; border-color: #35875a; }
.${COPY_BTN_CLASS}[data-state="error"] { background: #d9534f; border-color: #c9433f; }
.${COPY_BTN_CLASS}[data-state="error"]:hover { background: #c9433f; }
`;

  const BTN_TEXT = {
    idle: '纸鸢',
    loading: '转存中…',
    success: '已转存',
    error: '重试转存',
  };

  const COPY_BTN_TEXT = {
    idle: '复制',
    loading: '读取中',
    done: '已复制',
    error: '重试',
  };

  const COPY_BTN_TITLE = '复制该资源的磁力链接';

  function injectStyle() {
    if (document.getElementById('ky-import-style')) return;
    const style = document.createElement('style');
    style.id = 'ky-import-style';
    style.textContent = BTN_STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  function setButtonState(button, state, title) {
    button.dataset.state = state;
    button.textContent = BTN_TEXT[state] || BTN_TEXT.idle;
    button.disabled = state === 'loading';
    if (title) button.title = title;
  }

  function setCopyButtonState(button, state, title = COPY_BTN_TITLE) {
    button.dataset.state = state;
    button.textContent = COPY_BTN_TEXT[state] || COPY_BTN_TEXT.idle;
    button.disabled = state === 'loading';
    button.title = title;
  }

  /**
   * 写入剪贴板，兼容脚本猫 / Tampermonkey 的 GM_setClipboard 与 GM4 风格的 GM.setClipboard。
   * 返回 true 表示已由 GM API 完成写入，false 表示当前管理器未提供剪贴板 API。
   */
  async function gmSetClipboard(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return true;
    }
    if (typeof GM !== 'undefined' && GM && typeof GM.setClipboard === 'function') {
      // GM4 规范下可能返回 Promise，统一 await 以兼容两种实现
      await GM.setClipboard(text, 'text');
      return true;
    }
    return false;
  }

  /**
   * 复制文本到剪贴板，返回是否成功。
   * 依次尝试：GM 剪贴板 API（不受用户手势/异步链限制）
   * → navigator.clipboard（需安全上下文且页面聚焦）
   * → 临时 textarea + execCommand（老浏览器兜底）。
   */
  async function copyText(text) {
    const value = String(text || '');
    if (!value) return false;

    try {
      if (await gmSetClipboard(value)) return true;
    } catch (err) {
      warn('GM 剪贴板 API 复制失败，改试 Web API', err);
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (err) {
      warn('navigator.clipboard 复制失败，改试 execCommand', err);
    }

    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
      (document.body || document.documentElement).appendChild(area);
      area.select();
      area.setSelectionRange(0, area.value.length);
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (err) {
      warn('execCommand 复制失败', err);
      return false;
    }
  }

  function decodeEntities(text) {
    const el = document.createElement('textarea');
    el.innerHTML = text;
    return el.value;
  }

  function extractMagnetFromHtml(html) {
    const pattern = /magnet:\?xt=urn:btih:[^"'<>\s\\]+/i;
    const match = String(html || '').match(pattern);
    return match ? decodeEntities(match[0]) : '';
  }

  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const HEX_HASH_RE = /^[0-9a-f]{40}$/i;
  const BASE32_HASH_RE = /^[a-z2-7]{32}$/i;

  /** BTIH 的 Base32 形式（dmhy 用的就是它）转 40 位 hex；失败返回空串 */
  function base32ToHex(input) {
    const text = String(input || '').toUpperCase().replace(/=+$/, '');
    if (!text) return '';
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of text) {
      const index = BASE32_ALPHABET.indexOf(char);
      if (index < 0) return '';
      value = (value << 5) | index;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    if (bytes.length !== 20) return '';
    return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 解析并规范化磁力链接，返回 { magnet, hash, converted }，不可用则返回 null。
   *
   * 关键：dmhy 给出的 BTIH 大多是 Base32（32 位，如 IBDFG6XQ35NHBMXXU46LB2RHATX6ZUVO），
   * 而纸鸢网盘只接受 40 位 hex，直接提交会报「磁力哈希长度非法」，因此这里统一转成 hex。
   * 默认还会丢弃 tr= 跟踪器参数（纸鸢自行处理 tracker，原始链接常长达上千字符），只保留 dn。
   */
  function parseMagnet(raw) {
    const text = decodeEntities(String(raw || '').trim());
    if (!/^magnet:/i.test(text)) return null;
    const hashMatch = text.match(/xt=urn:btih:([0-9a-z]+)/i);
    if (!hashMatch) return null;

    const rawHash = hashMatch[1];
    let hash = '';
    if (HEX_HASH_RE.test(rawHash)) hash = rawHash.toLowerCase();
    else if (BASE32_HASH_RE.test(rawHash)) hash = base32ToHex(rawHash);
    if (!hash) return null;

    const dnMatch = text.match(/[?&]dn=([^&]*)/i);
    const dn = dnMatch ? dnMatch[1] : '';
    const magnet = readConfig().keepTrackers
      ? text.replace(/urn:btih:[0-9a-z]+/i, `urn:btih:${hash}`)
      : `magnet:?xt=urn:btih:${hash}${dn ? `&dn=${dn}` : ''}`;

    return { magnet, hash, converted: !HEX_HASH_RE.test(rawHash) };
  }

  function normalizeMagnet(raw) {
    const parsed = parseMagnet(raw);
    return parsed ? parsed.magnet : '';
  }

  /** 行内没有磁力链接时，回退到详情页解析（走 GM 请求，避免页面 CSP 限制） */
  async function fetchMagnetFromDetail(detailUrl) {
    const res = await gmRequest({
      method: 'GET',
      url: detailUrl,
      headers: { Accept: 'text/html,application/xhtml+xml' },
      timeout: 30000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new ImportError('DETAIL_HTTP', `打开详情页失败：HTTP ${res.status}`);
    }
    const raw = extractMagnetFromHtml(res.responseText);
    if (!raw) {
      throw new ImportError('NO_MAGNET', '详情页中也没有找到磁力链接（该资源可能只提供种子文件）');
    }
    const parsed = parseMagnet(raw);
    if (!parsed) {
      throw new ImportError('NO_MAGNET', `详情页的磁力哈希格式无法识别：${raw.slice(0, 60)}`);
    }
    return parsed.magnet;
  }

  const MAGNET_ANCHOR_SELECTOR =
    'a[href^="magnet:"], a.download-arrow.arrow-magnet, a[data-clipboard-text^="magnet:"], a[data-magnet^="magnet:"]';

  function magnetFromRow(row) {
    for (const anchor of row.querySelectorAll(MAGNET_ANCHOR_SELECTOR)) {
      // 依次尝试 href / data-* ：dmhy 目前是 href，data-* 作为兜底以防改版
      const candidates = [
        anchor.getAttribute('href'),
        anchor.dataset.magnet,
        anchor.dataset.clipboardText,
        anchor.getAttribute('data-clipboard-text'),
        anchor.getAttribute('data-magnet'),
      ];
      for (const candidate of candidates) {
        const magnet = normalizeMagnet(candidate);
        if (magnet) return magnet;
      }
    }
    return '';
  }

  function detailUrlFromRow(row) {
    const anchor = row.querySelector('a[href*="/topics/view/"]');
    if (!anchor) return '';
    const href = anchor.getAttribute('href') || '';
    try {
      return new URL(href, location.origin).toString();
    } catch (err) {
      return '';
    }
  }

  const PANEL_MASK_ID = 'ky-settings-mask';
  const PANEL_ID = 'ky-settings-panel';
  const panelPrimaryBtn =
    'padding:6px 12px;border:1px solid #2f7fd1;background:#3d8fd9;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;';
  const panelPlainBtn =
    'padding:6px 12px;border:1px solid #ccc;background:#f7f7f7;color:#333;border-radius:4px;cursor:pointer;font-size:13px;';
  const panelInput =
    'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;color:#222;background:#fff;';

  function closeSettingsPanel() {
    const mask = document.getElementById(PANEL_MASK_ID);
    if (mask) mask.remove();
  }

  /**
   * 图形化设置面板（Token / Endpoint）。
   * resolve(true) = 已保存，resolve(false) = 取消。
   */
  function openSettingsPanel() {
    if (document.getElementById(PANEL_MASK_ID)) return Promise.resolve(false);
    const config = readConfig();

    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.id = PANEL_MASK_ID;
      mask.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';

      const panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.cssText =
        'width:min(460px,92vw);background:#fff;color:#222;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.3);font:13px/1.6 "Microsoft YaHei",Arial,sans-serif;padding:18px 20px;';
      panel.innerHTML = `
        <div style="font-size:15px;font-weight:700;margin-bottom:2px;">纸鸢转存 · 脚本设置</div>
        <div style="color:#888;font-size:12px;margin-bottom:14px;">Token 只保存在本机脚本存储，不会写入脚本文件</div>
        <label style="display:block;margin-bottom:12px;">
          <span style="display:block;margin-bottom:4px;color:#555;">MCP Token</span>
          <span style="display:flex;gap:6px;">
            <input id="ky-set-token" type="password" autocomplete="off" spellcheck="false" style="${panelInput}" />
            <button id="ky-set-toggle" type="button" style="${panelPlainBtn}white-space:nowrap;">显示</button>
          </span>
        </label>
        <label style="display:block;margin-bottom:12px;">
          <span style="display:block;margin-bottom:4px;color:#555;">MCP Endpoint</span>
          <input id="ky-set-endpoint" type="text" autocomplete="off" spellcheck="false" style="${panelInput}" />
        </label>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <input id="ky-set-trackers" type="checkbox" />
          <span>保留 tracker 参数（tr=…）</span>
        </label>
        <div style="color:#888;font-size:12px;margin-bottom:14px;">
          默认不保留：纸鸢会自行处理 tracker，去掉后磁力更短。Base32 哈希（如 IBDFG6XQ…）会自动转成 40 位 hex。
        </div>
        <div style="color:#777;font-size:12px;margin-bottom:14px;">
          在<span style="color:#3d8fd9;"> mybt.kiteyuan.info </span>的 MCP 页面生成 Token（仅明文显示一次）。<br>
          若提示「未绑定邀请码」，请先在纸鸢网盘完成邀请码绑定。
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
          <button id="ky-set-cancel" type="button" style="${panelPlainBtn}">取消</button>
          <button id="ky-set-save" type="button" style="${panelPrimaryBtn}">保存</button>
          <button id="ky-set-save-test" type="button" style="${panelPrimaryBtn}">保存并测试连接</button>
        </div>
      `;
      mask.appendChild(panel);
      document.body.appendChild(mask);

      const tokenInput = panel.querySelector('#ky-set-token');
      const endpointInput = panel.querySelector('#ky-set-endpoint');
      const trackersInput = panel.querySelector('#ky-set-trackers');
      const toggleBtn = panel.querySelector('#ky-set-toggle');
      const cancelBtn = panel.querySelector('#ky-set-cancel');
      const saveBtn = panel.querySelector('#ky-set-save');
      const saveTestBtn = panel.querySelector('#ky-set-save-test');

      tokenInput.value = config.token;
      endpointInput.value = config.endpoint;
      trackersInput.checked = Boolean(config.keepTrackers);
      setTimeout(() => tokenInput.focus(), 0);

      const finish = (saved) => {
        document.removeEventListener('keydown', onKeyDown, true);
        closeSettingsPanel();
        resolve(saved);
      };

      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.stopPropagation();
          finish(false);
        }
      }

      const save = () => {
        const token = tokenInput.value.trim();
        const endpoint = endpointInput.value.trim();
        if (!token) {
          toast('error', 'MCP Token 不能为空');
          tokenInput.focus();
          return false;
        }
        if (!endpoint) {
          toast('error', 'MCP Endpoint 不能为空');
          endpointInput.focus();
          return false;
        }
        gmSetValue(STORE_KEYS.token, token);
        gmSetValue(STORE_KEYS.endpoint, endpoint);
        gmSetValue(STORE_KEYS.keepTrackers, Boolean(trackersInput.checked));
        invalidateConfigCache();
        resetMcpSession();
        toast('success', '设置已保存到本机（不会写入脚本文件）', 8000);
        return true;
      };

      toggleBtn.addEventListener('click', () => {
        const hidden = tokenInput.type === 'password';
        tokenInput.type = hidden ? 'text' : 'password';
        toggleBtn.textContent = hidden ? '隐藏' : '显示';
      });
      cancelBtn.addEventListener('click', () => finish(false));
      mask.addEventListener('click', (event) => {
        if (event.target === mask) finish(false);
      });
      document.addEventListener('keydown', onKeyDown, true);
      saveBtn.addEventListener('click', () => {
        if (save()) finish(true);
      });
      saveTestBtn.addEventListener('click', () => {
        if (!save()) return;
        finish(true);
        runConnectionTest();
      });
    });
  }

  async function runConnectionTest() {
    const loadingToast = toast('loading', '正在连接纸鸢网盘 MCP…', 0);
    try {
      const call = await mcpCallTool('storage_get_status', {});
      const data = unwrapToolResult(call.result);
      const points = data.points !== undefined ? `积分 ${data.points}` : '';
      const used = typeof data.storage_used_bytes === 'number' ? formatBytes(data.storage_used_bytes) : '';
      const total = typeof data.storage_limit_bytes === 'number' ? formatBytes(data.storage_limit_bytes) : '';
      const storage = used && total ? `已用 ${used} / ${total}` : '';
      const server = mcpState.serverInfo ? `${mcpState.serverInfo.name}@${mcpState.serverInfo.version}` : '未知服务端';
      loadingToast.remove();
      toast('success', `连接正常（${server}）\n${[points, storage].filter(Boolean).join('\n') || '未返回积分/空间信息'}`, 12000);
    } catch (err) {
      loadingToast.remove();
      toast('error', `连接失败：${friendlyError(err)}`, 12000);
      warn('测试连接失败', err);
    }
  }

  function resetMcpSession() {
    mcpState.initialized = false;
    mcpState.sessionId = '';
    mcpState.serverInfo = null;
  }

  const magnetHash = (magnet) =>
    ((String(magnet || '').match(/urn:btih:([0-9a-z]+)/i) || [])[1] || '').toLowerCase();

  async function runImport({ button, row, cache, allowTokenPrompt }) {
    setButtonState(button, 'loading', '正在提交转存任务…');
    const loadingToast = toast('loading', '正在提交转存任务…', 0);
    try {
      let magnet = cache.value || magnetFromRow(row);
      if (!magnet) {
        const detailUrl = detailUrlFromRow(row);
        if (!detailUrl) throw new ImportError('NO_MAGNET', '这一行没有找到磁力链接');
        loadingToast.textContent = `${LOG_PREFIX} 行内无磁力链接，正在从详情页解析…`;
        magnet = await fetchMagnetFromDetail(detailUrl);
      }
      cache.value = magnet;

      const { taskId, data, message } = await submitMagnet(magnet);
      const title = taskId ? `任务 ${taskId}` : message || '已提交';
      setButtonState(button, 'success', title);
      loadingToast.remove();
      toast('success', `已转存到纸鸢网盘${taskId ? `\n任务 ID：${taskId}` : ''}`, 8000);
      // 日志只记录磁力 hash，不输出资源名与完整磁力，避免泄露浏览内容
      log('转存成功', { hash: magnetHash(magnet), taskId, data });
    } catch (err) {
      loadingToast.remove();
      // 未配置 Token：打开图形化设置面板，保存成功后自动重试一次
      if (err && err.code === 'NO_TOKEN' && allowTokenPrompt) {
        toast('info', '请先在设置面板中填写 MCP Token');
        if (await openSettingsPanel()) {
          toast('info', '设置已保存，正在重新提交转存…');
          return runImport({ button, row, cache, allowTokenPrompt: false });
        }
      }
      const message = String(err && err.message ? err.message : err);
      if (err && err.code === 'TOOL_ERROR' && isAlreadyExists(message)) {
        setButtonState(button, 'success', message);
        toast('info', `纸鸢侧已存在该任务：${message}`, 8000);
        log('已存在', magnetHash(cache.value));
        return;
      }
      setButtonState(button, 'error', message);
      toast('error', `转存失败：${friendlyError(err)}`, 12000);
      warn('转存失败', err);
    }
  }

  /**
   * 按钮挂载点。
   *
   * 关键：不要把按钮放进「磁鏈」列。真实 dmhy 该列宽由表头 width="10%" 固定，
   * 配合 table.tablesorter{table-layout:fixed} 与 td{overflow:hidden}，列宽完全不受
   * 内容影响，且该列是 nowrap。而它原有的磁力 / 迅雷 / PikPak 三个按钮已几乎占满列宽
   * （实测 1920 视口：列宽 194px、内容 194px，零余量）。文本按钮塞进去会溢出并被裁切，
   * 把排在末尾的迅雷 / PikPak 按钮挤出可视区。
   *
   * 标题列（td.title）是唯一既宽又允许换行（word-break:break-all，非 nowrap）的列，
   * 因此按钮统一挂在标题列末尾，换行时只增加行高，不会挤掉任何原有元素。
   */
  function buttonHostFromRow(row) {
    const titleCell = row.querySelector('td.title');
    if (titleCell) return titleCell;
    // 降级：没有标题列时，退回磁力图标所在单元格
    const anchor = row.querySelector(MAGNET_ANCHOR_SELECTOR);
    if (anchor && anchor.parentElement) return anchor.parentElement;
    const cells = row.querySelectorAll('td');
    return cells.length ? cells[cells.length - 1] : row;
  }

  function makeButton(row) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BTN_CLASS;
    button.dataset.state = 'idle';
    button.textContent = BTN_TEXT.idle;

    const cachedMagnet = { value: '' };

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.state === 'loading') return;
      if (button.dataset.state === 'success') {
        toast('info', `该资源已提交过转存${button.title ? `（${button.title}）` : ''}`);
        return;
      }
      await runImport({ button, row, cache: cachedMagnet, allowTokenPrompt: true });
    });

    // 复制按钮复用同一个磁力缓存：转存解析过的磁力，复制时不再重复请求
    const copyButton = makeCopyButton(row, cachedMagnet);

    // 两按钮包在同一个 inline-flex 组里，保证它们作为整体换行、不会被拆到两行
    const group = document.createElement('span');
    group.className = BTN_GROUP_CLASS;
    group.appendChild(button);
    group.appendChild(copyButton);
    buttonHostFromRow(row).appendChild(group);

    return button;
  }

  /** 复制按钮：把该行的磁力链接（规范化后的 40 位 hex 形式）写入剪贴板 */
  function makeCopyButton(row, cache) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = COPY_BTN_CLASS;
    button.dataset.state = 'idle';
    button.textContent = COPY_BTN_TEXT.idle;
    button.title = COPY_BTN_TITLE;

    let resetTimer = 0;
    const resetLater = (delay) => {
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => setCopyButtonState(button, 'idle'), delay);
    };

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.state === 'loading') return;
      clearTimeout(resetTimer);

      let magnet = cache.value || magnetFromRow(row);
      if (!magnet) {
        const detailUrl = detailUrlFromRow(row);
        if (!detailUrl) {
          setCopyButtonState(button, 'error', '这一行没有找到磁力链接');
          toast('error', '这一行没有找到磁力链接');
          resetLater(2500);
          return;
        }
        // 行内无磁力：与转存按钮一致，回退到详情页解析
        setCopyButtonState(button, 'loading', '正在从详情页解析磁力链接…');
        try {
          magnet = await fetchMagnetFromDetail(detailUrl);
        } catch (err) {
          setCopyButtonState(button, 'error', String((err && err.message) || err));
          toast('error', `复制失败：${friendlyError(err)}`, 10000);
          warn('复制磁力失败', err);
          resetLater(2500);
          return;
        }
      }
      cache.value = magnet;

      if (await copyText(magnet)) {
        setCopyButtonState(button, 'done', '已复制磁力链接');
        toast('info', '已复制磁力链接', 3000);
        // 只记录 hash，不输出完整磁力与资源名，避免泄露浏览内容
        log('已复制磁力链接', magnetHash(magnet));
        resetLater(1500);
      } else {
        setCopyButtonState(button, 'error', '复制失败，请手动选择复制');
        toast('error', '复制失败：浏览器拒绝了剪贴板写入，请手动选择复制', 10000);
        resetLater(2500);
      }
    });

    return button;
  }

  function friendlyError(err) {
    const message = String((err && err.message) || err || '未知错误');
    switch (err && err.code) {
      case 'NO_TOKEN':
        return '尚未配置 MCP Token：点击按钮会弹出设置面板，或用脚本菜单「脚本设置」填写（Token 仅保存在本机）';
      case 'TOKEN_INVALID':
        return `MCP Token 无效或已被重置（${message}）。请在纸鸢网盘重新生成 Token 后更新脚本配置`;
      case 'NO_MAGNET':
        return message;
      case 'NETWORK':
        return `${message}（需允许脚本访问 mybt.kiteyuan.info）`;
      case 'TIMEOUT':
        return `${message}，任务可能仍在服务端处理，可稍后在纸鸢网盘查看`;
      default:
        break;
    }
    if (isInviteRequired(message)) {
      return `纸鸢网盘要求先绑定邀请码后才能使用 MCP：${message}`;
    }
    if (/哈希|hash/i.test(message) && /长度|非法|invalid|length/i.test(message)) {
      return `${message}\n（脚本已把 Base32 哈希自动转成 40 位 hex；若仍失败，可在设置面板勾选「保留 tracker 参数」再试，或反馈该磁力）`;
    }
    if (isTokenInvalid(message)) {
      return `${message}（若为鉴权失败，请更新 MCP Token）`;
    }
    return message;
  }

  let topicListEl = null;
  let scanScheduled = false;

  function collectRows() {
    const container = topicListEl && document.body.contains(topicListEl) ? topicListEl : document;
    const rows = Array.from(container.querySelectorAll('tr'));
    return rows.filter((row) => !row.closest(`#${TOAST_ID}`));
  }

  function decorateRow(row) {
    if (row.querySelector(`.${BTN_CLASS}`)) return;

    // 行内磁力优先；没有磁力图标时，只要含详情页链接也提供按钮（点击时解析详情页）
    if (row.querySelector(MAGNET_ANCHOR_SELECTOR) || detailUrlFromRow(row)) {
      makeButton(row);
    }
  }

  function scanPage() {
    scanScheduled = false;
    const rows = collectRows();
    let count = 0;
    for (const row of rows) {
      const before = row.querySelector(`.${BTN_CLASS}`);
      decorateRow(row);
      if (!before && row.querySelector(`.${BTN_CLASS}`)) count += 1;
    }
    if (count > 0) log(`已为 ${count} 条资源添加转存按钮`);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => scanPage());
  }

  function observePage() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target && mutation.target.closest && mutation.target.closest(`#${TOAST_ID}`)) continue;
        scheduleScan();
        return;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ *
   * 菜单
   * ------------------------------------------------------------------ */

  function registerMenus() {
    GM_registerMenuCommand('脚本设置（Token / Endpoint）', () => {
      openSettingsPanel();
    });

    GM_registerMenuCommand('测试连接（查看积分与空间）', () => {
      runConnectionTest();
    });

    GM_registerMenuCommand('重新扫描页面资源', () => {
      scanPage();
      toast('info', '已重新扫描');
    });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function boot() {
    injectStyle();
    topicListEl = document.querySelector('#topic_list') || null;
    registerMenus();
    scanPage();
    observePage();
    const config = readConfig();
    if (!config.token) {
      toast(
        'info',
        '首次使用：点击任意「纸鸢」按钮会弹出设置面板，填入 MCP Token 即可；\n也可以用脚本菜单「脚本设置」。Token 只保存在本机存储中。\n「复制」按钮把该行磁力写入剪贴板，不需要 Token。',
        15000
      );
    }
    log('脚本已加载', {
      endpoint: config.endpoint,
      hasToken: Boolean(config.token),
      topicList: Boolean(topicListEl),
    });
  }

  boot();
})();
