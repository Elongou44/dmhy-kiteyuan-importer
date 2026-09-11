# dmhy → 纸鸢网盘 一键转存

在动漫花园（`share.dmhy.org`）资源列表页的**每条资源旁**加一个「纸鸢转存」按钮，点击即通过纸鸢网盘的 **MCP（Streamable HTTP）** 接口把该资源的磁力链接转存到纸鸢网盘。

- 目标页面：`https://share.dmhy.org/topics/list?keyword=...`（`/topics/list*` 全部列表页）
- MCP Endpoint：`https://mybt.kiteyuan.info/api/v1/mcp`
- 调用工具：`magnet_task_add`

## 目录结构

```text
dmhy-kiteyuan-importer/
├── dmhy-kiteyuan.user.js         # 用户脚本本体（脚本猫 / Tampermonkey 通用）
├── tools/
│   ├── mcp-probe.mjs             # 只读协议探测器（initialize / tools/list，不会转存）
│   └── mock-mcp-server.mjs       # 本地 Mock MCP 服务端（零依赖，离线联调用）
├── test/
│   ├── mock-dmhy.html            # 与真实 dmhy 同构的模拟列表页（浏览器手动联调）
│   ├── e2e.mjs                   # 端到端测试：jsdom 执行真实脚本体 + Mock 服务端
│   ├── package.json
│   └── package-lock.json
├── .github/workflows/test.yml    # CI：push / PR 自动跑端到端测试
├── .gitignore
├── LICENSE                       # MIT
└── README.md
```

## 安装

1. 打开脚本猫（或 Tampermonkey）的**新建脚本**页面。
2. 把 `dmhy-kiteyuan.user.js` 的全部内容粘贴进去并保存。
3. 打开 `https://share.dmhy.org/topics/list?keyword=红猪`，每条资源旁会出现「纸鸢转存」按钮。

**脚本内不含任何 Token**——Token 属于隐私凭据，只保存在本机脚本存储中。首次使用时点击任意「纸鸢转存」按钮，按弹出框提示填写即可（Token 在纸鸢网盘 MCP 页面生成，只能明文查看一次）。

## 使用

| 操作 | 说明 |
|------|------|
| 首次使用 | 点击任意「纸鸢转存」按钮会弹出**图形化设置面板**，填入 MCP Token 并保存后自动重试转存 |
| 点击「纸鸢转存」 | 取出该行磁力链接并调用 `magnet_task_add`，成功后按钮变绿并显示任务 ID |
| 按钮变红「重试转存」 | 点击可重新提交（服务端临时错误、网络抖动等） |
| 行内没有磁力图标 | 自动回退到该资源的详情页解析磁力链接后再转存 |
| 资源已被转存过 | 纸鸢侧返回「已存在」时会识别为已完成，不会报错 |

### 脚本内的设置面板

点任意转存按钮（未配置时）或脚本菜单「脚本设置（Token / Endpoint）」即可打开：

- **MCP Token**：默认掩码显示，可点「显示」核对；留空会拒绝保存
- **MCP Endpoint**：预填当前值，默认 `https://mybt.kiteyuan.info/api/v1/mcp`
- **保留 tracker 参数（tr=…）**：默认不勾选，说明见下节「磁力哈希：Base32 → hex 自动转换」
- **保存** / **保存并测试连接**（保存后立即调用只读的 `storage_get_status` 验证连通性）
- 支持 `Esc`、点击遮罩、取消按钮关闭；保存成功后写入本机存储

脚本菜单（脚本猫面板 / Tampermonkey 菜单）提供：

- **脚本设置（Token / Endpoint）**：打开上述面板
- **测试连接（查看积分与空间）**：调用只读工具 `storage_get_status`，用于确认 Token 与网络是否正常
- **重新扫描页面资源**：页面内容被动态替换后手动重扫

> 脚本猫 / Tampermonkey 的扩展面板里也能看到该脚本的 GM 存储值（键名 `ky_mcp_token`、`ky_mcp_endpoint`）并直接编辑，但那需要记住键名，日常用脚本内的设置面板更直观；两者改的是同一份数据。

## 实现要点

### 为什么必须走 `GM_xmlhttpRequest`

脚本运行在 `share.dmhy.org`，而 MCP 服务在 `mybt.kiteyuan.info`。页面内 `fetch`/`XHR` 会被浏览器 CORS 拦截，因此跨域请求统一走 `GM_xmlhttpRequest`（脚本猫、Tampermonkey 均支持），并在脚本头声明 `@connect mybt.kiteyuan.info`。

