'use strict';
/**
 * 慈云影视 · 邮件与邮箱验证码模块（零依赖）
 * ============================================================
 * · 原生 net/tls 实现 SMTP（SSL 465 / STARTTLS 587），不引入第三方包
 * · 验证码内存存储：6 位数字，5 分钟有效，一次性消费
 * · 发信未配置时自动降级：「开发模式」下验证码随接口返回，便于本地体验
 *
 * 场景（scene）：register 注册 / login 邮箱登录 / reset 找回密码 / bind 绑定邮箱
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

/* ============================================================
 * 验证码存储
 * ============================================================ */
const codes = new Map(); // key -> { code, expire, tries, scene, sentAt }
const CODE_TTL = 5 * 60 * 1000;      // 5 分钟
const SEND_COOLDOWN = 60 * 1000;     // 同邮箱 60 秒冷却
const MAX_VERIFY_TRIES = 5;          // 单个验证码最多校验 5 次

function keyOf(email, scene) {
  return `${String(email || '').trim().toLowerCase()}|${scene}`;
}

/** 是否处于冷却期 */
function inCooldown(email, scene) {
  const rec = codes.get(keyOf(email, scene));
  if (!rec) return 0;
  const left = rec.sentAt + SEND_COOLDOWN - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** 生成并保存验证码 */
function issueCode(email, scene) {
  const code = String(crypto.randomInt(100000, 1000000)); // 6 位，密码学安全随机
  codes.set(keyOf(email, scene), {
    code,
    expire: Date.now() + CODE_TTL,
    tries: 0,
    scene,
    sentAt: Date.now(),
  });
  return code;
}

/**
 * 校验验证码
 * @returns {{ok:boolean, error?:string}}
 */
function checkCode(email, code, scene) {
  const rec = codes.get(keyOf(email, scene));
  if (!rec) return { ok: false, error: '请先获取验证码' };
  if (Date.now() > rec.expire) {
    codes.delete(keyOf(email, scene));
    return { ok: false, error: '验证码已过期，请重新获取' };
  }
  rec.tries += 1;
  if (rec.tries > MAX_VERIFY_TRIES) {
    codes.delete(keyOf(email, scene));
    return { ok: false, error: '尝试次数过多，请重新获取验证码' };
  }
  // 定时安全比较
  const a = Buffer.from(String(code || ''));
  const b = Buffer.from(rec.code);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return { ok: false, error: `验证码错误（剩余 ${Math.max(0, MAX_VERIFY_TRIES - rec.tries)} 次）` };
  codes.delete(keyOf(email, scene)); // 一次性消费
  return { ok: true };
}

/* ============================================================
 * SMTP 发送（原生 socket 实现）
 * ============================================================ */
function encodeBase64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

/** 等待 SMTP 响应：读取到「最后一行」为止（多行响应以 `250-` 续行） */
function readReply(socket, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      // 逐行检查，最后一行形如 `250 xxx`（code + 空格）表示响应结束
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: buf });
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('SMTP 连接被关闭')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('SMTP 响应超时')); }, timeout);
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
    }
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
}

function send(socket, line) {
  return new Promise((resolve, reject) => {
    socket.write(line + '\r\n', (e) => (e ? reject(e) : resolve()));
  });
}

