/* ============================================================
   慈云影视 · 核心工具库
   ============================================================ */

/** 极简 DOM 创建 */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

/** HTML 转义 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

/** 时长格式化 mm:ss / hh:mm:ss */
export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 把 "00:43:49" 转秒 */
export function durToSec(str) {
  if (!str) return 0;
  const p = String(str).split(':').map(Number).reverse();
  return (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600;
}

/** 时间戳 -> 相对时间 */
export function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - new Date(ts).getTime();
  const day = Math.floor(d / 86400000);
  if (day > 30) return new Date(ts).toLocaleDateString('zh-CN');
  if (day > 0) return day + ' 天前';
  const hr = Math.floor(d / 3600000);
  if (hr > 0) return hr + ' 小时前';
  const mi = Math.floor(d / 60000);
  return mi > 0 ? mi + ' 分钟前' : '刚刚';
}

/** 数字简写 1.2万 */
export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
}

/** 请求封装 */
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body && typeof opts.body === 'object' ? JSON.stringify(opts.body) : opts.body,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** 路由：极简 hash 路由 */
export function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  const seg = path.split('/').filter(Boolean);
  return { path, seg, params };
}

export function go(path) {
  if (location.hash === '#' + path) return;
  location.hash = path;
}

/**
 * 替换式跳转：不向浏览器历史压栈，而是替换当前条目。
 * 用途：登录页、守卫重定向等「自动跳转」。
 * 背景：如果用 go()（压栈），登录成功后按「返回」会再次落回登录页，
 *      登录页发现已登录又自动跳走 → 历史死循环，用户永远回不去
 *      登录前的页面（「登录之后没法返回」的根因）。
 *      用 replace 后，返回键会直接跳过登录页。
 */
export function goReplace(path) {
  const target = '#' + String(path || '/').replace(/^#/, '');
  if (location.hash === target) return;
  location.replace(target);
}

/**
 * 会话内导航栈：记录本站 hash 路由轨迹（最多 25 条）。
 * 在 route() 中调用；给「← 返回」按钮提供可靠的回退目标 ——
 * 直接 history.back() 可能跳出站外（比如从搜索引擎直达登录页），
 * 这里只回站内页。
 */
export function navStackPush() {
  try {
    const stack = JSON.parse(sessionStorage.getItem('cy_navstack') || '[]');
    const cur = location.hash || '#/';
    if (stack[stack.length - 1] !== cur) {
      stack.push(cur);
      sessionStorage.setItem('cy_navstack', JSON.stringify(stack.slice(-25)));
    }
  } catch { /* 存储不可用不影响路由 */ }
}

/** 智能返回：优先回站内上一页；没有可靠来路则回 fallback（默认首页）。替换式跳转。 */
export function goBackOrHome(fallback = '/') {
  let stack = [];
  try { stack = JSON.parse(sessionStorage.getItem('cy_navstack') || '[]'); } catch {}
  const cur = location.hash || '#/';
  while (stack.length && stack[stack.length - 1] === cur) stack.pop();
  const prev = stack[stack.length - 1];
  // 上一页不能又是登录/注册页（否则来回横跳）
  if (prev && prev !== cur && !/\/(login|register|forgot)\b/.test(prev)) {
    goReplace(prev);
  } else {
    goReplace(fallback);
  }
}

/**
 * 只允许站内路径的跳转地址（防开放重定向 / javascript: 注入）。
 * 用于处理 ?redirect= 参数：外链、协议头一律回落到 fallback。
 */
export function safeRedirect(raw, fallback = '/') {
  const s = String(raw || '').trim();
  if (!s) return fallback;
  if (/^(https?:)?\/\//i.test(s)) return fallback;   // 绝对地址 / 协议相对
  if (/^(javascript|data|vbscript):/i.test(s)) return fallback;
  return s.startsWith('#') ? s.slice(1) : s;
}

/** 本地存储 */
export const ls = {
  get(k, d) {
    try {
      const v = localStorage.getItem('cy_' + k);
      return v ? JSON.parse(v) : d;
    } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('cy_' + k, JSON.stringify(v)); } catch {}
  },
  del(k) {
    try { localStorage.removeItem('cy_' + k); } catch {}
  },
};

/** 收藏管理 */
export const fav = {
  list() { return ls.get('favs', []); },
  has(guid) { return this.list().some((x) => x.guid === guid); },
  toggle(item) {
    const arr = this.list();
    const i = arr.findIndex((x) => x.guid === item.guid);
    if (i >= 0) arr.splice(i, 1);
    else arr.unshift({ ...item, ts: Date.now() });
    ls.set('favs', arr.slice(0, 300));
    return i < 0;
  },
  remove(guid) { ls.set('favs', this.list().filter((x) => x.guid !== guid)); },
};

/** 观看历史（含播放进度：看到第几集、第几秒） */
export const history = {
  list() { return ls.get('history', []); },
  add(item) {
    const arr = this.list().filter((x) => x.guid !== item.guid);
    arr.unshift({ ...item, ts: Date.now() });
    ls.set('history', arr.slice(0, 120));
  },

  /**
   * 记录播放进度。
   * @param {string} guid 影片唯一标识
   * @param {{epIndex?:number, epName?:string, time?:number}} pos
   */
  savePos(guid, pos = {}) {
    const all = ls.get('positions', {});
    const prev = all[guid] || {};
    all[guid] = {
      epIndex: pos.epIndex != null ? pos.epIndex : (prev.epIndex || 0),
      epName: pos.epName != null ? pos.epName : (prev.epName || ''),
      time: pos.time != null ? pos.time : (prev.time || 0),
      lineIndex: pos.lineIndex != null ? pos.lineIndex : (prev.lineIndex || 0),
      ts: Date.now(),
    };
    ls.set('positions', all);
  },

  /** 读取播放进度；无记录返回 null */
  getPos(guid) {
    const all = ls.get('positions', {});
    const p = all[guid];
    if (!p) return null;
    // 超过 60 天自动失效，避免陈旧记录误导续播
    if (p.ts && Date.now() - p.ts > 60 * 86400000) return null;
    return p;
  },

  /** 清空某片的进度（看完时调用） */
  clearPos(guid) {
    const all = ls.get('positions', {});
    if (all[guid]) { delete all[guid]; ls.set('positions', all); }
  },

  /** 格式化秒数为 12:34 / 1:02:34 */
  fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  },

  clear() { ls.del('history'); },
};

