#!/usr/bin/env node
/**
 * 通过 GitHub API 推送当前分支。
 *
 * 适用场景：本机 github.com 的 git 传输被重置（Connection was reset），
 * 或 git 被配置成走只读镜像（gh-proxy 之类）导致 push 失败，而 api.github.com 仍可访问。
 *
 * 用法：
 *   node tools/push-via-api.mjs
 *   node tools/push-via-api.mjs --repo owner/name --branch main --message "chore: update"
 *
 * 说明：
 * - 凭据取自 `gh auth token`，只发给 api.github.com，不经过 git 传输层
 * - 以当前 git 索引（git ls-files）中的文件为准，整体生成一个 commit（先 `git add -A` 再运行）
 * - 远端存在但本地没有的文件会被删除，保持仓库与本地一致
 */

import { execFileSync, execSync } from 'node:child_process';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const repoSlug = arg('repo', 'Elongou44/dmhy-kiteyuan-importer');
const branch = arg('branch', 'main');
const message = arg('message', `chore: sync ${new Date().toISOString().slice(0, 10)}`);
const [owner, repo] = repoSlug.split('/');

if (!owner || !repo) {
  console.error('--repo 需要是 owner/name 格式');
  process.exit(2);
}

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
if (!token) {
  console.error('未取到 gh token，请先执行 gh auth login');
  process.exit(2);
}

async function api(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'push-via-api',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* 保留原始文本 */
  }
  if (!res.ok) {
    throw new Error(`${method} ${url} -> HTTP ${res.status}: ${String(text).slice(0, 300)}`);
  }
  return data;
}

const files = execSync('git ls-files -z', { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
if (files.length === 0) {
  console.error('git 索引为空，先执行 git add -A');
  process.exit(2);
}
console.log(`待推送文件：${files.length} 个 -> ${repoSlug}#${branch}`);

/** 读取 git 索引中的内容（保持仓库内的换行符规范，不受 core.autocrlf 影响） */
function readIndexed(filePath) {
  return execFileSync('git', ['cat-file', 'blob', `:${filePath}`], { maxBuffer: 64 * 1024 * 1024 });
}

async function createBlobs() {
  const result = [];
  for (const filePath of files) {
    const content = readIndexed(filePath).toString('base64');
    const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, { content, encoding: 'base64' });
    result.push({ path: filePath, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  blob ${filePath}`);
  }
  return result;
}

/** 空仓库无法使用 Git Data API，先用 Contents API 落一个初始提交 */
async function bootstrapEmptyRepo() {
  let content;
  try {
    content = readIndexed('README.md').toString('base64');
  } catch {
    content = Buffer.from('# init\n').toString('base64');
  }
  await api('PUT', `/repos/${owner}/${repo}/contents/README.md`, {
    message: 'chore: init repository',
    content,
    branch,
  });
  console.log('检测到空仓库：已用 README.md 建立初始提交，继续推送全部文件');
}

let blobs;
try {
  blobs = await createBlobs();
} catch (err) {
  if (!/HTTP 409/.test(err.message)) throw err;
  await bootstrapEmptyRepo();
  blobs = await createBlobs();
}

const tree = await api('POST', `/repos/${owner}/${repo}/git/trees`, { tree: blobs });

let parents = [];
try {
  const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  parents = [ref.object.sha];
} catch (err) {
  if (!/HTTP 404/.test(err.message)) throw err;
  console.log('远端分支不存在，将创建首个提交');
}

const commit = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
  message,
  tree: tree.sha,
  parents,
});

if (parents.length === 0) {
  await api('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  try {
    await api('PATCH', `/repos/${owner}/${repo}`, { default_branch: branch });
  } catch (err) {
    console.warn(`设置默认分支失败（可忽略）：${err.message}`);
  }
} else {
  await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
}

console.log(`\n推送完成：https://github.com/${repoSlug}/commit/${commit.sha}`);
console.log(`仓库地址：https://github.com/${repoSlug}`);
