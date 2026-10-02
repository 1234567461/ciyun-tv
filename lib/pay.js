'use strict';
/**
 * 慈云影视 · 支付与会员权益
 * ============================================================
 * 职责：
 *   1. 支付网关抽象（provider）：模拟支付 / 易支付风格 / 自定义回调
 *   2. 订单签名与回调校验（防伪造）
 *   3. 会员权益发放（VIP 续期叠加、余额充值、兑换码核销）
 *
 * 设计原则：
 *   · 零外部依赖，只依赖 node crypto
 *   · 开源友好：默认 mock provider，部署者填入商户信息即可切换真实支付
 *   · 幂等：同一订单重复回调不会重复发放权益
 */

const crypto = require('crypto');

/* ============================================================
 * 订单号 / 签名
 * ============================================================ */

/** 生成订单号：CY + 年月日 + 12 位随机 */
function newOrderNo() {
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const rnd = crypto.randomInt(0, 1e12).toString().padStart(12, '0');
  return 'CY' + ymd + rnd;
}

/**
 * 参与签名的参数拼接：按 key 升序，剔除空值与 sign 本身
 */
function signParams(params, key) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const raw = keys.map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('md5').update(raw + key).digest('hex');
}

/** 校验签名（常量时间比较） */
function verifySign(params, key) {
  const expect = signParams(params, key);
  const got = String(params.sign || '');
  if (expect.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got));
}

/* ============================================================
 * 支付网关
 * ============================================================ */

/**
 * 构建支付请求
 * @param {object} cfg  monetize 配置
 * @param {object} order 订单
 * @param {string} baseUrl 站点根地址（用于回调）
 * @returns {{ provider, mode, payload, tip }}
 *   mode:
 *     'mock'    — 前端展示「模拟支付」按钮，直接打回调
 *     'qrcode'  — 返回二维码内容（真实网关）
 *     'redirect'— 返回需跳转的 URL
 */
function buildPayment(cfg, order, baseUrl) {
  const provider = cfg.provider || 'mock';
  const notify = cfg.notifyUrl || (baseUrl ? baseUrl.replace(/\/+$/, '') + '/api/pay/callback' : '');
  const ret = baseUrl ? baseUrl.replace(/\/+$/, '') + '/#/vip?order=' + order.id : '';

  if (provider === 'mock') {
    return {
      provider: 'mock',
      mode: 'mock',
      tip: '当前为演示支付模式，点击下方按钮即可模拟支付成功',
      payload: { orderId: order.id, endpoint: '/api/pay/mock' },
    };
  }

  // 易支付（epay）风格：构造提交参数
  const params = {
    pid: cfg.merchantId || '',
    type: order.payMethod === 'wxpay' ? 'wxpay' : 'alipay',
    out_trade_no: order.id,
    notify_url: notify,
    return_url: ret,
    name: order.planName || '会员服务',
    money: Number(order.amount).toFixed(2),
  };
  params.sign = signParams(params, cfg.signKey || '');
  params.sign_type = 'MD5';

  if (provider === 'epay') {
    const gateway = cfg.gateway || '';
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return {
      provider: 'epay',
      mode: 'redirect',
      tip: '即将跳转到支付页面',
      payload: { url: gateway ? `${gateway}?${qs}` : '', params },
    };
  }

  // custom：完全交给部署者，前端按 payload 自行处理
  return {
    provider: 'custom',
    mode: 'custom',
    tip: '请按自定义支付流程完成支付',
    payload: { params, notify },
  };
}

/** 支付方式列表 */
function payMethods(cfg) {
  return [
    { id: 'alipay', name: '支付宝', icon: '🅰️' },
    { id: 'wxpay', name: '微信支付', icon: '💚' },
    { id: 'qqpay', name: 'QQ 钱包', icon: '🐧' },
  ].filter((m) => {
    // mock 模式全展示，真实模式按 provider 支持情况
    if ((cfg.provider || 'mock') === 'mock') return true;
    return true;
  });
}

/* ============================================================
 * 会员权益发放
 * ============================================================ */

/**
 * 计算 VIP 到期时间（续期叠加）
 * 未过期则在原到期时间上叠加，已过期则从当前时间算起
 */
function nextExpire(user, days) {
  const now = Date.now();
  const cur = user && user.vip && user.vip.expire ? user.vip.expire : 0;
  const base = cur > now ? cur : now;
  return base + Number(days) * 86400000;
}

/**
 * 发放会员权益（幂等标记由调用方保证）
 * @returns {object} 新的 vip 对象
 */
function grantVip(user, plan) {
  const days = Number(plan.days) || 30;
  const expire = nextExpire(user, days);
  const now = Date.now();
  const wasVip = user.vip && user.vip.expire > now;
  user.vip = {
    level: plan.id || 'vip',
    name: plan.name || '会员',
    expire,
    since: wasVip && user.vip.since ? user.vip.since : now,
    lastPlan: plan.id || 'vip',
  };
  return user.vip;
}

/** 计算会员剩余天数（不足 1 天按 0 计） */
function vipDaysLeft(user) {
  if (!user || !user.vip || !user.vip.expire) return 0;
  const left = user.vip.expire - Date.now();
  return left > 0 ? Math.ceil(left / 86400000) : 0;
}

/* ============================================================
 * 兑换码核销逻辑
 * ============================================================ */

/**
 * 校验兑换码可用性
 * @returns {{ ok:true } | { ok:false, error:string }}
 */
function checkRedeem(rec) {
  if (!rec) return { ok: false, error: '兑换码不存在' };
  if (rec.used) return { ok: false, error: '该兑换码已被使用' };
  if (rec.expire && rec.expire < Date.now()) return { ok: false, error: '该兑换码已过期' };
  return { ok: true };
}

/**
 * 执行兑换
 * @returns {{ type, value, vip?, balance?, tip }}
 */
function applyRedeem(rec, user) {
  if (rec.type === 'balance') {
    const amount = Number(rec.value) || 0;
    user.balance = Math.round(((user.balance || 0) + amount) * 100) / 100;
    return { type: 'balance', value: amount, balance: user.balance, tip: `已充值 ${amount} 元到余额` };
  }
  // 会员时长
  const days = Number(rec.value) || 30;
  const vip = grantVip(user, { id: rec.planName || 'redeem', name: rec.planName || '会员兑换', days });
  return { type: 'vip', value: days, vip, tip: `已兑换 ${days} 天会员` };
}

module.exports = {
  newOrderNo,
  signParams,
  verifySign,
  buildPayment,
  payMethods,
  nextExpire,
  grantVip,
  vipDaysLeft,
  checkRedeem,
  applyRedeem,
};
