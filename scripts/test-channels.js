#!/usr/bin/env node
'use strict';
/**
 * 慈云影视 · 支付渠道端到端测试
 * 覆盖：渠道 CRUD / 启停 / 排序 / 配置校验 / 下单路由 / 人工收款确认 / 回调验签
 * 用法：node scripts/test-channels.js [baseUrl]
 */

const BASE = process.argv[2] || 'http://localhost:8811';
let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

function jar() {
  const c = {};
  return {
    header: () => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '),
    save: (r) => {
      const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      for (const s of raw) {
        const [kv] = s.split(';');
        const i = kv.indexOf('=');
        c[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
    },
  };
}

async function req(j, path, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: j ? j.header() : '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (j) j.save(r);
  let d = null;
  const txt = await r.text();
  try { d = JSON.parse(txt); } catch { d = { _raw: txt }; }
  return { status: r.status, d, txt };
}

const rnd = () => Math.random().toString(36).slice(2, 8);

(async () => {
  console.log('\n═══ 慈云影视 · 支付渠道测试 ═══\n');

  // ---------- 准备：管理员 + 用户 ----------
  const admin = jar();
  await req(admin, '/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin888' } });

  const ua = jar();
  const acc = 'chuser' + rnd();
  await req(ua, '/api/user/register', { method: 'POST', body: { account: acc, password: 'test1234', nickname: '渠道测试' } });
  await req(ua, '/api/user/login', { method: 'POST', body: { account: acc, password: 'test1234' } });

  // ---------- [1] 渠道类型 ----------
  console.log('[1] 渠道类型元数据');
  const t = await req(admin, '/api/admin/pay/channel-types');
  const types = t.d.types || [];
  ok('返回 6 种渠道类型', types.length === 6, types.map((x) => x.id).join(','));
  for (const id of ['mock', 'epay', 'alipay', 'wxpay', 'manual', 'custom']) {
    ok(`含类型 ${id}`, types.some((x) => x.id === id));
  }
  const epayT = types.find((x) => x.id === 'epay') || {};
  ok('易支付字段齐全', (epayT.fields || []).length === 4, (epayT.fields || []).map((f) => f.k).join(','));
  ok('必填项标记正确', (epayT.fields || []).filter((f) => f.required).length === 3);
  ok('支付方式元数据', !!(t.d.methodMeta && t.d.methodMeta.alipay));

  // ---------- [2] 渠道列表 ----------
  console.log('\n[2] 渠道列表');
  let lst = await req(admin, '/api/admin/pay/channels');
  const init = lst.d.channels || [];
  ok('默认含 6 个渠道', init.length >= 6, init.length + ' 个');
  ok('mock 默认启用', init.find((c) => c.type === 'mock').enabled === true);
  ok('mock 可用', init.find((c) => c.type === 'mock').ready === true);
  // 内置未配置渠道（未启用）必须 ready=false，避免"看似可用实际不能付"
  ok('未启用的内置渠道 ready=false',
    init.filter((c) => !c.enabled).every((c) => !c.ready),
    init.filter((c) => !c.enabled).map((c) => c.id).join(',') || '(无)');
  ok('未登录不可读', (await req(null, '/api/admin/pay/channels')).status === 401);

  // ---------- [3] 新增渠道 ----------
  console.log('\n[3] 新增渠道');
  const cr = await req(admin, '/api/admin/pay/channels', {
    method: 'POST',
    body: {
      type: 'epay', name: '测试易支付', icon: '🌈', enabled: true, sort: 15,
      config: { gateway: 'https://pay.example.com/submit.php', merchantId: '2001', signKey: 'sk_test', signType: 'SHA256' },
    },
  });
  ok('新增成功', cr.status === 200 && cr.d.ok, cr.d.error || '');
  const newId = cr.d.channel && cr.d.channel.id;
  ok('返回渠道 ID', !!newId, newId);
  ok('配置校验通过', cr.d.check && cr.d.check.ok === true);
  ok('签名算法被保留', cr.d.channel.config.signType === 'SHA256', cr.d.channel.config.signType);

  // 缺必填
  const bad = await req(admin, '/api/admin/pay/channels', {
    method: 'POST', body: { type: 'alipay', name: '缺key的支付宝', enabled: true, config: { appId: '1' } },
  });
  ok('缺必填仍可保存但校验不通过', bad.status === 200 && bad.d.check.ok === false, bad.d.check && bad.d.check.error);
  const badId = bad.d.channel.id;
  await req(admin, '/api/admin/pay/channels/' + badId, { method: 'DELETE' });

  // ---------- [4] 可用渠道受付费开关约束 ----------
  console.log('\n[4] 前台渠道可读性');
  await req(admin, '/api/admin/monetize', { method: 'PUT', body: { enabled: true } });
  const pub = await req(ua, '/api/pay/channels');
  ok('付费开启后有渠道', (pub.d.channels || []).length >= 1, (pub.d.channels || []).length + ' 个');
  ok('前台不含密钥字段', !JSON.stringify(pub.d).includes('sk_test'));
  const epayPub = (pub.d.channels || []).find((c) => c.id === newId);
  ok('新渠道出现在前台', !!epayPub);
  ok('新渠道含 3 种支付方式', epayPub && epayPub.methods.length === 3, epayPub && epayPub.methods.map((m) => m.name).join('/'));

  // ---------- [5] 修改 / 启停 ----------
  console.log('\n[5] 修改与启停');
  const upd = await req(admin, '/api/admin/pay/channels/' + newId, {
    method: 'PUT', body: { name: '改名后的易支付', sort: 3 },
  });
  ok('改名生效', upd.d.channel.name === '改名后的易支付', upd.d.channel.name);
  ok('排序生效', upd.d.channel.sort === 3, String(upd.d.channel.sort));
  ok('配置未被覆盖', upd.d.channel.config.signKey === 'sk_test');

  const partial = await req(admin, '/api/admin/pay/channels/' + newId, {
    method: 'PUT', body: { config: { merchantId: '9999' } },
  });
  ok('配置局部合并不丢字段', partial.d.channel.config.gateway === 'https://pay.example.com/submit.php'
    && partial.d.channel.config.merchantId === '9999');

  const off = await req(admin, '/api/admin/pay/channels/' + newId, { method: 'PUT', body: { enabled: false } });
  ok('停用成功', off.d.channel.enabled === false);
  const pub2 = await req(ua, '/api/pay/channels');
  ok('停用后前台不可见', !(pub2.d.channels || []).some((c) => c.id === newId));
  await req(admin, '/api/admin/pay/channels/' + newId, { method: 'PUT', body: { enabled: true } });

  // ---------- [6] 排序接口 ----------
  console.log('\n[6] 批量排序');
  const all = (await req(admin, '/api/admin/pay/channels')).d.channels || [];
  const rev = all.map((c) => c.id).reverse();
  const ord = await req(admin, '/api/admin/pay/channel-order', { method: 'PUT', body: { ids: rev } });
  ok('排序接口成功', ord.status === 200 && ord.d.ok);
  const after = (await req(admin, '/api/admin/pay/channels')).d.channels || [];
  ok('顺序已改变', after[0].id === rev[0], after[0].id);

  // ---------- [7] 配置检测 ----------
  console.log('\n[7] 渠道连通性自检');
  const ck = await req(admin, '/api/admin/pay/channels/' + newId + '/test', { method: 'POST' });
  ok('自检返回 ok', ck.d.ok === true, ck.d.message);
  const ckBad = await req(admin, '/api/admin/pay/channels/ch_alipay/test', { method: 'POST' });
  ok('未配置渠道自检报错', ckBad.d.ok === false && (ckBad.d.missing || []).length > 0, ckBad.d.error);
  ok('自检需鉴权', (await req(null, '/api/admin/pay/channels/' + newId + '/test', { method: 'POST' })).status === 401);

  // ---------- [8] 下单路由到指定渠道 ----------
  console.log('\n[8] 下单路由');
  // 确保 mock 可用
  await req(admin, '/api/admin/pay/channels/ch_mock', { method: 'PUT', body: { enabled: true } });
  const vipInfo = (await req(ua, '/api/vip/info')).d;
  const plan = (vipInfo.plans || [])[0];
  ok('有可用套餐', !!plan, plan && plan.name);

  // 8.1 易支付渠道
  const o1 = await req(ua, '/api/vip/order', {
    method: 'POST', body: { type: 'vip', planId: plan.id, channelId: newId, payMethod: 'wxpay' },
  });
  ok('易支付下单成功', o1.d.ok && !o1.d.paid);
  ok('订单记录渠道', o1.d.order.channelId === newId, o1.d.order.channelId);
  ok('payment 为 epay', o1.d.payment.provider === 'epay');
  ok('payment mode=redirect', o1.d.payment.mode === 'redirect');
  ok('跳转 URL 含签名', /sign=/.test(o1.d.payment.payload.url), o1.d.payment.payload.url.slice(0, 90));
  ok('跳转 type=wxpay', /type=wxpay/.test(o1.d.payment.payload.url));
  ok('订单号透传', o1.d.payment.payload.url.includes(o1.d.order.id));

  // 8.2 mock 渠道
  const o2 = await req(ua, '/api/vip/order', {
    method: 'POST', body: { type: 'vip', planId: plan.id, channelId: 'ch_mock', payMethod: 'alipay' },
  });
  ok('mock 下单 mode=mock', o2.d.payment.mode === 'mock');
  const mp = await req(ua, '/api/pay/mock', { method: 'POST', body: { orderId: o2.d.order.id } });
  ok('模拟支付成功', mp.d.ok === true);
  ok('会员已生效', !!(mp.d.vip && mp.d.vip.active), mp.d.vip && mp.d.vip.daysLeft + ' 天');

  // 8.3 不可用渠道
  const o3 = await req(ua, '/api/vip/order', {
    method: 'POST', body: { type: 'vip', planId: plan.id, channelId: 'ch_alipay', payMethod: 'alipay' },
  });
  ok('未配置渠道下单被拒', o3.d.ok === false && /未配置完成/.test(o3.d.error || ''), o3.d.error);

  // ---------- [9] 人工收款全流程 ----------
  console.log('\n[9] 人工收款流程');
  await req(admin, '/api/admin/pay/channels/ch_manual', {
    method: 'PUT',
    body: {
      enabled: true,
      config: { qrcode: 'https://example.com/qr.png', accountName: '慈云影视', accountNo: 'alipay@ciyun.tv', instruct: '扫码后提交凭证' },
    },
  });
  const o4 = await req(ua, '/api/vip/order', {
    method: 'POST', body: { type: 'vip', planId: plan.id, channelId: 'ch_manual', payMethod: 'manual' },
  });
  ok('人工收款下单 mode=manual', o4.d.payment.mode === 'manual');
  ok('返回收款码', o4.d.payment.payload.qrcode === 'https://example.com/qr.png');
  ok('返回收款人', o4.d.payment.payload.accountName === '慈云影视');
  ok('返回金额', o4.d.payment.payload.amount === String(Number(plan.price).toFixed(2)));

  const mid = o4.d.order.id;
  const claimNoProof = await req(ua, '/api/pay/manual/claim', { method: 'POST', body: { orderId: mid } });
  ok('空凭证被拒', claimNoProof.status === 400);

  const claim = await req(ua, '/api/pay/manual/claim', {
    method: 'POST', body: { orderId: mid, proof: '转账单号 2026100200001', note: '已转账' },
  });
  ok('凭证提交成功', claim.d.ok === true);
  ok('订单转 claiming', claim.d.order.status === 'claiming', claim.d.order.status);
  ok('凭证已保存', claim.d.order.claim && claim.d.order.claim.proof === '转账单号 2026100200001');

  const beforeVip = (await req(ua, '/api/vip/info')).d.vip;
  const conf = await req(admin, '/api/admin/pay/orders/' + mid + '/confirm', { method: 'POST' });
  ok('管理员确认成功', conf.d && conf.d.ok === true);
  ok('订单转 paid', conf.d.order.status === 'paid');
  ok('payVia 标注 manual', /manual/.test(conf.d.order.payVia || ''), conf.d.order.payVia);
  const afterVip = (await req(ua, '/api/vip/info')).d.vip;
  ok('会员时长增加', afterVip.daysLeft > beforeVip.daysLeft, `${beforeVip.daysLeft} → ${afterVip.daysLeft}`);
  ok('重复确认幂等', (await req(admin, '/api/admin/pay/orders/' + mid + '/confirm', { method: 'POST' })).d.ok === true);

  // 驳回流程
  const o5 = await req(ua, '/api/vip/order', {
    method: 'POST', body: { type: 'vip', planId: plan.id, channelId: 'ch_manual' },
  });
  const rej = await req(admin, '/api/admin/pay/orders/' + o5.d.order.id + '/reject', {
    method: 'POST', body: { reason: '凭证无法识别' },
  });
  ok('驳回成功', rej.d.ok === true && rej.d.order.status === 'rejected');
  ok('驳回原因已记录', rej.d.order.rejectReason === '凭证无法识别');

  // ---------- [10] 回调验签 ----------
  console.log('\n[10] 支付回调');
  const o6 = await req(ua, '/api/vip/order', {
    method: 'POST', body: { type: 'vip', planId: plan.id, channelId: 'ch_mock' },
  });
  const cb = await req(null, '/api/pay/callback', {
    method: 'POST', body: { out_trade_no: o6.d.order.id, trade_status: 'TRADE_SUCCESS', money: plan.price },
  });
  ok('回调返回 success', cb.txt.trim() === 'success', cb.txt.trim());
  const q = await req(ua, '/api/user/order/' + o6.d.order.id);
  ok('回调后订单已支付', q.d.order.status === 'paid', q.d.order.status);

  const cbBad = await req(null, '/api/pay/callback', { method: 'POST', body: { out_trade_no: 'NOT_EXIST' } });
  ok('未知订单回调 404', cbBad.status === 404);

  // 金额不一致
  const o7 = await req(ua, '/api/vip/order', {
    method: 'POST', body: { type: 'vip', planId: plan.id, channelId: 'ch_mock' },
  });
  const cbAmt = await req(null, '/api/pay/callback', {
    method: 'POST', body: { out_trade_no: o7.d.order.id, trade_status: 'TRADE_SUCCESS', money: 0.01 },
  });
  ok('金额不一致被拒', cbAmt.status === 400, cbAmt.txt.trim());

  // ---------- [11] 删除渠道 ----------
  console.log('\n[11] 删除渠道');
  const del = await req(admin, '/api/admin/pay/channels/' + newId, { method: 'DELETE' });
  ok('删除成功', del.d.ok === true);
  const finalList = (await req(admin, '/api/admin/pay/channels')).d.channels || [];
  ok('列表已移除', !finalList.some((c) => c.id === newId));
  ok('删除需鉴权', (await req(null, '/api/admin/pay/channels/' + newId, { method: 'DELETE' })).status === 401);

  // ---------- 收尾：清理测试数据，恢复默认（保证可重复运行） ----------
  try {
    const remaining = (await req(admin, '/api/admin/pay/channels')).d.channels || [];
    for (const c of remaining) {
      // 删除本轮新增的测试渠道
      if (/^(ch_muqt|ch_测试)/.test(c.id) || (c.config && String(c.config.gateway || '').includes('pay.example.com'))) {
        await req(admin, '/api/admin/pay/channels/' + c.id, { method: 'DELETE' });
      } else if (['ch_manual'].includes(c.id)) {
        await req(admin, '/api/admin/pay/channels/' + c.id, { method: 'PUT', body: { enabled: false } });
      }
    }
    // 还原内置渠道排序
    const back = (await req(admin, '/api/admin/pay/channels')).d.channels || [];
    await req(admin, '/api/admin/pay/channel-order', {
      method: 'PUT',
      body: { ids: back.slice().sort((a, b) => (a.type === 'mock' ? -1 : a.sort - b.sort)).map((c) => c.id) },
    });
    // 付费模块恢复关闭
    await req(admin, '/api/admin/monetize', { method: 'PUT', body: { enabled: false } });
    await req(admin, '/api/admin/users/' + acc, { method: 'DELETE' });
    console.log('\n🧹 测试数据已清理（付费模块恢复关闭）');
  } catch (e) {
    console.log('\n⚠️  清理失败（不影响测试结论）:', e.message);
  }

  console.log('\n═══════════════════════════════');
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  if (fail) { console.log('  失败项：'); fails.forEach((f) => console.log('   · ' + f)); }
  console.log('═══════════════════════════════\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('💥 测试异常终止:', e.message);
  process.exit(1);
});
