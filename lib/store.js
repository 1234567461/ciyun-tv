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
  // 会员付费模块开关（开源版默认关闭，核心观看永远免费）
  monetize: {
    enabled: false,
    plans: [
      { id: 'vip_month', name: '月度会员', days: 30, price: 12, perks: ['去广告', '超清画质', '无限收藏'] },
      { id: 'vip_year', name: '年度会员', days: 365, price: 98, perks: ['去广告', '超清画质', '无限收藏', '专属线路'] },
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
    interval: 15,              // 同一用户两条评论最小间隔（秒）
    maxLen: 500,               // 单条评论最大字数
    keywords: ['加微信', '代刷', '赌博', '博彩', '私聊', '广告位', '出售', '办证'],
  },
  // 家庭共享（付费增值模块，1 户主 + 最多 5 成员）
  family: {
    enabled: true,             // 模块开关
    requireVip: true,          // 是否要求户主为会员才能创建
    maxMembers: 5,             // 最多可邀请成员数（不含户主）
    allowLeave: true,          // 成员是否可主动退出
    shareVip: true,            // 成员是否共享户主会员权益
  },
};

/** 默认内置源（央视官方公开） */
const DEFAULT_SOURCES = [
  {
    id: 'cctv-official',
    name: '央视网（官方公开）',
    type: 'cctv',
    enabled: true,
    builtin: true,
    desc: '央视网 tv.cctv.com 公开接口，栏目点播 + 频道直播',
    config: { serviceId: 'tvcctv' },
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
      orders: (s.orders || []).length,
      comments: (s.comments || []).length,
      pendingComments: (s.comments || []).filter((c) => c.status === 'pending').length,
      revenue: (s.orders || [])
        .filter((o) => o.status === 'paid')
        .reduce((a, o) => a + (o.amount || 0), 0),
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
      members: [],           // [{account, joinedAt}]
      createdAt: Date.now(),
      maxMembers: (s.settings.family && s.settings.family.maxMembers) || 5,
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
  addFamilyMember(familyId, account) {
    const f = this.getFamily(familyId);
    if (!f) return { error: '家庭不存在' };
    const max = (load().settings.family && load().settings.family.maxMembers) || 5;
    if ((f.members || []).length >= max) return { error: `成员已达上限（最多 ${max} 人）` };
    if (f.owner === account) return { error: '户主已在家庭中' };
    if ((f.members || []).some((m) => m.account === account)) return { error: '该用户已在家庭中' };
    if (this.findFamilyOf(account)) return { error: '该用户已加入其它家庭' };
    f.members.push({ account, joinedAt: Date.now() });
    save();
    return { family: f };
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
  createInvite(familyId, by, ttlMs = 3 * 86400000) {
    const s = load();
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const inv = {
      code,
      familyId,
      by,
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
    if (inv) { inv.used = true; save(); }
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
      return {
        ...f,
        ownerNickname: owner ? owner.nickname || owner.account : f.owner,
        count: (f.members || []).length,
        max: (load().settings.family && load().settings.family.maxMembers) || 5,
      };
    });
  },

  /* ------------------------- 会员/订单 ------------------------- */
  getOrders() {
    return load().orders || [];
  },
  addOrder(order) {
    const s = load();
    order.id = order.id || 'ord_' + Date.now().toString(36);
    order.createdAt = Date.now();
    s.orders.unshift(order);
    save();
    return order;
  },
  updateOrder(id, patch) {
    const s = load();
    const o = s.orders.find((x) => x.id === id);
    if (o) {
      Object.assign(o, patch);
      save();
    }
    return o;
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

  /** 重置为出厂设置（后台用） */
  reset() {
    state = initialState();
    state.columns = loadColumnsFile();
    save();
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

/** 重新统计各分类的栏目数量 */
function recountCategories(s) {
  const cats = s.columns.categories || [];
  for (const cat of cats) {
    cat.count = (s.columns.columns || []).filter((c) => c.category === cat.id).length;
  }
  s.columns.categories = cats.filter((c) => c.count > 0);
}

module.exports = { store, DEFAULT_SETTINGS, DEFAULT_SOURCES };
