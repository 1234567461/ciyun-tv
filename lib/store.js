'use strict';
/**
 * 慈云影视 - 轻量数据存储
 * ============================================================
 * 使用单个 JSON 文件持久化（data/store.json），零外部依赖，方便开源部署。
 * 结构：{ settings, columns, sources, stats, users, orders, sessions }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const COLUMNS_FILE = path.join(DATA_DIR, 'columns.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** 默认站点设置 */
const DEFAULT_SETTINGS = {
  siteName: '慈云影视',
  slogan: '免费 · 高清 · 无广告',
  logo: '',
  theme: {
    primary: '#e50914',
    accent: '#ff6b6b',
    mode: 'dark',
  },
  announcement: '本站数据均来自央视网等官方公开接口，仅供学习交流，请勿用于商业用途。',
  showAds: false,
  // 会员付费模块（开源版默认关闭，核心观看永远免费）
  monetize: {
    enabled: false,               // 是否开启付费模块
    mode: 'optional',             // optional=自愿赞助制（不付费也能用） | required=权益制（部分功能需会员）
    currency: '¥',
    provider: 'mock',             // 旧版单渠道字段（兼容保留，等于默认渠道的 type）
    testMode: true,               // 测试模式：下单后可一键模拟支付成功
    notifyUrl: '',                // 支付回调地址（provider 用）
    merchantId: '',               // 商户号
    signKey: '',                  // 签名密钥
    // —— 支付渠道列表（可增删改、启停、排序；每渠道独立配置） ——
    channels: [
      {
        id: 'ch_mock', type: 'mock', name: '模拟支付（演示）', icon: '🧪',
        enabled: true, sort: 0, testMode: true,
        desc: '无需任何商户信息，点击即可模拟支付成功，适合演示与本地开发',
        config: {},
        methods: [
          { id: 'alipay', name: '支付宝', icon: '🅰️', enabled: true },
          { id: 'wxpay', name: '微信支付', icon: '💚', enabled: true },
        ],
      },
      {
        id: 'ch_epay', type: 'epay', name: '易支付 / 彩虹易支付', icon: '🌈',
        enabled: false, sort: 10, testMode: false,
        desc: '兼容 彩虹易支付 及其衍生系统的统一下单接口，填入网关地址、商户号与密钥即可',
        config: {
          gateway: '',            // 如 https://pay.example.com/submit.php
          merchantId: '',         // pid
          signKey: '',            // 商户密钥
          signType: 'MD5',        // MD5 | SHA256
        },
        methods: [
          { id: 'alipay', name: '支付宝', icon: '🅰️', enabled: true },
          { id: 'wxpay', name: '微信支付', icon: '💚', enabled: true },
          { id: 'qqpay', name: 'QQ 钱包', icon: '🐧', enabled: true },
        ],
      },
      {
        id: 'ch_alipay', type: 'alipay', name: '支付宝（官方当面付）', icon: '🅰️',
        enabled: false, sort: 20, testMode: false,
        desc: '支付宝开放平台当面付 / 电脑网站支付，需 AppID、应用私钥与支付宝公钥',
        config: {
          appId: '', appPrivateKey: '', alipayPublicKey: '',
          gateway: 'https://openapi.alipay.com/gateway.do',
          productCode: 'FAST_INSTANT_TRADE_PAY',
        },
        methods: [{ id: 'alipay', name: '支付宝', icon: '🅰️', enabled: true }],
      },
      {
        id: 'ch_wxpay', type: 'wxpay', name: '微信支付（官方 Native）', icon: '💚',
        enabled: false, sort: 30, testMode: false,
        desc: '微信支付 V3 Native 扫码支付，需 AppID、商户号、APIv3 密钥与商户证书序列号',
        config: {
          appId: '', mchId: '', apiV3Key: '', serialNo: '', privateKey: '',
          gateway: 'https://api.mch.weixin.qq.com',
        },
        methods: [{ id: 'wxpay', name: '微信支付', icon: '💚', enabled: true }],
      },
      {
        id: 'ch_manual', type: 'manual', name: '人工收款 / 转账', icon: '🏦',
        enabled: false, sort: 40, testMode: false,
        desc: '展示收款码与说明，用户线下转账并提交凭证，管理员后台手动确认到账',
        config: {
          qrcode: '', instruct: '请使用支付宝/微信扫码支付，支付后点击「我已支付」并填写订单号，管理员将在 24 小时内确认。',
          accountName: '', accountNo: '',
        },
        methods: [{ id: 'manual', name: '转账 / 收款码', icon: '🏦', enabled: true }],
      },
      {
        id: 'ch_custom', type: 'custom', name: '自定义网关', icon: '🔧',
        enabled: false, sort: 50, testMode: false,
        desc: '完全自定义：自行提供下单跳转地址，回调仍走本站 /api/pay/callback',
        config: { gateway: '', signKey: '', extraQuery: '' },
        methods: [{ id: 'custom', name: '在线支付', icon: '🔧', enabled: true }],
      },
    ],
    allowBalance: true,           // 允许用余额支付
    redeemEnabled: true,          // 开启兑换码充值
    adminUnlimited: true,         // 管理员账号默认终身会员 + 无限额度
    minRecharge: 1,               // 最低充值金额
    rechargePresets: [10, 30, 50, 100, 200, 500],
    orderTimeout: 30,             // 订单未支付自动过期（分钟）
    autoRenewTip: true,           // 到期前提醒
    // —— 额度系统（默认关闭；开启后按额度/点数控制增值能力） ——
    quotaEnabled: false,          // 额度系统总开关（付费模块关闭时永不生效）
    requireLogin: true,           // 观看是否要求登录
    freeDailyPlays: 10,           // 每日免费观看次数（0=无免费额度）
    costPerPlay: 1,               // 每次观看消耗的次数额度
    dedupeDaily: true,            // 同一影片当日重复观看是否只扣一次
    vipFreePlays: true,           // 会员是否免观看额度
    allowPointsForPlay: true,     // 次数不足时是否允许用点数抵扣观看
    pointCosts: {                 // 通用点数消耗表
      play: 2,                    // 用点数看一部
      hd: 1,                      // 超清画质（单次）
      download: 5,                // 下载（单次）
      noAd: 10,                   // 去广告（按次）
    },
    plans: [
      {
        id: 'vip_month', name: '月度会员', days: 30, price: 12,
        originalPrice: 18, badge: '', recommended: false,
        perks: ['去广告', '超清画质', '无限收藏'],
      },
      {
        id: 'vip_quarter', name: '季度会员', days: 90, price: 32,
        originalPrice: 36, badge: '省 4 元', recommended: false,
        perks: ['去广告', '超清画质', '无限收藏', '家庭共享'],
      },
      {
        id: 'vip_year', name: '年度会员', days: 365, price: 98,
        originalPrice: 144, badge: '最划算', recommended: true,
        perks: ['去广告', '超清画质', '无限收藏', '专属线路', '家庭共享 5 人'],
      },
    ],
  },
  playback: {
    autoQuality: true,       // 自动清晰度
    autoFailover: true,      // 失败自动切换线路
    defaultLine: 'auto',     // auto | 线路id
    preload: true,
    mutedAutoplay: false,
  },
  // 社区模块（注册 / 评论）
  community: {
    enabled: true,
    allowRegister: true,       // 是否开放注册
    allowComment: true,        // 是否允许评论
    guestComment: false,       // 是否允许游客评论（默认需登录）
    commentReview: false,      // 新评论是否需要审核后可见
    needEmail: false,          // 注册是否强制填邮箱
    verifyEmail: false,        // 注册是否必须通过邮箱验证码
    emailLogin: true,          // 是否开放邮箱验证码登录
    interval: 15,              // 同一用户两条评论最小间隔（秒）
    maxLen: 500,               // 单条评论最大字数
    keywords: ['加微信', '代刷', '赌博', '博彩', '私聊', '广告位', '出售', '办证'],
  },
  // 邮件服务（SMTP，用于登录/注册验证码、找回密码）
  mail: {
    host: 'smtp.163.com',      // 163 邮箱 SMTP
    port: 465,
    user: 'zhousazi1145142025@163.com',   // 发信邮箱账号
    pass: '',                  // SMTP 授权码（在后台「设置 → 邮件服务」填写，不落默认值）
    from: '慈云影视',           // 发件人显示名
    secure: 'ssl',             // ssl（465）/ starttls（587）
  },
  // 家庭共享（付费增值模块，1 户主 + 最多 N 成员；对标 Emby / Jellyfin / Plex）
  family: {
    enabled: true,             // 模块开关
    requireVip: true,          // 是否要求户主为会员才能创建
    maxMembers: 5,             // 最多可邀请成员数（不含户主）
    allowLeave: true,          // 成员是否可主动退出
    shareVip: true,            // 成员是否共享户主会员权益
    // —— 并发流 & 设备（对标 Jellyfin MaxActiveVideoStreams / Emby 设备数 / Plex 并发流） ——
    maxStreams: 2,             // 每成员最大同时在线观看数（0 = 不限，-1 跟随全局）
    deviceLimit: 3,            // 每成员最大绑定设备数（0 = 不限）
    streamPolicy: 'replace',   // 超额策略：replace=顶掉最早会话 / block=直接拒绝
    // —— 额度池（家庭共享额度，对标 Plex Home 权益下放） ——
    shareQuota: true,          // 成员缺额度时，是否消耗户主额度池
    familyQuotaPool: 100,      // 户主提供给家庭共用的额度池（次）
    // —— 邀请策略 ——
    inviteTtlDays: 3,          // 邀请码默认有效期（天）
    inviteRole: 'member',      // 邀请码默认角色：member / child / guest / admin
    autoApprove: true,         // 邀请码是否直接通过（false = 需户主审核）
    // —— 内容分级（对标 Jellyfin Parental Rating / Emby Parental Control） ——
    parentalEnabled: true,     // 是否启用儿童分级管控
    childMaxRating: 'PG13',    // 儿童等级上限：G / PG / PG13 / R / UNRATED
    childBlockVip: true,       // 儿童账号是否禁用会员增值功能（超清/下载）
    childBlockComment: true,   // 儿童账号是否禁言
  },
};