跨域请求同时兼容 `GM_xmlhttpRequest` 与 GM4 风格的 `GM.xmlHttpRequest`；配置读取优先使用 `GM_getValue`/`GM_setValue`，若脚本管理器未注入同步 API 则回退 `localStorage`，两种情况都只保存于本机。

### 隐私信息（Token）如何处理

- 脚本源码中**不包含任何 Token**，可安全分享、备份、上传仓库
- Token 通过运行时配置写入脚本管理器的本机存储（键名 `ky_mcp_token`），仅在调用 MCP 时作为 `Authorization` 头发往纸鸢网盘 Endpoint
- 日志经过脱敏：控制台只输出磁力 **hash** 与任务 ID，不输出资源名、完整磁力或 Token
- 随时可在纸鸢网盘重置 Token，再用脚本菜单更新（旧 Token 立即失效）

### 磁力哈希：Base32 → hex 自动转换（重要）

dmhy 给出的 BTIH 大多是 **Base32**（32 位，如 `IBDFG6XQ35NHBMXXU46LB2RHATX6ZUVO`），而纸鸢网盘只接受 **40 位 hex**，直接提交会返回「磁力哈希长度非法」。

脚本在本地完成转换，**不需要再点进详情页手动挑链接**：

```text
dmhy 原始：magnet:?xt=urn:btih:IBDFG6XQ35NHBMXXU46LB2RHATX6ZUVO&dn=…&tr=…（一长串 tracker）
                                    ↓ 本地 Base32 → hex
提交给纸鸢：magnet:?xt=urn:btih:4046537af0df5a70b2f7a73cb0ea2704efecd2ae&dn=…
```

- 已经是 40 位 hex 的链接不会改动哈希
- 默认丢弃 `tr=` 跟踪器参数（纸鸢自行处理 tracker，原始链接常上千字符），只保留 `dn` 作为名称
- 想原样保留 tracker 时，在设置面板勾选「保留 tracker 参数」，此时仍会把哈希替换成 hex
- 若服务端仍报哈希相关错误，脚本会额外给出排查提示

### MCP 调用流程（尽可能少发请求）

真实服务端（`Golang-MagnetFlow 0.1.0`）实测行为：

- 响应为纯 `application/json`，**不返回 `Mcp-Session-Id`**（无状态）
- `notifications/initialized` 返回 `202`
- `tools/call` 结果同时带 `result.content[].text` 与 `result.structuredContent`
- **业务成功与失败都不设 `result.isError`**，结构与错误都在 `structuredContent.items` 里：
  - 成功（`magnet_task_list`）：`{ items: [{ id, magnet_hash, source_url, file_id, file_name, status, ... }] }`
  - 失败（`task_get_status` 传不存在的任务）：`{ items: [{ error: "invalid task_id", task_id: "..." }] }`，HTTP 仍是 200

  所以脚本对返回数据做**深层字段查找**（`items[].error` 判失败、`items[].id` 取任务 ID），而不是只看 `isError`，避免把失败当成转存成功。

因此脚本默认**直接发 `tools/call`（一次请求完成转存）**；只有在服务端返回 “session/initialize” 类错误时，才补做 `initialize` + `notifications/initialized` 并重试一次。响应解析同时兼容纯 JSON、JSON 数组和 SSE（`text/event-stream`）三种形态。

### 错误提示

| 场景 | 表现 |
|------|------|
| Token 失效 / 被重置（HTTP 401、403） | 提示重新生成 Token 并更新配置 |
| 未绑定邀请码 | 提示「纸鸢网盘要求先绑定邀请码后才能使用 MCP」 |
| 网络失败 / 超时 | 提示网络与超时（超时会提醒任务可能仍在服务端处理） |
| 服务端返回失败文案但未置 `isError` | 通过业务字段与失败文案兜底识别，避免把拒绝当成功 |
| 磁力哈希长度非法 | 已自动把 Base32 转成 40 位 hex；若仍失败会提示勾选「保留 tracker」或反馈该磁力 |

## 离线联调与测试

### 1. 手动联调（浏览器）

```bash
node tools/mock-mcp-server.mjs          # 启动 Mock，监听 http://127.0.0.1:8787/api/v1/mcp
npx serve -l 8788 .                     # 或 python -m http.server 8788
```

访问 `http://127.0.0.1:8788/test/mock-dmhy.html`（脚本头已 `@match http://127.0.0.1:8788/*`），
在脚本菜单把 Endpoint 改为 `http://127.0.0.1:8787/api/v1/mcp`，再点击任意按钮、在弹出框里填任意非空 Token（如 `mock-token`），即可完整走通转存流程。

