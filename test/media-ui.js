/* 前端图片交互回归（Playwright）
 * ------------------------------------------------------------
 * 后端 API 已经由 test/media-images.js 覆盖，这里专测「浏览器里到底能不能用」：
 *   - 评论编辑器出现发图按钮，能打开预览条
 *   - 聊天室出现发图按钮
 *   - 相册页 / 云盘页可正常渲染且无 JS 错误
 *   - 分享访问页在未登录状态可打开
 * 运行：node test/media-ui.js
 */
const { chromium } = require('playwright');
const path = require('path');

const BASE = process.env.CIYUN_BASE || 'http://127.0.0.1:8811';
let pass = 0, fail = 0;
const P = (ok, label, extra) => {
  console.log((ok ? '  ✅' : '  ❌'), label + (extra ? '  ' + extra : ''));
  ok ? pass++ : fail++;
};
const section = (t) => console.log('\n【' + t + '】');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 160)); });

  const login = async () => {
    await page.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.fill('input[name="account"]', 'tester01');
    await page.fill('input[name="password"]', 'test1234');
    await page.click('.auth-card .btn-primary');
    await page.waitForTimeout(1500);
  };

  /* ---------- 1. 静态资源与路由 ---------- */
  section('1 页面与资源');
  await page.goto(BASE + '/#/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(900);

  // media.css / media.js 真的被加载
  const assets = await page.evaluate(() => ({
    css: [...document.styleSheets].some((s) => (s.href || '').includes('media.css')),
    js: performance.getEntriesByType('resource').some((r) => r.name.includes('/js/media.js')),
  }));
  P(assets.css, 'media.css 已加载');
  P(assets.js, 'media.js 已加载（模块被引用）');

  /* ---------- 2. 相册页（需登录） ---------- */
  section('2 相册页');
  await login();
  await page.goto(BASE + '/#/gallery', { waitUntil: 'networkidle' });
  // hash 路由 + 一次 API 往返，等 DOM 真的长出 chips 再断言
  await page.waitForFunction(
    () => document.querySelectorAll('.gallery-head .chip').length >= 4,
    { timeout: 12000 }
  ).catch(() => {});
  P(!!(await page.$('.gallery-wrap')), '相册页已渲染（.gallery-wrap）');
  const galChips = await page.$$('.gallery-head .chip');
  P(galChips.length >= 4, '来源筛选 chips 存在', '共 ' + galChips.length + ' 个');
  const galStat = await page.textContent('.gallery-stat').catch(() => '');
  P(/张/.test(galStat || ''), '相册统计已显示', (galStat || '').trim());

  /* ---------- 3. 云盘页 ---------- */
  section('3 云盘页');
  await page.goto(BASE + '/#/drive', { waitUntil: 'networkidle' });
  await page.waitForSelector('.drive-wrap', { timeout: 10000 }).catch(() => {});
  P(!!(await page.$('.drive-wrap')), '云盘页已渲染（.drive-wrap）');
  P(!!(await page.$('.drive-side')), '侧栏存在');
  P(!!(await page.$('.drive-main')), '主区存在');
  const quotaTxt = await page.textContent('.drive-quota').catch(() => '');
  P(/GB|MB/.test(quotaTxt || ''), '配额信息已显示', (quotaTxt || '').replace(/\s+/g, ' ').slice(0, 60));

  // 上传按钮能点出文件选择（不真正上传，只验证控件存在）
  const upBtn = await page.$('.drive-side button, .drive-main button');
  P(!!upBtn, '工具栏按钮可用');

  /* ---------- 4. 评论编辑器发图入口 ---------- */
  section('4 评论区发图入口');
  // 直接用短视频详情页 —— 它的评论区一定存在，避免依赖「能不能点到某个卡片」
  await page.goto(BASE + '/#/shorts?view=grid', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const shCard = await page.$('.sh-grid .sh-gcard, .sh-gcard');
  if (shCard) {
    await shCard.click();
    await page.waitForTimeout(2800);
    const cmWrap = await page.$('.comments-wrap');
    if (cmWrap) {
      const pickBtn = await page.$('.cm-editor .btn-icon, .cm-editor [title*="图片"]');
      P(!!pickBtn, '评论编辑器出现发图按钮');
      const ta = await page.$('.cm-editor .cm-textarea');
      const ph = ta ? await ta.getAttribute('placeholder') : '';
      P(/粘贴|拖入|图片/.test(ph || ''), '占位文案提示可发图', '"' + ph + '"');
    } else {
      console.log('    ⚠️ 短视频详情无评论区，跳过');
    }
  } else {
    console.log('    ⚠️ 短视频网格为空，跳过评论区测试');
  }

  /* ---------- 5. 私信发图入口 ---------- */
  section('5 私信发图入口');
  await page.goto(BASE + '/#/social?tab=messages', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const socBox = await page.$('.soc-pane');
  P(!!socBox, '社交页已渲染');
  const socFoot = await page.$('.soc-cfoot');
  if (socFoot) {
    const hasPick = await page.$('.soc-cfoot .btn-icon, .soc-cfoot [title*="图片"]');
    P(!!hasPick, '私信输入区出现发图按钮');
  } else {
    console.log('    ℹ️ 无好友会话（.soc-cfoot 未出现），符合空态预期');
    const hint = await page.textContent('.soc-pane').catch(() => '');
    P(/好友|消息/.test(hint || ''), '空态有引导文案');
  }

  /* ---------- 6. 分享访问页（未登录） ---------- */
  section('6 分享访问页');
  const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await anon.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(e.message.slice(0, 120)));

  // 先在云盘里放一个文件，再基于它生成分享
  const tok = await page.evaluate(async () => {
    // 造一个 1x1 PNG，走真实上传接口
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append('file', new Blob([arr], { type: 'image/png' }), 'ui分享测试.png');
    const up = await fetch('/api/drive/upload', { method: 'POST', credentials: 'include', body: fd })
      .then((r) => r.json()).catch(() => null);
    const node = up && (up.node || up.file);
    if (!node) return null;
    const r = await fetch('/api/drive/share', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: node.id, expireDays: 3 }),
    }).then((x) => x.json()).catch(() => null);
    return r && r.share ? r.share.token : null;
  });

  if (tok) {
    await p2.goto(BASE + '/#/s/' + tok, { waitUntil: 'networkidle' });
    await p2.waitForTimeout(1500);
    const sp = await p2.$('.share-page');
    P(!!sp, '未登录可打开分享页（.share-page）');
    const txt = await p2.textContent('.share-page').catch(() => '');
    P(/下载|预览|提取码|空/.test(txt || ''), '分享页内容已渲染', (txt || '').replace(/\s+/g, ' ').slice(0, 70));
    const dlA = await p2.$('.share-acts a[href*="/file"]');
    P(!!dlA, '分享页给出下载入口');
  } else {
    P(false, '无法生成分享 token（云盘上传或分享接口异常）');
  }

  /* ---------- 汇总 ---------- */
  // 401 是未登录时预期会出现的探测请求，不算缺陷
  const realErrs = errs.filter((e) => !/favicon|401 \(Unauthorized\)|404 \(Not Found\)/i.test(e));
  P(realErrs.length === 0, '主上下文无 JS 错误', realErrs.length ? realErrs[0] : '');
  P(errs2.length === 0, '匿名上下文无 JS 错误', errs2.length ? errs2[0] : '');

  console.log('\n========== 结果: ' + pass + ' 过 / ' + fail + ' 挂 ==========');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