/** 图片懒加载观察器 */
let io = null;
export function lazyImg(img, src) {
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const el = e.target;
            const s = el.dataset.src;
            if (s) {
              el.src = s;
              el.onload = () => el.classList.add('loaded');
              el.onerror = () => {
                el.remove();
                const fb = el.parentElement && el.parentElement.querySelector('.card-fallback');
                if (fb) fb.style.display = 'grid';
              };
              delete el.dataset.src;
            }
            io.unobserve(el);
          }
        }
      },
      { rootMargin: '300px' }
    );
  }
  if (src) img.dataset.src = src;
  io.observe(img);
  return img;
}

/** debounce */
export function debounce(fn, ms = 300) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** 复制文本到剪贴板（clipboard API → execCommand 降级） */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-999px;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** 关闭分享面板（全局单例） */
export function closeShareSheet() {
  const old = document.getElementById('cy-share-sheet');
  if (old) old.remove();
  document.body.classList.remove('cy-sheet-locked');
}

/**
 * 分享面板（底部弹层，移动端惯例）：
 *  ① 复制链接 —— 任何环境可用
 *  ② 系统分享 —— 支持 Web Share API 的手机浏览器（可直接发微信/QQ）
 *  ③ 发给好友 —— 站内私信（好友列表选择，POST /api/social/messages）
 * 消息文本格式约定：'🎬 视频分享｜标题\n链接'，私信端识别后渲染成卡片。
 */
