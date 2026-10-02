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

const TIMEOUT = 12000;

/* ============================================================
 * 1. 基础请求层 —— 兼容 http/https、重定向、压缩、字符集
 * ============================================================ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 无依赖 HTTP 请求，返回 Buffer */
function requestBuffer(url, { headers = {}, timeout = TIMEOUT, redirects = 5 } = {}) {
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
            requestBuffer(next, { headers, timeout, redirects: redirects - 1 })
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
}

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

/** 5.5 EPG 电视节目单 */
async function getEpg(channel, dateStr) {
  const key = `epg:${channel}:${dateStr}`;
  return cached(key, 5 * 60 * 1000, () =>
    monitored('getEpgInfoByChannelNew', async () => {
      const url =
        `${EP.epg}?c=${encodeURIComponent(channel)}` +
        `&serviceId=tvcctv&d=${dateStr}&t=json`;
      const j = await fetchAny(url);
      const d = (j && j.data && (j.data[channel] || j.data[Object.keys(j.data)[0]])) || null;
      if (!d) return null;
      return {
        channel,
        name: d.channelName || channel,
        isLive: d.isLive || '',
        liveUrl: d.lvUrl || '',
        list: (d.list || []).map((x) => ({
          title: x.title,
          start: x.startTime,
          end: x.endTime,
          showTime: x.showTime,
          length: x.length,
          columnUrl: x.column_url || '',
          columnBackUrl: x.columnBackvideourl || '',
        })),
      };
    })
  );
}

/** 5.6 直播信息 */
async function getLive(channel) {
  const key = `live:${channel}`;
  return cached(key, 60 * 1000, () =>
    monitored('live.do', async () => {
      const url = `${EP.live}?channel=pa://cctv_p2p_hd${encodeURIComponent(channel)}&client=flash`;
      const j = await fetchAny(url);
      const hls = (j.hls_url && (j.hls_url.hls1 || j.hls_url.hls2 || j.hls_url.hls6)) || '';
      const flv = (j.flv_url && (j.flv_url.flv1 || j.flv_url.flv2)) || '';
      const poster = (j.hls_url && j.hls_url.hls5) || '';
      return {
        channel,
        hls,
        flv,
        poster,
        audioOnly: !!(j.hls_url && j.hls_url.hls6 && !j.hls_url.hls1),
        status: j.status || '',
        tip: j.tip_msg || '',
        playable: !!(hls || flv),
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
  requestText,
  fetchAny,
  parseJSON,
  parseXML,
  parseAuto,
  cached,
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
