/* 播放器生命周期回归
 * ============================================================
 * 锁定的 bug（用户反馈：「看完视频不关网站，还会有一卡一卡的声音」）：
 *   · 点播播放页 pageVod 先 new Player(占位) → 末尾又 switchEp() 重建，
 *     同页创建 2 个 <video> + 2 个 hls.js 实例。第一个刚起播就被 destroy，
 *     异步竞态下它的加载器没被干净停掉 → 变成「幽灵播放器」：
 *     DOM 里看不到，却在后台持续按分片周期拉流并输出声音。
 *   · 短视频详情页则完全没有清理逻辑，离开后 <video> 仍在播放。
 *
 * 期望：任意播放页离开后 —— 无残留 video、无持续拉流、无后台音频。
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8811';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

/** 打开某播放页 → 停留 → 切到首页 → 观察是否彻底停止 */
async function checkLeave(page, url, label, waitMs = 9000) {
  let phase = 'enter', t0 = 0;
  const after = [];
  const onReq = (r) => {
    if (phase === 'after' && /\/api\/(stream|shorts)/.test(r.url())) after.push(Date.now() - t0);
  };
  page.on('request', onReq);

  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(waitMs);

  // 记录进入时创建的 video 元素数（用于捕捉「重复创建」）
  const entered = await page.evaluate(() => document.querySelectorAll('video').length);

  t0 = Date.now(); phase = 'after';
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForTimeout(12000);

  const st = await page.evaluate(() => {
    const vs = [...document.querySelectorAll('video, audio')];
    return { inDom: vs.length, playing: vs.filter((v) => !v.paused).length };
  });
  page.off('request', onReq);

  const late = after.filter((x) => x > 3000).length;   // 3 秒后仍新增 = 没停
  ok(st.playing === 0, `${label}：离开后无 video 在播放（playing=${st.playing}）`);
  ok(late === 0, `${label}：离开 3 秒后无新增拉流（late=${late}）`);
  return entered;
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  // ---------- 1. 点播播放页 ----------
  const entered = await checkLeave(page, '/#/vod/hongniu/196328', '点播播放页');
  ok(entered <= 1, `点播页只创建 1 个 video（实际 ${entered}，>1 说明存在幽灵播放器）`);

  // ---------- 2. 短视频详情页 ----------
  const list = await (await fetch(BASE + '/api/shorts')).json();
  const item = (list.list || list.shorts || [])[0];
  if (item) {
    await checkLeave(page, '/#/shorts/' + item.id, '短视频详情页', 6000);
  } else {
    ok(true, '短视频详情页：无数据可测，跳过');
  }

  // ---------- 3. 短视频瀑布流 ----------
  await page.goto(BASE + '/#/shorts', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  let phase = 'enter', t0 = 0; const after = [];
  const onReq = (r) => { if (phase === 'after' && /\/api\/(shorts|stream)/.test(r.url())) after.push(Date.now() - t0); };
  page.on('request', onReq);
  t0 = Date.now(); phase = 'after';
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForTimeout(10000);
  const feedState = await page.evaluate(() => {
    const vs = [...document.querySelectorAll('video,audio')];
    return { playing: vs.filter((v) => !v.paused).length };
  });
  page.off('request', onReq);
  ok(feedState.playing === 0, `短视频瀑布流：离开后无 video 在播放（playing=${feedState.playing}）`);
  ok(after.filter((x) => x > 3000).length === 0, '短视频瀑布流：离开后无持续拉流');

  ok(errs.length === 0, '全程无未捕获 JS 错误' + (errs.length ? '：' + errs.join(' | ') : ''));

  console.log('\n  ────────────────');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
