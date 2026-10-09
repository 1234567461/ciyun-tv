/* 图片能力回归：评论 / 聊天室 / 弹幕 / 私信 发图 + 相册 + 云盘
 * ------------------------------------------------------------
 * 覆盖点：
 *  1) 图片上传接口（能力探测、未登录拒绝、登录后上传成功）
 *  2) 图片安全（伪装文件、解码炸弹、路径穿越）
 *  3) 图文评论 / 纯图片评论 / 回复带图
 *  4) 聊天室发图（含纯图片消息）
 *  5) 弹幕发图（一条最多 1 张）
 *  6) 私信发图
 *  7) 相册列表能查到上面发的图
 * 运行：node test/media-images.js  （需服务已在 8811 运行）
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = process.env.CIYUN_BASE || 'http://127.0.0.1:8811';
let pass = 0, fail = 0;
const P = (ok, label, extra) => {
  console.log((ok ? '  ✅' : '  ❌'), label + (extra ? '  ' + extra : ''));
  ok ? pass++ : fail++;
};
const section = (t) => console.log('\n【' + t + '】');

/* 站点对发言有间隔限流（约 15s），测试连续发帖会被挡。
 * 这不是功能问题，但会让断言假失败 —— 所以遇到限流就等待重试。 */
async function withRetry(fn, tries = 4, waitMs = 8000) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    const err = last && last.data && last.data.error;
    if (last.status !== 429 && !(err && /太快|频繁|稍候/.test(String(err)))) return last;
    if (i < tries - 1) {
      process.stdout.write(`    ⏳ 触发限流，等待 ${waitMs / 1000}s 重试…\n`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return last;
}

/* ------------------ 极简 HTTP 客户端（带 cookie 罐） ------------------ */
function mkClient() {
  const jar = new Map();
  return {
    jar,
    cookieHeader() {
      return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
    },
    absorb(res) {
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of sc) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
    },
    async req(method, url, body, opt = {}) {
      const headers = {};
      const ch = this.cookieHeader();
      if (ch && !opt.noCookie) headers.Cookie = ch;
      let payload = body;
      if (body && !(body instanceof FormData) && typeof body === 'object') {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      if (opt.headers) Object.assign(headers, opt.headers);
      const res = await fetch(BASE + url, { method, headers, body: payload });
      if (!opt.noCookie) this.absorb(res);
      const ct = res.headers.get('content-type') || '';
      let data = null;
      if (ct.includes('application/json')) { try { data = await res.json(); } catch { data = null; } }
      else { data = await res.text(); }
      return { status: res.status, data, headers: res.headers };
    },
    get(u, o) { return this.req('GET', u, null, o); },
    post(u, b, o) { return this.req('POST', u, b, o); },
    put(u, b, o) { return this.req('PUT', u, b, o); },
    del(u, o) { return this.req('DELETE', u, null, o); },
  };
}

/* ------------------ 造图工具 ------------------ */
/** 最小合法 PNG（可指定声明的宽高，用于解码炸弹测试） */
function pngBytes(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8;   // bit depth
  ihdr[17] = 6;   // RGBA
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  ihdr.writeUInt32BE(crc32(ihdr.slice(4, 21)), 21);

  // 一张纯色 IDAT（尺寸真实，保证是合法 PNG）
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 40; raw[o + 1] = 120; raw[o + 2] = 220; raw[o + 3] = 255;
    }
  }
  const idatData = zlib.deflateSync(raw);
  const idat = Buffer.alloc(12 + idatData.length);
  idat.writeUInt32BE(idatData.length, 0);
  idat.write('IDAT', 4, 'ascii');
  idatData.copy(idat, 8);
  idat.writeUInt32BE(crc32(idat.slice(4, 8 + idatData.length)), 8 + idatData.length);

  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, idat, iend]);
}

