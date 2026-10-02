import { chromium } from 'playwright';
import fs from 'fs';

const EXE = fs.existsSync('/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')
  ? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
  : '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const B = 'http://127.0.0.1:8811';
const OUT = './docs/screenshots';
const RUN = 'sh' + Date.now().toString(36).slice(-4);

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 120)); });

await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}, { path, method, body });

const shot = async (name, url, wait = 2600) => {
  await page.goto(B + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('📸', name);
};

/* ---------- 1. 前台首页（真实央视栏目） ---------- */
await shot('01-home', '/#/');

/* ---------- 2. 分类页 ---------- */
await shot('02-categories', '/#/category/documentary');

/* ---------- 3. 播放页（真实取流） ---------- */
const cols = await api('/api/columns?category=documentary&size=3');
const col = cols.d.list[0];
if (col) {
  const vids = await api(`/api/columns/${col.id}/videos?page=1&size=3`);
  if (vids.d.list && vids.d.list[0]) {
    await shot('03-player', '/#/play/' + vids.d.list[0].guid, 5000);
  }
}

/* ---------- 4. 登录 + 会员页 ---------- */
const U = 'shot_' + RUN;
await api('/api/user/register', 'POST', { account: U, password: 'test1234', nickname: '演示用户' });
await api('/api/user/login', 'POST', { account: U, password: 'test1234' });
await api('/api/admin/login', 'POST', { username: 'admin', password: 'admin888' });
await api('/api/admin/monetize', 'PUT', { enabled: true });
await api('/api/admin/test/grant-vip', 'POST', { account: U, days: 30 });
await api('/api/user/login', 'POST', { account: U, password: 'test1234' });
await shot('04-vip', '/#/vip');

/* ---------- 4b. 支付弹窗（多渠道路由） ---------- */
// 直接用 UI 登录（保证 SPA 内 auth 状态与 cookie 一致）
await page.goto(B + '/#/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.fill('input[placeholder*="字母开头"]', U);
await page.fill('input[type="password"]', 'test1234');
await page.click('button:has-text("登 录")');
await page.waitForTimeout(2600);
await page.goto(B + '/#/vip', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3200);
const buyBtn = await page.$('button:has-text("立即开通")');
if (buyBtn) {
  await buyBtn.click();
  await page.waitForTimeout(1700);
  await page.screenshot({ path: `${OUT}/05-pay-modal.png` });
  console.log('📸 05-pay-modal');
} else {
  console.log('⚠️  未找到「立即开通」按钮，dump 当前按钮：');
  const btns = await page.$$eval('button', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
  console.log('   ', btns.slice(0, 20).join(' | '));
}

/* ---------- 6. 后台 · 支付渠道 ---------- */
await page.goto(B + '/admin/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  localStorage.clear();
});
// 用管理员 cookie 直接进
await page.goto(B + '/admin/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const tab = await page.$('[data-tab="monetize"]');
if (tab) {
  await tab.click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/06-admin-monetize.png` });
  console.log('📸 06-admin-monetize');
  const chTab = await page.$('[data-t="channels"]');
  if (chTab) {
    await chTab.click();
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${OUT}/07-admin-channels.png` });
    console.log('📸 07-admin-channels');
  }
}

/* ---------- 7. 后台 · 内容管理（栏目库） ---------- */
const cTab = await page.$('[data-tab="content"]');
if (cTab) {
  await cTab.click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/08-admin-content.png` });
  console.log('📸 08-admin-content');
}
const sTab = await page.$('[data-tab="sources"]');
if (sTab) {
  await sTab.click();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/09-admin-sources.png` });
  console.log('📸 09-admin-sources');
}

/* ---------- 8. 移动端首页 ---------- */
const mctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await mctx.newPage();
await mp.goto(B + '/#/', { waitUntil: 'domcontentloaded' });
await mp.waitForTimeout(2800);
await mp.screenshot({ path: `${OUT}/10-mobile-home.png` });
console.log('📸 10-mobile-home');

await browser.close();

/* ---------- 清理 ---------- */
console.log('\n✅ 截图完成 →', OUT);
