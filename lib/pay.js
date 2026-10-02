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
 * @param {'MD5'|'SHA256'} algo
 */
function signParams(params, key, algo = 'MD5') {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const raw = keys.map((k) => `${k}=${params[k]}`).join('&');
  const name = String(algo).toUpperCase() === 'SHA256' ? 'sha256' : 'md5';
  return crypto.createHash(name).update(raw + key).digest('hex');
}

/** 校验签名（常量时间比较） */
function verifySign(params, key, algo = 'MD5') {
  const expect = signParams(params, key, algo);
  const got = String(params.sign || '');
  if (expect.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got));
}

/* ============================================================
 * 支付渠道（多渠道：可增删改启停排序，每渠道独立配置）
 * ============================================================ */

/** 渠道类型元数据（前端表单据此渲染配置项） */
const CHANNEL_TYPES = {
  mock: {
    name: '模拟支付', icon: '🧪',
    desc: '无需商户信息，一键模拟支付成功，用于演示与本地开发',
    fields: [],
  },
  epay: {
    name: '易支付 / 彩虹易支付', icon: '🌈',
    desc: '兼容彩虹易支付及衍生系统的统一下单接口',
    fields: [
      { k: 'gateway', label: '网关地址', type: 'text', ph: 'https://pay.example.com/submit.php', required: true },
      { k: 'merchantId', label: '商户号 PID', type: 'text', ph: '1000', required: true },
      { k: 'signKey', label: '商户密钥 Key', type: 'password', ph: '与易支付后台一致', required: true },
      { k: 'signType', label: '签名算法', type: 'select', options: ['MD5', 'SHA256'] },
    ],
    methods: ['alipay', 'wxpay', 'qqpay'],
  },
  alipay: {
    name: '支付宝（官方）', icon: '🅰️',
    desc: '支付宝开放平台 · 电脑网站支付 / 当面付',
    fields: [
      { k: 'appId', label: 'AppID', type: 'text', ph: '2021xxxxxxxxxxxx', required: true },
      { k: 'appPrivateKey', label: '应用私钥', type: 'textarea', ph: '-----BEGIN RSA PRIVATE KEY-----', required: true },
      { k: 'alipayPublicKey', label: '支付宝公钥', type: 'textarea', ph: '-----BEGIN PUBLIC KEY-----', required: true },
      { k: 'gateway', label: '网关', type: 'text', ph: 'https://openapi.alipay.com/gateway.do' },
      { k: 'productCode', label: '产品码', type: 'select', options: ['FAST_INSTANT_TRADE_PAY', 'FACE_TO_FACE_PAYMENT'] },
    ],
    methods: ['alipay'],
  },
  wxpay: {
    name: '微信支付（官方 V3）', icon: '💚',
    desc: '微信支付 V3 · Native 扫码支付',
    fields: [
      { k: 'appId', label: 'AppID', type: 'text', ph: 'wx1234567890abcdef', required: true },
      { k: 'mchId', label: '商户号 MchID', type: 'text', ph: '1600000000', required: true },
      { k: 'serialNo', label: '证书序列号', type: 'text', ph: '4A3B...', required: true },
      { k: 'apiV3Key', label: 'APIv3 密钥', type: 'password', ph: '32 位', required: true },
      { k: 'privateKey', label: '商户私钥', type: 'textarea', ph: '-----BEGIN PRIVATE KEY-----', required: true },
      { k: 'gateway', label: '网关', type: 'text', ph: 'https://api.mch.weixin.qq.com' },
    ],
    methods: ['wxpay'],
  },
  manual: {
    name: '人工收款 / 转账', icon: '🏦',
    desc: '展示收款码，用户线下转账后管理员手动确认',
    fields: [
      { k: 'qrcode', label: '收款码图片地址', type: 'text', ph: 'https://... 或 /uploads/qr.png' },
      { k: 'accountName', label: '收款人', type: 'text', ph: '张三' },
      { k: 'accountNo', label: '收款账号', type: 'text', ph: '支付宝/银行卡号' },
      { k: 'instruct', label: '支付说明', type: 'textarea', ph: '请扫码支付后联系管理员确认' },
    ],
    methods: ['manual'],
  },
  custom: {
    name: '自定义网关', icon: '🔧',
    desc: '自行提供下单跳转地址，回调仍走本站 /api/pay/callback',
    fields: [
      { k: 'gateway', label: '下单跳转地址', type: 'text', ph: 'https://your-gateway.com/pay', required: true },
      { k: 'signKey', label: '签名密钥', type: 'password', ph: '用于回调验签' },
      { k: 'extraQuery', label: '附加查询参数', type: 'text', ph: 'a=1&b=2' },
    ],
    methods: ['custom'],
  },
};

