/* 追剧（关注）功能回归：
 * 1) 未登录访问 /follows → 空态 + 去登录
 * 2) 导航入口（抽屉）存在
 * 3) 资源库播放页「🔔 追剧」按钮 → 点击 → 变已追剧
 * 4) /follows 列表出现该剧（服务端持久化）
 * 5) 再次点击取消 → 列表移除
 * 6) 短视频详情追剧按钮存在
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const BASE = 'http://127.0.0.1:8811';
  let pass = 0, fail = 0;
  const P = (ok, label) => { console.log((ok ? '  ✅' : '  ❌'), label); ok ? pass++ : fail++; };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));

  /* 1) 未登录 */
  await page.goto(BASE + '/#/follows', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);
  console.log('【1 未登录】');
  const guestTxt = await page.textContent('.main') || '';
  P(guestTxt.includes('登录后查看追剧') || guestTxt.includes('去登录'), '未登录显示引导: "' + guestTxt.slice(0, 30).replace(/\s+/g, ' ') + '"');

  /* 2) 抽屉入口 */
  await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.click('.nav-burger');
  await page.waitForTimeout(500);
  console.log('【2 导航入口】');
  const hasEntry = await page.evaluate(() => !!document.querySelector('a[href="#/follows"]'));
  P(hasEntry, '抽屉含「我的追剧」入口');
  await page.keyboard.press('Escape');

  /* 登录 */
  await page.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await page.fill('input[name="account"]', 'tester01');
  await page.fill('input[name="password"]', 'test1234');
  await page.click('.auth-card .btn-primary');
  await page.waitForTimeout(1500);

  /* 3) 资源库播放页追剧 */
  console.log('【3 播放页追剧按钮】');
  // 取源列表第一个源的第一个影片
  const target = await page.evaluate(async () => {
    const sr = await (await fetch('/api/multi/sources')).json();
    const srcs = (sr.sources || []).filter((s) => s.enabled !== false && s.id !== 'didizy');
    for (const s of srcs) {
      try {
        const d = await (await fetch('/api/multi/' + s.id + '/list?pg=1')).json();
        const it = (d.list || [])[0];
        if (it && it.id) {
          const dd = await (await fetch('/api/multi/' + s.id + '/detail/' + it.id)).json();
          if (dd && (dd.lines || []).some((l) => (l.episodes || []).length)) {
            return { srcId: s.id, vodId: it.id, name: dd.name || it.name };
          }
        }
      } catch { /* 下一个源 */ }
    }
    return null;
  });
  if (!target) {
    console.log('  ⚠️ 未找到可播影片，跳过播放页测试');
  } else {
    console.log('   目标影片:', target.name, '(' + target.srcId + '/' + target.vodId + ')');
    await page.goto(BASE + '/#/vod/' + target.srcId + '/' + target.vodId, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const btn = await page.$('.player-actions .follow-btn');
    P(!!btn, '播放页「🔔 追剧」按钮存在');
    if (btn) {
      // ⚠️ 顶栏 fixed z-100：把按钮滚到视口上方避让，否则点击被顶栏拦截
      await page.evaluate(() => {
        const b = document.querySelector('.player-actions');
        if (b) { const y = b.getBoundingClientRect().top + window.scrollY; window.scrollTo(0, Math.max(0, y - 220)); }
      });
      await page.waitForTimeout(600);
      const before = (await btn.textContent()).trim();
      await btn.click({ timeout: 15000 });
      await page.waitForTimeout(1800);
      const after = (await btn.textContent()).trim();
      P(after.includes('已追剧'), '点击后变为已追剧: "' + before + '" → "' + after + '"');

      /* 4) 追剧页出现 */
      await page.goto(BASE + '/#/follows', { waitUntil: 'networkidle' });
      await page.waitForTimeout(1600);
      const inList = await page.evaluate((nm) => {
        return [...document.querySelectorAll('.follow-card')].some((c) => c.textContent.includes(nm.slice(0, 4)));
      }, target.name);
      P(inList, '/follows 列表出现该剧（服务端持久化生效）');
      const apiCheck = await page.evaluate(async () => {
        const d = await (await fetch('/api/follows')).json();
        return (d.list || []).length;
      });
      P(apiCheck > 0, '服务端 /api/follows 返回 ' + apiCheck + ' 条');
      await page.screenshot({ path: '/tmp/f1_follows.png' });

      /* 5) 取消关注 */
      const delBtn = await page.$('.follow-card .follow-del');
      P(!!delBtn, '追剧卡片有取消按钮');
      if (delBtn) {
        await delBtn.click();
        await page.waitForTimeout(1500);
        const after2 = await page.evaluate(async () => {
          const d = await (await fetch('/api/follows')).json();
          return (d.list || []).length;
        });
        P(after2 === apiCheck - 1, '取消后服务端条数 ' + apiCheck + ' → ' + after2);
      }
    }
  }

  /* 6) 短视频详情追剧按钮 */
  await page.goto(BASE + '/#/shorts?view=grid', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const hasCard = await page.$('.sh-grid .sh-gcard');
  console.log('【4 短视频详情】');
  if (hasCard) {
    await page.evaluate(() => document.querySelector('.sh-grid .sh-gcard').click());
    await page.waitForTimeout(1500);
    const shFollow = await page.$('.sh-detail-acts .follow-btn');
    P(!!shFollow, '短视频详情追剧按钮存在');
    if (shFollow) {
      await shFollow.click();
      await page.waitForTimeout(1600);
      const txt = (await shFollow.textContent()).trim();
      P(txt.includes('已追'), '点击后追剧态生效: "' + txt + '"');
    }
  } else {
    console.log('  ⚠️ 无短视频数据，跳过');
  }

  P(errs.length === 0, '全程无 JS 错误' + (errs.length ? ': ' + errs[0] : ''));
  console.log('\n========== 结果: ' + pass + ' 过 / ' + fail + ' 挂 ==========');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
