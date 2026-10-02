'use strict';
/**
 * 慈云影视 - 主服务
 * ============================================================
 * 一个基于官方公开接口的影视聚合平台：
 *   · 点播：央视网 211 个栏目、数十万集视频，HLS 播放
 *   · 直播：17 个央视频道 EPG 节目单 + 直播流
 *   · 搜索：站内聚合搜索
 *   · 自定义源：后台可添加任意上游接口 / 直链
 *   · 后台管理：内容 / 统计 / 设置 / 接口监控 / 会员(可选)
 *
 * 开源协议：MIT
 */

const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const cctv = require('./lib/cctv');
const stream = require('./lib/stream');
const sources = require('./lib/sources');
const account = require('./lib/account');
const chat = require('./lib/chat');
const { store } = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 8811;
const HOST = process.env.HOST || '0.0.0.0';

app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ------------------------- 访问日志 & 统计 ------------------------- */
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && !req.path.startsWith('/api/stream')) {
    // 简单节流统计
    if (Math.random() < 0.1) store.recordVisit(req.path);
  }
  next();
});

/* ============================================================
 * API：站点信息
 * ============================================================ */
app.get('/api/site', (req, res) => {
  const s = store.settings;
  res.json({
    siteName: s.siteName,
    slogan: s.slogan,
    logo: s.logo,
    theme: s.theme,
    announcement: s.announcement,
    showAds: s.showAds,
    monetize: { enabled: s.monetize.enabled, plans: s.monetize.plans },
    playback: s.playback,
    community: {
      enabled: s.community.enabled !== false,
      allowRegister: s.community.allowRegister !== false,
      allowComment: s.community.allowComment !== false,
      guestComment: !!s.community.guestComment,
      commentReview: !!s.community.commentReview,
      needEmail: !!s.community.needEmail,
      maxLen: s.community.maxLen || 500,
    },
    family: {
      enabled: s.family.enabled !== false,
      requireVip: s.family.requireVip !== false,
      maxMembers: s.family.maxMembers || 5,
      shareVip: s.family.shareVip !== false,
    },
  });
});

/* ============================================================
 * API：栏目 / 分类
 * ============================================================ */
app.get('/api/categories', (req, res) => {
  res.json({ categories: store.categories });
});

app.get('/api/columns', (req, res) => {
  const { category, keyword, featured, page = 1, size = 60 } = req.query;
  let list = store.getColumns().filter((c) => c.enabled !== false);
  if (category && category !== 'all') list = list.filter((c) => c.category === category);
  if (featured === '1') list = list.filter((c) => c.featured);
  if (keyword) {
    const k = String(keyword).toLowerCase();
    list = list.filter((c) => c.name.toLowerCase().includes(k));
  }
  const total = list.length;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const sz = Math.min(200, parseInt(size, 10) || 60);
  const items = list.slice((p - 1) * sz, p * sz);
  res.json({ total, page: p, size: sz, list: items });
});

app.get('/api/columns/:id', (req, res) => {
  const col = store.getColumns().find((c) => c.id === req.params.id);
  if (!col) return res.status(404).json({ error: 'column not found' });
  res.json(col);
});

/** 栏目下的视频列表（分页） */
app.get('/api/columns/:id/videos', async (req, res) => {
  const col = store.getColumns().find((c) => c.id === req.params.id);
  if (!col) return res.status(404).json({ error: 'column not found' });
  try {
    const p = parseInt(req.query.page, 10) || 1;
    const n = Math.min(60, parseInt(req.query.size, 10) || 24);
    const data = await cctv.getColumnVideos(col.ctid, { p, n });
    res.json({ ...data, page: p, size: n, column: { id: col.id, name: col.name } });
  } catch (e) {
    res.status(502).json({ error: 'upstream failed', message: e.message });
  }
});

/* ============================================================
 * API：首页聚合数据
 * ============================================================ */
