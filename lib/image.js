'use strict';
/**
 * 慈云影视 · 安全图片处理模块
 * ============================================================
 * 与 lib/upload.js（视频）同源的纵深防御思路，但针对图片场景做了
 * 三处关键调整：
 *
 *   1. 支持「动图」—— GIF/WebP 必须保留动画，不能用静态转码覆盖，
 *      否则用户传的动图会变成一张静止图（体验事故）。
 *   2. 防「解码炸弹」—— 图片压缩率极高，100KB 的文件可以解出
 *      80000×80000（约 192 亿像素）。这类文件在浏览器里渲染即
 *      拖垮页面、在服务端转码即 OOM。必须在「解码之前」用文件头
 *      读出真实尺寸并拒绝。
 *   3. 缩略图分离 —— 原图用于查看/下载，缩略图用于列表/聊天窗
 *      渲染。聊天室一次刷屏几十张原图会打爆带宽与内存。
 *
 * 防御层次：
 *   L1 体积限制      —— 边收边计数，超限即断
 *   L2 扩展名白名单  —— jpg/jpeg/png/gif/webp/avif/bmp
 *   L3 文件名消毒    —— 丢弃原名，服务端随机命名
 *   L4 魔数校验      —— 读文件头确认真实格式（防 .php 改名 .jpg）
 *   L5 尺寸校验      —— 从头解析宽高，拒绝超大像素（防解码炸弹）
 *   L6 内容探测      —— ffprobe 确认真能解码为图像流
 *   L7 隔离存储      —— 存 web 根之外 + nosniff + 强制 inline 白名单
 *
 * 落盘目录：data/uploads/images/  （原图）与 data/uploads/images/thumb/
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

/* ============================================================
 * 配置
 * ============================================================ */
const IMAGE_DIR = process.env.IMAGE_DIR || path.join(__dirname, '..', 'data', 'uploads', 'images');
const THUMB_DIR = path.join(IMAGE_DIR, 'thumb');
const TMP_DIR = path.join(os.tmpdir(), 'cinema-image-tmp');

/** 允许的扩展名（小写，不含点） */
const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);

/** 扩展名 → 标准 MIME */
const EXT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

/**
 * 分场景体积上限（字节）。
 * 聊天/评论的图会长期留在数据库与列表中反复渲染，必须严格；
 * 相册与云盘是用户自己的存储，可放宽。
 */
const LIMITS = {
  comment: Number(process.env.IMAGE_MAX_COMMENT || 5 * 1024 * 1024),    // 5MB
  chat: Number(process.env.IMAGE_MAX_CHAT || 5 * 1024 * 1024),          // 5MB
  danmaku: Number(process.env.IMAGE_MAX_DANMAKU || 2 * 1024 * 1024),    // 2MB
  cover: Number(process.env.IMAGE_MAX_COVER || 10 * 1024 * 1024),       // 10MB
  avatar: Number(process.env.IMAGE_MAX_AVATAR || 2 * 1024 * 1024),      // 2MB
  gallery: Number(process.env.IMAGE_MAX_GALLERY || 20 * 1024 * 1024),   // 20MB
  drive: Number(process.env.IMAGE_MAX_DRIVE || 50 * 1024 * 1024),       // 50MB
};

/** 单边 / 总面积上限，防解码炸弹 */
const MAX_DIMENSION = Number(process.env.IMAGE_MAX_DIMENSION || 12000);       // 单边 12000px
const MAX_PIXELS = Number(process.env.IMAGE_MAX_PIXELS || 80 * 1024 * 1024);  // 约 8000 万像素

/** 缩略图最长边 */
const THUMB_SIZE = Number(process.env.IMAGE_THUMB_SIZE || 480);

/* ============================================================
 * L3 文件名消毒
 * ============================================================ */
/**
 * 生成安全的服务端文件名。
 * @param {string} ext 扩展名（会与白名单比对，不在白名单内一律降级为 jpg）
 */
function safeFileName(ext) {
  const e = ALLOWED_EXT.has(String(ext).toLowerCase()) ? String(ext).toLowerCase() : 'jpg';
  const rnd = crypto.randomBytes(12).toString('hex');
  return `${Date.now()}_${rnd}.${e}`;
}