/** 全部支付方式元数据 */
const METHOD_META = {
  alipay: { name: '支付宝', icon: '🅰️' },
  wxpay: { name: '微信支付', icon: '💚' },
  qqpay: { name: 'QQ 钱包', icon: '🐧' },
  manual: { name: '转账 / 收款码', icon: '🏦' },
  custom: { name: '在线支付', icon: '🔧' },
};

/** 取渠道列表（旧配置自动迁移为单渠道） */
function getChannels(cfg = {}) {
  let list = Array.isArray(cfg.channels) ? cfg.channels : null;
  if (!list || !list.length) {
    // 旧版单 provider 配置 → 迁移
    const p = cfg.provider || 'mock';
    const t = CHANNEL_TYPES[p] ? p : 'mock';
    const conf = {};
    for (const f of (CHANNEL_TYPES[t].fields || [])) conf[f.k] = cfg[f.k] || '';
    if (p === 'epay') { conf.merchantId = cfg.merchantId || ''; conf.signKey = cfg.signKey || ''; }
    list = [{
      id: 'ch_migrated', type: t, name: CHANNEL_TYPES[t].name, icon: CHANNEL_TYPES[t].icon,
      enabled: true, sort: 0, testMode: !!cfg.testMode, desc: CHANNEL_TYPES[t].desc,
      config: conf,
      methods: (CHANNEL_TYPES[t].methods || ['alipay']).map((m) => ({
        id: m, name: METHOD_META[m].name, icon: METHOD_META[m].icon, enabled: true,
      })),
    }];
  }
  return list.slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
}

/** 归一化一个渠道（补全字段 + 校验） */
function normalizeChannel(raw, idx = 0) {
  const type = CHANNEL_TYPES[raw && raw.type] ? raw.type : 'mock';
  const meta = CHANNEL_TYPES[type];
  const id = String((raw && raw.id) || '').trim() || ('ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
  const cfgIn = (raw && raw.config) || {};
  const config = {};
  for (const f of (meta.fields || [])) {
    config[f.k] = String(cfgIn[f.k] === undefined || cfgIn[f.k] === null ? '' : cfgIn[f.k]).slice(0, 8000);
    if (!config[f.k] && f.type === 'select') config[f.k] = (f.options || [''])[0];
  }
  const allowM = meta.methods || ['alipay'];
  const inM = Array.isArray(raw && raw.methods) ? raw.methods : [];
  const byId = {};
  for (const m of inM) { if (m && m.id) byId[m.id] = m; }
  const methods = allowM.map((mid, i) => ({
    id: mid,
    name: METHOD_META[mid] ? METHOD_META[mid].name : mid,
    icon: METHOD_META[mid] ? METHOD_META[mid].icon : '💳',
    enabled: byId[mid] ? byId[mid].enabled !== false : true,
  }));
  return {
    id,
    type,
    name: String((raw && raw.name) || meta.name).slice(0, 40),
    icon: String((raw && raw.icon) || meta.icon).slice(0, 4),
    enabled: !!(raw && raw.enabled),
    sort: Number.isFinite(Number(raw && raw.sort)) ? Number(raw.sort) : (idx + 1) * 10,
    testMode: !!(raw && raw.testMode),
    desc: String((raw && raw.desc) || meta.desc).slice(0, 200),
    config,
    methods,
  };
}

/** 渠道是否配置完整可用 */
function channelReady(ch) {
  if (!ch || !ch.enabled) return false;
  if (ch.type === 'mock') return true;
  const meta = CHANNEL_TYPES[ch.type];
  if (!meta) return false;
  return (meta.fields || []).every((f) => !f.required || (ch.config && ch.config[f.k]));
}

/** 可用渠道列表（含可用支付方式） */
function availableChannels(cfg = {}) {
  return getChannels(cfg)
    .filter((c) => channelReady(c))
    .map((c) => ({
      id: c.id, type: c.type, name: c.name, icon: c.icon, desc: c.desc,
      testMode: !!c.testMode,
      methods: (c.methods || []).filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.name, icon: m.icon })),
      // manual 渠道需要前端展示收款信息
      manual: c.type === 'manual' ? {
        qrcode: c.config.qrcode || '', instruct: c.config.instruct || '',
        accountName: c.config.accountName || '', accountNo: c.config.accountNo || '',
      } : null,
    }));
}

/** 支付方式列表（兼容旧接口：汇总所有可用渠道的方法） */
function payMethods(cfg) {
  const map = new Map();
  for (const c of availableChannels(cfg)) {
    for (const m of c.methods) if (!map.has(m.id)) map.set(m.id, m);
  }
  return [...map.values()];
}

