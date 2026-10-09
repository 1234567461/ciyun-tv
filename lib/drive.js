'use strict';
/**
 * 慈云影视 · 云盘存储引擎
 * ============================================================
 * 设计取舍说明（为什么是这样而不是那样）：
 *
 * 1. 为什么不做真·分布式对象存储？
 *    这是个单机 Node 应用，用户是同一批看电影的人。上 MinIO/S3 会引入
 *    一整套运维负担，收益几乎为零。所以走「本地隔离目录 + 扁平节点表」，
 *    但把接口设计成可替换的（storagePath / resolve 都在这一层），
 *    将来真要接对象存储只需换掉这层的 4 个函数。
 *
 * 2. 为什么文件不放在 public 下？
 *    云盘文件是「私有的」，放 public 等于全网可猜 URL 下载。所以放进
 *    data/uploads/drive/（web 根之外），一切访问都必须经过
 *    /api/drive/file/:id 走鉴权 + 归属校验。
 *
 * 3. 为什么配额要「写入前预检 + 边写边计数」双保险？
 *    只做写入前预检，用户传一个 10GB 文件而配额只剩 1GB 时，仍会先写满
 *    磁盘再被拒 —— 磁盘已经被撑爆了。所以接收过程中持续累计，一旦超过
 *    剩余配额立刻断流并删除半成品。
 *
 * 4. 分享链接为什么用随机 token 而不是自增 id？
 *    自增 id 可被遍历（/d/1 /d/2 ...），等于全站文件可被爬。token 用
 *    16 字节随机，且支持设密码与有效期。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { store } = require('./store');

/* ============================================================
 * 路径与常量
 * ============================================================ */
const DRIVE_DIR = process.env.DRIVE_DIR || path.join(__dirname, '..', 'data', 'uploads', 'drive');
const TMP_DIR = path.join(os.tmpdir(), 'cinema-drive-tmp');

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * 内部哨兵：调用方已用其他凭据（已验证的 cookie）通过校验，
 * 本次跳过提取码比对。用一个绝不会等于真实提取码的符号，
 * 比传 null/false 更不容易被误用。
 */
const SKIP_PASSWORD = Symbol('share-password-skipped');

/** 会员档位顺序（配额叠加时用） */
const PLAN_KEYS = ['month', 'quarter', 'year', 'forever'];

/** 允许上传的文件类型（扩展名白名单） */
const ALLOWED_EXT = new Set([
  // 图片
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg',
  // 视频
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'ts',
  // 音频
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
  // 文档
  'txt', 'md', 'pdf', 'epub', 'mobi', 'azw3', 'cbz', 'cbr',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv',
  // 压缩包
  'zip', 'rar', '7z', 'tar', 'gz',
  // 漫画/小说常见格式已在上面（cbz/cbr/epub/txt）
]);

/** 明确禁止的高危扩展名（即使白名单被误加也要拦） */
const BLOCKED_EXT = new Set([
  'php', 'php3', 'php4', 'php5', 'phtml', 'phar', 'pht',
  'jsp', 'jspx', 'asp', 'aspx', 'ashx', 'asmx', 'cgi', 'pl', 'py', 'rb',
  'sh', 'bash', 'zsh', 'so', 'dll', 'exe', 'msi', 'bat', 'cmd', 'com', 'scr',
  'js', 'mjs', 'html', 'htm', 'xhtml', 'svgz', 'htaccess',
]);

/** 可在线预览的类型 */
const PREVIEW_KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'flv', 'ts'],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'],
  text: ['txt', 'md', 'csv', 'json', 'log'],
  pdf: ['pdf'],
};

/* ============================================================
 * 工具
 * ============================================================ */
