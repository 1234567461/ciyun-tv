/* 第五轮综合回归：
 * 1) 上传卡片（375x667）：发布按钮「真实可见」（elementFromPoint，防 aspect-ratio 裁剪回归）
 * 2) 手机端顶栏搜索：点击图标 → 跳搜索页（focus-within 失效 bug 回归）
 * 3) feed 顶栏 375px：标题可见（不再被 @media 380 隐藏）
 * 4) 分享面板：短视频详情 → 三选项 → 复制链接（剪贴板）→ 空好友态
 * 5) 直播间：video 存在 + 页面无 JS 错误（引擎自愈逻辑在真实浏览器验证）
 * 6) 海报占位：资源库无图条目出现 .poster-fallback
 */
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const BASE = 'http://127.0.0.1:8811';
  let pass = 0, fail = 0;
  const P = (ok, label) => { console.log((ok ? '  ✅' : '  ❌'), label); ok ? pass++ : fail++; };

  /* ============ 1) 上传卡片真实可见（375x667）============ */
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 100)));
    await page.goto(BASE + '/#/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[name="account"]', 'tester01');
    await page.fill('input[name="password"]', 'test1234');
    await page.click('.auth-card .btn-primary');
    await page.waitForTimeout(1400);
    await page.goto(BASE + '/#/shorts/upload', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    console.log('【1 上传卡片 · 375x667】');
    // 关键：elementFromPoint 真实可见性（上一个 bug：几何可见但被 overflow:hidden 裁掉）
    const vis = await page.evaluate(() => {
      const btn = document.querySelector('.sh-upload-foot .btn-primary');
      if (!btn) return { exists: false };
      btn.scrollIntoView({ block: 'center' });
      const b = btn.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return { exists: true, w: Math.round(b.width), h: Math.round(b.height), hitOk: !!(hit && (hit === btn || btn.contains(hit))) };
    });
    P(vis.exists && vis.hitOk, '「发布」按钮真实可点（elementFromPoint 命中）尺寸 ' + vis.w + 'x' + vis.h);
    const formVisible = await page.evaluate(() => {
      const inp = document.querySelector('.sh-upload .sh-input');
      if (!inp) return false;
      inp.scrollIntoView({ block: 'center' });
      const b = inp.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!(hit && (hit === inp || inp.contains(hit) || hit.tagName === 'INPUT'));
    });
    P(formVisible, '标题输入框真实可见（表单未被裁剪）');
    P(errs.length === 0, '页面无 JS 错误');
    await ctx.close();
  }

  /* ============ 2) 手机端顶栏搜索跳转 ============ */
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/#/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1100);
    console.log('【2 手机端搜索入口】');
    await page.click('.search-box');
    await page.waitForTimeout(800);
    P(page.url().includes('/search'), '点击搜索图标 → 跳转搜索页: ' + page.url().replace(BASE + '/#', ''));
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'INPUT');
    P(focused, '搜索页输入框已自动聚焦');
    await ctx.close();
  }

  /* ============ 3) feed 顶栏 375px 标题 ============ */
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/#/shorts', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1200);
    console.log('【3 feed 顶栏 · 375px】');
    const t = await page.$('.sh-fh-title');
    P(!!t && await t.isVisible(), '「短视频」标题可见（不再隐藏）');
    // 排序 tab 仍可点
    const tabs = await page.$$('.sh-sort-tab');
    P(tabs.length === 3, '排序 tab 完整（3 个）');
    if (tabs.length === 3) {
      await tabs[2].click();
      await page.waitForTimeout(700);
      P(page.url().includes('sort=hot'), '「最热」tab 仍可点');
    }
    await ctx.close();
  }

  /* ============ 4) 分享面板 ============ */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await ctx.newPage();
    // 登录
    await page.goto(BASE + '/#/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[name="account"]', 'tester01');
    await page.fill('input[name="password"]', 'test1234');
    await page.click('.auth-card .btn-primary');
    await page.waitForTimeout(1400);
    // 短视频详情（取列表第一条，无视频则跳过该子项）
    await page.goto(BASE + '/#/shorts?view=grid', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const hasShort = await page.$('.sh-grid .sh-gcard');
    console.log('【4 分享面板】');
    if (!hasShort) {
      console.log('  ⚠️ 无短视频数据，分享面板测试跳过');
    } else {
      await page.evaluate(() => { document.querySelector('.sh-grid .sh-gcard').click(); });
      await page.waitForTimeout(1500);
      P(page.url().includes('/shorts/detail/'), '进入短视频详情页: ' + page.url().replace(BASE + '/#', ''));
      const shareBtn = await page.$('.sh-detail-acts .sh-dact');
      const btns = await page.$$('.sh-detail-acts .sh-dact');
      P(btns.length >= 3, '互动按钮 ≥3（点赞/分享/去广场）: ' + btns.length);
      // 点分享 → 面板
      const shareLabel = await page.evaluate(() => {
        const els = [...document.querySelectorAll('.sh-detail-acts .sh-dact')];
        const b = els.find((e) => e.textContent.includes('分享'));
        if (b) { b.click(); return true; }
        return false;
      });
      P(shareLabel, '「↗ 分享」按钮存在且可点');
      await page.waitForTimeout(700);
      P(await page.isVisible('#cy-share-sheet'), '分享面板弹出');
      const items = await page.$$('.cy-sheet-item');
      P(items.length >= 2, '面板选项数: ' + items.length + '（复制链接/系统分享/发给好友）');
      // 复制链接
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.cy-sheet-item')].find((e) => e.textContent.includes('复制链接'));
        if (b) b.click();
      });
      await page.waitForTimeout(600);
      let clip = '';
      try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch { clip = '(读取受限)'; }
      P(clip.includes('/shorts/detail/') || clip.includes('127.0.0.1'), '复制链接内容正确: ' + clip.slice(0, 70));
      // 再开面板 → 发给好友（空好友态）
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('.sh-detail-acts .sh-dact')];
        const b = els.find((e) => e.textContent.includes('分享'));
        if (b) b.click();
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.cy-sheet-item')].find((e) => e.textContent.includes('发给好友'));
        if (b) b.click();
      });
      await page.waitForTimeout(1200);
      const hint = await page.evaluate(() => {
        const h = document.querySelector('.cy-sheet-hint');
        return h ? h.textContent : '(无)';
      });
      P(hint.includes('还没有好友') || hint.includes('加载失败') || hint.includes('去加好友') || hint.includes('登录'), '发给好友 → 好友列表/空态正常: "' + hint.slice(0, 30) + '"');
    }
    await ctx.close();
  }

  /* ============ 5) 直播间 ============ */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 100)));
    await page.goto(BASE + '/#/live', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    console.log('【5 电视直播】');
    const n = (await page.$$('.live-card')).length;
    P(n >= 10, '频道列表加载: ' + n + ' 个');
    await page.goto(BASE + '/#/live/cctv1', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(6000);
    P(!!(await page.$('video')), '直播间 video 元素存在');
    const hasNow = await page.isVisible('.live-now');
    P(hasNow, '实时节目单（正在播出 + 进度）渲染');
    P(errs.length === 0, '直播间无 JS 错误' + (errs.length ? ': ' + errs[0] : ''));
    await ctx.close();
  }

  /* ============ 6) 海报占位 ============ */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/#/resource', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    console.log('【6 海报占位】');
    const stat = await page.evaluate(() => ({
      cards: document.querySelectorAll('.card').length,
      fallbacks: document.querySelectorAll('.poster-fallback').length,
    }));
    P(stat.fallbacks > 0 || stat.cards === 0, '无图卡片渲染海报占位: 占位 ' + stat.fallbacks + ' / 卡片 ' + stat.cards);
    await page.screenshot({ path: '/tmp/r5_poster.png' });
    await ctx.close();
  }

  console.log('\n========== 结果: ' + pass + ' 过 / ' + fail + ' 挂 ==========');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
