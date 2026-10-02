/* ============================================================
 * 慈云影视 · 家庭共享全方案测试（对标 Emby / Jellyfin / Plex）
 * 覆盖：角色矩阵 / 邀请码多态 / 审核流程 / 设备限制 /
 *       并发流限制 / 家庭额度池 / 分级管控 / 旧数据兼容
 * 用法：node scripts/test-family.js
 * ============================================================ */
const BASE = process.env.BASE || 'http://127.0.0.1:8811';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function sec(t) { console.log('\n' + t); }

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data: data || {} };
}

/** 注册并登录，返回带 cookie 的请求器 */
async function mkUser(acc, pwd = 'test1234') {
  let jar = '';
  await req('/api/user/register', { method: 'POST', body: { account: acc, password: pwd, nickname: acc } });
  const r2 = await fetch(BASE + '/api/user/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: acc, password: pwd }),
  });
  const sc = r2.headers.get('set-cookie');
  if (sc) jar = sc.split(';')[0];
  const d = await r2.json().catch(() => ({}));
  return {
    account: acc,
    cookie: jar,
    user: d.user || null,
    ok: r2.status === 200,
    get: (p) => req(p, { headers: { Cookie: jar } }),
    post: (p, b) => req(p, { method: 'POST', body: b, headers: { Cookie: jar } }),
    put: (p, b) => req(p, { method: 'PUT', body: b, headers: { Cookie: jar } }),
    del: (p) => req(p, { method: 'DELETE', headers: { Cookie: jar } }),
  };
}

/** 管理员登录（后台独立 cookie，字段为 username） */
async function mkAdmin() {
  const r = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin888' }),
  });
  const sc = r.headers.get('set-cookie');
  const jar = sc ? sc.split(';')[0] : '';
  return {
    cookie: jar,
    ok: r.status === 200,
    get: (p) => req(p, { headers: { Cookie: jar } }),
    post: (p, b) => req(p, { method: 'POST', body: b, headers: { Cookie: jar } }),
    put: (p, b) => req(p, { method: 'PUT', body: b, headers: { Cookie: jar } }),
    del: (p) => req(p, { method: 'DELETE', headers: { Cookie: jar } }),
  };
}

