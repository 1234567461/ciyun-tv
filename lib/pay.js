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
 * 额度系统（观看次数 / 通用点数）
 * ============================================================ */

/** 把日期归一成 yyyy-mm-dd（用于每日免费额度窗口） */
function dayKeyOf(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 归一化用户额度（不改动原对象） */
function ensureQuota(user) {
  const q = (user && user.quota) || {};
  return {
    times: Number.isFinite(q.times) ? q.times : 0,
    points: Number.isFinite(q.points) ? q.points : 0,
    usedPlays: Number(q.usedPlays) || 0,
    usedPoints: Number(q.usedPoints) || 0,
    dayKey: q.dayKey || '',
    dayUsed: Number(q.dayUsed) || 0,
    plays: q.plays || {},
  };
}

/** 增值功能的点数单价 */
function costOf(cfg, feature) {
  const table = (cfg && cfg.pointCosts) || {};
  const key = ['play', 'hd', 'download', 'noAd'].includes(feature) ? feature : 'play';
  const n = Number(table[key]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 额度视图（给前端展示）
 * @param {object} user
 * @param {{isAdmin?:boolean, isVip?:boolean}} opts
 */
function quotaView(user, opts = {}) {
  const cfg = (opts.cfg) || {};
  const enabled = !!cfg.quotaEnabled;
  if (opts.isAdmin) {
    return {
      enabled,
      unlimited: true, isAdmin: true, isVip: true,
      times: -1, points: -1,
      timesText: '∞', pointsText: '∞',
      freeDaily: 0, freeUsed: 0, freeRemain: 0,
      costPerPlay: 0, pointCosts: cfg.pointCosts || {},
      usedPlays: 0, usedPoints: 0,
    };
  }
  if (!user) {
    return {
      enabled,
      unlimited: false, isAdmin: false, isVip: false,
      times: 0, points: 0,
      timesText: '0', pointsText: '0',
      freeDaily: Number(cfg.freeDailyPlays) || 0,
      freeUsed: 0,
      freeRemain: Number(cfg.freeDailyPlays) || 0,
      costPerPlay: Number(cfg.costPerPlay) || 1,
      pointCosts: cfg.pointCosts || {},
      usedPlays: 0, usedPoints: 0,
    };
  }
  const q = ensureQuota(user);
  const today = dayKeyOf();
  const freeDaily = Math.max(0, Number(cfg.freeDailyPlays) || 0);
  const freeUsed = q.dayKey === today ? q.dayUsed : 0;
  const isVipNow = !!opts.isVip;
  return {
    enabled,
    unlimited: q.times === -1 && q.points === -1,
    isAdmin: false,
    isVip: isVipNow,
    times: q.times,
    points: q.points,
    timesText: q.times === -1 ? '∞' : String(q.times),
    pointsText: q.points === -1 ? '∞' : String(q.points),
    freeDaily: isVipNow && cfg.vipFreePlays !== false ? -1 : freeDaily,
    freeUsed,
    freeRemain: isVipNow && cfg.vipFreePlays !== false ? -1 : Math.max(0, freeDaily - freeUsed),
    costPerPlay: Math.max(1, Number(cfg.costPerPlay) || 1),
    pointCosts: cfg.pointCosts || {},
    usedPlays: q.usedPlays,
    usedPoints: q.usedPoints,
  };
}

/**
 * 观看额度网关（纯判定，不落库；由调用方在通过后 commitWatch）
 * @param {object|null} user 用户对象（未登录传 null）
 * @param {object} opts { guid, cfg, isVip, isAdmin }
 * @returns {{allow:boolean, cost:number, source:string, dayKey?:string, dayUsed?:number,
 *            error?:string, needLogin?:boolean, needQuota?:boolean, needVip?:boolean,
 *            needRecharge?:boolean, quota:object}}
 */
function gateWatch(user, opts = {}) {
  const cfg = opts.cfg || {};
  const guid = String(opts.guid || '');
  const q = ensureQuota(user);
  const today = dayKeyOf();

  const base = {
    allow: true, cost: 0, source: 'free',
    quota: quotaView(user, { cfg, isAdmin: opts.isAdmin, isVip: opts.isVip }),
  };

  // 1) 付费模块或额度系统未开启 → 完全放行
  if (!cfg.enabled || !cfg.quotaEnabled) {
    return { ...base, source: 'off' };
  }
  // 2) 管理员 → 放行
  if (opts.isAdmin) {
    return { ...base, source: 'admin' };
  }
  // 3) 未登录 → 按配置要求登录
  if (!user) {
    if (cfg.requireLogin !== false) {
      return { ...base, allow: false, needLogin: true, error: '请先登录后再观看' };
    }
    const freeDaily0 = Math.max(0, Number(cfg.freeDailyPlays) || 0);
    if (freeDaily0 > 0) return { ...base, source: 'free', dayKey: today, dayUsed: 1 };
    return {
      ...base, allow: false, needQuota: true, needVip: true,
      error: '观看额度已用完，请登录后兑换额度或开通会员',
    };
  }
  // 4) 会员免观看额度
  if (opts.isVip && cfg.vipFreePlays !== false) {
    return { ...base, source: 'vip' };
  }
  // 5) 每日免费额度
  const freeDaily = Math.max(0, Number(cfg.freeDailyPlays) || 0);
  const dayUsed = q.dayKey === today ? q.dayUsed : 0;
  if (dayUsed < freeDaily) {
    return { ...base, source: 'free', dayKey: today, dayUsed: dayUsed + 1 };
  }
  // 6) 幂等：同一影片当日重复观看不再扣
  const lastTs = guid ? q.plays[guid] : 0;
  if (cfg.dedupeDaily !== false && lastTs && dayKeyOf(lastTs) === today) {
    return { ...base, source: 'times', cost: 0 };
  }
  // 7) 观看次数额度
  const costPerPlay = Math.max(1, Number(cfg.costPerPlay) || 1);
  if (q.times === -1) return { ...base, source: 'times', cost: 0 };
  if (q.times >= costPerPlay) return { ...base, source: 'times', cost: costPerPlay };
  // 8) 通用点数抵扣
  const playCost = costOf(cfg, 'play');
  if (cfg.allowPointsForPlay !== false && playCost > 0) {
    if (q.points === -1) return { ...base, source: 'points', cost: 0 };
    if (q.points >= playCost) return { ...base, source: 'points', cost: playCost };
  }
  // 9) 拦截
  return {
    ...base, allow: false,
    needQuota: true, needVip: true, needRecharge: true,
    error: '观看额度已用完，可通过兑换码获取额度或开通会员',
  };
}

/**
 * 校验并计算增值功能的点数消耗
 * @returns {{ ok:boolean, cost:number, free:boolean, error?:string, needPoints?:number, points?:number }}
 */
function checkSpend(user, feature, cfg = {}, opts = {}) {
  const cost = costOf(cfg, feature);
  if (!cfg.enabled || !cfg.quotaEnabled) return { ok: true, cost: 0, free: true };
  if (opts.isAdmin) return { ok: true, cost: 0, free: true };
  // 会员在四项增值功能上全部免费
  if (opts.isVip && cfg.vipFreePlays !== false) return { ok: true, cost: 0, free: true };
  if (!user) return { ok: false, cost, error: '请先登录', needPoints: cost, points: 0 };
  if (cost <= 0) return { ok: true, cost: 0, free: true };
  const q = ensureQuota(user);
  if (q.points === -1) return { ok: true, cost: 0, free: true };
  if (q.points >= cost) return { ok: true, cost, free: false };
  return { ok: false, cost, error: '点数不足', needPoints: cost, points: q.points };
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
 * 执行兑换（四类型：会员天数 / 余额 / 观看次数 / 通用点数）
 * @returns {{ type, value, vip?, balance?, quota?, tip }}
 */
function applyRedeem(rec, user) {
  const v = Number(rec.value) || 0;

  if (rec.type === 'balance') {
    user.balance = Math.round(((user.balance || 0) + v) * 100) / 100;
    return { type: 'balance', value: v, balance: user.balance, tip: `已充值 ${v} 元到余额` };
  }

  if (rec.type === 'quota_times') {
    const q = ensureQuota(user);
    q.times = q.times === -1 ? -1 : q.times + v;
    user.quota = q;
    return { type: 'quota_times', value: v, quota: { times: q.times, points: q.points }, tip: `已获得 ${v} 次观看额度` };
  }

  if (rec.type === 'quota_points') {
    const q = ensureQuota(user);
    q.points = q.points === -1 ? -1 : q.points + v;
    user.quota = q;
    return { type: 'quota_points', value: v, quota: { times: q.times, points: q.points }, tip: `已获得 ${v} 点数` };
  }

  // 会员时长
  const days = v || 30;
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
  // 额度系统
  dayKeyOf,
  ensureQuota,
  quotaView,
  gateWatch,
  costOf,
  checkSpend,
};