/** 取扩展名（小写、无点） */
function extOf(name) {
  const b = path.basename(String(name || '').replace(/\\/g, '/'));
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

/** 去掉扩展名的基名 */
function baseOf(name) {
  const b = path.basename(String(name || ''));
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

/**
 * 文件名消毒：只保留安全字符，防止
 *   · 路径穿越（../）
 *   · 控制字符（换行注入响应头）
 *   · 超长文件名撑爆文件系统
 * 注意：这里保留中文 —— 用户在云盘里改名是常见操作。
 */
function sanitizeName(name, fallback = '未命名') {
  let s = String(name == null ? '' : name);
  // 去掉路径分隔符与控制字符
  s = s.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '');
  // 剥离「..」穿越序列：
  //   只把 / 换成 _ 是不够的 —— "..\/..\/etc/passwd" 会变成 ".._.._etc_passwd"，
  //   虽然落盘安全（存的其实是随机文件名），但展示给用户时看着像被入侵过，
  //   而且后续写日志/拼路径时是一颗定时炸弹。这里直接删掉。
  s = s.replace(/\.{2,}/g, '');
  // 去掉纯点名（"."、"..." 之类）
  s = s.replace(/^\.+$/, '');
  // 开头的点会生成隐藏文件，也可能被某些工具特殊处理，一并去掉
  s = s.replace(/^\.+/, '');
  s = s.trim();
  if (!s) s = fallback;
  // 限制长度（按字符数，避免多字节截断问题先用 Array.from）
  const arr = Array.from(s);
  if (arr.length > 120) s = arr.slice(0, 120).join('');
  return s;
}

/** 生成存储文件名（随机，与用户可见名解耦） */
function storageName(ext) {
  const e = ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
  return `${Date.now()}_${crypto.randomBytes(12).toString('hex')}.${e}`;
}

/** 生成分享 token（16 字节，URL 安全） */
function shareToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/** 生成 4 位提取码（去掉易混淆字符 0/O/1/I/l） */
function extractCode() {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  let out = '';
  const buf = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

/** 安全解析存储路径（防穿越） */
function resolveFile(storageNameStr) {
  const b = path.basename(String(storageNameStr || ''));
  if (!b || b !== String(storageNameStr || '')) return null;
  if (!/^[0-9]+_[0-9a-f]+\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|mp4|m4v|mov|webm|mkv|avi|flv|ts|mp3|m4a|aac|flac|wav|ogg|opus|txt|md|pdf|epub|mobi|azw3|cbz|cbr|doc|docx|xls|xlsx|ppt|pptx|csv|zip|rar|7z|tar|gz|bin)$/.test(b)) {
    return null;
  }
  const full = path.join(DRIVE_DIR, b);
  if (!full.startsWith(DRIVE_DIR + path.sep)) return null;
  return full;
}

async function ensureDirs() {
  await fsp.mkdir(DRIVE_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  try { await fsp.chmod(DRIVE_DIR, 0o700); } catch {}
  try { await fsp.chmod(TMP_DIR, 0o700); } catch {}
}

async function removeQuiet(p) {
  try { await fsp.unlink(p); } catch {}
}

/* ============================================================
 * 配额计算
 * ============================================================
 * 总额度 = 免费基础配额 + 会员档位配额 + 已购空间包
 * 三者独立累加，会员过期后档位配额自动失效（空间包永久保留）。
 */

/**
 * 计算某用户的云盘总配额（字节）。
 * @param {object} user 用户对象（可含 vip / driveExtraMB）
 * @returns {object} { totalBytes, freeBytes, vipBytes, packBytes }
 */
function quotaOf(user) {
  const cfg = (store.settings && store.settings.drive) || {};
  const freeBytes = Math.max(0, Number(cfg.freeQuotaMB || 0)) * MB;

  // 会员档位：取用户当前生效的最高档（不叠加，避免买月卡+年卡重复扩容）
  let vipBytes = 0;
  const now = Date.now();
  const vip = user && user.vip;
  if (vip && vip.expire > now) {
    const plan = String(vip.lastPlan || vip.level || '');
    const table = cfg.planQuotaMB || {};
    // 逐档比对，取命中的最大配额（兼容历史 plan 命名不一致）
    for (const k of PLAN_KEYS) {
      if (plan.includes(k) || String(vip.level || '').includes(k)) {
        vipBytes = Math.max(vipBytes, Number(table[k] || 0) * MB);
      }
    }
    // admin 无限
    if (String(vip.level) === 'admin' || vip.permanent) {
      vipBytes = Math.max(vipBytes, Number(table.forever || 0) * MB);
    }
    // 兜底：是会员但档位识别不出来 → 给最低档配额
    if (!vipBytes) vipBytes = Number(table.month || 0) * MB;
  }

  // 空间包（用户字段 driveExtraMB，购买后累加，永久有效）
  const packBytes = Math.max(0, Number((user && user.driveExtraMB) || 0)) * MB;

  return {
    totalBytes: freeBytes + vipBytes + packBytes,
    freeBytes,
    vipBytes,
    packBytes,
  };
}

/**
 * 配额视图（给前端用）。
 * @param {object} user
 * @returns {object} { totalBytes, usedBytes, ... , percent, full }
 */
function quotaView(user) {
  const q = quotaOf(user);
  const used = store.driveUsage(user.account);
  const total = q.totalBytes;
  const usedBytes = used.bytes;
  const percent = total > 0 ? Math.min(100, Math.round((usedBytes / total) * 1000) / 10) : 100;
  return {
    totalBytes: total,
    usedBytes,
    remainBytes: Math.max(0, total - usedBytes),
    files: used.files,
    percent,
    full: total > 0 && usedBytes >= total,
    // 明细，便于前端展示「免费 2GB + 会员 50GB + 空间包 10GB」
    freeBytes: q.freeBytes,
    vipBytes: q.vipBytes,
    packBytes: q.packBytes,
  };
}

/**
 * 判断能否再写入 needBytes。
 * @returns {{ok:boolean, reason?:string, remainBytes:number}}
 */
function canWrite(user, needBytes) {
  const v = quotaView(user);
  if (v.totalBytes <= 0) {
    return { ok: false, reason: '当前账号未开通云盘空间', remainBytes: 0 };
  }
  if (v.usedBytes + needBytes > v.totalBytes) {
    const over = v.usedBytes + needBytes - v.totalBytes;
    return {
      ok: false,
      remainBytes: v.remainBytes,
      reason: `空间不足：还需 ${fmtSize(over)}，当前剩余 ${fmtSize(v.remainBytes)}`,
    };
  }
  return { ok: true, remainBytes: v.remainBytes };
}

/** 人类可读体积 */
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < MB) return (b / 1024).toFixed(1) + ' KB';
  if (b < GB) return (b / MB).toFixed(1) + ' MB';
  return (b / GB).toFixed(2) + ' GB';
}

