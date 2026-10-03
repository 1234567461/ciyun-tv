const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message.slice(0, 160)));

  await page.goto('http://127.0.0.1:8811/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // 汉堡按钮是否可见
  const burgerVisible = await page.isVisible('.nav-burger');
  console.log('汉堡按钮可见:', burgerVisible);

  await page.screenshot({ path: '/tmp/m1_home.png' });

  // 打开抽屉
  await page.click('.nav-burger');
  await page.waitForTimeout(500);
  const drawerOpen = await page.isVisible('.drawer.open .drawer-panel');
  console.log('抽屉打开:', drawerOpen);

  const links = await page.$$eval('.drawer-link', (els) => els.map((e) => e.textContent.trim()));
  console.log('抽屉导航项:', links.join(' / '));
  const chips = await page.$$eval('.drawer-chip', (els) => els.map((e) => e.textContent.trim()));
  console.log('抽屉分类:', chips.slice(0, 8).join(' / '));
  const hasSearch = await page.isVisible('.drawer-search-input');
  console.log('抽屉搜索框:', hasSearch);

  await page.screenshot({ path: '/tmp/m2_drawer.png' });

  // 点一个导航项 → 抽屉应关闭且页面跳转
  const beforeUrl = page.url();
  await page.click('.drawer-link:nth-of-type(2)');
  await page.waitForTimeout(900);
  const drawerClosed = !(await page.isVisible('.drawer.open .drawer-panel').catch(() => false));
  console.log('点击后抽屉关闭:', drawerClosed);
  console.log('URL 变化:', beforeUrl !== page.url() ? '是 → ' + page.url().replace('http://127.0.0.1:8811/', '') : '否');
  await page.screenshot({ path: '/tmp/m3_after_nav.png' });

  // Esc 关闭测试
  await page.click('.nav-burger');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const escClosed = !(await page.isVisible('.drawer.open .drawer-panel').catch(() => false));
  console.log('Esc 关闭抽屉:', escClosed);

  console.log('控制台错误:', errs.length ? errs.slice(0, 5) : '无');
  await browser.close();
})();
