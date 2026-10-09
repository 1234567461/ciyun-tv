/* 云盘回归：上传 / 文件夹 / 重命名 / 移动 / 配额 / 分享 / 回收站 / 安全
 * ------------------------------------------------------------
 * 运行：node test/drive.js  （需服务已在 8811 运行）
 */
const zlib = require('zlib');

const BASE = process.env.CIYUN_BASE || 'http://127.0.0.1:8811';
let pass = 0, fail = 0;
const P = (ok, label, extra) => {
  console.log((ok ? '  ✅' : '  ❌'), label + (extra ? '  ' + extra : ''));
  ok ? pass++ : fail++;
};
const section = (t) => console.log('\n【' + t + '】');

function mkClient() {
  const jar = new Map();
  return {
    jar,
    cookieHeader() { return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; '); },
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
      const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
      if (!opt.noCookie) this.absorb(res);
      const ct = res.headers.get('content-type') || '';
      let data;
      if (ct.includes('application/json')) { try { data = await res.json(); } catch { data = null; } }
      else if (/^image\/|^application\/|^video\/|^audio\/|^text\//.test(ct) && opt.binary) { data = Buffer.from(await res.arrayBuffer()); }
      else { data = await res.text(); }
      return { status: res.status, data, headers: res.headers, ct };
    },
    get(u, o) { return this.req('GET', u, null, o); },
    post(u, b, o) { return this.req('POST', u, b, o); },
    put(u, b, o) { return this.req('PUT', u, b, o); },
    del(u, o) { return this.req('DELETE', u, null, o); },
  };
}

/** 上传文件到云盘 */
async function driveUpload(cli, buf, filename, parent = '') {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  if (parent) fd.append('parent', parent);
  return cli.req('POST', '/api/drive/upload', fd);
}

/** 造一个真的 zip（合法文件，便于验证「压缩包可存」） */
function realZip() {
  const name = Buffer.from('hello.txt');
  const content = Buffer.from('慈云影视 drive test ' + Date.now());
  const crc32 = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  })();
  const c = crc32(content);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(c, 14); lh.writeUInt32LE(content.length, 18); lh.writeUInt32LE(content.length, 22);
  lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  const local = Buffer.concat([lh, name, content]);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12);
  cd.writeUInt32LE(c, 16); cd.writeUInt32LE(content.length, 20); cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(name.length, 28);
  const central = Buffer.concat([cd, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

async function withRetry(fn, tries = 3, waitMs = 3000) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (last.status !== 429) return last;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

(async () => {
  console.log('慈云影视 · 云盘回归  →  ' + BASE);

  section('0 登录');
  const cli = mkClient();
  let r = await cli.post('/api/user/login', { account: 'admin', password: 'admin888' });
  if (!(r.status === 200 && r.data && (r.data.ok || r.data.user))) {
    console.log('  ❌ 登录失败，终止：' + JSON.stringify(r.data).slice(0, 100));
    process.exit(1);
  }
  P(true, '登录成功');

  const uniq = Date.now().toString(36).slice(-6);

  /* ============ 1. 列表与配额 ============ */
  section('1 列表与配额');
  r = await cli.get('/api/drive/list');
  P(r.status === 200, '云盘列表可访问');
  const q0 = r.data.quota || {};
  P(typeof q0.totalBytes === 'number' && q0.totalBytes > 0,
    '配额总额有效', (q0.totalBytes / 1073741824).toFixed(2) + ' GB');
  const used0 = q0.usedBytes || 0;

  /* ============ 2. 文件夹 ============ */
  section('2 文件夹');
  r = await withRetry(() => cli.post('/api/drive/folder', { name: '测试目录' + uniq }));
  const folderId = (r.status === 200 && r.data) ? (r.data.node && r.data.node.id) || r.data.id : null;
  P(r.status === 200 && !!folderId, '新建文件夹成功', folderId ? 'id=' + folderId : (r.data && r.data.error));

  // 重名自动加后缀，而不是覆盖
  r = await withRetry(() => cli.post('/api/drive/folder', { name: '测试目录' + uniq }));
  const folder2Id = (r.status === 200 && r.data) ? (r.data.node && r.data.node.id) || r.data.id : null;
  const name2 = (r.data && r.data.node && r.data.node.name) || (r.data && r.data.name) || '';
  P(r.status === 200 && !!folder2Id, '同名文件夹自动改名而非覆盖', '新名="' + name2 + '"');

  r = await cli.get('/api/drive/folders');
  P(r.status === 200 && Array.isArray(r.data.list), '文件夹平铺列表可访问', '共 ' + ((r.data.list || []).length) + ' 个');

  /* ============ 3. 上传 ============ */
  section('3 上传文件');
  const zipBuf = realZip();
  r = await withRetry(() => driveUpload(cli, zipBuf, '归档' + uniq + '.zip', folderId || ''));
  const fileNode = (r.status === 200 && r.data) ? (r.data.node || r.data.file) : null;
  const fileId = fileNode && fileNode.id;
  P(r.status === 200 && !!fileId, 'zip 上传成功',
    fileId ? `${(fileNode.size / 1024).toFixed(1)}KB id=${fileId}` : (r.data && r.data.error));

  // 配额累加
  r = await cli.get('/api/drive/list');
  const used1 = (r.data.quota || {}).usedBytes || 0;
  P(used1 > used0, '配额已用量随上传增加',
    `+${(((used1 - used0) / 1024)).toFixed(1)}KB`);

  // PDF / EPUB 这类文档也必须能存（不能只放行图片）
  const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  r = await withRetry(() => driveUpload(cli, pdfBuf, '文档' + uniq + '.pdf', folderId || ''));
  P(r.status === 200, 'PDF 上传成功', r.status !== 200 ? (r.data && r.data.error) : '');

  /* ============ 4. 安全防线 ============ */
  section('4 云盘安全防线');

  // 4.1 危险扩展名
  r = await withRetry(() => driveUpload(cli, Buffer.from('<?php echo 1; ?>'), 'shell.php', folderId || ''));
  P(r.status >= 400, '.php 被拒', r.data && r.data.error);

  // 4.2 真 ELF 改名 .txt
  const elf = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    Buffer.alloc(120, 0),
  ]);
  r = await withRetry(() => driveUpload(cli, elf, 'innocent' + uniq + '.txt', folderId || ''));
  P(r.status >= 400, 'ELF 可执行文件改名 .txt 被拒', r.data && r.data.error);

  // 4.3 Windows PE
  const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(126, 0)]);
  r = await withRetry(() => driveUpload(cli, pe, 'setup' + uniq + '.dat', folderId || ''));
  P(r.status >= 400, 'PE 可执行文件改名 .dat 被拒', r.data && r.data.error);

  // 4.4 shebang 脚本
  r = await withRetry(() => driveUpload(cli, Buffer.from('#!/bin/sh\nrm -rf /\n'), 'run' + uniq + '.txt', folderId || ''));
  P(r.status >= 400, 'shebang 脚本改名 .txt 被拒', r.data && r.data.error);

  // 4.5 文件名路径穿越
  r = await withRetry(() => driveUpload(cli, zipBuf, '../../../etc/pwn' + uniq + '.zip', folderId || ''));
  let traversalOk = r.status === 200;
  if (traversalOk) {
    const nn = (r.data.node && r.data.node.name) || '';
    P(!nn.includes('/') && !nn.includes('..'), '文件名路径穿越被清洗', '实际名="' + nn + '"');
  } else {
    P(true, '文件名路径穿越被拒', r.data && r.data.error);
  }

  /* ============ 5. 重命名 / 移动 ============ */
  section('5 重命名与移动');
  if (fileId) {
    r = await withRetry(() => cli.put('/api/drive/node/' + fileId, { name: '改名后' + uniq }));
    const newName = (r.data && r.data.node && r.data.node.name) || '';
    P(r.status === 200, '重命名成功', '新名="' + newName + '"');
    P(newName.includes('.zip'), '重命名后仍保留原扩展名（否则会丢文件类型）');

    r = await withRetry(() => cli.put('/api/drive/node/' + fileId, { parent: '' }));
    const np = r.data && r.data.node ? r.data.node.parent : undefined;
    P(r.status === 200 && (np === '' || np === null || np === undefined), '移动到根目录成功');
  }

  /* ============ 6. 下载 ============ */
  section('6 下载');
  if (fileId) {
    r = await cli.get('/api/drive/file/' + fileId, { binary: true });
    const okDl = r.status === 200 && Buffer.isBuffer(r.data);
    P(okDl, '下载成功', okDl ? r.data.length + ' bytes' : 'HTTP ' + r.status);
    if (okDl) P(r.data.equals(zipBuf), '下载内容与源文件逐字节一致');
  }

  /* ============ 7. 分享 ============ */
  section('7 分享链接');
  if (fileId) {
    // 显式带提取码 —— 把「密码校验」这条最容易出错的分支完整跑一遍
    r = await withRetry(() => cli.post('/api/drive/share', { nodeId: fileId, password: '2580', expireDays: 7 }));
    const share = (r.status === 200 && r.data) ? (r.data.share || r.data) : null;
    const token = share && share.token;
    P(r.status === 200 && !!token, '创建带提取码的分享成功',
      token ? 'token=' + String(token).slice(0, 10) + '…' : (r.data && r.data.error));

    if (token) {
      const anon = mkClient();
      r = await anon.get('/api/share/' + token, { noCookie: true });
      P(r.status === 200, '匿名可访问分享页', 'HTTP ' + r.status);
      P(r.data && r.data.needPassword === true, '分享页提示需要提取码', 'needPassword=' + (r.data && r.data.needPassword));

      // 无凭据下载必须被拒
      r = await anon.get('/api/share/' + token + '/file', { noCookie: true, binary: true });
      P(r.status === 403 || r.status === 401, '未验证时下载被拒', 'HTTP ' + r.status);

      // 错误提取码
      const bad = mkClient();
      r = await bad.post('/api/share/' + token + '/verify', { password: '0000' }, { noCookie: true });
      P(r.status >= 400, '错误提取码被拒', r.data && r.data.error);

      // 正确提取码（用独立 cookie 罐，确认 cookie 机制本身生效）
      const good = mkClient();
      r = await good.post('/api/share/' + token + '/verify', { password: '2580' });
      P(r.status === 200, '正确提取码通过', r.status !== 200 ? (r.data && r.data.error) : '');

      r = await good.get('/api/share/' + token + '/file', { binary: true });
      const ok2 = r.status === 200 && Buffer.isBuffer(r.data);
      P(ok2, '凭 cookie 下载成功', ok2 ? r.data.length + ' bytes' : 'HTTP ' + r.status);
      if (ok2) P(r.data.equals(zipBuf), '分享下载内容与源文件一致');

      r = await good.get('/api/share/' + token + '/list', { binary: true });
      P(r.status === 400, '分享的是文件时，列目录被明确拒绝', r.status === 400 ? 'HTTP 400' : 'HTTP ' + r.status);

      // 伪造签名 cookie 必须无效
      const forged = mkClient();
      forged.jar.set('cy_share_' + token, 'deadbeef:0123456789abcdef');
      r = await forged.get('/api/share/' + token + '/file', { binary: true });
      P(r.status !== 200, '伪造签名的 cookie 不通过', 'HTTP ' + r.status);

      // 取消分享
      const sid = share.id;
      r = await withRetry(() => cli.del('/api/drive/share/' + sid));
      P(r.status === 200, '取消分享成功', r.status !== 200 ? (r.data && r.data.error) : '');
      const anon2 = mkClient();
      r = await anon2.get('/api/share/' + token, { noCookie: true });
      P(r.status === 404 || r.status === 410, '取消分享后链接失效', 'HTTP ' + r.status);
    }
  }

  /* ============ 7.5 分享文件夹 ============ */
  section('7.5 分享文件夹（目录浏览 + 越权防护）');
  if (folderId) {
    // 往文件夹里塞一个文件，确认能列出来
    await withRetry(() => driveUpload(cli, zipBuf, '夹内文件' + uniq + '.zip', folderId));

    r = await withRetry(() => cli.post('/api/drive/share', { nodeId: folderId, expireDays: 3 }));
    const fShare = (r.status === 200 && r.data) ? (r.data.share || r.data) : null;
    const fToken = fShare && fShare.token;
    P(!!fToken, '文件夹创建分享成功', fToken ? 'token=' + String(fToken).slice(0, 10) + '…' : (r.data && r.data.error));

    if (fToken) {
      const anon = mkClient();
      r = await anon.get('/api/share/' + fToken, { noCookie: true });
      P(r.status === 200, '匿名访问文件夹分享页', 'HTTP ' + r.status);

      r = await anon.get('/api/share/' + fToken + '/list', { noCookie: true });
      const names = (r.data.list || []).map((n) => n.name);
      P(r.status === 200 && names.some((n) => n.includes('夹内文件')), '分享文件夹内文件可见',
        names.slice(0, 3).join(', '));

      // 越权：拿别的目录 id 当 parent
      r = await anon.get('/api/share/' + fToken + '/list?parent=' + encodeURIComponent(folder2Id || 'xxx'), { noCookie: true });
      P(r.status === 403, '分享目录外的 parent 被拒（越权防护）', 'HTTP ' + r.status);

      // 分享内文件也能直接下载
      r = await anon.get('/api/share/' + fToken + '/list', { noCookie: true });
      const innerFile = (r.data.list || []).find((n) => n.type === 'file');
      if (innerFile) {
        r = await anon.get('/api/share/' + fToken + '/node/' + innerFile.id, { noCookie: true, binary: true });
        const okInner = r.status === 200 && Buffer.isBuffer(r.data);
        P(okInner, '分享内文件可下载', okInner ? r.data.length + ' bytes' : 'HTTP ' + r.status);
        if (okInner) P(r.data.equals(zipBuf), '分享内下载内容与源文件一致');
      }

      // 越权：请求一个不属于该分享子树的节点 id
      r = await anon.get('/api/share/' + fToken + '/node/dn_not_a_real_node_xyz', { noCookie: true });
      P(r.status === 403 || r.status === 404, '分享外节点被拒（越权防护）', 'HTTP ' + r.status);

      await cli.del('/api/drive/share/' + fShare.id);
    }
  }

  /* ============ 8. 回收站 ============ */
  section('8 回收站');
  r = await withRetry(() => cli.post('/api/drive/folder', { name: '待删目录' + uniq }));
  const delId = (r.data && ((r.data.node && r.data.node.id) || r.data.id)) || null;
  if (delId) {
    r = await withRetry(() => cli.del('/api/drive/node/' + delId));
    P(r.status === 200, '删除到回收站成功', r.status !== 200 ? (r.data && r.data.error) : '');

    r = await cli.get('/api/drive/list?trashed=1');
    const inTrash = (r.data.list || []).some((n) => n.id === delId);
    P(r.status === 200 && inTrash, '回收站能查到被删节点', '回收站共 ' + ((r.data.list || []).length) + ' 项');

    r = await withRetry(() => cli.post('/api/drive/restore/' + delId));
    P(r.status === 200, '从回收站恢复成功', r.status !== 200 ? (r.data && r.data.error) : '');
  }

  /* ============ 9. 转存到相册 ============ */
  section('9 云盘图片转相册');
  // 先往云盘传一张真 PNG
  const png = (() => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'ascii');
    ihdr.writeUInt32BE(8, 8); ihdr.writeUInt32BE(8, 12);
    ihdr[16] = 8; ihdr[17] = 6;
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
    ihdr.writeUInt32BE(crc32(ihdr.slice(4, 21)), 21);
    const raw = Buffer.alloc((8 * 4 + 1) * 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const o = y * 33 + 1 + x * 4; raw[o] = 200; raw[o + 1] = 60; raw[o + 2] = 60; raw[o + 3] = 255; }
    const dd = zlib.deflateSync(raw);
    const idat = Buffer.alloc(12 + dd.length);
    idat.writeUInt32BE(dd.length, 0); idat.write('IDAT', 4, 'ascii'); dd.copy(idat, 8);
    idat.writeUInt32BE(crc32(idat.slice(4, 8 + dd.length)), 8 + dd.length);
    const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    return Buffer.concat([sig, ihdr, idat, iend]);
  })();
  r = await withRetry(() => driveUpload(cli, png, '云盘图' + uniq + '.png', ''));
  const pngId = (r.data && ((r.data.node && r.data.node.id) || r.data.id)) || null;
  if (pngId) {
    r = await cli.get('/api/gallery');
    const before = (r.data.list || []).length;
    r = await withRetry(() => cli.post('/api/drive/to-gallery', { nodeId: pngId }));
    P(r.status === 200, '云盘图片转存到相册成功', r.status !== 200 ? (r.data && r.data.error) : '');
    r = await cli.get('/api/gallery');
    P((r.data.list || []).length >= before, '相册数量未减少',
      before + ' → ' + ((r.data.list || []).length));
  }

  console.log('\n========== 结果: ' + pass + ' 过 / ' + fail + ' 挂 ==========');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