/** 只在文件头声明一个超大尺寸（不真的给数据）—— 解码炸弹 */
function pngBomb(w, h) {
  const full = pngBytes(2, 2);
  const b = Buffer.from(full);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  // 头里的 CRC 已失效，但我们的防线必须在「解析头」阶段就拒绝，不能等到解码
  return b;
}

/** 最小合法 JPEG（1x1 灰点） */
function jpegBytes() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03,
    0x02, 0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06,
    0x06, 0x05, 0x06, 0x09, 0x08, 0x0a, 0x0a, 0x09, 0x08, 0x09, 0x09, 0x0a, 0x0c, 0x0f, 0x0c, 0x0a,
    0x0b, 0x0e, 0x0b, 0x09, 0x09, 0x0d, 0x11, 0x0d, 0x0e, 0x0f, 0x10, 0x10, 0x11, 0x10, 0x0a, 0x0c,
    0x12, 0x13, 0x12, 0x10, 0x13, 0x0f, 0x10, 0x10, 0x10, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff, 0xc4, 0x00,
    0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37,
    0xff, 0xd9,
  ]);
}

/** 上传：把 Buffer 包成 multipart */
async function uploadImage(cli, buf, filename, scene = 'comment') {
  const fd = new FormData();
  fd.append('image', new Blob([buf]), filename);
  return cli.req('POST', '/api/upload/image?scene=' + scene, fd);
}

