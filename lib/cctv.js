'use strict';
/**
 * 慈云影视 - 央视公开接口客户端
 * ============================================================
 * 数据来源均为央视网(cctv.com)对外公开的 HTTP 接口，仅作聚合展示用途。
 * 本模块统一封装：请求头伪装、超时控制、自动重试、结果缓存、失败降级、
 * 多协议/多编码兼容（http/https、gzip/deflate/br、json/jsonp/xml/html）。
 *
 * 已知可用接口：
 *  1. 栏目视频列表 : api.cntv.cn/NewVideo/getVideoListByColumn?id={ctid}&n=&p=&mode=0&serviceId=tvcctv
 *  2. 专辑视频列表 : api.cntv.cn/NewVideo/getVideoListByAlbumIdNew?id={aid}&n=&p=&mode=0&pub=1&serviceId=tvcctv
 *  3. 视频取流     : vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid={guid}   -> hls_url / chapters
 *  4. 栏目页信息   : tv.cctv.com/lm/{code}/index.shtml                     -> 提取 TOPC ctid
 *  5. 节目单(EPG)  : api.cntv.cn/epg/getEpgInfoByChannelNew?c={ch}&serviceId=tvcctv&d=&t=json
 *  6. 直播流       : vdn.live.cntv.cn/api2/live.do?channel=pa://cctv_p2p_hd{ch}&client=flash
 *  7. 搜索         : search.cctv.com/search.php?qtext=&type=video&page=
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://tv.cctv.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: '*/*',
};

/* ============================================================
 * 连接池（keep-alive）
 * ------------------------------------------------------------
 * ⚠️ 性能关键：HLS 每 2~10 秒就请求一个分片，一集 45 分钟会有几百个请求。
 *    原先每个请求都新建 TCP + TLS 连接（https 握手 2~3 个 RTT，
 *    跨境/跨网可达数百毫秒），这类「建连开销」正是播放器缓冲被吃光、
 *    表现为「看一会儿卡一下」的主因之一。
 *
 *    复用长连接后，除首个请求外其余分片直接复用已建好的连接，
 *    首字节时间(TTFB)显著下降，缓冲余量能稳住。
 * ============================================================ */
const KEEPALIVE_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 15000,   // 空闲连接保活探测间隔
  maxSockets: 64,          // 单主机并发上限
  maxFreeSockets: 16,      // 空闲连接保留数
  timeout: 60000,          // 连接整体存活上限
};
const httpAgent = new http.Agent(KEEPALIVE_OPTS);
const httpsAgent = new https.Agent(KEEPALIVE_OPTS);

const TIMEOUT = 12000;

/* ============================================================
 * 1. 基础请求层 —— 兼容 http/https、重定向、压缩、字符集
 * ============================================================ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 给 Promise 加截止时间：超时则返回 fallback，绝不无限等待。
 * 用于「可选增强」环节（如节目单）——拿不到不影响主流程，但绝不能拖垮接口。
 */