/** 从原始文件名取扩展名（仅用于白名单比对，绝不用于落盘命名） */
function extOf(name) {
  const b = path.basename(String(name || '').replace(/\\/g, '/'));
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

/** 扩展名归一：jpeg → jpg */
function normExt(ext) {
  const e = String(ext || '').toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

/* ============================================================
 * L4 魔数校验
 * ============================================================ */
/**
 * 根据文件头判定真实图片格式。
 * 注意这里只做「是不是图片、是哪一种」，尺寸解析另走 sniffSize()。
 * @param {Buffer} head 文件前若干字节（建议 ≥ 64B）
 * @returns {'jpg'|'png'|'gif'|'webp'|'avif'|'bmp'|null}
 */
function sniffImage(head) {
  if (!head || head.length < 12) return null;

  // JPEG：FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';

  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
      head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'png';

  // GIF：'GIF87a' / 'GIF89a'
  const g = head.slice(0, 6).toString('latin1');
  if (g === 'GIF87a' || g === 'GIF89a') return 'gif';

  // WebP：RIFF....WEBP
  if (head.slice(0, 4).toString('latin1') === 'RIFF' &&
      head.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';

  // AVIF / HEIF：ISO BMFF，偏移 4 为 'ftyp'，品牌含 avif/avis/heic/heix/mif1
  if (head.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.slice(8, 12).toString('latin1').toLowerCase();
    if (/^(avif|avis|heic|heix|hevc|mif1|msf1)/.test(brand)) return 'avif';
    return null; // 是 BMFF，但可能是 mp4 视频 —— 交给视频模块处理
  }

  // BMP：'BM'
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';

  return null;
}

/* ============================================================
 * L5 尺寸解析（纯头解析，不解码像素 —— 防解码炸弹的关键）
 * ============================================================ */
/**
 * 从文件头解析图片真实宽高。
 * 全部走「读头部若干字节 + 按格式规范取字段」，不调用任何解码器，
 * 因此即使面对 80000×80000 的恶意文件也只会读几十字节、耗时微秒级。
 *
 * @param {string} filePath
 * @returns {Promise<{w:number,h:number,animated?:boolean,format?:string}|null>}
 */
async function readSize(filePath) {
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    const st = await fd.stat();
    const size = st.size;

    // 读头 64KB，足够覆盖大多数情况下的尺寸字段
    const headLen = Math.min(65536, size);
    const head = Buffer.alloc(headLen);
    await fd.read(head, 0, headLen, 0);

    const fmt = sniffImage(head);
    if (!fmt) return null;

    let w = 0, h = 0, animated = false;

    if (fmt === 'png') {
      // IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型 = 偏移 16 起
      if (head.length >= 24) {
        w = head.readUInt32BE(16);
        h = head.readUInt32BE(20);
      }
      // 是否存在 acTL 块（APNG 动图）
      animated = head.slice(0, headLen).includes('acTL');
    } else if (fmt === 'jpg') {
      // 逐段扫描 SOF 标记
      const r = parseJpegSize(head);
      if (r) { w = r.w; h = r.h; }
    } else if (fmt === 'gif') {
      if (head.length >= 10) {
        w = head.readUInt16LE(6);
        h = head.readUInt16LE(8);
      }
      // 多帧 = 动图（扫描 Graphic Control Extension 出现次数 > 1 不现实，
      // 这里用 NETSCAPE2.0 应用扩展块判断循环，或看有无多张图像描述符）
      animated = head.slice(0, headLen).includes('NETSCAPE2.0');
    } else if (fmt === 'webp') {
      const r = parseWebpSize(head);
      if (r) { w = r.w; h = r.h; animated = r.animated; }
    } else if (fmt === 'bmp') {
      if (head.length >= 26) {
        w = Math.abs(head.readInt32LE(18));
        h = Math.abs(head.readInt32LE(22));
      }
    } else if (fmt === 'avif') {
      // AVIF 尺寸在 ispe box 里，结构较深；用 ffprobe 兜底（见 detect()）
      const r = parseAvifSize(head);
      if (r) { w = r.w; h = r.h; }
    }

    return { w, h, animated, format: fmt };
  } catch {
    return null;
  } finally {
    if (fd) { try { await fd.close(); } catch {} }
  }
}

/** JPEG：扫描 marker，找到 SOF0~SOF15（排除 DHT/DAC 等） */
function parseJpegSize(buf) {
  let i = 2; // 跳过 FFD8
  const len = buf.length;
  while (i < len - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // 填充字节 FF
    if (marker === 0xff) { i++; continue; }
    // 无载荷的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const segLen = buf.readUInt16BE(i + 2);
    // SOF0..SOF15，排除 0xC4(DHT) / 0xC8(JPG) / 0xCC(DAC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return { w, h };
    }
    i += 2 + segLen;
  }
  return null;
}

/** WebP：VP8 / VP8L / VP8X 三种子格式 */
function parseWebpSize(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.slice(12, 16).toString('latin1');
  if (fourcc === 'VP8 ') {
    // 有损：帧标签 3 字节 + 同步码 9D 01 2A + 宽高（14 位，需 &0x3fff）
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return { w, h, animated: false };
  }
  if (fourcc === 'VP8L') {
    // 无损：签名 0x2F 后跟 28 位宽高（各 14 位）
    const bits = buf.readUInt32LE(21);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >> 14) & 0x3fff) + 1;
    return { w, h, animated: false };
  }
  if (fourcc === 'VP8X') {
    // 扩展格式：偏移 24 起 3 字节宽-1、3 字节高-1
    const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    // flags 第 2 字节 bit1 = animation
    const animated = !!(buf[20] & 0x02);
    return { w, h, animated };
  }
  return null;
}

