#!/usr/bin/env node
/**
 * 端到端测试：用 jsdom 加载真实脚本体（dmhy-kiteyuan.user.js），
 * 配合 Mock MCP 服务端验证按钮注入、MCP 调用、状态机与错误提示。
 *
 * 准备：cd test && npm install        （仅依赖 jsdom）
 * 运行：node test/e2e.mjs
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPT_CODE = readFileSync(path.join(ROOT, 'dmhy-kiteyuan.user.js'), 'utf8');
const MOCK_HTML = readFileSync(path.join(__dirname, 'mock-dmhy.html'), 'utf8');
const MOCK_SERVER = path.join(ROOT, 'tools', 'mock-mcp-server.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DETAIL_HTML = `<!DOCTYPE html><html><body>
  <h1>[红猪] Porco Rosso [720p]</h1>
  <a href="magnet:?xt=urn:btih:3333333333333333333333333333333333333333&amp;dn=Porco%20from%20detail" class="download-arrow arrow-magnet">磁力</a>
</body></html>`;

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok: Boolean(ok), extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  :: ${extra}` : ''}`);
}

async function waitFor(predicate, timeout = 4000, interval = 25) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await sleep(interval);
  }
  return false;
}

async function startMockServer(mode, port) {
  const child = spawn(process.execPath, [MOCK_SERVER, '--port', String(port), '--mode', mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => console.error('[mock stderr]', String(d).trim()));
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/v1/mcp`, { method: 'GET' });
      return child;
    } catch {
      await sleep(50);
    }
  }
  throw new Error('Mock 服务端启动超时');
}

/** 直接以 MCP 协议查询 mock 服务端上的任务列表，用于核对转存的 magnet 内容 */
async function fetchTasks(port, token, mode = 'normal') {
  const call = (method, params, id) =>
    fetch(`http://127.0.0.1:${port}/api/v1/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }).then((r) => r.json());

  if (mode === 'stricty') await call('initialize', { protocolVersion: '2025-11-25', capabilities: {} }, 1);
  const res = await call('tools/call', { name: 'magnet_task_list', arguments: {} }, 2);
  return res?.result?.structuredContent?.items || [];
}

async function createHarness({ mode, port, token = 'test-token', gm4 = false, extraStore = {}, clipboardApi = 'gm3' }) {
  const child = await startMockServer(mode, port);
  const store = new Map([
    ['ky_mcp_endpoint', `http://127.0.0.1:${port}/api/v1/mcp`],
    ['ky_mcp_protocol_version', '2025-11-25'],
    ['ky_mcp_timeout_ms', 15000],
  ]);
  if (token !== null) store.set('ky_mcp_token', token);
  for (const [key, value] of Object.entries(extraStore)) store.set(key, value);

  const dom = new JSDOM(MOCK_HTML, {
    url: 'https://share.dmhy.org/topics/list?keyword=%E7%BA%A2%E7%8C%AA',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const counters = { detailFetches: 0, totalRequests: 0 };
  const clipboard = [];

  window.GM_getValue = (key, fallback) => (store.has(key) ? store.get(key) : fallback);
  window.GM_setValue = (key, value) => store.set(key, value);
  window.GM_registerMenuCommand = () => {};

  const performRequest = (opts) => {
    counters.totalRequests += 1;
    const url = String(opts.url || '');
    if (url.includes('/topics/view/')) {
      counters.detailFetches += 1;
      return Promise.resolve({ status: 200, responseText: DETAIL_HTML, responseHeaders: '' });
    }
    return fetch(url, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.data }).then(async (res) => {
      const text = await res.text();
      const headerLines = [];
      res.headers.forEach((value, key) => headerLines.push(`${key}: ${value}`));
      return {
        status: res.status,
        responseText: text,
        responseHeaders: headerLines.join('\r\n'),
        finalUrl: url,
        readyState: 4,
      };
    });
  };

  if (gm4) {
    // 只提供 GM4 风格 API，验证脚本的回退分支
    window.GM = { xmlHttpRequest: (params) => performRequest(params) };
  } else {
    window.GM_xmlhttpRequest = (opts) => {
      performRequest(opts)
        .then((res) => opts.onload?.(res))
        .catch((err) => opts.onerror?.({ error: err.message, status: 0 }));
    };
  }

  // 剪贴板 API 形态：gm3 = GM_setClipboard；gm4 = GM.setClipboard（返回 Promise）；
  // none = 两者都不提供，用于验证回退到 Web API 及最终的失败提示
  const recordClipboard = (text) => { clipboard.push(String(text)); };
  if (clipboardApi === 'gm3') {
    window.GM_setClipboard = recordClipboard;
  } else if (clipboardApi === 'gm4') {
    window.GM = Object.assign(window.GM || {}, { setClipboard: async (text) => recordClipboard(text) });
  }

  window.eval(SCRIPT_CODE);
  await sleep(120);

  return {
    dom,
    window,
    counters,
    clipboard,
    store,
    close: () => child.kill(),
  };
}

