#!/usr/bin/env node
/** 通过 GitHub Git Data API 上传整个目录（绕过 git push 网络问题） */
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.GH_TOKEN || '';
if (!TOKEN) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(1); }
const OWNER = process.env.GH_OWNER || '1234567461';
const REPO = process.env.GH_REPO || process.env.REPO || 'ciyun-tv';
const BRANCH = process.env.GH_BRANCH || 'main';
const ROOT = process.env.PUBLISH_ROOT || '/workspace/cinema';

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'data', '.codebuddy', 'dist', 'docs/screenshots']);
const SKIP_FILES = new Set(['.DS_Store', 'publish-github.js']);
const SKIP_EXT = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|eot|mp4|webp)$/i;

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: url, method,
      headers: {
        Authorization: `token ${TOKEN}`,
        'User-Agent': 'ciyun-publish',
        Accept: 'application/vnd.github+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 60000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (e) { /* ignore */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j);
        reject(new Error(`HTTP ${res.statusCode} ${method} ${url}: ${buf.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || SKIP_DIRS.has(rel)) continue;
      walk(full, rel, out);
    } else {
      if (SKIP_FILES.has(name)) continue;
      out.push({ rel, full });
    }
  }
  return out;
}

(async () => {
  const files = walk(ROOT, '', []);
  console.log(`📦 待上传文件: ${files.length} 个`);

  // 1. 取分支当前 commit（新仓库可能还没有任何提交）
  let parentSha = null;
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    parentSha = ref.object.sha;
    await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
    console.log(`🔗 父提交: ${parentSha.slice(0, 8)}`);
  } catch (e) {
    console.log('🔗 空仓库：本次为首个提交');
    parentSha = null;
  }

  // 2. 逐个创建 blob（按索引分片并发，避免共享队列竞态）
  const tree = new Array(files.length);
  let done = 0;
  const CONC = 6;
  async function worker(startIdx) {
    for (let i = startIdx; i < files.length; i += CONC) {
      const f = files[i];
      const content = fs.readFileSync(f.full);
      const isText = !SKIP_EXT.test(f.rel);
      const res = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
        content: isText ? content.toString('utf8') : content.toString('base64'),
        encoding: isText ? 'utf-8' : 'base64',
      });
      tree[i] = { path: f.rel, mode: '100644', type: 'blob', sha: res.sha };
      done++;
      if (done % 10 === 0 || done === files.length) console.log(`  ⬆️  ${done}/${files.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, files.length) }, (_, k) => worker(k)));

  // 3. 创建 tree
  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree });
  console.log(`🌳 tree: ${newTree.sha.slice(0, 8)}`);

  // 4. 创建 commit（空仓库无父提交）
  const commitBody = {
    message: 'feat: 家庭共享全方案 + 额度兑换系统\n\n'
      + '- 额度系统：每日免费额度 / 观看次数 / 通用点数，超额硬性拦截\n'
      + '- 兑换码四态：会员天数 / 余额 / 观看次数 / 通用点数\n'
      + '- 三层开关：付费总开关 → 额度二级开关 → 具体规则（实现付费/不付费双重模式）\n'
      + '- 家庭共享（对标 Emby/Jellyfin/Plex）：5 种角色权限矩阵、并发流限制、设备数限制、家庭额度池、邀请码多态审核、内容分级\n'
      + '- 家庭额度池接入播放网关，成员额度耗尽自动扣池\n'
      + '- 后台家庭设置三栏配置 + 额度设置 tab\n'
      + '- 测试：家庭 84 项 + 付费回归 76 项全通过',
    tree: newTree.sha,
  };
  if (parentSha) commitBody.parents = [parentSha];
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, commitBody);
  console.log(`📝 commit: ${commit.sha.slice(0, 8)}`);

  // 5. 更新 / 创建 ref
  if (parentSha) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }
  console.log(`✅ 已推送到 https://github.com/${OWNER}/${REPO}@${BRANCH}`);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