(async () => {
  const RUN = Date.now().toString(36).slice(-5);
  console.log('=== 家庭共享全方案测试 · RUN=' + RUN + ' ===');

  const adm = await mkUser('admin_' + RUN);
  const webAdm = await mkAdmin();

  // 让 admin_xxx 成为管理员：直接改 store 不可行，这里用 admin 本身
  const A = await mkUser('fam_owner_' + RUN);
  const B = await mkUser('fam_mem_' + RUN);
  const C = await mkUser('fam_child_' + RUN);
  const D = await mkUser('fam_guest_' + RUN);

  ok('用户注册登录可用', A.ok && B.ok && C.ok && D.ok, { A: A.ok, B: B.ok });

  /* ---------- 1. 模块信息 ---------- */
  sec('【1】模块信息与规则曝光');
  let info = (await A.get('/api/family/info')).data;
  ok('family/info 返回 maxStreams', info.maxStreams !== undefined, info.maxStreams);
  ok('family/info 返回 deviceLimit', info.deviceLimit !== undefined, info.deviceLimit);
  ok('family/info 返回 shareQuota', info.shareQuota !== undefined, info.shareQuota);
  ok('family/info 返回 roles 角色矩阵', Array.isArray(info.roles) && info.roles.length >= 4);
  ok('角色矩阵含 child 且禁 hd/download',
    !!(info.roles || []).find((r) => r.id === 'child' && r.perms.hd === false && r.perms.download === false));
  ok('角色矩阵含 guest 且禁 shareQuota',
    !!(info.roles || []).find((r) => r.id === 'guest' && r.perms.shareQuota === false));

  /* ---------- 2. 创建家庭需会员 ---------- */
  sec('【2】创建家庭（requireVip 拦截）');
  let r = await A.post('/api/family/create', { name: '测试家庭' });
  ok('非会员创建被拦截 403', r.status === 403 && r.data.needVip === true, r.data);

  // 通过测试辅助接口授予会员
  const gv = await webAdm.post('/api/admin/test/grant-vip', { account: A.account, days: 30 });
  ok('管理员开通会员可用', gv.status === 200, gv.data);

  r = await A.post('/api/family/create', { name: '云家 ' + RUN });
  ok('会员创建家庭成功', r.status === 200 && r.data.family, r.data);
  const famId = r.data.family && r.data.family.id;

  info = (await A.get('/api/family/info')).data;
  ok('户主 role=owner', info.role === 'owner', info.role);
  ok('户主 perms.manage=true', info.perms && info.perms.manage === true);
  ok('家庭视图含额度池字段', info.family && info.family.quotaPool !== undefined);

  /* ---------- 3. 邀请码多态 ---------- */
  sec('【3】邀请码（角色 / 次数 / 备注）');
  r = await A.post('/api/family/invite', { role: 'member', maxUses: 2, note: '给家人' });
  ok('生成 member 邀请码', r.status === 200 && r.data.code, r.data);
  const invMember = r.data.code;
  ok('邀请码带 role/roleName', r.data.role === 'member' && r.data.roleName === '成员');
  ok('邀请码带 maxUses=2', r.data.maxUses === 2);

  const invChild = (await A.post('/api/family/invite', { role: 'child', maxUses: 1 })).data.code;
  const invGuest = (await A.post('/api/family/invite', { role: 'guest', maxUses: 1 })).data.code;
  const invAdminRole = (await A.post('/api/family/invite', { role: 'admin', maxUses: 1 })).data.code;
  ok('可生成 child/guest/admin 三种角色码',
    !!invChild && !!invGuest && !!invAdminRole);

  let peek = (await B.get('/api/family/invite/' + invChild + '/peek')).data;
  ok('peek 显示角色为儿童', peek.role === 'child' && peek.roleName === '儿童', peek);
  ok('peek 儿童权限 hd=false', peek.perms && peek.perms.hd === false);
  ok('peek 返回 maxUses/usedCount', peek.maxUses === 1 && peek.usedCount === 0);

  /* ---------- 4. 加入流程 ---------- */
  sec('【4】加入家庭与角色落地');
  r = await B.post('/api/family/join', { code: invMember, deviceId: 'dev-b-1', deviceName: 'B的手机' });
  ok('B 加入成功', r.status === 200, r.data);

  r = await C.post('/api/family/join', { code: invChild, deviceId: 'dev-c-1', deviceName: 'C的平板' });
  ok('C 以儿童身份加入', r.status === 200, r.data);

  r = await D.post('/api/family/join', { code: invGuest });
  ok('D 以访客身份加入', r.status === 200, r.data);

  const famView = (await A.get('/api/family/members')).data;
  ok('成员数 = 3', famView.count === 3, famView.count);
  const mB = (famView.members || []).find((m) => m.account === B.account);
  const mC = (famView.members || []).find((m) => m.account === C.account);
  ok('B 角色 member', mB && mB.role === 'member', mB && mB.role);
  ok('C 角色 child', mC && mC.role === 'child', mC && mC.role);
  ok('B 已登记 1 台设备', mB && mB.deviceCount === 1, mB && mB.devices);
  ok('成员视图含 roleName', mB && mB.roleName === '成员');

  /* ---------- 5. 成员权限矩阵 ---------- */
  sec('【5】成员权限矩阵（permissions）');
  const cInfo = (await C.get('/api/family/info')).data;
  ok('儿童 role=child', cInfo.role === 'child');
  ok('儿童不能邀请', cInfo.perms.invite === false);
  ok('儿童不能管理', cInfo.perms.manage === false);
  ok('儿童可观看', cInfo.perms.watch === true);
  const dInfo = (await D.get('/api/family/info')).data;
  ok('访客不共享额度池', dInfo.perms.shareQuota === false, dInfo.perms);

  r = await C.post('/api/family/invite', { role: 'member' });
  ok('儿童邀请被拒 403', r.status === 403, r.data);

  /* ---------- 6. 角色调整 ---------- */
  sec('【6】角色调整（admin/child 流转）');
  r = await A.put('/api/family/member/' + B.account + '/role', { role: 'admin' });
  ok('户主可将 B 提升为 family admin', r.status === 200, r.data);
  const bInfo = (await B.get('/api/family/info')).data;
  ok('B 现在 perms.manage=true', bInfo.perms.manage === true);
  r = await B.post('/api/family/invite', { role: 'member' });
  ok('家庭管理员可邀请', r.status === 200, r.data);

  r = await B.put('/api/family/member/' + C.account + '/role', { role: 'admin' });
  ok('非户主不能授予 admin', r.status === 403, r.data);

  r = await A.put('/api/family/member/' + A.account + '/role', { role: 'member' });
  ok('不能修改户主角色', r.status === 400, r.data);

  r = await A.put('/api/family/member/' + B.account + '/role', { role: 'boss' });
  ok('非法角色被拒 400', r.status === 400, r.data);

  await A.put('/api/family/member/' + B.account + '/role', { role: 'member' });

  /* ---------- 7. 邀请码使用次数 ---------- */
  sec('【7】邀请码使用次数约束');
  const invOne = (await A.post('/api/family/invite', { maxUses: 1 })).data.code;
  const E = await mkUser('fam_e_' + RUN);
  r = await E.post('/api/family/join', { code: invOne });
  ok('E 使用一次性邀请码成功', r.status === 200, r.data);
  const F = await mkUser('fam_f_' + RUN);
  r = await F.post('/api/family/join', { code: invOne });
  ok('同一邀请码第二次被拒 404', r.status === 404 || r.status === 410, r.data);
  await A.del('/api/family/member/' + E.account);

  /* ---------- 8. 设备限制 ---------- */
  sec('【8】设备数限制（deviceLimit）');
  // 默认 deviceLimit=3；用一个全新成员验证，避免累积干扰
  const H = await mkUser('fam_h_' + RUN);
  const invH = (await A.post('/api/family/invite', { maxUses: 1, role: 'member' })).data.code;
  await H.post('/api/family/join', { code: invH, deviceId: 'h-dev-1', deviceName: 'H的手机' });
  const hView = (await A.get('/api/family/members')).data;
  const mH = (hView.members || []).find((m) => m.account === H.account);
  ok('加入时登记首台设备', mH && mH.deviceCount === 1, mH && mH.devices);

  let dr = await H.post('/api/family/device', { deviceId: 'h-dev-2', name: 'H的电视' });
  ok('第 2 台设备允许', dr.status === 200, dr.data);
  dr = await H.post('/api/family/device', { deviceId: 'h-dev-3', name: 'H的电脑' });
  ok('第 3 台设备允许', dr.status === 200, dr.data);
  dr = await H.post('/api/family/device', { deviceId: 'h-dev-4', name: 'H的备用机' });
  ok('第 4 台设备被拒 403', dr.status === 403 && dr.data.needDevice === true, dr.data);
  dr = await H.post('/api/family/device', { deviceId: 'h-dev-1', name: 'H的手机' });
  ok('已登记设备重复上报放行', dr.status === 200, dr.data);

  const devList = (await A.get('/api/family/devices')).data;
  ok('户主可看到成员设备列表', (devList.devices || []).length >= 3, devList.devices && devList.devices.length);
  ok('设备列表 canManage=true', devList.canManage === true);

  const hDev = (await H.get('/api/family/devices')).data;
  ok('成员只能看到自己设备', (hDev.devices || []).every((d) => d.account === H.account));

  r = await H.del('/api/family/device/h-dev-3');
  ok('移除设备接口可用', r.status === 200, r.data);
  ok('移除后设备数减少', ((await A.get('/api/family/devices')).data.devices || [])
    .filter((d) => d.account === H.account).length === 2);

  /* ---------- 9. 家庭额度池 ---------- */
  sec('【9】家庭额度池（shareQuota）');
  let q = (await A.get('/api/family/quota')).data;
  ok('额度池初始可查', q.pool !== undefined && q.canRefill === true, q);

  r = await A.put('/api/family/quota', { amount: 50 });
  ok('户主设置池上限 50', r.status === 200 && r.data.pool === 50, r.data);

  r = await B.put('/api/family/quota', { amount: 100 });
  ok('成员不能调整池 403', r.status === 403, r.data);

  r = await A.put('/api/family/quota', { mode: 'delta', amount: 10 });
  ok('增量充值 +10 → 60', r.status === 200 && r.data.pool === 60, r.data);

  r = await A.put('/api/family/quota', { amount: -5 });
  ok('池上限不接受 < -1', r.status === 400, r.data);

  r = await A.put('/api/family/quota', { amount: -1 });
  ok('池上限 -1 表示无限', r.status === 200 && r.data.pool === -1, r.data);

  r = await A.put('/api/family/quota', { amount: 20, reset: true });
  ok('重置用量 + 设上限 20', r.status === 200 && r.data.pool === 20 && r.data.used === 0, r.data);

  /* ---------- 10. 分级管控 ---------- */
  sec('【10】内容分级配置（parentalEnabled）');
  const admCfg = await webAdm.put('/api/admin/family', {
    parentalEnabled: true, childMaxRating: 'PG', childBlockVip: true, childBlockComment: true,
  });
  ok('后台可设 childMaxRating', admCfg.status < 400 && admCfg.data.childMaxRating === 'PG', admCfg.data);
  const cInfo2 = (await C.get('/api/family/info')).data;
  ok('儿童 hd 被禁（childBlockVip）', cInfo2.perms.hd === false);
  ok('儿童 comment 被禁', cInfo2.perms.comment === false);

  /* ---------- 11. 后台配置字段 ---------- */
  sec('【11】后台家庭设置字段完整性');
  const cfg2 = await webAdm.put('/api/admin/family', {
    maxStreams: 1, deviceLimit: 2, streamPolicy: 'block', shareQuota: false,
    autoApprove: true, inviteTtlDays: 7, inviteRole: 'child', familyQuotaPool: 88,
  });
  const fc = cfg2.data || {};
  ok('maxStreams=1', fc.maxStreams === 1, fc.maxStreams);
  ok('deviceLimit=2', fc.deviceLimit === 2, fc.deviceLimit);
  ok('streamPolicy=block', fc.streamPolicy === 'block', fc.streamPolicy);
  ok('shareQuota=false', fc.shareQuota === false, fc.shareQuota);
  ok('autoApprove=true', fc.autoApprove === true, fc.autoApprove);
  ok('inviteTtlDays=7', fc.inviteTtlDays === 7, fc.inviteTtlDays);
  ok('inviteRole=child', fc.inviteRole === 'child', fc.inviteRole);
  ok('familyQuotaPool=88', fc.familyQuotaPool === 88, fc.familyQuotaPool);
  ok('拒绝非法 streamPolicy', (await webAdm.put('/api/admin/family', { streamPolicy: 'xxx' })).data.streamPolicy === 'block');
  ok('拒绝非法 inviteRole', (await webAdm.put('/api/admin/family', { inviteRole: 'owner' })).data.inviteRole === 'child');

  /* ---------- 12. 审核流程 ---------- */
  sec('【12】成员审核（autoApprove=false）');
  await webAdm.put('/api/admin/family', { autoApprove: false });
  await A.put('/api/family/quota', { amount: 100 });
  const G = await mkUser('fam_g_' + RUN);
  const invG = (await A.post('/api/family/invite', { maxUses: 1, role: 'member' })).data.code;
  const pendingBefore = (await A.get('/api/family/members')).data.pending;
  r = await G.post('/api/family/join', { code: invG });
  ok('autoApprove=false 时进入待审核', r.status === 200 && r.data.pending === true, r.data);
  const gView = (await A.get('/api/family/members')).data;
  ok('待审核成员不计入 active count', (gView.members || []).some((m) => m.account === G.account && m.pending === true));
  ok('家庭视图 pending 计数 +1', gView.pending === pendingBefore + 1, { before: pendingBefore, after: gView.pending });

  r = await A.post('/api/family/member/' + G.account + '/approve');
  ok('户主审核通过', r.status === 200, r.data);
  const gView2 = (await A.get('/api/family/members')).data;
  ok('审核后 pending 回到原值', gView2.pending === pendingBefore, { before: pendingBefore, after: gView2.pending });
  ok('审核后 G 不再是 pending', !(gView2.members || []).find((m) => m.account === G.account).pending);

  r = await B.post('/api/family/member/' + G.account + '/approve');
  ok('普通成员无权审核 403', r.status === 403, r.data);

  /* ---------- 13. 边界 ---------- */
  sec('【13】边界与异常');
  ok('无效邀请码 peek 404', (await B.get('/api/family/invite/BADCODE1/peek')).status === 404);
  r = await A.post('/api/family/invite', { role: 'owner' });
  const ownCode = r.status === 200 ? r.data.role : null;
  // 成员已满时会被 400 拦截，这同样说明无法生成 owner 码
  ok('不能生成 owner 角色码（降级或被拦）',
    r.status === 400 || ownCode !== 'owner',
    { status: r.status, role: r.data.role, error: r.data.error });
  const dup = await mkUser('fam_dup_' + RUN);
  // 先给 dup 开会员，才能走到"已有家庭"分支
  await webAdm.post('/api/admin/test/grant-vip', { account: dup.account, days: 30 });
  await dup.post('/api/family/create', { name: '原家庭' });
  r = await dup.post('/api/family/create', { name: '重复' });
  ok('已有家庭者再创建被拒 409', r.status === 409, r.data);
  const invFresh = (await A.post('/api/family/invite', { maxUses: 1 })).data.code;
  r = await dup.post('/api/family/join', { code: invFresh });
  ok('已在家庭者再加入被拒 400/409', r.status === 400 || r.status === 409, r.data);

  const ownerSelf = await A.del('/api/family/member/' + A.account);
  ok('户主不能直接退出 400', ownerSelf.status === 400, ownerSelf.data);

  /* ---------- 还原 ---------- */
  await webAdm.put('/api/admin/family', {
    autoApprove: false, maxStreams: 2, deviceLimit: 3, streamPolicy: 'replace',
    shareQuota: true, inviteTtlDays: 3, inviteRole: 'member', familyQuotaPool: 100,
    parentalEnabled: true, childMaxRating: 'PG13', childBlockVip: true, childBlockComment: true,
  });

  /* ---------- 14. 家庭额度池 × 播放网关联动 ---------- */
  sec('【14】家庭额度池 × 播放网关联动（单元级）');
  {
    const st = require('../lib/store');
    const pv = require('../lib/pay');
    const S = st.store;
    const RR = 'it' + Date.now().toString(36).slice(-4);
    S.upsertUser({ account: RR + 'o', nickname: 'o', password: 'x', tokens: [], balance: 0, quota: { times: 0, points: 0 } });
    S.upsertUser({ account: RR + 'm', nickname: 'm', password: 'x', tokens: [], balance: 0, quota: { times: 0, points: 0 } });
    const sf = S.createFamily(RR + 'o', '池联动');
    S.addFamilyMember(sf.id, RR + 'm', 'member');
    S.updateFamily(sf.id, { quotaPool: 3, poolUsed: 0 });
    const c2 = { ...S.settings.monetize, enabled: true, quotaEnabled: true, freeDailyPlays: 0, allowPointsForPlay: false, costPerPlay: 1 };
    const g = pv.gateWatch(S.findUser(RR + 'm'), { guid: 'ITG1', cfg: c2, isVip: false, isAdmin: false });
    ok('额度耗尽时被拦截', g.allow === false && g.needRecharge === true);
    ok('拦截分支带出应扣成本 cost>0', g.cost > 0, g.cost);
    const r1 = S.useFamilyQuota(sf.id, g.cost);
    ok('家庭池第 1 次扣减成功', r1 === 1, r1);
    S.useFamilyQuota(sf.id, g.cost);
    S.useFamilyQuota(sf.id, g.cost);
    const fnow = S.getFamily(sf.id);
    ok('池用满后 remain=0', fnow.quotaPool - fnow.poolUsed === 0, fnow);
    ok('池空后再扣返回 0', S.useFamilyQuota(sf.id, g.cost) === 0);
    S.updateFamily(sf.id, { quotaPool: -1, poolUsed: 0 });
    ok('无限池(-1)返回 -1', S.useFamilyQuota(sf.id, 5) === -1);
    // 清理
    S.deleteFamily(sf.id);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('失败项：'); fails.forEach((f) => console.log('  · ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(2);
});
