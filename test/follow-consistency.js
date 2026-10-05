/* 验证追剧的「重复/错乱」问题：
 * 模拟同一部剧从不同入口追/取关，检查记录是否会分裂或无法取关
 */
const BASE = 'http://127.0.0.1:8811';

const jar = {};
async function req(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const cookies = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  if (cookies) headers['Cookie'] = cookies;
  const r = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of sc) {
    const [kv] = c.split(';');
    const [k, v] = kv.split('=');
    if (k && v) jar[k.trim()] = v.trim();
  }
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

(async () => {
  console.log('=== 登录 ===');
  const lg = await req('/api/user/login', { method: 'POST', body: JSON.stringify({ account: 'tester01', password: 'test1234' }) });
  console.log('  login', lg.status, 'cookie cy_user =', jar.cy_user ? jar.cy_user.slice(0, 12) + '…' : '(无)');

  await req('/api/follows'); // 预热

  // 清空已有追剧
  const cur = (await req('/api/follows')).json;
  for (const it of (cur.list || [])) {
    await req('/api/follows/toggle', { method: 'POST', body: JSON.stringify({ type: it.type, targetId: it.targetId, title: it.title }) });
  }
  console.log('  清空后剩余:', ((await req('/api/follows')).json.list || []).length);

  console.log('\n=== 场景1：同一部剧，不同入口的 targetId（真实场景） ===');
  const GUID = 'd8ee138420f74b3fba83fdf45e13709f';
  // 入口 A：央视播放页传裸 32 位 hex guid（历史行为）→ 追
  await req('/api/follows/toggle', { method: 'POST', body: JSON.stringify({ type: 'vod', targetId: GUID, title: '新闻联播' }) });
  let l = (await req('/api/follows')).json.list || [];
  console.log('  从旧入口（裸 guid）追一次 → 记录数 =', l.length, '（应为 1）');

  console.log('\n=== 场景2：另一个入口必须看到「已追」（跨入口一致）===');
  const c1 = (await req('/api/follows/check?type=vod&targetId=' + GUID)).json;
  const c2 = (await req('/api/follows/check?type=vod&targetId=cctv-official:' + GUID)).json;
  const c3 = (await req('/api/follows/check?type=vod&targetId=NOT_EXIST')).json;
  console.log('  check 裸 guid        →', c1.following, '(应为 true)');
  console.log('  check 带前缀(新入口) →', c2.following, '(应为 true)');
  console.log('  check 不存在的剧     →', c3.following, '(应为 false)');
  console.log(c1.following === true && c2.following === true && c3.following === false
    ? '  ✅ 跨入口状态一致（不会再「追没追都提示」）' : '  ❌ 跨入口不一致');

  console.log('\n=== 场景3：从新入口取关，旧入口也必须变「未追」，且不残留 ===');
  await req('/api/follows/toggle', { method: 'POST', body: JSON.stringify({ type: 'vod', targetId: 'cctv-official:' + GUID, title: '新闻联播' }) });
  l = (await req('/api/follows')).json.list || [];
  const a1 = (await req('/api/follows/check?type=vod&targetId=' + GUID)).json.following;
  const a2 = (await req('/api/follows/check?type=vod&targetId=cctv-official:' + GUID)).json.following;
  console.log('  取关后剩余记录 =', l.length, '（应为 0，历史重复项一并清掉）');
  console.log('  裸 guid check  →', a1, '（应为 false）');
  console.log('  带前缀 check   →', a2, '（应为 false）');
  console.log(l.length === 0 && a1 === false && a2 === false
    ? '  ✅ 取关彻底生效，不会「取关了还显示已追」' : '  ❌ 仍有残留');

  console.log('\n=== 场景4：type 缺失应被拒绝 ===');
  const r = await req('/api/follows/toggle', { method: 'POST', body: JSON.stringify({ targetId: 'x', title: 't' }) });
  console.log('  无 type 提交 →', r.status, JSON.stringify(r.json));
  console.log(r.status === 400 ? '  ✅ 正确拒绝' : '  ❌ 未拒绝');

  /* ---------- E. 关注用户（type=user）跨大小写一致 ---------- */
  console.log('\n=== 场景5：关注用户时账号名大小写不一致 ===');
  // 以 tester02 身份关注 tester01
  for (const k of Object.keys(jar)) delete jar[k];
  await req('/api/user/login', { method: 'POST', body: JSON.stringify({ account: 'tester02', password: 'test1234' }) });
  // 先清掉可能已有的关注
  const s0 = (await req('/api/users/tester01/stats')).json;
  if (s0.following) await req('/api/users/tester01/follow', { method: 'POST', body: '{}' });

  const base0 = (await req('/api/users/tester01/stats')).json;
  await req('/api/users/TESTER01/follow', { method: 'POST', body: '{}' });   // 大写路径提交
  const after1 = (await req('/api/users/tester01/stats')).json;
  console.log('  大写路径关注后 followers:', base0.followers, '→', after1.followers, '（应 +1）');
  console.log(after1.followers === base0.followers + 1 ? '  ✅ 大小写不影响计数' : '  ❌ 计数异常');

  console.log('\n=== 场景6：following 字段语义（我是否关注了他）===');
  console.log('  关注后 stats.following =', after1.following, '（应为 true，布尔）');
  console.log('  stats.followingCount   =', after1.followingCount, '（数字，他关注了多少人）');
  const okSem = after1.following === true && typeof after1.followingCount === 'number';
  console.log(okSem ? '  ✅ 两个字段语义已分离（不再把「他关注几人」当成「我是否关注」）' : '  ❌ 字段语义错乱');

  // 取关后应变 false 且记录清空
  await req('/api/users/tester01/follow', { method: 'POST', body: '{}' });
  const after2 = (await req('/api/users/tester01/stats')).json;
  console.log('  取关后 following =', after2.following, ' followers =', after2.followers);
  console.log(after2.following === false ? '  ✅ 取关后正确回落 false' : '  ❌ 取关后仍为已关注');

  // 未登录访问 stats → following 必须 false（不能因为粉丝数非零就为 true）
  for (const k of Object.keys(jar)) delete jar[k];
  await req('/api/users/tester01/follow', { method: 'POST', body: '{}' }); // 未登录调用应 401，忽略
  const anon = (await req('/api/users/tester02/stats')).json;
  console.log('  未登录访问 stats.following =', anon.following, '（应为 false）');
  console.log(anon.following === false ? '  ✅ 访客恒为 false' : '  ❌ 访客被误判为已关注');

  // 收尾
  const fin = (await req('/api/follows')).json.list || [];
  for (const it of fin) await req('/api/follows/toggle', { method: 'POST', body: JSON.stringify({ type: it.type, targetId: it.targetId, title: it.title }) });
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
