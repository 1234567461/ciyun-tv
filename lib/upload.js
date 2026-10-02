'use strict';
/**
 * 慈云影视 · 安全上传模块
 * ============================================================
 * 目标：让用户上传的视频「一定是视频」，杜绝恶意文件伪装。
 *
 * 七层纵深防御：
 *   L1 体积限制        —— 边收边计数，超限立即中断，防 DoS
 *   L2 扩展名白名单    —— 只接受 mp4/mov/m4v/webm/mkv/flv/avi
 *   L3 文件名消毒      —— 丢弃用户原名，服务端随机命名（防路径穿越 / XSS / RCE）
 *   L4 魔数(Magic)校验 —— 读文件头，校验真实容器格式（防 .php 改名 .mp4）
 *   L5 结构校验        —— 解析容器 box，确认含 moov/ftyp 等真实视频结构
 *   L6 ffprobe 探测    —— 必须解析出 1 条视频流且时长合法（终极判定）
 *   L7 存储隔离        —— 存 web 根之外 + Content-Disposition + nosniff，杜绝执行
 *
 * 任一层不通过 → 立即删除临时文件并拒绝。
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
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const TMP_DIR = path.join(os.tmpdir(), 'cinema-upload-tmp');

/** 允许的扩展名（小写，不含点） */
const ALLOWED_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'flv', 'avi', 'ts']);

/** 允许的 MIME 前缀/枚举 */
const ALLOWED_MIME = new Set([
  'video/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm',
  'video/x-matroska', 'video/x-flv', 'video/x-msvideo', 'video/avi',
  'video/mp2t', 'application/octet-stream', // 部分浏览器/系统给 octet-stream，靠魔数兜底
]);

/** 体积上限（默认 512MB） */
const MAX_SIZE = Number(process.env.UPLOAD_MAX_SIZE || 512 * 1024 * 1024);
/** 时长上限（秒，默认 2 小时） */
const MAX_DURATION = Number(process.env.UPLOAD_MAX_DURATION || 2 * 3600);
/** 时长下限（秒，默认 1 秒） */
const MIN_DURATION = 1;

/* ============================================================
 * L3 文件名消毒
 * ============================================================ */
/**
 * 生成安全的服务端文件名：时间戳 + 随机串 + 白名单扩展名。
 * 完全不使用用户提供的名字，从根上杜绝路径穿越 / 特殊字符攻击。
 */
function safeFileName(ext) {
  const e = ALLOWED_EXT.has(String(ext).toLowerCase()) ? String(ext).toLowerCase() : 'mp4';
  const rnd = crypto.randomBytes(12).toString('hex');
  return `${Date.now()}_${rnd}.${e}`;
}

/** 从原始文件名取扩展名（仅用于白名单比对，绝不用于落盘命名） */
function extOf(name) {
  const b = path.basename(String(name || '').replace(/\\/g, '/'));
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

/* ============================================================
 * L4 魔数校验（按容器格式校验文件头）
 * ============================================================ */
/**
 * 根据文件头判定真实容器类型。
 * @param {Buffer} head 文件前若干字节（建议 ≥ 64B）
 * @returns {string|null} 'mp4'|'mov'|'webm'|'mkv'|'flv'|'avi'|'ts' 或 null
 */
function sniffContainer(head) {
  if (!head || head.length < 12) return null;

  // ISO BMFF (mp4/m4v/mov)：偏移 4 起为 'ftyp'
  if (head.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.slice(8, 12).toString('latin1');
    if (/^(qt|isom|mp4|iso2|avc1|M4V|dash|iso[5-9])/.test(brand)) return 'mp4';
    return 'mp4';
  }

  // EBML (webm/mkv)：1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const s = head.slice(0, 64).toString('latin1');
    if (s.includes('webm')) return 'webm';
    if (s.includes('matroska')) return 'mkv';
    return 'mkv';
  }

  // FLV：'FLV' + 版本
  if (head.slice(0, 3).toString('latin1') === 'FLV') return 'flv';

  // AVI：RIFF....AVI 
  if (head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'AVI ') return 'avi';

  // MPEG-TS：同步字节 0x47，且每 188 字节重复 0x47
  if (head[0] === 0x47 && head.length >= 377 && head[188] === 0x47 && head[376] === 0x47) return 'ts';

  // ASF/WMV：30 26 B2 75
  if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) return 'asf';

  return null;
}

