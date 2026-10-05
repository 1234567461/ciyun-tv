/* 后台管理：保存栏 / 管理员改密 / 创建用户 / 邮箱注册开关 —— 端到端回归 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8811';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  // ---------- 管理员登录 ----------
  const login = await page.request.post(BASE + '/api/admin/login', {
    data: { username: 'admin', password: 'admin888' },
  });
  ok(login.ok(), '管理员登录成功');

  // ---------- 1. 站点设置：保存栏必须出现在 DOM ----------
  await page.goto(BASE + '/admin/');
  await page.waitForTimeout(600);
  // 切到「站点设置」
  await page.click('.side-item[data-tab="settings"]');
  await page.waitForTimeout(800);

  const barInfo = await page.evaluate(() => {
    const mask = document.querySelector('#settings-savebar');
    const bar = document.querySelector('.save-bar');
    const saveBtn = document.querySelector('.save-bar .sb-save');
    // 占位 div 被替换成文本 "undefined" 的检测
    const bodyText = document.body.innerText || '';
    return {
      hasPlaceholder: !!mask,
      hasBar: !!bar,
      hasSaveBtn: !!saveBtn,
      saveText: saveBtn ? saveBtn.textContent.trim() : null,
      hasUndefinedText: /\bundefined\b/.test(bodyText),
      layoutChildren: (document.querySelector('.layout > main, .layout .page') || {}).outerHTML
        ? true : true,
    };
  });
  ok(barInfo.hasBar, '站点设置页出现 .save-bar（保存栏已挂载）');
  ok(barInfo.hasSaveBtn, '保存栏内有「保存设置」按钮');
  ok(!barInfo.hasUndefinedText, '页面未出现裸文本 "undefined"（replaceWith bug 已修）');

  // ---------- 2. 改站点名称 → 点保存 → 落盘 ----------
  const NEW_NAME = '慈云影视·测试' + Date.now().toString(36).slice(-4);
  await page.fill('#s-name', NEW_NAME);
  await page.click('.save-bar .sb-save');
  await page.waitForTimeout(900);
  const afterSave = await page.request.get(BASE + '/api/site');
  const cfg = await afterSave.json();
  ok(cfg.siteName === NEW_NAME, '站点名称修改后已真正落盘（' + cfg.siteName + '）');

  // ---------- 3. 管理员密码字段是 password 类型 ----------
  const pwdType = await page.getAttribute('#s-pass', 'type');
  ok(pwdType === 'password', '管理员密码输入框为 password 类型（不再明文展示）');

  // ---------- 4. 创建用户（后台开号，绕过邮箱） ----------
  await page.click('.side-item[data-tab="users"]');
  await page.waitForTimeout(700);
  const hasCreateBtn = await page.$('#user-create');
  ok(!!hasCreateBtn, '用户管理页出现「创建用户」按钮');

  const ACC = 't_' + Date.now().toString(36);
  await page.click('#user-create');
  await page.waitForTimeout(300);
  ok(!!(await page.$('.modal-dlg')), '创建用户弹窗已打开');
  await page.fill('#cu-acc', ACC);
  await page.fill('#cu-pwd', 'Ciyun2026x');
  await page.fill('#cu-nick', '测试账号');
  await page.click('#cu-save');
  await page.waitForTimeout(900);

  // 用新账号登录验证
  const newLogin = await page.request.post(BASE + '/api/user/login', {
    data: { account: ACC, password: 'Ciyun2026x' },
  });
  ok(newLogin.ok(), '后台创建的用户可直接登录（无需邮箱验证）');

  // ---------- 5. 邮箱注册开关：关闭验证码 → 无邮箱可注册 ----------
  // 先在后台把 verifyEmail 关掉（默认即关），确保注册无需邮箱
  const put = await page.request.put(BASE + '/api/admin/settings', {
    data: { community: { verifyEmail: false, needEmail: false } },
  });
  ok(put.ok(), '可写入 community.verifyEmail = false');

  const cfg2 = await (await page.request.get(BASE + '/api/site')).json();
  ok(cfg2.community.needEmail === false && cfg2.community.verifyEmail === false,
    '前端 site-config 正确反映 needEmail/verifyEmail 均为 false');

  const ACC2 = 'r_' + Date.now().toString(36);
  const reg = await page.request.post(BASE + '/api/user/register', {
    data: { account: ACC2, password: 'Ciyun2026x', nickname: '无邮箱注册' },
  });
  ok(reg.ok(), '无 SMTP / 无邮箱时仍可注册（降级生效）');

  // ---------- 6. 开启验证码后，无验证码注册应被拒 ----------
  await page.request.put(BASE + '/api/admin/settings', {
    data: { community: { verifyEmail: true } },
  });
  const ACC3 = 'v_' + Date.now().toString(36);
  const reg2 = await page.request.post(BASE + '/api/user/register', {
    data: { account: ACC3, password: 'Ciyun2026x', email: 'x@example.com' },
  });
  ok(!reg2.ok(), '开启邮箱验证码后，缺验证码的注册被正确拒绝');

  // 复原
  await page.request.put(BASE + '/api/admin/settings', {
    data: { community: { verifyEmail: false, needEmail: false }, siteName: '慈云影视' },
  });

  ok(errs.length === 0, '页面无未捕获 JS 错误' + (errs.length ? '：' + errs.join(' | ') : ''));

  console.log('\n  ────────────────');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