/** AVIF：递归找 ispe box（宽高各 4 字节 BE） */
function parseAvifSize(buf) {
  // ispe 结构：size(4) 'ispe'(4) version(4) width(4) height(4)
  const idx = buf.slice(0, Math.min(buf.length, 4096)).indexOf('ispe');
  if (idx < 0) return null;
  const p = idx + 4 + 4; // 跳过 'ispe' 与 version/flags
  if (p + 8 > buf.length) return null;
  return { w: buf.readUInt32BE(p), h: buf.readUInt32BE(p + 4) };
}

/* ============================================================
 * L6 内容探测（ffprobe）
 * ============================================================ */
let _ffprobeOk = null;
async function hasFfprobe() {
  if (_ffprobeOk !== null) return _ffprobeOk;
  _ffprobeOk = await new Promise((resolve) => {
    execFile('ffprobe', ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
  return _ffprobeOk;
}

/** 用 ffprobe 确认文件真的能被解码为图像流 */
function ffprobeImage(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0',
       '-show_entries', 'stream=codec_name,width,height',
       '-show_entries', 'format=format_name',
       '-of', 'json', filePath],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message.slice(0, 200) });
        try {
          const j = JSON.parse(stdout);
          const s = (j.streams || [])[0];
          if (!s) return resolve({ ok: false, error: '无图像流' });
          resolve({
            ok: true,
            codec: s.codec_name || '',
            width: s.width || 0,
            height: s.height || 0,
            format: (j.format && j.format.format_name) || '',
          });
        } catch {
          resolve({ ok: false, error: 'ffprobe 输出解析失败' });
        }
      }
    );
  });
}

/* ============================================================
 * 主校验流程
 * ============================================================ */
/**
 * 校验一张已落盘到临时目录的图片。
 *
 * @param {object} f      { path, size, originalname, mimetype }
 * @param {object} [opt]  { scene: 'comment'|'chat'|'danmaku'|'cover'|'avatar'|'gallery'|'drive' }
 * @returns {Promise<{ok:boolean, reason?:string, info?:object}>}
 */
