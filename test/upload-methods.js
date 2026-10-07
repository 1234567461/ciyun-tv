/* 上传端点方法兼容回归
 * 背景：/api/shorts/upload 原先只注册 POST，GET 探测直接 404 →
 *       部分客户端/代理/中间设备在上传前先发 GET 探测时会失败，
 *       表现为「某些人没法上传视频」。
 * 期望：GET/HEAD/OPTIONS 一律 200 且返回能力说明（不要求登录）；
 *       POST 仍强制登录鉴权；真正上传链路不受影响。
 */
const BASE = process.env.BASE || 'http://localhost:8811';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

const URL = BASE + '/api/shorts/upload';

(async () => {
  // ---------- 1. GET 探测：应 200，不再 404 ----------
  const get = await fetch(URL);
  ok(get.status === 200, 'GET 返回 200（原为 404）');
  const gj = await get.json().catch(() => ({}));
  ok(gj.ok === true, 'GET 响应体含 ok:true');
  ok(gj.method === 'POST', 'GET 说明真正上传用 POST');
  ok(gj.fields && gj.fields.video && gj.fields.title, 'GET 返回必填字段说明（video/title）');
  ok(gj.authed === false, '未登录 GET 也放通（authed:false，不返回 401）');
  ok(get.headers.get('allow') && /POST/.test(get.headers.get('allow')), 'GET 响应带 Allow 头');

  // ---------- 2. HEAD / OPTIONS 也应放通 ----------
  const head = await fetch(URL, { method: 'HEAD' });
  ok(head.status === 200, 'HEAD 返回 200');
  const opt = await fetch(URL, { method: 'OPTIONS' });
  ok(opt.status === 200, 'OPTIONS 返回 200（预检放通）');

  // ---------- 3. POST 未登录：仍必须 401 ----------
  const post = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(post.status === 401, 'POST 未登录仍返回 401（鉴权未被削弱）');

  // ---------- 4. 登录后 POST 走真逻辑（非 401/404） ----------
  // requireUser 认的是用户端 cookie(cy_user)，故注册一个临时普通用户来测。
  const acc = 'up_' + Date.now().toString(36);
  const reg = await fetch(BASE + '/api/user/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: acc, password: 'Ciyun2026x' }),
  });
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  ok(reg.status === 200 && /cy_user=/.test(cookie), '注册临时用户并取得用户端会话');

  const post2 = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: '{}',
  });
  ok(post2.status === 400, '已登录 POST 但非 multipart → 400「请使用 multipart/form-data」（证明进入了上传逻辑）');
  const p2j = await post2.json().catch(() => ({}));
  ok(/multipart/.test(p2j.error || ''), '错误文案明确指出需要 multipart/form-data');

  // ---------- 5. 已登录 GET 应回显身份 ----------
  const get2 = await fetch(URL, { headers: { cookie } });
  const g2j = await get2.json();
  ok(g2j.authed === true && g2j.user, '已登录 GET 回显 authed:true + user（便于前端自检）');

  console.log('\n  ────────────────');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