function withDeadline(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** 无依赖 HTTP 请求，返回 Buffer */
function requestBuffer(url, { headers = {}, timeout = TIMEOUT, redirects = 5, insecure = true } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + url));
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { ...DEFAULT_HEADERS, ...headers },
        agent: u.protocol === 'http:' ? httpAgent : httpsAgent,
        // 部分公开采集站证书链不完整 / 仅支持旧版 TLS，容错处理避免整体不可用
        ...(u.protocol === 'https:' && insecure
          ? {
              rejectUnauthorized: false,
              minVersion: 'TLSv1',
              secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
            }
          : {}),
      },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(
            requestBuffer(next, { headers, timeout, redirects: redirects - 1, insecure })
          );
        }
        const chunks = [];
        let stream = res;
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode} for ${url}`);
            err.statusCode = res.statusCode;
            err.body = buf.toString('utf8');
            return reject(err);
          }
          resolve({ buf, headers: res.headers, statusCode: res.statusCode });
        });
        stream.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('Request timeout: ' + url)));
    req.end();
  });
}

/**
 * 流式请求：返回可 pipe 的响应流（不整包读入内存）。
 * 用于直播分片（.ts）等大体积媒体数据 —— 边下边发，省掉一整跳延迟。
 * 返回一个 EventEmitter 风格的对象：'response' / 'error' 事件 + pipe/destroy。
 *
 * @param {string} url 目标地址
 * @param {{headers?:object,timeout?:number,redirects?:number,insecure?:boolean}} options
 */
function requestStream(url, { headers = {}, timeout = TIMEOUT, redirects = 5, insecure = true } = {}) {
  const emitter = new EventEmitter();
  let current = null;
  let destroyed = false;

  emitter.pipe = (dest) => {
    emitter._dest = dest;
    if (emitter._response) emitter._response.pipe(dest);
    return dest;
  };
  emitter.destroy = () => {
    destroyed = true;
    try { if (current) current.destroy(); } catch {}
    try { if (emitter._response) emitter._response.destroy(); } catch {}
  };

  const start = (target, left) => {
    if (destroyed) return;
    let u;
    try { u = new URL(target); } catch (e) { return emitter.emit('error', new Error('Invalid URL: ' + target)); }

    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { ...DEFAULT_HEADERS, ...headers },
        agent: u.protocol === 'http:' ? httpAgent : httpsAgent,
        ...(u.protocol === 'https:' && insecure
          ? {
              rejectUnauthorized: false,
              minVersion: 'TLSv1',
              secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
            }
          : {}),
      },
      (res) => {
        // 重定向：跟随（直播源常有 302 跳转）
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          return start(next, left - 1);
        }
        current = res;
        emitter.response = res;
        emitter._response = res;
        if (emitter._dest) res.pipe(emitter._dest);
        emitter.emit('response', res.headers);
      }
    );
    current = req;
    req.on('error', (e) => { if (!destroyed) emitter.emit('error', e); });
    req.setTimeout(timeout, () => req.destroy(new Error('Stream timeout: ' + target)));
    req.end();
  };

  start(url, redirects);
  return emitter;
}

/**
 * 将 Buffer 按目标字符集解码为字符串。
 * 兼容 UTF-8 / GBK / GB2312 / GB18030 / Big5 / latin1。
 */
function decodeBuffer(buf, contentType = '') {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  let charset = (m ? m[1] : 'utf-8').toLowerCase();
  if (/gbk|gb2312|gb18030/.test(charset)) {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      /* Node 支持 gb18030 解码 */
    }
  }
  if (/big5/.test(charset)) {
    try {
      return new TextDecoder('big5').decode(buf);
    } catch {
      /* ignore */
    }
  }
  return buf.toString('utf8');
}

/** 文本请求 */
async function requestText(url, opts = {}) {
  const { buf, headers } = await requestBuffer(url, opts);
  return decodeBuffer(buf, headers['content-type']);
}

/* ============================================================
 * 2. 多格式解析 —— JSON / JSONP / XML / HTML
 * ============================================================ */

/** 剥离 JSONP 外壳 */
function stripJsonp(txt) {
  const t = txt.trim();
  if (/^[{[]/.test(t)) return t;
  // callback({...}) / callback([...]);
  const m = /^[a-zA-Z_$][\w$.]*\s*\(([\s\S]*)\)\s*;?\s*$/.exec(t);
  return m ? m[1] : t;
}

/** 容错 JSON 解析 */
function parseJSON(txt) {
  return JSON.parse(stripJsonp(txt));
}

/** 极简 XML 解析（把 <item>..<title>x</title>..</item> 转成对象数组），够用即可 */
function parseXML(txt) {
  const items = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi;
  const blocks = txt.match(itemRe) || [];
  for (const blk of blocks) {
    const o = {};
    const fieldRe = /<([\w:]+)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = fieldRe.exec(blk))) {
      if (m[1].includes(':')) continue;
      o[m[1]] = m[2]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .trim();
    }
    if (Object.keys(o).length) items.push(o);
  }
  return items;
}

/** 通用解析：自动识别 JSON/JSONP/XML */
function parseAuto(txt) {
  const t = txt.trim();
  if (/^[{[]/.test(t) || /^[a-zA-Z_$][\w$.]*\s*\(/.test(t)) {
    try {
      return parseJSON(t);
    } catch {
      /* fallthrough */
    }
  }
  if (/^\s*</.test(t)) return { __xml: parseXML(t), __raw: t };
  return { __raw: t };
}

/**
 * 通用 GET：自动重试 + 自动解析
 */
async function fetchAny(url, { retries = 2, headers, timeout } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const txt = await requestText(url, { headers, timeout });
      return parseAuto(txt);
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(280 * (i + 1));
    }
  }
  throw lastErr;
}

/* ============================================================
 * 3. 缓存层 —— TTL 内存缓存（减小上游压力、提升稳定性）
 * ============================================================ */

const _cache = new Map();

/* ------------------------------------------------------------
 * 磁盘持久化：采集源的分类表 / 列表结果缓存到磁盘。
 * 背景：上游 ac=class 实测 1.5~3.3s/源，17 个源串行要 16s+。
 *      纯内存缓存在进程重启后全部失效，用户每次重启都要等首屏
 *      十几秒。这里把热数据落盘，重启后秒级恢复。
 * 策略：只持久化白名单前缀的 key（分类/列表这类"重"数据），
 *      写入合并节流（避免频繁写盘），过期项自动清理。
 * ------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');

const PERSIST_FILE = process.env.CACHE_FILE
  || path.join(__dirname, '..', 'data', 'cache.json');
const PERSIST_PREFIXES = ['ms-cat:', 'ms-list:'];
const PERSIST_MAX_ENTRIES = 400;

let _persistDirty = false;
let _persistTimer = null;

function shouldPersist(key) {
  return PERSIST_PREFIXES.some((p) => String(key).startsWith(p));
}

function loadPersist() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    const now = Date.now();
    let n = 0;
    for (const [k, v] of Object.entries(raw || {})) {
      if (!v || typeof v.expire !== 'number' || now > v.expire) continue;
      _cache.set(k, v);
      n++;
    }
    if (n) console.log(`[cache] 已从磁盘恢复 ${n} 条预热缓存`);
  } catch (e) {
    console.error('[cache] 磁盘缓存读取失败:', e.message);
  }
}

function savePersist() {
  _persistDirty = false;
  _persistTimer = null;
  try {
    const out = {};
    let n = 0;
    const now = Date.now();
    for (const [k, v] of _cache.entries()) {
      if (!shouldPersist(k)) continue;
      if (!v || typeof v.expire !== 'number' || now > v.expire) continue;
      out[k] = v;
      if (++n >= PERSIST_MAX_ENTRIES) break;
    }
    fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(out));
  } catch (e) {
    console.error('[cache] 磁盘缓存写入失败:', e.message);
  }
}

function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(savePersist, 4000);   // 合并写入，避免高频 IO
  if (_persistTimer.unref) _persistTimer.unref();
}

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expire) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  _cache.set(key, { value, expire: Date.now() + ttl });
  // 简单的容量控制
  if (_cache.size > 800) {
    const first = _cache.keys().next().value;
    _cache.delete(first);
  }
  if (shouldPersist(key)) {
    _persistDirty = true;
    schedulePersist();
  }
}

/** 主动清理过期项并立即落盘（进程退出 / 手动调用） */
function flushCache() {
  if (_persistDirty) savePersist();
}

process.on('SIGTERM', () => { flushCache(); process.exit(0); });
process.on('SIGINT', () => { flushCache(); process.exit(0); });

async function cached(key, ttl, fn) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const val = await fn();
  if (val !== undefined && val !== null) cacheSet(key, val, ttl);
  return val;
}

/* ============================================================
 * 4. 接口健康监控 —— 记录每个上游接口的成功/失败
 * ============================================================ */

const health = {
  stats: {}, // name -> {ok, fail, lastOk, lastErr, lastMs}
  record(name, ok, ms, err) {
    const s = (this.stats[name] = this.stats[name] || {
      ok: 0,
      fail: 0,
      lastOk: 0,
      lastErr: '',
      lastMs: 0,
      updated: 0,
    });
    if (ok) {
      s.ok++;
      s.lastOk = Date.now();
      s.lastMs = ms;
    } else {
      s.fail++;
      s.lastErr = String(err && err.message ? err.message : err).slice(0, 120);
    }
    s.updated = Date.now();
  },
  snapshot() {
    return Object.entries(this.stats).map(([name, s]) => {
      const total = s.ok + s.fail;
      return {
        name,
        ok: s.ok,
        fail: s.fail,
        successRate: total ? +(s.ok / total * 100).toFixed(1) : 100,
        avgMs: s.lastMs,
        lastOk: s.lastOk ? new Date(s.lastOk).toISOString() : null,
        lastErr: s.lastErr,
        status: s.fail && !s.lastOk ? 'down' : s.lastErr && Date.now() - s.updated < 60000 ? 'degraded' : 'up',
      };
    });
  },
};

/** 包裹一层监控 */
async function monitored(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    health.record(name, true, Date.now() - t0);
    return r;
  } catch (e) {
    health.record(name, false, Date.now() - t0, e);
    throw e;
  }
}

/* ============================================================
 * 5. 业务接口封装
 * ============================================================ */

const EP = {
  column: 'https://api.cntv.cn/NewVideo/getVideoListByColumn',
  album: 'https://api.cntv.cn/NewVideo/getVideoListByAlbumIdNew',
  videoInfo: 'https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do',
  videoInfoByGuid: 'https://api.cntv.cn/video/videoinfoByGuid',
  epg: 'https://api.cntv.cn/epg/getEpgInfoByChannelNew',
  live: 'https://vdn.live.cntv.cn/api2/live.do',
  search: 'https://search.cctv.com/search.php',
  columnPage: 'https://tv.cctv.com/lm/%s/index.shtml',
};

/** 5.1 栏目视频列表 */
async function getColumnVideos(ctid, { p = 1, n = 24, sort = 'desc' } = {}) {
  const key = `col:${ctid}:${p}:${n}:${sort}`;
  return cached(key, 10 * 60 * 1000, () =>
    monitored('getVideoListByColumn', async () => {
      const url =
        `${EP.column}?id=${encodeURIComponent(ctid)}&n=${n}&sort=${sort}` +
        `&p=${p}&d=&mode=0&serviceId=tvcctv`;
      const j = await fetchAny(url);
      const data = (j && j.data) || {};
      return {
        total: data.total || 0,
        list: (data.list || []).map(normalizeVideo),
      };
    })
  );
}

/** 5.2 专辑（剧集/动画）列表 */
async function getAlbumVideos(aid, { p = 1, n = 24 } = {}) {
  const key = `alb:${aid}:${p}:${n}`;
  return cached(key, 10 * 60 * 1000, () =>
    monitored('getVideoListByAlbumIdNew', async () => {
      const url =
        `${EP.album}?id=${encodeURIComponent(aid)}&serviceId=tvcctv` +
        `&p=${p}&n=${n}&mode=0&pub=1&sort=asc`;
      const j = await fetchAny(url);
      const data = (j && j.data) || {};
      return {
        total: data.total || 0,
        list: (data.list || []).map(normalizeVideo),
      };
    })
  );
}

/** 统一视频对象结构 */
function normalizeVideo(it) {
  if (!it) return null;
  return {
    guid: it.guid || it.vid || '',
    title: (it.title || '').trim(),
    image: it.image || it.img || '',
    brief: (it.brief || '').replace(/\s+/g, ' ').trim(),
    length: it.length || it.len || '',
    time: it.time || '',
    url: it.url || '',
    // 页面地址里可提取 guid
  };
}

/** 5.3 取播放地址（HLS + 分档 + 分段） */
async function getPlayInfo(guid) {
  const key = `play:${guid}`;
  return cached(key, 6 * 60 * 1000, () =>
    monitored('getHttpVideoInfo.do', async () => {
      const url = `${EP.videoInfo}?pid=${encodeURIComponent(guid)}`;
      const j = await fetchAny(url);
      if (!j || j.ack !== 'yes') {
        const err = new Error((j && j.tip_msg) || 'video unavailable');
        err.code = j && j.status;
        throw err;
      }
      const chapters = buildChapters(j);
      return {
        title: j.title || '',
        hls: j.hls_url || '',
        hlsEnc: (j.manifest && j.manifest.hls_enc2_url) || '',
        flv: (j.flv_url && j.flv_url.flv1) || '',
        duration: j.duration || '',
        image: (j.image) || '',
        chapters,
      };
    })
  );
}

function buildChapters(j) {
  const out = [];
  const ch = j.chapters || {};
  for (const k of Object.keys(ch)) {
    const c = ch[k];
    if (c && c.url) {
      out.push({
        id: k,
        url: c.url,
        duration: c.duration || '',
        image: c.image || '',
        // 是否为加密段
        enc: !!c.encrypt,
      });
    }
  }
  // 若存在 manifest 里的一般地址
  if (!out.length && j.hls_url) {
    out.push({ id: '0', url: j.hls_url, duration: j.duration || '' });
  }
  return out;
}

/** 5.4 从视频详情页提取 guid / 描述 */
async function getVideoPage(url) {
  return monitored('videoPage', async () => {
    const html = await requestText(url);
    const guid = (/(?:guid|videoCenterId)["']?\s*[:=]\s*["']([0-9a-f]{32})/i.exec(html) || [])[1] || '';
    const title = (/<title>(.*?)<\/title>/i.exec(html) || [])[1] || '';
    const img = (/<meta\s+property=["']og:image["']\s+content=["']([^"']+)/i.exec(html) || [])[1] || '';
    const desc = (/<meta\s+name=["']description["']\s+content=["']([^"']+)/i.exec(html) || [])[1] || '';
    return { guid, title: title.trim(), image: img, brief: desc.trim() };
  });
}

/** 5.5 EPG 电视节目单（实现见下方 getEpg / getNowEpg） */

/**
 * 5.6 直播信息
 *
 * ⚠️ 血泪教训（黑屏有声的根因）：
 *   官方旧接口 vdn.live.cntv.cn/api2/live.do 已废弃，
 *   返回的 hls_url.hls1 / hls2 恒为空，只有 hls6 是「纯音频」流。
 *   旧代码 `hls1 || hls2 || hls6` 会自动降级到音频 → 播放器有声音、无画面。
 *
 * ✅ 现用方案：对接央视播放器真实使用的 ldncctvwbcd/ldcctvwbcd CDN 族
 *    （Playwright 嗅探 tv.cctv.com/live/{ch}/ 的真实 streamUrl 得出）
 *
 * 【地址格式】
 *   https://{host}/{prefix}/cdrmld{ch}_1/index.m3u8?b=200-2100
 *     {prefix} ∈ ldncctvwbcd | ldcctvwbcd | ldocctvwbcd
 *     结构：master playlist → ?BR=td|ud|hd|md 四档 → 媒体播放列表
 *     TS 编码：标准 H.264(0x1b) + AAC(0x0f) —— 浏览器原生可解 ✅
 *
 * ❌ 已弃用的错误源（黑屏元凶之一）：
 *   hlslive1-txy-*.live.cntv.cn/live/hls_cdrm/enc1/av1/{ch}/...
 *   该 CDN 的 PMT 声明 stream_type=0x06(私有)，浏览器无法解出视频轨，
 *   且 flv1 分支全 404 —— 这就是「有声音、全黑屏」的直接原因。
 */

/** CDN 主机池（按覆盖面排序，volcfcdn/volc 系最广） */
const LIVE_HOSTS = [
  'ldncctvwbcdbyte.volcfcdn.com',
  'ldncctvwbcdtxy.liveplay.myqcloud.com',
  'ldncctvwbcdks.v.kcdnvip.com',
  'ldncctvwbcdcnc.v.wscdns.com',
  'ldncctvwbcdbd.a.bdydns.com',
  'ldcctvwbcdbyte.volcfcdn.com',
  'ldcctvwbcdtxy.liveplay.myqcloud.com',
  'ldocctvwbcdbyte.volcfcdn.com',
  'ldocctvwbcdks.v.kcdnvip.com',
  'ldocctvwbcdtxy.liveplay.myqcloud.com',
];

/** CDN 路径前缀变体 */
const LIVE_PREFIXES = ['ldncctvwbcd', 'ldcctvwbcd', 'ldocctvwbcd'];

/** 码率档位（高 → 低） */
const LIVE_BRS = ['td', 'ud', 'hd', 'md'];

/**
 * 按频道硬映射的「已验证」源（ffprobe 实测 H.264 可用）
 * 命中后直接返回，跳过组合竞速，显著加快首播速度
 */
const LIVE_VERIFIED = {
  cctv1: 'https://ldncctvwbcdbyte.volcfcdn.com/ldncctvwbcd/cdrmldcctv1_1/index.m3u8?b=200-2100',
  cctv5: 'https://ldncctvwbcdbyte.volcfcdn.com/ldncctvwbcd/cdrmldcctv5_1/index.m3u8?b=200-2100',
  cctv5plus: 'https://ldncctvwbcdbyte.volcfcdn.com/ldncctvwbcd/cdrmldcctv5plus_1/index.m3u8?b=200-2100',
  cctv13: 'https://ldncctvwbcdbyte.volcfcdn.com/ldncctvwbcd/cdrmldcctv13_1/index.m3u8?b=200-2100',
  cctv16: 'https://ldncctvwbcdbyte.volcfcdn.com/ldncctvwbcd/cdrmldcctv16_1/index.m3u8?b=200-2100',
};

/**
 * 生成直播流候选地址（按优先级排序）。
 * 实测：ldncctvwbcdbyte.volcfcdn.com + ldncctvwbcd 前缀对**全部 18 个频道**
 * 的 master playlist 均存在，故置于最前。
 */
function liveCandidates(channel) {
  const out = [];
  if (LIVE_VERIFIED[channel]) out.push(LIVE_VERIFIED[channel]);
  // 第一梯队：实测最稳的 hosts（volc 火山云 / 腾讯云） × 前缀组合
  const P1 = ['ldncctvwbcdbyte.volcfcdn.com', 'ldcctvwbcdbyte.volcfcdn.com',
              'ldncctvwbcdtxy.liveplay.myqcloud.com', 'ldcctvwbcdtxy.liveplay.myqcloud.com'];
  for (const host of P1) {
    const m = /^(ld[cn]?|ldoc)cctvwbcd/.exec(host);
    const prefix = m ? m[1] + 'cctvwbcd' : 'ldncctvwbcd';
    out.push(`https://${host}/${prefix}/cdrmld${channel}_1/index.m3u8?b=200-2100`);
  }
  // 第二梯队：其余 host × 全部前缀变体（含不带 b= 参数的写法）
  for (const host of LIVE_HOSTS) {
    for (const prefix of LIVE_PREFIXES) {
      out.push(`https://${host}/${prefix}/cdrmld${channel}_1/index.m3u8?b=200-2100`);
    }
  }
  return [...new Set(out)];
}

