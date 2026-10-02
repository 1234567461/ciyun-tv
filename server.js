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
const pay = require('./lib/pay');
const security = require('./lib/security');
const mail = require('./lib/mail');
const { store, REDEEM_TYPES, FAMILY_ROLES, FAMILY_ROLE_NAME, FAMILY_ROLE_PERMS } = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 8811;
const HOST = process.env.HOST || '0.0.0.0';

/** 给 Promise 加截止时间：超时返回 fallback，避免可选环节拖垮整个接口 */
function withDeadline(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

app.set('trust proxy', true); // 反向代理下取真实 IP（限流/锁定依赖）

app.use(security.securityHeaders);
// 压缩：JS/CSS 体积随功能增长已明显增大，必须 gzip 后才不致拖慢首屏
app.use(compression({
  level: 6,
  threshold: 512,          // >512B 才压缩，小响应跳过减少开销
  filter: (req, res) => {
    // 流媒体代理（m3u8/ts 分片）不压缩，避免破坏实时性与 CPU 浪费
    if (/^\/(api\/(stream|proxy|live)|hls)/.test(req.path)) return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/** 取客户端真实 IP（兼容反代） */
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

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
/**
 * 公告代理：从配套监控服务拉取最新公告。
 * 这样运营只需在监控端改一处，全站用户下次进入即可看到。
 * 未部署监控 / 不可达时，回退站点设置里的 announcement，不影响主流程。
 */
app.get('/api/announcement', async (req, res) => {
  const fallback = (store.settings && store.settings.announcement) || '';
  const statusUrl = process.env.STATUS_URL || req.app.get('statusUrl');
  if (!statusUrl) return res.json({ announcement: fallback, source: 'local' });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(statusUrl.replace(/\/+$/, '') + '/api/announcement', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('status ' + r.status);
    const d = await r.json();
    const text = (d && d.announcement) || '';
    return res.json({ announcement: text || fallback, source: text ? 'remote' : 'local' });
  } catch {
    return res.json({ announcement: fallback, source: 'local' });
  }
});

app.get('/api/site', (req, res) => {
  const s = store.settings;
  res.json({
    siteName: s.siteName,
    slogan: s.slogan,
    logo: s.logo,
    theme: s.theme,
    announcement: s.announcement,
    showAds: s.showAds,
    monetize: {
      enabled: !!s.monetize.enabled,
      mode: s.monetize.mode || 'optional',
      currency: s.monetize.currency || '¥',
      provider: s.monetize.provider || 'mock',
      testMode: s.monetize.testMode !== false,
      allowBalance: s.monetize.allowBalance !== false,
      redeemEnabled: s.monetize.redeemEnabled !== false,
      adminUnlimited: s.monetize.adminUnlimited !== false,
      quotaEnabled: !!s.monetize.quotaEnabled,
      quotaRules: {
        requireLogin: s.monetize.requireLogin !== false,
        freeDailyPlays: Math.max(0, Number(s.monetize.freeDailyPlays) || 0),
        costPerPlay: Math.max(1, Number(s.monetize.costPerPlay) || 1),
        dedupeDaily: s.monetize.dedupeDaily !== false,
        vipFreePlays: s.monetize.vipFreePlays !== false,
        allowPointsForPlay: s.monetize.allowPointsForPlay !== false,
        pointCosts: s.monetize.pointCosts || {},
      },
      minRecharge: s.monetize.minRecharge || 1,
      rechargePresets: s.monetize.rechargePresets || [10, 30, 50, 100, 200, 500],
      orderTimeout: s.monetize.orderTimeout || 30,
      payMethods: pay.payMethods(s.monetize),
      channels: pay.availableChannels(s.monetize),
      plans: s.monetize.plans || [],
    },
    playback: s.playback,
    community: {
      enabled: s.community.enabled !== false,
      allowRegister: s.community.allowRegister !== false,
      allowComment: s.community.allowComment !== false,
      guestComment: !!s.community.guestComment,
      commentReview: !!s.community.commentReview,
      needEmail: !!s.community.needEmail,
      verifyEmail: !!s.community.verifyEmail,
      emailLogin: s.community.emailLogin !== false,
      maxLen: s.community.maxLen || 500,
    },
    mail: {
      // 仅暴露「是否可用」，绝不下发 SMTP 凭据
      configured: !!(s.mail && s.mail.host && s.mail.user && s.mail.pass),
      from: (s.mail && s.mail.from) || '',
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

/** 家庭并发流会话（内存，2 分钟无心跳自动过期） */
const familyStreams = new Map();

app.get('/api/video/:guid', async (req, res) => {
  const cfg = store.settings.monetize || {};
  const u = currentUser(req);
  try {
    // ---- 家庭：并发流限制 + 额度池兜底（对标 Jellyfin MaxActiveVideoStreams / Plex 并发流）----
    const famCfg = store.settings.family || {};
    let famInfo = null;
    if (u && famCfg.enabled !== false) {
      const fam = store.findFamilyOf(u.account);
      if (fam && fam.owner !== u.account) {
        // 并发流限制
        const limit = famCfg.maxStreams === undefined ? 2 : Number(famCfg.maxStreams);
        if (limit > 0) {
          const sessKey = 'fam:' + fam.id + ':' + u.account;
          const cur = familyStreams.get(sessKey) || [];
          const live = cur.filter((s) => Date.now() - s.at < 120000); // 2 分钟无心跳视为结束
          if (live.length >= limit) {
            if ((famCfg.streamPolicy || 'replace') === 'block') {
              return res.status(429).json({
                error: `同时在线观看数已达上限（最多 ${limit} 路），请先关闭其他设备`,
                needStream: true, streamLimit: limit, active: live.length,
                sessions: live.map((s) => ({ device: s.device, at: s.at })),
              });
            }
            // replace：顶掉最早的一路
            live.sort((a, b) => a.at - b.at);
            live.shift();
          }
          live.push({ at: Date.now(), device: String(req.headers['x-device-id'] || '').slice(0, 64) });
          familyStreams.set(sessKey, live.slice(-10));
        }
        famInfo = { id: fam.id, role: myFamilyRole(fam, u.account) };
      }
    }

    // ---- 额度网关（付费模块 + 额度系统双开关开启时才生效）----
    let gate = null;
    if (cfg.enabled && cfg.quotaEnabled) {
      gate = pay.gateWatch(u, {
        guid: req.params.guid, cfg,
        isVip: u ? isVip(u) : false,
        isAdmin: u ? isAdminAccount(u.account) : false,
      });
      if (!gate.allow) {
        // 家庭额度池兜底：成员额度耗尽时消耗户主共享池
        if (u && famInfo && famCfg.shareQuota !== false && gate.needRecharge) {
          const fam = store.getFamily(famInfo.id);
          const poolRemain = fam
            ? ((Number(fam.quotaPool) || 0) === -1
              ? -1 : Math.max(0, (Number(fam.quotaPool) || 0) - (Number(fam.poolUsed) || 0)))
            : 0;
          if (poolRemain !== 0) {
            const used = store.useFamilyQuota(fam.id, gate.cost || 0);
            if (used !== 0) {
              store.addQuotaLog({
                account: u.account, type: 'family', delta: -(gate.cost || 0),
                reason: '消耗家庭共享额度池', ref: req.params.guid,
              });
              gate = { ...gate, allow: true, source: 'family', cost: gate.cost || 0 };
            }
          }
        }
        if (!gate.allow) {
          return res.status(gate.needLogin ? 401 : 403).json({
            error: gate.error,
            needQuota: true,
            needLogin: !!gate.needLogin,
            needVip: !!gate.needVip,
            needRecharge: !!gate.needRecharge,
            quota: gate.quota,
            redeemEnabled: cfg.redeemEnabled !== false,
            quotaEnabled: true,
            familyPool: famInfo ? true : false,
          });
        }
      }
      // 同步落库扣减（在 await 之前完成，杜绝并发超扣）
      if (u && ['free', 'times', 'points'].includes(gate.source)) {
        store.commitWatch(u.account, {
          guid: req.params.guid,
          source: gate.source,
          cost: gate.cost,
          dayKey: gate.dayKey,
          dayUsed: gate.dayUsed,
        });
        if (gate.cost > 0) {
          store.addQuotaLog({
            account: u.account,
            type: gate.source === 'points' ? 'points' : 'times',
            delta: -gate.cost,
            reason: '观看影片消耗',
            ref: req.params.guid,
            after: pay.ensureQuota(store.findUser(u.account))[
              gate.source === 'points' ? 'points' : 'times'
            ],
          });
        }
      }
    }

    const info = await cctv.getPlayInfo(req.params.guid);
    store.recordPlay(req.params.guid, { title: info.title });
    res.json({
      ...info,
      // 提供给前端的可选播放地址（经本地代理，规避跨域）
      src: info.hls ? `/api/stream?url=${encodeURIComponent(info.hls)}` : '',
      // 多线路：主 HLS + 加密 HLS + FLV
      lines: buildLines(info),
      // 额度回显（前端展示剩余）
      quota: pay.quotaView(u, { cfg, isAdmin: u ? isAdminAccount(u.account) : false, isVip: u ? isVip(u) : false }),
      quotaSource: gate ? gate.source : null,
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

  // 🔒 SSRF 防护：解析真实 IP，拦截内网/保留地址，避免被用作内网探测跳板
  const chk = await security.checkUpstream(url);
  if (!chk.ok) return res.status(403).send('forbidden upstream: ' + chk.reason);

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
    let now = live.now || null;
    // 节目单缺失时兜底：单独再取一次当前频道实时节目。
    // ⚡ 必须走缓存且带截止时间 —— 原来用 skipCache:true 会实时抓央视网页，
    //    上游一慢就把接口拖到 6~8s（表现为直播页偶发卡死）。
    //    节目单一期也就几十秒粒度，缓存足够；拿不到就算了，不能拖累出流。
    if (!now) {
      try {
        const cur = await withDeadline(cctv.getNowEpg([req.params.channel]), 2000, null);
        now = (cur && cur[0]) || null;
      } catch { /* 忽略 */ }
    }
    res.json({
      ...live,
      now,                                  // 前端直接读取：正在播节目 + 进度
      epgNow: now,                          // 兼容别名
      name: ch ? ch.name : req.params.channel,
      logo: ch ? ch.logo : '',
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
      // ⚠️ 前端传 typeId，历史接口用 type —— 两者都要接受，
      //    否则分类筛选静默失效（永远返回全量列表）。
      typeId: req.query.typeId || req.query.type || '',
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
  // 排除央视源：前端搜索已单独走 /api/search 取央视结果，此处重复查纯属浪费
  // （央视源检索耗时最长，之前正是它把整体拖到 4s）
  const list = store.getSources().filter((s) => s.enabled !== false && s.type !== 'cctv');
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
  const ip = clientIp(req);
  // ① 总入口限流：同 IP 每分钟最多 12 次尝试
  const rl = security.rateLimit('admin-login:' + ip, { window: 60 * 1000, max: 12 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后再试` });
  }
  // ② 暴力破解锁定（渐进式：5 次后 30s，逐级到 1800s）
  const guard = security.loginGuard(ip);
  if (!guard.ok) {
    res.setHeader('Retry-After', String(guard.retryAfter));
    return res.status(429).json({ error: `失败次数过多，账号已临时锁定，请 ${guard.retryAfter} 秒后再试` });
  }

  const { username, password } = req.body || {};
  const s = store.settings;
  const expectUser = s.adminUsername || 'admin';
  // ③ 口令校验：支持已哈希与历史明文，校验通过后自动升级为哈希
  const stored = s.adminPassword || 'admin888';
  const uOk = String(username || '') === expectUser;
  const pv = security.verifyAdminPassword(password, stored);
  if (!uOk || !pv.ok) {
    const { count, lockSec } = security.loginFail(ip);
    const left = Math.max(0, 5 - count);
    return res.status(401).json({
      error: lockSec
        ? `账号或密码错误，已锁定 ${lockSec} 秒`
        : `账号或密码错误${count >= 2 ? `（剩余尝试 ${left} 次）` : ''}`,
    });
  }
  security.loginOk(ip);

  // 历史明文口令 → 升级为 PBKDF2 哈希落库
  if (pv.legacy) {
    try {
      store.setSettings({ adminPassword: security.hashAdminPassword(password) });
    } catch (e) { /* 忽略，不影响登录 */ }
  }

  const token = crypto.randomBytes(32).toString('hex');
  store.setSession(token, { role: 'admin', user: username, ip, at: Date.now() });
  // 同步一个同名用户端账号，让管理员在用户端也享有终身会员与无限额度
  try {
    if ((store.settings.monetize || {}).adminUnlimited !== false) {
      let u = store.findUser(username);
      if (!u) {
        u = {
          account: username,
          nickname: '站务管理员',
          password: account.hashPassword(password),
          email: '', avatar: '', bio: '',
          createdAt: Date.now(), lastLogin: Date.now(),
          status: 'active', tokens: [], balance: 0,
          role: 'admin',
        };
        store.upsertUser(u);
      } else if (u.role !== 'admin') {
        u.role = 'admin';
        store.upsertUser(u);
      }
    }
  } catch (e) { /* 忽略，不影响后台登录 */ }
  res.cookie('cy_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.headers['x-forwarded-proto'] === 'https' || req.secure,
    maxAge: 7 * 86400000,
  });
  res.json({ ok: true, token });
});

/** 测试辅助：仅非生产环境可用的会员授予（供 scripts/test-*.js 使用） */
app.post('/api/admin/test/grant-vip', requireAdmin, (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: '生产环境已禁用' });
  const { account: acc, days } = req.body || {};
  const u = store.findUser(String(acc || '').toLowerCase());
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const vip = pay.grantVip(u, { id: 'test', name: '测试会员', days: Math.max(1, parseInt(days, 10) || 30) });
  store.upsertUser(u);
  res.json({ ok: true, vip });
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
/** 对管理设置做安全脱敏：口令不下发，邮箱授权码打码 */
function safeSettingsView(s) {
  const out = JSON.parse(JSON.stringify(s));
  if (out.adminPassword) {
    out.adminPassword = '';           // 绝不回传口令（明文或哈希都不回传）
    out.adminPasswordSet = true;      // 只告知「已设置」
  }
  if (out.mail && out.mail.pass) {
    out.mail = { ...out.mail, pass: '', passSet: true };
  }
  return out;
}

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(safeSettingsView(store.settings));
});
app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const patch = { ...(req.body || {}) };

  // 🔒 管理口令：非空才更新，且必须通过强度校验，落库前哈希
  if (patch.adminPassword !== undefined) {
    const pwd = String(patch.adminPassword || '');
    const changedUser = patch.adminUsername && patch.adminUsername !== (store.settings.adminUsername || 'admin');
    if (pwd === '') {
      delete patch.adminPassword;      // 空 = 不改
    } else {
      const err = security.checkAdminPassword(pwd);
      if (err) return res.status(400).json({ error: '口令强度不足：' + err });
      patch.adminPassword = security.hashAdminPassword(pwd);
      // 改口令后吊销所有后台会话，强制重新登录
      store.revokeAllSessions && store.revokeAllSessions();
    }
    if (changedUser && pwd === '') {
      return res.status(400).json({ error: '修改管理员账号时必须同时设置新口令' });
    }
  }
  // 邮箱授权码：空表示不改
  if (patch.mail && 'pass' in patch.mail && !patch.mail.pass) {
    delete patch.mail.pass;
  }
  const saved = store.setSettings(patch);
  res.json(safeSettingsView(saved));
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
  for (const k of ['enabled', 'requireVip', 'allowLeave', 'shareVip', 'shareQuota',
    'autoApprove', 'parentalEnabled', 'childBlockVip', 'childBlockComment']) {
    if (b[k] !== undefined) patch[k] = !!b[k];
  }
  if (b.maxMembers !== undefined) patch.maxMembers = Math.max(1, Math.min(20, parseInt(b.maxMembers, 10) || 5));
  // -1 表示不限；0 表示关闭限制
  if (b.maxStreams !== undefined) patch.maxStreams = Math.max(-1, Math.min(20, parseInt(b.maxStreams, 10) || 0));
  if (b.deviceLimit !== undefined) patch.deviceLimit = Math.max(0, Math.min(50, parseInt(b.deviceLimit, 10) || 0));
  if (['replace', 'block'].includes(b.streamPolicy)) patch.streamPolicy = b.streamPolicy;
  if (b.familyQuotaPool !== undefined) {
    const n = Math.trunc(Number(b.familyQuotaPool) || 0);
    patch.familyQuotaPool = n === -1 ? -1 : Math.max(0, Math.min(1000000, n));
  }
  if (b.inviteTtlDays !== undefined) patch.inviteTtlDays = Math.max(1, Math.min(30, parseInt(b.inviteTtlDays, 10) || 3));
  if (FAMILY_ROLES.includes(b.inviteRole) && b.inviteRole !== 'owner') patch.inviteRole = b.inviteRole;
  if (['G', 'PG', 'PG13', 'R', 'UNRATED'].includes(b.childMaxRating)) patch.childMaxRating = b.childMaxRating;
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

/** 管理员默认账号（享有会员身份与无限额度） */
function isAdminAccount(account) {
  if (!account) return false;
  const s = store.settings || {};
  if (s.monetize && s.monetize.adminUnlimited === false) return false;
  return String(account) === String(s.adminUsername || 'admin');
}

/** 管理员特权视图（会员 + 无限额度） */
const ADMIN_PRIVILEGE = {
  level: 'admin',
  name: '管理员（终身会员）',
  expire: 4102444800000,      // 2100-01-01，视作永久
  since: 0,
  lastPlan: 'admin',
  permanent: true,
};

/** 用户信息脱敏输出 */
function publicUser(u) {
  if (!u) return null;
  const cfg = store.settings.monetize || {};
  const now = Date.now();
  const isAdm = isAdminAccount(u.account);
  const own = (u.vip && u.vip.expire > now) || isAdm;
  return {
    account: u.account,
    nickname: u.nickname || u.account,
    email: u.email || '',
    avatar: u.avatar || '',
    bio: u.bio || '',
    createdAt: u.createdAt || 0,
    vip: isAdm ? ADMIN_PRIVILEGE : (u.vip || null),
    vipActive: !!own,
    vipDaysLeft: isAdm ? 36500 : (own ? Math.ceil((u.vip.expire - now) / 86400000) : 0),
    isAdmin: isAdm,
    adminPrivilege: isAdm,
    unlimited: isAdm,
    quota: pay.quotaView(u, { cfg, isAdmin: isAdm, isVip: own }),
    balance: isAdm ? null : Math.round(((u.balance || 0)) * 100) / 100,
    currency: cfg.currency || '¥',
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
  // 🔒 注册限流：同 IP 每小时最多 6 个账号，防批量注册
  const ip = clientIp(req);
  const rl = security.rateLimit('register:' + ip, { window: 60 * 60 * 1000, max: 6 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `注册过于频繁，请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试` });
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

  // 🔒 开启邮箱验证时，必须携带有效验证码
  if (c.verifyEmail) {
    const code = String((req.body || {}).emailCode || '').trim();
    const chk = mail.checkCode(email, code, 'register');
    if (!chk.ok) return res.status(400).json({ error: chk.error, field: 'emailCode' });
  }

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
  res.cookie('cy_user', token, {
    httpOnly: true, sameSite: 'lax',
    secure: req.headers['x-forwarded-proto'] === 'https' || req.secure,
    maxAge: 30 * 86400000,
  });
  res.json({ ok: true, token, user: publicUser(user) });
});

/** 登录 */
app.post('/api/user/login', (req, res) => {
  const ip = clientIp(req);
  // 🔒 登录限流 + 渐进锁定，防撞库
  const rl = security.rateLimit('user-login:' + ip, { window: 60 * 1000, max: 15 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后再试` });
  }
  const guard = security.loginGuard(ip);
  if (!guard.ok) {
    res.setHeader('Retry-After', String(guard.retryAfter));
    return res.status(429).json({ error: `失败次数过多，请 ${guard.retryAfter} 秒后再试` });
  }

  const { account: acc, password, remember } = req.body || {};
  const key = String(acc || '').trim().toLowerCase();
  if (!key || !password) return res.status(400).json({ error: '请输入账号和密码' });

  const u = store.findUser(key);
  // 🔒 统一错误文案，避免账号枚举
  const genericErr = '账号或密码错误';
  if (!u) {
    const { count, lockSec } = security.loginFail(ip);
    return res.status(401).json({ error: lockSec ? `失败次数过多，已锁定 ${lockSec} 秒` : genericErr });
  }
  if (u.status === 'banned') return res.status(403).json({ error: '该账号已被封禁' });

  const v = account.verifyPassword(password, u.password);
  if (!v.ok) {
    const { count, lockSec } = security.loginFail(ip);
    return res.status(401).json({ error: lockSec ? `失败次数过多，已锁定 ${lockSec} 秒` : genericErr });
  }
  security.loginOk(ip);
  if (v.needsUpgrade) {
    u.password = account.hashPassword(password);
  }

  const token = account.newToken();
  u.tokens = [...(u.tokens || []).slice(-4), token]; // 最多保留 5 个登录设备
  u.lastLogin = Date.now();
  store.upsertUser(u);
  store.setSession(token, { role: 'user', account: key });

  const maxAge = remember === false ? undefined : 30 * 86400000;
  res.cookie('cy_user', token, {
    httpOnly: true, sameSite: 'lax',
    secure: req.headers['x-forwarded-proto'] === 'https' || req.secure,
    maxAge,
  });
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

/* ============================================================
 * API：邮箱验证码 / 邮箱登录 / 找回密码
 * ============================================================ */

/** 发信配置是否就绪（决定是否走「开发模式」直接回显验证码） */
function mailCfg() {
  return (store.settings && store.settings.mail) || {};
}

/** 是否开启了邮箱验证相关能力 */
app.get('/api/mail/status', (req, res) => {
  const m = mailCfg();
  res.json({
    configured: !!(m.host && m.user && m.pass),
    from: m.from || m.user || '',
    scenes: mail.SCENE_NAME,
  });
});

/** 发送验证码 */
app.post('/api/mail/code', async (req, res) => {
  const ip = clientIp(req);
  // 🔒 发信限流：同 IP 每小时最多 10 次
  const rl = security.rateLimit('mail-code:' + ip, { window: 60 * 60 * 1000, max: 10 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: '发送过于频繁，请稍后再试' });
  }
  const { email, scene } = req.body || {};
  const sc = ['register', 'login', 'reset', 'bind'].includes(scene) ? scene : 'register';
  const to = String(email || '').trim().toLowerCase();

  // 场景预检：注册场景邮箱不能已被占用；登录/重置场景邮箱必须存在
  if (sc === 'register' && store.findUserByEmail(to)) {
    return res.status(409).json({ error: '该邮箱已被使用', field: 'email' });
  }
  if ((sc === 'login' || sc === 'reset') && !store.findUserByEmail(to)) {
    // 不暴露邮箱是否存在 → 仍返回成功，但实际不发（防枚举）
    return res.json({ ok: true, scene: sc, message: '若该邮箱已注册，验证码将发送至你的邮箱' });
  }

  const r = await mail.sendCode(mailCfg(), to, sc);
  if (!r.ok) {
    // 邮件服务未配置：如实告知，但绝不回显验证码
    if (r.mailNotConfigured) return res.status(503).json({ error: r.error, mailNotConfigured: true });
    return res.status(400).json({ error: r.error });
  }
  const out = { ok: true, scene: sc, message: '验证码已发送，请查收邮箱（5 分钟内有效）' };
  // 🔒 仅在部署方显式开启 MAIL_DEV_ECHO=1 且非生产环境时，才回显验证码。
  //    默认关闭：防止线上任何人拿他人邮箱取码重置密码。
  if (r.devMode) {
    out.devMode = true;
    out.devCode = r.devCode;
    out.message = '未配置 SMTP 服务，已启用开发模式';
  }
  res.json(out);
});

/** 邮箱验证码登录（免密码） */
app.post('/api/user/login/email', (req, res) => {
  const ip = clientIp(req);
  const rl = security.rateLimit('mail-login:' + ip, { window: 60 * 1000, max: 10 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `尝试过于频繁，请 ${rl.retryAfter} 秒后再试` });
  }
  const { email, code, remember } = req.body || {};
  const to = String(email || '').trim().toLowerCase();
  const u = store.findUserByEmail(to);
  if (!u) return res.status(401).json({ error: '邮箱或验证码错误' });
  if (u.status === 'banned') return res.status(403).json({ error: '该账号已被封禁' });

  const chk = mail.checkCode(to, code, 'login');
  if (!chk.ok) return res.status(401).json({ error: chk.error });

  const token = account.newToken();
  u.tokens = [...(u.tokens || []).slice(-4), token];
  u.lastLogin = Date.now();
  store.upsertUser(u);
  store.setSession(token, { role: 'user', account: u.account });
  const maxAge = remember === false ? undefined : 30 * 86400000;
  res.cookie('cy_user', token, {
    httpOnly: true, sameSite: 'lax',
    secure: req.headers['x-forwarded-proto'] === 'https' || req.secure,
    maxAge,
  });
  res.json({ ok: true, token, user: publicUser(u) });
});

/** 找回密码：邮箱验证码 + 新密码 */
app.post('/api/user/reset-password', (req, res) => {
  const ip = clientIp(req);
  const rl = security.rateLimit('reset-pwd:' + ip, { window: 60 * 60 * 1000, max: 8 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  }
  const { email, code, password } = req.body || {};
  const to = String(email || '').trim().toLowerCase();
  const u = store.findUserByEmail(to);
  if (!u) return res.status(400).json({ error: '邮箱未注册' });

  const ePwd = account.checkPassword(password);
  if (ePwd) return res.status(400).json({ error: ePwd, field: 'password' });

  const chk = mail.checkCode(to, code, 'reset');
  if (!chk.ok) return res.status(400).json({ error: chk.error });

  u.password = account.hashPassword(password);
  u.tokens = [];                 // 吊销全部旧登录
  store.upsertUser(u);
  res.json({ ok: true, message: '密码已重置，请使用新密码登录' });
});

/** 发送绑定邮箱验证码（需登录） */
app.post('/api/user/email/bind-code', async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const ip = clientIp(req);
  const rl = security.rateLimit('bind-code:' + ip, { window: 60 * 60 * 1000, max: 10 });
  if (!rl.ok) return res.status(429).json({ error: '发送过于频繁，请稍后再试' });

  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const e = account.checkEmail(email);
  if (e) return res.status(400).json({ error: e, field: 'email' });
  if (store.findUserByEmail(email)) return res.status(409).json({ error: '该邮箱已被使用', field: 'email' });

  const r = await mail.sendCode(mailCfg(), email, 'bind');
  if (!r.ok) {
    if (r.mailNotConfigured) return res.status(503).json({ error: r.error, mailNotConfigured: true });
    return res.status(400).json({ error: r.error });
  }
  const out = { ok: true, message: '验证码已发送' };
  // 🔒 同 /api/mail/code：默认不回显，需显式 MAIL_DEV_ECHO=1 且非生产
  if (r.devMode) { out.devMode = true; out.devCode = r.devCode; }
  res.json(out);
});

/** 确认绑定邮箱（需登录） */
app.post('/api/user/email/bind', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const { email, code } = req.body || {};
  const to = String(email || '').trim().toLowerCase();
  const chk = mail.checkCode(to, code, 'bind');
  if (!chk.ok) return res.status(400).json({ error: chk.error });
  if (store.findUserByEmail(to)) return res.status(409).json({ error: '该邮箱已被使用' });
  u.email = to;
  store.upsertUser(u);
  res.json({ ok: true, user: publicUser(u) });
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
    vip: isAdminAccount(u.account) ? ADMIN_PRIVILEGE : u.vip,
    isAdmin: isAdminAccount(u.account),
    unlimited: isAdminAccount(u.account),
    comments: store.getComments().filter((c) => c.account === u.account && c.status !== 'deleted').length,
  }));
  res.json({ users });
});

/**
 * 后台创建用户账号（不需要邮箱）
 * POST /api/admin/users
 * body: { account, password, nickname?, email?, vip?, days?, unlimited? }
 *
 * 用途：管理员直接开号，绕过邮箱验证码流程，适合批量发号 / 内部测试。
 */
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { account: acct, password, nickname = '', email = '', vip = '', days = 0, unlimited = false } = req.body || {};
  const a = String(acct || '').trim();
  const p = String(password || '');
  if (!/^[A-Za-z0-9_@.\-]{3,32}$/.test(a)) {
    return res.status(400).json({ error: '账号需 3-32 位，仅限字母/数字/下划线/点/横线/@' });
  }
  const pe = account.checkPassword(p);
  if (pe) return res.status(400).json({ error: '密码强度不足：' + pe });
  if (store.findUser(a)) return res.status(409).json({ error: '该账号已存在' });
  if (email && store.findUserByEmail(email)) return res.status(409).json({ error: '该邮箱已被占用' });

  const now = Date.now();
  let vipUntil = 0;
  if (unlimited) vipUntil = 0;
  else if (vip) {
    const d = Math.max(0, parseInt(days, 10) || 0);
    if (d > 0) {
      const base = { day: 86400000, month: 30 * 86400000, quarter: 90 * 86400000, year: 365 * 86400000 }[vip];
      const plan = store.findPlan && store.findPlan(vip);
      const dur = plan && plan.days ? plan.days * 86400000 : (base || 30 * 86400000);
      vipUntil = now + dur;
    }
  }

  const user = {
    account: a,
    nickname: nickname || a,
    email: String(email || '').trim(),
    password: account.hashPassword(p),
    vip: vip || '',
    vipUntil,
    unlimited: !!unlimited,
    role: 'user',
    status: 'active',
    tokens: [],
    createdAt: now,
    lastLogin: 0,
  };
  store.upsertUser(user);
  res.json({ ok: true, user: { account: a, nickname: user.nickname, email: user.email, vip: user.vip, vipUntil, unlimited: !!unlimited } });
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
 * 会员付费 · 钱包 · 兑换码（可选模块，默认关闭）
 * ------------------------------------------------------------
 * 设计理念：可付费可不付费
 *   · mode = 'optional'：自愿赞助制，不付费也能完整使用（仅少些增值权益）
 *   · mode = 'required'：权益制，部分增值功能需会员
 * 核心影视观看永远免费，付费只对应增值服务。
 * ============================================================ */

/** 站点根地址（用于拼接回调地址） */
function siteBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/** 金额规整到 2 位小数 */
function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 保存支付渠道列表（写回 monetize.channels） */
function savePayChannels(list) {
  const norm = (list || []).map((c, i) => pay.normalizeChannel(c, i));
  norm.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
  store.setSettings({ monetize: { channels: norm } });
  return norm;
}

/** 会员视图（含剩余天数） */
function vipView(u) {
  const cfg = store.settings.monetize || {};
  const isAdm = u && isAdminAccount(u.account);
  if (isAdm) {
    return {
      active: true,
      isAdmin: true,
      privilege: true,
      unlimited: true,
      source: 'admin',
      level: 'admin',
      name: '管理员（终身会员 · 无限额度）',
      expire: null,
      daysLeft: 36500,
      since: 0,
      balance: null,
      quota: pay.quotaView(u, { cfg, isAdmin: true, isVip: true }),
      currency: cfg.currency || '¥',
      mode: cfg.mode || 'optional',
    };
  }
  const own = u && u.vip && u.vip.expire > Date.now();
  const fam = u ? store.findFamilyOf(u.account) : null;
  let shared = false;
  if (!own && u && fam && fam.owner !== u.account && (store.settings.family || {}).shareVip !== false) {
    const owner = store.findUser(fam.owner);
    shared = !!(owner && owner.vip && owner.vip.expire > Date.now());
  }
  const active = own || shared;
  return {
    active,
    source: own ? 'own' : shared ? 'family' : null,
    level: own ? u.vip.level : shared ? 'family' : null,
    name: own ? u.vip.name || '会员' : shared ? '家庭共享会员' : null,
    expire: own ? u.vip.expire : null,
    daysLeft: own ? pay.vipDaysLeft(u) : 0,
    since: own ? u.vip.since || null : null,
    balance: money((u && u.balance) || 0),
    quota: pay.quotaView(u, { cfg, isAdmin: false, isVip: active }),
    currency: cfg.currency || '¥',
    mode: cfg.mode || 'optional',
  };
}

/** 会员中心信息 */
app.get('/api/vip/info', (req, res) => {
  const cfg = store.settings.monetize || {};
  const u = currentUser(req);
  res.json({
    enabled: !!cfg.enabled,
    mode: cfg.mode || 'optional',
    currency: cfg.currency || '¥',
    provider: cfg.provider || 'mock',
    testMode: cfg.testMode !== false,
    allowBalance: cfg.allowBalance !== false,
    redeemEnabled: cfg.redeemEnabled !== false,
    adminUnlimited: cfg.adminUnlimited !== false,
    minRecharge: cfg.minRecharge || 1,
    rechargePresets: cfg.rechargePresets || [10, 30, 50, 100, 200, 500],
    orderTimeout: cfg.orderTimeout || 30,
    isAdmin: !!(u && isAdminAccount(u.account)),
    adminNote: u && isAdminAccount(u.account) ? '管理员账号享有终身会员与无限额度' : '',
    // —— 额度系统 ——
    quotaEnabled: !!cfg.quotaEnabled,
    quotaRules: {
      requireLogin: cfg.requireLogin !== false,
      freeDailyPlays: Math.max(0, Number(cfg.freeDailyPlays) || 0),
      costPerPlay: Math.max(1, Number(cfg.costPerPlay) || 1),
      dedupeDaily: cfg.dedupeDaily !== false,
      vipFreePlays: cfg.vipFreePlays !== false,
      allowPointsForPlay: cfg.allowPointsForPlay !== false,
      pointCosts: cfg.pointCosts || {},
    },
    plans: (cfg.plans || []).map((p) => ({
      ...p,
      // 省多少钱
      save: p.originalPrice ? money(p.originalPrice - p.price) : 0,
      perDay: p.days ? money(p.price / p.days) : 0,
    })),
    payMethods: pay.payMethods(cfg),
    channels: pay.availableChannels(cfg),
    vip: u ? vipView(u) : null,
    loggedIn: !!u,
  });
});

/** ============ 额度（观看次数 / 通用点数） ============ */

/** 我的额度 */
app.get('/api/quota', (req, res) => {
  const cfg = store.settings.monetize || {};
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const isAdm = isAdminAccount(u.account);
  const v = pay.quotaView(u, { cfg, isAdmin: isAdm, isVip: isVip(u) });
  res.json({
    ok: true,
    enabled: !!cfg.quotaEnabled,
    quota: v,
    rules: {
      requireLogin: cfg.requireLogin !== false,
      freeDailyPlays: Math.max(0, Number(cfg.freeDailyPlays) || 0),
      costPerPlay: Math.max(1, Number(cfg.costPerPlay) || 1),
      dedupeDaily: cfg.dedupeDaily !== false,
      vipFreePlays: cfg.vipFreePlays !== false,
      allowPointsForPlay: cfg.allowPointsForPlay !== false,
      pointCosts: cfg.pointCosts || {},
    },
    redeemEnabled: cfg.redeemEnabled !== false,
    currency: cfg.currency || '¥',
  });
});

/** 额度流水 */
app.get('/api/quota/log', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const { page = 1, size = 20 } = req.query;
  const all = store.getQuotaLog(u.account, 500);
  const p = Math.max(1, parseInt(page, 10) || 1);
  const s = Math.min(100, parseInt(size, 10) || 20);
  res.json({ total: all.length, page: p, size: s, list: all.slice((p - 1) * s, p * s) });
});

/** 增值功能扣点（超清 / 下载 / 去广告 / 纯点看片） */
app.post('/api/quota/spend', (req, res) => {
  const cfg = store.settings.monetize || {};
  const u = currentUser(req);
  const b = req.body || {};
  const feature = ['play', 'hd', 'download', 'noAd'].includes(b.feature) ? b.feature : 'play';

  const isAdm = u ? isAdminAccount(u.account) : false;
  const chk = pay.checkSpend(u, feature, cfg, { isAdmin: isAdm, isVip: u ? isVip(u) : false });
  if (!chk.ok) {
    return res.status(402).json({
      error: chk.error,
      needPoints: chk.needPoints,
      points: chk.points,
      needRecharge: true,
      feature,
    });
  }
  if (chk.cost > 0 && u) {
    store.addQuota(u.account, { points: -chk.cost });
    store.addQuotaLog({
      account: u.account,
      type: 'points',
      delta: -chk.cost,
      reason: { hd: '超清画质', download: '下载影片', noAd: '去广告', play: '点数观看' }[feature] || '增值功能',
      ref: String(b.guid || ''),
      after: pay.ensureQuota(store.findUser(u.account)).points,
    });
  }
  res.json({
    ok: true,
    feature,
    charged: chk.cost,
    free: chk.free,
    quota: pay.quotaView(store.findUser(u ? u.account : null), { cfg, isAdmin: isAdm, isVip: u ? isVip(u) : false }),
  });
});

/** 我的订单 */
app.get('/api/user/orders', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  store.expireOrders();
  const list = store.getOrdersOf(u.account, 100).map((o) => ({
    ...o,
    expired: o.status === 'pending' && o.expire && o.expire < Date.now(),
  }));
  res.json({ list, wallet: { balance: money(u.balance || 0) } });
});

/** 钱包信息 */
app.get('/api/user/wallet', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  res.json({
    balance: money(u.balance || 0),
    currency: (store.settings.monetize || {}).currency || '¥',
    log: store.getWalletLog(u.account, 50),
  });
});

/**
 * 下单
 * body: { type:'vip'|'recharge', planId?, amount?, payMethod?, useBalance? }
 * - type=vip      : 购买套餐，planId 必填
 * - type=recharge : 余额充值，amount 必填
 * - useBalance    : 是否用余额直接支付（仅 type=vip 有效）
 */
app.post('/api/vip/order', (req, res) => {
  const cfg = store.settings.monetize || {};
  if (!cfg.enabled) return res.status(403).json({ error: '付费模块未开启' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录后再操作' });

  const b = req.body || {};
  const type = b.type === 'recharge' ? 'recharge' : 'vip';
  const payMethod = String(b.payMethod || 'alipay');
  const channelId = String(b.channelId || '');
  const useBalance = !!b.useBalance;

  // ---- 管理员特权：无需下单，直接授予（会员/额度无限） ----
  if (isAdminAccount(u.account)) {
    return res.json({
      ok: true, paid: true, privileged: true,
      message: '管理员账号享有终身会员与无限额度，无需购买',
      order: null, vip: vipView(u),
    });
  }

  let plan = null;
  let amount = 0;
  let planName = '';

  if (type === 'vip') {
    plan = store.findPlan(b.planId);
    if (!plan) return res.status(404).json({ error: '套餐不存在或已下架' });
    amount = money(plan.price);
    planName = plan.name;
  } else {
    if (cfg.allowBalance === false && b.type === 'recharge') {
      return res.status(403).json({ error: '本站未开启充值功能' });
    }
    amount = money(b.amount);
    const min = Number(cfg.minRecharge) || 1;
    if (!(amount >= min)) return res.status(400).json({ error: `单次充值不少于 ${cfg.currency || '¥'}${min}` });
    if (amount > 100000) return res.status(400).json({ error: '单次充值金额过大' });
    planName = '余额充值';
  }

  // ---- 余额支付：直接扣款，立即完成 ----
  if (useBalance && type === 'vip') {
    if (cfg.allowBalance === false) return res.status(403).json({ error: '本站未开启余额支付' });
    if ((u.balance || 0) < amount) {
      return res.status(400).json({ error: '余额不足，请先充值', needRecharge: true, balance: money(u.balance || 0), amount });
    }
    const order = store.addOrder({
      type: 'vip', account: u.account, planId: plan.id, planName: plan.name,
      amount, payMethod: 'balance', status: 'pending', title: plan.name,
    });
    store.addBalance(u.account, -amount);
    finishOrder(order, { via: 'balance' });
    return res.json({ ok: true, paid: true, order: store.findOrder(order.id), vip: vipView(store.findUser(u.account)) });
  }

  // ---- 在线支付：创建待支付订单 ----
  const order = store.addOrder({
    id: pay.newOrderNo(),
    type,
    account: u.account,
    planId: plan ? plan.id : null,
    planName,
    amount,
    payMethod,
    channelId,
    status: 'pending',
    title: planName,
  });

  const payment = pay.buildPayment(cfg, order, siteBaseUrl(req));
  // 渠道不可用时：作废订单并明确报错，避免前端拿到"看似成功"的订单
  if (!payment.ok) {
    store.updateOrder(order.id, { status: 'cancelled', cancelAt: Date.now(), cancelReason: payment.error || 'channel unavailable' });
    return res.status(400).json({ ok: false, error: payment.error || '支付渠道不可用', order: store.findOrder(order.id) });
  }
  res.json({ ok: true, paid: false, order, payment, vip: vipView(u) });
});

/** 兼容旧接口：POST /api/user/order 等价于 /api/vip/order（type=vip） */
app.post('/api/user/order', (req, res) => {
  const cfg = store.settings.monetize || {};
  if (!cfg.enabled) return res.status(403).json({ error: '付费模块未开启' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录后再操作' });
  const plan = store.findPlan((req.body || {}).planId);
  if (!plan) return res.status(404).json({ error: '套餐不存在' });
  const order = store.addOrder({
    id: pay.newOrderNo(),
    type: 'vip',
    account: u.account,
    planId: plan.id,
    planName: plan.name,
    amount: money(plan.price),
    payMethod: (req.body || {}).payMethod || 'alipay',
    status: 'pending',
    title: plan.name,
  });
  const payment = pay.buildPayment(cfg, order, siteBaseUrl(req));
  if (!payment.ok) {
    store.updateOrder(order.id, { status: 'cancelled', cancelAt: Date.now(), cancelReason: payment.error || 'channel unavailable' });
    return res.status(400).json({ ok: false, error: payment.error || '支付渠道不可用' });
  }
  res.json({ ok: true, order, payment });
});

/** 取消订单 */
app.post('/api/user/order/:id/cancel', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const o = store.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.account !== u.account) return res.status(403).json({ error: '无权操作该订单' });
  if (o.status !== 'pending') return res.status(400).json({ error: '该订单当前状态不可取消' });
  store.updateOrder(o.id, { status: 'cancelled', cancelAt: Date.now() });
  res.json({ ok: true });
});

/** 查询单个订单状态（前端轮询支付结果用） */
app.get('/api/user/order/:id', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const o = store.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.account !== u.account) return res.status(403).json({ error: '无权查看该订单' });
  res.json({
    order: {
      ...o,
      expired: o.status === 'pending' && o.expire && o.expire < Date.now(),
    },
    vip: vipView(u),
  });
});

/**
 * 订单完成后发放权益（幂等：已发放过不再重复）
 * @param {object} order
 * @param {object} opts { via 支付渠道 }
 */
function finishOrder(order, opts = {}) {
  if (!order || order.status === 'paid') return order;
  const cfg = store.settings.monetize || {};
  store.updateOrder(order.id, {
    status: 'paid',
    payAt: Date.now(),
    paidAt: Date.now(),   // 兼容旧字段
    payVia: opts.via || order.payMethod || 'online',
    grantDone: false,
  });
  const fresh = store.findOrder(order.id);

  const u = fresh.account && fresh.account !== 'guest' ? store.findUser(fresh.account) : null;
  if (u) {
    try {
      if (fresh.type === 'recharge') {
        store.addBalance(u.account, fresh.amount);
      } else if (fresh.planId) {
        const plan = store.findPlan(fresh.planId);
        if (plan) {
          pay.grantVip(u, plan);
          store.upsertUser(u);
        }
      }
      store.updateOrder(fresh.id, { grantDone: true, grantAt: Date.now() });
    } catch (e) {
      console.error('[pay] 发放权益失败', e.message);
      store.updateOrder(fresh.id, { grantError: e.message });
    }
  }
  return store.findOrder(order.id);
}

/** 模拟支付（演示模式 / 测试模式专用） */
app.post('/api/pay/mock', (req, res) => {
  const cfg = store.settings.monetize || {};
  if (!cfg.enabled) return res.status(403).json({ error: '付费模块未开启' });
  if (cfg.testMode === false) return res.status(403).json({ error: '演示支付已关闭' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const o = store.findOrder((req.body || {}).orderId);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.account !== u.account) return res.status(403).json({ error: '无权操作该订单' });
  if (o.status === 'paid') return res.json({ ok: true, order: o, vip: vipView(u) });
  if (o.status !== 'pending') return res.status(400).json({ error: '订单已失效，请重新下单' });
  const done = finishOrder(o, { via: 'mock' });
  res.json({ ok: true, order: done, vip: vipView(store.findUser(u.account)) });
});

/* ============================================================
 * 支付渠道：微信 V3 下单 / 人工收款凭证 / 渠道可用性
 * ============================================================ */

/**
 * 微信支付 V3 · Native 扫码下单
 * 前端拿到 buildPayment 的 payload（含 body / auth 头）后，POST 到此接口由服务端发起真实请求
 */
app.post('/api/pay/wxpay/native', async (req, res) => {
  const cfg = store.settings.monetize || {};
  if (!cfg.enabled) return res.status(403).json({ error: '付费模块未开启' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });

  const o = store.findOrder((req.body || {}).orderId);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.account !== u.account) return res.status(403).json({ error: '无权操作该订单' });
  if (o.status !== 'pending') return res.status(400).json({ error: '订单已失效，请重新下单' });

  // 定位微信渠道
  const ch = pay.getChannels(cfg).find((c) => c.type === 'wxpay' && c.enabled)
    || pay.getChannels(cfg).find((c) => c.id === o.channelId);
  if (!ch || ch.type !== 'wxpay') return res.status(400).json({ error: '未配置可用的微信支付渠道' });
  const chk = pay.checkChannel(ch);
  if (!chk.ok) return res.status(400).json({ error: chk.error });

  const body = {
    appid: ch.config.appId,
    mchid: ch.config.mchId,
    description: (o.planName || '会员服务').slice(0, 120),
    out_trade_no: o.id,
    notify_url: `${siteBaseUrl(req)}/api/pay/callback`,
    amount: { total: Math.round(Number(o.amount) * 100), currency: 'CNY' },
  };
  const bodyStr = JSON.stringify(body);
  let auth = '';
  try {
    auth = pay.wxV3Auth('POST', '/v3/pay/transactions/native',
      ch.config.mchId, ch.config.serialNo, ch.config.privateKey, bodyStr);
  } catch (e) {
    return res.status(400).json({ error: '商户私钥无效：' + e.message });
  }

  const gw = (ch.config.gateway || 'https://api.mch.weixin.qq.com').replace(/\/+$/, '');
  try {
    const r = await fetch(`${gw}/v3/pay/transactions/native`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'ciyun-tv/1.0',
        Authorization: auth,
      },
      body: bodyStr,
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!r.ok) {
      return res.status(502).json({
        error: (j && (j.message || j.code)) || '微信下单失败',
        detail: txt.slice(0, 300),
      });
    }
    // 保存 prepay_id，便于后续查询
    store.updateOrder(o.id, { prepayId: j.prepay_id || '', qrcodeUrl: j.code_url || '' });
    res.json({ ok: true, codeUrl: j.code_url || '', prepayId: j.prepay_id || '' });
  } catch (e) {
    res.status(502).json({ error: '无法连接微信支付网关：' + e.message });
  }
});

/** 人工收款：用户提交支付凭证（转账号 / 截图链接 / 备注），等待管理员确认 */
app.post('/api/pay/manual/claim', (req, res) => {
  const cfg = store.settings.monetize || {};
  if (!cfg.enabled) return res.status(403).json({ error: '付费模块未开启' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const b = req.body || {};
  const o = store.findOrder(b.orderId);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.account !== u.account) return res.status(403).json({ error: '无权操作该订单' });
  if (o.status !== 'pending') return res.status(400).json({ error: '订单当前状态无需提交凭证' });
  const proof = String(b.proof || '').trim().slice(0, 500);
  if (!proof) return res.status(400).json({ error: '请填写支付凭证（转账单号 / 末四位 / 截图链接）' });
  store.updateOrder(o.id, {
    claim: { proof, note: String(b.note || '').slice(0, 300), at: Date.now(), by: u.account },
    status: 'claiming',
  });
  res.json({ ok: true, order: store.findOrder(o.id), message: '凭证已提交，管理员确认后自动到账' });
});

/** 可用支付渠道（前台展示用，不含敏感配置） */
app.get('/api/pay/channels', (req, res) => {
  const cfg = store.settings.monetize || {};
  res.json({
    enabled: !!cfg.enabled,
    currency: cfg.currency || '¥',
    channels: cfg.enabled ? pay.availableChannels(cfg) : [],
    methods: cfg.enabled ? pay.payMethods(cfg) : [],
    allowBalance: cfg.allowBalance !== false,
    rechargePresets: cfg.rechargePresets || [10, 30, 50, 100, 200, 500],
    minRecharge: cfg.minRecharge || 1,
  });
});

/** 渠道类型清单（后台表单渲染用） */
app.get('/api/admin/pay/channel-types', requireAdmin, (req, res) => {
  res.json({
    types: Object.entries(pay.CHANNEL_TYPES).map(([id, t]) => ({
      id, name: t.name, icon: t.icon, desc: t.desc,
      fields: t.fields || [], methods: t.methods || [],
    })),
    methodMeta: pay.METHOD_META,
  });
});

/** 后台：渠道列表 */
app.get('/api/admin/pay/channels', requireAdmin, (req, res) => {
  const cfg = store.settings.monetize || {};
  const list = pay.getChannels(cfg).map((c) => ({
    ...c,
    ready: pay.channelReady(c),
    check: pay.checkChannel(c),
  }));
  res.json({ channels: list, list: list });
});

/** 后台：新增渠道 */
app.post('/api/admin/pay/channels', requireAdmin, (req, res) => {
  const cfg = store.settings.monetize || {};
  const list = pay.getChannels(cfg);
  const ch = pay.normalizeChannel(req.body || {}, list.length);
  if (list.find((x) => x.id === ch.id)) return res.status(409).json({ error: '渠道 ID 已存在' });
  list.push(ch);
  savePayChannels(list);
  res.json({ ok: true, channel: ch, check: pay.checkChannel(ch) });
});

/** 后台：修改渠道（配置 / 启停 / 排序 / 名称 / 支付方式） */
app.put('/api/admin/pay/channels/:id', requireAdmin, (req, res) => {
  const cfg = store.settings.monetize || {};
  const list = pay.getChannels(cfg);
  const idx = list.findIndex((c) => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '渠道不存在' });
  const b = req.body || {};
  const merged = {
    ...list[idx],
    ...b,
    id: list[idx].id,
    // 配置项做合并（允许只改其中一项，不覆盖其余密钥）
    config: b.config ? { ...list[idx].config, ...b.config } : list[idx].config,
    methods: b.methods || list[idx].methods,
  };
  list[idx] = pay.normalizeChannel(merged, idx);
  savePayChannels(list);
  res.json({ ok: true, channel: list[idx], check: pay.checkChannel(list[idx]) });
});

/** 后台：删除渠道 */
app.delete('/api/admin/pay/channels/:id', requireAdmin, (req, res) => {
  const cfg = store.settings.monetize || {};
  const list = pay.getChannels(cfg).filter((c) => c.id !== req.params.id);
  savePayChannels(list);
  res.json({ ok: true, total: list.length });
});

/** 后台：渠道排序（一次性提交顺序数组）
 *  注意：路径不能放在 /channels/:id 之下，否则 "order" 会被当作 id 吃掉
 */
app.put('/api/admin/pay/channel-order', requireAdmin, (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必须为数组' });
  const cfg = store.settings.monetize || {};
  const list = pay.getChannels(cfg);
  ids.forEach((id, i) => {
    const c = list.find((x) => x.id === id);
    if (c) c.sort = (i + 1) * 10;
  });
  savePayChannels(list);
  res.json({ ok: true });
});

/** 后台：连通性自检（不发真实请求，只校验配置完整性 + 密钥可解析） */
app.post('/api/admin/pay/channels/:id/test', requireAdmin, (req, res) => {
  const cfg = store.settings.monetize || {};
  const ch = pay.getChannels(cfg).find((c) => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: '渠道不存在' });
  const check = pay.checkChannel(ch);
  res.json({
    ok: check.ok,
    ready: pay.channelReady(ch),
    error: check.error || '',
    missing: check.missing || [],
    type: ch.type,
    name: ch.name,
    message: check.ok ? '配置完整，可正常使用' : (check.error || '配置不完整'),
  });
});

/** 后台：人工收款订单确认 / 驳回 */
app.post('/api/admin/pay/orders/:id/confirm', requireAdmin, (req, res) => {
  const o = store.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.status === 'paid') return res.json({ ok: true, order: o, message: '订单已支付' });
  if (!['pending', 'claiming'].includes(o.status)) {
    return res.status(400).json({ error: '该订单当前状态不可确认' });
  }
  const done = finishOrder(o, { via: 'manual:' + ((req.admin && (req.admin.user || req.admin.username)) || 'admin') });
  res.json({ ok: true, order: done });
});

app.post('/api/admin/pay/orders/:id/reject', requireAdmin, (req, res) => {
  const o = store.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.status === 'paid') return res.status(400).json({ error: '已支付订单不可驳回，请走退款' });
  store.updateOrder(o.id, {
    status: 'rejected',
    rejectReason: String((req.body || {}).reason || '凭证无效').slice(0, 200),
    rejectAt: Date.now(),
  });
  res.json({ ok: true, order: store.findOrder(o.id) });
});

/**
 * 支付回调（真实网关）
 * body: { out_trade_no|orderId, trade_status|status, money, sign, ... }
 * 校验：签名（若配置了 signKey）+ 金额一致性
 */
app.post('/api/pay/callback', (req, res) => {
  const cfg = store.settings.monetize || {};
  const b = req.body || {};
  const orderId = b.out_trade_no || b.orderId || b.order_id;
  const o = store.findOrder(orderId);
  if (!o) return res.status(404).send('order not found');

  // 签名校验（配置了 signKey 才强制）
  if (cfg.signKey) {
    if (!pay.verifySign(b, cfg.signKey)) {
      console.warn('[pay] 回调签名校验失败', orderId);
      return res.status(400).send('sign error');
    }
  }

  // 金额校验：若回调带金额，必须与订单一致
  if (b.money !== undefined && money(b.money) !== money(o.amount)) {
    console.warn('[pay] 回调金额不一致', orderId, b.money, o.amount);
    return res.status(400).send('amount mismatch');
  }

  // 支付状态：易支付风格 trade_status=TRADE_SUCCESS
  const okStatus = ['TRADE_SUCCESS', 'SUCCESS', 'success', 'paid', 'TRADE_FINISHED'].includes(String(b.trade_status || b.status || 'paid'));
  if (!okStatus) {
    return res.send('fail');
  }

  if (o.status === 'pending') finishOrder(o, { via: 'callback' });
  // 网关通常要求返回 success 纯文本
  res.send('success');
});

/** 退款 / 后台手动标记（管理员） */
function refundOrder(id, byAdmin) {
  const o = store.findOrder(id);
  if (!o) return null;
  if (o.status !== 'paid') return { error: '仅已支付订单可退款' };
  const u = o.account && o.account !== 'guest' ? store.findUser(o.account) : null;

  // 退款：扣回余额或回收会员时长（按套餐天数回退）
  if (u) {
    if (o.type === 'recharge') {
      store.addBalance(u.account, -o.amount);
    } else if (o.planId && u.vip) {
      const plan = store.findPlan(o.planId);
      if (plan) {
        u.vip.expire = Math.max(Date.now(), u.vip.expire - plan.days * 86400000);
        if (u.vip.expire <= Date.now()) u.vip = null;
        store.upsertUser(u);
      }
    }
  }
  store.updateOrder(id, { status: 'refunded', refundAt: Date.now(), refundBy: byAdmin || 'admin' });
  return store.findOrder(id);
}

/* ============================================================
 * 兑换码（用户端）
 * ============================================================ */

/** 兑换 */
app.post('/api/user/redeem', (req, res) => {
  const cfg = store.settings.monetize || {};
  if (cfg.redeemEnabled === false) return res.status(403).json({ error: '本站未开启兑换码功能' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录后再兑换' });

  const code = String((req.body || {}).code || '').trim();
  if (!code) return res.status(400).json({ error: '请输入兑换码' });

  const rec = store.findRedeemCode(code);
  const chk = pay.checkRedeem(rec);
  if (!chk.ok) return res.status(400).json({ error: chk.error });

  const r = pay.applyRedeem(rec, u);
  store.upsertUser(u);
  store.consumeRedeemCode(rec.code, u.account);

  // 记录一条零金额订单，便于流水查询
  store.addOrder({
    id: pay.newOrderNo(),
    type: rec.type === 'balance' ? 'recharge' : rec.type === 'vip' ? 'vip' : 'quota',
    quotaType: rec.type.startsWith('quota') ? rec.type : null,
    account: u.account,
    planId: null,
    planName: rec.planName + '（兑换码）',
    amount: 0,
    payMethod: 'redeem',
    status: 'paid',
    payAt: Date.now(),
    payVia: 'redeem',
    redeemCode: rec.code,
    grantDone: true,
    title: rec.planName,
  });

  // 额度类兑换补记额度流水
  if (rec.type === 'quota_times' || rec.type === 'quota_points') {
    const dim = rec.type === 'quota_times' ? 'times' : 'points';
    store.addQuotaLog({
      account: u.account,
      type: dim,
      delta: Number(rec.value) || 0,
      reason: '兑换码兑换',
      ref: rec.code,
      after: pay.ensureQuota(store.findUser(u.account))[dim],
    });
  }

  res.json({
    ok: true,
    redeem: r,
    vip: vipView(store.findUser(u.account)),
    quota: pay.quotaView(store.findUser(u.account), {
      cfg,
      isAdmin: isAdminAccount(u.account),
      isVip: isVip(store.findUser(u.account)),
    }),
  });
});

/* ============================================================
 * 会员付费（后台管理）
 * ============================================================ */

/** 保存付费配置 */
app.put('/api/admin/monetize', requireAdmin, (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['enabled', 'testMode', 'allowBalance', 'redeemEnabled', 'autoRenewTip', 'adminUnlimited',
    'quotaEnabled', 'requireLogin', 'dedupeDaily', 'vipFreePlays', 'allowPointsForPlay']) {
    if (b[k] !== undefined) patch[k] = !!b[k];
  }
  if (b.mode !== undefined) patch.mode = b.mode === 'required' ? 'required' : 'optional';
  if (b.provider !== undefined) patch.provider = ['mock', 'epay', 'custom'].includes(b.provider) ? b.provider : 'mock';
  if (b.currency !== undefined) patch.currency = String(b.currency).slice(0, 4) || '¥';
  for (const k of ['notifyUrl', 'merchantId', 'signKey', 'gateway']) {
    if (b[k] !== undefined) patch[k] = String(b[k]).slice(0, 300);
  }
  for (const k of ['minRecharge', 'orderTimeout']) {
    if (b[k] !== undefined) patch[k] = Math.max(0, Number(b[k]) || 0);
  }
  if (Array.isArray(b.rechargePresets)) {
    patch.rechargePresets = b.rechargePresets
      .map((x) => Math.max(1, Number(x) || 0))
      .filter(Boolean)
      .slice(0, 12);
  }
  // 额度相关数值
  for (const k of ['freeDailyPlays', 'costPerPlay']) {
    if (b[k] !== undefined) patch[k] = Math.max(0, parseInt(b[k], 10) || 0);
  }
  if (b.costPerPlay !== undefined && !(patch.costPerPlay >= 1)) patch.costPerPlay = 1;
  if (b.pointCosts && typeof b.pointCosts === 'object') {
    const pc = {};
    for (const k of ['play', 'hd', 'download', 'noAd']) {
      pc[k] = Math.max(0, parseInt(b.pointCosts[k], 10) || 0);
    }
    patch.pointCosts = pc;
  }
  if (Array.isArray(b.plans)) {
    patch.plans = b.plans.slice(0, 20).map((p, i) => ({
      id: String(p.id || 'plan_' + (i + 1)).slice(0, 40),
      name: String(p.name || '套餐').slice(0, 30),
      days: Math.max(1, Math.min(3650, parseInt(p.days, 10) || 30)),
      price: Math.max(0, money(p.price)),
      originalPrice: p.originalPrice ? Math.max(0, money(p.originalPrice)) : 0,
      badge: String(p.badge || '').slice(0, 12),
      recommended: !!p.recommended,
      perks: Array.isArray(p.perks)
        ? p.perks.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
        : String(p.perks || '').split(/[，,]/).map((x) => x.trim()).filter(Boolean).slice(0, 12),
    }));
  }
  store.setSettings({ monetize: patch });
  res.json(store.settings.monetize);
});

/** 订单管理：分页 + 筛选 */
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  store.expireOrders();
  const { status = '', type = '', account = '', keyword = '', page = 1, size = 20 } = req.query;
  res.json(store.queryOrders({
    status, type, account, keyword,
    page: parseInt(page, 10) || 1,
    size: parseInt(size, 10) || 20,
  }));
});

/** 订单操作：标记已支付 / 退款 / 取消 */
app.put('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const { action, note } = req.body || {};
  const o = store.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });

  if (action === 'paid') {
    if (o.status === 'paid') return res.json({ ok: true, order: o });
    const done = finishOrder(o, { via: 'admin' });
    return res.json({ ok: true, order: done });
  }
  if (action === 'refund') {
    const r = refundOrder(o.id, (req.admin && req.admin.user) || 'admin');
    if (r && r.error) return res.status(400).json({ error: r.error });
    return res.json({ ok: true, order: r });
  }
  if (action === 'cancel') {
    store.updateOrder(o.id, { status: 'cancelled', cancelAt: Date.now() });
    return res.json({ ok: true, order: store.findOrder(o.id) });
  }
  // 兼容旧的直接 patch 用法
  const patch = { ...(req.body || {}) };
  delete patch.action;
  if (note !== undefined) patch.note = String(note).slice(0, 200);
  store.updateOrder(o.id, patch);
  res.json(store.findOrder(o.id));
});