/** 默认内置源（全部经实测可用；央视网为官方公开接口，其余为公开采集站） */
const DEFAULT_SOURCES = [
  /* ---------------- 官方公开源（首选） ---------------- */
  {
    id: 'cctv-official',
    name: '央视网 · 官方公开',
    type: 'cctv',
    enabled: true,
    builtin: true,
    official: true,
    priority: 100,
    desc: '央视网 tv.cctv.com 公开接口：栏目点播 + 频道直播 + 节目单（官方公开，最稳）',
    config: { serviceId: 'tvcctv' },
  },
  {
    id: 'cctv-live',
    name: '央视直播 · 频道合集',
    type: 'cctv',
    enabled: true,
    builtin: true,
    official: true,
    priority: 95,
    desc: 'CCTV-1/2/4/5/6/8/13 等 20+ 频道直播，m3u8 直出',
    config: { serviceId: 'tvcctv', mode: 'live' },
  },
  /* ---------------- 公开影视采集源（苹果 CMS 标准） ---------------- */
  {
    id: 'hongniu',
    name: '红牛资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 80,
    desc: '国内速度优、更新快，11 万+ 影视，M3U8 直链',
    url: 'https://hongniuzy2.com/api.php/provide/vod/from/hnm3u8',
    config: { from: 'hnm3u8' },
  },
  {
    id: 'liangzi',
    name: '量子资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 78,
    desc: '资源量大、线路稳定，15 万+ 影视',
    url: 'https://cj.lziapi.com/api.php/provide/vod/from/lzm3u8',
    config: { from: 'lzm3u8' },
  },
  {
    id: 'zy360',
    name: '360 资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 72,
    desc: '7 万+ 影视，覆盖电影/剧集/综艺/动漫',
    url: 'https://360zyzz.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'dytt',
    name: '电影天堂资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 76,
    desc: '8.4 万+ 影视，老牌资源站，欧美/日韩剧集丰富',
    url: 'https://caiji.dyttzyapi.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'wujin',
    name: '无尽资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 74,
    desc: '12 万+ 影视，更新勤、线路多',
    url: 'https://api.wujinapi.me/api.php/provide/vod',
    config: {},
  },
  {
    id: 'ffzy',
    name: '非凡资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 73,
    desc: '9.8 万+ 影视，画质较好',
    url: 'https://api.ffzyapi.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'guangsu',
    name: '光速资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 70,
    desc: '11 万+ 影视，接口稳定',
    url: 'https://api.guangsuapi.com/api.php/provide/vod/from/gsm3u8',
    config: { from: 'gsm3u8' },
  },
  {
    id: 'jinying',
    name: '金鹰资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 60,
    desc: '低延迟线路，29 路播放源（部分海外网络可能受限）',
    url: 'http://jyzyapi.com/provide/vod/from/jinyingm3u8',
    config: { from: 'jinyingm3u8' },
  },
  {
    id: 'shandian',
    name: '闪电资源',
    type: 'maccms-json',
    enabled: false,
    builtin: true,
    priority: 55,
    desc: '20 路播放源（默认关闭：仅国内服务器可访问）',
    url: 'http://sdzyapi.com/api.php/provide/vod/from/sdm3u8',
    config: { from: 'sdm3u8' },
  },
  {
    id: 'aosika',
    name: '奥斯卡资源',
    type: 'maccms-json',
    enabled: false,
    builtin: true,
    priority: 50,
    desc: '97 路播放源（默认关闭：内容需自行审核，建议先开启内容过滤）',
    url: 'https://aosikazy.com/api.php/provide/vod',
    config: {},
  },
];

