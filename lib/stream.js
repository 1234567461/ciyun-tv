'use strict';
/**
 * 慈云影视 - 统一流媒体代理
 * ============================================================
 * 目标：让浏览器能播放任何上游流（HLS/FLV/MP4/DASH/TS），
 * 解决跨域、防盗链(Referer)、m3u8 内相对路径、加密分片等问题，
 * 并支持多线路自动容灾（一个地址失败自动尝试下一个）。
 *
 * 支持协议识别：
 *   .m3u8 / .m3u   -> HLS（改写内嵌地址为本地代理地址）
 *   .mpd           -> DASH（透传）
 *   .flv           -> HTTP-FLV（透传，供 flv.js 使用）
 *   .mp4/.mov/.webm-> 直连媒体（支持 Range 断点/拖动）
 *   .ts/.m4s/.key  -> HLS 分片/密钥（透传，注意解密不介入）
 */

const { requestBuffer } = require('./cctv');
const { URL } = require('url');

/** 上游请求头（绕过部分防盗链） */
function upstreamHeaders(target, extra = {}) {
  let origin = '';
  try {
    const u = new URL(target);
    origin = u.origin + '/';
  } catch {}
  return {
    Referer: origin,
    Origin: origin.replace(/\/$/, ''),
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...extra,
  };
}

/** 识别流类型 */
function detectStreamType(url) {
  const u = (url || '').split('?')[0].toLowerCase();
  if (u.endsWith('.m3u8') || u.endsWith('.m3u')) return 'hls';
  if (u.endsWith('.mpd')) return 'dash';
  if (u.endsWith('.flv')) return 'flv';
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(u)) return 'file';
  if (u.endsWith('.ts') || u.endsWith('.m4s')) return 'segment';
  if (u.endsWith('.key')) return 'key';
  return 'unknown';
}

/**
 * 把 m3u8 正文里的所有资源地址改写为本地代理地址，
 * 使浏览器经我们转发，规避跨域和防盗链。
 *
 * @param {string} text        m3u8 正文
 * @param {string} baseUrl     该 m3u8 的原始地址（用于解析相对路径）
 * @param {string} proxyPrefix 本地代理前缀，例如 /api/stream?url=
 */
function rewriteM3U8(text, baseUrl, proxyPrefix = '/api/stream?url=') {
  const lines = text.split(/\r?\n/);
  // 已经是代理地址的，直接取其中的原始 url，避免二次包裹
  const unwrap = (s) => {
    const i = s.indexOf(proxyPrefix);
    if (i >= 0) return decodeURIComponent(s.slice(i + proxyPrefix.length));
    return null;
  };

  const out = lines.map((line) => {
    const t = line.trim();
    if (!t) return line;

    // 1) URI="..." 属性（KEY / MEDIA / MAP 等）
    if (t.startsWith('#')) {
      return t.replace(/URI="([^"]+)"/g, (m, uri) => {
        const raw = unwrap(uri) || uri;
        const abs = new URL(raw, baseUrl).toString();
        return `URI="${proxyPrefix}${encodeURIComponent(abs)}"`;
      });
    }

    // 2) 资源行（分片或子列表）—— 任意非 # 开头都视为资源引用
    if (t && !t.startsWith('#')) {
      const raw = unwrap(t) || t;
      let abs;
      try {
        abs = new URL(raw, baseUrl).toString();
      } catch {
        return line;
      }
      return `${proxyPrefix}${encodeURIComponent(abs)}`;
    }
    return line;
  });
  return out.join('\n');
}

/**
 * 核心代理处理。
 * @param {string} target 上游地址
 * @param {object} req    http 请求（用于透传 Range、处理条件请求）
 * @param {object} res    http 响应
 * @param {object} opts   { headers, rewrite:boolean }
 */
async function proxyStream(target, req, res, opts = {}) {
  const type = detectStreamType(target);
  const isMedia = ['file', 'segment', 'flv', 'dash'].includes(type);

  const headers = upstreamHeaders(target, opts.headers || {});
  // 透传 Range（拖动进度、断点续传）
  if (req.headers.range && isMedia) headers.Range = req.headers.range;

  // m3u8 需要拿到完整文本用于改写
  const needRewrite = type === 'hls';
  if (needRewrite) delete headers.Range;

  const { buf, headers: rh, statusCode } = await requestBuffer(target, {
    headers,
    timeout: 15000,
  });

  // 内容类型
  let ct = rh['content-type'] || '';
  if (!ct || ct === 'application/octet-stream') {
    ct =
      type === 'hls'
        ? 'application/vnd.apple.mpegurl'
        : type === 'flv'
        ? 'video/x-flv'
        : type === 'dash'
        ? 'application/dash+xml'
        : type === 'file'
        ? 'video/mp4'
        : type === 'segment'
        ? 'video/mp2t'
        : 'application/octet-stream';
  }

  res.statusCode = statusCode || 200;
  res.setHeader('Content-Type', ct);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (rh['content-range']) res.setHeader('Content-Range', rh['content-range']);
  if (rh['accept-ranges']) res.setHeader('Accept-Ranges', rh['accept-ranges']);
  else if (isMedia) res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', type === 'hls' ? 'no-cache' : 'public, max-age=3600');

  if (needRewrite) {
    const text = buf.toString('utf8');
    const rewritten = rewriteM3U8(text, target);
    res.setHeader('Content-Length', Buffer.byteLength(rewritten));
    return res.end(rewritten);
  }

  return res.end(buf);
}

/**
 * 多线路自动切换：依次尝试候选地址，返回第一个可用的流地址。
 * @param {string[]} candidates
 * @returns {Promise<{url:string,type:string,index:number}>}
 */
async function pickWorkingStream(candidates) {
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    if (!url) continue;
    try {
      const headers = upstreamHeaders(url);
      // 只取头部少量字节做探活
      const { statusCode } = await requestBuffer(url, { headers, timeout: 8000 });
      if (statusCode >= 200 && statusCode < 400) {
        return { url, type: detectStreamType(url), index: i };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('all streams unavailable');
}

/**
 * 探测 m3u8 的清晰度档位（主列表 -> 分档列表）
 */
function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('#EXT-X-STREAM-INF')) {
      const bw = (/,BANDWIDTH=(\d+)/i.exec(t) || [])[1];
      const res = (/,RESOLUTION=([\dx]+)/i.exec(t) || [])[1];
      const next = (lines[i + 1] || '').trim();
      if (next && !next.startsWith('#')) {
        variants.push({
          bandwidth: bw ? parseInt(bw, 10) : 0,
          resolution: res || '',
          url: new URL(next, baseUrl).toString(),
        });
      }
    }
  }
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

module.exports = {
  proxyStream,
  rewriteM3U8,
  detectStreamType,
  pickWorkingStream,
  parseMasterPlaylist,
  upstreamHeaders,
};