app.get('/api/home', async (req, res) => {
  try {
    const cats = store.categories;
    const cols = store.getColumns().filter((c) => c.enabled !== false);
    const featured = cols.filter((c) => c.featured).slice(0, 8);

    // 并行拉取首页若干栏目的最新视频（每个分类取一个栏目）
    const picks = [];
    for (const cat of cats) {
      const c = cols.find((x) => x.category === cat.id);
      if (c) picks.push(c);
    }
    const blocks = await Promise.all(
      picks.slice(0, 8).map(async (col) => {
        try {
          const d = await cctv.getColumnVideos(col.ctid, { p: 1, n: 12 });
          return {
            categoryId: col.category,
            column: { id: col.id, name: col.name, ctid: col.ctid },
            list: d.list,
          };
        } catch {
          return { categoryId: col.category, column: { id: col.id, name: col.name }, list: [] };
        }
      })
    );

    res.json({
      featured,
      columns: cols.slice(0, 24),
      categories: cats,
      blocks: blocks.filter((b) => b.list.length),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
 * API：播放
 * ============================================================ */
app.get('/api/video/:guid', async (req, res) => {
  try {
    const info = await cctv.getPlayInfo(req.params.guid);
    store.recordPlay(req.params.guid, { title: info.title });
    res.json({
      ...info,
      // 提供给前端的可选播放地址（经本地代理，规避跨域）
      src: info.hls ? `/api/stream?url=${encodeURIComponent(info.hls)}` : '',
      // 多线路：主 HLS + 加密 HLS + FLV
      lines: buildLines(info),
    });
  } catch (e) {
    res.status(502).json({ error: 'play info failed', message: e.message });
  }
});

function buildLines(info) {
  const lines = [];
  if (info.hls) lines.push({ id: 'hls', name: '高清线路', type: 'hls', url: info.hls });
  if (info.hlsEnc && info.hlsEnc !== info.hls)
    lines.push({ id: 'hls-enc', name: '备用线路', type: 'hls', url: info.hlsEnc });
  if (info.flv) lines.push({ id: 'flv', name: 'FLV 线路', type: 'flv', url: info.flv });
  for (let i = 0; i < (info.chapters || []).length; i++) {
    const c = info.chapters[i];
    if (c.url && !lines.find((l) => l.url === c.url)) {
      lines.push({ id: 'ch' + i, name: '分段线路 ' + (i + 1), type: 'hls', url: c.url });
    }
  }
  return lines;
}

/** 多线路可用性探测：返回第一个可用线路 */
app.get('/api/video/:guid/best-line', async (req, res) => {
  try {
    const info = await cctv.getPlayInfo(req.params.guid);
    const cands = [info.hls, info.hlsEnc, info.flv].filter(Boolean);
    if (!cands.length) return res.status(404).json({ error: 'no line' });
    const picked = await stream.pickWorkingStream(cands);
    res.json({
      ...picked,
      src: `/api/stream?url=${encodeURIComponent(picked.url)}`,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** 探测清晰度档位 */
app.get('/api/qualities', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const text = await cctv.requestText(url, { headers: stream.upstreamHeaders(url) });
    const variants = stream.parseMasterPlaylist(text, url);
    res.json({
      variants: variants.map((v) => ({
        ...v,
        label: v.resolution
          ? v.resolution.replace('x', '×') + (v.bandwidth >= 2048000 ? ' 超清' : v.bandwidth >= 1228800 ? ' 高清' : ' 标清')
          : Math.round(v.bandwidth / 1000) + ' kbps',
        src: `/api/stream?url=${encodeURIComponent(v.url)}`,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ============================================================
 * API：流媒体代理（核心，兼容所有协议）
 * ============================================================ */
app.get('/api/stream', async (req, res) => {
  let url = req.query.url;
  if (!url) return res.status(400).send('url required');
  url = decodeURIComponent(url);
  // 幂等：若传入地址本身已是被包裹过的代理地址，解出真实地址
  const m = /\/api\/stream\?url=(.+)$/.exec(url);
  if (m) url = decodeURIComponent(m[1]);
  if (!/^https?:\/\//i.test(url)) return res.status(400).send('invalid url');
  try {
    await stream.proxyStream(url, req, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send('upstream error: ' + e.message);
  }
});

/** 探测地址类型与可用性（前端切换线路用） */
app.get('/api/probe', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const picked = await stream.pickWorkingStream([url]);
    res.json({ ok: true, type: picked.type, url });
  } catch (e) {
    res.json({ ok: false, error: e.message, url });
  }
});

/* ============================================================
 * API：搜索
 * ============================================================ */
app.get('/api/search', async (req, res) => {
  const kw = (req.query.q || '').trim();
  if (!kw) return res.json({ list: [] });
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const r = await cctv.search(kw, { page });
    // 若搜索结果为视频页，尝试补全封面
    const list = await Promise.all(
      r.list.slice(0, 24).map(async (it) => {
        if (it.image) return it;
        try {
          const p = await cctv.getVideoPage(it.url);
          return { ...it, guid: p.guid || it.guid, image: p.image, brief: p.brief || '' };
        } catch {
          return it;
        }
      })
    );
    res.json({ keyword: kw, list, source: '央视网' });
  } catch (e) {
    res.status(502).json({ error: 'search failed', message: e.message });
  }
});

/* ============================================================
 * API：直播
 * ============================================================ */
app.get('/api/live/channels', (req, res) => {
  res.json({ channels: store.liveChannels });
});

app.get('/api/live/:channel/epg', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const epg = await cctv.getEpg(req.params.channel, date);
    if (!epg) return res.status(404).json({ error: 'epg not found' });
    res.json(epg);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/live/:channel', async (req, res) => {
  try {
    const live = await cctv.getLive(req.params.channel);
    const ch = store.liveChannels.find((c) => c.id === req.params.channel);
    res.json({
      ...live,
      name: ch ? ch.name : req.params.channel,
      src: live.hls ? `/api/stream?url=${encodeURIComponent(live.hls)}` : '',
      flvSrc: live.flv ? `/api/stream?url=${encodeURIComponent(live.flv)}` : '',
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ============================================================
 * API：自定义源管理（后台）+ 多源统一接口
 * ============================================================ */
app.get('/api/sources', (req, res) => {
  const list = store.getSources().map((s) => ({ ...s, detectedType: sources.inferType(s) }));
  res.json({ sources: list });
});

app.post('/api/sources', requireAdmin, (req, res) => {
  const { name, type, url, config, enabled } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const src = store.addSource({
    name,
    type: type || 'auto',
    url: url || '',
    config: config || {},
    enabled: enabled !== false,
  });
  res.json(src);
});

app.put('/api/sources/:id', requireAdmin, (req, res) => {
  const src = store.updateSource(req.params.id, req.body || {});
  if (!src) return res.status(404).json({ error: 'not found' });
  res.json(src);
});

app.delete('/api/sources/:id', requireAdmin, (req, res) => {
  store.deleteSource(req.params.id);
  res.json({ ok: true });
});

/** 测试源连通性：探测分类与首个列表 */
app.post('/api/sources/test', requireAdmin, async (req, res) => {
  const cfg = req.body || {};
  const src = {
    id: 'test',
    name: cfg.name || '测试源',
    type: cfg.type || 'auto',
    url: cfg.url,
    config: cfg.config || {},
  };
  try {
    const cats = await sources.call(src, 'categories').catch(() => []);
    const list = await sources.call(src, 'list', { typeId: (cats[0] && cats[0].id) || '', page: 1 });
    res.json({
      ok: true,
      type: sources.inferType(src),
      categories: cats.length,
      total: list.total || list.list.length,
      sample: list.list.slice(0, 3).map((v) => v.name),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, type: sources.inferType(src) });
  }
});

/**
 * 多源统一接口（前台使用）
 *  GET /api/multi/sources            列出可用源
 *  GET /api/multi/:srcId/categories  源的分类
 *  GET /api/multi/:srcId/list        源的列表
 *  GET /api/multi/:srcId/detail/:id  源的详情（含线路与剧集）
 */
app.get('/api/multi/sources', (req, res) => {
  const list = store
    .getSources()
    .filter((s) => s.enabled !== false)
    .map((s) => ({ id: s.id, name: s.name, type: sources.inferType(s), builtin: !!s.builtin, desc: s.desc || '' }));
  res.json({ sources: list });
});

app.get('/api/multi/:srcId/categories', async (req, res) => {
  const src = store.getSource(req.params.srcId);
  if (!src) return res.status(404).json({ error: 'source not found' });
  try {
    const cats = await sources.call(src, 'categories');
    res.json({ source: src.id, type: sources.inferType(src), categories: cats });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/multi/:srcId/list', async (req, res) => {
  const src = store.getSource(req.params.srcId);
  if (!src) return res.status(404).json({ error: 'source not found' });
  try {
    const r = await sources.call(src, 'list', {
      typeId: req.query.type || '',
      page: parseInt(req.query.page, 10) || 1,
      keyword: req.query.wd || '',
    });
    res.json({ source: src.id, type: sources.inferType(src), ...r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/multi/:srcId/detail/:id', async (req, res) => {
  const src = store.getSource(req.params.srcId);
  if (!src) return res.status(404).json({ error: 'source not found' });
  try {
    const d = await sources.call(src, 'detail', { id: req.params.id });
    // 为每条线路的每个剧集附加播放地址（经代理或直链）
    d.lines = (d.lines || []).map((l) => ({
      ...l,
      episodes: (l.episodes || []).map((ep) => ({
        ...ep,
        // 央视源用 guid 走 /api/video；其他源直接代理
        playUrl: ep.guid ? null : ep.url,
        src: ep.guid ? null : '/api/stream?url=' + encodeURIComponent(ep.url),
      })),
    }));
    res.json(d);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** 跨源聚合搜索 */
app.get('/api/multi/search', async (req, res) => {
  const wd = (req.query.wd || '').trim();
  if (!wd) return res.json({ keyword: '', results: [] });
  const list = store.getSources().filter((s) => s.enabled !== false);
  const results = await sources.searchAll(list, wd, { page: parseInt(req.query.page, 10) || 1 });
  res.json({ keyword: wd, results: results.filter((r) => r.source) });
});


/** 添加栏目（支持栏目简码 / 栏目页 URL，自动解析 ctid） */
app.post('/api/columns/resolve', requireAdmin, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const r = await cctv.resolveColumnId(code.trim());
    if (!r.ctid) return res.status(404).json({ error: '未找到栏目 ID' });
    // 验证是否有视频
    const v = await cctv.getColumnVideos(r.ctid, { p: 1, n: 1 });
    res.json({ ...r, total: v.total, sample: v.list[0] || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ============================================================
 * API：后台管理
 * ============================================================ */

/** 简易鉴权：登录态写在 cookie，默认账号 admin / admin888（可在设置里改） */
function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies['cy_token'];
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const sess = store.getSession(token);
  if (!sess || sess.role !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  req.admin = sess;
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const s = store.settings;
  const expectUser = s.adminUsername || 'admin';
  const expectPass = s.adminPassword || 'admin888';
  if (username !== expectUser || password !== expectPass) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  store.setSession(token, { role: 'admin', user: username });
  res.cookie('cy_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400000 });
  res.json({ ok: true, token });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies && req.cookies['cy_token'];
  if (token) store.delSession(token);
  res.clearCookie('cy_token');
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  const token = req.cookies && req.cookies['cy_token'];
  const sess = token && store.getSession(token);
  if (!sess || sess.role !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, user: sess.user });
});

/** 站点设置读写 */
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(store.settings);
});
app.put('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(store.setSettings(req.body || {}));
});
app.post('/api/admin/settings/reset', requireAdmin, (req, res) => {
  store.setSettings(store.settingsDefaults);
  res.json({ ok: true });
});

/** 栏目管理 */
app.put('/api/admin/columns/:id', requireAdmin, (req, res) => {
  const col = store.updateColumn(req.params.id, req.body || {});
  if (!col) return res.status(404).json({ error: 'not found' });
  res.json(col);
});
app.post('/api/admin/columns', requireAdmin, (req, res) => {
  try {
    const { id, name, ctid, category } = req.body || {};
    if (!name || !ctid) return res.status(400).json({ error: 'name & ctid required' });
    const col = store.addColumn({
      id: id || 'col_' + Date.now().toString(36),
      name,
      ctid,
      category: category || 'other',
      total: 0,
      enabled: true,
      featured: false,
    });
    res.json(col);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/admin/columns/:id', requireAdmin, (req, res) => {
  store.deleteColumn(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/featured', requireAdmin, (req, res) => {
  store.reorderFeatured(req.body.ids || []);
  res.json({ ok: true });
});

/** 统计 */
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json(store.getStats());
});

/** 接口健康监控 */
app.get('/api/admin/health', requireAdmin, async (req, res) => {
  if (req.query.probe === '1') {
    // 主动探测关键接口
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await Promise.allSettled([
      cctv.getColumnVideos('TOPC1451559180488841', { p: 1, n: 1 }),
      cctv.getPlayInfo('85818b83c2a04b619c6ce090dcf3bc3d'),
      cctv.getEpg('cctv1', now),
    ]);
  }
  res.json({ stats: cctv.health.snapshot() });
});

/** 会员套餐设置（付费模块，默认关闭） */
app.put('/api/admin/monetize', requireAdmin, (req, res) => {
  const { enabled, plans } = req.body || {};
  store.setSettings({ monetize: { enabled: !!enabled, plans: plans || store.settings.monetize.plans } });
  res.json(store.settings.monetize);
});

/** 社区设置（注册 / 评论） */
app.put('/api/admin/community', requireAdmin, (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['enabled', 'allowRegister', 'allowComment', 'guestComment', 'commentReview', 'needEmail']) {
    if (b[k] !== undefined) patch[k] = !!b[k];
  }
  if (b.interval !== undefined) patch.interval = Math.max(0, Math.min(600, parseInt(b.interval, 10) || 0));
  if (b.maxLen !== undefined) patch.maxLen = Math.max(10, Math.min(2000, parseInt(b.maxLen, 10) || 500));
  if (Array.isArray(b.keywords)) patch.keywords = b.keywords.map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
  store.setSettings({ community: patch });
  res.json(store.settings.community);
});

/** 家庭共享设置（后台） */
app.put('/api/admin/family', requireAdmin, (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['enabled', 'requireVip', 'allowLeave', 'shareVip']) {
    if (b[k] !== undefined) patch[k] = !!b[k];
  }
  if (b.maxMembers !== undefined) patch.maxMembers = Math.max(1, Math.min(20, parseInt(b.maxMembers, 10) || 5));
  store.setSettings({ family: patch });
  res.json(store.settings.family);
});

/** 家庭列表（后台） */
app.get('/api/admin/families', requireAdmin, (req, res) => {
  res.json({ families: store.getFamilyList() });
});

app.delete('/api/admin/families/:id', requireAdmin, (req, res) => {
  store.deleteFamily(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json({ orders: store.getOrders() });
});
app.put('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const o = store.updateOrder(req.params.id, req.body || {});
  if (!o) return res.status(404).json({ error: 'not found' });
  res.json(o);
});

/** 配置导入导出 */
app.get('/api/admin/export', requireAdmin, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="ciyun-config.json"');
  res.json(store.exportConfig());
});
app.post('/api/admin/import', requireAdmin, (req, res) => {
  store.importConfig(req.body || {});
  res.json({ ok: true });
});

/* ============================================================
 * 用户端：账号系统（注册 / 登录 / 资料 / 改密）
 * ============================================================ */

/** 取当前登录用户（cookie: cy_user） */
function currentUser(req) {
  const token = req.cookies && req.cookies['cy_user'];
  if (!token) return null;
  const sess = store.getSession(clientToken(req, 'cy_user'));
  if (!sess || sess.role !== 'user') return null;
  const u = store.findUser(sess.account);
  return u || null;
}

/** 兼容从 cookie 或 Authorization 取 token */
function clientToken(req, name) {
  const fromCookie = req.cookies && req.cookies[name];
  if (fromCookie) return fromCookie;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/** 用户信息脱敏输出 */
function publicUser(u) {
  if (!u) return null;
  return {
    account: u.account,
    nickname: u.nickname || u.account,
    email: u.email || '',
    avatar: u.avatar || '',
    bio: u.bio || '',
    createdAt: u.createdAt || 0,
    vip: u.vip || null,
    stats: {
      comments: (store.getComments().filter((c) => c.account === u.account && c.status !== 'deleted') || []).length,
    },
  };
}

/** 注册参数规则（给前端展示） */
app.get('/api/user/rules', (req, res) => {
  res.json({
    account: '4-20 位，字母开头，可含字母、数字、下划线',
    password: '至少 8 位，需同时包含字母和数字',
    nickname: '最多 16 个字，可留空',
  });
});

/** 注册 */
app.post('/api/user/register', (req, res) => {
  const c = store.settings.community || {};
  if (c.enabled === false || c.allowRegister === false) {
    return res.status(403).json({ error: '本站暂未开放注册' });
  }
  const { account: acc, password, nickname, email } = req.body || {};

  const eAcc = account.checkAccount(acc);
  if (eAcc) return res.status(400).json({ error: eAcc, field: 'account' });
  const ePwd = account.checkPassword(password);
  if (ePwd) return res.status(400).json({ error: ePwd, field: 'password' });
  const eNick = account.checkNickname(nickname);
  if (eNick) return res.status(400).json({ error: eNick, field: 'nickname' });
  const eMail = account.checkEmail(email);
  if (eMail) return res.status(400).json({ error: eMail, field: 'email' });
  if (c.needEmail && !email) return res.status(400).json({ error: '本站要求填写邮箱', field: 'email' });

  const key = String(acc).trim().toLowerCase();
  if (store.findUser(key)) return res.status(409).json({ error: '该账号已被注册', field: 'account' });
  if (email && store.findUserByEmail(email)) return res.status(409).json({ error: '该邮箱已被使用', field: 'email' });

  const user = {
    account: key,
    password: account.hashPassword(password),
    nickname: (nickname || '').trim() || account.defaultNickname(acc),
    email: (email || '').trim().toLowerCase(),
    avatar: '',
    bio: '',
    role: 'user',
    createdAt: Date.now(),
    vip: null,
    tokens: [],
  };
  store.upsertUser(user);

  // 注册即登录
  const token = account.newToken();
  user.tokens = [token];
  store.upsertUser(user);
  store.setSession(token, { role: 'user', account: key });
  res.cookie('cy_user', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400000 });
  res.json({ ok: true, token, user: publicUser(user) });
});

/** 登录 */
app.post('/api/user/login', (req, res) => {
  const { account: acc, password, remember } = req.body || {};
  const key = String(acc || '').trim().toLowerCase();
  if (!key || !password) return res.status(400).json({ error: '请输入账号和密码' });

  const u = store.findUser(key);
  if (!u) return res.status(401).json({ error: '账号不存在' });
  if (u.status === 'banned') return res.status(403).json({ error: '该账号已被封禁' });

  const v = account.verifyPassword(password, u.password);
  if (!v.ok) return res.status(401).json({ error: '密码错误' });
  if (v.needsUpgrade) {
    u.password = account.hashPassword(password);
  }

  const token = account.newToken();
  u.tokens = [...(u.tokens || []).slice(-4), token]; // 最多保留 5 个登录设备
  u.lastLogin = Date.now();
  store.upsertUser(u);
  store.setSession(token, { role: 'user', account: key });

  const maxAge = remember === false ? undefined : 30 * 86400000;
  res.cookie('cy_user', token, { httpOnly: true, sameSite: 'lax', maxAge });
  res.json({ ok: true, token, user: publicUser(u) });
});

/** 退出 */
app.post('/api/user/logout', (req, res) => {
  const token = clientToken(req, 'cy_user');
  if (token) {
    const sess = store.getSession(token);
    if (sess && sess.account) {
      const u = store.findUser(sess.account);
      if (u) { u.tokens = (u.tokens || []).filter((t) => t !== token); store.upsertUser(u); }
    }
    store.delSession(token);
  }
  res.clearCookie('cy_user');
  res.json({ ok: true });
});

/** 当前登录状态 */
app.get('/api/user/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: publicUser(u) });
});

/** 更新资料（昵称 / 头像 / 简介 / 邮箱） */
app.put('/api/user/profile', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const { nickname, avatar, bio, email } = req.body || {};

  if (nickname !== undefined) {
    const e = account.checkNickname(nickname);
    if (e) return res.status(400).json({ error: e, field: 'nickname' });
    u.nickname = String(nickname).trim() || account.defaultNickname(u.account);
  }
  if (email !== undefined) {
    const e = account.checkEmail(email);
    if (e) return res.status(400).json({ error: e, field: 'email' });
    const other = store.findUserByEmail(email);
    if (other && other.account !== u.account) return res.status(409).json({ error: '该邮箱已被使用', field: 'email' });
    u.email = String(email).trim().toLowerCase();
  }
  if (avatar !== undefined) {
    if (typeof avatar !== 'string' || avatar.length > 200000) {
      return res.status(400).json({ error: '头像数据过大' });
    }
    u.avatar = avatar;
  }
  if (bio !== undefined) {
    u.bio = String(bio).slice(0, 100);
  }
  store.upsertUser(u);
  res.json({ ok: true, user: publicUser(u) });
});

/** 修改密码（需验证原密码） */
app.put('/api/user/password', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const { oldPassword, newPassword } = req.body || {};
  const v = account.verifyPassword(oldPassword, u.password);
  if (!v.ok) return res.status(400).json({ error: '原密码不正确', field: 'oldPassword' });
  const e = account.checkPassword(newPassword);
  if (e) return res.status(400).json({ error: e, field: 'newPassword' });
  if (oldPassword === newPassword) return res.status(400).json({ error: '新密码不能与原密码相同', field: 'newPassword' });

  u.password = account.hashPassword(newPassword);
  u.tokens = [];               // 改密后踢出全部其他设备
  const token = clientToken(req, 'cy_user');
  if (token) {
    u.tokens = [token];
    store.setSession(token, { role: 'user', account: u.account });
  }
  store.upsertUser(u);
  res.json({ ok: true, message: '密码已修改，其他设备已下线' });
});

/* ============================================================
 * 评论系统
 * ============================================================ */

/** 敏感词 / 内容合规检查 */
function checkContent(text) {
  const c = store.settings.community || {};
  const s = String(text || '').trim();
  if (!s) return '评论内容不能为空';
  if (s.length > (c.maxLen || 500)) return `评论最多 ${c.maxLen || 500} 字`;
  if (s.length < 2) return '评论至少 2 个字';
  for (const k of c.keywords || []) {
    if (k && s.includes(k)) return '评论包含违规词，请修改后重试';
  }
  if (/https?:\/\/|www\./i.test(s) && !/cctv\.com/i.test(s)) return '请勿发布外部广告链接';
  return null;
}

/** 获取某目标的评论列表（分页） */
app.get('/api/comments', (req, res) => {
  const type = req.query.type || 'video';
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const u = currentUser(req);
  const page = parseInt(req.query.page, 10) || 1;
  const size = Math.min(30, parseInt(req.query.size, 10) || 10);
  const r = store.queryComments(type, id, { page, size });
  const me = u ? u.account : null;
  // 标注当前用户是否点过赞
  const decorate = (c) => ({ ...c, liked: me ? (store.findComment(c.id)?.likes || []).includes(me) : false });
  res.json({
    ...r,
    list: r.list.map((c) => ({ ...c, ...decorate(c), replies: (c.replies || []).map(decorate) })),
    loggedIn: !!u,
    user: u ? { account: u.account, nickname: u.nickname, avatar: u.avatar } : null,
  });
});

/** 发表评论 / 回复 */
app.post('/api/comments', (req, res) => {
  const c = store.settings.community || {};
  if (c.enabled === false || c.allowComment === false) {
    return res.status(403).json({ error: '评论功能已关闭' });
  }
  const u = currentUser(req);
  if (!u && !c.guestComment) return res.status(401).json({ error: '请登录后发表评论' });

  const { targetType = 'video', targetId, content, parentId } = req.body || {};
  if (!targetId) return res.status(400).json({ error: '缺少目标 ID' });

  const err = checkContent(content);
  if (err) return res.status(400).json({ error: err });

  // 频率限制
  const last = store.lastCommentAt(u ? u.account : 'guest');
  const gap = (c.interval || 15) * 1000;
  if (last && Date.now() - last < gap) {
    const wait = Math.ceil((gap - (Date.now() - last)) / 1000);
    return res.status(429).json({ error: `发言太快，请 ${wait} 秒后再试` });
  }

  // 回复校验
  let parent = null;
  if (parentId) {
    parent = store.findComment(parentId);
    if (!parent) return res.status(404).json({ error: '被回复的评论不存在' });
    if (parent.status !== 'visible') return res.status(400).json({ error: '该评论不可回复' });
    // 只允许两级：回复的回复挂到根评论下
    if (parent.parentId) parent = store.findComment(parent.parentId) || parent;
  }

  const rec = store.addComment({
    parentId: parent ? parent.id : null,
    targetType,
    targetId,
    account: u ? u.account : 'guest',
    nickname: u ? u.nickname : '游客',
    avatar: u ? u.avatar : '',
    content: String(content).trim(),
    status: c.commentReview ? 'pending' : 'visible',
  });

  res.json({
    ok: true,
    comment: { ...rec, likes: 0, replies: [], liked: false },
    pending: rec.status === 'pending',
    message: rec.status === 'pending' ? '评论已提交，通过审核后显示' : '评论发表成功',
  });
});

/** 点赞 / 取消点赞 */
app.post('/api/comments/:id/like', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请登录后点赞' });
  const r = store.toggleCommentLike(req.params.id, u.account);
  if (!r) return res.status(404).json({ error: '评论不存在' });
  res.json({ ok: true, ...r });
});

/** 删除自己的评论 */
app.delete('/api/comments/:id', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const c = store.findComment(req.params.id);
  if (!c) return res.status(404).json({ error: '评论不存在' });
  if (c.account !== u.account) return res.status(403).json({ error: '只能删除自己的评论' });
  store.deleteComment(req.params.id);
  res.json({ ok: true });
});

/** 我的评论 */
app.get('/api/user/comments', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const list = store
    .getComments()
    .filter((c) => c.account === u.account && c.status !== 'deleted')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
  res.json({ list: list.map((c) => ({ ...c, likes: (c.likes || []).length })) });
});

/* ============================================================
 * 后台：用户与评论管理
 * ============================================================ */
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = store.getUsers().map((u) => ({
    account: u.account,
    nickname: u.nickname,
    email: u.email,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
    status: u.status || 'active',
    vip: u.vip,
    comments: store.getComments().filter((c) => c.account === u.account && c.status !== 'deleted').length,
  }));
  res.json({ users });
});

app.put('/api/admin/users/:account', requireAdmin, (req, res) => {
  const u = store.findUser(req.params.account);
  if (!u) return res.status(404).json({ error: 'not found' });
  const { status, nickname, resetPassword } = req.body || {};
  if (status) u.status = status;
  if (nickname) u.nickname = nickname;
  if (resetPassword) {
    const e = account.checkPassword(resetPassword);
    if (e) return res.status(400).json({ error: e });
    u.password = account.hashPassword(resetPassword);
    u.tokens = [];
  }
  store.upsertUser(u);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:account', requireAdmin, (req, res) => {
  store.deleteUser(req.params.account);
  res.json({ ok: true });
});

/** 评论管理：分页 + 状态筛选 */
app.get('/api/admin/comments', requireAdmin, (req, res) => {
  const { status = '', keyword = '', page = 1, size = 20 } = req.query;
  let list = store.getComments();
  if (status) list = list.filter((c) => c.status === status);
  if (keyword) {
    const k = String(keyword).toLowerCase();
    list = list.filter(
      (c) => c.content.toLowerCase().includes(k) || c.nickname.toLowerCase().includes(k) || c.targetId.includes(k)
    );
  }
  list = list.sort((a, b) => b.createdAt - a.createdAt);
  const total = list.length;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const sz = Math.min(100, parseInt(size, 10) || 20);
  const start = (p - 1) * sz;
  // 补上父评论内容（便于展示上下文）
  const byId = new Map(store.getComments().map((c) => [c.id, c]));
  const items = list.slice(start, start + sz).map((c) => ({
    ...c,
    likes: (c.likes || []).length,
    parent: c.parentId && byId.get(c.parentId) ? { id: c.parentId, nickname: byId.get(c.parentId).nickname } : null,
  }));
  res.json({ total, page: p, size: sz, list: items });
});

/** 审核操作：通过 / 隐藏 / 删除 */
app.put('/api/admin/comments/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  const c = store.updateComment(req.params.id, { status });
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.delete('/api/admin/comments/:id', requireAdmin, (req, res) => {
  const hard = req.query.hard === '1';
  store.deleteComment(req.params.id, hard);
  res.json({ ok: true });
});

/* ============================================================
 * 会员：下单与支付（可选模块，默认关闭）
 * ============================================================ */
app.post('/api/user/order', (req, res) => {
  const s = store.settings;
  if (!s.monetize.enabled) return res.status(403).json({ error: '付费模块未开启' });
  const { planId } = req.body || {};
  const plan = (s.monetize.plans || []).find((p) => p.id === planId);
  if (!plan) return res.status(404).json({ error: '套餐不存在' });
  const u = currentUser(req);
  const order = store.addOrder({
    planId: plan.id,
    planName: plan.name,
    amount: plan.price,
    status: 'pending',
    account: u ? u.account : 'guest',
  });
  res.json({ ok: true, order });
});

/** 模拟支付回调（真实部署可接入支付网关） */
app.post('/api/pay/callback', (req, res) => {
  const { orderId } = req.body || {};
  const o = store.updateOrder(orderId, { status: 'paid', paidAt: Date.now() });
  if (!o) return res.status(404).json({ error: 'order not found' });
  const plan = (store.settings.monetize.plans || []).find((p) => p.id === o.planId);
  if (plan && o.account && o.account !== 'guest') {
    const u = store.findUser(o.account);
    if (u) {
      u.vip = { level: plan.id, expire: Date.now() + plan.days * 86400000 };
      store.upsertUser(u);
    }
  }
  res.json({ ok: true });
});

/* ============================================================
 * 家庭共享（付费增值模块 · 1 户主 + 最多 5 成员）
 * ============================================================ */

/** 家庭模块信息（前端展示规则） */
app.get('/api/family/info', (req, res) => {
  const cfg = store.settings.family || {};
  const u = currentUser(req);
  const fam = u ? store.findFamilyOf(u.account) : null;
  res.json({
    enabled: cfg.enabled !== false,
    requireVip: cfg.requireVip !== false,
    maxMembers: cfg.maxMembers || 5,
    allowLeave: cfg.allowLeave !== false,
    shareVip: cfg.shareVip !== false,
    family: fam ? familyView(fam, u) : null,
    role: fam ? (fam.owner === (u && u.account) ? 'owner' : 'member') : null,
  });
});

/** 家庭视图（脱敏） */
function familyView(fam, me) {
  const owner = store.findUser(fam.owner);
  const members = (fam.members || []).map((m) => {
    const u = store.findUser(m.account);
    return {
      account: m.account,
      nickname: u ? u.nickname || u.account : m.account,
      avatar: u ? u.avatar : '',
      joinedAt: m.joinedAt,
      isOwner: false,
    };
  });
  return {
    id: fam.id,
    name: fam.name,
    owner: fam.owner,
    ownerNickname: owner ? owner.nickname || owner.account : fam.owner,
    ownerAvatar: owner ? owner.avatar : '',
    ownerVip: owner ? isVip(owner) : false,
    members,
    count: members.length,
    maxMembers: (store.settings.family && store.settings.family.maxMembers) || 5,
    isOwner: me ? fam.owner === me.account : false,
    createdAt: fam.createdAt,
  };
}

/** 判断会员是否有效（家庭共享时成员也算） */
function isVip(u) {
  if (!u) return false;
  const own = u.vip && u.vip.expire && u.vip.expire > Date.now();
  if (own) return true;
  // 家庭共享：户主是会员则成员共享
  const cfg = store.settings.family || {};
  if (cfg.shareVip === false) return false;
  const fam = store.findFamilyOf(u.account);
  if (!fam || fam.owner === u.account) return false;
  const owner = store.findUser(fam.owner);
  return !!(owner && owner.vip && owner.vip.expire && owner.vip.expire > Date.now());
}

/** 创建家庭 */
app.post('/api/family/create', (req, res) => {
  const cfg = store.settings.family || {};
  if (cfg.enabled === false) return res.status(403).json({ error: '家庭功能未开启' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  if (store.findFamilyOf(u.account)) return res.status(409).json({ error: '你已在一个家庭中，请先退出' });
  if (cfg.requireVip !== false) {
    const own = u.vip && u.vip.expire && u.vip.expire > Date.now();
    if (!own) return res.status(403).json({ error: '创建家庭需先开通会员', needVip: true });
  }
  const fam = store.createFamily(u.account, (req.body && req.body.name) || '');
  res.json({ ok: true, family: familyView(fam, u) });
});

/** 修改家庭名 */
app.put('/api/family', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  if (fam.owner !== u.account) return res.status(403).json({ error: '只有户主可以修改' });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: '家庭名称不能为空' });
  store.updateFamily(fam.id, { name });
  res.json({ ok: true, family: familyView(store.getFamily(fam.id), u) });
});

/** 生成邀请码 */
app.post('/api/family/invite', (req, res) => {
  const cfg = store.settings.family || {};
  if (cfg.enabled === false) return res.status(403).json({ error: '家庭功能未开启' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  if (fam.owner !== u.account) return res.status(403).json({ error: '只有户主可以邀请成员' });
  const max = cfg.maxMembers || 5;
  if ((fam.members || []).length >= max) return res.status(400).json({ error: `成员已满（最多 ${max} 人）` });
  const ttl = Math.max(1, Math.min(30, parseInt((req.body && req.body.days) || 3, 10) || 3)) * 86400000;
  const inv = store.createInvite(fam.id, u.account, ttl);
  res.json({ ok: true, code: inv.code, expire: inv.expire });
});

/** 查看当前有效邀请码 */
app.get('/api/family/invites', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.json({ invites: [] });
  const list = store
    .getInvites()
    .filter((i) => i.familyId === fam.id && !i.used && i.expire > Date.now())
    .map((i) => ({ code: i.code, expire: i.expire, createdAt: i.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ invites: list, isOwner: fam.owner === u.account });
});

app.delete('/api/family/invite/:code', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const inv = store.findInvite(req.params.code);
  if (!inv) return res.status(404).json({ error: '邀请码不存在' });
  const fam = store.getFamily(inv.familyId);
  if (!fam || fam.owner !== u.account) return res.status(403).json({ error: '无权操作' });
  store.revokeInvite(req.params.code);
  res.json({ ok: true });
});

/** 校验邀请码（加入前预览） */
app.get('/api/family/invite/:code/peek', (req, res) => {
  const inv = store.findInvite(req.params.code);
  if (!inv || inv.used) return res.status(404).json({ error: '邀请码无效或已使用' });
  if (inv.expire < Date.now()) return res.status(410).json({ error: '邀请码已过期' });
  const fam = store.getFamily(inv.familyId);
  if (!fam) return res.status(404).json({ error: '家庭不存在' });
  const owner = store.findUser(fam.owner);
  res.json({
    familyName: fam.name,
    ownerNickname: owner ? owner.nickname || owner.account : fam.owner,
    count: (fam.members || []).length,
    maxMembers: (store.settings.family && store.settings.family.maxMembers) || 5,
  });
});

/** 通过邀请码加入家庭 */
app.post('/api/family/join', (req, res) => {
  const cfg = store.settings.family || {};
  if (cfg.enabled === false) return res.status(403).json({ error: '家庭功能未开启' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const code = String((req.body && req.body.code) || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: '请输入邀请码' });

  const inv = store.findInvite(code);
  if (!inv || inv.used) return res.status(404).json({ error: '邀请码无效或已使用' });
  if (inv.expire < Date.now()) return res.status(410).json({ error: '邀请码已过期' });

  const fam = store.getFamily(inv.familyId);
  if (!fam) return res.status(404).json({ error: '家庭不存在' });
  if (fam.owner === u.account) return res.status(400).json({ error: '你是该家庭的户主' });
  const existing = store.findFamilyOf(u.account);
  if (existing) {
    if (existing.id === fam.id) return res.status(400).json({ error: '你已在该家庭中' });
    return res.status(409).json({ error: '你已加入其它家庭，请先退出' });
  }

  const r = store.addFamilyMember(fam.id, u.account);
  if (r.error) return res.status(400).json({ error: r.error });
  store.consumeInvite(code);
  res.json({ ok: true, family: familyView(store.getFamily(fam.id), u) });
});

/** 移除成员（户主）或退出家庭（成员） */
app.delete('/api/family/member/:account', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  const target = req.params.account;

  if (target === u.account) {
    // 退出
    if (fam.owner === u.account) return res.status(400).json({ error: '户主不能直接退出，请解散家庭' });
    if ((store.settings.family || {}).allowLeave === false) return res.status(403).json({ error: '管理员已关闭成员退出' });
    store.removeFamilyMember(fam.id, u.account);
    return res.json({ ok: true, left: true });
  }
  if (fam.owner !== u.account) return res.status(403).json({ error: '只有户主可以移除成员' });
  store.removeFamilyMember(fam.id, target);
  res.json({ ok: true });
});

/** 解散家庭（户主） */
app.delete('/api/family', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  if (fam.owner !== u.account) return res.status(403).json({ error: '只有户主可以解散家庭' });
  store.deleteFamily(fam.id);
  res.json({ ok: true });
});

/** 成员列表 */
app.get('/api/family/members', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.json({ members: [], owner: null });
  res.json(familyView(fam, u));
});

/* ============================================================
 * 同源聊天室（看同一部片的用户实时聊天）
 * ============================================================ */

/** 消息频率限制：内存记录，每用户每房间最小间隔 3 秒 */
const chatRate = new Map();
function chatRateOk(key) {
  const last = chatRate.get(key) || 0;
  if (Date.now() - last < 3000) return false;
  chatRate.set(key, Date.now());
  if (chatRate.size > 5000) chatRate.clear();
  return true;
}

/** 房间历史 + 在线人数 */
app.get('/api/chat/history', (req, res) => {
  const room = String(req.query.room || '').slice(0, 120);
  if (!room) return res.status(400).json({ error: 'room required' });
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 60);
  res.json({ room, online: chat.online(room), list: chat.history(room, limit) });
});

/** SSE 实时订阅 */
app.get('/api/chat/stream', (req, res) => {
  const room = String(req.query.room || '').slice(0, 120);
  if (!room) return res.status(400).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = res;
  const unsub = chat.subscribe(room, client);

  // 初始在线人数
  res.write(`event: presence\ndata: ${JSON.stringify({ online: chat.online(room) })}\n\n`);
  chat.broadcastPresence(room);

  // 心跳保活
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
  }, 20000);

  req.on('close', () => {
    clearInterval(hb);
    unsub();
    chat.broadcastPresence(room);
  });
});

/** 发送消息 */
app.post('/api/chat/send', (req, res) => {
  const cfg = store.settings.community || {};
  if (cfg.enabled === false) return res.status(403).json({ error: '聊天功能已关闭' });

  const u = currentUser(req);
  if (!u && !cfg.guestComment) return res.status(401).json({ error: '请登录后聊天' });

  const room = String((req.body && req.body.room) || '').slice(0, 120);
  const content = String((req.body && req.body.content) || '').trim();
  if (!room) return res.status(400).json({ error: '缺少房间' });
  if (!content) return res.status(400).json({ error: '消息不能为空' });
  if (content.length > 200) return res.status(400).json({ error: '消息最多 200 字' });
  for (const k of cfg.keywords || []) {
    if (k && content.includes(k)) return res.status(400).json({ error: '消息包含违规词' });
  }

  const key = (u ? u.account : 'guest') + '@' + room;
  if (!chatRateOk(key)) return res.status(429).json({ error: '发送太快，请稍候' });

  const msg = chat.push(room, {
    account: u ? u.account : 'guest',
    nickname: u ? u.nickname || u.account : '游客',
    avatar: u ? u.avatar : '',
    content,
  });
  chat.broadcast(room, 'message', msg);
  res.json({ ok: true, message: msg });
});

app.get('/api/admin/chat/rooms', requireAdmin, (req, res) => {
  res.json({ rooms: chat.roomStats() });
});

/* ============================================================
 * 弹幕系统
 *   本地弹幕：danmaku:<targetId>  仅在当前视频/频道显示
 *   全站弹幕：danmaku:global      全站在线用户都能看到
 * ============================================================ */

const DANMAKU_MAX_LEN = 60;

/** 房间命名：local -> danmaku:xxx ；global -> danmaku:global */
function danmakuRoom(scope, targetId) {
  return scope === 'global' ? 'danmaku:global' : 'danmaku:' + String(targetId || '').slice(0, 120);
}

/** 拉取弹幕（可带时间范围，用于视频按进度回放） */
app.get('/api/danmaku', (req, res) => {
  const scope = req.query.scope === 'global' ? 'global' : 'local';
  const targetId = req.query.target || '';
  const room = danmakuRoom(scope, targetId);
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
  const list = chat.history(room, limit);
  res.json({ scope, room, online: chat.online(room), list });
});

/** 弹幕 SSE 实时流 */
app.get('/api/danmaku/stream', (req, res) => {
  const scope = req.query.scope === 'global' ? 'global' : 'local';
  const targetId = req.query.target || '';
  const room = danmakuRoom(scope, targetId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': danmaku connected\n\n');

  const unsub = chat.subscribe(room, res);
  res.write(`event: presence\ndata: ${JSON.stringify({ online: chat.online(room) })}\n\n`);

  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
  }, 20000);

  req.on('close', () => { clearInterval(hb); unsub(); });
});

/** 发送弹幕 */
app.post('/api/danmaku', (req, res) => {
  const cfg = store.settings.community || {};
  if (cfg.enabled === false) return res.status(403).json({ error: '弹幕功能已关闭' });
  const u = currentUser(req);
  if (!u && !cfg.guestComment) return res.status(401).json({ error: '请登录后发送弹幕' });

  const scope = (req.body && req.body.scope) === 'global' ? 'global' : 'local';
  const targetId = (req.body && req.body.target) || '';
  const content = String((req.body && req.body.content) || '').trim();
  const color = String((req.body && req.body.color) || '#ffffff').slice(0, 16);
  const position = ['scroll', 'top', 'bottom'].includes(req.body && req.body.position)
    ? req.body.position : 'scroll';

  if (!content) return res.status(400).json({ error: '弹幕内容不能为空' });
  if (content.length > DANMAKU_MAX_LEN) return res.status(400).json({ error: `弹幕最多 ${DANMAKU_MAX_LEN} 字` });
  for (const k of cfg.keywords || []) {
    if (k && content.includes(k)) return res.status(400).json({ error: '弹幕包含违规词' });
  }

  const key = 'dm:' + (u ? u.account : 'guest') + '@' + danmakuRoom(scope, targetId);
  if (!chatRateOk(key)) return res.status(429).json({ error: '发得太快啦' });

  const room = danmakuRoom(scope, targetId);
  const dm = chat.push(room, {
    account: u ? u.account : 'guest',
    nickname: u ? u.nickname || u.account : '游客',
    content,
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff',
    position,
    scope,
    // 播放进度（秒），用于视频内按时间轴对齐
    time: Math.max(0, Number(req.body && req.body.time) || 0),
  });
  chat.broadcast(room, 'danmaku', dm);
  res.json({ ok: true, danmaku: dm });
});

app.get('/api/admin/danmaku/rooms', requireAdmin, (req, res) => {
  const rooms = chat.roomStats().filter((r) => r.id.startsWith('danmaku:'));
  res.json({ rooms });
});

/* ============================================================
 * 静态资源
 * ============================================================ */
app.use(
  '/hls',
  express.static(path.join(__dirname, 'node_modules', 'hls.js', 'dist'), { maxAge: '7d' })
);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// SPA 兜底
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ============================================================
 * 启动
 * ============================================================ */
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ┌───────────────────────────────────────────────┐');
    console.log('  │           慈云影视  ·  已启动                  │');
    console.log('  ├───────────────────────────────────────────────┤');
    console.log(`  │  前台      http://localhost:${PORT}/              │`);
    console.log(`  │  后台      http://localhost:${PORT}/admin/        │`);
    console.log(`  │  账号      admin / admin888                    │`);
    console.log('  └───────────────────────────────────────────────┘');
    console.log('');
  });
}

module.exports = app;
