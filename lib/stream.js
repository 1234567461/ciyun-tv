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

const { requestBuffer, requestStream } = require('./cctv');
const { URL } = require('url');

/** 上游请求头（绕过部分防盗链） */
function upstreamHeaders(target, extra = {}) {
  let origin = '';
  try {
    const u = new URL(target);
    origin = u.origin + '/';
  } catch {}
  // ⚠️ 央视直播 CDN（hlslive/txy、kcdnvip、volcfcdn、bdydns）做了 Referer 防盗链：
  //    必须带 Referer: https://tv.cctv.com/ 才能取到分片，否则 403/502。
  const isCctv = /(cntv\.cn|kcdnvip\.com|volcfcdn\.com|bdydns\.com|myalicdn\.com|cctv\.com)/i.test(
    target || ''
  );
  return {
    Referer: isCctv ? 'https://tv.cctv.com/' : origin,
    Origin: isCctv ? 'https://tv.cctv.com' : origin.replace(/\/$/, ''),
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
 * 规范化 H.264 codec 字符串（修复央视源「黑屏有声」的关键补丁）。
 *
 * ⚠️ 血泪教训：
 *   央视 ldncctvwbcd/ldcctvwbcd 系列 CDN 的 master playlist **不写 CODECS 属性**，
 *   hls.js 只能从 TS 分片的 SPS 里自行推断。央视源的 SPS 为
 *     profile_idc=100(High) + constraint_flags=0x01 + level_idc=40
 *   hls.js 据此拼出 `avc1.640128`。而 Chromium 的 MSE 认为
 *     High profile 下 constraint_flags 的保留位 0x01 非法 → isTypeSupported=false
 *     → bufferAddCodecError → 视频轨整轨丢弃（音频 AAC 正常）→ 黑屏有声。
 *
 * 修法：把 avc1.6401xx 这种非法约束位写法，规整为标准 `avc1.6400xx`
 *      （constraint_flags=0x00）。两者对解码器完全等价，但后者 MSE 接受。
 *
 * @param {string} codecs 形如 "avc1.640128,mp4a.40.2"
 */
function normalizeCodecs(codecs) {
  if (!codecs || typeof codecs !== 'string') return codecs;
  return codecs.replace(/avc1\.([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/g, (m, a, b, c) => {
    const profile = parseInt(a, 16);
    const constraints = parseInt(b, 16);
    const level = parseInt(c, 16);
    // High(0x64) / High10(0x6E) / High422(0x7A) / High444(0x7C) 的约束保留位应为 0
    const HIGH = [0x64, 0x6e, 0x7a, 0x7c];
    if (HIGH.includes(profile) && (constraints & 0x0f) !== 0) {
      return `avc1.${a}00${c}`;
    }
    return m;
  });
}

/**
 * 把 m3u8 正文里的所有资源地址改写为本地代理地址，
 * 使浏览器经我们转发，规避跨域和防盗链。
 *
 * 另外两条关键修补（解决直播黑屏）：
 *   1. master playlist 的 #EXT-X-STREAM-INF 若缺 CODECS，注入标准值，
 *      避免 hls.js 从 SPS 推断出 MSE 不接受的畸形 codec；
 *   2. 已有 CODECS 的，做 normalizeCodecs 规整。
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
    let work = line;
    const t = line.trim();

    // 0) 修补 #EXT-X-STREAM-INF 的 CODECS（关键！）
    if (t.startsWith('#EXT-X-STREAM-INF')) {
      work = patchStreamInfCodecs(line, baseUrl);
    }

    const tt = work.trim();
    if (!tt) return work;

    // 1) URI="..." 属性（KEY / MEDIA / MAP 等）
    if (tt.startsWith('#')) {
      return work.replace(/URI="([^"]+)"/g, (m, uri) => {
        const raw = unwrap(uri) || uri;
        const abs = new URL(raw, baseUrl).toString();
        return `URI="${proxyPrefix}${encodeURIComponent(abs)}"`;
      });
    }

    // 2) 资源行（分片或子列表）—— 任意非 # 开头都视为资源引用
    if (tt && !tt.startsWith('#')) {
      const raw = unwrap(tt) || tt;
      let abs;
      try {
        abs = new URL(raw, baseUrl).toString();
      } catch {
        return line;
      }
      return `${proxyPrefix}${encodeURIComponent(abs)}`;
    }
    return work;
  });
  return out.join('\n');
}

/**
 * 修补 #EXT-X-STREAM-INF 行：
 *   - 若已有 CODECS：做 normalizeCodecs 规整（修 avc1.640128 这类非法约束位）
 *   - 若无 CODECS：按分辨率注入标准 H.264 + AAC 声明
 *
 * 为什么要注入：master 缺 CODECS 时，hls.js 会退化为从 TS 的 SPS 推断，
 * 而央视源 SPS 的约束位非法 → MSE 拒绝该 codec → 整条视频轨被丢弃 → 黑屏有声。
 * 显式声明后 hls.js 会直接采用，跳过 SPS 推断。
 */
function patchStreamInfCodecs(line, baseUrl) {
  const hasCodecs = /CODECS="[^"]*"/i.test(line);
  if (hasCodecs) {
    return line.replace(/CODECS="([^"]*)"/gi, (m, c) => `CODECS="${normalizeCodecs(c)}"`);
  }
  // 从 RESOLUTION 推断 codec level（保守取 High@4.0，兼容 720p/1080p）
  const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
  let level = '28'; // High@4.0
  if (res) {
    const h = Number(res[2]);
    if (h <= 480) level = '1f'; // High@3.1
    else if (h <= 720) level = '1f';
    else level = '28';
  }
  const codecs = `avc1.6400${level},mp4a.40.2`;
  // 插到 BANDWIDTH 之后（CODECS 顺序无强制要求，但需在行内）
  if (/BANDWIDTH=\d+/i.test(line)) {
    return line.replace(/(BANDWIDTH=\d+)/i, `$1,CODECS="${codecs}"`);
  }
  return line + `,CODECS="${codecs}"`;
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

  // m3u8 需要拿到完整文本用于改写；其余（ts 分片/flv/mp4）一律流式转发，
  // 避免「服务端先整包下载完再发」带来的额外延迟 —— 直播分片每 4s 一个，
  // 这一跳延迟叠加正是「播一会儿就一直报错」的诱因之一。
  const needRewrite = type === 'hls';
  if (needRewrite) delete headers.Range;

  if (needRewrite) {
    const { buf, headers: rh, statusCode } = await requestBuffer(target, {
      headers,
      timeout: 15000,
    });
    let ct = rh['content-type'] || '';
    if (!ct || ct === 'application/octet-stream') ct = 'application/vnd.apple.mpegurl';
    res.statusCode = statusCode || 200;
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    const text = buf.toString('utf8');
    const rewritten = rewriteM3U8(text, target);
    res.setHeader('Content-Length', Buffer.byteLength(rewritten));
    return res.end(rewritten);
  }

  // ---- 媒体数据：流式 pipe，边下边发 ----
  return await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const upstream = requestStream(target, { headers, timeout: 20000 });

    upstream.on('response', (rh) => {
      const statusCode = upstream.response.statusCode || 200;

      let ct = rh['content-type'] || '';
      if (!ct || ct === 'application/octet-stream') {
        ct =
          type === 'flv'
            ? 'video/x-flv'
            : type === 'dash'
            ? 'application/dash+xml'
            : type === 'file'
            ? 'video/mp4'
            : type === 'segment'
            ? 'video/mp2t'
            : 'application/octet-stream';
      }

      res.statusCode = statusCode;
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      if (rh['content-length']) res.setHeader('Content-Length', rh['content-length']);
      if (rh['content-range']) res.setHeader('Content-Range', rh['content-range']);
      if (rh['accept-ranges']) res.setHeader('Accept-Ranges', rh['accept-ranges']);
      else if (isMedia) res.setHeader('Accept-Ranges', 'bytes');
      // 分片可短缓存（回看窗口内复用），flv 直播流不可缓存
      res.setHeader('Cache-Control', type === 'flv' ? 'no-cache' : 'public, max-age=60');

      upstream.pipe(res);
      upstream.on('end', done);
      upstream.on('error', () => { try { res.end(); } catch {} done(); });
    });

    upstream.on('error', (e) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('upstream error: ' + e.message);
      } else {
        try { res.end(); } catch {}
      }
      done();
    });

    // 客户端断开（切台/关页）立即中止上游，释放连接
    res.on('close', () => {
      if (!settled) { try { upstream.destroy(); } catch {} done(); }
    });
  });
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
  normalizeCodecs,
  proxyStream,
  rewriteM3U8,
  detectStreamType,
  pickWorkingStream,
  parseMasterPlaylist,
  upstreamHeaders,
};