async function scenarioHappyPath() {
  const harness = await createHarness({ mode: 'normal', port: 8787 });
  const { window, counters } = harness;
  try {
    const buttons = [...window.document.querySelectorAll('.ky-import-btn')];
    check('normal: 注入按钮数量为 6（含无磁力行、重复磁力行与 Base32 磁力行）', buttons.length === 6, `实际 ${buttons.length}`);

    // 回归守卫：真实 dmhy 的「磁鏈」列宽由表头 width="10%" + table-layout:fixed 固定，
    // 且该列 nowrap / overflow:hidden，原有磁力 / 迅雷 / PikPak 三个按钮已占满列宽。
    // 按钮一旦插进该列就会溢出并把排在末尾的原按钮挤出可视区，因此必须挂在标题列。
    check(
      'normal: 按钮挂在标题列（td.title）末尾',
      (() => {
        const row = window.document.querySelectorAll('#topic_list tbody tr')[0];
        const group = row.querySelector('.ky-btn-group');
        return Boolean(group) && group.parentElement === row.querySelector('td.title');
      })()
    );
    check(
      'normal: 「磁鏈」列原有元素未被改动或插入',
      (() => {
        const rows = [...window.document.querySelectorAll('#topic_list tbody tr')];
        return rows.every((row) => {
          const magnetCell = row.querySelector('a.arrow-magnet')?.closest('td')
            || [...row.children].find((td) => td.querySelector('.download-xl'));
          if (!magnetCell) return true;
          const hasOurButton = magnetCell.querySelector('.ky-import-btn, .ky-copy-btn, .ky-btn-group');
          const originalAnchors = magnetCell.querySelectorAll('a').length;
          return !hasOurButton && originalAnchors === 3;
        });
      })()
    );
    check(
      'normal: 转存按钮与复制按钮同处一个按钮组',
      (() => {
        const row = window.document.querySelectorAll('#topic_list tbody tr')[0];
        const group = row.querySelector('.ky-btn-group');
        const kids = group ? [...group.children] : [];
        return kids.length === 2
          && kids[0].classList.contains('ky-import-btn')
          && kids[1].classList.contains('ky-copy-btn');
      })()
    );

    buttons[0].click();
    const okFirst = await waitFor(() => buttons[0].dataset.state === 'success');
    check('normal: 行内磁力转存成功', okFirst, `state=${buttons[0].dataset.state}`);
    check('normal: 成功后按钮展示任务 ID', /mock-task-/.test(buttons[0].title), buttons[0].title);

    buttons[1].click();
    await waitFor(() => buttons[1].dataset.state === 'success');
    check('normal: 第二条资源转存成功', buttons[1].dataset.state === 'success');

    // 第 3 行：没有磁力链接，应回退到详情页解析
    buttons[2].click();
    const okThird = await waitFor(() => buttons[2].dataset.state === 'success');
    check('normal: 无磁力行回退详情页解析成功', okThird, `state=${buttons[2].dataset.state}`);
    check('normal: 触发了详情页请求', counters.detailFetches === 1, `次数 ${counters.detailFetches}`);

    const tasks = await fetchTasks(8787, 'test-token');
    const hashes = tasks.map((t) => t.magnet_hash).sort();
    const expected = [
      '1111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222',
      '3333333333333333333333333333333333333333',
    ];
    check('normal: 服务端收到 3 条转存任务且 hash 正确', hashes.length === 3 && hashes.every((h, i) => h === expected[i]), JSON.stringify(hashes));

    buttons[0].click();
    await sleep(120);
    const tasksAfterRepeatClick = await fetchTasks(8787, 'test-token');
    check('normal: 已成功的按钮重复点击不会重复提交', tasksAfterRepeatClick.length === 3, `任务数 ${tasksAfterRepeatClick.length}`);

    // 第 5 行与第 1 行磁力相同：服务端返回 items[].error = task already exists
    buttons[4].click();
    const okDup = await waitFor(() => buttons[4].dataset.state === 'success');
    check('normal: 服务端「已存在」按已完成处理而非报错', okDup, `state=${buttons[4].dataset.state}`);
    const dupToast = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('normal: 重复转存提示服务端原因', /already exists/i.test(dupToast), dupToast.slice(-100));
    check('normal: 重复转存未新增任务', (await fetchTasks(8787, 'test-token')).length === 3);
  } finally {
    harness.close();
  }
}

