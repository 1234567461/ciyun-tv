/* ============================================================
   慈云影视 · 共享 UI 组件
   ============================================================ */

import { h, esc, lazyImg, titleColor, durToSec } from './util.js';

/**
 * 海报式占位（源列表无封面时）：
 * 片名首字大字 + 按标题生成的渐变底 + 类型角标，代替单调色块。
 * 不少采集源「列表接口不给图、详情接口才给」，此类条目统一用此占位。
 */
export function posterFallback(name, typeName) {
  const t = String(name || '剧').trim();
  const chars = t.slice(0, Math.min(4, Math.max(2, Math.ceil(t.length / 2))));
  return h('div', { class: 'poster-fallback' }, [
    h('div', { class: 'pf-name', text: chars }),
    typeName ? h('div', { class: 'pf-type', text: String(typeName).slice(0, 4) }) : null,
  ]);
}

/** 视频卡片 */
export function videoCard(v, onClick) {
  const thumb = h('div', { class: 'card-thumb' });
  if (v.image) {
    const img = h('img', { alt: v.title, loading: 'lazy' });
    lazyImg(img, v.image);
    thumb.appendChild(img);
  } else {
    thumb.style.background = titleColor(v.title || 'x');
    thumb.appendChild(h('div', { class: 'card-fallback', text: '🎬', style: { display: 'none' } }));
  }

  const dur = v.length || (v.duration ? '' : '');
  return h(
    'div',
    {
      class: 'card',
      onclick: () => onClick && onClick(v),
      title: v.title,
    },
    [
      thumb,
      h('div', { class: 'card-play', html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>' }),
      dur ? h('div', { class: 'card-dur', text: dur }) : null,
      h('div', { class: 'card-title', text: v.title }),
    ]
  );
}

/** 栏目卡 */
export function columnCard(col, onClick) {
  return h(
    'div',
    { class: 'col-card', onclick: () => onClick && onClick(col) },
    [
      h('div', { class: 'c-icon', text: (col.icon || '🎞️') }),
      h('div', {}, [
        h('div', { class: 'c-name', text: col.name }),
        h('div', { class: 'c-meta', text: (col.total ? col.total.toLocaleString() + ' 期' : '') + (col.categoryName ? ' · ' + col.categoryName : '') }),
      ]),
    ]
  );
}

/** 横向轨道（带左右滚动） */
export function rail(title, items, { icon = '', moreHref = '', moreText = '查看全部', renderItem } = {}) {
  const scroller = h('div', { class: 'rail' });
  items.forEach((it) => scroller.appendChild(renderItem(it)));

  const sec = h('div', { class: 'section' }, [
    h('div', { class: 'section-head' }, [
      h('div', { class: 'section-title' }, [
        icon ? h('span', { class: 'icon', text: icon }) : null,
        h('span', { text: title }),
      ]),
      moreHref
        ? h('a', { class: 'section-more', href: '#' + moreHref, text: moreText + ' →' })
        : null,
    ]),
    scroller,
  ]);

  // 鼠标滚轮横向滚动
  scroller.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      scroller.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  return sec;
}

/** 骨架屏轨道 */
export function sklRail(title, icon = '') {
  const sc = h('div', { class: 'rail' });
  for (let i = 0; i < 6; i++) sc.appendChild(h('div', { class: 'skl skl-card' }));
  return h('div', { class: 'section' }, [
    h('div', { class: 'section-head' }, [
      h('div', { class: 'section-title' }, [icon ? h('span', { class: 'icon', text: icon }) : null, h('span', { text: title })]),
    ]),
    sc,
  ]);
}

/** 页脚 */
export function footer(settings = {}) {
  return h('div', { class: 'footer' }, [
    h('div', { html: `<strong style="color:var(--text)">${esc(settings.siteName || '慈云影视')}</strong> · ${esc(settings.slogan || '')}` }),
    h('div', { style: { marginTop: '8px' } }, [
      h('a', { href: '#/discover', text: '发现' }),
      ' · ',
      h('a', { href: '#/live', text: '电视直播' }),
      ' · ',
      h('a', { href: '#/search', text: '搜索' }),
      ' · ',
      h('a', { href: '#/admin/', text: '管理后台' }),
    ]),
    h('div', {
      class: 'disclaimer',
      text:
        '本站为开源影视聚合项目（MIT 协议），所有内容均来自央视网等官方公开接口，仅供技术学习与交流，' +
        '不存储、不制作、不传播任何视频内容，请勿用于商业用途。如有侵权请联系删除。',
    }),
    h('div', { style: { marginTop: '10px', fontSize: '12px' }, text: '© ' + new Date().getFullYear() + ' 慈云影视 · Powered by Node.js + HLS.js' }),
  ]);
}

/** 空状态 */
export function emptyState(icon, title, sub) {
  return h('div', { class: 'empty' }, [
    h('div', { class: 'ico', text: icon || '📭' }),
    h('div', { class: 't', text: title || '暂无内容' }),
    sub ? h('div', { text: sub }) : null,
  ]);
}

/** 加载更多按钮 */
export function loadMoreBtn(onClick) {
  return h('div', { style: { textAlign: 'center', marginTop: '32px' } }, [
    h('button', { class: 'btn btn-ghost', text: '加载更多', onclick: (e) => onClick(e) }),
  ]);
}

/* ============================================================
   公告弹窗
   ------------------------------------------------------------
   · 站点设置里的 announcement 字段支持多行，每行作为一条公告
   · 用内容哈希做版本号：公告改了会重新弹出，没改则不打扰
   · 支持「本次关闭」与「不再提示」（localStorage 记录）
   ============================================================ */

const ANN_KEY = 'cy_announce_seen';   // 已读公告的内容指纹
const ANN_OFF = 'cy_announce_muted';  // 用户点了「不再提示」

/** 简易稳定哈希（公告内容 → 指纹），用于判断公告是否变更 */
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * 展示公告弹窗（若有新公告且用户未选择「不再提示」）
 * @param {string} text 公告正文（支持 \n 分行）
 */
export function showAnnouncement(text) {
  const raw = String(text || '').trim();
  if (!raw) return;

  const items = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return;

  const fingerprint = hashStr(raw);
  let muted = false, seen = '';
  try {
    muted = localStorage.getItem(ANN_OFF) === '1';
    seen = localStorage.getItem(ANN_KEY) || '';
  } catch { /* 隐私模式忽略 */ }
  if (muted || seen === fingerprint) return; // 已读或已静音 → 不打扰

  // 滚动定时器的清理句柄（先声明，供 close 引用）
  let stopTimer = null;

  const close = () => {
    try { localStorage.setItem(ANN_KEY, fingerprint); } catch {}
    if (stopTimer) stopTimer();          // 关掉循环滚动，避免后台空转
    mask.classList.add('ann-out');
    setTimeout(() => mask.remove(), 220);
    document.removeEventListener('keydown', onKey);
  };
  const mute = () => {
    try { localStorage.setItem(ANN_OFF, '1'); localStorage.setItem(ANN_KEY, fingerprint); } catch {}
    close();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const body = h('div', { class: 'ann-body' });
  const track = h('div', { class: 'ann-track' });
  // 多条公告：自动循环滚动轮播；单条则静态展示
  const carousel = items.length > 1;
  if (carousel) body.classList.add('ann-scroll');

  items.forEach((line, i) => {
    track.appendChild(
      h('div', { class: 'ann-item' + (i === 0 ? ' on' : '') }, [
        h('span', { class: 'ann-dot', text: String(i + 1) }),
        h('span', { class: 'ann-text', text: line }),
      ])
    );
  });
  body.appendChild(track);

  // 进度点（多条目时显示）
  let dots = null;
  if (carousel) {
    dots = h('div', { class: 'ann-dots' },
      items.map((_, i) => h('i', { class: i === 0 ? 'on' : '' }))
    );
  }

  /** 滚动控制：定时切换条目，鼠标悬停/聚焦时暂停 */
  let idx = 0;
  let timer = null;
  const slides = () => [...track.children];
  const goto = (n) => {
    const list = slides();
    idx = (n + list.length) % list.length;
    list.forEach((el, i) => el.classList.toggle('on', i === idx));
    if (dots) [...dots.children].forEach((d, i) => d.classList.toggle('on', i === idx));
  };
  const start = () => {
    if (!carousel || timer) return;
    timer = setInterval(() => goto(idx + 1), 2600);
  };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  if (carousel) {
    start();
    body.addEventListener('mouseenter', stop);   // 悬停暂停，方便阅读
    body.addEventListener('mouseleave', start);
    // 手动点击进度点跳转
    if (dots) {
      [...dots.children].forEach((d, i) => {
        d.addEventListener('click', () => { stop(); goto(i); start(); });
      });
    }
  }

  const dialog = h('div', { class: 'ann-dialog', role: 'dialog', 'aria-modal': 'true' }, [
    h('div', { class: 'ann-head' }, [
      h('div', { class: 'ann-title' }, [
        h('span', { class: 'ann-ico', text: '📢' }),
        h('span', { text: '网站公告' }),
      ]),
      h('button', { class: 'ann-x', html: '&times;', title: '关闭', 'aria-label': '关闭', onclick: close }),
    ]),
    body,
    dots,
    h('div', { class: 'ann-foot' }, [
      h('button', { class: 'btn btn-ghost btn-sm', text: '不再提示', onclick: mute }),
      h('button', { class: 'btn btn-primary btn-sm', text: '我知道了', onclick: close }),
    ]),
  ]);

  const mask = h('div', { class: 'ann-mask' }, [dialog]);
  // 点遮罩空白处关闭
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  // 关闭时务必清掉定时器，避免后台空转
  const realClose = close;
  const closeWrapped = () => { stop(); realClose(); };

  document.body.appendChild(mask);
  document.addEventListener('keydown', onKey);
  // 把关闭按钮绑定替换为带清理的版本：
  // （close 在闭包内被多处引用，这里通过覆盖事件的简单方式保证清理）
  dialog.querySelector('.ann-x').onclick = closeWrapped;
  [...dialog.querySelectorAll('.ann-foot .btn')].forEach((b, i) => {
    if (i === 1) b.onclick = closeWrapped; // 「我知道了」
  });
  mask.addEventListener('click', (e) => { if (e.target === mask) closeWrapped(); });

  requestAnimationFrame(() => mask.classList.add('ann-in'));
}

/* ============================================================
   顶部滚动公告栏
   ------------------------------------------------------------
   · 常驻在页头下方，逐条横向滚动播报（跑马灯）
   · 单条时静态展示，不滚动
   · 用户可点「×」收起（按内容指纹记忆，公告变更后重新出现）
   ============================================================ */

const BAR_OFF = 'cy_annbar_closed';   // 被用户收起的公告指纹

let _annBar = null;      // 当前挂载的公告栏元素
let _annBarTimer = null; // 滚动定时器

/**
 * 渲染/更新顶部滚动公告栏
 * @param {string} text 公告正文（\n 分行）
 */
export function renderAnnounceBar(text) {
  const raw = String(text || '').trim();

  // 公告为空 → 移除已有公告栏
  if (!raw) return clearAnnounceBar();

  const items = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return clearAnnounceBar();

  const fingerprint = hashStr(raw);
  let closed = '';
  try { closed = localStorage.getItem(BAR_OFF) || ''; } catch {}
  if (closed === fingerprint) return clearAnnounceBar(); // 用户已收起这条公告

  // 内容未变则复用，避免每次轮询都重建 DOM（重建会打断滚动位置）
  if (_annBar && _annBar.dataset.fp === fingerprint) return;

  clearAnnounceBar();

  const track = h('div', { class: 'annbar-track' });
  items.forEach((line, i) => {
    track.appendChild(
      h('span', { class: 'annbar-item' }, [
        h('i', { class: 'annbar-dot' }),
        h('span', { text: line }),
        i < items.length - 1 ? h('span', { class: 'annbar-sep', text: '　·　' }) : null,
      ])
    );
  });

  const closeBtn = h('button', {
    class: 'annbar-x', html: '&times;', title: '收起公告', 'aria-label': '收起公告',
    onclick: () => {
      try { localStorage.setItem(BAR_OFF, fingerprint); } catch {}
      clearAnnounceBar();
    },
  });

  const bar = h('div', { class: 'annbar', role: 'marquee' }, [
    h('span', { class: 'annbar-ico', text: '📢' }),
    h('div', { class: 'annbar-view' }, [track]),
    closeBtn,
  ]);
  bar.dataset.fp = fingerprint;

  // 挂到页头之后（找不到页头则挂到 body 顶部）
  const anchor = document.querySelector('.site-header') || document.body.firstChild;
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
  else document.body.insertBefore(bar, document.body.firstChild);

  _annBar = bar;

  // 内容超出可视宽度才滚动（短内容静态展示，避免无意义的跑马灯）
  requestAnimationFrame(() => {
    const view = bar.querySelector('.annbar-view');
    if (!view || !view.clientWidth) return;
    const overflow = track.scrollWidth - view.clientWidth;
    if (overflow > 8) {
      track.style.setProperty('--ann-shift', '-' + (overflow + 24) + 'px');
      track.style.animationDuration = Math.max(9, Math.round((overflow + 300) / 46)) + 's';
      track.classList.add('running');
    }
  });
}

/** 移除公告栏并清理定时器 */
export function clearAnnounceBar() {
  if (_annBarTimer) { clearInterval(_annBarTimer); _annBarTimer = null; }
  if (_annBar) {
    const t = _annBar.querySelector('.annbar-track');
    if (t) t.classList.remove('running');
    _annBar.remove();
    _annBar = null;
  }
}

/**
 * 从站点/监控接口拉取公告并同步到「弹窗 + 顶部滚动栏」两处
 * @param {string} fallbackText 站点设置里的公告（作为兜底）
 */
export async function syncAnnouncement(fallbackText) {
  let text = String(fallbackText || '').trim();
  try {
    const r = await fetch('/api/announcement', { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      const remote = (d && d.announcement) || '';
      if (remote.trim()) text = remote.trim();
    }
  } catch { /* 拉取失败用兜底 */ }

  showAnnouncement(text);   // 首次/有更新时弹窗
  renderAnnounceBar(text);  // 顶部滚动栏（可收起）
  return text;
}