function initialState() {
  return {
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    columns: null, // 从 columns.json 载入
    sources: JSON.parse(JSON.stringify(DEFAULT_SOURCES)),
    stats: { plays: {}, daily: {}, visits: {}, totalPlays: 0 },
    users: [],
    orders: [],
    sessions: {},
    comments: [],
    families: [],
    invites: [],
    redeemCodes: [],   // 兑换码
    quotaLog: [],      // 额度流水
    shorts: [],        // 短视频（用户发布，抖音式）
    follows: [],       // 追剧订阅 { account, type:'vod'|'short'|'live', targetId, title, cover, updatedAt, lastEp }
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

let state = null;

function loadColumnsFile() {
  try {
    return JSON.parse(fs.readFileSync(COLUMNS_FILE, 'utf8'));
  } catch {
    return { categories: [], columns: [], liveChannels: [] };
  }
}

function load() {
  if (state) return state;
  if (fs.existsSync(FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      // 合并新增的默认字段（向后兼容）
      state.settings = mergeDeep(
        JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
        state.settings || {}
      );
      state.stats = state.stats || { plays: {}, daily: {}, visits: {}, totalPlays: 0 };
      state.users = state.users || [];
      state.orders = state.orders || [];
      state.comments = state.comments || [];
      state.families = state.families || [];
      state.invites = state.invites || [];
      state.redeemCodes = state.redeemCodes || [];
      state.quotaLog = state.quotaLog || [];
      // 家庭数据旧版本兼容：成员补 role/devices/pending，家庭补额度池字段
      for (const f of state.families) {
        if (!Number.isFinite(f.quotaPool)) f.quotaPool = 0;
        if (!Number.isFinite(f.poolUsed)) f.poolUsed = 0;
        for (const m of (f.members || [])) {
          if (!FAMILY_ROLES.includes(m.role)) m.role = 'member';
          m.devices = m.devices || [];
          m.pending = !!m.pending;
        }
      }
      for (const i of state.invites) {
        i.role = FAMILY_ROLES.includes(i.role) ? i.role : 'member';
        if (!Number.isFinite(i.maxUses)) i.maxUses = 1;
        i.usedCount = Number(i.usedCount) || (i.used ? 1 : 0);
      }
      state.sources = state.sources || JSON.parse(JSON.stringify(DEFAULT_SOURCES));
      state.sessions = state.sessions || {};
    } catch (e) {
      console.error('[store] 读取失败，使用初始状态:', e.message);
      state = initialState();
    }
  } else {
    state = initialState();
  }
  state.columns = loadColumnsFile();
  return state;
}

function mergeDeep(base, override) {
  for (const k of Object.keys(override || {})) {
    const v = override[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      base[k] = mergeDeep(base[k] && typeof base[k] === 'object' ? base[k] : {}, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

let saveTimer = null;
/** 防抖落盘 */
function save() {
  load();
  state.updatedAt = Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const dump = { ...state };
      dump.columns = undefined; // 栏目库单独存储，不重复写入
      fs.writeFileSync(FILE, JSON.stringify(dump, null, 1));
    } catch (e) {
      console.error('[store] 保存失败:', e.message);
    }
  }, 200);
}

/* ------------------------- 访问接口 ------------------------- */

const store = {
  get settings() {
    return load().settings;
  },
  setSettings(patch) {
    const s = load();
    s.settings = mergeDeep(s.settings, patch);
    save();
    return s.settings;
  },
  get columns() {
    return load().columns;
  },
  get categories() {
    return load().columns.categories || [];
  },
  get liveChannels() {
    return load().columns.liveChannels || [];
  },
  get settingsDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  },

  /** 栏目增删改（后台） */
  getColumns() {
    return load().columns.columns || [];
  },
  updateColumn(id, patch) {
    const s = load();
    const col = (s.columns.columns || []).find((c) => c.id === id);
    if (col) {
      Object.assign(col, patch);
      save();
    }
    return col;
  },
  addColumn(col) {
    const s = load();
    s.columns.columns = s.columns.columns || [];
    if (s.columns.columns.find((c) => c.id === col.id)) {
      throw new Error('栏目已存在: ' + col.id);
    }
    s.columns.columns.unshift(col);
    // 同步分类计数
    recountCategories(s);
    save();
    return col;
  },
  deleteColumn(id) {
    const s = load();
    s.columns.columns = (s.columns.columns || []).filter((c) => c.id !== id);
    recountCategories(s);
    save();
  },
  reorderFeatured(ids) {
    const s = load();
    const set = new Set(ids);
    for (const c of s.columns.columns || []) {
      c.featured = set.has(c.id);
    }
    s.settings.featuredOrder = ids;
    save();
  },

  /* ------------------------- 自定义源 ------------------------- */
  getSources() {
    return load().sources || [];
  },
  addSource(src) {
    const s = load();
    src.id = src.id || 'src_' + Date.now().toString(36);
    s.sources.push(src);
    save();
    return src;
  },
  updateSource(id, patch) {
    const s = load();
    const it = s.sources.find((x) => x.id === id);
    if (it) {
      Object.assign(it, patch);
      save();
    }
    return it;
  },
  deleteSource(id) {
    load().sources = load().sources.filter((x) => x.id !== id || x.builtin);
    save();
  },
  getSource(id) {
    return (load().sources || []).find((x) => x.id === id);
  },

  /* ------------------------- 统计 ------------------------- */
  recordPlay(guid, meta = {}) {
    const s = load();
    const st = s.stats;
    st.plays[guid] = st.plays[guid] || { count: 0, title: meta.title || '', last: 0 };
    st.plays[guid].count++;
    st.plays[guid].title = meta.title || st.plays[guid].title;
    st.plays[guid].last = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    st.daily[day] = (st.daily[day] || 0) + 1;
    st.totalPlays = (st.totalPlays || 0) + 1;
    save();
  },
  recordVisit(pathname) {
    const s = load();
    const day = new Date().toISOString().slice(0, 10);
    s.stats.visits[day] = (s.stats.visits[day] || 0) + 1;
    save();
  },
  getStats() {
    const s = load();
    const st = s.stats;
    const rev = this.revenueSummary();
    const top = Object.entries(st.plays || {})
      .map(([guid, v]) => ({ guid, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    // 近 14 天
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ date: d, plays: (st.daily || {})[d] || 0, visits: (st.visits || {})[d] || 0 });
    }
    return {
      totalPlays: st.totalPlays || 0,
      top,
      days,
      columns: (s.columns.columns || []).length,
      sources: (s.sources || []).length,
      users: (s.users || []).length,
      vipUsers: (s.users || []).filter((u) => u.vip && u.vip.expire > Date.now()).length,
      orders: (s.orders || []).length,
      comments: (s.comments || []).length,
      pendingComments: (s.comments || []).filter((c) => c.status === 'pending').length,
      families: (s.families || []).length,
      redeemTotal: (s.redeemCodes || []).length,
      redeemUsed: (s.redeemCodes || []).filter((x) => x.used).length,
      revenue: rev.revenue,
      todayRevenue: rev.todayRevenue,
    };
  },

  /* ------------------------- 用户 ------------------------- */
  getUsers() {
    return load().users || [];
  },
  findUser(account) {
    const a = String(account || '').toLowerCase();
    return (load().users || []).find((u) => u.account === a);
  },
  findUserByEmail(email) {
    const e = String(email || '').toLowerCase();
    if (!e) return null;
    return (load().users || []).find((u) => (u.email || '').toLowerCase() === e);
  },
  findUserByToken(token) {
    if (!token) return null;
    return (load().users || []).find((u) => (u.tokens || []).some((t) => t.id === token));
  },
  upsertUser(user) {
    const s = load();
    const i = s.users.findIndex((u) => u.account === user.account);
    if (i >= 0) s.users[i] = { ...s.users[i], ...user };
    else s.users.push(user);
    save();
    return user;
  },
  deleteUser(account) {
    const s = load();
    s.users = s.users.filter((u) => u.account !== account);
    s.comments = (s.comments || []).filter((c) => c.account !== account);
    save();
  },

  /* ------------------------- 评论 ------------------------- */
  getComments() {
    return load().comments || [];
  },
  addComment(c) {
    const s = load();
    const rec = {
      id: 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      parentId: c.parentId || null,
      targetType: c.targetType || 'video',
      targetId: String(c.targetId || ''),
      account: c.account || 'guest',
      nickname: c.nickname || '游客',
      avatar: c.avatar || '',
      content: String(c.content || ''),
      status: c.status || 'visible', // visible | pending | hidden | deleted
      likes: [],
      createdAt: Date.now(),
    };
    s.comments.unshift(rec);
    // 单文件不宜无限增长
    if (s.comments.length > 20000) s.comments.length = 20000;
    save();
    return rec;
  },
  findComment(id) {
    return (load().comments || []).find((c) => c.id === id);
  },
  updateComment(id, patch) {
    const c = this.findComment(id);
    if (!c) return null;
    Object.assign(c, patch);
    save();
    return c;
  },
  deleteComment(id, hard = false) {
    const s = load();
    if (hard) {
      s.comments = s.comments.filter((c) => c.id !== id && c.parentId !== id);
    } else {
      const c = this.findComment(id);
      if (c) { c.status = 'deleted'; c.content = ''; }
      // 子回复一并标记
      for (const x of s.comments) if (x.parentId === id) { x.status = 'deleted'; x.content = ''; }
    }
    save();
  },
  /** 查询某目标下的评论（含结构化为楼层+回复） */
  queryComments(targetType, targetId, opts = {}) {
    const all = (load().comments || []).filter(
      (c) => c.targetType === targetType && c.targetId === String(targetId)
    );
    const includeHidden = !!opts.includeHidden;
    const visible = all.filter((c) => includeHidden || c.status === 'visible');
    const roots = visible.filter((c) => !c.parentId).sort((a, b) => b.createdAt - a.createdAt);
    const total = visible.length;
    const page = Math.max(1, opts.page || 1);
    const size = Math.min(50, opts.size || 10);
    const slice = roots.slice((page - 1) * size, page * size);
    const list = slice.map((r) => ({
      ...r,
      likes: (r.likes || []).length,
      replies: visible
        .filter((c) => c.parentId === r.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((x) => ({ ...x, likes: (x.likes || []).length })),
    }));
    return { list, total, page, size, totalRoots: roots.length };
  },
  toggleCommentLike(id, account) {
    const c = this.findComment(id);
    if (!c) return null;
    c.likes = c.likes || [];
    const i = c.likes.indexOf(account);
    if (i >= 0) c.likes.splice(i, 1);
    else c.likes.push(account);
    save();
    return { likes: c.likes.length, liked: i < 0 };
  },
  /** 某用户最近的评论（用于频率限制） */
  lastCommentAt(account) {
    const list = (load().comments || []).filter((c) => c.account === account);
    return list.length ? Math.max(...list.map((c) => c.createdAt)) : 0;
  },

  /* ------------------------- 家庭共享 ------------------------- */
  getFamilies() {
    return load().families || [];
  },
  /** 查找用户所属家庭（户主或成员） */
  findFamilyOf(account) {
    return (load().families || []).find(
      (f) => f.owner === account || (f.members || []).some((m) => m.account === account)
    );
  },
  getFamily(id) {
    return (load().families || []).find((f) => f.id === id);
  },
  createFamily(owner, name) {
    const s = load();
    const rec = {
      id: 'fam_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      owner,
      name: name || (owner + ' 的家庭'),
      members: [],           // [{account, role, joinedAt, devices:[{id,name,lastAt}]}]
      createdAt: Date.now(),
      maxMembers: (s.settings.family && s.settings.family.maxMembers) || 5,
      quotaPool: 0,          // 家庭共享额度池（次）
      poolUsed: 0,           // 池已消耗
    };
    s.families.push(rec);
    save();
    return rec;
  },
  updateFamily(id, patch) {
    const f = this.getFamily(id);
    if (!f) return null;
    Object.assign(f, patch);
    save();
    return f;
  },
  deleteFamily(id) {
    const s = load();
    s.families = s.families.filter((f) => f.id !== id);
    s.invites = (s.invites || []).filter((i) => i.familyId !== id);
    save();
  },
  addFamilyMember(familyId, account, role) {
    const f = this.getFamily(familyId);
    if (!f) return { error: '家庭不存在' };
    const max = (load().settings.family && load().settings.family.maxMembers) || 5;
    if ((f.members || []).length >= max) return { error: `成员已达上限（最多 ${max} 人）` };
    if (f.owner === account) return { error: '户主已在家庭中' };
    if ((f.members || []).some((m) => m.account === account)) return { error: '该用户已在家庭中' };
    if (this.findFamilyOf(account)) return { error: '该用户已加入其它家庭' };
    f.members.push({
      account,
      role: FAMILY_ROLES.includes(role) ? role : 'member',
      joinedAt: Date.now(),
      devices: [],
      pending: false,
    });
    save();
    return { family: f };
  },
  /** 待审核成员（autoApprove=false 时） */
  addPendingMember(familyId, account, role) {
    const f = this.getFamily(familyId);
    if (!f) return { error: '家庭不存在' };
    const max = (load().settings.family && load().settings.family.maxMembers) || 5;
    const cnt = (f.members || []).filter((m) => !m.pending).length;
    if (cnt >= max) return { error: `成员已达上限（最多 ${max} 人）` };
    if (f.owner === account) return { error: '户主已在家庭中' };
    if ((f.members || []).some((m) => m.account === account)) return { error: '你已提交过加入申请' };
    if (this.findFamilyOf(account)) return { error: '该用户已加入其它家庭' };
    f.members.push({
      account,
      role: FAMILY_ROLES.includes(role) ? role : 'member',
      joinedAt: Date.now(),
      devices: [],
      pending: true,
    });
    save();
    return { family: f };
  },
  /** 审核通过 */
  approveFamilyMember(familyId, account) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    const m = (f.members || []).find((x) => x.account === account);
    if (m) { m.pending = false; m.approvedAt = Date.now(); save(); }
    return f;
  },
  /** 修改成员角色 */
  setFamilyRole(familyId, account, role) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    const m = (f.members || []).find((x) => x.account === account);
    if (m) { m.role = FAMILY_ROLES.includes(role) ? role : m.role; save(); }
    return f;
  },
  /** 成员设备登记（幂等：同 id 只更新 lastAt） */
  touchDevice(familyId, account, deviceId, deviceName) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    const m = (f.members || []).find((x) => x.account === account);
    if (!m) return null;
    m.devices = m.devices || [];
    const id = String(deviceId || '').slice(0, 64) || 'unknown';
    const hit = m.devices.find((d) => d.id === id);
    if (hit) { hit.lastAt = Date.now(); hit.name = deviceName || hit.name; }
    else m.devices.push({ id, name: String(deviceName || '未知设备').slice(0, 40), lastAt: Date.now() });
    save();
    return m;
  },
  /** 家庭额度池扣减 */
  useFamilyQuota(familyId, cost) {
    const f = this.getFamily(familyId);
    if (!f) return 0;
    const pool = Number(f.quotaPool) || 0;
    if (pool === -1) return -1;              // 无限池
    const remain = Math.max(0, pool - (Number(f.poolUsed) || 0));
    const use = Math.min(remain, Math.max(0, cost));
    f.poolUsed = (Number(f.poolUsed) || 0) + use;
    save();
    return use;
  },
  /** 家庭额度池充值 */
  refillFamilyQuota(familyId, amount) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    const amt = Math.trunc(Number(amount) || 0);
    f.quotaPool = (Number(f.quotaPool) || 0);
    if (f.quotaPool === -1) return f;        // 无限保持
    f.quotaPool = Math.max(0, f.quotaPool + amt);
    save();
    return f;
  },
  removeFamilyMember(familyId, account) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    f.members = (f.members || []).filter((m) => m.account !== account);
    save();
    return f;
  },
  /* 邀请码 */
  getInvites() {
    return load().invites || [];
  },
  createInvite(familyId, by, ttlMs = 3 * 86400000, role = 'member', extra = {}) {
    const s = load();
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const inv = {
      code,
      familyId,
      by,
      role: FAMILY_ROLES.includes(role) ? role : 'member',
      maxUses: Math.max(1, Math.trunc(Number(extra.maxUses) || 1)),
      usedCount: 0,
      note: String(extra.note || '').slice(0, 60),
      used: false,
      expire: Date.now() + ttlMs,
      createdAt: Date.now(),
    };
    s.invites.push(inv);
    if (s.invites.length > 2000) s.invites = s.invites.slice(-2000);
    save();
    return inv;
  },
  findInvite(code) {
    const c = String(code || '').toUpperCase();
    return (load().invites || []).find((i) => i.code === c);
  },
  consumeInvite(code) {
    const inv = this.findInvite(code);
    if (inv) {
      inv.usedCount = (Number(inv.usedCount) || 0) + 1;
      if (inv.usedCount >= (inv.maxUses || 1)) inv.used = true;
      save();
    }
    return inv;
  },
  revokeInvite(code) {
    const s = load();
    s.invites = (s.invites || []).filter((i) => i.code !== String(code).toUpperCase());
    save();
  },
  /** 家庭列表（后台） */
  getFamilyList() {
    const fams = load().families || [];
    return fams.map((f) => {
      const owner = this.findUser(f.owner);
      const members = f.members || [];
      return {
        ...f,
        ownerNickname: owner ? owner.nickname || owner.account : f.owner,
        count: members.filter((m) => !m.pending).length,
        pending: members.filter((m) => m.pending).length,
        max: (load().settings.family && load().settings.family.maxMembers) || 5,
        devices: members.reduce((n, m) => n + ((m.devices || []).length), 0),
        quotaPool: Number(f.quotaPool) || 0,
        poolUsed: Number(f.poolUsed) || 0,
      };
    });
  },

  /* ------------------------- 会员 / 钱包 / 订单 ------------------------- */

  /** 全部订单（新→旧） */
  getOrders() {
    return load().orders || [];
  },
  /** 按用户查订单 */
  getOrdersOf(account, limit = 100) {
    return (load().orders || [])
      .filter((o) => o.account === account)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },
  findOrder(id) {
    return (load().orders || []).find((x) => x.id === id);
  },
  /**
   * 创建订单
   * type: vip=会员套餐 | recharge=余额充值
   */
  addOrder(order) {
    const s = load();
    if (!order.id) {
      order.id = 'ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    order.status = order.status || 'pending';   // pending | paid | refunded | expired | cancelled
    order.createdAt = Date.now();
    order.expire = order.expire || Date.now() + ((s.settings.monetize.orderTimeout || 30) * 60000);
    order.payAt = null;
    s.orders.unshift(order);
    // 单文件不宜无限增长
    if (s.orders.length > 50000) s.orders.length = 50000;
    save();
    return order;
  },
  updateOrder(id, patch) {
    const o = this.findOrder(id);
    if (!o) return null;
    Object.assign(o, patch);
    save();
    return o;
  },
  /** 将超时未支付订单标记为过期 */
  expireOrders() {
    const s = load();
    const now = Date.now();
    let n = 0;
    for (const o of s.orders || []) {
      if (o.status === 'pending' && o.expire && o.expire < now) {
        o.status = 'expired';
        n++;
      }
    }
    if (n) save();
    return n;
  },
  /** 后台订单分页查询 */
  queryOrders(opts = {}) {
    let list = (load().orders || []).slice();
    if (opts.status) list = list.filter((o) => o.status === opts.status);
    if (opts.type) list = list.filter((o) => (o.type || 'vip') === opts.type);
    if (opts.account) {
      const a = String(opts.account).toLowerCase();
      list = list.filter((o) => String(o.account || '').toLowerCase().includes(a));
    }
    if (opts.keyword) {
      const k = String(opts.keyword).toLowerCase();
      list = list.filter(
        (o) =>
          o.id.toLowerCase().includes(k) ||
          String(o.planName || '').toLowerCase().includes(k) ||
          String(o.account || '').toLowerCase().includes(k)
      );
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const page = Math.max(1, opts.page || 1);
    const size = Math.min(100, opts.size || 20);
    return {
      total,
      page,
      size,
      list: list.slice((page - 1) * size, page * size),
      summary: this.revenueSummary(),
    };
  },

  /** 收入看板 */
  revenueSummary() {
    const s = load();
    const orders = s.orders || [];
    const paid = orders.filter((o) => o.status === 'paid');
    const todayKey = new Date().toISOString().slice(0, 10);
    const sum = (arr) => arr.reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const isToday = (o) => new Date(o.payAt || o.createdAt).toISOString().slice(0, 10) === todayKey;

    // 近 14 天收入
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const dayOrders = paid.filter((o) => new Date(o.payAt || o.createdAt).toISOString().slice(0, 10) === d);
      days.push({ date: d, amount: sum(dayOrders), count: dayOrders.length });
    }

    // 按套餐维度
    const byPlan = {};
    for (const o of paid) {
      const k = o.planName || o.planId || '未知';
      if (!byPlan[k]) byPlan[k] = { name: k, count: 0, amount: 0 };
      byPlan[k].count++;
      byPlan[k].amount += Number(o.amount) || 0;
    }

    return {
      revenue: sum(paid),
      todayRevenue: sum(paid.filter(isToday)),
      todayCount: paid.filter(isToday).length,
      paidCount: paid.length,
      pendingCount: orders.filter((o) => o.status === 'pending').length,
      refundedCount: orders.filter((o) => o.status === 'refunded').length,
      refundedAmount: sum(orders.filter((o) => o.status === 'refunded')),
      orderCount: orders.length,
      // 客单价
      arpu: paid.length ? +(sum(paid) / paid.length).toFixed(2) : 0,
      days,
      byPlan: Object.values(byPlan).sort((a, b) => b.amount - a.amount),
      // 付费用户数
      payers: new Set(paid.map((o) => o.account).filter(Boolean)).size,
    };
  },

  /** 套餐查找 */
  findPlan(planId) {
    return (load().settings.monetize.plans || []).find((p) => p.id === planId);
  },

  /* ------------------------- 钱包余额 ------------------------- */
  /** 修改用户余额（delta 正负），返回新余额 */
  addBalance(account, delta) {
    const u = this.findUser(account);
    if (!u) return null;
    u.balance = Math.max(0, Math.round(((u.balance || 0) + Number(delta || 0)) * 100) / 100);
    this.upsertUser(u);
    return u.balance;
  },
  /** 钱包流水（从订单推算，无需单独表） */
  getWalletLog(account, limit = 50) {
    return this.getOrdersOf(account, 200)
      .filter((o) => o.status === 'paid' || o.status === 'refunded')
      .slice(0, limit);
  },

  /* ------------------------- 额度（观看次数 / 通用点数） ------------------------- */
  /** 归一化读取用户额度（缺失字段补默认值，兼容旧数据） */
  getQuota(account) {
    const u = this.findUser(account);
    if (!u) return null;
    const q = u.quota || {};
    return {
      times: Number.isFinite(q.times) ? q.times : 0,
      points: Number.isFinite(q.points) ? q.points : 0,
      usedPlays: Number(q.usedPlays) || 0,
      usedPoints: Number(q.usedPoints) || 0,
      dayKey: q.dayKey || '',
      dayUsed: Number(q.dayUsed) || 0,
      plays: q.plays || {},
      updatedAt: q.updatedAt || 0,
    };
  },
  /** 覆盖式写入额度（patch 中出现的键才会被覆盖） */
  setQuota(account, patch = {}) {
    const u = this.findUser(account);
    if (!u) return null;
    const q = this.getQuota(account) || {};
    Object.assign(q, patch);
    q.updatedAt = Date.now();
    u.quota = q;
    this.upsertUser(u);
    return q;
  },
  /** 增量增减额度：{ times, points }，不为负；-1 表示无限并保持无限 */
  addQuota(account, delta = {}) {
    const u = this.findUser(account);
    if (!u) return null;
    const q = this.getQuota(account) || {};
    const bump = (cur, d) => {
      if (cur === -1) return -1;                    // 已无限则保持无限
      const next = Math.round((Number(cur) || 0) + (Number(d) || 0));
      return next < 0 ? 0 : next;
    };
    if (delta.times !== undefined) q.times = bump(q.times, delta.times);
    if (delta.points !== undefined) q.points = bump(q.points, delta.points);
    q.updatedAt = Date.now();
    u.quota = q;
    this.upsertUser(u);
    return q;
  },
  /** 记录一次观看（同步完成：扣减 + 去重打点 + 统计），返回最新额度 */
  commitWatch(account, decision = {}) {
    const u = this.findUser(account);
    if (!u) return null;
    const q = this.getQuota(account) || {};
    const now = Date.now();
    const guid = String(decision.guid || '');

    if (decision.source === 'free') {
      q.dayKey = decision.dayKey || q.dayKey;
      q.dayUsed = Number(decision.dayUsed) || (Number(q.dayUsed) || 0) + 1;
    } else if (decision.source === 'times' && decision.cost > 0) {
      q.times = q.times === -1 ? -1 : Math.max(0, q.times - decision.cost);
      q.usedPlays = (q.usedPlays || 0) + decision.cost;
    } else if (decision.source === 'points' && decision.cost > 0) {
      q.points = q.points === -1 ? -1 : Math.max(0, q.points - decision.cost);
      q.usedPoints = (q.usedPoints || 0) + decision.cost;
    }
    if (guid) {
      if (!q.plays) q.plays = {};
      q.plays[guid] = now;
      // 清理 7 天前的去重记录，防止无限膨胀
      const cutoff = now - 7 * 86400000;
      const keys = Object.keys(q.plays);
      if (keys.length > 3000) {
        for (const k of keys) if (q.plays[k] < cutoff) delete q.plays[k];
      }
    }
    q.updatedAt = now;
    u.quota = q;
    this.upsertUser(u);
    return q;
  },
  /** 扣减点数（用于增值功能） */
  spendPoints(account, cost, reason) {
    const q = this.addQuota(account, { points: -Math.abs(cost) });
    if (q) {
      const q2 = this.getQuota(account);
      if (q2) q2.usedPoints = (q2.usedPoints || 0) + Math.abs(cost);
      this.setQuota(account, { usedPoints: q2 ? q2.usedPoints : 0 });
    }
    return q;
  },
  /** 额度流水 */
  addQuotaLog(entry = {}) {
    const s = load();
    s.quotaLog = s.quotaLog || [];
    const rec = {
      id: 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      account: entry.account || '',
      type: entry.type === 'points' ? 'points' : 'times',   // 变动维度
      delta: Number(entry.delta) || 0,                       // 正=增加 负=消耗
      reason: String(entry.reason || '').slice(0, 60),
      ref: String(entry.ref || '').slice(0, 60),
      after: entry.after === undefined ? null : entry.after,
      createdAt: Date.now(),
    };
    s.quotaLog.unshift(rec);
    if (s.quotaLog.length > 20000) s.quotaLog.length = 20000;
    save();
    return rec;
  },
  getQuotaLog(account, limit = 50) {
    return (load().quotaLog || [])
      .filter((x) => x.account === account)
      .slice(0, Math.max(1, Math.min(500, limit)));
  },
  /** 后台：额度列表（含用户基础信息） */
  queryQuotaUsers(opts = {}) {
    let list = (load().users || []).map((u) => {
      const q = u.quota || {};
      return {
        account: u.account,
        nickname: u.nickname || u.account,
        vip: !!(u.vip && u.vip.expire > Date.now()),
        times: Number.isFinite(q.times) ? q.times : 0,
        points: Number.isFinite(q.points) ? q.points : 0,
        usedPlays: Number(q.usedPlays) || 0,
        usedPoints: Number(q.usedPoints) || 0,
        createdAt: u.createdAt || 0,
      };
    });
    if (opts.keyword) {
      const k = String(opts.keyword).toLowerCase();
      list = list.filter((x) => x.account.includes(k) || x.nickname.toLowerCase().includes(k));
    }
    if (opts.status === 'has') list = list.filter((x) => x.times > 0 || x.points > 0 || x.times === -1 || x.points === -1);
    else if (opts.status === 'empty') list = list.filter((x) => x.times <= 0 && x.points <= 0);
    list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const page = Math.max(1, opts.page || 1);
    const size = Math.min(200, opts.size || 20);
    return { total, page, size, list: list.slice((page - 1) * size, page * size) };
  },
  /** 额度系统统计 */
  quotaStats() {
    const users = load().users || [];
    let unlimited = 0, withTimes = 0, withPoints = 0;
    let totalTimes = 0, totalPoints = 0, usedPlays = 0, usedPoints = 0;
    for (const u of users) {
      const q = u.quota;
      if (!q) continue;
      if (q.times === -1 || q.points === -1) unlimited++;
      if (q.times > 0 || q.times === -1) withTimes++;
      if (q.points > 0 || q.points === -1) withPoints++;
      if (q.times > 0) totalTimes += q.times;
      if (q.points > 0) totalPoints += q.points;
      usedPlays += Number(q.usedPlays) || 0;
      usedPoints += Number(q.usedPoints) || 0;
    }
    return { unlimited, withTimes, withPoints, totalTimes, totalPoints, usedPlays, usedPoints, users: users.length };
  },

  /* ------------------------- 兑换码 ------------------------- */
  getRedeemCodes() {
    return load().redeemCodes || [];
  },
  /** 批量创建兑换码
   *  item: { type:'vip'|'balance'|'quota_times'|'quota_points',
   *          value: 天数 | 金额 | 次数 | 点数, planName, count, batch, ttlDays }
   */
  createRedeemCodes(item = {}) {
    const s = load();
    s.redeemCodes = s.redeemCodes || [];
    const count = Math.max(1, Math.min(500, parseInt(item.count, 10) || 1));
    const out = [];
    const batch = item.batch || 'B' + Date.now().toString(36).toUpperCase();
    const type = REDEEM_TYPES.includes(item.type) ? item.type : 'vip';
    for (let i = 0; i < count; i++) {
      const code = genRedeemCode();
      const rec = {
        code,
        type,
        value: Number(item.value) || 0,
        planName: item.planName || REDEEM_TYPE_NAME[type],
        batch,
        used: false,
        usedBy: null,
        usedAt: null,
        expire: item.ttlDays ? Date.now() + item.ttlDays * 86400000 : 0,
        createdAt: Date.now(),
      };
      s.redeemCodes.unshift(rec);
      out.push(rec);
    }
    if (s.redeemCodes.length > 50000) s.redeemCodes.length = 50000;
    save();
    return out;
  },
  findRedeemCode(code) {
    // 用户输入容错：忽略大小写、空格与连字符
    const norm = (x) => String(x || '').trim().toUpperCase().replace(/[\s-]/g, '');
    const c = norm(code);
    if (!c) return null;
    return (load().redeemCodes || []).find((x) => norm(x.code) === c);
  },
  /** 核销兑换码 */
  consumeRedeemCode(code, account) {
    const rec = this.findRedeemCode(code);
    if (!rec) return null;
    rec.used = true;
    rec.usedBy = account;
    rec.usedAt = Date.now();
    save();
    return rec;
  },
  /** 后台兑换码分页查询 */
  queryRedeemCodes(opts = {}) {
    let list = (load().redeemCodes || []).slice();
    if (opts.batch) list = list.filter((x) => x.batch === opts.batch);
    if (opts.type) list = list.filter((x) => x.type === opts.type);
    if (opts.status === 'used') list = list.filter((x) => x.used);
    else if (opts.status === 'unused') list = list.filter((x) => !x.used);
    if (opts.keyword) {
      const k = String(opts.keyword).toUpperCase();
      list = list.filter((x) => x.code.includes(k) || String(x.usedBy || '').includes(k));
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const page = Math.max(1, opts.page || 1);
    const size = Math.min(200, opts.size || 50);
    const batches = [...new Set((load().redeemCodes || []).map((x) => x.batch))].filter(Boolean);
    return { total, page, size, list: list.slice((page - 1) * size, page * size), batches };
  },
  deleteRedeemCodes(ids = []) {
    const s = load();
    const set = new Set(ids);
    s.redeemCodes = (s.redeemCodes || []).filter((x) => !set.has(x.code));
    save();
  },

  /* ------------------------- 会话 ------------------------- */
  setSession(token, data) {
    const s = load();
    s.sessions[token] = { ...data, ts: Date.now() };
    save();
  },
  getSession(token) {
    const s = load();
    const it = s.sessions[token];
    if (!it) return null;
    if (Date.now() - it.ts > 7 * 86400000) {
      delete s.sessions[token];
      save();
      return null;
    }
    return it;
  },
  delSession(token) {
    const s = load();
    delete s.sessions[token];
    save();
  },
  /** 吊销全部后台会话（改管理口令后强制重新登录） */
  revokeAllSessions() {
    const s = load();
    for (const [tok, sess] of Object.entries(s.sessions || {})) {
      if (sess && sess.role === 'admin') delete s.sessions[tok];
    }
    save();
  },

  /** 重置为出厂设置（后台用） */
  reset() {
    state = initialState();
    state.columns = loadColumnsFile();
    save();
  },

  /* ============================================================
   * 短视频（用户发布，抖音式）
   * ============================================================ */
  getShorts({ status, account, keyword } = {}) {
    let list = load().shorts || [];
    if (status) list = list.filter((s) => (s.status || 'pending') === status);
    if (account) list = list.filter((s) => s.account === account);
    if (keyword) {
      const k = String(keyword).toLowerCase();
      list = list.filter((s) => (s.title || '').toLowerCase().includes(k) || (s.desc || '').toLowerCase().includes(k));
    }
    return list;
  },

  findShort(id) {
    return (load().shorts || []).find((s) => s.id === id);
  },

  /** 新增/更新短视频 */
  upsertShort(item) {
    const s = load();
    s.shorts = s.shorts || [];
    const i = s.shorts.findIndex((x) => x.id === item.id);
    if (i >= 0) s.shorts[i] = { ...s.shorts[i], ...item };
    else s.shorts.unshift(item);
    save();
    return item;
  },

  deleteShort(id) {
    const s = load();
    s.shorts = (s.shorts || []).filter((x) => x.id !== id);
    save();
  },

  /** 点赞/取消点赞（一次） */
  toggleShortLike(id, account) {
    const s = load();
    const it = (s.shorts || []).find((x) => x.id === id);
    if (!it) return null;
    it.likes = it.likes || [];
    const i = it.likes.indexOf(account);
    if (i >= 0) it.likes.splice(i, 1);
    else it.likes.push(account);
    save();
    return { liked: i < 0, likes: it.likes.length };
  },

  /** 播放计数 */
  bumpShortView(id) {
    const s = load();
    const it = (s.shorts || []).find((x) => x.id === id);
    if (!it) return;
    it.views = (it.views || 0) + 1;
    save();
  },

  /* ============================================================
   * 追剧订阅
   * ============================================================ */
  getFollows(account) {
    return (load().follows || []).filter((f) => f.account === account);
  },

  findFollow(account, type, targetId) {
    return (load().follows || []).find((f) => f.account === account && f.type === type && f.targetId === targetId);
  },

  /** 关注/取关，返回 {following:boolean} */
  toggleFollow(account, item) {
    const s = load();
    s.follows = s.follows || [];
    const i = s.follows.findIndex((f) => f.account === account && f.type === item.type && f.targetId === item.targetId);
    if (i >= 0) {
      s.follows.splice(i, 1);
      save();
      return { following: false };
    }
    s.follows.unshift({ account, ...item, updatedAt: Date.now() });
    save();
    return { following: true };
  },

  /** 更新追剧进度（最新集） */
  touchFollow(account, type, targetId, patch = {}) {
    const s = load();
    const f = (s.follows || []).find((x) => x.account === account && x.type === type && x.targetId === targetId);
    if (f) { Object.assign(f, patch, { updatedAt: Date.now() }); save(); }
    return f;
  },

  /** 导出/导入配置 */
  exportConfig() {
    const s = load();
    return {
      settings: s.settings,
      sources: s.sources,
      columns: s.columns.columns,
      exportedAt: new Date().toISOString(),
      version: 1,
    };
  },
  importConfig(cfg) {
    const s = load();
    if (cfg.settings) s.settings = mergeDeep(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), cfg.settings);
    if (cfg.sources) s.sources = cfg.sources;
    if (cfg.columns) s.columns.columns = cfg.columns;
    save();
  },
};