async function scenarioSse() {
  const harness = await createHarness({ mode: 'sse', port: 8788 });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    const ok = await waitFor(() => button.dataset.state === 'success');
    check('sse: text/event-stream 响应可正确解析', ok, `state=${button.dataset.state}`);
  } finally {
    harness.close();
  }
}

async function scenarioRequiresHandshake() {
  const harness = await createHarness({ mode: 'stricty', port: 8789 });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    const ok = await waitFor(() => button.dataset.state === 'success');
    check('stricty: 服务端要求握手时自动 initialize 并重试成功', ok, `state=${button.dataset.state}`);
  } finally {
    harness.close();
  }
}

async function scenarioInviteRequired() {
  const harness = await createHarness({ mode: 'unbound', port: 8790 });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    await waitFor(() => button.dataset.state === 'error');
    const toastText = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('unbound: 未绑定邀请码时按钮进入失败态', button.dataset.state === 'error');
    check('unbound: 提示文案包含「邀请码」', /邀请码/.test(toastText), toastText.slice(0, 120));
  } finally {
    harness.close();
  }
}

async function scenarioTokenInvalid() {
  const harness = await createHarness({ mode: 'expired', port: 8791 });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    await waitFor(() => button.dataset.state === 'error');
    const toastText = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('expired: Token 失效时进入失败态', button.dataset.state === 'error');
    check('expired: 提示文案提示 Token 无效', /Token\s*无效/.test(toastText), toastText.slice(0, 120));
  } finally {
    harness.close();
  }
}

async function scenarioBusinessErrorText() {
  const harness = await createHarness({ mode: 'biz', port: 8792 });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    await waitFor(() => button.dataset.state === 'error');
    const toastText = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('biz: 无 isError 标记但文案为失败时也能识别', button.dataset.state === 'error');
    check('biz: 透出服务端失败原因', /积分不足/.test(toastText), toastText.slice(0, 120));
  } finally {
    harness.close();
  }
}

async function scenarioManualRetry() {
  const harness = await createHarness({ mode: 'flaky', port: 8793 });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    await waitFor(() => button.dataset.state === 'error');
    check('flaky: 服务端临时错误时进入失败态可重试', button.dataset.state === 'error');

    button.click();
    await waitFor(() => button.dataset.state === 'error');
    check('flaky: 第二次失败仍可重试', button.dataset.state === 'error');

    button.click();
    const ok = await waitFor(() => button.dataset.state === 'success');
    check('flaky: 第三次点击转存成功', ok, `state=${button.dataset.state}`);
  } finally {
    harness.close();
  }
}