/**
 * 发送一封邮件
 * @param {object} cfg  { host, port, user, pass, from, secure }
 * @param {object} mail { to, subject, text, html }
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function sendMail(cfg, mail) {
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) {
    return { ok: false, error: '未配置 SMTP 服务' };
  }
  const port = Number(cfg.port) || 465;
  const useStartTls = cfg.secure === 'starttls' || port === 587;
  const from = cfg.from || cfg.user;
  const fromHeader = /<.+>/.test(from) ? from : `${from} <${cfg.user}>`;

  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { socket && socket.destroy(); } catch {} resolve(r); } };

    const onConnected = async (sock) => {
      socket = sock;
      try {
        let r = await readReply(sock);
        if (r.code !== 220) throw new Error('服务未就绪: ' + r.text);

        await send(sock, 'EHLO ciyun-tv');
        r = await readReply(sock);
        if (r.code !== 250) throw new Error('EHLO 失败: ' + r.text);

        if (useStartTls) {
          await send(sock, 'STARTTLS');
          r = await readReply(sock);
          if (r.code !== 220) throw new Error('STARTTLS 失败: ' + r.text);
          // 升级加密
          socket = tls.connect({ socket: sock, servername: cfg.host }, async () => {
            try {
              await send(socket, 'EHLO ciyun-tv');
              await readReply(socket);
              await authAndSend(socket);
            } catch (e) { done({ ok: false, error: e.message }); }
          });
          socket.on('error', (e) => done({ ok: false, error: e.message }));
          return;
        }
        await authAndSend(sock);
      } catch (e) {
        done({ ok: false, error: e.message });
      }
    };

    const authAndSend = async (sock) => {
      // AUTH LOGIN
      await send(sock, 'AUTH LOGIN');
      let r = await readReply(sock);
      if (r.code !== 334) throw new Error('AUTH LOGIN 失败: ' + r.text);
      await send(sock, encodeBase64(cfg.user));
      r = await readReply(sock);
      if (r.code !== 334) throw new Error('用户名被拒: ' + r.text);
      await send(sock, encodeBase64(cfg.pass));
      r = await readReply(sock);
      if (r.code !== 235) throw new Error('认证失败（请检查授权码）: ' + r.text);

      await send(sock, `MAIL FROM:<${cfg.user}>`);
      r = await readReply(sock);
      if (r.code !== 250) throw new Error('MAIL FROM 失败: ' + r.text);

      await send(sock, `RCPT TO:<${mail.to}>`);
      r = await readReply(sock);
      if (r.code !== 250 && r.code !== 251) throw new Error('收件人被拒: ' + r.text);

      await send(sock, 'DATA');
      r = await readReply(sock);
      if (r.code !== 354) throw new Error('DATA 失败: ' + r.text);

      const boundary = 'ciyun_' + crypto.randomBytes(8).toString('hex');
      const body =
        `From: ${fromHeader}\r\n` +
        `To: <${mail.to}>\r\n` +
        `Subject: =?UTF-8?B?${encodeBase64(mail.subject || '慈云影视')}?=\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n` +
        `Date: ${new Date().toUTCString()}\r\n` +
        `\r\n` +
        (mail.html || mail.text || '') +
        `\r\n.\r\n`;
      await send(sock, body);
      r = await readReply(sock);
      if (r.code !== 250) throw new Error('投递失败: ' + r.text);

      await send(sock, 'QUIT').catch(() => {});
      done({ ok: true });
    };

    const opts = { host: cfg.host, port };
    if (useStartTls) {
      const sock = net.connect(opts, () => onConnected(sock));
      sock.on('error', (e) => done({ ok: false, error: e.message }));
      sock.setTimeout(25000, () => done({ ok: false, error: 'SMTP 连接超时' }));
    } else {
      const sock = tls.connect({ ...opts, servername: cfg.host }, () => onConnected(sock));
      sock.on('error', (e) => done({ ok: false, error: e.message }));
      sock.setTimeout(25000, () => done({ ok: false, error: 'SMTP 连接超时' }));
    }
  });
}

/* ============================================================
 * 业务：发送验证码邮件
 * ============================================================ */
const SCENE_NAME = {
  register: '注册账号',
  login: '邮箱登录',
  reset: '重置密码',
  bind: '绑定邮箱',
};

function codeEmailHtml(code, scene) {
  const name = SCENE_NAME[scene] || '身份验证';
  return `<!doctype html><html><body style="margin:0;padding:32px;background:#0d0d12;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
  <div style="max-width:460px;margin:0 auto;background:#17171f;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.08)">
    <div style="background:linear-gradient(135deg,#e50914,#b20710);padding:22px 26px">
      <div style="color:#fff;font-size:18px;font-weight:700">慈云影视</div>
      <div style="color:rgba(255,255,255,.8);font-size:12.5px;margin-top:4px">身份验证邮件</div>
    </div>
    <div style="padding:26px;color:#f0f0f5">
      <p style="margin:0 0 16px;font-size:14px;line-height:1.7">你正在进行「${name}」操作，验证码为：</p>
      <div style="text-align:center;margin:22px 0">
        <div style="display:inline-block;background:rgba(229,9,20,.12);border:1px dashed rgba(229,9,20,.5);
                    border-radius:12px;padding:14px 28px;letter-spacing:8px;font-size:30px;font-weight:700;color:#ff6b6b">${code}</div>
      </div>
      <p style="margin:16px 0 0;font-size:13px;color:#9a9aa8;line-height:1.7">
        验证码 5 分钟内有效，请勿泄露给他人。<br>若非本人操作，忽略本邮件即可。
      </p>
    </div>
    <div style="padding:16px 26px;background:rgba(255,255,255,.02);border-top:1px solid rgba(255,255,255,.06);
                color:#6a6a78;font-size:12px">本邮件由系统自动发送，请勿直接回复。</div>
  </div></body></html>`;
}

/**
 * 发送场景验证码
 * @returns {Promise<{ok:boolean, error?:string, devCode?:string, cooldown?:number}>}
 */
async function sendCode(cfg, email, scene) {
  const to = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, error: '邮箱格式不正确' };

  const wait = inCooldown(to, scene);
  if (wait) return { ok: false, error: `请 ${wait} 秒后再试`, cooldown: wait };

  const code = issueCode(to, scene);
  const subject = `【慈云影视】${SCENE_NAME[scene] || '验证'}验证码：${code}`;

  // 未配置 SMTP → 开发模式：直接把验证码返回（仅本地体验）
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) {
    return { ok: true, devMode: true, devCode: code, error: undefined };
  }

  const r = await sendMail(cfg, { to, subject, html: codeEmailHtml(code, scene) });
  if (!r.ok) {
    // 发信失败 → 撤销验证码，避免用户拿到无效码
    codes.delete(keyOf(to, scene));
    return { ok: false, error: r.error || '邮件发送失败' };
  }
  return { ok: true };
}

module.exports = {
  sendCode,
  checkCode,
  issueCode,
  inCooldown,
  sendMail,
  codeEmailHtml,
  SCENE_NAME,
};