async function validateImage(f, opt = {}) {
  const p = f.path;
  const scene = LIMITS[opt.scene] ? opt.scene : 'comment';
  const maxSize = opt.maxSize || LIMITS[scene];

  let st;
  try { st = await fsp.stat(p); } catch { return { ok: false, reason: '文件不存在或不可读' }; }

  // L1 体积
  if (st.size <= 0) return { ok: false, reason: '文件为空' };
  if (st.size > maxSize) {
    return { ok: false, reason: `图片超过 ${(maxSize / 1048576).toFixed(0)}MB 限制` };
  }

  // L2 扩展名白名单
  const rawExt = extOf(f.originalname);
  if (!rawExt || !ALLOWED_EXT.has(rawExt)) {
    // 允许「无扩展名但内容合法」的图片（部分 App 分享时丢扩展名）
    if (rawExt) return { ok: false, reason: `不支持的图片格式 .${rawExt}` };
  }

  // L4 魔数
  const fd = await fsp.open(p, 'r');
  let head;
  try {
    head = Buffer.alloc(1024);
    await fd.read(head, 0, 1024, 0);
  } finally {
    try { await fd.close(); } catch {}
  }
  const fmt = sniffImage(head);
  if (!fmt) {
    return { ok: false, reason: '文件头校验失败：这不是有效的图片（疑似伪装文件）' };
  }
  // 扩展名与真实格式一致性检查（宽松：只拦明显冲突，如 .png 实为 jpg 也放行，
  // 因为部分工具会写错扩展名；但若声称 png 实为 mp4 这类跨类伪装必须拦）
  const mt = String(f.mimetype || '').toLowerCase();
  if (mt && !mt.startsWith('image/') && mt !== 'application/octet-stream') {
    return { ok: false, reason: `MIME 类型不被允许：${mt}` };
  }

  // L5 尺寸（防解码炸弹）
  const dim = await readSize(p);
  if (!dim || !dim.w || !dim.h) {
    return { ok: false, reason: '无法解析图片尺寸，文件可能已损坏' };
  }
  if (dim.w > MAX_DIMENSION || dim.h > MAX_DIMENSION) {
    return { ok: false, reason: `图片单边不能超过 ${MAX_DIMENSION}px（当前 ${dim.w}×${dim.h}）` };
  }
  if (dim.w * dim.h > MAX_PIXELS) {
    return { ok: false, reason: `图片像素总量过大（${(dim.w * dim.h / 1e6).toFixed(1)}MP），请压缩后再传` };
  }

  // L6 ffprobe 真实解码探测（确认不是「头部合法但数据全是垃圾」的构造文件）
  let probe = null;
  if (await hasFfprobe()) {
    probe = await ffprobeImage(p);
    // avif/bmp 的 ffprobe 支持度视构建而定 → 探测失败时降级信任头部结论
    if (!probe.ok && (fmt === 'jpg' || fmt === 'png' || fmt === 'gif' || fmt === 'webp')) {
      return { ok: false, reason: '无法解码该图片，判定为伪造或损坏文件' };
    }
  }

  return {
    ok: true,
    info: {
      format: fmt,
      ext: normExt(fmt),
      mime: EXT_MIME[normExt(fmt)] || 'application/octet-stream',
      width: probe && probe.width ? probe.width : dim.w,
      height: probe && probe.height ? probe.height : dim.h,
      animated: !!dim.animated,
      size: st.size,
    },
  };
}

/* ============================================================
 * L7 落盘（隔离存储）
 * ============================================================ */
async function ensureDirs() {
  await fsp.mkdir(IMAGE_DIR, { recursive: true });
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  try { await fsp.chmod(IMAGE_DIR, 0o700); } catch {}
  try { await fsp.chmod(THUMB_DIR, 0o700); } catch {}
  try { await fsp.chmod(TMP_DIR, 0o700); } catch {}
}

/**
 * 把校验通过的图片从临时目录移入正式存储，并顺带生成缩略图。
 *
 * @param {string} tmpPath
 * @param {object} info   validateImage 返回的 info
 * @returns {Promise<{ok:boolean, filename?:string, thumb?:string, w?:number, h?:number, reason?:string}>}
 */
async function commitImage(tmpPath, info, opt = {}) {
  await ensureDirs();
  const ext = info.ext || 'jpg';
  const name = safeFileName(ext);
  const dest = path.join(IMAGE_DIR, name);
  const thumbName = name.replace(/\.[^.]+$/, '.jpg');
  const thumbPath = path.join(THUMB_DIR, thumbName);

  try {
    try {
      await fsp.rename(tmpPath, dest);
    } catch (e) {
      if (e.code === 'EXDEV') {
        await fsp.copyFile(tmpPath, dest);
        await fsp.unlink(tmpPath);
      } else throw e;
    }
    await fsp.chmod(dest, 0o600);

    // 缩略图：动图与极小图不生成（动图生成缩略图会丢失动画且耗时；
    // 小图本身无需缩略）
    let thumb = '';
    if (!info.animated && opt.thumb !== false) {
      const ok = await makeThumb(dest, thumbPath);
      if (ok) {
        thumb = thumbName;
        try { await fsp.chmod(thumbPath, 0o600); } catch {}
      }
    }

    return { ok: true, filename: name, thumb, w: info.width, h: info.height };
  } catch (e) {
    return { ok: false, reason: '落盘失败：' + e.message.slice(0, 120) };
  }
}

