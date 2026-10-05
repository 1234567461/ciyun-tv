/* 直播页节目单回归
 * 曾经的 bug：卡片读 epg.isLive（后端根本没这个字段）→ 永远停在「加载节目单…」。
 * 正确字段是 epg.list[{title,start,end}]，需自行挑出当前正在播的一期。
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8811';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

(async () => {
  // 1) 后端契约：/api/live/:ch/epg 必须返回 list（而不是 isLive）
  const chs = await (await fetch(BASE + '/api/live/channels')).json();
  ok(Array.isArray(chs.channels) && chs.channels.length > 0, '频道列表可用（' + (chs.channels || []).length + ' 个）');

  const first = chs.channels[0];
  const epg = await (await fetch(BASE + '/api/live/' + first.id + '/epg')).json();
  ok(Array.isArray(epg.list) && epg.list.length > 0, 'EPG 返回 list 数组（' + (epg.list || []).length + ' 期）');
  ok(epg.isLive === undefined, 'EPG 不含 isLive 字段（前端不应再依赖它）');
  const it = epg.list[0];
  ok(typeof it.title === 'string' && typeof it.start === 'number' && typeof it.end === 'number',
    'EPG 每项含 title/start/end（前端据此判断当前节目）');

  // 2) 前端渲染：卡片不能卡在「加载节目单…」
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(BASE + '/#/live', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const st = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.live-card')];
    const nows = cards.map((c) => (c.querySelector('.c-now') || {}).textContent || '');
    return {
      total: cards.length,
      loading: nows.filter((t) => /加载节目单/.test(t)).length,
      showing: nows.filter((t) => /正在播出：/.test(t)).length,
      sample: nows.slice(0, 3),
    };
  });
  ok(st.total > 0, '直播页渲染出频道卡片（' + st.total + ' 个）');
  ok(st.loading === 0, '没有卡片卡在「加载节目单…」（' + st.loading + ' 个）');
  ok(st.showing >= st.total - 1, '绝大多数卡片显示「正在播出：xxx」（' + st.showing + '/' + st.total + '）');
  ok(!st.sample.some((t) => /undefined/.test(t)), '节目名不含 undefined 占位');

  ok(errs.length === 0, '页面无未捕获 JS 错误' + (errs.length ? '：' + errs.join(' | ') : ''));

  console.log('\n  ────────────────');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
