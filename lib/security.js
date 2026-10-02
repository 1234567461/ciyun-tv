'use strict';
/**
 * 慈云影视 · 安全加固模块
 * ============================================================
 * 集中处理：
 *  1. 安全响应头（CSP / X-Frame-Options / nosniff / Referrer-Policy）
 *  2. 登录失败限流与渐进锁定（防暴力破解）
 *  3. SSRF 防护（/api/stream 上游地址白名单 + 内网地址拦截）
 *  4. 管理口令哈希存储与强度校验
 *  5. 简单内存限流器（通用）
 */

const crypto = require('crypto');
const net = require('net');
const dns = require('dns');
const { URL } = require('url');

/* ============================================================
 * 1. 安全响应头
 * ============================================================ */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // 现代浏览器已弃用，显式关闭避免错误拦截
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // 只对非流媒体接口加 CSP，避免破坏 hls.js / 第三方播放器
  if (!/^\/api\/(stream|hls|proxy)/.test(req.path)) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // 站内原生 JS 单页需 inline/eval；hls.js 以 blob: 注入 Web Worker 也需放行
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        "worker-src 'self' blob:",
        "child-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: data: https:",
        "connect-src 'self' https: blob: data:",
        "font-src 'self' data:",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    );
  }
  // 若经 HTTPS 反向代理访问，补 HSTS
  const proto = req.headers['x-forwarded-proto'] || '';
  if (proto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/* ============================================================
 * 2. 通用内存限流器（滑动窗口）
 * ============================================================ */
const buckets = new Map();

/**
 * @param {string} key   限流维度（如 `login:1.2.3.4`）
 * @param {object} opt   { window=60000, max=10 }
 * @returns {{ok:boolean, remaining:number, retryAfter:number}}
 */
function rateLimit(key, { window = 60000, max = 10 } = {}) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + window };
    buckets.set(key, b);
  }
  b.count += 1;
  const ok = b.count <= max;
  return {
    ok,
    remaining: Math.max(0, max - b.count),
    retryAfter: ok ? 0 : Math.ceil((b.reset - now) / 1000),
  };
}

/** 清空某个限流 key（如登录成功后） */
function rateLimitReset(key) {
  buckets.delete(key);
}

// 定期清理过期桶，防内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 5 * 60 * 1000).unref();

/* ============================================================
 * 3. 登录暴力破解防护（失败计数 + 渐进锁定）
 * ============================================================ */
const loginFails = new Map(); // ip -> { count, lockedUntil, firstAt }

const LOCK_STEPS = [0, 0, 0, 0, 0, 30, 60, 300, 900, 1800]; // 第 n 次失败后的锁定时长（秒）

function loginGuard(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return { ok: true };
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { ok: false, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { ok: true };
}

function loginFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0, firstAt: now };
  // 距首次失败超过 30 分钟，重新计数
  if (now - rec.firstAt > 30 * 60 * 1000) { rec.count = 0; rec.firstAt = now; }
  rec.count += 1;
  const lockSec = LOCK_STEPS[Math.min(rec.count, LOCK_STEPS.length - 1)] || 0;
  if (lockSec) rec.lockedUntil = now + lockSec * 1000;
  loginFails.set(ip, rec);
  return { count: rec.count, lockSec };
}

function loginOk(ip) {
  loginFails.delete(ip);
}

/* ============================================================
 * 4. SSRF 防护
 * ============================================================ */

/** 判断是否内网 / 保留地址（IPv4 + IPv6） */
function isPrivateAddress(ip) {
  if (!ip) return true;
  const t = String(ip).toLowerCase();
  if (net.isIPv6(t)) {
    if (t === '::1' || t === '::') return true;
    // fc00::/7 唯一本地、fe80::/10 链路本地
    if (/^f[cd][0-9a-f]{2}:/.test(t)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(t)) return true;
    // IPv4 映射：::ffff:10.0.0.1
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(t);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  const p = t.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;              // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;     // 私有
  if (a === 192 && b === 168) return true;              // 私有
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  if (a === 192 && b === 0) return true;                // 保留
  if (a >= 224) return true;                            // 组播 / 保留
  return false;
}

/**
 * 上游流地址白名单校验（防 SSRF）
 * @param {string} rawUrl
 * @returns {Promise<{ok:boolean, reason?:string, url?:string}>}
 */
async function checkUpstream(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { ok: false, reason: 'url required' };
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid url' };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: '仅支持 http/https' };

  // 禁止明显的内网主机名
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: '禁止访问内网地址' };
  }

  // DNS 解析后校验真实 IP，防 DNS Rebinding / 域名指向内网
  let addrs = [];
  try {
    if (net.isIP(host)) {
      addrs = [{ address: host }];
    } else {
      addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    }
  } catch (e) {
    return { ok: false, reason: '域名解析失败' };
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) return { ok: false, reason: '禁止访问内网地址' };
  }
  return { ok: true, url: u.toString() };
}

/* ============================================================
 * 5. 管理口令
 * ============================================================ */
const account = require('./account');

/** 生成管理口令哈希（复用 PBKDF2 方案） */
function hashAdminPassword(pwd) {
  return account.hashPassword(pwd);
}

/** 校验管理口令：兼容历史明文记录，验证成功后调用方应落库为哈希 */
function verifyAdminPassword(input, stored) {
  if (!stored) return { ok: false, legacy: false };
  if (String(stored).startsWith('pbkdf2$')) {
    return { ok: account.verifyPassword(input, stored).ok, legacy: false };
  }
  // 历史明文 → 定时安全比较
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(stored));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, legacy: true };
}

const WEAK_PASSWORDS = new Set([
  'admin', 'admin888', 'admin123', '123456', '12345678', 'password', 'root',
  'qwerty', '111111', 'abc123', 'letmein', 'administrator',
]);

/** 管理口令强度校验：≥8 位，含字母与数字，非弱口令 */
function checkAdminPassword(pwd) {
  const p = String(pwd || '');
  if (!p) return '请输入密码';
  if (p.length < 8) return '密码至少 8 位';
  if (p.length > 72) return '密码过长';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return '密码需同时包含字母和数字';
  if (WEAK_PASSWORDS.has(p.toLowerCase())) return '该密码过于常见，请更换';
  if (/^(.)\1+$/.test(p)) return '密码不能为重复字符';
  return '';
}

module.exports = {
  securityHeaders,
  rateLimit,
  rateLimitReset,
  loginGuard,
  loginFail,
  loginOk,
  isPrivateAddress,
  checkUpstream,
  hashAdminPassword,
  verifyAdminPassword,
  checkAdminPassword,
  WEAK_PASSWORDS,
};