Mock 支持以下模式（`--mode` 或环境变量 `MOCK_MODE`）：

| 模式 | 行为 |
|------|------|
| `normal` | 正常返回（默认），`items[].id` 风格结构，重复磁力返回 `items[].error` |
| `sse` | `tools/call` 用 `text/event-stream` 返回 |
| `unbound` | 返回未绑定邀请码错误（`result.isError`） |
| `biz` | 只返回失败文案，不置 `isError` |
| `deep` | 模拟真实服务端：失败在 `items[].error` 且不置 `isError` |
| `expired` | 一律返回 401 |
| `stricty` | 必须先 `initialize`，否则返回 `-32002` |
| `flaky` | 前 2 次 `tools/call` 返回 -32603 错误，第 3 次成功 |

### 2. 自动化端到端测试

```bash
cd test && npm install && npm test
```

测试会用 jsdom 加载并执行真实的 `dmhy-kiteyuan.user.js`（注入 `GM_*` 桩），覆盖 43 项断言：
按钮注入位置与数量、行内磁力转存、成功后展示任务 ID、无磁力行回退详情页、重复磁力按「已存在」处理、**Base32 磁力自动转 hex 并去掉 tr 参数**、保留 tracker 开关、哈希非法时的排查提示、SSE 解析、握手回退、邀请码/Token 失效/业务错误/深层 error 提示、未配置 Token 时弹出设置面板并取消/保存/自动重试、重复点击不重复提交、失败后可重试、仅 GM4 风格 API 时的兼容路径等。

### 3. 只读协议探测

```bash
node tools/mcp-probe.mjs --token <你的 MCP Token>
node tools/mcp-probe.mjs --token <你的 MCP Token> --call storage_get_status
```

只执行 `initialize` / `tools/list` / 指定的只读工具，**不会创建转存任务**。用于确认 Token 是否有效、服务端工具列表是否变化。

## 常见问题

**页面没有出现按钮？**
确认脚本已启用、当前地址匹配 `/topics/list*`；若页面表格是动态替换的，用菜单「重新扫描页面资源」。也可打开控制台查看 `[dmhy→纸鸢]` 日志。

**提示未绑定邀请码？**
先在纸鸢网盘完成邀请码绑定，MCP 调用才会被服务端接受。

**Token 填错了 / 重置后不生效？**
用脚本菜单「脚本设置（Token / Endpoint）」重新填写即可，旧 Token 会立即失效。

**Token 存在哪里？会和脚本一起泄露吗？**
不存在脚本里。它保存在脚本管理器的本机存储（键名 `ky_mcp_token`），源码、日志、页面展示中都不会出现，可放心分享脚本。

**为什么按钮在“磁力”图标旁边而不是标题后面？**
按钮紧贴该资源的磁力链接插入，便于确认转存的就是这一条资源；无磁力图标时（少数只有种子的资源）会挂在行尾。

**能一次导入整页吗？**
当前只提供逐条按钮（按需求实现）。如需批量，可自行在控制台循环点击，或提需求扩展。

## 开源与发布

本仓库**不含任何 Token / 账号信息**（Token 只在运行时存于本机脚本存储），可以直接公开：

- **用户脚本仓库**：脚本头 `@namespace` / `@author` 目前指向 `github.com/Elongou44/dmhy-kiteyuan-importer`，换成你的实际仓库地址即可
- **Greasy Fork**：直接提交 `dmhy-kiteyuan.user.js`（`@name` / `@description` / `@license` / `@match` / `@connect` 均已就绪，脚本零依赖）
- **CI**：`.github/workflows/test.yml` 会在 push / PR 时运行 43 项端到端断言，不需要任何凭据

发布前自检：

```bash
# 不应命中任何 64 位 hex（MCP Token 形态）；ky_mcp_token 只是本机存储键名，不是凭据
grep -rnE "[0-9a-f]{64}" dmhy-kiteyuan.user.js README.md tools/ test/
```

## 安全与免责声明

- 脚本源码不含任何 Token，可安全分享与备份。Token 仅保存在本机脚本存储（脚本猫 / Tampermonkey 的脚本级存储，或管理器未注入同步 API 时的 `localStorage`），只在调用 MCP 时由 `GM_xmlhttpRequest` 发往纸鸢网盘 MCP Endpoint；如怀疑泄露，在纸鸢网盘重置 Token 即可立刻失效。
- 本项目与动漫花园、纸鸢网盘官方均无关联，仅供个人学习与自用；请遵守目标站点的服务条款，控制调用频率，不要对站点造成压力。因使用本脚本导致的账号、积分或数据问题由使用者自行承担。

## License

MIT