/* ============================================================
 * 视图
 * ============================================================ */
/** 节点 → 前端视图 */
function nodeView(n, opt = {}) {
  if (!n) return null;
  const ext = n.ext || extOf(n.name);
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    parent: n.parent || '',
    size: n.size || 0,
    sizeText: fmtSize(n.size || 0),
    ext,
    mime: n.mime || '',
    w: n.w || 0,
    h: n.h || 0,
    // 文件给下载/预览地址；文件夹给空
    url: n.type === 'file' ? `/api/drive/file/${n.id}` : '',
    preview: n.type === 'file' ? previewKind(ext) : '',
    thumb: n.type === 'file' && isImageExt(ext) && n.imgFile
      ? `/api/image/thumb/${n.imgFile}` : '',
    downloads: n.downloads || 0,
    createdAt: n.createdAt || 0,
    updatedAt: n.updatedAt || 0,
    trashed: !!n.trashed,
    trashedAt: n.trashedAt || 0,
    ...(opt.extra || {}),
  };
}

function isImageExt(ext) {
  return PREVIEW_KINDS.image.includes(String(ext || '').toLowerCase());
}

/** 预览类型：image | video | audio | text | pdf | '' */
function previewKind(ext) {
  const e = String(ext || '').toLowerCase();
  for (const [k, list] of Object.entries(PREVIEW_KINDS)) {
    if (list.includes(e)) return k;
  }
  return '';
}

/* ============================================================
 * 文件校验（上传前）
 * ============================================================
 * 云盘允许的类型比视频/图片模块宽（要能存文档、压缩包、电子书），
 * 因此不能靠「魔数必须匹配某一种格式」来判，改用「黑名单 + 魔数负向校验」：
 *   · 扩展名不在白名单 → 拒
 *   · 扩展名在高危黑名单 → 拒（双保险）
 *   · 魔数命中可执行文件特征（ELF / PE / Mach-O / shebang）→ 拒
 * 这样就既能存 zip/pdf/epub，又不会让 .exe 改名 .zip 混进来。
 */