async function scenarioDeepError() {
  const harness = await createHarness({ mode: 'deep', port: 8794 });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    await waitFor(() => button.dataset.state === 'error');
    const toastText = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('deep: items[].error 形式（无 isError）也能识别为失败', button.dataset.state === 'error');
    check('deep: 透出服务端错误原因', /invalid magnet link/.test(toastText), toastText.slice(0, 120));
  } finally {
    harness.close();
  }
}

async function scenarioGm4Api() {
  const harness = await createHarness({ mode: 'normal', port: 8795, gm4: true });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    const ok = await waitFor(() => button.dataset.state === 'success');
    check('gm4: 只提供 GM.xmlHttpRequest 时也能转存', ok, `state=${button.dataset.state}`);
  } finally {
    harness.close();
  }
}

async function scenarioTokenNotConfigured() {
  // 情况一：未配置 Token，点击按钮弹出设置面板，用户取消
  const cancelHarness = await createHarness({ mode: 'normal', port: 8796, token: null });
  try {
    const { window } = cancelHarness;
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    const panelOpened = await waitFor(() => window.document.getElementById('ky-settings-panel'));
    check('no-token: 未配置时点击按钮弹出图形化设置面板', Boolean(panelOpened));
    const startupToast = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('no-token: 启动时提示去配置 Token', /首次使用/.test(startupToast), startupToast.slice(0, 50));

    window.document.getElementById('ky-set-cancel').click();
    await waitFor(() => button.dataset.state === 'error');
    const toastText = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('no-token: 取消后按钮失败并给出引导', /尚未配置 MCP Token/.test(toastText), toastText.slice(-80));
    check('no-token: 取消后面板关闭', !window.document.getElementById('ky-settings-panel'));
  } finally {
    cancelHarness.close();
  }

  // 情况二：在面板里填写 Token 并保存 → 自动重试转存
  const fillHarness = await createHarness({ mode: 'normal', port: 8797, token: null });
  try {
    const { window, store } = fillHarness;
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    await waitFor(() => window.document.getElementById('ky-settings-panel'));

    const tokenInput = window.document.getElementById('ky-set-token');
    check('no-token: 面板 Token 输入框初始为空', tokenInput.value === '');
    check(
      'no-token: 面板 Endpoint 预填当前配置',
      window.document.getElementById('ky-set-endpoint').value === 'http://127.0.0.1:8797/api/v1/mcp'
    );
    check('no-token: Token 输入框默认掩码显示', tokenInput.type === 'password');

    tokenInput.value = 'filled-token';
    window.document.getElementById('ky-set-save').click();
    const ok = await waitFor(() => button.dataset.state === 'success');
    check('no-token: 面板保存后自动重试转存成功', ok, `state=${button.dataset.state}`);
    check('no-token: Token 只写入本机脚本存储', store.get('ky_mcp_token') === 'filled-token');
    check('no-token: 保存后面板自动关闭', !window.document.getElementById('ky-settings-panel'));
  } finally {
    fillHarness.close();
  }
}

async function scenarioBase32Hash() {
  const harness = await createHarness({ mode: 'normal', port: 8798 });
  const { window } = harness;
  try {
    const buttons = [...window.document.querySelectorAll('.ky-import-btn')];
    const button = buttons[5]; // 第 6 行：Base32 磁力 + 一长串 tracker
    button.click();
    const ok = await waitFor(() => button.dataset.state === 'success');
    check('base32: 列表页 Base32 磁力可直接一键转存（无需进详情页）', ok, `state=${button.dataset.state}`);

    const tasks = await fetchTasks(8798, 'test-token');
    check(
      'base32: 哈希已转换为 40 位 hex 提交',
      tasks[0]?.magnet_hash === '4046537af0df5a70b2f7a73cb0ea2704efecd2ae',
      JSON.stringify(tasks[0] || {})
    );
    check(
      'base32: 默认去掉 tr 跟踪器、保留 dn',
      Boolean(tasks[0]) && !tasks[0].source_url.includes('tr=') && tasks[0].source_url.includes('dn='),
      (tasks[0] || {}).source_url
    );
  } finally {
    harness.close();
  }
}