/* ------------------ 主流程 ------------------ */
(async () => {
  console.log('慈云影视 · 图片能力回归  →  ' + BASE);

  /* ============ 0. 准备管理员/普通用户 ============ */
  section('0 登录准备');
  const admin = mkClient();
  let r = await admin.post('/api/user/login', { account: 'admin', password: 'admin888' });
  let adminOk = r.status === 200 && r.data && (r.data.ok || r.data.user);
  P(adminOk, '管理员登录', 'HTTP ' + r.status + (adminOk ? '' : ' ' + JSON.stringify(r.data).slice(0, 80)));
  if (!adminOk) {
    console.log('\n!! 无法登录，后续测试无意义，请确认 admin/admin888 可用');
    process.exit(1);
  }

  // 造一个普通用户（随机账号，避免重复跑冲突）；注册可能关闭 → 退回用 admin
  const uniq = Date.now().toString(36).slice(-6);
  const ua = 'imgtest_' + uniq;
  const user = mkClient();
  r = await user.post('/api/user/register', {
    account: ua, password: 'test1234', nickname: '图片测试' + uniq,
    email: ua + '@example.com',
  });
  let userOk = r.status === 200 && r.data && r.data.ok;
  if (!userOk) {
    console.log('    ⚠️ 注册不可用（' + (r.data && r.data.error) + '），改用 admin 账号做业务侧测试');
    const c = mkClient();
    await c.post('/api/user/login', { account: 'admin', password: 'admin888' });
    user.jar.clear();
    for (const [k, v] of c.jar) user.jar.set(k, v);
  }
  const U = user;
  const myAcc = userOk ? ua : 'admin';
  P(true, '测试账号就绪：' + myAcc);

  /* ============ 1. 上传接口 ============ */
  section('1 图片上传接口');
  const guest = mkClient();
  r = await guest.req('POST', '/api/upload/image', new FormData());
  P(r.status === 401 || r.status === 403, '未登录上传被拒绝', 'HTTP ' + r.status);

  const goodPng = pngBytes(64, 48);
  r = await uploadImage(U, goodPng, 'ok.png', 'comment');
  const upOk = r.status === 200 && r.data && r.data.ok && r.data.attachment;
  P(upOk, '登录后 PNG 上传成功', upOk ? `(${r.data.image.w}x${r.data.image.h})` : (r.data && r.data.error));
  const att1 = upOk ? r.data.attachment : null;

  r = await uploadImage(U, jpegBytes(), 'ok.jpg', 'comment');
  const attJpg = (r.status === 200 && r.data.ok) ? r.data.attachment : null;
  P(!!attJpg, 'JPEG 上传成功');

  /* ============ 2. 安全防线 ============ */
  section('2 图片安全防线');

  // 2.1 伪装文件：PHP 内容改名 .jpg
  r = await uploadImage(U, Buffer.from('<?php system($_GET["c"]); ?>'), 'evil.jpg');
  P(r.status >= 400, 'PHP 伪装成 .jpg 被拒', r.data && r.data.error);

  // 2.2 解码炸弹：声明 80000x80000
  r = await uploadImage(U, pngBomb(80000, 80000), 'bomb.png');
  P(r.status >= 400, '解码炸弹（80000x80000）被拒', r.data && r.data.error);

  // 2.3 真 mp4 改名 .jpg
  const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(64, 0)]);
  r = await uploadImage(U, fakeMp4, 'fake.jpg');
  P(r.status >= 400, 'MP4 改名 .jpg 被拒', r.data && r.data.error);

  // 2.4 不支持的扩展名
  r = await uploadImage(U, goodPng, 'a.exe');
  P(r.status >= 400, '不支持的扩展名 .exe 被拒', r.data && r.data.error);

  /* ============ 3. 图片读取 ============ */
  section('3 图片读取与路径安全');
  if (att1) {
    r = await U.get('/api/image/' + att1.file, { noCookie: true });
    P(r.status === 200 && String(r.headers.get('content-type')).startsWith('image/'),
      '原图可读', 'HTTP ' + r.status + ' ' + r.headers.get('content-type'));
    if (att1.thumb) {
      r = await U.get('/api/image/thumb/' + att1.thumb, { noCookie: true });
      P(r.status === 200, '缩略图可读', 'HTTP ' + r.status);
    } else {
      console.log('    ℹ️ 该图未生成缩略图（小图或动图属正常）');
    }
  }
  r = await U.get('/api/image/..%2F..%2Fetc%2Fpasswd', { noCookie: true });
  P(r.status === 404 || r.status === 400, '路径穿越读取被拒', 'HTTP ' + r.status);
  r = await U.get('/api/image/' + encodeURIComponent('../../server.js'), { noCookie: true });
  P(r.status === 404 || r.status === 400, '编码型路径穿越被拒', 'HTTP ' + r.status);

  /* ============ 4. 评论发图 ============ */
  section('4 评论发图');
  const targetType = 'video', targetId = 'imgtest-' + uniq;
  r = await U.get(`/api/comments?type=${targetType}&id=${targetId}&page=1&size=10`);
  P(r.status === 200 && typeof r.data.imageEnabled === 'boolean', '评论列表返回图片能力开关',
    'imageEnabled=' + (r.data && r.data.imageEnabled) + ' maxImages=' + (r.data && r.data.maxImages));

  // 4.1 图文混合
  r = await withRetry(() => U.post('/api/comments', {
    targetType, targetId, content: '图文测试 ' + uniq,
    attachments: att1 ? [att1] : [],
  }));
  const cm1 = (r.status === 200 && r.data) ? (r.data.comment || r.data) : null;
  P(r.status === 200, '图文混合评论提交成功', 'HTTP ' + r.status + (cm1 && cm1.id ? ' id=' + cm1.id : ''));

  // 4.2 纯图片评论（此前被 checkContent 拦，已修）
  r = await withRetry(() => U.post('/api/comments', { targetType, targetId, content: '', attachments: att1 ? [att1] : [] }));
  P(r.status === 200, '纯图片评论（正文为空）提交成功', r.status !== 200 ? (r.data && r.data.error) : '');

  // 4.3 空评论必须拒
  r = await U.post('/api/comments', { targetType, targetId, content: '', attachments: [] });
  P(r.status >= 400, '空评论（无字无图）被拒', r.data && r.data.error);

  // 4.4 伪造文件名
  r = await U.post('/api/comments', {
    targetType, targetId, content: '伪造引用测试',
    attachments: ['9999999_deadbeef.png'],
  });
  P(r.status >= 400, '伪造图片引用被拒', r.data && r.data.error);

  // 4.5 外部 URL 注入
  r = await U.post('/api/comments', {
    targetType, targetId, content: '外部链接注入',
    attachments: ['https://evil.example.com/x.png'],
  });
  P(r.status >= 400, '外部 URL 作为附件被拒', r.data && r.data.error);

  // 4.6 列表能查到 images
  r = await U.get(`/api/comments?type=${targetType}&id=${targetId}&page=1&size=20`);
  const withImg = (r.data.list || []).find((c) => c.images && c.images.length);
  P(!!withImg, '评论列表返回可渲染的 images 数组',
    withImg ? withImg.images[0].url : '未找到带图评论');

  // 4.7 回复带图
  if (cm1 && cm1.id) {
    r = await withRetry(() => U.post('/api/comments', {
      targetType, targetId, content: '回复带图 ' + uniq,
      parentId: cm1.id, attachments: attJpg ? [attJpg] : [],
    }));
    P(r.status === 200, '回复也支持带图', r.status !== 200 ? (r.data && r.data.error) : '');
  }

  /* ============ 5. 聊天室发图 ============ */
  section('5 聊天室发图');
  const room = 'imgtest:' + uniq;
  r = await withRetry(() => U.post('/api/chat/send', { room, content: '聊天图文 ' + uniq, attachments: att1 ? [att1] : [] }));
  P(r.status === 200, '聊天室图文消息发送成功', r.status !== 200 ? (r.data && r.data.error) : '');

  r = await withRetry(() => U.post('/api/chat/send', { room, content: '', attachments: attJpg ? [attJpg] : [] }));
  P(r.status === 200, '聊天室纯图片消息发送成功', r.status !== 200 ? (r.data && r.data.error) : '');

  r = await U.post('/api/chat/send', { room, content: '', attachments: [] });
  P(r.status >= 400, '聊天室空消息被拒', r.data && r.data.error);

  r = await U.get('/api/chat/history?room=' + encodeURIComponent(room) + '&limit=20');
  const chatImg = (r.data.list || []).find((m) => m.images && m.images.length);
  P(!!chatImg, '聊天历史返回 images 字段', chatImg ? chatImg.images[0].url : '');
  P(r.data.imageEnabled === true || r.data.imageEnabled === false, '聊天历史返回 imageEnabled 开关',
    'imageEnabled=' + r.data.imageEnabled);

  /* ============ 6. 弹幕发图 ============ */
  section('6 弹幕发图');
  r = await withRetry(() => U.post('/api/danmaku', {
    scope: 'local', target: 'dmtest-' + uniq, content: '图弹幕', color: '#ff6b6b', position: 'scroll',
    time: 12, attachments: att1 ? [att1] : [],
  }));
  const dm = (r.status === 200 && r.data) ? r.data.danmaku : null;
  P(r.status === 200 && dm && (dm.attachments || []).length === 1, '图片弹幕发送成功',
    r.status !== 200 ? (r.data && r.data.error) : '');

  // 一条弹幕最多 1 张：传 3 张必须在「校验阶段」就被明确拒绝
  // （这里是显式报错而非静默截断 —— 用户该知道自己的图没发出去）
  r = await withRetry(() => U.post('/api/danmaku', {
    scope: 'local', target: 'dmtest-' + uniq, content: '多图弹幕', position: 'top', time: 20,
    attachments: att1 && attJpg ? [att1, attJpg, att1] : [],
  }));
  const overErr = r.data && r.data.error;
  P(r.status === 400 && /最多/.test(String(overErr)), '超量弹幕图片被明确拒绝', overErr || 'HTTP ' + r.status);

  // 再补一条「恰好 1 张」确认放行
  r = await withRetry(() => U.post('/api/danmaku', {
    scope: 'local', target: 'dmtest-' + uniq, content: '单图弹幕', position: 'top', time: 22,
    attachments: attJpg ? [attJpg] : [],
  }));
  const dm3 = (r.status === 200 && r.data) ? r.data.danmaku : null;
  P(!!dm3 && (dm3.attachments || []).length === 1, '单张图片弹幕放行',
    r.status !== 200 ? (r.data && r.data.error) : '');

  // 历史带 images
  r = await U.get('/api/danmaku?scope=local&target=' + encodeURIComponent('dmtest-' + uniq) + '&limit=20');
  const dmHist = (r.data.list || []).find((m) => m.images && m.images.length);
  P(!!dmHist, '弹幕历史返回 images 字段');
  P(typeof r.data.imageEnabled === 'boolean', '弹幕历史返回 imageEnabled 开关', 'imageEnabled=' + r.data.imageEnabled);

  /* ============ 7. 私信发图 ============ */
  section('7 私信发图');
  const uni2 = Date.now().toString(36).slice(-5) + 'b';
  const ua2 = 'imgtest2_' + uni2;
  const user2 = mkClient();
  r = await user2.post('/api/user/register', {
    account: ua2, password: 'test1234', nickname: '图片测试2', email: ua2 + '@example.com',
  });
  const has2 = r.status === 200 && r.data && r.data.ok;
  if (!has2) {
    console.log('    ⚠️ 第二账号注册失败，跳过私信发图测试（' + (r.data && r.data.error) + '）');
  } else {
    await U.post('/api/social/request', { account: ua2 });
    await user2.post('/api/social/accept', { account: myAcc });
    r = await withRetry(() => U.post('/api/social/messages', { to: ua2, text: '私信图文', attachments: att1 ? [att1] : [] }));
    P(r.status === 200, '私信图文发送成功', r.status !== 200 ? (r.data && r.data.error) : '');

    r = await U.get('/api/social/messages/' + ua2);
    const msgImg = (r.data.list || []).find((m) => m.images && m.images.length);
    P(!!msgImg, '私信记录返回 images 字段', msgImg ? msgImg.images[0].url : '');
    P(typeof r.data.imageEnabled === 'boolean', '私信接口返回 imageEnabled 开关', 'imageEnabled=' + r.data.imageEnabled);

    r = await U.get('/api/social/conversations');
    const conv = (r.data.list || []).find((c) => c.account === ua2);
    P(!!conv && conv.last && conv.last.images > 0, '会话列表标记含图消息',
      conv && conv.last ? 'text="' + conv.last.text + '" images=' + conv.last.images : '');
  }

  /* ============ 8. 相册 ============ */
  section('8 我的相册');
  r = await U.get('/api/gallery');
  P(r.status === 200 && Array.isArray(r.data.list), '相册列表可访问', '共 ' + ((r.data.list || []).length) + ' 张');
  if ((r.data.list || []).length) {
    const one = r.data.list[0];
    P(!!(one.url || (one.attachment && one.attachment.file)), '相册条目带可渲染 URL');
  }
  r = await U.get('/api/gallery?scene=comment');
  P(r.status === 200, '相册按来源筛选可用（scene=comment）', '共 ' + ((r.data.list || []).length) + ' 张');

  /* ============ 9. 云盘 ============ */
  section('9 云盘基础');
  r = await U.get('/api/drive/list');
  P(r.status === 200, '云盘列表可访问', r.status !== 200 ? (r.data && r.data.error) : '');
  if (r.status === 200) {
    const q = r.data.quota || {};
    P(typeof q.totalBytes === 'number' && typeof q.usedBytes === 'number', '云盘返回配额信息',
      `已用 ${(q.usedBytes / 1048576).toFixed(1)}MB / 总额 ${(q.totalBytes / 1073741824).toFixed(2)}GB`);
  }
  r = await U.post('/api/drive/folder', { name: '测试文件夹' + uniq });
  P(r.status === 200, '新建文件夹成功', r.status !== 200 ? (r.data && r.data.error) : '');

  /* ============ 汇总 ============ */
  console.log('\n========== 结果: ' + pass + ' 过 / ' + fail + ' 挂 ==========');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
