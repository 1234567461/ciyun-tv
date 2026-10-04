/* 上传页回归测试：
 * 1) 未登录访问 → 跳登录（守卫）
 * 2) 登录后发布按钮可见且可点（回归：此前按钮初始 disabled 永不解禁）
 * 3) 空点 → toast「请先选择视频文件」
 * 4) 选真实视频文件 → 预览出现、按钮仍可点
 * 5) 无标题点击 → toast「请填写标题」
 * 6) 填标题上传 → 全链路成功（服务端七层校验 + 落盘 + 跳转）
 */
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    permissions: [],
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  const BASE = 'http://127.0.0.1:8811';
  const P = (ok, label) => console.log((ok ? '  ✅' : '  ❌'), label);
  const CLIP = '/tmp/test-clip.mp4';
  const stamp = Date.now().toString(36);

  // ---- 1) 未登录守卫 ----
  await page.goto(BASE + '/#/shorts/upload', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(900);
  console.log('【守卫】');
  P(page.url().includes('/login'), '未登录访问上传页 → 跳转登录页: ' + page.url().replace(BASE + '/#', ''));

  // ---- 2) 登录后进入上传页 ----
  await page.fill('input[name="account"]', 'tester01');
  await page.fill('input[name="password"]', 'test1234');
  await page.click('.auth-card .btn-primary');
  await page.waitForTimeout(1500);
  // 登录后应回到 redirect 指定的上传页
  console.log('【进入上传页】');
  P(page.url().includes('/shorts/upload'), '登录后回到上传页: ' + page.url().replace(BASE + '/#', ''));

  // ---- 3) 发布按钮可见且可点（核心回归）----
  const btn = page.locator('.sh-upload-foot .btn-primary');
  P(await btn.isVisible(), '「发布」按钮可见');
  P(await btn.isEnabled(), '「发布」按钮可点（非 disabled）——本次修复核心');

  // ---- 4) 空点 → toast 提示 ----
  await btn.click();
  await page.waitForTimeout(500);
  let toastTxt = '';
  const t1 = await page.$('#cy-toast div:last-child');
  if (t1) toastTxt = (await t1.textContent()) || '';
  P(toastTxt.includes('请先选择视频文件'), '空点提示: "' + toastTxt + '"');

  // ---- 5) 选择视频文件 ----
  await page.setInputFiles('input[type="file"]', CLIP);
  await page.waitForTimeout(900);
  P(await page.isVisible('.sh-preview-video'), '视频预览出现');
  P(await page.isVisible('.sh-drop.has-file'), '拖拽区显示文件名（has-file 态）');
  P(await btn.isEnabled(), '选完文件后按钮仍可点');
  const btnTxt = (await btn.textContent()) || '';
  P(btnTxt.trim() === '发布', '按钮文案为「发布」: "' + btnTxt.trim() + '"');
  await page.screenshot({ path: '/tmp/u1_picked.png' });

  // ---- 6) 无标题点击 → toast ----
  await btn.click();
  await page.waitForTimeout(500);
  const t2 = await page.$('#cy-toast div:last-child');
  toastTxt = t2 ? (await t2.textContent()) || '' : '';
  P(toastTxt.includes('请填写标题'), '无标题提示: "' + toastTxt + '"');

  // ---- 7) 填标题真实上传 ----
  await page.fill('.sh-upload .sh-input', '上传链路测试_' + stamp);
  await btn.click();
  // 等待上传完成（按钮变回「发布」且进度文案含成功，或发生跳转）
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    const url = page.url();
    if (url.includes('view=grid')) { ok = true; break; }
    const prog = await page.$('.sh-prog-txt');
    const pt = prog ? (await prog.textContent()) || '' : '';
    if (pt.includes('发布成功')) { ok = true; break; }
    if (pt.includes('❌')) { console.log('   上传进度文案:', pt); break; }
  }
  console.log('【全链路上传】');
  P(ok, '上传成功（进度提示成功或跳回网格页）: ' + page.url().replace(BASE + '/#', ''));
  await page.screenshot({ path: '/tmp/u2_done.png' });

  // ---- 8) 服务端确认：新视频出现在列表 ----
  const list = await page.evaluate(async (s) => {
    const r = await fetch('/api/shorts?page=1&size=30&sort=new');
    const d = await r.json();
    return (d.list || d.items || []).map((x) => x.title);
  }, stamp);
  P(list.some((t) => t && t.includes('上传链路测试_' + stamp)), '新视频已出现在 /api/shorts 列表（共 ' + list.length + ' 条）');

  console.log('页面JS错误:', errs.length ? errs.slice(0, 3) : '无');
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('测试脚本异常:', e.message); process.exit(1); });