app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const s = store.getOrders();
  const i = s.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '订单不存在' });
  s.splice(i, 1);
  res.json({ ok: true });
});

/** 收入看板 */
app.get('/api/admin/revenue', requireAdmin, (req, res) => {
  store.expireOrders();
  res.json(store.revenueSummary());
});

/* ---- 兑换码管理 ---- */
app.get('/api/admin/redeem', requireAdmin, (req, res) => {
  const { batch = '', type = '', status = '', keyword = '', page = 1, size = 50 } = req.query;
  res.json(store.queryRedeemCodes({
    batch, type, status, keyword,
    page: parseInt(page, 10) || 1,
    size: parseInt(size, 10) || 50,
  }));
});

/** 兑换码类型标签与单位 */
const REDEEM_LABEL = { vip: '会员', balance: '余额', quota_times: '次数额度', quota_points: '点数' };
const REDEEM_UNIT = { vip: '天', balance: '元', quota_times: '次', quota_points: '点' };
const REDEEM_LIMIT = { vip: 3650, balance: 100000, quota_times: 1000000, quota_points: 1000000 };

app.post('/api/admin/redeem', requireAdmin, (req, res) => {
  const b = req.body || {};
  const type = REDEEM_TYPES.includes(b.type) ? b.type : 'vip';
  const value = Number(b.value);
  if (!(value > 0)) return res.status(400).json({ error: '请填写有效的面额/天数' });
  if (value > REDEEM_LIMIT[type]) {
    return res.status(400).json({ error: `${REDEEM_LABEL[type]}数值过大（上限 ${REDEEM_LIMIT[type]}）` });
  }

  const defaultName = {
    vip: `${value} 天会员`,
    balance: '余额充值',
    quota_times: `${value} 次观看额度`,
    quota_points: `${value} 点数`,
  }[type];

  const list = store.createRedeemCodes({
    type,
    value,
    planName: String(b.planName || defaultName).slice(0, 30),
    count: Math.max(1, Math.min(500, parseInt(b.count, 10) || 1)),
    batch: String(b.batch || '').slice(0, 24) || undefined,
    ttlDays: Math.max(0, parseInt(b.ttlDays, 10) || 0),
  });
  res.json({ ok: true, codes: list, count: list.length });
});