/**
 * 构建支付请求（多渠道）
 * @param {object} cfg monetize 配置
 * @param {object} order 订单（需含 channelId / payMethod）
 * @param {string} baseUrl 站点根地址
 * @returns {{ ok, provider, mode, tip, payload, error? }}
 *   mode: 'mock' | 'qrcode' | 'redirect' | 'manual' | 'custom'
 */
function buildPayment(cfg, order, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const notify = cfg.notifyUrl || (base ? base + '/api/pay/callback' : '');
  const ret = base ? base + '/#/vip?order=' + order.id : '';

  const channels = getChannels(cfg);
  // 选中渠道：优先订单指定，其次第一个可用
  let ch = channels.find((c) => c.id === order.channelId);
  if (!ch) ch = availableChannels(cfg)[0] ? channels.find((c) => c.id === availableChannels(cfg)[0].id) : null;
  if (!ch) return { ok: false, error: '没有可用的支付渠道，请联系管理员配置' };
  if (!channelReady(ch)) return { ok: false, error: '所选支付渠道未配置完成，请更换渠道或联系管理员' };

  const method = order.payMethod || ((ch.methods || []).find((m) => m.enabled) || {}).id || 'alipay';

  // 1) 模拟支付
  if (ch.type === 'mock') {
    return {
      ok: true, provider: 'mock', mode: 'mock', channelId: ch.id, channelName: ch.name,
      tip: '当前为演示支付模式，点击下方按钮即可模拟支付成功',
      payload: { orderId: order.id, endpoint: '/api/pay/mock' },
    };
  }

  // 2) 人工收款
  if (ch.type === 'manual') {
    return {
      ok: true, provider: 'manual', mode: 'manual', channelId: ch.id, channelName: ch.name,
      tip: ch.config.instruct || '请扫码支付后提交凭证，管理员确认后到账',
      payload: {
        orderId: order.id, qrcode: ch.config.qrcode || '',
        accountName: ch.config.accountName || '', accountNo: ch.config.accountNo || '',
        instruct: ch.config.instruct || '', amount: Number(order.amount).toFixed(2),
        endpoint: '/api/pay/manual/claim',
      },
    };
  }

  // 3) 易支付
  if (ch.type === 'epay') {
    const params = {
      pid: ch.config.merchantId || '',
      type: method === 'wxpay' ? 'wxpay' : method === 'qqpay' ? 'qqpay' : 'alipay',
      out_trade_no: order.id,
      notify_url: notify,
      return_url: ret,
      name: order.planName || '会员服务',
      money: Number(order.amount).toFixed(2),
      sitename: (cfg.siteName || '慈云影视'),
    };
    params.sign = signParams(params, ch.config.signKey || '', ch.config.signType || 'MD5');
    params.sign_type = ch.config.signType || 'MD5';
    const gw = ch.config.gateway || '';
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return {
      ok: true, provider: 'epay', mode: 'redirect', channelId: ch.id, channelName: ch.name,
      tip: '即将跳转到支付页面',
      payload: { url: gw ? `${gw}${gw.includes('?') ? '&' : '?'}${qs}` : '', params },
    };
  }

  // 4) 支付宝官方（构造电脑网站支付表单）
  if (ch.type === 'alipay') {
    const biz = {
      out_trade_no: order.id,
      total_amount: Number(order.amount).toFixed(2),
      subject: order.planName || '会员服务',
      product_code: ch.config.productCode || 'FAST_INSTANT_TRADE_PAY',
    };
    const params = {
      app_id: ch.config.appId || '',
      method: 'alipay.trade.page.pay',
      format: 'JSON', charset: 'utf-8', sign_type: 'RSA2',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      version: '1.0',
      notify_url: notify, return_url: ret,
      biz_content: JSON.stringify(biz),
    };
    let signed = false, sign = '';
    try {
      sign = rsaSign(params, ch.config.appPrivateKey, 'RSA-SHA256');
      signed = !!sign;
    } catch (e) { signed = false; }
    if (!signed) {
      return { ok: false, error: '支付宝应用私钥无效或未配置，请在后台补全' };
    }
    params.sign = sign;
    const gw = ch.config.gateway || 'https://openapi.alipay.com/gateway.do';
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return {
      ok: true, provider: 'alipay', mode: 'redirect', channelId: ch.id, channelName: ch.name,
      tip: '即将跳转到支付宝',
      payload: { url: `${gw}?${qs}`, params },
    };
  }

  // 5) 微信支付 V3 Native
  if (ch.type === 'wxpay') {
    const body = {
      appid: ch.config.appId || '',
      mchid: ch.config.mchId || '',
      description: order.planName || '会员服务',
      out_trade_no: order.id,
      notify_url: notify || (base + '/api/pay/callback'),
      amount: { total: Math.round(Number(order.amount) * 100), currency: 'CNY' },
    };
    let authHeader = '';
    try {
      authHeader = wxV3Auth('POST', '/v3/pay/transactions/native',
        ch.config.mchId, ch.config.serialNo, ch.config.privateKey, JSON.stringify(body));
    } catch (e) { authHeader = ''; }
    if (!authHeader) {
      return { ok: false, error: '微信支付商户私钥无效或未配置，请在后台补全' };
    }
    return {
      ok: true, provider: 'wxpay', mode: 'qrcode', channelId: ch.id, channelName: ch.name,
      tip: '请使用微信扫码支付',
      payload: {
        // 由服务端发起下单请求（见 server /api/pay/wxpay/native）
        endpoint: '/api/pay/wxpay/native',
        orderId: order.id, body, auth: authHeader,
        gateway: ch.config.gateway || 'https://api.mch.weixin.qq.com',
      },
    };
  }

  // 6) 自定义
  const params = {
    out_trade_no: order.id,
    money: Number(order.amount).toFixed(2),
    name: order.planName || '会员服务',
    type: method,
    notify_url: notify, return_url: ret,
  };
  if (ch.config.signKey) params.sign = signParams(params, ch.config.signKey);
  const extra = String(ch.config.extraQuery || '').trim();
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const gw = ch.config.gateway || '';
  return {
    ok: true, provider: 'custom', mode: 'custom', channelId: ch.id, channelName: ch.name,
    tip: '请按自定义支付流程完成支付',
    payload: { url: gw ? `${gw}${gw.includes('?') ? '&' : '?'}${qs}${extra ? '&' + extra : ''}` : '', params, notify },
  };
}