/**
 * L5 结构校验：MP4/MOV 需在文件里找到 moov（或 mdat）box，
 * 防止「只有 ftyp 头的空壳文件」或伪造头。
 * @param {string} filePath
 */
async function validateMp4Structure(filePath) {
  const fd = await fsp.open(filePath, 'r');
  try {
    const size = (await fd.stat()).size;
    // 扫描前 2MB 与后 2MB（moov 可能在文件尾部，需 faststart 或尾部索引）
    const readAt = async (start, len) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, size - start)));
      if (buf.length === 0) return Buffer.alloc(0);
      await fd.read(buf, 0, buf.length, start);
      return buf;
    };
    const head = await readAt(0, Math.min(2 * 1024 * 1024, size));
    const tail = size > 2 * 1024 * 1024 ? await readAt(Math.max(0, size - 2 * 1024 * 1024), 2 * 1024 * 1024) : Buffer.alloc(0);
    const hay = Buffer.concat([head, tail]).toString('latin1');
    const hasMoov = hay.includes('moov');
    const hasMdat = hay.includes('mdat');
    return { ok: hasMoov, hasMoov, hasMdat };
  } finally {
    await fd.close();
  }
}

/* ============================================================
 * L6 ffprobe 真实探测
 * ============================================================ */
/** 是否安装 ffprobe */
let _ffprobeOk = null;
async function hasFfprobe() {
  if (_ffprobeOk !== null) return _ffprobeOk;
  _ffprobeOk = await new Promise((resolve) => {
    execFile('ffprobe', ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
  return _ffprobeOk;
}

/**
 * 用 ffprobe 探测媒体信息。
 * @returns {Promise<{ok:boolean, streams:Array, duration:number, error?:string}>}
 */
function ffprobe(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-analyzeduration', '10000000',   // 允许 10s 探测
        '-probesize', '10000000',
        '-show_entries', 'stream=index,codec_type,codec_name,width,height',
        '-show_entries', 'format=duration,format_name',
        '-of', 'json',
        filePath,
      ],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, streams: [], duration: 0, error: err.message.slice(0, 200) });
        try {
          const j = JSON.parse(stdout);
          const streams = j.streams || [];
          const duration = Number((j.format && j.format.duration) || 0);
          resolve({ ok: true, streams, duration, format: (j.format && j.format.format_name) || '' });
        } catch (e) {
          resolve({ ok: false, streams: [], duration: 0, error: 'ffprobe 输出解析失败' });
        }
      }
    );
  });
}

/* ============================================================
 * 主校验流程
 * ============================================================ */
/**
 * 对一个已落盘到临时目录的文件做全量安全校验。
 *
 * @param {object} f  { path, size, originalname, mimetype }
 * @returns {Promise<{ok:boolean, reason?:string, info?:object}>}
 */
