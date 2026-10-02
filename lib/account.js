'use strict';
/**
 * 慈云影视 - 账号与安全工具
 * ============================================================
 * · 密码：PBKDF2-SHA512 加盐哈希（10 万次迭代），绝不存明文
 * · 会话：随机 token，服务端可撤销
 * · 校验：账号 / 密码强度 / 邮箱
 */

const crypto = require('crypto');

const ITER = 100000;
const KEYLEN = 64;
const DIGEST = 'sha512';

/** 生成密码哈希：pbkdf2$iter$salt$hash */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, ITER, KEYLEN, DIGEST).toString('hex');
  return `pbkdf2$${ITER}$${salt}$${hash}`;
}

/** 校验密码（兼容早期 sha256 明文单哈希记录，验证后自动升级） */
function verifyPassword(password, stored) {
  if (!stored) return { ok: false };
  const pwd = String(password || '');
  if (stored.startsWith('pbkdf2$')) {
    const [, iter, salt, hash] = stored.split('$');
    const calc = crypto.pbkdf2Sync(pwd, salt, parseInt(iter, 10) || ITER, KEYLEN, DIGEST).toString('hex');
    return { ok: timingEqual(calc, hash), needsUpgrade: false };
  }
  // 旧格式：sha256 单哈希
  const legacy = crypto.createHash('sha256').update(pwd).digest('hex');
  return { ok: timingEqual(legacy, stored), needsUpgrade: true };
}

/** 定时安全比较，防时序攻击 */
function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 生成登录 token */
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/* ------------------------- 校验规则 ------------------------- */

const RESERVED = ['admin', 'administrator', 'root', 'system', 'guest', 'null', 'undefined', 'official', 'owner'];

/** 账号：4-20 位，字母开头，允许字母/数字/下划线/中文昵称不做账号用 */
function checkAccount(account) {
  const a = String(account || '').trim();
  if (!a) return '请输入账号';
  if (a.length < 4 || a.length > 20) return '账号长度需 4-20 位';
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(a)) return '账号需字母开头，仅含字母、数字、下划线';
  if (RESERVED.includes(a.toLowerCase())) return '该账号为系统保留，请更换';
  return null;
}

/** 密码强度：至少 8 位，且包含字母与数字 */
function checkPassword(password) {
  const p = String(password || '');
  if (!p) return '请输入密码';
  if (p.length < 8) return '密码至少 8 位';
  if (p.length > 64) return '密码过长（最多 64 位）';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return '密码需同时包含字母和数字';
  const weak = ['12345678', 'password', 'admin888', '11111111', 'abc12345', 'qwertyui'];
  if (weak.includes(p.toLowerCase())) return '密码过于简单，请更换';
  return null;
}

/** 密码强度评分 0-4（前端展示用） */
function passwordScore(password) {
  const p = String(password || '');
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Za-z]/.test(p) && /[0-9]/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}

/** 昵称：1-16 位，过滤控制字符 */
function checkNickname(nick) {
  const n = String(nick || '').trim();
  if (!n) return null; // 允许为空，用账号兜底
  if (n.length > 16) return '昵称最多 16 个字';
  if (/[\u0000-\u001f<>]/.test(n)) return '昵称含非法字符';
  return null;
}

function checkEmail(email) {
  const e = String(email || '').trim();
  if (!e) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return '邮箱格式不正确';
  if (e.length > 64) return '邮箱过长';
  return null;
}

/** 由账号生成默认昵称与头像色 */
function defaultNickname(account) {
  return String(account || '用户').slice(0, 16);
}

module.exports = {
  hashPassword,
  verifyPassword,
  newToken,
  checkAccount,
  checkPassword,
  passwordScore,
  checkNickname,
  checkEmail,
  defaultNickname,
};