/**
 * 生成缩略图（ffmpeg，等比缩放到最长边 THUMB_SIZE）。
 * 失败不抛错 —— 没有缩略图时前端回退用原图。
 */
function makeThumb(src, dest) {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', src,
       '-vf', `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=decrease`,
       '-frames:v', '1', '-q:v', '4', '-y', dest],
      { timeout: 30000 },
      (err) => resolve(!err && fs.existsSync(dest))
    );
  });
}

/** 安全删除（失败不抛） */
async function removeQuiet(p) {
  try { await fsp.unlink(p); } catch {}
}

/**
 * 安全解析存储文件名（防路径穿越）。
 * 只接受本模块生成的文件名格式：<数字>_<24位hex>.<白名单扩展名>
 * @returns {string|null} 绝对路径
 */
function resolveStored(name) {
  const b = path.basename(String(name || ''));
  if (!b || b !== String(name || '')) return null;
  // 兼容缩略图子目录：thumb/xxx.jpg
  if (/^thumb\/[0-9]+_[0-9a-f]+\.jpg$/.test(String(name))) {
    const full = path.join(IMAGE_DIR, String(name));
    if (!full.startsWith(THUMB_DIR + path.sep)) return null;
    return full;
  }
  if (!/^[0-9]+_[0-9a-f]+\.(jpg|jpeg|png|gif|webp|avif|bmp)$/.test(b)) return null;
  const full = path.join(IMAGE_DIR, b);
  if (!full.startsWith(IMAGE_DIR + path.sep)) return null;
  return full;
}

/** 解析缩略图路径 */
function resolveThumb(name) {
  const b = path.basename(String(name || ''));
  if (!/^[0-9]+_[0-9a-f]+\.jpg$/.test(b)) return null;
  const full = path.join(THUMB_DIR, b);
  if (!full.startsWith(THUMB_DIR + path.sep)) return null;
  return full;
}

/** 删除一张图片（原图 + 缩略图） */
async function removeImage(name) {
  const full = resolveStored(name);
  if (full) await removeQuiet(full);
  const thumbName = String(name || '').replace(/\.[^.]+$/, '.jpg');
  const t = resolveThumb(thumbName);
  if (t) await removeQuiet(t);
}

/**
 * 构造对外可访问的图片描述对象（前端直接用）。
 */
function imageView(rec, base = '/api/image') {
  if (!rec) return null;
  if (typeof rec === 'string') {
    // 兼容老数据：只存了文件名
    return { url: `${base}/${rec}`, thumb: `${base}/${rec}`, name: '', w: 0, h: 0, size: 0 };
  }
  return {
    url: `${base}/${rec.file}`,
    thumb: rec.thumb ? `${base}/thumb/${rec.thumb}` : `${base}/${rec.file}`,
    name: String(rec.name || '').slice(0, 120),
    w: rec.w || 0,
    h: rec.h || 0,
    size: rec.size || 0,
    animated: !!rec.animated,
  };
}

module.exports = {
  IMAGE_DIR,
  THUMB_DIR,
  TMP_DIR,
  LIMITS,
  MAX_DIMENSION,
  MAX_PIXELS,
  THUMB_SIZE,
  ALLOWED_EXT,
  EXT_MIME,
  ensureDirs,
  safeFileName,
  extOf,
  normExt,
  sniffImage,
  readSize,
  parseJpegSize,
  parseWebpSize,
  ffprobeImage,
  hasFfprobe,
  validateImage,
  commitImage,
  makeThumb,
  removeQuiet,
  removeImage,
  resolveStored,
  resolveThumb,
  imageView,
};