/** RSA 签名（支付宝 RSA2 / 微信 V3 共用） */
function rsaSign(params, privateKey, algo = 'RSA-SHA256') {
  if (!privateKey) return '';
  const keys = Object.keys(params).filter((k) => k !== 'sign' && params[k] !== '' && params[k] != null).sort();
  const raw = keys.map((k) => `${k}=${params[k]}`).join('&');
  const key = normalizePem(privateKey, 'PRIVATE');
  const s = crypto.createSign(algo);
  s.update(raw, 'utf8');
  return s.sign(key, 'base64');
}

/** 规范化 PEM（支持纯 base64 一行字符串） */
function normalizePem(k, kind) {
  let v = String(k || '').trim();
  if (v.includes('-----BEGIN')) return v;
  const body = v.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  const head = kind === 'PRIVATE' ? 'PRIVATE KEY' : 'PUBLIC KEY';
  return `-----BEGIN ${head}-----\n${lines.join('\n')}\n-----END ${head}-----`;
}

/** 微信支付 V3 请求签名头 */
function wxV3Auth(method, path, mchId, serialNo, privateKey, bodyStr) {
  if (!mchId || !serialNo || !privateKey) return '';
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const msg = `${method}\n${path}\n${ts}\n${nonce}\n${bodyStr}\n`;
  const key = normalizePem(privateKey, 'PRIVATE');
  const s = crypto.createSign('RSA-SHA256');
  s.update(msg, 'utf8');
  const sig = s.sign(key, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${sig}",timestamp="${ts}",serial_no="${serialNo}"`;
}

/** 验证渠道配置（后台保存时给出可用性提示） */
function checkChannel(ch) {
  if (!ch) return { ok: false, error: '渠道不存在' };
  const meta = CHANNEL_TYPES[ch.type];
  if (!meta) return { ok: false, error: '未知渠道类型' };
  const miss = (meta.fields || []).filter((f) => f.required && !(ch.config && ch.config[f.k])).map((f) => f.label);
  if (miss.length) return { ok: false, error: '缺少必填项：' + miss.join('、'), missing: miss };
  if (ch.type === 'alipay') {
    try { rsaSign({ t: '1' }, ch.config.appPrivateKey); }
    catch (e) { return { ok: false, error: '应用私钥格式错误（应为 PKCS#8 / PKCS#1 PEM）' }; }
  }
  if (ch.type === 'wxpay') {
    try { wxV3Auth('POST', '/v3/test', ch.config.mchId, ch.config.serialNo, ch.config.privateKey, '{}'); }
    catch (e) { return { ok: false, error: '商户私钥格式错误' }; }
  }
  return { ok: true };
}

/* ============================================================
 * 兼容层：旧版单 provider 语义
 * ============================================================ */

/** @deprecated 使用 availableChannels */
function payMethodsLegacy(cfg) { return payMethods(cfg); }

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
  // 9) 拦截（带出应扣成本，供家庭额度池兜底使用）
  return {
    ...base, allow: false,
    cost: costPerPlay,
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
  // 支付渠道
  CHANNEL_TYPES,
  METHOD_META,
  getChannels,
  normalizeChannel,
  channelReady,
  availableChannels,
  checkChannel,
  rsaSign,
  wxV3Auth,
  normalizePem,
};
