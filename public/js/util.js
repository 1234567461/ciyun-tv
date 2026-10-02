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

/** 观看历史 */
export const history = {
  list() { return ls.get('history', []); },
  add(item) {
    const arr = this.list().filter((x) => x.guid !== item.guid);
    arr.unshift({ ...item, ts: Date.now() });
    ls.set('history', arr.slice(0, 120));
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

/** toast 提示 */
export function toast(msg, type = 'info') {
  let box = document.getElementById('cy-toast');
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
