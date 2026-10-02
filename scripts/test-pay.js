#!/usr/bin/env node
/**
 * 慈云影视 · 收费机制端到端测试
 * 覆盖：套餐 → 下单 → 模拟支付 → 会员发放 → 续期叠加 → 余额充值
 *       兑换码（会员/余额）→ 余额支付 → 退款 → 收入统计
 */
'use strict';

const BASE = process.env.BASE || 'http://localhost:8811';

let pass = 0, fail = 0;
const results = [];

async function req(method, path, body, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie().join('; ') : (res.headers.get('set-cookie') || '');
  return { status: res.status, data, cookie: setCookie };
}

function check(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

/** 提取 cookie 中的某个值 */
function cookieOf(setCookie, name) {
  const m = new RegExp(name + '=([^;]+)').exec(setCookie || '');
  return m ? `${name}=${m[1]}` : '';
}

(async () => {
  console.log('\n══════ 慈云影视 · 收费机制端到端测试 ══════\n');

  /* ---------- 0. 准备：管理员开启付费模块 ---------- */
  console.log('【0】管理员配置');
  const al = await req('POST', '/api/admin/login', { username: 'admin', password: 'admin888' });
  const adminCookie = cookieOf(al.cookie, 'cy_token');
  check('管理员登录', al.status === 200 && !!adminCookie);

  const plans = [
    { id: 'vip_month', name: '月度会员', days: 30, price: 12, originalPrice: 18, badge: '', recommended: false, perks: ['去广告', '超清画质'] },
    { id: 'vip_year', name: '年度会员', days: 365, price: 98, originalPrice: 144, badge: '最划算', recommended: true, perks: ['去广告', '超清画质', '家庭共享'] },
  ];
  const setM = await req('PUT', '/api/admin/monetize', {
    enabled: true, mode: 'optional', provider: 'mock', testMode: true,
    allowBalance: true, redeemEnabled: true, minRecharge: 1,
    rechargePresets: [10, 50, 100], orderTimeout: 30, plans,
  }, adminCookie);
  check('保存付费配置', setM.status === 200 && setM.data.enabled === true);
  check('配置回显套餐数', (setM.data.plans || []).length === 2);
  check('配置回显收费模式', setM.data.mode === 'optional');

  /* ---------- 1. 注册测试用户 ---------- */
  console.log('\n【1】用户注册与登录');
  const acc = 'paytest' + Date.now().toString(36).slice(-5);
  const reg = await req('POST', '/api/user/register', { account: acc, password: 'Test12345', nickname: '支付测试' });
  check('注册成功', reg.status === 200);
  const userCookie = cookieOf(reg.cookie, 'cy_user');
  check('拿到用户会话', !!userCookie);

  /* ---------- 2. 会员中心信息 ---------- */
  console.log('\n【2】会员中心信息');
  const vi = await req('GET', '/api/vip/info', null, userCookie);
  check('获取会员信息', vi.status === 200);
  check('返回套餐列表', (vi.data.plans || []).length === 2);
  check('套餐含省额计算', (vi.data.plans || []).every((p) => 'save' in p && 'perDay' in p));
  check('返回支付方式', (vi.data.payMethods || []).length >= 1);
  check('初始非会员', vi.data.vip && vi.data.vip.active === false);
  check('初始余额为 0', vi.data.vip && vi.data.vip.balance === 0);

  /* ---------- 3. 在线下单 → 模拟支付 → 发放会员 ---------- */
  console.log('\n【3】购买会员（在线支付）');
  const o1 = await req('POST', '/api/vip/order', { type: 'vip', planId: 'vip_month', payMethod: 'alipay' }, userCookie);
  check('下单成功', o1.status === 200 && o1.data.ok);
  check('订单为待支付', o1.data.order && o1.data.order.status === 'pending');
  check('金额正确 12 元', o1.data.order && o1.data.order.amount === 12);
  check('订单号格式 CY 开头', o1.data.order && /^CY\d{20}$/.test(o1.data.order.id));
  check('返回支付指令(mock)', o1.data.payment && o1.data.payment.mode === 'mock');
  const orderId1 = o1.data.order.id;

  const badPay = await req('POST', '/api/pay/mock', { orderId: 'CY00000000000000000000' }, userCookie);
  check('支付不存在的订单被拒', badPay.status === 404);

  const pay1 = await req('POST', '/api/pay/mock', { orderId: orderId1 }, userCookie);
  check('模拟支付成功', pay1.status === 200 && pay1.data.ok);
  check('订单状态变为已支付', pay1.data.order && pay1.data.order.status === 'paid');
  check('会员已生效', pay1.data.vip && pay1.data.vip.active === true);
  check('会员剩余约 30 天', pay1.data.vip && pay1.data.vip.daysLeft >= 29 && pay1.data.vip.daysLeft <= 30);

  /* ---------- 4. 幂等性 ---------- */
  console.log('\n【4】幂等与重复回调');
  const payAgain = await req('POST', '/api/pay/mock', { orderId: orderId1 }, userCookie);
  check('重复支付不报错', payAgain.status === 200);
  const viAfter = await req('GET', '/api/vip/info', null, userCookie);
  check('重复支付未叠加时长', viAfter.data.vip.daysLeft <= 30, `实际 ${viAfter.data.vip.daysLeft} 天`);

  /* ---------- 5. 续期叠加 ---------- */
  console.log('\n【5】会员续期叠加');
  const o2 = await req('POST', '/api/vip/order', { type: 'vip', planId: 'vip_month' }, userCookie);
  await req('POST', '/api/pay/mock', { orderId: o2.data.order.id }, userCookie);
  const viRenew = await req('GET', '/api/vip/info', null, userCookie);
  check('续期后约 60 天', viRenew.data.vip.daysLeft >= 59 && viRenew.data.vip.daysLeft <= 60, `实际 ${viRenew.data.vip.daysLeft} 天`);

  /* ---------- 6. 余额充值 ---------- */
  console.log('\n【6】余额充值');
  const o3 = await req('POST', '/api/vip/order', { type: 'recharge', amount: 100, payMethod: 'wxpay' }, userCookie);
  check('充值下单成功', o3.status === 200 && o3.data.order.type === 'recharge');
  check('充值金额 100', o3.data.order.amount === 100);
  await req('POST', '/api/pay/mock', { orderId: o3.data.order.id }, userCookie);
  const wallet1 = await req('GET', '/api/user/wallet', null, userCookie);
  check('余额已到账 100', wallet1.data.balance === 100, `实际 ${wallet1.data.balance}`);

  const lowRecharge = await req('POST', '/api/vip/order', { type: 'recharge', amount: 0.5 }, userCookie);
  check('低于最低充值被拒', lowRecharge.status === 400);

  /* ---------- 7. 余额支付 ---------- */
  console.log('\n【7】余额支付');
  const o4 = await req('POST', '/api/vip/order', { type: 'vip', planId: 'vip_month', useBalance: true }, userCookie);
  check('余额支付直接完成', o4.status === 200 && o4.data.paid === true);
  check('余额扣款 12 元', o4.data.vip.balance === 88, `实际 ${o4.data.vip.balance}`);
  check('会员时长叠加到约 90 天', o4.data.vip.daysLeft >= 89 && o4.data.vip.daysLeft <= 90, `实际 ${o4.data.vip.daysLeft} 天`);

  const bigOrder = await req('POST', '/api/vip/order', { type: 'vip', planId: 'vip_year', useBalance: true }, userCookie);
  await req('POST', '/api/vip/order', { type: 'vip', planId: 'vip_year', useBalance: true }, userCookie);
  const emptied = await req('GET', '/api/user/wallet', null, userCookie);
  const o5 = await req('POST', '/api/vip/order', { type: 'vip', planId: 'vip_year', useBalance: true }, userCookie);
  check('余额不足被拒并提示充值', o5.status === 400 && o5.data.needRecharge === true, `余额 ${emptied.data.balance}`);

  /* ---------- 8. 兑换码：会员 ---------- */
  console.log('\n【8】兑换码 - 会员时长');
  const mk1 = await req('POST', '/api/admin/redeem', { type: 'vip', value: 90, planName: '季度会员', count: 3, ttlDays: 30, batch: 'TEST' }, adminCookie);
  check('生成 3 个会员兑换码', mk1.status === 200 && mk1.data.count === 3);
  const vipCode = mk1.data.codes[0].code;
  check('兑换码格式 4-4-4-4', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(vipCode), vipCode);

  const before = (await req('GET', '/api/vip/info', null, userCookie)).data.vip.daysLeft;
  const rd1 = await req('POST', '/api/user/redeem', { code: vipCode }, userCookie);
  check('兑换会员成功', rd1.status === 200 && rd1.data.ok);
  check('兑换后增加 90 天', rd1.data.vip.daysLeft >= before + 89, `${before} → ${rd1.data.vip.daysLeft}`);

  const rdAgain = await req('POST', '/api/user/redeem', { code: vipCode }, userCookie);
  check('重复兑换被拒', rdAgain.status === 400);

  const rdFuzzy = await req('POST', '/api/user/redeem', { code: mk1.data.codes[1].code.replace(/-/g, '').toLowerCase() }, userCookie);
  check('兑换码容错（无横线小写）', rdFuzzy.status === 200);

  const rdBad = await req('POST', '/api/user/redeem', { code: 'AAAA-BBBB-CCCC-DDDD' }, userCookie);
  check('无效兑换码被拒', rdBad.status === 400);

  /* ---------- 9. 兑换码：余额 ---------- */
  console.log('\n【9】兑换码 - 余额充值');
  const mk2 = await req('POST', '/api/admin/redeem', { type: 'balance', value: 50, count: 1, batch: 'TEST' }, adminCookie);
  const balCode = mk2.data.codes[0].code;
  const balBefore = (await req('GET', '/api/user/wallet', null, userCookie)).data.balance;
  const rd2 = await req('POST', '/api/user/redeem', { code: balCode }, userCookie);
  check('兑换余额成功', rd2.status === 200 && rd2.data.redeem.type === 'balance');
  const balAfter = (await req('GET', '/api/user/wallet', null, userCookie)).data.balance;
  check('余额增加 50 元', Math.abs(balAfter - (balBefore + 50)) < 0.01, `${balBefore} → ${balAfter}`);

  /* ---------- 10. 订单列表与取消 ---------- */
  console.log('\n【10】订单管理');
  const myOrders = await req('GET', '/api/user/orders', null, userCookie);
  check('我的订单可查', myOrders.status === 200 && myOrders.data.list.length >= 5);
  check('订单含钱包信息', myOrders.data.wallet && typeof myOrders.data.wallet.balance === 'number');

  const oCancel = await req('POST', '/api/vip/order', { type: 'vip', planId: 'vip_month' }, userCookie);
  const cxl = await req('POST', `/api/user/order/${oCancel.data.order.id}/cancel`, null, userCookie);
  check('取消待支付订单', cxl.status === 200);
  const afterCancel = await req('GET', `/api/user/order/${oCancel.data.order.id}`, null, userCookie);
  check('订单状态为已取消', afterCancel.data.order.status === 'cancelled');

  /* ---------- 11. 越权防护 ---------- */
  console.log('\n【11】越权防护');
  const acc2 = 'hacker' + Date.now().toString(36).slice(-5);
  const reg2 = await req('POST', '/api/user/register', { account: acc2, password: 'Test12345', nickname: '他人' });
  const hackerCookie = cookieOf(reg2.cookie, 'cy_user');
  const steal = await req('GET', `/api/user/order/${orderId1}`, null, hackerCookie);
  check('无法查看他人订单', steal.status === 403);
  const paySteal = await req('POST', '/api/pay/mock', { orderId: orderId1 }, hackerCookie);
  check('无法支付他人订单', paySteal.status === 403);

  const anonWallet = await req('GET', '/api/user/wallet');
  check('未登录无法查看钱包', anonWallet.status === 401);
  const anonRedeem = await req('POST', '/api/user/redeem', { code: balCode });
  check('未登录无法兑换', anonRedeem.status === 401);

  /* ---------- 12. 后台订单与收入 ---------- */
  console.log('\n【12】后台订单与收入看板');
  const adminOrders = await req('GET', '/api/admin/orders?size=50', null, adminCookie);
  check('后台订单列表', adminOrders.status === 200 && adminOrders.data.total >= 5);
  check('订单含汇总信息', !!adminOrders.data.summary);

  const paidOnly = await req('GET', '/api/admin/orders?status=paid', null, adminCookie);
  check('按状态筛选订单', paidOnly.status === 200 && paidOnly.data.list.every((o) => o.status === 'paid'));

  const kwOrder = await req('GET', '/api/admin/orders?keyword=' + acc, null, adminCookie);
  check('按账号搜索订单', kwOrder.data.list.every((o) => o.account === acc));

  const rev = await req('GET', '/api/admin/revenue', null, adminCookie);
  check('收入看板可用', rev.status === 200);
  check('累计收入 > 0', rev.data.revenue > 0, `¥${rev.data.revenue}`);
  check('已支付订单数正确', rev.data.paidCount >= 5);
  check('近14天曲线为14点', (rev.data.days || []).length === 14);
  check('按套餐维度统计', (rev.data.byPlan || []).length >= 1);
  check('客单价已计算', rev.data.arpu > 0);
  check('付费用户数 >= 1', rev.data.payers >= 1);

  /* ---------- 13. 退款 ---------- */
  console.log('\n【13】订单退款');
  const balBeforeRefund = (await req('GET', '/api/user/wallet', null, userCookie)).data.balance;
  const refundTarget = o3.data.order.id;   // 100 元充值单
  const refund = await req('PUT', `/api/admin/orders/${refundTarget}`, { action: 'refund' }, adminCookie);
  check('退款成功', refund.status === 200 && refund.data.order.status === 'refunded');
  const balAfterRefund = (await req('GET', '/api/user/wallet', null, userCookie)).data.balance;
  check('充值单退款扣回余额', Math.abs(balAfterRefund - (balBeforeRefund - 100)) < 0.01, `${balBeforeRefund} → ${balAfterRefund}`);

  const vipBeforeRefund = (await req('GET', '/api/vip/info', null, userCookie)).data.vip.daysLeft;
  const vipOrderRefund = await req('PUT', `/api/admin/orders/${orderId1}`, { action: 'refund' }, adminCookie);
  check('会员单退款成功', vipOrderRefund.status === 200);
  const vipAfterRefund = (await req('GET', '/api/vip/info', null, userCookie)).data.vip.daysLeft;
  check(
    '退款后会员时长回退约 30 天',
    vipBeforeRefund - vipAfterRefund >= 29 || vipAfterRefund <= 0,
    `${vipBeforeRefund} → ${vipAfterRefund}`
  );

  /* ---------- 14. 后台标记支付 ---------- */
  console.log('\n【14】后台手动标记支付');
  const oManual = await req('POST', '/api/vip/order', { type: 'vip', planId: 'vip_month' }, userCookie);
  const markPaid = await req('PUT', `/api/admin/orders/${oManual.data.order.id}`, { action: 'paid' }, adminCookie);
  check('后台标记已支付', markPaid.status === 200 && markPaid.data.order.status === 'paid');

  /* ---------- 15. 兑换码后台管理 ---------- */
  console.log('\n【15】兑换码后台管理');
  const adminRedeem = await req('GET', '/api/admin/redeem?batch=TEST&size=100', null, adminCookie);
  check('兑换码列表', adminRedeem.status === 200 && adminRedeem.data.total >= 4);
  check('按批次筛选', adminRedeem.data.batches.includes('TEST'));
  const usedOnly = await req('GET', '/api/admin/redeem?status=used', null, adminCookie);
  check('筛选已使用兑换码', usedOnly.data.list.every((x) => x.used));
  const csv = await fetch(BASE + '/api/admin/redeem/export?batch=TEST', { headers: { Cookie: adminCookie } });
  const csvText = await csv.text();
  check('导出 CSV 成功', csv.status === 200 && csvText.includes('兑换码'));
  check('CSV 含中文表头', csvText.includes('面额/天数'));

  /* ---------- 16. 权限控制 ---------- */
  console.log('\n【16】后台权限');
  const noAuth = await req('GET', '/api/admin/revenue');
  check('未登录无法访问收入看板', noAuth.status === 401);
  const userTryAdmin = await req('GET', '/api/admin/orders', null, userCookie);
  check('普通用户无法访问后台订单', userTryAdmin.status === 401);

  /* ---------- 17. 收费模式：可选 ---------- */
  console.log('\n【17】可选付费模式');
  const siteInfo = await req('GET', '/api/site');
  check('站点暴露收费模式', siteInfo.data.monetize.mode === 'optional');
  check('免费观看不受影响', siteInfo.data.monetize.enabled === true);
  const homeFree = await req('GET', '/api/home');
  check('首页依然免费可用', homeFree.status === 200);

  /* ---------- 输出 ---------- */
  console.log('\n' + results.join('\n'));
  console.log('\n════════════════════════════════════════');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('════════════════════════════════════════\n');

  // 清理测试数据
  try {
    await req('PUT', '/api/admin/monetize', { enabled: false, mode: 'optional', plans }, adminCookie);
    const u2 = await req('DELETE', '/api/admin/users/' + acc2, null, adminCookie);
    const u1 = await req('DELETE', '/api/admin/users/' + acc, null, adminCookie);
    console.log('🧹 测试数据已清理（付费模块恢复关闭）\n');
  } catch (e) { console.log('清理提示:', e.message); }

  process.exit(fail ? 1 : 0);
})();