async function validateUpload(f) {
  const p = f.path;
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    return { ok: false, reason: '文件不存在或不可读' };
  }

  // L1 体积
  if (st.size <= 0) return { ok: false, reason: '文件为空' };
  if (st.size > MAX_SIZE) return { ok: false, reason: `文件超过上限 ${(MAX_SIZE / 1048576).toFixed(0)}MB` };

  // L2 扩展名白名单
  const ext = extOf(f.originalname);
  if (!ext || !ALLOWED_EXT.has(ext)) {
    return { ok: false, reason: `不支持的文件类型 .${ext || '(无扩展名)'}` };
  }

  // L4 魔数校验
  const fd = await fsp.open(p, 'r');
  let head;
  try {
    head = Buffer.alloc(512);
    await fd.read(head, 0, 512, 0);
  } finally {
    await fd.close();
  }
  const container = sniffContainer(head);
  if (!container) {
    return { ok: false, reason: '文件头校验失败：这不是有效的视频容器格式（疑似伪装文件）' };
  }
  // 展示层 MIME 与真实容器一致性（宽松比对，仅做告警性拦截）
  const mt = String(f.mimetype || '').toLowerCase();
  if (mt && !ALLOWED_MIME.has(mt) && !mt.startsWith('video/')) {
    return { ok: false, reason: `MIME 类型不被允许：${mt}` };
  }

  // L5 结构校验（MP4/MOV 家族）
  if (container === 'mp4') {
    const s = await validateMp4Structure(p);
    if (!s.ok) return { ok: false, reason: 'MP4 结构校验失败：缺少 moov 元数据（文件损坏或伪造）' };
  }

  // L6 ffprobe 终极判定
  if (await hasFfprobe()) {
    const info = await ffprobe(p);
    if (!info.ok) return { ok: false, reason: 'ffprobe 无法解析该文件，判定为非视频：' + (info.error || '') };
    const v = (info.streams || []).filter((s) => s.codec_type === 'video');
    if (!v.length) return { ok: false, reason: '未检测到视频流（可能只有音频或为伪造文件）' };
    if (info.duration && info.duration > MAX_DURATION) {
      return { ok: false, reason: `视频时长超过上限 ${(MAX_DURATION / 3600).toFixed(1)} 小时` };
    }
    if (info.duration && info.duration < MIN_DURATION) {
      return { ok: false, reason: '视频时长过短' };
    }
    return {
      ok: true,
      info: {
        container,
        duration: Math.round(info.duration || 0),
        width: v[0].width || 0,
        height: v[0].height || 0,
        videoCodec: v[0].codec_name || '',
        audioCodec: (info.streams || []).find((s) => s.codec_type === 'audio')?.codec_name || '',
        hasAudio: (info.streams || []).some((s) => s.codec_type === 'audio'),
        size: st.size,
      },
    };
  }

  // 无 ffprobe 时的降级：至少魔数 + 结构已通过
  return {
    ok: true,
    info: { container, duration: 0, width: 0, height: 0, size: st.size, degraded: true },
  };
}

/* ============================================================
 * L7 落盘（隔离存储）
 * ============================================================ */
async function ensureDirs() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  // 目录权限收紧（仅属主可读写执行）
  try { await fsp.chmod(UPLOAD_DIR, 0o700); } catch {}
  try { await fsp.chmod(TMP_DIR, 0o700); } catch {}
}

/**
 * 把校验通过的文件从临时目录移到正式存储（原子 move，同盘）。
 * @returns {Promise<{ok:boolean, filename?:string, rel?:string, reason?:string}>}
 */
async function commitFile(tmpPath, ext) {
  await ensureDirs();
  const name = safeFileName(ext);
  const dest = path.join(UPLOAD_DIR, name);
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
    return { ok: true, filename: name, rel: name };
  } catch (e) {
    return { ok: false, reason: '落盘失败：' + e.message.slice(0, 120) };
  }
}

/** 安全删除（失败不抛） */
async function removeQuiet(p) {
  try { await fsp.unlink(p); } catch {}
}

/** 安全解析用户给定的存储文件名（防路径穿越） */
function resolveStored(name) {
  const b = path.basename(String(name || ''));
  if (!b || b !== String(name || '') || !/^[0-9]+_[0-9a-f]+\.(mp4|m4v|mov|webm|mkv|flv|avi|ts)$/.test(b)) return null;
  const full = path.join(UPLOAD_DIR, b);
  // 双保险：解析后的真实路径必须仍在 UPLOAD_DIR 内
  if (!full.startsWith(UPLOAD_DIR + path.sep)) return null;
  return full;
}

module.exports = {
  UPLOAD_DIR,
  TMP_DIR,
  MAX_SIZE,
  MAX_DURATION,
  ALLOWED_EXT,
  ensureDirs,
  safeFileName,
  extOf,
  sniffContainer,
  validateMp4Structure,
  validateUpload,
  ffprobe,
  hasFfprobe,
  commitFile,
  removeQuiet,
  resolveStored,
};
