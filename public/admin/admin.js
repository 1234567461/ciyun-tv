/* ============================================================
   慈云影视 · 后台管理
   面板：概览 / 内容 / 自定义源 / 接口监控 / 站点设置 / 会员 / 数据
   ============================================================ */

const API = (p, o = {}) => fetch(p, {
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  ...o,
  body: o.body && typeof o.body === 'object' ? JSON.stringify(o.body) : o.body,
}).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'HTTP ' + r.status), { data: d, status: r.status });
  return d;
});

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function toast(msg, type = '') {
  let host = $('#toast-host');
  if (!host) { host = document.createElement('div'); host.id = 'toast-host'; host.className = 'toast-host'; document.body.appendChild(host); }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 320); }, 2400);
}

/* ============================================================
   应用
   ============================================================ */
const app = { tab: 'dashboard', site: null, settings: null };

async function boot() {
  try {
    const me = await API('/api/admin/me');
    if (!me.ok) throw new Error('not logged in');
    await start();
  } catch {
    renderLogin();
  }
}

function renderLogin() {
  document.body.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <div class="login-logo">
          <div class="login-mark">慈</div>
          <h1>慈云影视 后台</h1>
        </div>
        <div class="login-sub">管理你的影视聚合站点</div>
        <div class="field">
          <div class="input-wrap"><input id="u" placeholder="管理员账号" value="admin" autocomplete="username"></div>
        </div>
        <div class="field">
          <div class="input-wrap"><input id="p" type="password" placeholder="密码" value="admin888" autocomplete="current-password"></div>
        </div>
        <button class="btn-login" id="login-btn">登 录</button>
        <div class="login-tip">默认账号 admin / admin888，请在「站点设置」中及时修改</div>
      </div>
    </div>`;
  const doLogin = async () => {
    try {
      await API('/api/admin/login', { method: 'POST', body: { username: $('#u').value, password: $('#p').value } });
      toast('登录成功', 'ok');
      setTimeout(start, 300);
    } catch (e) {
      toast(e.message || '登录失败', 'err');
    }
  };
  $('#login-btn').onclick = doLogin;
  $('#p').onkeydown = (e) => e.key === 'Enter' && doLogin();
}

async function start() {
  [app.site, app.settings] = await Promise.all([API('/api/site'), API('/api/admin/settings')]);
  render();
}

const TABS = [
  { id: 'dashboard', icon: '📊', label: '概览' },
  { id: 'content', icon: '🎞️', label: '内容管理' },
  { id: 'sources', icon: '🔌', label: '自定义源' },
  { id: 'comments', icon: '💬', label: '评论管理' },
  { id: 'users', icon: '👥', label: '用户管理' },
  { id: 'families', icon: '👨‍👩‍👧', label: '家庭共享' },
  { id: 'health', icon: '❤️', label: '接口监控' },
  { id: 'monetize', icon: '💎', label: '会员付费' },
  { id: 'settings', icon: '⚙️', label: '站点设置' },
  { id: 'data', icon: '💾', label: '数据备份' },
];

const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

function render() {
  document.body.innerHTML = `
    <div class="layout">
      <aside class="side">
        <div class="side-logo"><div class="side-mark">慈</div><span>慈云影视</span></div>
        ${TABS.map((t) => `<div class="side-item ${t.id === app.tab ? 'on' : ''}" data-tab="${t.id}">
          <span class="ic">${t.icon}</span><span class="lbl">${t.label}</span></div>`).join('')}
        <div class="side-foot">
          <div class="side-item" id="go-site"><span class="ic">🌐</span><span class="lbl">访问前台</span></div>
          <div class="side-item" id="logout"><span class="ic">🚪</span><span class="lbl">退出登录</span></div>
        </div>
      </aside>
      <main class="content" id="content"></main>
    </div>`;
  $$('.side-item[data-tab]').forEach((el) => (el.onclick = () => { app.tab = el.dataset.tab; render(); }));
  $('#go-site').onclick = () => window.open('/', '_blank');
  $('#logout').onclick = async () => { await API('/api/admin/logout', { method: 'POST' }); location.reload(); };
  route();
}

function route() {
  const c = $('#content');
  c.innerHTML = '';
  ({
    dashboard: viewDashboard,
    content: viewContent,
    sources: viewSources,
    comments: viewComments,
    users: viewUsers,
    families: viewFamilies,
    health: viewHealth,
    monetize: viewMonetize,
    settings: viewSettings,
    data: viewData,
  }[app.tab] || viewDashboard)(c);
}

/* ============================================================
   概览
   ============================================================ */
async function viewDashboard(c) {
  c.innerHTML = `<div class="page-head"><div><h2>概览</h2><div class="sub">站点运行状态一览</div></div></div><div id="dash"></div>`;
  const box = $('#dash');
  try {
    const [stats, health] = await Promise.all([API('/api/admin/stats'), API('/api/admin/health')]);
    const maxPlay = Math.max(1, ...stats.days.map((d) => d.plays));
    const maxVisit = Math.max(1, ...stats.days.map((d) => d.visits));
    box.innerHTML = `
      <div class="grid4" style="margin-bottom:18px">
        <div class="stat"><div class="k">总播放量</div><div class="v">${stats.totalPlays.toLocaleString()}</div><div class="d">累计播放次数</div></div>
        <div class="stat"><div class="k">栏目总数</div><div class="v">${stats.columns}</div><div class="d">个可点播栏目</div></div>
        <div class="stat"><div class="k">自定义源</div><div class="v">${stats.sources}</div><div class="d">个内容源</div></div>
        <div class="stat"><div class="k">注册用户</div><div class="v">${stats.users}</div><div class="d">${stats.orders} 笔订单 · ¥${stats.revenue}</div></div>
      </div>
      <div class="grid2">
        <div class="card">
          <h3>📈 近 14 天播放量</h3>
          <div class="chart">${stats.days.map((d) => `<div class="bar" style="height:${(d.plays / maxPlay) * 100}%"><span>${d.plays}</span></div>`).join('')}</div>
          <div class="chart-x">${stats.days.map((d) => `<div>${d.date.slice(5)}</div>`).join('')}</div>
        </div>
        <div class="card">
          <h3>👀 近 14 天访问量</h3>
          <div class="chart">${stats.days.map((d) => `<div class="bar" style="height:${(d.visits / maxVisit) * 100}%"><span>${d.visits}</span></div>`).join('')}</div>
          <div class="chart-x">${stats.days.map((d) => `<div>${d.date.slice(5)}</div>`).join('')}</div>
        </div>
      </div>
      <div class="card">
        <h3>🔥 热门内容 TOP 10</h3>
        ${stats.top.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th style="width:50px">#</th><th>标题</th><th style="width:110px">播放次数</th></tr></thead>
          <tbody>${stats.top.slice(0, 10).map((t, i) => `<tr>
            <td>${i + 1}</td><td class="name">${esc(t.title || t.guid)}</td><td>${t.count}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty"><div class="i">📭</div>暂无播放数据</div>'}
      </div>
      <div class="card">
        <h3>❤️ 接口健康状态</h3>
        ${renderHealthTable(health.stats)}
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="card">加载失败：${esc(e.message)}</div>`;
  }
}

function renderHealthTable(list) {
  if (!list.length) return '<div class="empty"><div class="i">💤</div>暂无调用记录，访问前台后自动记录</div>';
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>接口</th><th>状态</th><th>成功率</th><th>成功/失败</th><th>耗时</th><th>最后错误</th></tr></thead>
    <tbody>${list.map((h) => `<tr>
      <td class="name">${esc(h.name)}</td>
      <td><span class="badge ${h.status === 'up' ? 'ok' : h.status === 'degraded' ? 'warn' : 'err'}">${
        h.status === 'up' ? '正常' : h.status === 'degraded' ? '波动' : '异常'}</span></td>
      <td>${h.successRate}%</td>
      <td>${h.ok} / ${h.fail}</td>
      <td>${h.avgMs}ms</td>
      <td style="color:var(--text-mute);font-size:12px">${esc(h.lastErr || '—')}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

/* ============================================================
   内容管理
   ============================================================ */
async function viewContent(c) {
  c.innerHTML = `
    <div class="page-head">
      <div><h2>内容管理</h2><div class="sub">管理栏目显示、推荐位，或添加新的央视栏目</div></div>
      <button class="btn btn-primary" id="add-col">+ 添加栏目</button>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:16px">
        <input id="col-search" placeholder="搜索栏目名…" class="narrow" style="flex:1">
        <select id="col-cat" class="narrow" style="width:150px"></select>
      </div>
      <div id="col-list"></div>
    </div>`;

  const cats = await API('/api/categories');
  $('#col-cat').innerHTML = '<option value="">全部分类</option>' +
    cats.categories.map((x) => `<option value="${x.id}">${x.icon} ${x.name} (${x.count})</option>`).join('');

  let all = [];
  const loadList = async () => {
    const d = await API('/api/columns?size=300');
    all = d.list;
    paint();
  };
  function paint() {
    const kw = ($('#col-search').value || '').toLowerCase();
    const cat = $('#col-cat').value;
    const list = all.filter((x) => (!cat || x.category === cat) && (!kw || x.name.toLowerCase().includes(kw)));
    $('#col-list').innerHTML = list.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>栏目名</th><th>分类</th><th>内容量</th><th style="width:90px">推荐</th><th style="width:90px">启用</th><th style="width:80px">操作</th></tr></thead>
      <tbody>${list.map((x) => `<tr data-id="${x.id}">
        <td class="name">${esc(x.name)}</td>
        <td><span class="badge dim">${esc(catName(x.category))}</span></td>
        <td>${(x.total || 0).toLocaleString()} 期</td>
        <td><div class="switch ${x.featured ? 'on' : ''}" data-f="featured" data-id="${x.id}"></div></td>
        <td><div class="switch ${x.enabled !== false ? 'on' : ''}" data-f="enabled" data-id="${x.id}"></div></td>
        <td><button class="btn btn-danger btn-sm" data-del="${x.id}">删除</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty"><div class="i">🔍</div>没有匹配的栏目</div>';

    $$('.switch[data-f]', $('#col-list')).forEach((sw) => (sw.onclick = async () => {
      const id = sw.dataset.id, f = sw.dataset.f;
      const cur = all.find((x) => x.id === id);
      const val = f === 'enabled' ? cur.enabled === false : !cur.featured;
      await API('/api/admin/columns/' + id, { method: 'PUT', body: { [f]: val } });
      cur[f] = val;
      sw.classList.toggle('on');
      toast('已更新');
    }));
    $$('[data-del]', $('#col-list')).forEach((b) => (b.onclick = async () => {
      if (!confirm('确定删除该栏目？')) return;
      await API('/api/admin/columns/' + b.dataset.del, { method: 'DELETE' });
      toast('已删除');
      loadList();
    }));
  }
  $('#col-search').oninput = paint;
  $('#col-cat').onchange = paint;
  $('#add-col').onclick = () => showAddColumn(cats.categories, loadList);
  loadList();
}

function catName(id) {
  const c = (app.site && app.site.categories || []).find((x) => x.id === id);
  return c ? c.name : (window.__cats || []).find((x) => x.id === id)?.name || id;
}

function showAddColumn(cats, onDone) {
  window.__cats = cats;
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:900;display:grid;place-items:center;padding:20px';
  mask.innerHTML = `
    <div class="card" style="max-width:520px;width:100%;margin:0">
      <h3>➕ 添加栏目</h3>
      <div class="field">
        <label>栏目简码 或 栏目页链接</label>
        <input id="ac-code" placeholder="例如：jlp（纪录片）或 https://tv.cctv.com/lm/jlp/index.shtml">
        <div style="font-size:12px;color:var(--text-mute);margin-top:6px">从央视网栏目页地址中提取的英文简码，如 tv.cctv.com/lm/<b>jlp</b>/</div>
      </div>
      <div class="row" style="margin-bottom:16px">
        <button class="btn btn-ghost" id="ac-resolve">🔍 解析栏目信息</button>
      </div>
      <div id="ac-preview"></div>
      <div class="row" style="margin-top:20px">
        <button class="btn btn-ghost" id="ac-cancel">取消</button>
        <button class="btn btn-primary" id="ac-save" disabled>保存栏目</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  let resolved = null;

  $('#ac-cancel', mask).onclick = () => mask.remove();
  mask.onclick = (e) => e.target === mask && mask.remove();
  $('#ac-resolve', mask).onclick = async () => {
    const code = $('#ac-code', mask).value.trim();
    if (!code) return toast('请输入简码或链接', 'err');
    $('#ac-preview', mask).innerHTML = '<div style="color:var(--text-mute)">解析中…</div>';
    try {
      const r = await API('/api/columns/resolve', { method: 'POST', body: { code } });
      resolved = r;
      $('#ac-preview', mask).innerHTML = `
        <div class="card" style="margin:0;background:var(--bg)">
          <div style="margin-bottom:10px"><b style="font-size:16px">${esc(r.name)}</b> <span class="badge dim">${esc(r.ctid)}</span></div>
          <div style="font-size:13px;color:var(--text-dim)">共 ${r.total.toLocaleString()} 期内容</div>
          ${r.sample ? `<div style="font-size:12.5px;color:var(--text-mute);margin-top:8px">最新：${esc(r.sample.title)}</div>` : ''}
        </div>`;
      $('#ac-save', mask).disabled = false;
    } catch (e) {
      $('#ac-preview', mask).innerHTML = `<div style="color:var(--err)">解析失败：${esc(e.message)}</div>`;
    }
  };
  $('#ac-save', mask).onclick = async () => {
    if (!resolved) return;
    try {
      await API('/api/admin/columns', {
        method: 'POST',
        body: { id: resolved.ctid, name: resolved.name, ctid: resolved.ctid, category: 'other' },
      });
      toast('栏目已添加', 'ok');
      mask.remove();
      onDone && onDone();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ============================================================
   自定义源
   ============================================================ */
async function viewSources(c) {
  c.innerHTML = `
    <div class="page-head">
      <div><h2>自定义源</h2><div class="sub">添加任意上游接口或直链，扩展内容来源</div></div>
      <button class="btn btn-primary" id="add-src">+ 添加源</button>
    </div>
    <div class="card"><div id="src-list"></div></div>
    <div class="card">
      <h3>📖 支持的源类型</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>类型</th><th>说明</th><th>配置示例</th></tr></thead>
        <tbody>
          <tr><td class="name">央视官方</td><td>央视网公开接口（内置）</td><td><code>{ "serviceId": "tvcctv" }</code></td></tr>
          <tr><td class="name">M3U 订阅</td><td>导入 m3u/m3u8 播放列表</td><td><code>http://example.com/live.m3u</code></td></tr>
          <tr><td class="name">直链</td><td>单个 HLS/FLV/MP4 地址</td><td><code>https://.../stream.m3u8</code></td></tr>
          <tr><td class="name">自定义 API</td><td>返回 JSON 列表的上游接口</td><td><code>https://api.example.com/list</code></td></tr>
        </tbody></table></div>
    </div>`;
  const load = async () => {
    const d = await API('/api/sources');
    $('#src-list').innerHTML = d.sources.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>名称</th><th>类型</th><th>地址</th><th style="width:90px">启用</th><th style="width:80px">操作</th></tr></thead>
      <tbody>${d.sources.map((s) => `<tr>
        <td class="name">${esc(s.name)} ${s.builtin ? '<span class="badge on">内置</span>' : ''}</td>
        <td><span class="badge dim">${esc(s.type)}</span></td>
        <td style="color:var(--text-mute);font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.url || JSON.stringify(s.config || {}))}</td>
        <td><div class="switch ${s.enabled ? 'on' : ''}" data-src="${s.id}"></div></td>
        <td>${s.builtin ? '—' : `<button class="btn btn-danger btn-sm" data-delsrc="${s.id}">删除</button>`}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty"><div class="i">🔌</div>暂无自定义源</div>';

    $$('.switch[data-src]', $('#src-list')).forEach((sw) => (sw.onclick = async () => {
      const s = d.sources.find((x) => x.id === sw.dataset.src);
      await API('/api/sources/' + s.id, { method: 'PUT', body: { enabled: !s.enabled } });
      sw.classList.toggle('on');
      toast('已更新');
    }));
    $$('[data-delsrc]', $('#src-list')).forEach((b) => (b.onclick = async () => {
      if (!confirm('确定删除该源？')) return;
      await API('/api/sources/' + b.dataset.delsrc, { method: 'DELETE' });
      toast('已删除');
      load();
    }));
  };
  $('#add-src').onclick = () => showAddSource(load);
  load();
}

function showAddSource(onDone) {
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:900;display:grid;place-items:center;padding:20px';
  mask.innerHTML = `
    <div class="card" style="max-width:520px;width:100%;margin:0">
      <h3>➕ 添加自定义源</h3>
      <div class="field"><label>源名称</label><input id="s-name" placeholder="例如：我的直播源"></div>
      <div class="field"><label>源类型</label>
        <select id="s-type">
          <option value="m3u">M3U 订阅</option>
          <option value="direct">直链 (HLS/FLV/MP4)</option>
          <option value="api">自定义 API</option>
          <option value="cctv">央视接口</option>
        </select>
      </div>
      <div class="field"><label>地址 / 配置</label><input id="s-url" placeholder="https://example.com/list.m3u"></div>
      <div class="row" style="margin-top:20px">
        <button class="btn btn-ghost" id="s-cancel">取消</button>
        <button class="btn btn-primary" id="s-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  $('#s-cancel', mask).onclick = () => mask.remove();
  mask.onclick = (e) => e.target === mask && mask.remove();
  $('#s-save', mask).onclick = async () => {
    const name = $('#s-name', mask).value.trim();
    if (!name) return toast('请输入名称', 'err');
    await API('/api/sources', { method: 'POST', body: { name, type: $('#s-type', mask).value, url: $('#s-url', mask).value.trim() } });
    toast('已添加', 'ok');
    mask.remove();
    onDone && onDone();
  };
}

/* ============================================================
   接口监控
   ============================================================ */
async function viewHealth(c) {
  c.innerHTML = `
    <div class="page-head">
      <div><h2>接口监控</h2><div class="sub">上游接口可用性与成功率</div></div>
      <button class="btn btn-primary" id="probe">⚡ 主动探测</button>
    </div>
    <div class="card" id="health-box"><div class="empty"><div class="i">⏳</div>加载中…</div></div>
    <div class="card">
      <h3>🛠 稳定性机制</h3>
      <div class="switch-row"><div><div class="t">自动重试</div><div class="d">接口失败自动重试 2 次，指数退避</div></div><span class="badge ok">已开启</span></div>
      <div class="switch-row"><div><div class="t">结果缓存</div><div class="d">列表 10 分钟、取流 6 分钟、直播 1 分钟</div></div><span class="badge ok">已开启</span></div>
      <div class="switch-row"><div><div class="t">多线路容灾</div><div class="d">播放失败自动切换备用线路（HLS/FLV/加密流）</div></div><span class="badge ok">已开启</span></div>
      <div class="switch-row"><div><div class="t">清晰度自适应</div><div class="d">HLS 自动档位选择，卡顿自动降码率</div></div><span class="badge ok">已开启</span></div>
    </div>`;

  const load = async (probe) => {
    $('#health-box').innerHTML = '<div class="empty"><div class="i">⏳</div>' + (probe ? '探测中…' : '加载中…') + '</div>';
    const d = await API('/api/admin/health' + (probe ? '?probe=1' : ''));
    $('#health-box').innerHTML = '<h3>📡 接口状态</h3>' + renderHealthTable(d.stats);
  };
  $('#probe').onclick = () => { toast('正在探测…'); load(true).then(() => toast('探测完成', 'ok')); };
  load(false);
}

/* ============================================================
   会员付费
   ============================================================ */
async function viewMonetize(c) {
  const s = app.settings;
  const m = s.monetize;
  c.innerHTML = `
    <div class="page-head"><div><h2>会员付费</h2><div class="sub">可选模块 · 关闭时完全免费</div></div></div>
    <div class="card">
      <div class="switch-row">
        <div><div class="t">启用付费模块</div><div class="d">关闭后所有内容永久免费，无任何会员限制（开源默认）</div></div>
        <div class="switch ${m.enabled ? 'on' : ''}" id="m-toggle"></div>
      </div>
      <div style="padding:14px 0 0;font-size:13px;color:var(--text-mute)">
        说明：核心影视观看<b style="color:var(--text-dim)">永久免费</b>。开启付费模块后，会员可获得增值权益（去广告、超清画质、无限收藏等），
        这是常见的开源项目可持续模式。支付网关需自行对接。
      </div>
    </div>
    <div class="card">
      <h3>💎 会员套餐</h3>
      <div id="plans"></div>
      <button class="btn btn-ghost btn-sm" id="add-plan" style="margin-top:14px">+ 添加套餐</button>
      <button class="btn btn-primary btn-sm" id="save-plans" style="margin-top:14px;margin-left:8px">保存套餐</button>
    </div>
    <div class="card">
      <h3>🧾 订单记录</h3>
      <div id="orders"></div>
    </div>`;

  let plans = JSON.parse(JSON.stringify(m.plans || []));
  const paintPlans = () => {
    $('#plans').innerHTML = plans.map((p, i) => `
      <div class="card" style="background:var(--bg);margin-bottom:12px">
        <div class="row">
          <div style="flex:1"><label>套餐名称</label><input data-i="${i}" data-k="name" value="${esc(p.name)}"></div>
          <div style="width:110px;flex:0 0 auto"><label>天数</label><input data-i="${i}" data-k="days" type="number" value="${p.days}"></div>
          <div style="width:110px;flex:0 0 auto"><label>价格 ¥</label><input data-i="${i}" data-k="price" type="number" value="${p.price}"></div>
          <div style="flex:0 0 auto;align-self:flex-end"><button class="btn btn-danger btn-sm" data-rm="${i}">删除</button></div>
        </div>
        <div class="field" style="margin:12px 0 0"><label>权益（逗号分隔）</label>
          <input data-i="${i}" data-k="perks" value="${esc((p.perks || []).join('，'))}"></div>
      </div>`).join('') || '<div class="empty">暂无套餐</div>';

    $$('[data-i]', $('#plans')).forEach((inp) => (inp.oninput = () => {
      const i = +inp.dataset.i, k = inp.dataset.k;
      if (k === 'perks') plans[i].perks = inp.value.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
      else if (k === 'days' || k === 'price') plans[i][k] = +inp.value;
      else plans[i][k] = inp.value;
    }));
    $$('[data-rm]', $('#plans')).forEach((b) => (b.onclick = () => { plans.splice(+b.dataset.rm, 1); paintPlans(); }));
  };
  paintPlans();

  $('#m-toggle').onclick = async (e) => {
    const on = !e.target.classList.contains('on');
    e.target.classList.toggle('on');
    await API('/api/admin/monetize', { method: 'PUT', body: { enabled: on, plans } });
    app.settings.monetize.enabled = on;
    toast(on ? '付费模块已启用' : '付费模块已关闭', 'ok');
  };
  $('#add-plan').onclick = () => { plans.push({ id: 'plan_' + Date.now().toString(36), name: '新套餐', days: 30, price: 10, perks: [] }); paintPlans(); };
  $('#save-plans').onclick = async () => {
    await API('/api/admin/monetize', { method: 'PUT', body: { enabled: app.settings.monetize.enabled, plans } });
    app.settings.monetize.plans = plans;
    toast('套餐已保存', 'ok');
  };

  // 订单
  const d = await API('/api/admin/orders');
  $('#orders').innerHTML = d.orders.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>订单号</th><th>套餐</th><th>金额</th><th>账号</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
    <tbody>${d.orders.map((o) => `<tr>
      <td style="font-size:12px">${esc(o.id)}</td>
      <td>${esc(o.planName)}</td>
      <td>¥${o.amount}</td>
      <td>${esc(o.account)}</td>
      <td><span class="badge ${o.status === 'paid' ? 'ok' : 'warn'}">${o.status === 'paid' ? '已支付' : '待支付'}</span></td>
      <td style="font-size:12px;color:var(--text-mute)">${new Date(o.createdAt).toLocaleString('zh-CN')}</td>
      <td>${o.status !== 'paid' ? `<button class="btn btn-ghost btn-sm" data-pay="${o.id}">标记已支付</button>` : '—'}</td>
    </tr>`).join('')}</tbody></table></div>` : '<div class="empty"><div class="i">🧾</div>暂无订单</div>';

  $$('[data-pay]').forEach((b) => (b.onclick = async () => {
    await API('/api/pay/callback', { method: 'POST', body: { orderId: b.dataset.pay } });
    toast('已标记支付', 'ok');
    viewMonetize($('#content'));
  }));
}

/* ============================================================
   站点设置
   ============================================================ */
async function viewSettings(c) {
  const s = app.settings;
  let cats = (app.site && app.site.categories) || [];
  c.innerHTML = `
    <div class="page-head"><div><h2>站点设置</h2><div class="sub">站点信息、外观与播放策略</div></div>
      <button class="btn btn-primary" id="save-set">保存设置</button></div>

    <div class="grid2">
      <div class="card">
        <h3>🏷️ 基本信息</h3>
        <div class="field"><label>站点名称</label><input id="s-name" value="${esc(s.siteName)}"></div>
        <div class="field"><label>站点标语</label><input id="s-slogan" value="${esc(s.slogan)}"></div>
        <div class="field"><label>公告</label><textarea id="s-notice" rows="3">${esc(s.announcement)}</textarea></div>
      </div>
      <div class="card">
        <h3>🎨 外观主题</h3>
        <div class="field"><label>主题模式</label>
          <select id="s-mode">
            <option value="dark" ${s.theme.mode === 'dark' ? 'selected' : ''}>深色（影院风）</option>
            <option value="light" ${s.theme.mode === 'light' ? 'selected' : ''}>浅色</option>
          </select></div>
        <div class="row">
          <div><label>主色</label><input id="s-primary" type="color" value="${s.theme.primary}" style="height:42px;padding:4px"></div>
          <div><label>强调色</label><input id="s-accent" type="color" value="${s.theme.accent}" style="height:42px;padding:4px"></div>
        </div>
      </div>
      <div class="card">
        <h3>▶️ 播放策略</h3>
        <div class="switch-row"><div><div class="t">自动清晰度</div><div class="d">根据网速自动选择画质</div></div>
          <div class="switch ${s.playback.autoQuality ? 'on' : ''}" id="p-autoq"></div></div>
        <div class="switch-row"><div><div class="t">失败自动切源</div><div class="d">线路异常时自动切换备用源</div></div>
          <div class="switch ${s.playback.autoFailover ? 'on' : ''}" id="p-failover"></div></div>
        <div class="switch-row"><div><div class="t">预加载</div><div class="d">提前缓冲下一段内容</div></div>
          <div class="switch ${s.playback.preload ? 'on' : ''}" id="p-preload"></div></div>
      </div>
      <div class="card">
        <h3>🔐 安全</h3>
        <div class="field"><label>管理员账号</label><input id="s-admin" value="${esc(s.adminUsername || 'admin')}"></div>
        <div class="field"><label>管理员密码</label><input id="s-pass" type="text" value="${esc(s.adminPassword || 'admin888')}"></div>
        <div style="font-size:12.5px;color:var(--warn)">⚠️ 开源部署时请务必修改默认密码</div>
      </div>
    </div>
    ${communityCard()}`;

  const sw = (id, key) => {
    const el = $(id);
    el.onclick = () => { el.classList.toggle('on'); };
  };
  sw('#p-autoq'); sw('#p-failover'); sw('#p-preload');
  bindCommunityCard();

  $('#save-set').onclick = async () => {
    const patch = {
      siteName: $('#s-name').value,
      slogan: $('#s-slogan').value,
      announcement: $('#s-notice').value,
      adminUsername: $('#s-admin').value,
      adminPassword: $('#s-pass').value,
      theme: { mode: $('#s-mode').value, primary: $('#s-primary').value, accent: $('#s-accent').value },
      playback: {
        autoQuality: $('#p-autoq').classList.contains('on'),
        autoFailover: $('#p-failover').classList.contains('on'),
        preload: $('#p-preload').classList.contains('on'),
      },
    };
    app.settings = await API('/api/admin/settings', { method: 'PUT', body: patch });
    await saveCommunityCard();
    toast('设置已保存', 'ok');
  };
}

/* ============================================================
   数据备份
   ============================================================ */
function viewData(c) {
  c.innerHTML = `
    <div class="page-head"><div><h2>数据备份</h2><div class="sub">导出/导入站点配置</div></div></div>
    <div class="grid2">
      <div class="card">
        <h3>📤 导出配置</h3>
        <p style="color:var(--text-dim);font-size:13.5px;margin-bottom:16px">
          导出站点设置、自定义源、栏目配置为 JSON 文件，便于迁移或备份。</p>
        <button class="btn btn-primary" id="do-export">下载配置文件</button>
      </div>
      <div class="card">
        <h3>📥 导入配置</h3>
        <p style="color:var(--text-dim);font-size:13.5px;margin-bottom:16px">
          从 JSON 文件恢复配置，将覆盖当前设置。</p>
        <input type="file" id="imp-file" accept=".json" style="margin-bottom:12px">
        <button class="btn btn-ghost" id="do-import">导入配置</button>
      </div>
      <div class="card">
        <h3>🔗 快捷链接</h3>
        <div class="switch-row"><div><div class="t">前台首页</div><div class="d">/</div></div>
          <a class="btn btn-ghost btn-sm" href="/" target="_blank">打开</a></div>
        <div class="switch-row"><div><div class="t">电视直播</div><div class="d">/#/live</div></div>
          <a class="btn btn-ghost btn-sm" href="/#/live" target="_blank">打开</a></div>
        <div class="switch-row"><div><div class="t">全部栏目</div><div class="d">/#/discover</div></div>
          <a class="btn btn-ghost btn-sm" href="/#/discover" target="_blank">打开</a></div>
      </div>
    </div>`;

  $('#do-export').onclick = async () => {
    const d = await API('/api/admin/export');
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ciyun-config-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    toast('已导出', 'ok');
  };
  $('#do-import').onclick = async () => {
    const f = $('#imp-file').files[0];
    if (!f) return toast('请选择文件', 'err');
    const text = await f.text();
    try {
      await API('/api/admin/import', { method: 'POST', body: JSON.parse(text) });
      toast('导入成功，正在刷新…', 'ok');
      setTimeout(() => location.reload(), 800);
    } catch (e) { toast('导入失败：' + e.message, 'err'); }
  };
}

/* ============================================================
   评论管理
   ============================================================ */
async function viewComments(c) {
  c.innerHTML =
    '<div class="page-head"><div><h2>评论管理</h2><div class="sub">审核、隐藏或删除用户评论</div></div>' +
    '<button class="btn btn-ghost" id="cm-refresh">\u21bb 刷新</button></div>' +
    '<div class="card"><div class="row" style="margin-bottom:16px;flex-wrap:wrap;gap:10px">' +
    '<input id="cm-kw" placeholder="搜索内容 / 昵称 / 目标ID\u2026" style="flex:1;min-width:200px">' +
    '<select id="cm-status" style="width:150px"><option value="">全部状态</option>' +
    '<option value="visible">已公开</option><option value="pending">待审核</option>' +
    '<option value="hidden">已隐藏</option><option value="deleted">已删除</option></select></div>' +
    '<div id="cm-list"></div></div>';

  let page = 1;
  const badge = (s) => ({
    visible: '<span class="badge ok">已公开</span>',
    pending: '<span class="badge warn">待审核</span>',
    hidden: '<span class="badge err">已隐藏</span>',
    deleted: '<span class="badge dim">已删除</span>',
  }[s] || s);

  const load = async () => {
    const kw = $('#cm-kw').value.trim();
    const st = $('#cm-status').value;
    $('#cm-list').innerHTML = '<div class="empty"><div class="i">\u23f3</div>加载中\u2026</div>';
    const d = await API('/api/admin/comments?page=' + page + '&size=20&status=' + st + '&keyword=' + encodeURIComponent(kw));
    if (!d.list.length) {
      $('#cm-list').innerHTML = '<div class="empty"><div class="i">\ud83d\udcac</div>暂无评论</div>';
      return;
    }
    $('#cm-list').innerHTML =
      '<div class="cm-manage">' +
      d.list.map((x) =>
        '<div class="cm-card" data-id="' + x.id + '">' +
          '<div class="cm-card-head">' +
            '<div class="cm-avatar">' + esc((x.nickname || '?').slice(0, 1).toUpperCase()) + '</div>' +
            '<div style="flex:1;min-width:0">' +
              '<div class="cm-name">' + esc(x.nickname) + ' <span style="color:var(--text-mute);font-weight:400">@' + esc(x.account) + '</span></div>' +
              '<div class="cm-meta">' + new Date(x.createdAt).toLocaleString('zh-CN') + ' \u00b7 ' + esc(x.targetType) + '/' + esc(String(x.targetId).slice(0, 12)) + ' \u00b7 \ud83d\udc4d ' + x.likes + '</div>' +
            '</div>' + badge(x.status) +
          '</div>' +
          (x.parent ? '<div class="cm-parent">\u21b3 回复 @' + esc(x.parent.nickname) + '</div>' : '') +
          '<div class="cm-body">' + (esc(x.content) || '<i style="color:var(--text-mute)">（内容已删除）</i>') + '</div>' +
          '<div class="cm-actions">' +
            (x.status !== 'visible' ? '<button class="btn btn-ghost btn-sm" data-act="visible">\u2713 通过</button>' : '') +
            (x.status === 'visible' ? '<button class="btn btn-ghost btn-sm" data-act="hidden">\ud83d\udeab 隐藏</button>' : '') +
            '<button class="btn btn-danger btn-sm" data-act="del">删除</button>' +
          '</div>' +
        '</div>'
      ).join('') +
      '</div><div class="pager">' +
      '<button class="btn btn-ghost btn-sm" id="cm-prev" ' + (page <= 1 ? 'disabled' : '') + '>\u2039 上一页</button>' +
      '<span style="color:var(--text-mute);font-size:13px">第 ' + page + ' 页 \u00b7 共 ' + d.total + ' 条</span>' +
      '<button class="btn btn-ghost btn-sm" id="cm-next" ' + (page * 20 >= d.total ? 'disabled' : '') + '>下一页 \u203a</button></div>';

    $$('.cm-card', $('#cm-list')).forEach((card) => {
      const id = card.dataset.id;
      $$('[data-act]', card).forEach((b) => (b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'del') {
          if (!confirm('确定删除该评论？其回复也将一并移除。')) return;
          await API('/api/admin/comments/' + id, { method: 'DELETE' });
          toast('已删除', 'ok');
        } else {
          await API('/api/admin/comments/' + id, { method: 'PUT', body: { status: act } });
          toast(act === 'visible' ? '已通过' : '已隐藏', 'ok');
        }
        load();
      }));
    });
    if ($('#cm-prev')) $('#cm-prev').onclick = () => { page = Math.max(1, page - 1); load(); };
    if ($('#cm-next')) $('#cm-next').onclick = () => { page++; load(); };
  };
  $('#cm-refresh').onclick = load;
  $('#cm-kw').oninput = debounce(load, 350);
  $('#cm-status').onchange = () => { page = 1; load(); };
  load();
}