async function scenarioKeepTrackers() {
  const harness = await createHarness({
    mode: 'normal',
    port: 8799,
    extraStore: { ky_magnet_keep_trackers: true },
  });
  const { window } = harness;
  try {
    const button = window.document.querySelectorAll('.ky-import-btn')[5];
    button.click();
    const ok = await waitFor(() => button.dataset.state === 'success');
    check('keep-trackers: 勾选保留后可转存成功', ok, `state=${button.dataset.state}`);
    const tasks = await fetchTasks(8799, 'test-token');
    check(
      'keep-trackers: 保留 tr 参数且哈希仍为 hex',
      Boolean(tasks[0]) && tasks[0].source_url.includes('tr=') && tasks[0].source_url.includes('4046537af0df5a70b2f7a73cb0ea2704efecd2ae'),
      (tasks[0] || {}).source_url
    );
  } finally {
    harness.close();
  }
}

async function scenarioHashLengthError() {
  const harness = await createHarness({ mode: 'hashlen', port: 8800 });
  const { window } = harness;
  try {
    const button = window.document.querySelector('.ky-import-btn');
    button.click();
    await waitFor(() => button.dataset.state === 'error');
    const toastText = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('hashlen: 服务端报哈希非法时按钮失败', button.dataset.state === 'error');
    check('hashlen: 提示已自动转 Base32→hex 并给出排查建议', /Base32/.test(toastText), toastText.slice(-160));
  } finally {
    harness.close();
  }
}

/**
 * 复制按钮：不依赖 MCP 配置（token 置空），点击即把规范化后的磁力写入剪贴板。
 * 用「无 Token」环境运行，可同时验证复制不会触发任何转存任务。
 */
async function scenarioCopyMagnet() {
  const harness = await createHarness({ mode: 'normal', port: 8801, token: null });
  const { window, clipboard } = harness;
  try {
    const importButtons = [...window.document.querySelectorAll('.ky-import-btn')];
    const copyButtons = [...window.document.querySelectorAll('.ky-copy-btn')];

    check('copy: 转存按钮初始文案为「纸鸢」', importButtons.length === 6 && importButtons.every((b) => b.textContent === '纸鸢'), importButtons[0]?.textContent);
    check('copy: 每行转存按钮后都跟一个复制按钮', copyButtons.length === importButtons.length, `转存 ${importButtons.length} / 复制 ${copyButtons.length}`);
    check(
      'copy: 复制按钮紧跟在转存按钮之后',
      importButtons.length > 0 && importButtons.every((btn, i) => btn.nextElementSibling === copyButtons[i])
    );
    check('copy: 复制按钮初始文案为「复制」', copyButtons[0]?.textContent === '复制', copyButtons[0]?.textContent);

    // 第 1 行：行内磁力 → 直接复制规范化后的磁力
    copyButtons[0].click();
    const okFirst = await waitFor(() => clipboard.length === 1);
    check('copy: 行内磁力可直接复制', okFirst, JSON.stringify(clipboard));
    check(
      'copy: 复制内容为规范化磁力（40 位 hex + dn）',
      clipboard[0] === 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Porco%20Rosso',
      clipboard[0]
    );
    // 文案切换在 copyText 的 await 之后，轮询等待而非依赖微任务时序
    const doneShown = await waitFor(() => copyButtons[0].textContent === '已复制', 1000);
    check('copy: 复制成功后按钮短暂显示「已复制」', doneShown, copyButtons[0].textContent);
    check('copy: 复制不会改变转存按钮状态', importButtons[0].dataset.state === 'idle', importButtons[0].dataset.state);

    // 第 3 行：无行内磁力 → 回退详情页解析后复制
    copyButtons[2].click();
    const okThird = await waitFor(() => clipboard.length === 2);
    check('copy: 无磁力行回退详情页解析后复制', okThird, JSON.stringify(clipboard));
    check(
      'copy: 详情页磁力被复制',
      clipboard[1] === 'magnet:?xt=urn:btih:3333333333333333333333333333333333333333&dn=Porco%20from%20detail',
      clipboard[1]
    );

    // 第 6 行：Base32 磁力 → 复制为 40 位 hex
    copyButtons[5].click();
    await waitFor(() => clipboard.length === 3);
    check(
      'copy: Base32 磁力复制为 40 位 hex',
      Boolean(clipboard[2]) && clipboard[2].startsWith('magnet:?xt=urn:btih:4046537af0df5a70b2f7a73cb0ea2704efecd2ae&dn='),
      clipboard[2]
    );

    const reset = await waitFor(() => copyButtons[0].textContent === '复制', 3000);
    check('copy: 状态自动复位为「复制」', reset, copyButtons[0].textContent);

    const tasks = await fetchTasks(8801, 'test-token');
    check('copy: 复制不会向纸鸢提交任何转存任务', tasks.length === 0, `任务数 ${tasks.length}`);
  } finally {
    harness.close();
  }
}