const EXEC_MAGIC = [
  { name: 'ELF', test: (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 },
  { name: 'PE/EXE', test: (b) => b[0] === 0x4d && b[1] === 0x5a },                              // MZ
  { name: 'Mach-O', test: (b) => [0xfeedface, 0xfeedfacf, 0xcafebabe].some((m) => b.readUInt32BE(0) === m >>> 0) },
  { name: 'Java class', test: (b) => b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe },
  { name: 'shell script', test: (b) => b.slice(0, 2).toString('latin1') === '#!' },
  { name: 'Windows 批处理', test: (b) => /^@?echo\s|^@echo/i.test(b.slice(0, 16).toString('latin1')) },
  // 动态库
  { name: '共享库', test: (b) => b.slice(1, 4).toString('latin1') === 'ELF' },
];

/**
 * 校验云盘上传的文件头。
 * @returns {{ok:boolean, reason?:string, isImage:boolean}}
 */
async function sniffFile(filePath, origName) {
  const ext = extOf(origName);

  if (!ext) return { ok: false, reason: '文件缺少扩展名' };
  if (BLOCKED_EXT.has(ext)) return { ok: false, reason: `出于安全考虑，不允许上传 .${ext} 文件` };
  if (!ALLOWED_EXT.has(ext)) return { ok: false, reason: `不支持的文件类型 .${ext}` };

  // 可执行文件魔数负向校验
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    const head = Buffer.alloc(64);
    await fd.read(head, 0, 64, 0);

    for (const m of EXEC_MAGIC) {
      try {
        if (m.test(head)) {
          return { ok: false, reason: `检测到可执行文件特征（${m.name}），已拒绝` };
        }
      } catch { /* 某些 test 需要更长缓冲，忽略 */ }
    }

    // 图片走图片模块的魔数识别，识别成功则标记（后续生成缩略图）
    const img = require('./image');
    const fmt = img.sniffImage(head);
    return { ok: true, isImage: !!fmt, imageFormat: fmt || '' };
  } catch (e) {
    return { ok: false, reason: '读取文件失败：' + e.message.slice(0, 80) };
  } finally {
    if (fd) { try { await fd.close(); } catch {} }
  }
}

/* ============================================================
 * 路径解析（云盘内的「当前目录」概念）
 * ============================================================ */
/**
 * 校验文件夹归属并返回规范化 parent id。
 * 空字符串代表根目录。
 */
function normParent(account, parent) {
  const p = String(parent || '');
  if (!p) return '';
  const node = store.findDriveNode(p, account);
  if (!node || node.type !== 'folder' || node.trashed) return null;
  return p;
}

/** 面包屑：从根到当前目录 */
function breadcrumb(account, folderId) {
  const out = [];
  let cur = folderId;
  let guard = 0;
  while (cur && guard++ < 100) {
    const n = store.findDriveNode(cur, account);
    if (!n) break;
    out.unshift({ id: n.id, name: n.name });
    cur = n.parent;
  }
  return out;
}

