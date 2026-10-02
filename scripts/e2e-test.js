#!/usr/bin/env node
/**
 * 慈云影视 - 端到端链路测试
 * 验证：栏目 → 视频列表 → 取流 → m3u8 改写 → 二级列表 → TS 分片 → 清晰度
 * 用法：node scripts/e2e-test.js [baseUrl]
 */

const BASE = process.argv[2] || 'http://localhost:8811';
let pass = 0, fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function get(path, asText) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return asText ? r.text() : r.json();
}

(async () => {
  console.log('\n═══ 慈云影视 · 端到端链路测试 ═══\n');

  // 1. 站点信息
  console.log('[1] 站点信息');
  const site = await get('/api/site');
  ok('返回站点名', !!site.siteName, site.siteName);
  ok('主题配置', !!site.theme);
  ok('播放设置', !!site.playback);
  ok('付费模块默认关闭', site.monetize.enabled === false);

  // 2. 分类与栏目
  console.log('\n[2] 分类与栏目');
  const cats = await get('/api/categories');
  ok('分类数量 > 5', cats.categories.length > 5, cats.categories.length + ' 个');
  const cols = await get('/api/columns?category=documentary&size=5');
  ok('纪录片栏目 > 0', cols.total > 0, cols.total + ' 个');
  const col = cols.list[0];

  // 3. 栏目视频列表
  console.log('\n[3] 栏目视频列表');
  const vids = await get(`/api/columns/${col.id}/videos?page=1&size=6`);
  ok('返回视频列表', vids.list && vids.list.length > 0, vids.list.length + ' 条');
  ok('视频含 guid', !!vids.list[0].guid);
  ok('视频含封面', !!vids.list[0].image);
  ok('视频含时长', !!vids.list[0].length, vids.list[0].length);
  ok('total 有效', vids.total > 0, vids.total + ' 期');

  // 4. 取播放地址
  console.log('\n[4] 取播放地址');
  const guid = vids.list[0].guid;
  const info = await get('/api/video/' + guid);
  ok('返回标题', !!info.title, info.title);
  ok('返回 HLS 地址', !!info.hls);
  ok('返回线路列表', info.lines && info.lines.length > 0, info.lines.length + ' 条线路');
  ok('线路含本地代理 src', info.lines.every((l) => !l.src || l.src.startsWith('/api/stream')));

  // 5. m3u8 代理改写
  console.log('\n[5] m3u8 代理改写');
  const l1 = await get('/api/stream?url=' + encodeURIComponent(info.hls), true);
  ok('主 m3u8 返回', l1.includes('#EXTM3U'));
  const l1lines = l1.split('\n').filter((x) => x.trim() && !x.startsWith('#'));
  ok('主 m3u8 内地址已改写', l1lines.every((x) => x.startsWith('/api/stream?url=')));

  // 6. 二级列表
  console.log('\n[6] 二级 m3u8 列表');
  const l2 = await get(l1lines[0], true);
  ok('二级列表返回', l2.includes('#EXTM3U'));
  const l2lines = l2.split('\n').filter((x) => x.trim() && !x.startsWith('#'));
  ok('二级内分片已改写', l2lines.length > 0 && l2lines.every((x) => x.startsWith('/api/stream?url=')));

  // 7. TS 分片
  console.log('\n[7] TS 分片拉取');
  const r = await fetch(BASE + l2lines[0]);
  const buf = Buffer.from(await r.arrayBuffer());
  ok('分片 HTTP 200', r.status === 200, 'HTTP ' + r.status);
  ok('分片有内容', buf.length > 1000, (buf.length / 1024).toFixed(1) + ' KB');
  ok('分片类型正确', /mp2t|octet/i.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  ok('TS 同步字节(0x47)', buf[0] === 0x47, '0x' + buf[0].toString(16));

  // 8. 清晰度
  console.log('\n[8] 清晰度档位');
  const q = await get('/api/qualities?url=' + encodeURIComponent(info.hls));
  ok('返回档位', q.variants && q.variants.length > 0, q.variants.length + ' 档');

  // 9. 搜索
  console.log('\n[9] 搜索');
  const s = await get('/api/search?q=' + encodeURIComponent('纪录片'));
  ok('搜索结果非空', s.list && s.list.length > 0, s.list.length + ' 条');

  // 10. 直播
  console.log('\n[10] 直播与节目单');
  const chs = await get('/api/live/channels');
  ok('频道列表', chs.channels.length > 10, chs.channels.length + ' 个频道');
  const epg = await get('/api/live/cctv1/epg');
  ok('EPG 节目单', epg.list && epg.list.length > 0, epg.list.length + ' 个节目');
  ok('当前节目', !!epg.isLive, epg.isLive);

  // 11. 健康监控
  console.log('\n[11] 接口健康监控');
  const h = await get('/api/admin/health').catch(() => null);
  ok('健康接口需鉴权(未登录应 401)', h === null);

  // 12. 后台鉴权
  console.log('\n[12] 后台鉴权');
  const loginRes = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin888' }),
  });
  const lj = await loginRes.json();
  ok('默认账号登录成功', lj.ok === true);
  const cookie = loginRes.headers.get('set-cookie');
  const settings = await fetch(BASE + '/api/admin/settings', { headers: { cookie: cookie.split(';')[0] } }).then((r) => r.json());
  ok('登录后可读设置', !!settings.siteName);
  const stats = await fetch(BASE + '/api/admin/stats', { headers: { cookie: cookie.split(';')[0] } }).then((r) => r.json());
  ok('统计数据可用', typeof stats.totalPlays === 'number', stats.totalPlays + ' 次播放');

  console.log('\n═══════════════════════════════');
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  console.log('═══════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n💥 测试异常终止:', e.message);
  process.exit(1);
});