export function shareLink(opts = {}) {
  const url = location.origin + location.pathname + (location.hash || '#/');
  const title = (opts.title || document.title || '慈云影视').slice(0, 60);
  closeShareSheet();

  const root = h('div', { id: 'cy-share-sheet' });
  const mask = h('div', { class: 'cy-sheet-mask', onclick: () => closeShareSheet() });
  const sheet = h('div', { class: 'cy-sheet' }, [
    h('div', { class: 'cy-sheet-bar' }),
    h('div', { class: 'cy-sheet-title', text: '分享「' + (title.length > 18 ? title.slice(0, 18) + '…' : title) + '」' }),
    h('div', { class: 'cy-sheet-body' }),
  ]);
  root.append(mask, sheet);
  document.body.appendChild(root);
  document.body.classList.add('cy-sheet-locked');
  const body = sheet.querySelector('.cy-sheet-body');
  const close = () => closeShareSheet();

  /* —— ① 复制链接 —— */
  body.appendChild(h('button', {
    class: 'cy-sheet-item',
    onclick: async () => {
      const ok = await copyText(url);
      toast(ok ? '链接已复制，去粘贴给朋友吧' : '复制失败，请手动复制地址栏链接', ok ? 'success' : 'error');
      if (ok) close();
    },
  }, [
    h('span', { class: 'ic', text: '🔗' }),
    h('span', { class: 'lb', text: '复制链接' }),
    h('span', { class: 'ds', text: '粘贴到微信 / QQ 等发给朋友' }),
  ]));

  /* —— ② 系统分享（手机）—— */
  if (navigator.share) {
    body.appendChild(h('button', {
      class: 'cy-sheet-item',
      onclick: () => {
        navigator.share({ title, text: (opts.text || ('我在「慈云影视」发现《' + title + '》，一起来看！')), url })
          .then(() => close())
          .catch((e) => { if (e && e.name !== 'AbortError') toast('分享失败，试试复制链接'); });
      },
    }, [
      h('span', { class: 'ic', text: '📤' }),
      h('span', { class: 'lb', text: '系统分享' }),
      h('span', { class: 'ds', text: '调用手机分享面板（微信 / QQ / 微博）' }),
    ]));
  }

  /* —— ③ 发给好友（站内私信）—— */
  body.appendChild(h('button', {
    class: 'cy-sheet-item',
    onclick: () => showFriends(),
  }, [
    h('span', { class: 'ic', text: '💬' }),
    h('span', { class: 'lb', text: '发给好友' }),
    h('span', { class: 'ds', text: '通过站内私信分享给好友' }),
  ]));

  /* 好友选择视图（面板内切换） */
  async function showFriends() {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'cy-sheet-hint', text: '加载好友列表…' }));
    let authMod;
    try {
      authMod = await import('./auth.js');
    } catch { /* ignore */ }
    if (!authMod || !authMod.auth || !authMod.auth.loggedIn) {
      body.innerHTML = '';
      body.appendChild(h('div', { class: 'cy-sheet-hint' }, [
        h('div', { text: '登录后才能发给好友' }),
        h('button', { class: 'btn btn-primary btn-sm', text: '去登录', onclick: () => { close(); goReplace('/login?redirect=' + encodeURIComponent(location.hash)); } }),
      ]));
      return;
    }
    let list = [];
    try {
      const d = await api('/api/social/friends');
      list = d.list || [];
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(h('div', { class: 'cy-sheet-hint', text: '加载失败：' + e.message }));
      return;
    }
    body.innerHTML = '';
    if (!list.length) {
      body.appendChild(h('div', { class: 'cy-sheet-hint' }, [
        h('div', { text: '还没有好友，先去添加一个吧' }),
        h('button', { class: 'btn btn-primary btn-sm', text: '去加好友', onclick: () => { close(); go('/social?tab=search'); } }),
      ]));
      return;
    }
    list.forEach((f) => {
      body.appendChild(h('button', {
        class: 'cy-sheet-friend',
        onclick: async () => {
          const msg = '🎬 视频分享｜' + title + '\n' + url;
          try {
            await api('/api/social/messages', { method: 'POST', body: { to: f.account, text: msg } });
            close();
            toast('已分享给 ' + (f.nickname || f.account), 'success');
          } catch (e) {
            toast(e.message || '发送失败', 'error');
          }
        },
      }, [
        h('span', { class: 'av', text: (f.nickname || f.account || '?').slice(0, 1).toUpperCase() }),
        h('span', { class: 'lb', text: f.nickname || f.account }),
        f.online ? h('span', { class: 'dot' }) : null,
      ]));
    });
  }
}

/** toast 提示 */
export function toast(msg, type = 'info') {  let box = document.getElementById('cy-toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'cy-toast';
    box.style.cssText = `position:fixed;left:50%;bottom:44px;transform:translateX(-50%);
      z-index:9999;display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none`;
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  const color = type === 'error' ? '#e50914' : type === 'success' ? '#22c55e' : 'rgba(30,30,38,.96)';
  t.style.cssText = `padding:11px 22px;border-radius:10px;font-size:14px;color:#fff;
    background:${color};box-shadow:0 8px 28px rgba(0,0,0,.4);backdrop-filter:blur(10px);
    opacity:0;transform:translateY(10px);transition:all .3s cubic-bezier(.16,1,.3,1)`;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(10px)';
    setTimeout(() => t.remove(), 320);
  }, 2200);
}

/** 应用设置到 CSS 变量 / 主题 */
export function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  if (theme.primary) {
    root.style.setProperty('--primary', theme.primary);
    root.style.setProperty('--primary-dark', shade(theme.primary, -18));
  }
  if (theme.accent) root.style.setProperty('--accent', theme.accent);
  root.setAttribute('data-theme', theme.mode === 'light' ? 'light' : 'dark');
}

function shade(hex, pct) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const f = (i) => {
    let v = parseInt(m[i], 16) + Math.round(2.55 * pct);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  };
  return '#' + f(1) + f(2) + f(3);
}

/** 根据标题生成稳定的渐变占位色 */
export function titleColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue} 42% 24%), hsl(${(hue + 40) % 360} 38% 14%))`;
}