/** 同目录下是否已存在同名（重名自动加 (1)(2)） */
function uniqueName(account, parent, name, excludeId) {
  const siblings = store.driveNodes(account, { parent: parent || '' }).filter((n) => n.id !== excludeId);
  const taken = new Set(siblings.map((n) => n.name));
  if (!taken.has(name)) return name;

  const base = baseOf(name);
  const ext = extOf(name);
  const suffix = ext ? '.' + ext : '';
  for (let i = 1; i < 1000; i++) {
    const cand = `${base} (${i})${suffix}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base} (${Date.now()})${suffix}`;
}

/* ============================================================
 * 分享链接
 * ============================================================ */
/**
 * 创建分享。
 * @param {object} user
 * @param {string} nodeId
 * @param {object} opt { password, expireDays }
 */
function createShare(user, nodeId, opt = {}) {
  const cfg = (store.settings && store.settings.drive) || {};
  if (cfg.allowShare === false) return { ok: false, reason: '本站已关闭分享功能' };

  const node = store.findDriveNode(nodeId, user.account);
  if (!node || node.trashed) return { ok: false, reason: '文件不存在' };

  // 已有未过期分享则直接复用（避免同一文件生成一堆链接）
  const exist = store.findShareByNode(nodeId);
  if (exist) {
    return {
      ok: true,
      share: shareView(exist, node),
      reused: true,
    };
  }

  let password = String(opt.password || '').trim().slice(0, 16);
  if (!password && cfg.shareNeedPassword) password = extractCode();

  const maxDays = Number(cfg.shareMaxDays || 30);
  let expireDays = Number(opt.expireDays || 0);
  if (expireDays > 0) expireDays = Math.min(expireDays, maxDays);
  const expiresAt = expireDays > 0 ? Date.now() + expireDays * 86400000 : 0;

  const rec = store.addDriveShare({
    nodeId,
    account: user.account,
    token: shareToken(),
    password,
    expiresAt,
  });
  return { ok: true, share: shareView(rec, node) };
}

/** 分享 → 视图 */
function shareView(s, node) {
  if (!s) return null;
  const now = Date.now();
  const expired = !!(s.expiresAt && s.expiresAt <= now);
  return {
    id: s.id,
    nodeId: s.nodeId,
    token: s.token,
    // 走前端 hash 路由（#/s/<token>），这样分享页能跟站点同一套 UI
    url: `/#/s/${s.token}`,
    hasPassword: !!s.password,
    password: s.password || '',
    expiresAt: s.expiresAt || 0,
    expired,
    revoked: !!s.revoked,
    views: s.views || 0,
    downloads: s.downloads || 0,
    createdAt: s.createdAt || 0,
    name: node ? node.name : '',
    type: node ? node.type : 'file',
    size: node ? node.size || 0 : 0,
    sizeText: fmtSize(node ? node.size || 0 : 0),
  };
}

/**
 * 校验并取出分享（含密码与过期检查）。
 *
 * @param {string} token
 * @param {string} password  提取码；传 SKIP_PASSWORD 表示调用方已通过
 *                           其他方式（如已验证的 cookie）确认过身份，
 *                           本次跳过密码比对。
 * @returns {{ok:boolean, reason?:string, code?:string, share?:object, node?:object}}
 */
function accessShare(token, password) {
  const s = store.findDriveShare({ token: String(token || '') });
  if (!s) return { ok: false, code: 'not_found', reason: '分享不存在或已被取消' };
  if (s.revoked) return { ok: false, code: 'revoked', reason: '该分享已被取消' };
  if (s.expiresAt && s.expiresAt <= Date.now()) return { ok: false, code: 'expired', reason: '该分享已过期' };

  if (s.password) {
    // 已通过 cookie 验证 → 跳过密码比对
    if (password !== SKIP_PASSWORD) {
      if (!password) return { ok: false, code: 'need_password', reason: '请输入提取码' };
      if (String(password).trim().toLowerCase() !== String(s.password).toLowerCase()) {
        return { ok: false, code: 'bad_password', reason: '提取码不正确' };
      }
    }
  }

  const node = store.findDriveNode(s.nodeId);
  if (!node || node.trashed) return { ok: false, code: 'gone', reason: '分享的文件已被删除' };

  return { ok: true, share: s, node };
}

/* ============================================================
 * 清理：回收站过期文件
 * ============================================================ */
/**
 * 清理超过保留期的回收站项目（物理删文件 + 删节点）。
 * 由定时任务调用。
 */
async function purgeTrash() {
  const cfg = (store.settings && store.settings.drive) || {};
  const keepDays = Number(cfg.trashKeepDays || 30);
  if (keepDays <= 0) return { removed: 0 };

  const cutoff = Date.now() - keepDays * 86400000;
  const all = store.getDriveNodesRaw ? store.getDriveNodesRaw() : [];
  const victims = all.filter((n) => n.trashed && n.trashedAt && n.trashedAt < cutoff);
  const ids = victims.map((n) => n.id);

  for (const n of victims) {
    if (n.type === 'file' && n.file) {
      const full = resolveFile(n.file);
      if (full) await removeQuiet(full);
    }
  }
  if (ids.length) store.removeDriveNodes(ids);
  return { removed: ids.length };
}

module.exports = {
  DRIVE_DIR,
  TMP_DIR,
  MB,
  GB,
  ALLOWED_EXT,
  BLOCKED_EXT,
  PREVIEW_KINDS,
  PLAN_KEYS,
  SKIP_PASSWORD,

  extOf,
  baseOf,
  sanitizeName,
  storageName,
  shareToken,
  extractCode,
  resolveFile,
  ensureDirs,
  removeQuiet,

  quotaOf,
  quotaView,
  canWrite,
  fmtSize,

  nodeView,
  previewKind,
  isImageExt,
  sniffFile,
  normParent,
  breadcrumb,
  uniqueName,

  createShare,
  shareView,
  accessShare,
  purgeTrash,
};
