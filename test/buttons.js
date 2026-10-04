const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 100)));
  const BASE = 'http://127.0.0.1:8811';
  const P = (ok, label) => console.log((ok ? '  ✅' : '  ❌'), label);

  // ---- 1) 短视频 feed：顶部按钮 + 推流量排序切换 ----
  await page.goto(BASE + '/#/shorts', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);
  console.log('【短视频 feed 页】');
  P(await page.isVisible('.sh-feed-head'), '顶部悬浮操作条可见');
  P((await page.$$('.sh-sort-tab')).length === 3, '排序切换：推荐/最新/最热 三个 tab');
  P(await page.isVisible('.sh-sort-tab.on'), '默认选中一个排序');
  P(await page.isVisible('.sh-feed-head .sh-fh-btn'), '返回按钮存在');
  P((await page.textContent('.sh-sort-tab.on')).includes('推荐'), '默认为推荐流（推流量机制）');
  await page.screenshot({ path: '/tmp/b1_feed.png' });

  // 切到"最热"
  await page.click('.sh-sort-tab:nth-child(3)');
  await page.waitForTimeout(1000);
  P(page.url().includes('sort=hot'), '点击"最热" → URL 携带 sort=hot');
  P((await page.textContent('.sh-sort-tab.on')).includes('最热'), '选中态切换到"最热"');

  // ---- 2) 登录页返回按钮 ----
  await page.goto(BASE + '/#/shorts?view=grid', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  console.log('【登录页】');
  P(await page.isVisible('.auth-back'), '← 返回按钮可见');
  await page.screenshot({ path: '/tmp/b2_login.png' });
  await page.click('.auth-back');
  await page.waitForTimeout(700);
  P(page.url().includes('shorts'), '点击返回 → 回到站内上一页: ' + page.url().replace(BASE + '/#', ''));

  // ---- 3) 404 页 ----
  await page.goto(BASE + '/#/nonexistent-page', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  console.log('【404 页】');
  P(await page.isVisible('.btn.btn-primary'), '回首页按钮可见');

  // ---- 4) 抽屉用户区（未登录）----
  await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.click('.nav-burger');
  await page.waitForTimeout(500);
  console.log('【抽屉 · 未登录】');
  P(await page.isVisible('.drawer-user'), '抽屉含"账号"区');
  P(await page.isVisible('.drawer-login-cta'), '登录/注册按钮可见');
  P(await page.isVisible('.drawer-user .drawer-link'), '会员中心入口可见');
  await page.screenshot({ path: '/tmp/b3_drawer_guest.png' });
  await page.keyboard.press('Escape');

  // ---- 5) 抽屉用户区（已登录）----
  await page.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.fill('input[name="account"]', 'tester01');
  await page.fill('input[name="password"]', 'test1234');
  await page.click('.auth-card .btn-primary');
  await page.waitForTimeout(1400);
  await page.click('.nav-burger');
  await page.waitForTimeout(500);
  console.log('【抽屉 · 已登录】');
  P(await page.isVisible('.drawer-user-card'), '用户卡片（头像+昵称）可见');
  const hasLogout = await page.isVisible('.drawer-logout');
  P(hasLogout, '退出登录按钮可见');
  await page.screenshot({ path: '/tmp/b4_drawer_user.png' });

  console.log('页面JS错误:', errs.length ? errs.slice(0, 3) : '无');
  await browser.close();
})();
