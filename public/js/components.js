/* ============================================================
   慈云影视 · 共享 UI 组件
   ============================================================ */

import { h, esc, lazyImg, titleColor, durToSec } from './util.js';

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