/* ============================================================
   用户管理
   ============================================================ */
async function viewUsers(c) {
  c.innerHTML = '<div class="page-head"><div><h2>用户管理</h2><div class="sub">注册用户、封禁与密码重置</div></div></div>' +
    '<div class="card" id="user-box"><div class="empty"><div class="i">\u23f3</div>加载中\u2026</div></div>';

  const load = async () => {
    const d = await API('/api/admin/users');
    if (!d.users.length) {
      $('#user-box').innerHTML = '<div class="empty"><div class="i">\ud83d\udc65</div>暂无注册用户</div>';
      return;
    }
    $('#user-box').innerHTML = '<div class="table-wrap"><table class="table">' +
      '<thead><tr><th>账号</th><th>昵称</th><th>邮箱</th><th>评论</th><th>注册</th><th>状态</th><th style="width:220px">操作</th></tr></thead>' +
      '<tbody>' + d.users.map((u) =>
        '<tr><td class="name">' + esc(u.account) + '</td>' +
        '<td>' + esc(u.nickname || '\u2014') + '</td>' +
        '<td style="font-size:12px;color:var(--text-mute)">' + esc(u.email || '\u2014') + '</td>' +
        '<td>' + u.comments + '</td>' +
        '<td style="font-size:12px;color:var(--text-mute)">' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '\u2014') + '</td>' +
        '<td><span class="badge ' + (u.status === 'banned' ? 'err' : 'ok') + '">' + (u.status === 'banned' ? '已封禁' : '正常') + '</span></td>' +
        '<td><button class="btn btn-ghost btn-sm" data-ban="' + esc(u.account) + '" data-cur="' + (u.status || 'active') + '">' + (u.status === 'banned' ? '解封' : '封禁') + '</button> ' +
        '<button class="btn btn-ghost btn-sm" data-pwd="' + esc(u.account) + '">重置密码</button> ' +
        '<button class="btn btn-danger btn-sm" data-del="' + esc(u.account) + '">删除</button></td></tr>'
      ).join('') + '</tbody></table></div>';

    $$('[data-ban]').forEach((b) => (b.onclick = async () => {
      const next = b.dataset.cur === 'banned' ? 'active' : 'banned';
      await API('/api/admin/users/' + encodeURIComponent(b.dataset.ban), { method: 'PUT', body: { status: next } });
      toast(next === 'banned' ? '已封禁' : '已解封', 'ok');
      load();
    }));
    $$('[data-pwd]').forEach((b) => (b.onclick = async () => {
      const p = prompt('为该用户设置新密码（至少 8 位，含字母和数字）：');
      if (!p) return;
      try {
        await API('/api/admin/users/' + encodeURIComponent(b.dataset.pwd), { method: 'PUT', body: { resetPassword: p } });
        toast('密码已重置', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('删除用户 @' + b.dataset.del + ' 及其全部评论？')) return;
      await API('/api/admin/users/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
      toast('已删除', 'ok');
      load();
    }));
  };
  load();
}

/* ============================================================
   家庭管理
   ============================================================ */
async function viewFamilies(c) {
  c.innerHTML = '<div class="page-head"><div><h2>家庭共享</h2><div class="sub">家庭单元、成员与共享策略</div></div></div>' +
    '<div class="card"><h3>\u2699\ufe0f 模块设置</h3><div id="fam-cfg"></div></div>' +
    '<div class="card"><h3>\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66 家庭列表</h3><div id="fam-list"></div></div>';

  const cfg = (app.settings && app.settings.family) || {};
  const sw = (id, on) => '<div class="switch ' + (on ? 'on' : '') + '" id="' + id + '"></div>';
  $('#fam-cfg').innerHTML =
    '<div class="switch-row"><div><div class="t">启用家庭功能</div><div class="d">关闭后前台隐藏家庭入口</div></div>' + sw('f-en', cfg.enabled !== false) + '</div>' +
    '<div class="switch-row"><div><div class="t">需会员才能创建</div><div class="d">户主必须是有效会员</div></div>' + sw('f-vip', cfg.requireVip !== false) + '</div>' +
    '<div class="switch-row"><div><div class="t">成员共享会员权益</div><div class="d">户主是会员时，成员同步享受（如去广告）</div></div>' + sw('f-share', cfg.shareVip !== false) + '</div>' +
    '<div class="switch-row"><div><div class="t">允许成员主动退出</div><div class="d">关闭后仅户主可移除成员</div></div>' + sw('f-leave', cfg.allowLeave !== false) + '</div>' +
    '<div class="field" style="margin-top:12px"><label>每户最多成员数（不含户主，1+?）</label>' +
    '<input id="f-max" type="number" min="1" max="20" value="' + (cfg.maxMembers || 5) + '" style="max-width:160px"></div>' +
    '<button class="btn btn-primary btn-sm" id="f-save" style="margin-top:14px">保存设置</button>';

  ['f-en', 'f-vip', 'f-share', 'f-leave'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.onclick = () => el.classList.toggle('on');
  });
  $('#f-save').onclick = async () => {
    const body = {
      enabled: $('#f-en').classList.contains('on'),
      requireVip: $('#f-vip').classList.contains('on'),
      shareVip: $('#f-share').classList.contains('on'),
      allowLeave: $('#f-leave').classList.contains('on'),
      maxMembers: +$('#f-max').value || 5,
    };
    app.settings.family = await API('/api/admin/family', { method: 'PUT', body });
    toast('已保存', 'ok');
  };

  const d = await API('/api/admin/families');
  $('#fam-list').innerHTML = d.families.length
    ? '<div class="table-wrap"><table class="table"><thead><tr><th>家庭名</th><th>户主</th><th>成员</th><th>创建时间</th><th style="width:90px">操作</th></tr></thead><tbody>' +
      d.families.map((f) =>
        '<tr><td class="name">' + esc(f.name) + '</td><td>' + esc(f.ownerNickname) + ' <span style="color:var(--text-mute);font-size:12px">@' + esc(f.owner) + '</span></td>' +
        '<td>' + f.count + ' / ' + f.max + '</td>' +
        '<td style="font-size:12px;color:var(--text-mute)">' + new Date(f.createdAt).toLocaleDateString('zh-CN') + '</td>' +
        '<td><button class="btn btn-danger btn-sm" data-delfam="' + f.id + '">解散</button></td></tr>'
      ).join('') + '</tbody></table></div>'
    : '<div class="empty"><div class="i">\ud83c\udfe0</div>暂无家庭</div>';

  $$('[data-delfam]').forEach((b) => (b.onclick = async () => {
    if (!confirm('确定解散该家庭？')) return;
    await API('/api/admin/families/' + b.dataset.delfam, { method: 'DELETE' });
    toast('已解散', 'ok');
    viewFamilies($('#content'));
  }));
}

