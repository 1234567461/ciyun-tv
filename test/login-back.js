const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));

  const BASE = 'http://127.0.0.1:8811';
  const strip = (u) => String(u).replace(BASE, '').replace('about:blank', '(空白，测试起点)');

  await page.goto(BASE + '/#/profile', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);

  // 1) 未登录访问守卫页 → 落在登录页（带 redirect）
  console.log('1. 未登录访问 /profile 落在:', strip(page.url()));

  // 2) UI 登录
  await page.fill('input[name="account"]', 'tester01');
  await page.fill('input[name="password"]', 'test1234');
  await page.click('.auth-card .btn-primary');
  await page.waitForTimeout(1500);
  console.log('2. 登录后落在:', strip(page.url()));
  const loggedIn = await page.evaluate(() => !!localStorage.getItem('cy_token'));
  console.log('   token 已写入:', loggedIn);

  // 3) 连按返回 —— 不应再落回登录页
  await page.goBack(); await page.waitForTimeout(500);
  const back1 = strip(page.url());
  console.log('3. 按返回落在:', back1);
  console.log(back1.includes('login') ? '   ❌ 仍被困在登录页' : '   ✅ 返回键不再被登录页吞掉');

  // 4) 已登录直接访问登录页 → 替换跳走（不留登录页历史）
  await page.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  console.log('4. 已登录访问 /login 落在:', strip(page.url()));

  // 5) 恶意外链 redirect 被清洗
  await page.evaluate(() => localStorage.removeItem('cy_token'));
  await page.goto(BASE + '/#/login?redirect=' + encodeURIComponent('https://evil.com/phish'), { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const red = await page.evaluate(() => document.querySelector('.auth-foot a')?.getAttribute('href') || '');
  console.log('5. 恶意外链 redirect 清洗后 href:', red || '(已去掉参数)');

  console.log('页面JS错误:', errs.length ? errs : '无');
  await browser.close();
})();