/** 兼容旧调用：B 类候选（新版已并入 liveCandidates，保留空实现避免破坏引用） */
function liveCandidatesB() {
  return [];
}

/** 计算 m3u8 相对 url 的绝对地址 */
function absUrl(base, rel) {
  if (/^https?:/.test(rel)) return rel;
  try {
    return new URL(rel, base).toString();
  } catch {
    return '';
  }
}

/**
 * 解析一个 m3u8：判断是「媒体列表」（含分片）还是「master 列表」（含子档位）
 * 返回 { kind, url, resolution, segments }
 */
function parseM3u8(txt, baseUrl) {
  if (!txt || !txt.includes('#EXTM3U')) return null;
  const isMaster = /#EXT-X-STREAM-INF/i.test(txt);
  const res = (/RESOLUTION=(\d+x\d+)/i.exec(txt) || [])[1] || '';

  if (isMaster) {
    // 取 BANDWIDTH 最高的一档
    const lines = txt.split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /BANDWIDTH=(\d+)/i.exec(lines[i]);
      if (!m) continue;
      const next = (lines[i + 1] || '').trim();
      if (!next || next.startsWith('#')) continue;
      const bw = Number(m[1]) || 0;
      if (!best || bw > best.bw) best = { bw, url: absUrl(baseUrl, next), res };
    }
    if (!best) return null;
    return { kind: 'master', url: best.url, resolution: best.res, segments: 0 };
  }

  const segs = (txt.match(/^[^\s#].+\.(?:ts|m4s|mp4|aac)(\?\S*)?$/gim) || []).length;
  if (!segs) return null;
  // 媒体列表本身常不带 RESOLUTION，从 url 路径兜底推断档位（1080p / 720p / …）
  let res2 = res;
  if (!res2) {
    const q = /(\d{3,4})p/i.exec(baseUrl);
    if (q) res2 = q[1] + 'p';
  }
  if (!res2 && /\?BR=hd|_hd\//i.test(baseUrl)) res2 = '480p';
  return { kind: 'media', url: baseUrl, resolution: res2, segments: segs };
}

/**
 * 探测直播 m3u8。
 *
 * @param {string} url
 * @param {object} opt
 *   stayOnMaster=true 时，遇到 master playlist 就原地返回（并带上 masterUrl），
 *   不再下钻到媒体列表。这样上层可以把 master 交给 hls.js，
 *   让我们在代理层注入的 CODECS 生效（否则 hls.js 从 SPS 推断出非法 codec → 黑屏）。
 *
 * @returns {Promise<{kind,url,resolution,segments,masterUrl?}|null>}
 */
async function probeLive(url, { depth = 0, stayOnMaster = false, timeout = 2500 } = {}) {
  if (depth > 3 || !url) return null;
  try {
    // ⚡ 单次探测超时收紧到 2.5s：正常 CDN 都是几百毫秒内响应，
    //    用 8s 会让「某个候选挂掉」的场景白白拖满整个探测窗口。
    //    探测本身就带总截止时间兜底，这里只需保证单跳够快。
    const txt = await requestText(url, { timeout, headers: { Referer: 'https://tv.cctv.com/' } });
    const r = parseM3u8(txt, url);
    if (!r) return null;
    if (r.kind === 'master') {
      if (stayOnMaster) {
        // 校验 master 所述子档位真实可用，避免返回死 master
        const ok = await probeLive(r.url, { depth: depth + 1, timeout });
        if (!ok) return null;
        return { ...r, masterUrl: url, resolution: r.resolution || ok.resolution };
      }
      return probeLive(r.url, { depth: depth + 1, timeout });
    }
    return r;
  } catch {
    return null;
  }
}

async function getLive(channel) {
  const key = `live:${channel}`;
  return cached(key, 45 * 1000, () =>
    monitored('live.cntv', async () => {
      const ch = String(channel || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!ch) throw new Error('invalid channel');

      // 1) 并行竞速探测：把候选按批并发探，谁先成功用谁（大幅降低首播等待）
      // ⚠️ 关键：返回 **master playlist** 地址而非「解析到底」的媒体列表！
      //    央视源 master 不含 CODECS，我们在 /api/stream 代理层已为
      //    #EXT-X-STREAM-INF 注入标准 CODECS。hls.js 若直接拿到媒体列表，
      //    只能从 TS 的 SPS 推断出非法的 avc1.640128 → MSE 拒绝 → 黑屏有声。
      let hls = '';
      let resolution = '';
      const candidates = liveCandidates(ch);
      const BATCH = 6;
      // ⚡ 探测加总超时：候选源多时逐批探测可能耗时很久，
      //    上游某批无响应会一直挂着 → 整个接口卡死。6s 后放弃探测，
      //    退回「取第一个候选地址」保证至少有源可试，由前端 hls.js 自行容错。
      const probeAll = (async () => {
        let found = null;
        for (let i = 0; i < candidates.length && !found; i += BATCH) {
          const batch = candidates.slice(i, i + BATCH);
          const rs = await Promise.all(batch.map((c) => probeLive(c, { stayOnMaster: true })));
          found = rs.find(Boolean) || null;
        }
        return found;
      })();
      const found = await withDeadline(probeAll, 6000, null);
      if (found) {
        hls = found.masterUrl || found.url;
        resolution = found.resolution;
      } else if (candidates.length) {
        // 超时兜底：用首个候选，至少让播放器有机会尝试
        const c = candidates[0];
        hls = c.masterUrl || c.url || (typeof c === 'string' ? c : '');
      }

      // 2) 海报图（官方 CDN，用作播放前占位）
      const poster = `https://t.live.cntv.cn/imagehd/${ch}_01.png`;

      // 3) 实时节目单（正在播 / 即将播）
      //    ⚡ 用缓存（默认 30s TTL）：原来传 skipCache:true 导致每次请求
      //    都要实时抓央视网页，上游一慢就把整个 /api/live/:channel 拖到 8s+。
      //    节目单本身 30s 粒度足够，缓存命中后接口稳定在毫秒级。
      let now = null;
      try {
        const epg = await withDeadline(getNowEpg([ch], { skipCache: false }), 2500, null);
        now = (epg && epg[0]) || null;
      } catch {
        now = null;
      }

      return {
        channel: ch,
        hls,
        flv: '',
        poster,
        resolution,
        // 关键：只要能拿到 m3u8，就说明有画面，不再是 audioOnly
        audioOnly: !hls,
        status: hls ? '1' : '0',
        tip: hls ? '' : '该频道暂无可用的直播流，请稍后再试',
        playable: !!hls,
        now,   // 实时节目单：{ title, startText, endText, progress, remaining }
        updatedAt: Date.now(),
      };
    })
  );
}

/**
 * 实时节目单（正在播的节目）
 * 接口：https://api.cntv.cn/epg/nowepg?c=cctv1,cctv5&serviceId=tvcctv&cb=t
 * 返回每频道的当前节目、起止时间与播放进度
 */
async function getNowEpg(channels = [], { skipCache = false } = {}) {
  const list = (Array.isArray(channels) ? channels : [channels])
    .map((c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  if (!list.length) return [];
  const key = `nowepg:${list.join(',')}`;

  const run = () =>
    monitored('epg.nowepg', async () => {
      const url = `https://api.cntv.cn/epg/nowepg?c=${list.join(',')}&serviceId=tvcctv&cb=t`;
      const j = await fetchAny(url);
      // ⚠️ parseJSON 对 `t([{...}])` 形式会剥掉外层数组，单频道时返回裸对象
      // → 这里统一归一成数组，兼容 0/1/N 个频道
      const arr = Array.isArray(j)
        ? j
        : Array.isArray(j && j.data)
          ? j.data
          : j && typeof j === 'object' && !j.__raw
            ? [j]
            : [];
      const now = Date.now();
      return arr.map((x) => {
        const start = (Number(x.ints) || 0) * 1000;
        const end = (Number(x.inte) || 0) * 1000;
        const total = Math.max(1, end - start);
        const elapsed = Math.min(total, Math.max(0, now - start));
        return {
          channel: x.c || '',
          channelName: x.n || '',
          title: x.t || '',
          start,
          end,
          startText: x.s || '',
          endText: x.e || '',
          progress: Math.round((elapsed / total) * 100),
          remaining: Math.max(0, Math.round((end - now) / 60000)),
          columnUrl: x.column_url || '',
          columnBackUrl: x.burl || '',
          live: end > now && start <= now,
        };
      });
    });

  return skipCache ? run() : cached(key, 30 * 1000, run);
}

/**
 * 全天节目单（EPG）
 * 接口：https://api.cntv.cn/epg/getEpgInfoByChannelNew?c={ch}&serviceId=tvcctv&d={yyyymmdd}
 */
async function getEpg(channel, date) {
  const ch = String(channel || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const d = String(date || '').replace(/-/g, '') || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `epg:${ch}:${d}`;
  return cached(key, 30 * 60 * 1000, () =>
    monitored('epg.getEpgInfoByChannelNew', async () => {
      const url = `${EP.epg}?c=${ch}&serviceId=tvcctv&d=${d}`;
      const j = await fetchAny(url);
      const node = (j && j.data && (j.data[ch] || Object.values(j.data)[0])) || null;
      if (!node) return null;
      const list = (node.list || []).map((x) => ({
        title: x.title || '',
        start: x.startTime || 0,
        end: x.endTime || 0,
        showTime: x.showTime || '',
        length: x.length || 0,
        columnUrl: x.column_url || '',
        columnBackUrl: x.column_backvideourl || '',
      }));
      return {
        channel: ch,
        name: node.name || ch,
        date: d,
        list,
        total: list.length,
      };
    })
  );
}

/** 5.7 搜索（抓取站内搜索页） */
async function search(kw, { page = 1 } = {}) {
  const key = `search:${kw}:${page}`;
  return cached(key, 10 * 60 * 1000, () =>
    monitored('search.cctv', async () => {
      const url =
        `${EP.search}?qtext=${encodeURIComponent(kw)}&type=video` +
        `&sort=relevance&page=${page}`;
      const html = await requestText(url);

      // 按结果块切分：央视搜索页每个结果通常在一个含 shtml 链接的片段里
      const list = [];
      const seen = new Set();

      // 1) 优先解析带缩略图的结构块
      const blocks = html.split(/<li[\s>]/i);
      for (const blk of blocks) {
        const linkM = /href="(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/(VID[A-Za-z0-9]+)\.shtml)"/i.exec(blk);
        if (!linkM) continue;
        const url2 = linkM[1];
        if (seen.has(url2)) continue;

        // 标题：优先 h3/a title，其次任意可见文本
        let title = '';
        const tM =
          /<a[^>]+title="([^"]{2,120})"/i.exec(blk) ||
          /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]{2,160}?)<\/a>/i.exec(blk) ||
          /<a[^>]+href="[^"]*VID[A-Za-z0-9]+\.shtml"[^>]*>([\s\S]{2,160}?)<\/a>/i.exec(blk);
        if (tM) title = tM[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        // 清理「查看详情》」等噪声
        title = title.replace(/^查看详情[》>]*$/, '').replace(/&hellip;/g, '…');
        if (!title || title.length < 2) continue;

        const imgM = /<img[^>]+src="(https?:[^"]+\.(?:jpg|jpeg|png|webp))"/i.exec(blk);
        const briefM = /<(?:p|div)[^>]*class="[^"]*(?:brief|txt|desc|con)[^"]*"[^>]*>([\s\S]{4,300}?)<\/(?:p|div)>/i.exec(blk);

        seen.add(url2);
        list.push({
          title,
          url: url2,
          guid: linkM[2],
          image: imgM ? imgM[1] : '',
          brief: briefM ? briefM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '',
        });
      }

      // 2) 兜底：直接抓所有 VID 链接，用相邻文本做标题
      if (list.length < 3) {
        const re = /href="(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/(VID[A-Za-z0-9]+)\.shtml)"[^>]*>([\s\S]{2,200}?)<\/a>/gi;
        let m;
        while ((m = re.exec(html))) {
          if (seen.has(m[1])) continue;
          const t = m[3].replace(/<[^>]+>/g, '').trim();
          if (!t || t.length < 2 || /查看详情/.test(t)) continue;
          seen.add(m[1]);
          list.push({ title: t, url: m[1], guid: m[2], image: '', brief: '' });
        }
      }

      return { list: list.slice(0, 40) };
    })
  );
}

/** 5.8 从栏目页解析 ctid（用于后台添加栏目） */
async function resolveColumnId(codeOrUrl) {
  return monitored('columnPage', async () => {
    let url = codeOrUrl;
    if (!/^https?:/.test(codeOrUrl)) {
      url = EP.columnPage.replace('%s', codeOrUrl);
    }
    const html = await requestText(url);
    const ctid = (/TOPC\d{16,20}/.exec(html) || [])[0] || '';
    const title = (/<title>(.*?)<\/title>/i.exec(html) || [])[1] || '';
    return { ctid, name: title.split(/[_\-|]/)[0].trim(), url };
  });
}

module.exports = {
  // 基础设施
  requestBuffer,
  requestStream,
  requestText,
  fetchAny,
  parseJSON,
  parseXML,
  parseAuto,
  cached,
  loadPersist,
  flushCache,
  health,
  monitored,
  // 业务
  getColumnVideos,
  getAlbumVideos,
  getPlayInfo,
  getVideoPage,
  getEpg,
  getLive,
  search,
  resolveColumnId,
  normalizeVideo,
  EP,
};