/** 兑换码支持的四种类型 */
const REDEEM_TYPES = ['vip', 'balance', 'quota_times', 'quota_points'];
/** 各类型的默认名称 */
const REDEEM_TYPE_NAME = {
  vip: '会员兑换',
  balance: '余额充值',
  quota_times: '观看次数额度',
  quota_points: '通用点数',
};

/** 生成兑换码：4 组 4 位，形如 A1B2-C3D4-E5F6-G7H8（去掉易混字符） */
function genRedeemCode() {
  const AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1
  const pick = () => AB[crypto.randomInt(0, AB.length)];
  const seg = () => Array.from({ length: 4 }, pick).join('');
  return [seg(), seg(), seg(), seg()].join('-');
}

/** 家庭成员角色（对标 Jellyfin 用户组 / Plex 子账户 / Emby 用户权限） */
const FAMILY_ROLES = ['owner', 'admin', 'member', 'child', 'guest'];
const FAMILY_ROLE_NAME = {
  owner: '户主',
  admin: '家庭管理员',
  member: '成员',
  child: '儿童',
  guest: '访客',
};
/** 角色默认能力（可被 settings 覆盖） */
const FAMILY_ROLE_PERMS = {
  owner: { watch: true, hd: true, download: true, comment: true, invite: true, manage: true, shareQuota: true },
  admin: { watch: true, hd: true, download: true, comment: true, invite: true, manage: true, shareQuota: true },
  member: { watch: true, hd: true, download: true, comment: true, invite: false, manage: false, shareQuota: true },
  child: { watch: true, hd: false, download: false, comment: false, invite: false, manage: false, shareQuota: true },
  guest: { watch: true, hd: false, download: false, comment: false, invite: false, manage: false, shareQuota: false },
};
/** 内容分级顺序（对标 Jellyfin ParentalRating） */
const RATING_LEVELS = ['G', 'PG', 'PG13', 'R', 'UNRATED'];

/** 重新统计各分类的栏目数量 */
function recountCategories(s) {
  const cats = s.columns.categories || [];
  for (const cat of cats) {
    cat.count = (s.columns.columns || []).filter((c) => c.category === cat.id).length;
  }
  s.columns.categories = cats.filter((c) => c.count > 0);
}

module.exports = {
  store, DEFAULT_SETTINGS, DEFAULT_SOURCES,
  REDEEM_TYPES, REDEEM_TYPE_NAME,
  FAMILY_ROLES, FAMILY_ROLE_NAME, FAMILY_ROLE_PERMS, RATING_LEVELS,
};