/**
 * 剪贴板 API 兼容性：GM4 风格的 GM.setClipboard，以及两者都缺失时的降级失败提示。
 * jsdom 中 navigator.clipboard 与 document.execCommand 均不存在，因此 clipboardApi='none'
 * 会真实走完三级降级并落到失败分支。
 */
async function scenarioCopyClipboardFallback() {
  const gm4Harness = await createHarness({ mode: 'normal', port: 8802, token: null, clipboardApi: 'gm4' });
  try {
    const { window, clipboard } = gm4Harness;
    const copyButton = window.document.querySelector('.ky-copy-btn');
    copyButton.click();
    const ok = await waitFor(() => clipboard.length === 1);
    check('copy-gm4: 仅提供 GM.setClipboard 时也能复制', ok, JSON.stringify(clipboard));
    check(
      'copy-gm4: 复制内容正确',
      clipboard[0] === 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Porco%20Rosso',
      clipboard[0]
    );
  } finally {
    gm4Harness.close();
  }

  const noneHarness = await createHarness({ mode: 'normal', port: 8803, token: null, clipboardApi: 'none' });
  try {
    const { window, clipboard } = noneHarness;
    const copyButton = window.document.querySelector('.ky-copy-btn');
    copyButton.click();
    const failed = await waitFor(() => copyButton.dataset.state === 'error');
    check('copy-fallback: 无可用剪贴板 API 时按钮进入失败态', failed, `state=${copyButton.dataset.state}`);
    check('copy-fallback: 失败态文案为「重试」', copyButton.textContent === '重试', copyButton.textContent);
    check('copy-fallback: 未写入任何内容', clipboard.length === 0, JSON.stringify(clipboard));
    const toastText = window.document.getElementById('ky-toast-host')?.textContent || '';
    check('copy-fallback: 提示用户手动复制', /手动/.test(toastText), toastText.slice(-120));
    const reset = await waitFor(() => copyButton.dataset.state === 'idle', 4000);
    check('copy-fallback: 失败后仍会复位为「复制」', reset, copyButton.textContent);
  } finally {
    noneHarness.close();
  }
}

async function main() {
  await scenarioHappyPath();
  await scenarioSse();
  await scenarioRequiresHandshake();
  await scenarioInviteRequired();
  await scenarioTokenInvalid();
  await scenarioBusinessErrorText();
  await scenarioManualRetry();
  await scenarioDeepError();
  await scenarioGm4Api();
  await scenarioTokenNotConfigured();
  await scenarioBase32Hash();
  await scenarioKeepTrackers();
  await scenarioHashLengthError();
  await scenarioCopyMagnet();
  await scenarioCopyClipboardFallback();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项断言，失败 ${failed.length} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试运行异常：', err);
  process.exit(1);
});
