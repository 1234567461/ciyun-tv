/* 粉丝数 / 订阅数展示 + 分享链接可被他人观看 回归：
 *
 * A. 粉丝数随关注行为变化（服务端 + 前端双验证）
 *    1) 登录 tester01，B 账号关注 tester01 → stats.followers +1
 *    2) tester01 的 following 数随之变化
 *    3) 不能关注自己
 * B. 创作者主页 #/u/:account
 *    4) 路由可直达、无「页面不存在」
 *    5) 渲染 4 项统计（粉丝/关注/作品/获赞）
 *    6) 显示关注按钮
 * C. 分享链接可被访客（未登录）直接观看
 *    7) 未登录访问 #/shorts/detail/:id 正常渲染
 *    8) 未登录访问 #/vod/:src/:id 正常渲染
 *    9) 未登录访问 #/u/:account 正常渲染
 * D. 分享面板
 *   10) 播放页「分享」按钮存在
 *   11) 点击弹出面板且含「复制链接」
 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8811';
const U = 'tester01', PWD = 'test1234';
const U2 = 'tester02', PWD2 = 'test1234';

let pass = 0, fail = 0;
const T = (ok, label) => { console.log((ok ? '  ✅' : '  ❌'), label); ok ? pass++ : fail++; };

/* 纯 HTTP 的 API 辅助（带 cookie 会话，与真实浏览器一致） */
const jar = {};
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookies) headers['Cookie'] = cookies;
  const r = await fetch(BASE + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of sc) {
    const [kv] = c.split(';');
    const [k, v] = kv.split('=');
    if (k && v) jar[k.trim()] = v.trim();
  }
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
}
async function login(acc, pwd) {
  const r = await api('/api/user/login', { method: 'POST', body: JSON.stringify({ account: acc, password: pwd }) });
  return r.status === 200;
}
/** 切换账号：清空 cookie 后重新登录 */
async function switchTo(acc, pwd) {
  for (const k of Object.keys(jar)) delete jar[k];
  return login(acc, pwd);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  /* ---------- A. 粉丝数（纯 API） ---------- */
  console.log('【A 粉丝数 / 订阅数】');
  const ok1 = await login(U, PWD);
  T(ok1, `登录 ${U} 成功`);
  const ok2 = await switchTo(U2, PWD2);
  T(ok2, `登录 ${U2} 成功${ok2 ? '' : '（关注类断言将跳过）'}`);

  // 先看 U 的基线（在 U2 会话下读公开接口）
  const before = (await api(`/api/users/${U}/stats`)).json || {};
  T(typeof before.followers === 'number', `stats.followers 为数字 (${before.followers})`);
  T(typeof before.works === 'number', `stats.works 存在 (${before.works})`);
  T(typeof before.totalViews === 'number', `stats.totalViews 存在 (${before.totalViews})`);

  // B（U2）关注 A（U）
  if (ok2) {
    const on = await api(`/api/users/${U}/follow`, { method: 'POST', body: '{}' });
    T(on.status === 200, `关注 ${U} 成功（HTTP ${on.status}）`);
    const after = (await api(`/api/users/${U}/stats`)).json || {};
    T(after.followers === before.followers + 1,
      `粉丝数 +1: ${before.followers} → ${after.followers}`);

    // U2 的关注数（注意：following=我是否关注了他，followingCount=他关注了多少人）
    const t2s = (await api(`/api/users/${U2}/stats`)).json || {};
    T(typeof t2s.followingCount === 'number' && t2s.followingCount >= 1,
      `${U2} 的 followingCount = ${t2s.followingCount}（TA 关注了多少人）`);

    // 当前会话是 U2，check U 的 following 应为 true
    const uStats = (await api(`/api/users/${U}/stats`)).json || {};
    T(uStats.following === true, `${U2} 视角看 ${U}：stats.following = ${uStats.following}（应为 true）`);

    // 再点一次 → 取消
    await api(`/api/users/${U}/follow`, { method: 'POST', body: '{}' });
    const off = (await api(`/api/users/${U}/stats`)).json || {};
    T(off.followers === before.followers,
      `取关后回落: ${after.followers} → ${off.followers}`);
  }

  // 自己关注自己 → 应拒绝（切回 U 会话）
  await switchTo(U, PWD);
  const self = await api(`/api/users/${U}/follow`, { method: 'POST', body: '{}' });
  T(self.status === 400 || self.status === 403, `不能关注自己（HTTP ${self.status}）`);

  // 访客（无 cookie）看 stats：following 必须 false
  for (const k of Object.keys(jar)) delete jar[k];
  const anon = (await api(`/api/users/${U}/stats`)).json || {};
  T(anon.following === false, `访客视角 stats.following = ${anon.following}（应为 false，不能误判已关注）`);

  /* ---------- B/C 浏览器侧 ---------- */
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));

  console.log('【B 创作者主页】');
  await page.goto(`${BASE}/#/u/${U}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1600);
  const puTxt = (await page.textContent('.main')) || '';
  T(!puTxt.includes('页面不存在') && !puTxt.includes('404'), '创作者主页路由可达（非死路由）');
  const head = await page.$('.pu-head');
  T(!!head, '.pu-head 头部渲染');
  const nums = await page.evaluate(() => [...document.querySelectorAll('.pu-stat .pu-num')].map((n) => n.textContent.trim()));
  T(nums.length >= 3, `统计项数量 ${nums.length}（粉丝/关注/作品/获赞）`);
  const labels = await page.evaluate(() => [...document.querySelectorAll('.pu-stat .pu-key')].map((n) => n.textContent.trim()).join('/'));
  T(/粉丝/.test(labels) && /关注/.test(labels), `统计标签含粉丝与关注: ${labels}`);
  const puFollow = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.pu-head button, .pu-info button, .pu-head a.btn, button.btn')];
    const b = bs.find((x) => /关注/.test(x.textContent) && !/粉丝/.test(x.textContent));
    return b ? b.textContent.trim() : '';
  });
  T(!!puFollow, `创作者主页有「关注」按钮（"${puFollow}"）`);
  await page.screenshot({ path: '/tmp/fs_profile.png' });

  console.log('【C 访客（未登录）可看分享链接】');
  /** 页面正文文本：兼容 .main / .watch-wrap / #app 三种容器 */
  const pageText = (p) => p.evaluate(() => {
    const el = document.querySelector('.main') || document.querySelector('.watch-wrap') || document.querySelector('#app');
    return (el && el.textContent) || '';
  });
  const guest = await browser.newContext({ viewport: { width: 414, height: 780 } }); // 手机端访客
  const gp = await guest.newPage();
  const gerr = [];
  gp.on('pageerror', (e) => gerr.push(e.message.slice(0, 140)));

  // 取一条短视频 id
  const sh = (await api('/api/shorts?limit=1')).json || {};
  const shId = (sh.list || [])[0] && (sh.list || [])[0].id;
  if (shId) {
    await gp.goto(`${BASE}/#/shorts/detail/${shId}`, { waitUntil: 'networkidle', timeout: 30000 });
    await gp.waitForTimeout(1600);
    const t = await pageText(gp);
    T(!t.includes('页面不存在') && t.length > 20, `访客可看短视频分享链接 (${shId})`);
    const acts = await gp.$('.sh-detail-acts');
    T(!!acts, '短视频详情互动区渲染（含点赞/评论/收藏/分享）');
  } else {
    console.log('  ⚠️ 无短视频数据，跳过详情断言');
  }

  // 资源库播放页（未登录）
  const target = await page.evaluate(async () => {
    const sr = await (await fetch('/api/multi/sources')).json();
    const srcs = (sr.sources || []).filter((s) => s.enabled !== false && s.id !== 'didizy');
    for (const s of srcs) {
      try {
        const d = await (await fetch(`/api/multi/${s.id}/list?pg=1`)).json();
        const it = (d.list || [])[0];
        if (it && it.id) return { srcId: s.id, vodId: it.id, name: d.name || it.name };
      } catch { /* next */ }
    }
    return null;
  });
  /** 页面正文文本：兼容 .main / .watch-wrap / #app 三种容器 */
  if (target) {
    await gp.goto(`${BASE}/#/vod/${target.srcId}/${target.vodId}`, { waitUntil: 'networkidle', timeout: 30000 });
    await gp.waitForTimeout(2200);
    const vt = await pageText(gp);
    T(!vt.includes('页面不存在') && vt.length > 20, `访客可看播放页分享链接 (${target.name})`);

    console.log('【D 分享面板】');
    const shareBtn = await gp.evaluate(() => {
      const bs = [...document.querySelectorAll('.player-actions button, .player-actions .follow-btn, button')];
      const b = bs.find((x) => /分享/.test(x.textContent));
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      return true;
    });
    T(shareBtn, '播放页存在「分享」按钮');
    if (shareBtn) {
      await gp.evaluate(() => {
        const bs = [...document.querySelectorAll('button')];
        const b = bs.find((x) => /分享/.test(x.textContent));
        b && b.click();
      });
      await gp.waitForTimeout(800);
      const sheet = await gp.$('#cy-share-sheet');
      T(!!sheet, '点击后弹出分享面板');
      if (sheet) {
        const st = (await gp.textContent('#cy-share-sheet')) || '';
        T(/复制链接/.test(st), '面板含「复制链接」');
        T(/发给好友|分享给好友/.test(st), '面板含「发给好友」');
        await gp.screenshot({ path: '/tmp/fs_share.png' });
      }
    }
  } else {
    console.log('  ⚠️ 未找到可播影片，跳过播放页分享测试');
  }

  T(gerr.length === 0, '访客侧全程无 JS 错误' + (gerr.length ? ': ' + gerr[0] : ''));
  T(errs.length === 0, '登录侧全程无 JS 错误' + (errs.length ? ': ' + errs[0] : ''));

  console.log(`\n========== 结果: ${pass} 过 / ${fail} 挂 ==========`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