/* ============================================================
   社区设置（合并进设置页）
   ============================================================ */
function communityCard() {
  const cm = (app.settings && app.settings.community) || {};
  return '<div class="card"><h3>\ud83d\udcac 社区与评论</h3>' +
    '<div class="switch-row"><div><div class="t">开放注册</div><div class="d">关闭后新用户无法注册</div></div><div class="switch ' + (cm.allowRegister !== false ? 'on' : '') + '" id="c-reg"></div></div>' +
    '<div class="switch-row"><div><div class="t">开启评论</div><div class="d">关闭后前台隐藏评论区</div></div><div class="switch ' + (cm.allowComment !== false ? 'on' : '') + '" id="c-comment"></div></div>' +
    '<div class="switch-row"><div><div class="t">允许游客评论</div><div class="d">关闭后必须登录才能评论</div></div><div class="switch ' + (cm.guestComment ? 'on' : '') + '" id="c-guest"></div></div>' +
    '<div class="switch-row"><div><div class="t">评论先审后发</div><div class="d">新评论需管理员审核后公开</div></div><div class="switch ' + (cm.commentReview ? 'on' : '') + '" id="c-review"></div></div>' +
    '<div class="row" style="margin-top:12px"><div><label>评论字数上限</label><input id="c-maxlen" type="number" value="' + (cm.maxLen || 500) + '"></div>' +
    '<div><label>发言间隔（秒）</label><input id="c-interval" type="number" value="' + (cm.interval || 15) + '"></div></div>' +
    '<div class="field" style="margin-top:12px"><label>敏感词（逗号分隔）</label><input id="c-kw" value="' + esc((cm.keywords || []).join('，')) + '"></div>' +
    '</div>';
}

function bindCommunityCard() {
  ['c-reg', 'c-comment', 'c-guest', 'c-review'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.onclick = () => el.classList.toggle('on');
  });
}

async function saveCommunityCard() {
  const body = {
    allowRegister: $('#c-reg') && $('#c-reg').classList.contains('on'),
    allowComment: $('#c-comment') && $('#c-comment').classList.contains('on'),
    guestComment: $('#c-guest') && $('#c-guest').classList.contains('on'),
    commentReview: $('#c-review') && $('#c-review').classList.contains('on'),
    maxLen: +($('#c-maxlen') || {}).value || 500,
    interval: +($('#c-interval') || {}).value || 15,
    keywords: (($('#c-kw') || {}).value || '').split(/[，,]/).map((x) => x.trim()).filter(Boolean),
  };
  app.settings.community = await API('/api/admin/community', { method: 'PUT', body });
}

boot();