app.delete('/api/admin/redeem', requireAdmin, (req, res) => {
  const codes = (req.body || {}).codes || [];
  if (!Array.isArray(codes) || !codes.length) return res.status(400).json({ error: '请选择要删除的兑换码' });
  store.deleteRedeemCodes(codes.map((c) => String(c).toUpperCase()));
  res.json({ ok: true });
});

/** 导出兑换码 CSV */
app.get('/api/admin/redeem/export', requireAdmin, (req, res) => {
  const batch = req.query.batch || '';
  const status = req.query.status || '';
  const type = req.query.type || '';
  // 分页拉取全部匹配项（每页 200 为 store 上限）
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const chunk = store.queryRedeemCodes({ batch, status, type, page, size: 200 }).list;
    all.push(...chunk);
    if (chunk.length < 200) break;
  }
  const rows = [];
  rows.push(['兑换码', '类型', '面额/天数', '套餐名', '批次', '状态', '使用者', '使用时间', '创建时间'].join(','));
  const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '');
  for (const x of all) {
    rows.push([
      x.code,
      REDEEM_LABEL[x.type] || '会员',
      `${x.value} ${REDEEM_UNIT[x.type] || ''}`.trim(),
      `"${String(x.planName || '').replace(/"/g, '""')}"`,
      x.batch || '',
      x.used ? '已使用' : '未使用',
      x.usedBy || '',
      fmt(x.usedAt),
      fmt(x.createdAt),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="redeem-${batch || 'all'}.csv"`);
  res.send('\ufeff' + rows.join('\n'));  // BOM 让 Excel 正确识别中文
});

/* ---- 后台：额度管理 ---- */

/** 额度总览与用户列表 */
app.get('/api/admin/quota/users', requireAdmin, (req, res) => {
  const { keyword = '', status = '', page = 1, size = 20 } = req.query;
  const result = store.queryQuotaUsers({
    keyword, status,
    page: parseInt(page, 10) || 1,
    size: parseInt(size, 10) || 20,
  });
  res.json({ ...result, stats: store.quotaStats() });
});

/** 调整单个用户的额度 */
app.put('/api/admin/quota/users/:account', requireAdmin, (req, res) => {
  const u = store.findUser(req.params.account);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const b = req.body || {};
  const mode = b.mode === 'delta' ? 'delta' : 'set';
  const { times, points, reason } = b;

  if (times === undefined && points === undefined) {
    return res.status(400).json({ error: '请至少填写一项额度' });
  }
  const patch = {};
  for (const k of ['times', 'points']) {
    if (b[k] === undefined || b[k] === '') continue;
    const n = parseInt(b[k], 10);
    if (!Number.isFinite(n)) return res.status(400).json({ error: '额度需为整数' });
    // set 模式：值即最终额度，不得小于 -1；delta 模式：允许负数为扣减
    if (mode === 'set' && n < -1) return res.status(400).json({ error: '额度不能小于 -1（-1 表示无限）' });
    if (Math.abs(n) > 10000000) return res.status(400).json({ error: '额度数值过大' });
    patch[k] = n;
  }

  let after;
  if (mode === 'delta') {
    after = store.addQuota(u.account, patch);
  } else {
    after = store.setQuota(u.account, patch);
  }
  for (const k of Object.keys(patch)) {
    store.addQuotaLog({
      account: u.account,
      type: k,
      delta: mode === 'delta' ? patch[k] : null,
      reason: String(reason || '后台调整').slice(0, 60),
      ref: 'admin',
      after: after ? after[k] : null,
    });
  }
  res.json({ ok: true, quota: after });
});

/** 批量发放额度 */
app.post('/api/admin/quota/grant', requireAdmin, (req, res) => {
  const b = req.body || {};
  const accounts = Array.isArray(b.accounts) ? b.accounts.map((a) => String(a).toLowerCase()) : [];
  if (!accounts.length) return res.status(400).json({ error: '请选择要发放的用户' });
  const times = b.times === undefined || b.times === '' ? 0 : parseInt(b.times, 10) || 0;
  const points = b.points === undefined || b.points === '' ? 0 : parseInt(b.points, 10) || 0;
  if (!times && !points) return res.status(400).json({ error: '请填写要发放的额度' });

  const done = [];
  const missing = [];
  for (const acc of accounts.slice(0, 500)) {
    if (!store.findUser(acc)) { missing.push(acc); continue; }
    const q = store.addQuota(acc, { times, points });
    store.addQuotaLog({
      account: acc, type: times ? 'times' : 'points',
      delta: times || points,
      reason: String(b.reason || '批量发放').slice(0, 60),
      ref: 'admin-batch',
      after: q ? q[times ? 'times' : 'points'] : null,
    });
    done.push(acc);
  }
  res.json({ ok: true, granted: done.length, accounts: done, missing });
});

/** 额度流水查询（后台） */
app.get('/api/admin/quota/log', requireAdmin, (req, res) => {
  const { account = '', page = 1, size = 30 } = req.query;
  const all = account ? store.getQuotaLog(account, 500) : (store.getQuotaLog('', 0) || []);
  const p = Math.max(1, parseInt(page, 10) || 1);
  const s = Math.min(200, parseInt(size, 10) || 30);
  res.json({ total: all.length, page: p, size: s, list: all.slice((p - 1) * s, p * s) });
});

/* ============================================================
 * 家庭共享（付费增值模块 · 1 户主 + 最多 5 成员）
 * ============================================================ */

/** 家庭模块信息（前端展示规则） */
app.get('/api/family/info', (req, res) => {
  const cfg = store.settings.family || {};
  const u = currentUser(req);
  const fam = u ? store.findFamilyOf(u.account) : null;
  const role = fam && u
    ? (fam.owner === u.account ? 'owner'
      : ((fam.members || []).find((x) => x.account === u.account) || {}).role || 'member')
    : null;
  res.json({
    enabled: cfg.enabled !== false,
    requireVip: cfg.requireVip !== false,
    maxMembers: cfg.maxMembers || 5,
    allowLeave: cfg.allowLeave !== false,
    shareVip: cfg.shareVip !== false,
    // 并发流 / 设备 / 额度池 / 邀请 / 分级
    maxStreams: cfg.maxStreams === undefined ? 2 : cfg.maxStreams,
    deviceLimit: cfg.deviceLimit === undefined ? 3 : cfg.deviceLimit,
    streamPolicy: cfg.streamPolicy || 'replace',
    shareQuota: cfg.shareQuota !== false,
    familyQuotaPool: cfg.familyQuotaPool === undefined ? 100 : cfg.familyQuotaPool,
    inviteTtlDays: cfg.inviteTtlDays || 3,
    inviteRole: cfg.inviteRole || 'member',
    autoApprove: !!cfg.autoApprove,
    parentalEnabled: cfg.parentalEnabled !== false,
    childMaxRating: cfg.childMaxRating || 'PG13',
    roles: FAMILY_ROLES.filter((r) => r !== 'owner').map((r) => ({
      id: r, name: FAMILY_ROLE_NAME[r], perms: familyPerms(r),
    })),
    family: fam ? familyView(fam, u) : null,
    role,
    perms: role ? familyPerms(role) : null,
  });
});

/** 家庭视图（脱敏） */
function familyView(fam, me) {
  const owner = store.findUser(fam.owner);
  const ownerAcc = owner ? owner.account : fam.owner;
  const members = (fam.members || []).map((m) => {
    const u = store.findUser(m.account);
    const role = FAMILY_ROLES.includes(m.role) ? m.role : 'member';
    return {
      account: m.account,
      nickname: u ? u.nickname || u.account : m.account,
      avatar: u ? u.avatar : '',
      joinedAt: m.joinedAt,
      role,
      roleName: FAMILY_ROLE_NAME[role] || '成员',
      pending: !!m.pending,
      isOwner: false,
      devices: (m.devices || []).map((d) => ({ id: d.id, name: d.name, lastAt: d.lastAt })),
      deviceCount: (m.devices || []).length,
    };
  });
  const active = members.filter((m) => !m.pending);
  const cfg = store.settings.family || {};
  const role = me ? (fam.owner === me.account ? 'owner'
    : ((fam.members || []).find((x) => x.account === me.account) || {}).role || 'member') : null;
  return {
    id: fam.id,
    name: fam.name,
    owner: ownerAcc,
    ownerNickname: owner ? owner.nickname || owner.account : fam.owner,
    ownerAvatar: owner ? owner.avatar : '',
    ownerVip: owner ? isVip(owner) : false,
    members,
    count: active.length,
    pending: members.filter((m) => m.pending).length,
    maxMembers: cfg.maxMembers || 5,
    isOwner: me ? fam.owner === me.account : false,
    role,
    roleName: FAMILY_ROLE_NAME[role] || null,
    perms: role ? familyPerms(role) : null,
    createdAt: fam.createdAt,
    // 额度池
    quotaPool: Number(fam.quotaPool) || 0,
    poolUsed: Number(fam.poolUsed) || 0,
    poolRemain: (Number(fam.quotaPool) || 0) === -1
      ? -1 : Math.max(0, (Number(fam.quotaPool) || 0) - (Number(fam.poolUsed) || 0)),
    maxStreams: cfg.maxStreams === undefined ? 2 : cfg.maxStreams,
    deviceLimit: cfg.deviceLimit === undefined ? 3 : cfg.deviceLimit,
  };
}

/** 角色能力（对标 Jellyfin/Emby 用户权限矩阵） */
function familyPerms(role) {
  const base = FAMILY_ROLE_PERMS[role] || FAMILY_ROLE_PERMS.member;
  const cfg = store.settings.family || {};
  const out = { ...base };
  if (role === 'child' || role === 'guest') {
    if (cfg.childBlockVip !== false) { out.hd = false; out.download = false; }
    if (cfg.childBlockComment !== false) out.comment = false;
  }
  return out;
}

/** 判断会员是否有效（家庭共享时成员也算） */
function isVip(u) {
  if (!u) return false;
  if (isAdminAccount(u.account)) return true;      // 管理员默认终身会员
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

/** 生成邀请码（支持指定角色 / 可用次数 / 备注） */
app.post('/api/family/invite', (req, res) => {
  const cfg = store.settings.family || {};
  if (cfg.enabled === false) return res.status(403).json({ error: '家庭功能未开启' });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  const meRole = fam.owner === u.account ? 'owner'
    : ((fam.members || []).find((x) => x.account === u.account) || {}).role;
  if (!familyPerms(meRole).invite) return res.status(403).json({ error: '只有户主或家庭管理员可以邀请成员' });
  const max = cfg.maxMembers || 5;
  const activeCount = (fam.members || []).filter((m) => !m.pending).length;
  if (activeCount >= max) return res.status(400).json({ error: `成员已满（最多 ${max} 人）` });

  const b = req.body || {};
  const days = Math.max(1, Math.min(30, parseInt(b.days || cfg.inviteTtlDays || 3, 10) || 3));
  const role = FAMILY_ROLES.includes(b.role) && b.role !== 'owner' ? b.role : (cfg.inviteRole || 'member');
  const maxUses = Math.max(1, Math.min(50, parseInt(b.maxUses, 10) || 1));
  const inv = store.createInvite(fam.id, u.account, days * 86400000, role, {
    maxUses, note: b.note,
  });
  res.json({ ok: true, code: inv.code, expire: inv.expire, role: inv.role,
    roleName: FAMILY_ROLE_NAME[inv.role], maxUses: inv.maxUses, url: '/#/join?code=' + inv.code });
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
    .map((i) => ({
      code: i.code, expire: i.expire, createdAt: i.createdAt,
      role: i.role || 'member', roleName: FAMILY_ROLE_NAME[i.role || 'member'] || '成员',
      maxUses: i.maxUses || 1, usedCount: i.usedCount || 0, note: i.note || '',
      url: '/#/join?code=' + i.code,
    }))
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
  const role = inv.role || 'member';
  const cfg = store.settings.family || {};
  res.json({
    familyName: fam.name,
    ownerNickname: owner ? owner.nickname || owner.account : fam.owner,
    ownerAvatar: owner ? owner.avatar : '',
    count: (fam.members || []).filter((m) => !m.pending).length,
    maxMembers: cfg.maxMembers || 5,
    role,
    roleName: FAMILY_ROLE_NAME[role] || '成员',
    perms: familyPerms(role),
    maxUses: inv.maxUses || 1,
    usedCount: inv.usedCount || 0,
    note: inv.note || '',
    autoApprove: !!cfg.autoApprove,
  });
});

/** 通过邀请码加入家庭（支持自动通过 / 待审核） */
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
  if ((Number(inv.usedCount) || 0) >= (inv.maxUses || 1)) return res.status(410).json({ error: '邀请码使用次数已用尽' });

  const fam = store.getFamily(inv.familyId);
  if (!fam) return res.status(404).json({ error: '家庭不存在' });
  if (fam.owner === u.account) return res.status(400).json({ error: '你是该家庭的户主' });
  const existing = store.findFamilyOf(u.account);
  if (existing) {
    if (existing.id === fam.id) return res.status(400).json({ error: '你已在该家庭中' });
    return res.status(409).json({ error: '你已加入其它家庭，请先退出' });
  }

  const pending = cfg.autoApprove === false;   // autoApprove 关闭 → 待户主审核
  const r = pending
    ? store.addPendingMember(fam.id, u.account, inv.role)
    : store.addFamilyMember(fam.id, u.account, inv.role);
  if (r.error) return res.status(400).json({ error: r.error });
  store.consumeInvite(code);

  // 记录本次加入的设备
  const devId = String((req.body && req.body.deviceId) || req.headers['x-device-id'] || '').slice(0, 64);
  if (devId && !pending) {
    store.touchDevice(fam.id, u.account, devId, (req.body && req.body.deviceName) || '');
  }
  res.json({
    ok: true, pending,
    message: pending ? '已提交加入申请，等待户主审核' : '已加入家庭',
    family: familyView(store.getFamily(fam.id), u),
  });
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

/* ---------------- 家庭 · 角色 / 审核 / 设备 / 额度池 ---------------- */

/** 当前用户在该家庭的角色（helper） */
function myFamilyRole(fam, account) {
  if (!fam) return null;
  if (fam.owner === account) return 'owner';
  return ((fam.members || []).find((m) => m.account === account) || {}).role || null;
}
function canManage(fam, account) {
  return !!familyPerms(myFamilyRole(fam, account) || '').manage;
}

/** 修改成员角色（户主 / 家庭管理员） */
app.put('/api/family/member/:account/role', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  if (!canManage(fam, u.account)) return res.status(403).json({ error: '只有户主或家庭管理员可以调整角色' });
  const target = req.params.account;
  if (target === fam.owner) return res.status(400).json({ error: '不能修改户主角色' });
  const role = String((req.body && req.body.role) || '');
  if (!FAMILY_ROLES.includes(role) || role === 'owner') return res.status(400).json({ error: '无效的角色' });
  if (role === 'admin' && myFamilyRole(fam, u.account) !== 'owner') {
    return res.status(403).json({ error: '只有户主可以设置家庭管理员' });
  }
  store.setFamilyRole(fam.id, target, role);
  res.json({ ok: true, family: familyView(store.getFamily(fam.id), u) });
});

/** 审核通过待加入成员 */
app.post('/api/family/member/:account/approve', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  if (!canManage(fam, u.account)) return res.status(403).json({ error: '无权审核' });
  const max = (store.settings.family && store.settings.family.maxMembers) || 5;
  const activeCount = (fam.members || []).filter((m) => !m.pending).length;
  if (activeCount >= max) return res.status(400).json({ error: `成员已满（最多 ${max} 人）` });
  store.approveFamilyMember(fam.id, req.params.account);
  res.json({ ok: true, family: familyView(store.getFamily(fam.id), u) });
});

/** 设备列表（自己 / 户主看全部） */
app.get('/api/family/devices', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.json({ devices: [] });
  const isMgr = canManage(fam, u.account);
  const devices = [];
  for (const m of (fam.members || [])) {
    if (!isMgr && m.account !== u.account) continue;
    for (const d of (m.devices || [])) {
      devices.push({ account: m.account, deviceId: d.id, name: d.name, lastAt: d.lastAt });
    }
  }
  devices.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  res.json({ devices, deviceLimit: (store.settings.family || {}).deviceLimit || 3, canManage: isMgr });
});

/** 设备登记 / 心跳（前端播放时调用，实现"设备数限制"） */
app.post('/api/family/device', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.json({ ok: true, noFamily: true });
  const cfg = store.settings.family || {};
  const limit = cfg.deviceLimit === undefined ? 3 : Number(cfg.deviceLimit);
  const deviceId = String((req.body && req.body.deviceId) || '').slice(0, 64);
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const m = (fam.members || []).find((x) => x.account === u.account);
  const existing = ((m && m.devices) || []).map((d) => d.id);
  if (fam.owner !== u.account && limit > 0 && !existing.includes(deviceId) && existing.length >= limit) {
    return res.status(403).json({
      error: `设备数已达上限（最多 ${limit} 台）`, needDevice: true, deviceLimit: limit,
      devices: (m.devices || []).map((d) => ({ id: d.id, name: d.name, lastAt: d.lastAt })),
    });
  }
  store.touchDevice(fam.id, u.account, deviceId, (req.body && req.body.name) || '');
  res.json({ ok: true, deviceLimit: limit });
});

/** 移除设备 */
app.delete('/api/family/device/:deviceId', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  const targetAcc = String(req.query.account || u.account);
  if (targetAcc !== u.account && !canManage(fam, u.account)) {
    return res.status(403).json({ error: '无权移除他人设备' });
  }
  const m = (fam.members || []).find((x) => x.account === targetAcc);
  if (m) {
    m.devices = (m.devices || []).filter((d) => d.id !== req.params.deviceId);
    store.updateFamily(fam.id, { members: fam.members });
  }
  res.json({ ok: true });
});

/** 家庭额度池：查看 / 充值（户主） */
app.get('/api/family/quota', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.json({ pool: 0, used: 0, remain: 0 });
  const pool = Number(fam.quotaPool) || 0;
  const used = Number(fam.poolUsed) || 0;
  res.json({
    pool, used, remain: pool === -1 ? -1 : Math.max(0, pool - used),
    canRefill: fam.owner === u.account,
    shareQuota: (store.settings.family || {}).shareQuota !== false,
  });
});

/** 重置额度池用量 / 调整池上限 */
app.put('/api/family/quota', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  const fam = store.findFamilyOf(u.account);
  if (!fam) return res.status(404).json({ error: '你还没有家庭' });
  if (fam.owner !== u.account) return res.status(403).json({ error: '只有户主可以调整家庭额度池' });
  const b = req.body || {};
  if (b.reset) {
    fam.poolUsed = 0;
    store.updateFamily(fam.id, { poolUsed: 0 });
  }
  if (b.amount !== undefined) {
    const amt = Math.trunc(Number(b.amount) || 0);
    if (b.mode === 'delta') store.refillFamilyQuota(fam.id, amt);
    else {
      if (amt < -1) return res.status(400).json({ error: '池上限不能小于 -1（-1 表示无限）' });
      store.updateFamily(fam.id, { quotaPool: amt });
    }
  }
  const f2 = store.getFamily(fam.id);
  const pool = Number(f2.quotaPool) || 0;
  const used = Number(f2.poolUsed) || 0;
  res.json({ ok: true, pool, used, remain: pool === -1 ? -1 : Math.max(0, pool - used) });
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
 * 短视频（用户发布 · 抖音式）
 * ============================================================
 * 上传安全：七层纵深防御（详见 lib/upload.js）
 *   L1 体积限制 → L2 扩展名白名单 → L3 文件名消毒 → L4 魔数校验
 *   → L5 容器结构校验 → L6 ffprobe 真实探测 → L7 隔离存储
 */

/** 登录态中间件（普通用户）：未登录返回 401 */
function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  req.user = u;
  next();
}

/** 短视频视图（脱敏 + 补齐字段） */
function shortView(s, viewer) {
  return {
    id: s.id,
    account: s.account,
    author: s.author || s.account,
    authorAvatar: s.authorAvatar || '',
    title: s.title || '',
    desc: s.desc || '',
    cover: s.cover || '',
    tags: s.tags || [],
    duration: s.duration || 0,
    width: s.width || 0,
    height: s.height || 0,
    size: s.size || 0,
    views: s.views || 0,
    likes: (s.likes || []).length,
    liked: viewer ? (s.likes || []).includes(viewer) : false,
    comments: store.getComments().filter((c) => c.targetId === 'short:' + s.id && c.status !== 'deleted').length,
    status: s.status || 'pending',
    createdAt: s.createdAt,
    // 播放地址（走统一代理，支持 Range）
    src: `/api/shorts/${s.id}/video`,
  };
}

/**
 * 上传短视频
 * POST /api/shorts/upload  (multipart/form-data)
 * fields: video(文件), title, desc, tags, cover
 *
 * 安全说明：全程流式落盘到临时目录 → 七层校验 → 校验通过才移入正式目录。
 */
app.post(
  '/api/shorts/upload',
  requireUser,
  (req, res, next) => {
    // 独立限流：每用户每小时最多 20 次上传
    const rl = security.rateLimit('upload:' + (req.user && req.user.account), { window: 3600 * 1000, max: 20 });
    if (!rl.ok) return res.status(429).json({ error: '上传过于频繁，请稍后再试', retryAfter: rl.retryAfter });
    next();
  },
  async (req, res) => {
    const upload = require('./lib/upload');
    await upload.ensureDirs();

    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('multipart/form-data')) {
      return res.status(400).json({ error: '请使用 multipart/form-data 上传' });
    }
    const boundary = '--' + ct.split('boundary=')[1];
    if (!boundary || boundary === '--undefined') return res.status(400).json({ error: '缺少 multipart boundary' });

    let tmpPath = null;
    try {
      const r = await receiveMultipart(req, upload, boundary);
      tmpPath = r.tmpPath;

      // 字段校验
      const title = String(r.fields.title || '').trim().slice(0, 80);
      const desc = String(r.fields.desc || '').trim().slice(0, 500);
      const tags = String(r.fields.tags || '')
        .split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
      if (!title) throw new UploadError('请填写视频标题');
      if (!r.file) throw new UploadError('未收到视频文件');

      // —— 七层安全校验 ——
      const v = await upload.validateUpload({
        path: tmpPath,
        size: r.file.size,
        originalname: r.file.filename,
        mimetype: r.file.contentType,
      });
      if (!v.ok) throw new UploadError(v.reason || '文件校验未通过');

      // 落盘（隔离存储 + 随机文件名）
      const ext = upload.extOf(r.file.filename) || 'mp4';
      const c = await upload.commitFile(tmpPath, ext);
      if (!c.ok) throw new UploadError(c.reason || '保存失败');
      tmpPath = null; // 已移走，勿再删

      const info = v.info || {};
      const id = 'sh_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
      const autoPublish = store.settings.community && store.settings.community.shortAutoPublish !== false;
      const item = {
        id,
        account: req.user.account,
        author: req.user.nickname || req.user.account,
        authorAvatar: req.user.avatar || '',
        title, desc, tags,
        cover: String(r.fields.cover || '').slice(0, 500),
        file: c.filename,
        duration: info.duration || 0,
        width: info.width || 0,
        height: info.height || 0,
        size: info.size || r.file.size,
        videoCodec: info.videoCodec || '',
        audioCodec: info.audioCodec || '',
        views: 0,
        likes: [],
        status: autoPublish ? 'published' : 'pending',
        createdAt: Date.now(),
      };
      store.upsertShort(item);
      res.json({ ok: true, short: shortView(item, req.user.account), pending: !autoPublish });
    } catch (e) {
      if (tmpPath) await upload.removeQuiet(tmpPath);
      const code = e instanceof UploadError ? 400 : 500;
      res.status(code).json({ error: e.message || '上传失败' });
    }
  }
);

class UploadError extends Error {}

/**
 * 极简 multipart/form-data 解析（零依赖）。
 * 安全要点：
 *   · 边收边写盘，累计超 MAX_SIZE 立即 413，防内存/磁盘 DoS
 *   · 只保存第一个文件的字节流到随机临时名
 *   · 表单字段限长，防止超长字段撑爆内存
 */
function receiveMultipart(req, upload, boundary) {
  return new Promise((resolve, reject) => {
    const bufBoundary = Buffer.from(boundary);
    let buf = Buffer.alloc(0);
    const fields = {};
    let file = null;
    let tmpPath = null;
    let ws = null;
    let written = 0;
    let state = 'preamble'; // preamble | headers | body
    let curName = '';
    let curFilename = '';
    let curCT = '';
    let done = false;

    const finish = async () => {
      if (done) return;
      done = true;
      if (ws) await new Promise((r) => ws.end(r));
      resolve({ fields, file, tmpPath });
    };

    const fail = async (err) => {
      if (done) return;
      done = true;
      try { if (ws) ws.destroy(); } catch {}
      if (tmpPath) await upload.removeQuiet(tmpPath);
      reject(err);
    };

    req.on('data', (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);

      // 超限保护（整体请求）
      if (buf.length > upload.MAX_SIZE + 8 * 1024 * 1024) {
        return fail(new UploadError(`文件超过上限 ${(upload.MAX_SIZE / 1048576).toFixed(0)}MB`));
      }

      // 循环解析
      for (;;) {
        if (state === 'preamble') {
          const i = buf.indexOf(bufBoundary);
          if (i < 0) { if (buf.length > bufBoundary.length) buf = buf.slice(-bufBoundary.length); return; }
          buf = buf.slice(i + bufBoundary.length);
          if (buf.slice(0, 2).toString() === '--') return finish();
          if (buf.slice(0, 2).toString() === '\r\n') buf = buf.slice(2);
          state = 'headers';
          continue;
        }
        if (state === 'headers') {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) { if (buf.length > 64 * 1024) return fail(new UploadError('表单头异常')); return; }
          const head = buf.slice(0, i).toString('utf8');
          buf = buf.slice(i + 4);
          const nm = /name="([^"]*)"/i.exec(head);
          const fn = /filename="([^"]*)"/i.exec(head);
          const ct2 = /Content-Type:\s*([^\r\n]+)/i.exec(head);
          curName = nm ? nm[1] : '';
          curFilename = fn ? fn[1] : '';
          curCT = ct2 ? ct2[1].trim() : '';
          if (curFilename) {
            if (file) { return fail(new UploadError('一次只能上传一个视频文件')); }
            file = { filename: curFilename, contentType: curCT, size: 0 };
            tmpPath = path.join(upload.TMP_DIR, 'up_' + crypto.randomBytes(10).toString('hex') + '.part');
            ws = fs.createWriteStream(tmpPath);
            ws.on('error', (e) => fail(new UploadError('写入临时文件失败：' + e.message.slice(0, 80))));
            written = 0;
          }
          state = 'body';
          continue;
        }
        if (state === 'body') {
          const i = buf.indexOf(bufBoundary);
          if (i < 0) {
            // 保守：留出 boundary 长度 + 4 防跨块
            const safe = Math.max(0, buf.length - bufBoundary.length - 4);
            if (safe > 0) {
              const piece = buf.slice(0, safe);
              if (ws) { written += piece.length; if (written > upload.MAX_SIZE) return fail(new UploadError(`文件超过上限 ${(upload.MAX_SIZE / 1048576).toFixed(0)}MB`)); ws.write(piece); }
              else if (Object.keys(fields).length === 0 || curName) {
                fields[curName] = (fields[curName] || '') + piece.toString('utf8');
                if (fields[curName].length > 100000) return fail(new UploadError('表单字段过长'));
              }
              buf = buf.slice(safe);
            }
            return;
          }
          const piece = buf.slice(0, i);
          // 去掉尾部 CRLF
          const clean = piece.length >= 2 && piece.slice(-2).toString() === '\r\n' ? piece.slice(0, -2) : piece;
          if (ws) { written += clean.length; if (written > upload.MAX_SIZE) return fail(new UploadError(`文件超过上限 ${(upload.MAX_SIZE / 1048576).toFixed(0)}MB`)); ws.write(clean); }
          else {
            fields[curName] = (fields[curName] || '') + clean.toString('utf8');
            if (fields[curName].length > 100000) return fail(new UploadError('表单字段过长'));
          }
          buf = buf.slice(i + bufBoundary.length);
          if (ws) {
            file.size = written;
            ws.end();
            ws = null;
          }
          if (buf.slice(0, 2).toString() === '--') return finish();
          if (buf.slice(0, 2).toString() === '\r\n') buf = buf.slice(2);
          state = 'headers';
          continue;
        }
        return;
      }
    });
    req.on('end', () => { if (!done) finish(); });
    req.on('error', (e) => fail(e));
  });
}

/** 视频播放（支持 Range，鉴权后放行；仅限已发布或作者本人/管理员） */
app.get('/api/shorts/:id/video', async (req, res) => {
  const upload = require('./lib/upload');
  const s = store.findShort(req.params.id);
  if (!s) return res.status(404).send('not found');
  const me = currentUser(req);
  const isOwner = me && me.account === s.account;
  const isAdminReq = !!(req.admin);
  if ((s.status || 'pending') !== 'published' && !isOwner && !isAdminReq) {
    return res.status(403).send('forbidden');
  }
  const full = upload.resolveStored(s.file);
  if (!full) return res.status(404).send('bad file');
  let st;
  try { st = fs.statSync(full); } catch { return res.status(404).send('missing'); }

  // 防盗链 + 不可执行
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= st.size) end = st.size - 1;
    if (start > end) return res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end();
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(full, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(full).pipe(res);
  }
});

/** 短视频信息流（分页 + 排序） */
app.get('/api/shorts', (req, res) => {
  const { sort = 'new', page = 1, size = 12, account = '', keyword = '' } = req.query;
  const me = currentUser(req);
  const canAdmin = !!req.admin;
  let list = store.getShorts({ account, keyword }).filter(
    (s) => (s.status || 'pending') === 'published' || (me && me.account === s.account) || canAdmin
  );
  if (sort === 'hot') list = list.slice().sort((a, b) => (b.views || 0) - (a.views || 0));
  else if (sort === 'like') list = list.slice().sort((a, b) => (b.likes || []).length - (a.likes || []).length);
  else list = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const p = Math.max(1, parseInt(page, 10) || 1);
  const sz = Math.min(50, Math.max(1, parseInt(size, 10) || 12));
  const total = list.length;
  const items = list.slice((p - 1) * sz, p * sz).map((s) => shortView(s, me && me.account));
  res.json({ list: items, total, page: p, size: sz, hasMore: p * sz < total });
});

/** 单个短视频详情 */
app.get('/api/shorts/:id', (req, res) => {
  const s = store.findShort(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const me = currentUser(req);
  if ((s.status || 'pending') !== 'published' && !(me && me.account === s.account) && !req.admin) {
    return res.status(403).json({ error: 'forbidden' });
  }
  store.bumpShortView(s.id);
  res.json({ short: shortView(store.findShort(s.id), me && me.account) });
});

/** 点赞 / 取消点赞 */
app.post('/api/shorts/:id/like', requireUser, (req, res) => {
  const r = store.toggleShortLike(req.params.id, req.user.account);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

/** 删除自己的视频（管理员可删任意） */
app.delete('/api/shorts/:id', requireUser, (req, res) => {
  const s = store.findShort(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const isOwner = s.account === req.user.account;
  if (!isOwner && !req.admin) return res.status(403).json({ error: '无权删除' });
  const upload = require('./lib/upload');
  const full = upload.resolveStored(s.file);
  if (full) upload.removeQuiet(full);
  store.deleteShort(req.params.id);
  res.json({ ok: true });
});

/* ---------- 后台：短视频审核 ---------- */
app.get('/api/admin/shorts', requireAdmin, (req, res) => {
  const { status = '', keyword = '', page = 1, size = 20 } = req.query;
  let list = store.getShorts({ status: status || undefined, keyword });
  list = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const p = Math.max(1, parseInt(page, 10) || 1);
  const sz = Math.min(100, Math.max(1, parseInt(size, 10) || 20));
  const total = list.length;
  res.json({
    total, page: p, size: sz,
    list: list.slice((p - 1) * sz, p * sz).map((s) => shortView(s, null)),
  });
});

app.put('/api/admin/shorts/:id', requireAdmin, (req, res) => {
  const s = store.findShort(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { status, title } = req.body || {};
  if (status && ['published', 'pending', 'rejected'].includes(status)) s.status = status;
  if (title !== undefined) s.title = String(title).slice(0, 80);
  store.upsertShort(s);
  res.json({ ok: true });
});

app.delete('/api/admin/shorts/:id', requireAdmin, (req, res) => {
  const s = store.findShort(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const upload = require('./lib/upload');
  const full = upload.resolveStored(s.file);
  if (full) upload.removeQuiet(full);
  store.deleteShort(req.params.id);
  res.json({ ok: true });
});

/* ============================================================
 * 追剧（收藏订阅 + 更新追踪）
 * ============================================================ */
/** 我的追剧列表 */
/* ============================================================
 * API：社交 —— 加好友 / 私信
 * ============================================================ */
const SOCIAL_ENABLED = () => {
  const c = store.settings.community || {};
  return c.enabled !== false && c.socialEnabled !== false; // 后台可关闭社交
};

/** 统一校验：社交开关 + 登录 */
function requireSocial(req, res, next) {
  if (!SOCIAL_ENABLED()) return res.status(403).json({ error: '本站已关闭社交功能' });
  requireUser(req, res, next);
}

/** 用户公开信息（脱敏，不含邮箱/密码等） */
function publicUser(acc) {
  const u = store.findUser(acc);
  if (!u) return { account: acc, nickname: acc, avatar: '' };
  return {
    account: u.account,
    nickname: u.nickname || u.account,
    avatar: u.avatar || '',
    vip: !!(u.vip && u.vip.expire > Date.now()),
    createdAt: u.createdAt || 0,
  };
}

/** 社交总览：好友数 + 未读私信数（用于顶栏红点） */
app.get('/api/social/summary', requireSocial, (req, res) => {
  const me = req.user.account;
  res.json({
    friends: store.listFriends(me).length,
    requests: store.listFriendRequests(me).length,
    unread: store.unreadCount(me),
    enabled: true,
  });
});

/** 搜索用户（加好友用） */
app.get('/api/social/search', requireSocial, (req, res) => {
  const kw = req.query.q || '';
  const list = store.searchUsers(kw, { exclude: req.user.account });
  // 标注与我的关系，便于前端直接渲染按钮状态
  res.json({
    list: list.map((u) => {
      const f = store.findFriendship(req.user.account, u.account);
      return {
        ...u,
        relation: !f ? 'none' : f.status === 'accepted' ? 'friend' : (f.from === req.user.account ? 'sent' : 'received'),
      };
    }),
  });
});

/** 好友列表（含在线状态） */
app.get('/api/social/friends', requireSocial, (req, res) => {
  const me = req.user.account;
  const list = store.listFriends(me).map((acc) => {
    const u = publicUser(acc);
    const conv = store.convId(me, acc);
    return { ...u, online: !!chat.online(conv), unread: store.unreadCount(acc) >= 0 ? countUnreadFrom(me, acc) : 0 };
  });
  res.json({ list });
});

/** 计算「我收到的、来自某人的未读数」 */
function countUnreadFrom(me, other) {
  const meL = String(me).toLowerCase();
  const conv = store.convId(me, other);
  return store.listMessages(me, other, { limit: 100000 }).filter((m) => m.conv === conv && m.to === meL && !m.read).length;
}

/** 待处理的好友申请 */
app.get('/api/social/requests', requireSocial, (req, res) => {
  const me = req.user.account;
  res.json({
    received: store.listFriendRequests(me).map((f) => ({ ...publicUser(f.a === me ? f.b : f.a), from: f.from, at: f.createdAt })),
    sent: store.listSentRequests(me).map((f) => ({ ...publicUser(f.a === me ? f.b : f.a), at: f.createdAt })),
  });
});

/** 发起好友申请 */
app.post('/api/social/request', requireSocial, (req, res) => {
  const me = req.user.account;
  const to = String((req.body && req.body.account) || '').toLowerCase();
  if (!to) return res.status(400).json({ error: '缺少账号' });
  if (to === me) return res.status(400).json({ error: '不能添加自己为好友' });
  if (!store.findUser(to)) return res.status(404).json({ error: '该用户不存在' });

  const r = store.requestFriend(me, to);
  if (!r.ok) return res.status(400).json({ error: r.reason === 'self' ? '不能添加自己' : '操作失败' });
  const msg = r.status === 'accepted' ? '你们已成为好友' : '好友申请已发送';
  res.json({ ok: true, status: r.status, message: msg });
});

/** 接受好友申请 */
app.post('/api/social/accept', requireSocial, (req, res) => {
  const me = req.user.account;
  const other = String((req.body && req.body.account) || '').toLowerCase();
  const r = store.acceptFriend(me, other);
  if (!r.ok) return res.status(400).json({ error: r.reason === 'cannot_accept_own' ? '不能接受自己发出的申请' : '申请不存在' });
  res.json({ ok: true, status: 'accepted', message: '已添加为好友' });
});

/** 删除好友 / 拒绝申请 / 撤回申请 */
app.post('/api/social/remove', requireSocial, (req, res) => {
  const me = req.user.account;
  const other = String((req.body && req.body.account) || '').toLowerCase();
  store.removeFriend(me, other);
  res.json({ ok: true, message: '已解除好友关系' });
});

/** 会话列表（私信首页） */
app.get('/api/social/conversations', requireSocial, (req, res) => {
  const list = store.listConversations(req.user.account).map((c) => ({
    ...c,
    online: !!chat.online(store.convId(req.user.account, c.account)),
  }));
  res.json({ list, totalUnread: store.unreadCount(req.user.account) });
});

/** 拉取与某人的聊天记录 */
app.get('/api/social/messages/:account', requireSocial, (req, res) => {
  const me = req.user.account;
  const other = String(req.params.account || '').toLowerCase();
  if (!store.findFriendship(me, other) || store.findFriendship(me, other).status !== 'accepted') {
    return res.status(403).json({ error: '你们还不是好友' });
  }
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
  const list = store.listMessages(me, other, { limit });
  // 打开会话即标记已读
  store.readMessages(me, other);
  res.json({ list, peer: publicUser(other) });
});

/** 发送私信 */
app.post('/api/social/messages', requireSocial, (req, res) => {
  const me = req.user.account;
  const to = String((req.body && req.body.to) || '').toLowerCase();
  const text = String((req.body && req.body.text) || '').trim();
  if (!to) return res.status(400).json({ error: '缺少收信人' });
  if (!text) return res.status(400).json({ error: '消息不能为空' });
  if (text.length > 2000) return res.status(400).json({ error: '消息过长（最多 2000 字）' });

  const f = store.findFriendship(me, to);
  if (!f || f.status !== 'accepted') return res.status(403).json({ error: '仅好友之间可发送私信' });

  // 限流：每分钟最多 30 条，防刷屏
  const rl = security.rateLimit('msg:' + me, { window: 60 * 1000, max: 30 });
  if (!rl.ok) return res.status(429).json({ error: '发送过快，请稍后再试' });

  const rec = store.sendMessage(me, to, text);
  res.json({ ok: true, message: rec });
});

/** 未读私信数（轮询用，轻量） */
app.get('/api/social/unread', requireSocial, (req, res) => {
  res.json({ unread: store.unreadCount(req.user.account) });
});

app.get('/api/follows', requireUser, (req, res) => {
  res.json({ list: store.getFollows(req.user.account) });
});

/** 是否已追（单项查询） */
app.get('/api/follows/check', requireUser, (req, res) => {
  const { type, targetId } = req.query;
  const f = store.findFollow(req.user.account, type, targetId);
  res.json({ following: !!f, item: f || null });
});

/** 追 / 取关 */
app.post('/api/follows/toggle', requireUser, (req, res) => {
  const { type, targetId, title = '', cover = '', note = '', lastEp = '' } = req.body || {};
  if (!type || !targetId) return res.status(400).json({ error: '缺少参数' });
  const r = store.toggleFollow(req.user.account, {
    type: String(type).slice(0, 20),
    targetId: String(targetId).slice(0, 80),
    title: String(title).slice(0, 100),
    cover: String(cover).slice(0, 500),
    note: String(note).slice(0, 200),
    lastEp: String(lastEp).slice(0, 40),
  });
  res.json(r);
});

/** 更新追剧进度 */
app.post('/api/follows/progress', requireUser, (req, res) => {
  const { type, targetId, lastEp = '' } = req.body || {};
  const f = store.touchFollow(req.user.account, type, targetId, { lastEp: String(lastEp).slice(0, 40) });
  res.json({ ok: !!f, item: f || null });
});

/* ============================================================
 * 静态资源
 * ============================================================ */
app.use(
  '/hls',
  express.static(path.join(__dirname, 'node_modules', 'hls.js', 'dist'), { maxAge: '7d' })
);
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  etag: true,
  lastModified: true,
  // 前端资源变更靠 ETag 协商（max-age=0 + 304）不可靠且每次全量校验，
  // 改为短缓存：JS/CSS 1 小时强缓存，命中即 0 请求；带 ?v= 版本号时更久
  setHeaders: (res, filePath, stat) => {
    if (/\.(js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else if (/\.html?$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

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
    warmupLive();
  });
}

/**
 * 直播源后台预热
 * ------------------------------------------------------------
 * 冷启动时首次访问某频道要实时探测候选源（实测可达 6s+），
 * 用户在页面就会干等。这里在服务启动后于后台静默预热全部频道，
 * 等用户点进来时已命中缓存 → 毫秒级出流。
 * 全程静默，失败不影响主流程；错峰执行，避免瞬间打满上游。
 */
function warmupLive() {
  const chs = (store.liveChannels || []).map((c) => c.id).filter(Boolean);
  if (!chs.length) return;
  const CONCURRENCY = 3;
  let idx = 0;
  let done = 0;

  const next = () => {
    if (idx >= chs.length) {
      console.log(`  [预热] 直播源就绪：${done}/${chs.length} 个频道`);
      return;
    }
    const ch = chs[idx++];
    cctv.getLive(ch)
      .then(() => { done++; })
      .catch(() => {})
      .finally(() => setTimeout(next, 400)); // 错峰，别把上游打满
  };
  for (let i = 0; i < CONCURRENCY; i++) next();
}

module.exports = app;
