/* 真实场景复现：用户在两个入口操作同一部剧，验证状态一致
 * 1) 资源库播放页 #/vod/cctv-official/col:xxx 点「追剧」
 * 2) 打开 #/follows 确认出现
 * 3) 同一部剧，从 #/watch/<guid> 检查是否显示「已追剧」（跨入口一致）
 * 4) 在 #/follows 点 ✕ 取关
 * 5) 回到播放页，按钮必须回到「🔔 追剧」
 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8811';

let pass = 0, fail = 0;
const T = (ok, label) => { console.log((ok ? '  ✅' : '  ❌'), label); ok ? pass++ : fail++; };

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  page.on('console', (m) => { if (m.type() === 'error' && !/400|Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text().slice(0, 140)); });

  // 登录
  await page.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await page.fill('input[name="account"]', 'tester01');
  await page.fill('input[name="password"]', 'test1234');
  await page.click('.auth-card .btn-primary');
  await page.waitForTimeout(2000);

  // 清理既有追剧
  await page.evaluate(async () => {
    const d = await (await fetch('/api/follows')).json();
    for (const it of (d.list || [])) {
      await fetch('/api/follows/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: it.type, targetId: it.targetId, title: it.title }) });
    }
  });

  // 找一部央视合集的剧（同时有 col: 与 guid 两个入口）
  const target = await page.evaluate(async () => {
    const d = await (await fetch('/api/multi/cctv-official/list?pg=1')).json();
    const it = (d.list || [])[0];
    if (!it) return null;
    const dd = await (await fetch(`/api/multi/cctv-official/detail/${encodeURIComponent(it.id)}`)).json();
    const eps = ((dd.lines || [])[0] || {}).episodes || [];
    return { vodId: it.id, name: dd.name || it.name, firstGuid: eps[0] && eps[0].url };
  });
  console.log('  目标:', target && target.name, '| vodId =', target && target.vodId, '| 首集 guid =', target && target.firstGuid ? String(target.firstGuid).slice(0, 12) + '…' : '(无)');

  /* 1) 资源库播放页追剧 */
  console.log('【1 资源库播放页点追剧】');
  await page.goto(`${BASE}/#/vod/cctv-official/${encodeURIComponent(target.vodId)}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2800);
  const btn1 = await page.$('.player-actions .follow-btn');
  T(!!btn1, '播放页追剧按钮存在');
  if (btn1) {
    await page.evaluate(() => {
      const b = document.querySelector('.player-actions');
      if (b) window.scrollTo(0, Math.max(0, b.getBoundingClientRect().top + window.scrollY - 200));
    });
    await page.waitForTimeout(400);
    await btn1.click({ timeout: 12000 });
    await page.waitForTimeout(1600);
    const t = (await btn1.textContent()).trim();
    T(/已追剧/.test(t), `点击后变为「${t}」`);

    /* 2) 追剧页出现 */
    console.log('【2 #/follows 是否出现】');
    await page.goto(BASE + '/#/follows', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    const inList = await page.evaluate((nm) => [...document.querySelectorAll('.follow-card')].some((c) => c.textContent.includes(nm.slice(0, 4))), target.name);
    T(inList, '追剧列表出现该剧');

    /* 3) 跨入口：用首集 guid 走 /watch 检查状态 */
    if (target.firstGuid) {
      console.log('【3 跨入口一致性：#/watch/<guid> 是否也显示已追剧】');
      await page.goto(`${BASE}/#/watch/${target.firstGuid}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2600);
      const btn2txt = await page.evaluate(() => {
        const b = document.querySelector('.player-actions .follow-btn') || document.querySelector('.follow-btn');
        return b ? b.textContent.trim() : '(无按钮)';
      });
      T(/已追剧/.test(btn2txt), `另一入口显示「${btn2txt}」（应为已追剧）`);
    }

    /* 4) 从追剧页取关 */
    console.log('【4 从 #/follows 取关】');
    await page.goto(BASE + '/#/follows', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    const del = await page.$('.follow-card .follow-del');
    T(!!del, '追剧卡片有 ✕ 取关按钮');
    if (del) {
      await del.click();
      await page.waitForTimeout(1800);
      const cnt = await page.evaluate(async () => ((await (await fetch('/api/follows')).json()).list || []).length);
      T(cnt === 0, `取关后服务端剩余 ${cnt} 条（应为 0）`);

      /* 5) 回播放页按钮应变回未追 */
      await page.goto(`${BASE}/#/vod/cctv-official/${encodeURIComponent(target.vodId)}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2600);
      const back = await page.evaluate(() => {
        const b = document.querySelector('.player-actions .follow-btn');
        return b ? b.textContent.trim() : '(无按钮)';
      });
      T(/🔔|追剧/.test(back) && !/已追剧/.test(back), `播放页按钮回到「${back}」（不应再显示已追剧）`);
    }
  }

  T(errs.length === 0, '全程无 JS 错误' + (errs.length ? ': ' + errs[0] : ''));
  console.log(`\n========== 结果: ${pass} 过 / ${fail} 挂 ==========`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
