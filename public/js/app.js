/* ============================================================
   慈云影视 · 主应用（路由 + 页面）
   ============================================================ */

import { h, api, go, parseRoute, esc, fmtNum, fav, history, toast, applyTheme, ls, durToSec, relTime, titleColor } from './util.js';
import { videoCard, columnCard, rail, sklRail, footer, emptyState, loadMoreBtn, showAnnouncement } from './components.js';
import { Player, detectType } from './player.js';
import { auth, avatarEl } from './auth.js';
import { mountComments } from './comments.js';
import { mountChat } from './chat.js';
import { createDanmaku, createDanmakuBar } from './danmaku.js';
import { renderFamilyPage } from './family.js';
import { renderVipPage } from './vip.js';
import { renderSocialPage } from './social.js';

const state = {
  site: null,
  categories: [],
  columns: [],
  liveChannels: [],
};

const app = () => document.getElementById('app');

/* ============================================================
   初始化
   ============================================================ */
async function boot() {
  try {
    const [site, cats] = await Promise.all([api('/api/site'), api('/api/categories')]);
    state.site = site;
    state.categories = cats.categories;
    applyTheme(site.theme);
    document.title = site.siteName + ' · ' + site.slogan;
  } catch (e) {
    console.error(e);
  }
  await auth.refresh();
  renderHeader();
  renderFooter();
  window.addEventListener('hashchange', route);
  route();
  // 公告弹窗：优先用监控服务下发的最新公告，回退站点设置里的 announcement
  showAnnouncement(state.site && state.site.announcement);
  syncRemoteAnnouncement();
}

/**
 * 拉取公告并展示。
 * 走主站自身的 /api/announcement 代理（由服务端转发到监控服务），
 * 避免前端跨域问题；监控未部署时服务端回退本地公告。
 * 公告不是核心功能，任何异常都静默跳过。
 */
async function syncRemoteAnnouncement() {
  try {
    const d = await api('/api/announcement');
    const text = (d && d.announcement) || '';
    if (text && text.trim() !== String((state.site && state.site.announcement) || '').trim()) {
      showAnnouncement(text);
    }
  } catch {
    /* 忽略：公告取不到不影响使用 */
  }
}

/* ============================================================
   顶栏
   ============================================================ */
function renderHeader() {
  const header = document.getElementById('header');
  header.innerHTML = '';
  const s = state.site || {};

  const navMap = [
    { href: '#/', text: '首页', match: ['/'] },
    { href: '#/discover', text: '发现', match: ['/discover'] },
    { href: '#/resource?type=anime', text: '动漫', match: ['/resource'] },
    { href: '#/resource?type=us', text: '美剧', match: ['/resource'] },
    { href: '#/resource?type=movie', text: '电影', match: ['/resource'] },
    { href: '#/live', text: '电视直播', match: ['/live'] },
    { href: '#/family', text: '家庭共享', match: ['/family'] },
    { href: '#/category/news', text: '新闻', match: ['/category/news'] },
    { href: '#/category/documentary', text: '纪录片', match: ['/category/documentary'] },
    { href: '#/category/anime', text: '央视动画', match: ['/category/anime'] },
    { href: '#/fav', text: '我的收藏', match: ['/fav'] },
  ];

  const nav = h('nav', { class: 'nav' });
  navMap.forEach((n) =>
    nav.appendChild(
      h('a', {
        href: n.href,
        text: n.text,
        'data-match': n.match[0],
        onclick: () => setTimeout(markActive, 0),
      })
    )
  );

  const searchInput = h('input', {
    placeholder: '搜索影视、节目…',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        const v = e.target.value.trim();
        if (v) go('/search?q=' + encodeURIComponent(v));
      }
    },
  });

  header.append(
    h('a', { class: 'logo', href: '#/' }, [
      h('div', { class: 'logo-mark', text: '慈' }),
      h('div', { class: 'logo-text', text: s.siteName || '慈云影视' }),
    ]),
    nav,
    h('div', { class: 'header-actions' }, [
      h('div', { class: 'search-box' }, [
        h('span', { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>' }),
        searchInput,
      ]),
      h('button', { class: 'icon-btn', title: '切换主题', html: themeIcon(), onclick: toggleTheme }),
      buildUserArea(),
    ])
  );

  // 滚动效果
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    header.classList.toggle('scrolled', y > 40);
    if (y > lastY && y > 300) header.classList.add('hide');
    else header.classList.remove('hide');
    lastY = y;
  });
  markActive();
}

let lastY = 0;

function themeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  return dark
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', cur);
  ls.set('theme', cur);
  const btn = document.querySelector('.header-actions .icon-btn');
  if (btn) btn.innerHTML = themeIcon();
}

/* ------------------------- 顶栏用户区 ------------------------- */
function buildUserArea() {
  const area = h('div', { class: 'user-area' });
  const monetize = (state.site && state.site.monetize) || {};

  // 会员入口（付费模块开启时显示）
  const vipEntry = monetize.enabled
    ? h('a', { class: 'btn btn-vip btn-sm', href: '#/vip', html: '💎<span>会员</span>' })
    : null;

  if (!auth.loggedIn) {
    area.append(
      vipEntry || '',
      h('a', { class: 'btn btn-ghost btn-sm', href: '#/login', text: '登录' }),
      h('a', { class: 'btn btn-primary btn-sm', href: '#/register', text: '注册' })
    );
    if (!vipEntry) area.removeChild(area.firstChild);
    return area;
  }

  const u = auth.user;
  const vipActive = u.vipActive || (u.vip && u.vip.expire > Date.now());

  const dd = h('div', { class: 'dropdown' }, [
    h('div', { class: 'dd-user' }, [
      h('div', { class: 'n' }, [
        h('span', { text: u.nickname || u.account }),
        vipActive ? h('span', { class: 'dd-vip', text: '💎 会员' }) : null,
      ]),
      h('div', { class: 'a', text: '@' + u.account }),
      monetize.enabled
        ? h('div', { class: 'dd-bal' }, [
            h('span', { text: '余额 ' + (u.currency || '¥') + (u.balance || 0).toFixed(2) }),
            h('a', { href: '#/vip?tab=recharge', text: '充值', onclick: () => close() }),
          ])
        : null,
    ]),
    h('a', { href: '#/profile', html: '👤<span>个人中心</span>', onclick: () => close() }),
    monetize.enabled ? h('a', { href: '#/vip', html: '💎<span>会员中心</span>', onclick: () => close() }) : null,
    monetize.enabled ? h('a', { href: '#/vip?tab=orders', html: '🧾<span>我的订单</span>', onclick: () => close() }) : null,
    h('a', { href: '#/profile?tab=comments', html: '💬<span>我的评论</span>', onclick: () => close() }),
    h('a', { href: '#/fav', html: '⭐<span>我的收藏</span>', onclick: () => close() }),
    h('a', { href: '#/history', html: '🕘<span>观看历史</span>', onclick: () => close() }),
    h('button', { class: 'danger', html: '🚪<span>退出登录</span>', onclick: async () => { await auth.logout(); toast('已退出登录'); renderHeader(); route(); } }),
  ].filter(Boolean));

  const wrap = h('div', { class: 'avatar-menu' }, [avatarEl(u), dd]);
  const av = wrap.querySelector('.avatar');
  const close = () => { dd.classList.remove('open'); document.removeEventListener('click', onDoc); };
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  av.onclick = (e) => {
    e.stopPropagation();
    const willOpen = !dd.classList.contains('open');
    dd.classList.toggle('open');
    if (willOpen) setTimeout(() => document.addEventListener('click', onDoc), 0);
  };
  if (vipEntry) area.appendChild(vipEntry);
  area.appendChild(wrap);
  return area;
}

function markActive() {
  const { path } = parseRoute();
  document.querySelectorAll('.nav a').forEach((a) => {
    const m = a.getAttribute('data-match');
    const on = m === '/' ? path === '/' : path.startsWith(m);
    a.classList.toggle('active', on);
  });
}

function renderFooter() {
  const f = footer(state.site || {});
  const host = document.getElementById('footer');
  host.innerHTML = '';
  host.appendChild(f);
}

/* ============================================================
   路由
   ============================================================ */
async function route() {
  const { path, seg, params } = parseRoute();
  const root = app();
  window.scrollTo(0, 0);
  markActive();
  // 清理上一页的聊天室 SSE 连接
  if (window.__chat && window.__chat.destroy) { try { window.__chat.destroy(); } catch {} window.__chat = null; }
  if (window.__dm && window.__dm.destroy) { try { window.__dm.destroy(); } catch {} window.__dm = null; }
  root.innerHTML = '';

  try {
    if (path === '/' || path === '') return pageHome(root);
    if (seg[0] === 'discover') return pageDiscover(root);
    if (seg[0] === 'category') return pageCategory(root, seg[1] || 'all');
    if (seg[0] === 'column') return pageColumn(root, seg[1], parseInt(params.get('p')) || 1);
    if (seg[0] === 'watch') return pageWatch(root, seg[1]);
    if (seg[0] === 'live') return seg[1] ? pageLiveRoom(root, seg[1]) : pageLive(root);
    if (seg[0] === 'resource') return pageResource(root, params.get('type') || '', parseInt(params.get('p')) || 1);
    if (seg[0] === 'vod') return pageVod(root, seg[1], seg[2]);
    if (seg[0] === 'search') return pageSearch(root, params.get('q') || '');
    if (seg[0] === 'fav') return pageFav(root);
    if (seg[0] === 'history') return pageHistory(root);
    if (seg[0] === 'login') return pageAuth(root, 'login');
    if (seg[0] === 'register') return pageAuth(root, 'register');
    if (seg[0] === 'forgot') return pageForgot(root);
    if (seg[0] === 'profile') return pageProfile(root, params.get('tab') || 'info');
    if (seg[0] === 'family') return renderFamilyPage(root, state.site);
    if (seg[0] === 'vip') return renderVipPage(root, state.site, { tab: params.get('tab') || 'plans' });
    if (seg[0] === 'social') return renderSocialPage(root, params.get('tab') || 'messages');
    if (seg[0] === 'join') return pageJoin(root, params.get('code') || '');
    if (seg[0] === 'u') return pageUserProfile(root, seg[1]);
    return page404(root);
  } catch (e) {
    console.error(e);
    root.appendChild(h('div', { class: 'error-box', text: '出错了：' + e.message }));
  }
}

/* ============================================================
   首页
   ============================================================ */
async function pageHome(root) {
  root.appendChild(h('div', { class: 'hero-skel skl' }));

  let data;
  try {
    data = await api('/api/home');
  } catch (e) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
    return;
  }

  root.innerHTML = '';
  root.appendChild(buildHero(data));

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  const box = main.querySelector('.container');

  // 分类快捷入口
  box.appendChild(
    rail(
      '分类导航',
      data.categories,
      { icon: '🧭', moreHref: '/discover', moreText: '全部分类', renderItem: (c) =>
          columnCard({ icon: c.icon, name: c.name, total: c.count, categoryName: '个栏目' }, () => go('/category/' + c.id)),
      }
    )
  );

  // 最新更新（各分类块）
  for (const b of data.blocks || []) {
    const cat = data.categories.find((c) => c.id === b.categoryId);
    box.appendChild(
      rail(b.column.name, b.list, {
        icon: cat ? cat.icon : '🎞️',
        moreHref: '/column/' + b.column.id,
        moreText: '查看栏目',
        renderItem: (v) => videoCard(v, (v) => go('/watch/' + v.guid)),
      })
    );
  }

  root.appendChild(main);
}

function buildHero(data) {
  const feats = (data.featured || []).slice(0, 5);
  const hero = h('div', { class: 'hero' });
  const dots = h('div', { class: 'hero-dots' });

  if (!feats.length) {
    hero.appendChild(h('div', { class: 'hero-content' }, [
      h('div', { class: 'hero-badge', text: '🎬 欢迎' }),
      h('h1', { class: 'hero-title', text: state.site.siteName }),
      h('p', { class: 'hero-desc', text: state.site.announcement }),
      h('div', { class: 'hero-actions' }, [
        h('a', { class: 'btn btn-primary', href: '#/discover', text: '开始观看' }),
      ]),
    ]));
    return hero;
  }

  // 异步拉取每个推荐栏目的首个视频作为主视觉
  feats.forEach((col, i) => {
    const slide = h('div', { class: 'hero-slide' + (i === 0 ? ' active' : '') });
    slide.appendChild(h('div', { class: 'hero-bg' }));
    slide.appendChild(
      h('div', { class: 'hero-content' }, [
        h('div', { class: 'hero-badge', text: '🔥 精选推荐' }),
        h('h1', { class: 'hero-title', text: col.name }),
        h('div', { class: 'hero-meta' }, [
          h('span', { text: (col.total || 0).toLocaleString() + ' 期节目' }),
          h('span', { class: 'sep' }),
          h('span', { class: 'cat', text: catName(col.category) }),
        ]),
        h('p', { class: 'hero-desc', text: '来自央视网官方公开资源 · 点击进入栏目观看全部内容' }),
        h('div', { class: 'hero-actions' }, [
          h('a', { class: 'btn btn-primary', href: '#/column/' + col.id, html: playIcon() + '<span>进入栏目</span>' }),
          h('a', { class: 'btn btn-ghost', href: '#/category/' + col.category, text: '更多同类' }),
        ]),
      ])
    );
    hero.appendChild(slide);
    dots.appendChild(h('button', { class: i === 0 ? 'active' : '', onclick: () => showSlide(i) }));
  });
  hero.appendChild(dots);

  let cur = 0;
  let timer;
  function showSlide(i) {
    cur = i;
    hero.querySelectorAll('.hero-slide').forEach((s, k) => s.classList.toggle('active', k === i));
    dots.querySelectorAll('button').forEach((d, k) => d.classList.toggle('active', k === i));
    resetTimer();
  }
  function resetTimer() {
    clearInterval(timer);
    timer = setInterval(() => showSlide((cur + 1) % feats.length), 7000);
  }
  resetTimer();

  // 拉取封面
  feats.forEach(async (col, i) => {
    try {
      const d = await api(`/api/columns/${col.id}/videos?page=1&size=1`);
      const v = d.list && d.list[0];
      if (v && v.image) {
        const bg = hero.querySelectorAll('.hero-bg')[i];
        if (bg) {
          const img = new Image();
          img.onload = () => { bg.style.backgroundImage = `url("${v.image}")`; };
          img.src = v.image;
        }
        // 用真实节目标题
        const t = hero.querySelectorAll('.hero-title')[i];
        if (t && v.title) t.textContent = v.title;
        const desc = hero.querySelectorAll('.hero-desc')[i];
        if (desc && v.brief) desc.textContent = v.brief;
        // 播放按钮直达该视频
        const btn = hero.querySelectorAll('.hero-actions .btn-primary')[i];
        if (btn && v.guid) {
          btn.setAttribute('href', '#/watch/' + v.guid);
          btn.innerHTML = playIcon() + '<span>立即播放</span>';
        }
      }
    } catch {}
  });

  return hero;
}

function playIcon() {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="margin-right:2px"><path d="M8 5v14l11-7z"/></svg>';
}

function catName(id) {
  const c = state.categories.find((x) => x.id === id);
  return c ? c.name : '综合';
}

/* ============================================================
   发现页（全部栏目）
   ============================================================ */
async function pageDiscover(root) {
  // 每个分类一个栏目轨道，数据量大，分批加载
  const head = h('div', { class: 'page-head' }, [
    h('h1', { class: 'page-title', html: '<span>🧭</span> 发现全部内容' }),
    h('p', { class: 'page-sub', text: '共 ' + (state.categories.reduce((a, c) => a + c.count, 0)) + ' 个栏目，持续更新' }),
  ]);
  root.appendChild(head);

  const chips = h('div', { class: 'chips' });
  [ { id: 'all', name: '全部', icon: '🌐' }, ...state.categories ].forEach((c) => {
    chips.appendChild(
      h('a', {
        class: 'chip' + (c.id === 'all' ? ' active' : ''),
        href: c.id === 'all' ? '#/discover' : '#/category/' + c.id,
        text: c.icon ? c.icon + ' ' + c.name : c.name,
      })
    );
  });
  root.appendChild(h('div', { class: 'container' }, [chips]));

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  const box = main.querySelector('.container');

  for (const cat of state.categories) {
    const lr = sklRail(cat.name, cat.icon);
    box.appendChild(lr);
    api('/api/columns?category=' + cat.id + '&size=60').then((d) => {
      const cols = d.list;
      const newRail = rail(cat.name, cols, {
        icon: cat.icon,
        moreHref: '/category/' + cat.id,
        moreText: '查看全部 ' + d.total + ' 个',
        renderItem: (c) => columnCard({ ...c, categoryName: '' }, () => go('/column/' + c.id)),
      });
      lr.replaceWith(newRail);
    }).catch(() => { lr.replaceWith(emptyState('📭', cat.name + ' 加载失败')); });
  }
  root.appendChild(main);
}

/* ============================================================
   分类页
   ============================================================ */
async function pageCategory(root, catId) {
  const cat = state.categories.find((c) => c.id === catId) || { id: 'all', name: '全部栏目', icon: '🎞️', desc: '所有内容' };
  const head = h('div', { class: 'page-head' }, [
    h('h1', { class: 'page-title' }, [h('span', { text: cat.icon }), h('span', { text: cat.name })]),
    h('p', { class: 'page-sub', text: cat.desc || '' }),
  ]);
  root.appendChild(head);

  const chips = h('div', { class: 'chips' });
  [{ id: 'all', name: '全部', icon: '🌐' }, ...state.categories].forEach((c) => {
    chips.appendChild(
      h('a', { class: 'chip' + (c.id === catId ? ' active' : ''), href: c.id === 'all' ? '#/discover' : '#/category/' + c.id, text: (c.icon || '') + ' ' + c.name })
    );
  });
  root.appendChild(h('div', { class: 'container' }, [chips]));

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  const box = main.querySelector('.container');
  box.appendChild(sklRail('加载中…', cat.icon));

  try {
    const d = await api('/api/columns?category=' + catId + '&size=200');
    box.innerHTML = '';
    if (!d.list.length) {
      box.appendChild(emptyState('📭', '该分类暂无栏目'));
    } else {
      const grid = h('div', { class: 'grid' });
      d.list.forEach((c) =>
        grid.appendChild(
          h('div', { style: { aspectRatio: '16/9' } }, [
            columnCard({ ...c, categoryName: '' }, () => go('/column/' + c.id)),
          ])
        )
      );
      box.appendChild(grid);
    }
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
  }
  root.appendChild(main);
}

/* ============================================================
   栏目页（视频列表）
   ============================================================ */
async function pageColumn(root, colId, page) {
  const main = h('div', { class: 'main', style: { paddingTop: '100px' } }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');
  box.appendChild(sklRail('加载中…', '🎞️'));

  let col, data;
  try {
    col = await api('/api/columns/' + colId);
    data = await api(`/api/columns/${colId}/videos?page=${page}&size=36`);
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
    return;
  }

  root.innerHTML = '';
  root.appendChild(
    h('div', { class: 'page-head' }, [
      h('a', { class: 'chip', href: '#/category/' + col.category, style: { display: 'inline-block', marginBottom: '16px' }, text: '← 返回 ' + catName(col.category) }),
      h('h1', { class: 'page-title' }, [h('span', { text: '🎞️' }), h('span', { text: col.name })]),
      h('p', { class: 'page-sub', text: `共 ${fmtNum(data.total)} 期 · 第 ${page} 页` }),
    ])
  );

  const main2 = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  const grid = h('div', { class: 'grid' });
  data.list.forEach((v) => grid.appendChild(videoCard(v, (v) => go('/watch/' + v.guid + '?col=' + colId))));
  main2.querySelector('.container').appendChild(grid);

  // 分页
  const totalPages = Math.ceil((data.total || 0) / 36);
  if (totalPages > 1) {
    const pg = h('div', { class: 'chips', style: { justifyContent: 'center', marginTop: '36px' } });
    const start = Math.max(1, page - 4);
    const end = Math.min(totalPages, start + 8);
    if (page > 1) pg.appendChild(h('a', { class: 'chip', href: `#/column/${colId}?p=${page - 1}`, text: '‹ 上一页' }));
    for (let i = start; i <= end; i++) {
      pg.appendChild(h('a', { class: 'chip' + (i === page ? ' active' : ''), href: `#/column/${colId}?p=${i}`, text: String(i) }));
    }
    if (page < totalPages) pg.appendChild(h('a', { class: 'chip', href: `#/column/${colId}?p=${page + 1}`, text: '下一页 ›' }));
    main2.querySelector('.container').appendChild(pg);
  }

  root.appendChild(main2);
  document.title = col.name + ' · ' + (state.site.siteName || '慈云影视');
}

/* ============================================================
   播放页
   ============================================================ */
/** 额度不足时的引导页 */
function renderQuotaGate(main, d, guid) {
  const q = d.quota || {};
  const back = '#/watch/' + guid;
  const needLogin = !!d.needLogin;

  const acts = needLogin
    ? [h('a', { class: 'btn btn-primary', href: '#/login?redirect=' + encodeURIComponent(back), text: '🔑 立即登录' })]
    : [
        d.redeemEnabled
          ? h('a', { class: 'btn btn-primary', href: '#/vip?tab=redeem', text: '🎁 兑换额度' })
          : null,
        h('a', { class: 'btn btn-ghost', href: '#/vip?tab=plans', text: '💎 开通会员' }),
      ].filter(Boolean);

  main.appendChild(
    h('div', { class: 'quota-gate' }, [
      h('div', { class: 'qg-ic', text: needLogin ? '🔒' : '🎟️' }),
      h('h2', { text: needLogin ? '请先登录后观看' : '观看额度已用完' }),
      h('p', {
        text: needLogin
          ? '本站已开启观看额度管理，登录后可享受每日免费额度，也可通过兑换码获取更多额度。'
          : d.error || '当前账号的观看次数与点数均已用完，可通过兑换码获取额度或开通会员无限观看。',
      }),
      !needLogin
        ? h('div', { class: 'qg-stat' }, [
            q.times !== undefined
              ? h('div', {}, [h('div', { class: 'k', text: '观看次数' }), h('div', { class: 'v', text: q.timesText !== undefined ? q.timesText : String(q.times) })])
              : null,
            q.points !== undefined
              ? h('div', {}, [h('div', { class: 'k', text: '通用点数' }), h('div', { class: 'v', text: q.pointsText !== undefined ? q.pointsText : String(q.points) })])
              : null,
            q.freeRemain !== undefined && q.freeRemain >= 0
              ? h('div', {}, [h('div', { class: 'k', text: '今日免费剩余' }), h('div', { class: 'v', text: String(q.freeRemain) })])
              : null,
          ])
        : null,
      h('div', { class: 'qg-acts' }, acts),
      h('div', { style: { marginTop: '22px' } }, [
        h('a', { class: 'btn btn-ghost btn-sm', href: '#/', text: '返回首页' }),
      ]),
    ])
  );
}

async function pageWatch(root, guid) {
  const { params } = parseRoute();
  const main = h('div', { class: 'player-page' });
  root.appendChild(main);

  // 播放器容器
  const wrap = h('div', { class: 'player-wrap' });
  main.appendChild(wrap);
  wrap.appendChild(h('div', { class: 'spinner', style: { position: 'absolute', top: '50%', left: '50%', marginLeft: '-23px', marginTop: '-23px' } }));

  let info;
  try {
    info = await api('/api/video/' + guid);
  } catch (e) {
    const d = (e && e.data) || {};
    main.innerHTML = '';
    // 额度拦截 → 引导页
    if (d.needQuota || d.needLogin) {
      renderQuotaGate(main, d, guid);
      return;
    }
    main.appendChild(h('div', { class: 'error-box', text: '无法播放该视频：' + (d.message ? d.message : e.message) }));
    main.appendChild(h('div', { style: { padding: '0 40px' } }, [h('a', { class: 'btn btn-ghost', href: '#/', text: '返回首页' })]));
    return;
  }

  // 线路：优先用本地代理 src
  const lines = (info.lines || []).map((l, i) => ({
    ...l,
    src: '/api/stream?url=' + encodeURIComponent(l.url),
    type: l.type || detectType(l.url),
  }));
  if (!lines.length && info.hls) {
    lines.push({ id: 'hls', name: '默认线路', type: 'hls', src: '/api/stream?url=' + encodeURIComponent(info.hls) });
  }

  wrap.innerHTML = '';
  wrap.appendChild(h('div', { class: 'spinner', style: { position: 'absolute', top: '50%', left: '50%', marginLeft: '-23px', marginTop: '-23px' } }));

  const playerHost = h('div', { style: { position: 'absolute', inset: 0 } });
  wrap.innerHTML = '';
  wrap.appendChild(playerHost);

  // 弹幕层（覆盖在播放器之上）
  const dmLayer = h('div', { class: 'dm-layer' });
  wrap.appendChild(dmLayer);

  const lineBar = h('div', { class: 'line-picker' });
  let player;

  function renderLines(activeIdx) {
    lineBar.innerHTML = '';
    lineBar.appendChild(h('span', { class: 'label', text: '播放线路：' }));
    lines.forEach((l, i) => {
      lineBar.appendChild(
        h('button', {
          class: 'line-btn' + (i === activeIdx ? ' active' : ''),
          text: l.name || '线路 ' + (i + 1),
          onclick: () => { player.switchLine(i); renderLines(i); },
        })
      );
    });
    // 自动检测线路
    lineBar.appendChild(
      h('button', {
        class: 'line-btn',
        text: '⚡ 自动优选',
        onclick: async (e) => {
          e.target.textContent = '检测中…';
          try {
            const best = await api('/api/video/' + guid + '/best-line');
            const idx = lines.findIndex((l) => l.url === best.url);
            if (idx >= 0) { player.switchLine(idx); renderLines(idx); toast('已切换到最优线路', 'success'); }
            else { lines.unshift({ id: 'best', name: '优选线路', type: best.type, src: best.src, url: best.url }); player.switchLine(0); renderLines(0); toast('已启用优选线路', 'success'); }
          } catch { toast('优选失败，请手动切换', 'error'); }
          e.target.textContent = '⚡ 自动优选';
        },
      })
    );
  }

  // 顶部信息
  const isFav = fav.has(guid);
  const headBar = h('div', { class: 'player-head' }, [
    h('div', {}, [
      h('h1', { class: 'player-title', text: info.title || '视频播放' }),
      h('div', { class: 'player-meta' }, [
        info.duration ? h('span', { text: '时长 ' + info.duration }) : null,
        h('span', { class: 'tag tag-primary', text: 'HLS 高清' }),
        h('span', { text: '来源：央视网官方公开资源' }),
      ]),
    ]),
    h('div', { class: 'player-actions' }, [
      h('button', {
        class: 'btn btn-ghost btn-sm',
        html: (isFav ? '★ 已收藏' : '☆ 收藏'),
        onclick: (e) => {
          const on = fav.toggle({ guid, title: info.title, image: info.image, url: location.hash });
          e.target.innerHTML = on ? '★ 已收藏' : '☆ 收藏';
          toast(on ? '已加入收藏' : '已取消收藏', 'success');
        },
      }),
      h('a', { class: 'btn btn-primary btn-sm', href: '#/', text: '回到首页' }),
    ]),
  ]);

  main.appendChild(headBar);
  main.appendChild(lineBar);

  // 弹幕控制条
  const dmBarBox = h('div', { class: 'dm-bar' });
  main.appendChild(dmBarBox);

  let danmaku = null;

  // 创建播放器
  player = new Player(playerHost, {
    lines,
    guid,
    title: info.title,
    poster: info.image,
    autoplay: true,
    autoFailover: state.site && state.site.playback ? state.site.playback.autoFailover !== false : true,
    onLineChange: (i) => renderLines(i),
    onFailover: (i) => {
      toast('线路异常，已自动切换到 ' + (lines[i].name || '备用线路'), 'info');
    },
    onEnded: () => {
      // 自动播放同栏目下一集
      const col = params.get('col');
      if (col) loadNext(col, guid);
    },
  });
  renderLines(0);

  // 初始化弹幕（本地 + 全站）
  danmaku = createDanmaku(dmLayer, {
    targetId: guid,
    getTime: () => (player && player.video ? player.video.currentTime : 0),
  });
  createDanmakuBar(dmBarBox, danmaku);
  if (window.__dm && window.__dm.destroy) { try { window.__dm.destroy(); } catch {} }
  window.__dm = danmaku;

  // 记录历史
  history.add({ guid, title: info.title, image: info.image });

  // 评论区
  const cmSection = h('div', { class: 'cm-area' });
  main.appendChild(cmSection);
  mountComments(cmSection, { targetType: 'video', targetId: guid, maxLen: (state.site.community && state.site.community.maxLen) || 500 });

  // 同源聊天室：看同一部片的人一起聊
  const chatSection = h('div', { class: 'chat-wrap' });
  main.appendChild(chatSection);
  window.__chat = mountChat(chatSection, { room: 'video:' + guid, title: '同屏聊天室', subtitle: '正在看这部片的人都在这里' });

  // 相关推荐：同栏目其他视频
  const col = params.get('col');
  if (col) loadRelated(main, col, guid);
  else {
    // 无栏目信息时，用搜索相关标题
    try {
      const kw = (info.title || '').replace(/[《》\s].*$/, '').slice(0, 8);
      if (kw) {
        const r = await api('/api/search?q=' + encodeURIComponent(kw));
        const list = (r.list || []).filter((x) => x.guid && x.guid !== guid).slice(0, 12);
        if (list.length) {
          main.appendChild(
            rail('相关推荐', list, { icon: '🔗', renderItem: (v) => videoCard(v, (v) => go('/watch/' + v.guid)) })
          );
        }
      }
    } catch {}
  }
}

async function loadRelated(main, colId, guid) {
  try {
    const [col, data] = await Promise.all([
      api('/api/columns/' + colId),
      api(`/api/columns/${colId}/videos?page=1&size=36`),
    ]);
    const others = data.list.filter((v) => v.guid !== guid);
    main.appendChild(
      rail(col.name + ' · 更多', others, {
        icon: '🎞️',
        moreHref: '/column/' + colId,
        moreText: '查看全部',
        renderItem: (v) => videoCard(v, (v) => go('/watch/' + v.guid + '?col=' + colId)),
      })
    );
  } catch {}
}

async function loadNext(colId, guid) {
  try {
    const data = await api(`/api/columns/${colId}/videos?page=1&size=60`);
    const idx = data.list.findIndex((v) => v.guid === guid);
    if (idx >= 0 && data.list[idx + 1]) {
      const next = data.list[idx + 1];
      toast('即将播放：' + next.title, 'info');
      setTimeout(() => go('/watch/' + next.guid + '?col=' + colId), 1200);
    }
  } catch {}
}

/* ============================================================
   直播
   ============================================================ */
async function pageLive(root) {
  root.appendChild(
    h('div', { class: 'page-head' }, [
      h('h1', { class: 'page-title', html: '<span>📡</span> 电视直播' }),
      h('p', { class: 'page-sub', text: '中央电视台各频道 · 节目单实时同步' }),
    ])
  );
  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  let chs = state.liveChannels;
  if (!chs.length) {
    const d = await api('/api/live/channels');
    state.liveChannels = d.channels;
    chs = d.channels;
  }

  const grid = h('div', { class: 'live-grid' });
  box.appendChild(grid);
  chs.forEach((c) => {
    const card = h('div', { class: 'live-card', onclick: () => go('/live/' + c.id) }, [
      h('div', { class: 'live-badge' }, [h('span', { class: 'dotp' }), h('span', { text: '直播中' })]),
      h('div', { class: 'c-name', text: c.name }),
      h('div', { class: 'c-now', text: '加载节目单…' }),
    ]);
    grid.appendChild(card);
    api('/api/live/' + c.id + '/epg').then((epg) => {
      if (epg && epg.isLive) card.querySelector('.c-now').textContent = '正在播出：' + epg.isLive;
    }).catch(() => { card.querySelector('.c-now').textContent = '查看节目单'; });
  });
}

async function pageLiveRoom(root, chId) {
  const main = h('div', { class: 'player-page' });
  root.appendChild(main);

  const wrap = h('div', { class: 'player-wrap' }, [
    h('div', { class: 'spinner', style: { position: 'absolute', top: '50%', left: '50%', marginLeft: '-23px', marginTop: '-23px' } }),
  ]);
  main.appendChild(wrap);

  let live, epg;
  try {
    [live, epg] = await Promise.all([
      api('/api/live/' + chId),
      api('/api/live/' + chId + '/epg').catch(() => null),
    ]);
  } catch (e) {
    main.innerHTML = '';
    main.appendChild(h('div', { class: 'error-box', text: '直播加载失败：' + e.message }));
    return;
  }

  wrap.innerHTML = '';
  const host = h('div', { style: { position: 'absolute', inset: 0 } });
  wrap.appendChild(host);

  // 弹幕层
  const dmLayer = h('div', { class: 'dm-layer' });
  wrap.appendChild(dmLayer);

  main.appendChild(
    h('div', { class: 'player-head' }, [
      h('div', {}, [
        h('h1', { class: 'player-title', text: live.name || chId.toUpperCase() }),
        h('div', { class: 'player-meta' }, [
          h('span', { class: 'live-badge' }, [h('span', { class: 'dotp' }), h('span', { text: 'LIVE' })]),
          live.resolution ? h('span', { class: 'tag', text: live.resolution }) : null,
          live.audioOnly ? h('span', { class: 'tag tag-warn', text: '仅音频' }) : null,
        ]),
      ]),
      h('div', { class: 'player-actions' }, [
        h('a', { class: 'btn btn-ghost btn-sm', href: '#/live', text: '← 全部频道' }),
      ]),
    ])
  );

  // 🔴 实时节目单：正在播的节目 + 播放进度（来自 nowepg 接口，30 秒刷新）
  if (live.now) {
    const nowBox = h('div', { class: 'live-now' });
    const paint = (n) => {
      nowBox.innerHTML = '';
      if (!n) return;
      nowBox.appendChild(h('div', { class: 'ln-left' }, [
        h('div', { class: 'ln-label' }, [
          h('span', { class: 'ln-dotp' }),
          h('span', { text: '正在播出' }),
        ]),
        h('div', { class: 'ln-title', text: n.title || '—' }),
        h('div', { class: 'ln-time', text: (n.startText || '') + ' — ' + (n.endText || '') }),
      ]));
      nowBox.appendChild(h('div', { class: 'ln-right' }, [
        h('div', { class: 'ln-progress' }, [
          h('i', { style: { width: Math.min(100, Math.max(0, n.progress || 0)) + '%' } }),
        ]),
        h('div', { class: 'ln-remain', text: n.remaining > 0 ? ('还有 ' + n.remaining + ' 分钟') : '即将结束' }),
      ]));
    };
    paint(live.now);
    main.appendChild(nowBox);

    // 自动刷新进度（本地推进 + 每 30 秒重新拉取）
    let local = { ...live.now };
    const tick = setInterval(() => {
      if (!nowBox.isConnected) { clearInterval(tick); return; }
      if (local.end > local.start) {
        const elapsed = Math.min(local.end - local.start, Date.now() - local.start);
        local.progress = Math.round((elapsed / (local.end - local.start)) * 100);
        local.remaining = Math.max(0, Math.round((local.end - Date.now()) / 60000));
        paint(local);
      }
    }, 15000);
    setTimeout(async () => {
      try {
        const d = await api('/api/live/' + chId);
        if (d.now && nowBox.isConnected) { local = { ...d.now }; paint(local); }
      } catch {}
    }, 30000);
  }

  if (live.playable) {
    const p = new Player(host, {
      // 字段兼容（历史上出过 bug：只认 src/flvSrc，而某些响应只有 hls/flv）：
      //   · 优先用 src/flvSrc —— 接口已包装成 /api/stream 代理地址，
      //     走代理能统一注入 CODECS、规避跨域与 Referer 限制，最稳
      //   · 回退到 hls/flv 原始地址 —— 保证任何响应形态下都有源可播
      lines: [
        (live.src || live.hls) ? { name: 'HLS 线路', type: 'hls', src: live.src || live.hls, url: live.src || live.hls } : null,
        (live.flvSrc || live.flv) ? { name: 'FLV 线路', type: 'flv', src: live.flvSrc || live.flv, url: live.flvSrc || live.flv } : null,
      ].filter(Boolean),
      autoplay: true,
      title: live.name,
    });
    // 直播弹幕（当前频道 + 全站）
    const bar = h('div', { class: 'dm-bar' });
    main.appendChild(bar);
    const dm = createDanmaku(dmLayer, {
      targetId: 'live:' + chId,
      getTime: () => (p && p.video ? p.video.currentTime : 0),
    });
    createDanmakuBar(bar, dm);
    window.__dm = dm;
  } else {
    host.innerHTML = '';
    host.appendChild(
      h('div', { class: 'empty', style: { height: '100%', display: 'grid', placeContent: 'center' } }, [
        h('div', { class: 'ico', text: '📺' }),
        h('div', { class: 't', text: live.tip || '该频道暂不支持网页播放' }),
        h('div', { text: '受版权保护，部分直播时段不对外开放视频流。可观看下方完整节目单。' }),
      ])
    );
  }

  // 节目单
  if (epg && epg.list && epg.list.length) {
    const now = Date.now() / 1000;
    const list = h('div', { class: 'epg-list' });
    epg.list.forEach((it) => {
      const isNow = now >= it.start && now < it.end;
      list.appendChild(
        h('div', { class: 'epg-item' + (isNow ? ' now' : '') }, [
          h('span', { class: 'tm', text: it.showTime || new Date(it.start * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }),
          h('span', { class: 'ttl', text: it.title }),
          isNow ? h('span', { class: 'tag tag-primary', text: '正在播出' }) : null,
        ])
      );
    });
    main.appendChild(
      h('div', { class: 'main' }, [
        h('div', { class: 'container' }, [
          h('div', { class: 'section-head' }, [h('div', { class: 'section-title' }, [h('span', { class: 'icon', text: '🗓️' }), h('span', { text: '今日节目单' })])]),
          list,
        ]),
      ])
    );
    // 滚动到当前节目
    setTimeout(() => {
      const el = list.querySelector('.epg-item.now');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 300);
  }

  // 同源聊天室：同频道观众实时聊天
  const chatSection = h('div', { class: 'chat-wrap' });
  main.appendChild(chatSection);
  window.__chat = mountChat(chatSection, {
    room: 'live:' + chId,
    title: (live.name || chId.toUpperCase()) + ' 聊天室',
    subtitle: '正在看这个频道的观众',
  });
}

/* ============================================================
   影视资源库（动漫 / 美剧 / 电影 / 电视剧 … 多源聚合）
   ============================================================ */

/** 资源库频道定义：把「用户语言」映射到各采集源的分类名 */
const RES_TYPES = [
  { id: 'anime', name: '动漫', icon: '🎌', keys: ['动漫', '动画', '国漫', '中国动漫', '日本动漫', '日韩动漫', '海外动漫', '欧美动漫'] },
  { id: 'us', name: '美剧', icon: '🇺🇸', keys: ['美剧', '欧美剧', '欧美'] },
  { id: 'movie', name: '电影', icon: '🎬', keys: ['电影', '动作片', '喜剧片', '科幻片', '恐怖片', '爱情片', '战争片', '剧情片', '纪录片电影'] },
  { id: 'tv', name: '电视剧', icon: '📺', keys: ['电视剧', '国产剧', '港台剧', '日韩剧', '连续剧', '国产'] },
  { id: 'variety', name: '综艺', icon: '🎤', keys: ['综艺', '真人秀', '脱口秀'] },
  { id: 'doc', name: '纪录片', icon: '🌍', keys: ['纪录片', '记录'] },
];

/** 给 Promise 加超时兜底：超时则返回 fallback，避免个别慢源拖死整页渲染 */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** 分类名是否命中某频道 */
function resMatched(typeId, typeName) {
  const t = RES_TYPES.find((x) => x.id === typeId);
  if (!t) return false;
  const n = String(typeName || '');
  return t.keys.some((k) => n.includes(k));
}

/** 缓存各源的分类，避免重复请求 */
const _catCache = new Map();
async function sourceCategories(srcId) {
  if (_catCache.has(srcId)) return _catCache.get(srcId);
  try {
    const d = await api('/api/multi/' + srcId + '/categories');
    const list = d.categories || [];
    _catCache.set(srcId, list);
    return list;
  } catch {
    _catCache.set(srcId, []);
    return [];
  }
}

/** 资源库总览页：#/resource?type=anime */
async function pageResource(root, typeId) {
  const cur = RES_TYPES.find((x) => x.id === typeId) || RES_TYPES[0];

  root.appendChild(h('div', { class: 'search-hero' }, [
    h('div', { class: 'res-hero-title' }, [
      h('span', { class: 'icon', text: '🗂️' }),
      h('span', { text: '影视资源库' }),
    ]),
    h('div', { class: 'page-sub', text: '多源聚合 · 动漫 / 美剧 / 电影 / 电视剧，海量在线资源' }),
    h('div', { class: 'hot-words', style: { marginTop: '14px' } },
      RES_TYPES.map((t) => h('button', {
        class: 'chip' + (t.id === cur.id ? ' on' : ''),
        text: t.icon + ' ' + t.name,
        onclick: () => go('/resource?type=' + t.id),
      }))
    ),
  ]));

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');
  box.appendChild(sklRail('正在加载 ' + cur.name + ' …', cur.icon));

  try {
    const { sources: srcList } = await api('/api/multi/sources');
    const usable = (srcList || []).filter((s) => s.enabled !== false && s.type !== 'cctv');
    if (!usable.length) {
      box.innerHTML = '';
      box.appendChild(emptyState('🔌', '暂无可用的资源源', '请到后台「自定义源」添加并启用采集源'));
      return;
    }

    // ⚡ 增量渲染：哪个源先返回就先展示，不再等全部源。
    //    （原实现 Promise.all 要等 5 源 × 3 分类共 15 个请求全回来才渲染，实测约 15s，
    //      用户以为页面是空的 → 只能靠搜索。现在首屏约 1s 即可见内容。）
    box.innerHTML = '';
    let total = 0;
    let pending = usable.length;
    let renderedHead = false;
    const headEl = h('div', { class: 'section-head' }, [
      h('div', { class: 'section-title' }, [
        h('span', { class: 'icon', text: cur.icon }),
        h('span', { text: cur.name + ' · 共 0 部' }),
      ]),
    ]);
    const tail = h('div'); // 汇总区，始终留在最底部
    box.append(headEl, tail);

    const bumpHead = () => {
      headEl.querySelector('.section-title span:last-child').textContent = cur.name + ' · 共 ' + total + ' 部';
    };
    bumpHead();

    const renderSource = (src, list) => {
      if (!list.length) return;
      total += list.length;
      bumpHead();
      const sec = h('div', { style: { marginTop: '26px' } }, [
        h('div', { class: 'section-head' }, [
          h('div', { class: 'section-title' }, [
            h('span', { class: 'icon', text: '📡' }),
            h('span', { text: src.name }),
          ]),
          h('span', { class: 'page-sub', text: list.length + ' 部' }),
        ]),
      ]);
      const grid = h('div', { class: 'grid' });
      list.slice(0, 30).forEach((v) => grid.appendChild(vodCard(v, src.id)));
      sec.appendChild(grid);
      box.insertBefore(sec, tail); // 插到汇总区之前，保持顺序稳定
      renderedHead = true;
    };

    await Promise.all(
      usable.map(async (src) => {
        try {
          const cats = await sourceCategories(src.id);
          const hit = cats.filter((c) => resMatched(cur.id, c.name));
          if (hit.length) {
            // 分类内并发，但单源整体超时兜底，避免个别源拖死整页
            const chunks = await withTimeout(
              Promise.all(
                hit.slice(0, 3).map((c) =>
                  api('/api/multi/' + src.id + '/list?typeId=' + encodeURIComponent(c.id) + '&page=1')
                    .then((d) => (d.list || []).map((v) => ({ ...v, _type: c.name })))
                    .catch(() => [])
                )
              ),
              6000,
              []
            );
            const seen = new Set();
            const list = chunks.flat().filter((v) => {
              const k = (v.name || '').trim();
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            renderSource(src, list);
          }
        } catch (_) {
          /* 单源失败不影响其他源 */
        } finally {
          if (--pending === 0 && !renderedHead) {
            box.innerHTML = '';
            box.appendChild(emptyState('😕', cur.name + ' 频道暂无内容', '换个频道，或到后台启用更多资源源'));
          }
        }
      })
    );
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
  }
}

/** 采集源影片卡片 */
function vodCard(v, srcId) {
  const thumb = h('div', { class: 'card-thumb' });
  if (v.pic) {
    const img = h('img', { alt: v.name, loading: 'lazy' });
    img.onerror = () => { img.remove(); thumb.style.background = titleColor(v.name || 'x'); };
    img.src = v.pic;
    thumb.appendChild(img);
  } else {
    thumb.style.background = titleColor(v.name || 'x');
  }
  return h('div', {
    class: 'card',
    title: v.name,
    onclick: () => go('/vod/' + srcId + '/' + v.id),
  }, [
    thumb,
    v.remarks ? h('div', { class: 'card-dur', text: v.remarks }) : null,
    h('div', { class: 'card-play', html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>' }),
    h('div', { class: 'card-title', text: v.name }),
  ]);
}

/** 资源详情与播放页：#/vod/:srcId/:id */
async function pageVod(root, srcId, vodId) {
  root.appendChild(h('div', { class: 'watch-wrap' }, [h('div', { class: 'watch-skel skl' })]));

  let detail;
  try {
    detail = await api('/api/multi/' + srcId + '/detail/' + vodId);
  } catch (e) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'error-box', text: '影片加载失败：' + e.message }));
    return;
  }
  root.innerHTML = '';

  // 线路与剧集归一
  const lines = (detail.lines || []).map((l, i) => ({
    id: 'ln' + i,
    name: l.name || ('线路' + (i + 1)),
    type: 'hls',
    episodes: l.episodes || [],
  })).filter((l) => l.episodes.length);

  const wrap = h('div', { class: 'watch-wrap' });
  root.appendChild(wrap);

  const playerHost = h('div', { class: 'player-host' });
  wrap.appendChild(playerHost);

  if (!lines.length) {
    playerHost.appendChild(h('div', { class: 'error-box', text: '该影片暂无可播放线路' }));
    return;
  }

  // 当前线路 / 集
  let curLine = 0;
  let curEp = 0;
  const playUrl = () => lines[curLine].episodes[curEp].url;

  const epTitle = () => {
    const ep = lines[curLine].episodes[curEp] || {};
    return (detail.name || '') + (ep.name ? ' · ' + ep.name : '');
  };

  const info = {
    title: epTitle(),
    image: detail.pic || '',
  };

  // 播放器（经本地 /api/stream 代理，规避跨域与防盗链）
  const proxied = (u) => '/api/stream?url=' + encodeURIComponent(u);
  let player = new Player(playerHost, {
    lines: [{ id: 'main', name: '线路 1', type: 'hls', url: proxied(playUrl()) }],
    title: info.title,
    poster: info.image,
    autoplay: true,
    autoFailover: true,
    onEnded: () => {
      // 自动下一集
      if (curEp < lines[curLine].episodes.length - 1) { curEp += 1; switchEp(); }
    },
  });

  // 头部信息
  const headBar = h('div', { class: 'player-head' }, [
    h('div', {}, [
      h('h1', { class: 'player-title', text: detail.name || '影片' }),
      h('div', { class: 'player-meta' }, [
        detail.remarks ? h('span', { class: 'tag tag-primary', text: detail.remarks }) : null,
        detail.year ? h('span', { text: detail.year }) : null,
        detail.area ? h('span', { text: String(detail.area).trim() }) : null,
        detail.typeName ? h('span', { text: detail.typeName }) : null,
      ]),
    ]),
    h('div', { class: 'player-actions' }, [
      h('button', {
        class: 'btn btn-ghost btn-sm',
        html: fav.has('#/vod/' + srcId + '/' + vodId) ? '★ 已收藏' : '☆ 收藏',
        onclick: (e) => {
          const on = fav.toggle({ guid: 'vod:' + srcId + ':' + vodId, title: detail.name, image: detail.pic, url: location.hash });
          e.target.innerHTML = on ? '★ 已收藏' : '☆ 收藏';
          toast(on ? '已加入收藏' : '已取消收藏', 'success');
        },
      }),
      h('a', { class: 'btn btn-primary btn-sm', href: '#/resource', text: '更多资源' }),
    ]),
  ]);
  wrap.appendChild(headBar);

  // 线路切换
  const lineBar = h('div', { class: 'line-bar' });
  const renderLines = (active) => {
    lineBar.innerHTML = '';
    lines.forEach((l, i) => {
      lineBar.appendChild(h('button', {
        class: 'line-chip' + (i === active ? ' on' : ''),
        text: l.name + '（' + l.episodes.length + '）',
        onclick: () => { curLine = i; curEp = 0; switchEp(); renderLines(i); },
      }));
    });
  };
  wrap.appendChild(lineBar);
  renderLines(0);

  // 剧集列表
  const epBox = h('div', { class: 'ep-box' });
  wrap.appendChild(epBox);

  function renderEps() {
    epBox.innerHTML = '';
    epBox.appendChild(h('div', { class: 'section-title', style: { marginBottom: '12px' } }, [
      h('span', { class: 'icon', text: '🎞️' }),
      h('span', { text: '选集（' + lines[curLine].episodes.length + '）' }),
    ]));
    const grid = h('div', { class: 'ep-grid' });
    lines[curLine].episodes.forEach((ep, i) => {
      grid.appendChild(h('button', {
        class: 'ep-chip' + (i === curEp ? ' on' : ''),
        text: ep.name || String(i + 1),
        onclick: () => { curEp = i; switchEp(); },
      }));
    });
    epBox.appendChild(grid);
  }

  function switchEp() {
    if (player && player.destroy) { try { player.destroy(); } catch {} }
    playerHost.innerHTML = '';
    player = new Player(playerHost, {
      lines: [{ id: 'main', name: lines[curLine].name, type: 'hls', url: proxied(playUrl()) }],
      title: epTitle(),
      poster: info.image,
      autoplay: true,
      autoFailover: true,
      onEnded: () => {
        if (curEp < lines[curLine].episodes.length - 1) { curEp += 1; switchEp(); }
      },
    });
    playerHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderEps();
    renderLines(curLine);
  }

  // 简介
  if (detail.content) {
    wrap.appendChild(h('div', { class: 'card', style: { marginTop: '22px' } }, [
      h('h3', { text: '📖 剧情简介' }),
      h('p', { class: 'vod-brief', text: detail.content }),
      detail.actor ? h('p', { class: 'vod-meta-line', text: '主演：' + detail.actor }) : null,
      detail.director ? h('p', { class: 'vod-meta-line', text: '导演：' + detail.director }) : null,
    ]));
  }

  switchEp();
}

/* ============================================================
   搜索
   ============================================================ */
async function pageSearch(root, q) {
  const input = h('input', {
    placeholder: '输入关键词，如：罗小黑、美剧、纪录片…',
    value: q,
    onkeydown: (e) => { if (e.key === 'Enter') doSearch(e.target.value.trim()); },
  });

  root.appendChild(
    h('div', { class: 'search-hero' }, [
      h('div', { class: 'search-input-lg' }, [
        h('span', { html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>' }),
        input,
        h('button', { class: 'btn btn-primary btn-sm', text: '搜索', onclick: () => doSearch(input.value.trim()) }),
      ]),
      h('div', { class: 'hot-words' },
        ['罗小黑', '海贼王', '美剧', '火影忍者', '纪录片', '新闻联播', '百家讲坛', '动画片'].map((w) =>
          h('button', { class: 'chip', text: w, onclick: () => { input.value = w; doSearch(w); } })
        )
      ),
    ])
  );

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  if (!q) {
    box.appendChild(emptyState('🔍', '搜索你想看的内容', '同时搜索央视网与影视资源库（动漫 / 美剧 / 电影 / 电视剧）'));
    return;
  }

  // ⚡ 流式渲染：央视网与资源库两条通道各返回各渲染，先到的先显示，
  //    不再等两边都回来（原实现 Promise.allSettled 要等最慢的源，实测约 4s 才出结果）。
  box.innerHTML = '';
  const loading = h('div', { class: 'page-sub', style: { padding: '6px 2px 2px', opacity: '.7' }, text: '正在搜索「' + q + '」…' });
  box.appendChild(loading);

  const cctvZone = h('div');
  const multiZone = h('div');
  const emptyZone = h('div');
  box.append(cctvZone, multiZone, emptyZone);

  let shown = 0;
  let pending = 2;
  const finishOne = () => {
    if (--pending === 0) {
      loading.remove();
      if (!shown) {
        emptyZone.appendChild(emptyState('😕', '没有找到「' + q + '」相关内容', '换个关键词试试，或到「资源库」按频道浏览'));
      }
    }
  };

  // ① 央视网（通常很快，~0.1s，先出）
  withTimeout(api('/api/search?q=' + encodeURIComponent(q)), 8000, { list: [] })
    .then((d) => {
      const list = ((d && d.list) || []).filter((v) => v.guid);
      if (list.length) {
        shown += list.length;
        const sec = h('div', {}, [
          h('div', { class: 'section-head', style: { marginTop: '8px' } }, [
            h('div', { class: 'section-title' }, [
              h('span', { class: 'icon', text: '📺' }),
              h('span', { text: '央视网 · ' + list.length + ' 条' }),
            ]),
          ]),
        ]);
        const grid = h('div', { class: 'grid' });
        list.forEach((v) => grid.appendChild(videoCard(v, (v) => go('/watch/' + v.guid))));
        sec.appendChild(grid);
        cctvZone.appendChild(sec);
      }
    })
    .catch(() => {})
    .finally(finishOne);

  // ② 影视资源库（多源聚合，较慢，~4s，但不再阻塞央视结果展示）
  withTimeout(api('/api/multi/search?wd=' + encodeURIComponent(q)), 12000, { results: [] })
    .then((d) => {
      const results = ((d && d.results) || []).filter((r) => (r.list || []).length);
      const total = results.reduce((a, r) => a + r.list.length, 0);
      if (total) {
        shown += total;
        multiZone.appendChild(h('div', { class: 'section-head', style: { marginTop: '30px' } }, [
          h('div', { class: 'section-title' }, [
            h('span', { class: 'icon', text: '🗂️' }),
            h('span', { text: '影视资源库 · ' + total + ' 条' }),
          ]),
        ]));
        results.forEach((r) => {
          multiZone.appendChild(h('div', { class: 'section-head', style: { marginTop: '18px' } }, [
            h('div', { class: 'section-title' }, [
              h('span', { class: 'icon', text: '📡' }),
              h('span', { text: r.source.name }),
            ]),
            h('span', { class: 'page-sub', text: r.list.length + ' 条' }),
          ]));
          const grid = h('div', { class: 'grid' });
          r.list.slice(0, 24).forEach((v) => grid.appendChild(vodCard(v, r.source.id)));
          multiZone.appendChild(grid);
        });
      }
    })
    .catch(() => {})
    .finally(finishOne);

  function doSearch(kw) {
    if (!kw) return;
    go('/search?q=' + encodeURIComponent(kw));
  }
}

/* ============================================================
   收藏 / 历史
   ============================================================ */
function pageFav(root) {
  root.appendChild(h('div', { class: 'page-head' }, [
    h('h1', { class: 'page-title', html: '<span>⭐</span> 我的收藏' }),
    h('p', { class: 'page-sub', text: '收藏内容保存在本地浏览器' }),
  ]));
  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');
  const list = fav.list();
  if (!list.length) return box.appendChild(emptyState('⭐', '还没有收藏', '在播放页点击「收藏」即可添加'));
  const grid = h('div', { class: 'grid' });
  list.forEach((v) => grid.appendChild(videoCard(v, (v) => go('/watch/' + v.guid))));
  box.appendChild(grid);
}

function pageHistory(root) {
  root.appendChild(h('div', { class: 'page-head' }, [
    h('h1', { class: 'page-title', html: '<span>🕘</span> 观看历史' }),
    h('p', { class: 'page-sub', text: '最近观看记录' }),
  ]));
  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');
  const list = history.list();
  if (!list.length) return box.appendChild(emptyState('🕘', '暂无观看记录'));
  const grid = h('div', { class: 'grid' });
  list.forEach((v) => grid.appendChild(videoCard(v, (v) => go('/watch/' + v.guid))));
  box.appendChild(grid);
  box.appendChild(
    h('div', { style: { textAlign: 'center', marginTop: '32px' } }, [
      h('button', { class: 'btn btn-ghost btn-sm', text: '清空历史', onclick: () => { history.clear(); toast('已清空'); route(); } }),
    ])
  );
}

function page404(root) {
  root.appendChild(h('div', { class: 'main', style: { paddingTop: '140px' } }, [
    emptyState('🧭', '页面不存在', '检查一下地址吧'),
  ]));
}

/* ============================================================
   登录 / 注册
   ============================================================ */
function pageAuth(root, mode) {
  if (auth.loggedIn) { go('/profile'); return; }
  const c = (state.site && state.site.community) || {};
  if (mode === 'register' && (c.enabled === false || c.allowRegister === false)) {
    root.appendChild(h('div', { class: 'auth-page' }, [
      h('div', { class: 'auth-card' }, [
        h('div', { class: 'auth-head' }, [h('div', { class: 'mark', text: '慈' }), h('h1', { text: '暂未开放注册' }), h('p', { text: '本站当前关闭了注册入口，请联系管理员' })]),
        h('a', { class: 'btn btn-primary btn-block', href: '#/login', text: '去登录' }),
      ]),
    ]));
    return;
  }

  const isReg = mode === 'register';
  const { params } = parseRoute();
  const redirect = params.get('redirect') || '#/';

  const fields = {};

  const mkInput = (key, { type = 'text', placeholder, icon, autocomplete }) => {
    const input = h('input', { type, placeholder, autocomplete, name: key });
    fields[key] = input;
    const wrap = h('div', { class: 'input-wrap' }, [
      icon ? h('span', { class: 'ico', html: icon }) : null,
      input,
      type === 'password'
        ? h('span', { class: 'eye', html: eyeIcon(false), onclick: (e) => {
            const on = input.type === 'password';
            input.type = on ? 'text' : 'password';
            e.target.closest('.eye').innerHTML = eyeIcon(on);
          } })
        : null,
    ]);
    return wrap;
  };

  const pwdMeter = h('div', { class: 'pwd-meter', 'data-s': '0' }, [h('i'), h('i'), h('i'), h('i')]);
  const errBox = h('div', { class: 'err', style: { display: 'none' } });

  /* ---------- 邮箱验证码辅助（登录 / 注册 / 找回密码共用） ---------- */
  const mkCodeField = (key, scene, emailGetter) => {
    const input = h('input', { placeholder: '6 位验证码', maxlength: '6', inputmode: 'numeric', name: key });
    fields[key] = input;
    const btn = h('button', { class: 'btn btn-ghost btn-sm send-code', text: '获取验证码', type: 'button' });
    const wrap = h('div', { class: 'input-wrap has-btn' }, [
      h('span', { class: 'ico', html: shieldIcon() }),
      input,
      btn,
    ]);
    let timer = null;
    btn.onclick = async () => {
      const email = (emailGetter ? emailGetter() : fields.email.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr('请先填写正确的邮箱地址', 'email');
      btn.disabled = true;
      btn.textContent = '发送中…';
      try {
        const r = await api('/api/mail/code', { method: 'POST', body: { email, scene } });
        let left = 60;
        const tick = () => {
          if (left <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = '重新获取'; return; }
          btn.textContent = left + 's 后重发';
          left -= 1;
        };
        tick();
        timer = setInterval(tick, 1000);
        if (r.devMode && r.devCode) {
          input.value = r.devCode;
          toast('开发模式：验证码 ' + r.devCode + ' 已自动填入', 'info');
        } else {
          toast(r.message || '验证码已发送', 'success');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '获取验证码';
        showErr(e.message || '发送失败');
      }
    };
    return wrap;
  };

  /* ---------- 登录方式切换：密码 / 邮箱验证码 ---------- */
  let loginMode = 'password'; // password | email
  const modeSwitch = h('div', { class: 'auth-tabs' });

  const accountField = h('div', { class: 'field' }, [
    h('label', { text: '账号' }),
    mkInput('account', { placeholder: '4-20 位，字母开头', icon: userIcon(), autocomplete: 'username' }),
    h('div', { class: 'hint', text: '字母开头，可含字母、数字、下划线' }),
  ]);

  const pwdField = h('div', { class: 'field' }, [
    h('label', { text: '密码' }),
    mkInput('password', { type: 'password', placeholder: isReg ? '至少 8 位，含字母和数字' : '请输入密码', icon: lockIcon(), autocomplete: isReg ? 'new-password' : 'current-password' }),
    isReg ? pwdMeter : null,
    isReg ? h('div', { class: 'hint', text: '至少 8 位，需同时包含字母和数字' }) : null,
  ]);

  // 邮箱登录块（仅登录页、且站点开启邮箱登录时）
  const emailLoginOn = !isReg && c.emailLogin !== false;
  const emailField = h('div', { class: 'field' }, [
    h('label', { text: '邮箱' }),
    mkInput('email', { placeholder: 'your@email.com', icon: mailIcon(), autocomplete: 'email' }),
  ]);
  const emailCodeField = h('div', { class: 'field' }, [
    h('label', { text: '邮箱验证码' }),
    mkCodeField('emailCode', 'login', () => fields.email.value),
  ]);
  const emailBox = h('div', { class: 'email-login-box' }, [emailField, emailCodeField]);

  if (isReg) {
    fields.password.addEventListener('input', () => {
      pwdMeter.dataset.s = String(scorePassword(fields.password.value));
    });
  }

  const extraFields = isReg
    ? [
        h('div', { class: 'field' }, [
          h('label', { text: '昵称（选填）' }),
          mkInput('nickname', { placeholder: '显示名称，最多 16 字', icon: tagIcon(), autocomplete: 'nickname' }),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: '邮箱' + (c.needEmail || c.verifyEmail ? '' : '（选填）') }),
          mkInput('email', { placeholder: '用于登录与找回密码', icon: mailIcon(), autocomplete: 'email' }),
        ]),
        c.verifyEmail
          ? h('div', { class: 'field' }, [
              h('label', { text: '邮箱验证码' }),
              mkCodeField('emailCode', 'register', () => fields.email.value),
            ])
          : null,
        h('div', { class: 'field' }, [
          h('label', { text: '确认密码' }),
          mkInput('confirm', { type: 'password', placeholder: '再次输入密码', icon: lockIcon(), autocomplete: 'new-password' }),
        ]),
      ]
    : [];

  const submitBtn = h('button', { class: 'btn btn-primary btn-block', text: isReg ? '注册并登录' : '登 录' });

  const card = h('div', { class: 'auth-card' }, [
    h('div', { class: 'auth-head' }, [
      h('div', { class: 'mark', text: '慈' }),
      h('h1', { text: isReg ? '创建账号' : '欢迎回来' }),
      h('p', { text: isReg ? '注册即可参与评论、收藏与同步' : '登录后同步你的收藏、历史与评论' }),
    ]),
    c.commentReview && isReg
      ? h('div', { class: 'auth-notice', text: '📌 注册后可发表评论，新评论需经管理员审核后公开显示' })
      : null,
    errBox,
    emailLoginOn ? modeSwitch : null,
    loginMode === 'password' ? h('div', {}, [accountField, pwdField, ...extraFields.filter(Boolean)]) : emailBox,
    submitBtn,
    !isReg ? h('div', { class: 'auth-links' }, [
      h('a', { href: '#/forgot', text: '忘记密码？' }),
    ]) : null,
    h('div', { class: 'auth-foot' }, isReg
      ? ['已有账号？', h('a', { href: '#/login' + (redirect !== '#/' ? '?redirect=' + encodeURIComponent(redirect) : ''), text: '立即登录' })]
      : ['还没有账号？', h('a', { href: '#/register' + (redirect !== '#/' ? '?redirect=' + encodeURIComponent(redirect) : ''), text: '免费注册' })]),
  ]);

  root.appendChild(h('div', { class: 'auth-page' }, [card]));

  /** 重绘登录方式切换 */
  const paintMode = () => {
    if (!emailLoginOn) return;
    modeSwitch.innerHTML = '';
    [['password', '账号密码'], ['email', '邮箱验证码']].forEach(([m, label]) => {
      modeSwitch.appendChild(h('button', {
        class: 'auth-tab' + (loginMode === m ? ' on' : ''),
        text: label,
        onclick: () => {
          loginMode = m;
          errBox.style.display = 'none';
          const body = card.querySelector('.auth-body') || card;
          // 简易重绘：直接切换节点显示
          if (m === 'email') {
            accountField.replaceWith(emailBox);
            // 保证 emailBox 在 submitBtn 之前
          } else {
            emailBox.replaceWith(h('div', { class: 'pwd-stack' }, [accountField, pwdField, ...extraFields.filter(Boolean)]));
          }
          paintMode();
          submitBtn.textContent = m === 'email' ? '邮箱登录' : '登 录';
        },
      }));
    });
  };
  paintMode();

  const showErr = (msg, field) => {
    errBox.style.display = 'block';
    errBox.textContent = '⚠ ' + msg;
    if (field && fields[field]) fields[field].focus();
  };

  const doSubmit = async () => {
    errBox.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = '处理中…';
    try {
      let r;
      if (isReg) {
        const account = fields.account.value.trim();
        const password = fields.password.value;
        if (!account) throw Object.assign(new Error('请输入账号'), { data: { field: 'account' } });
        if (!password) throw Object.assign(new Error('请输入密码'), { data: { field: 'password' } });
        if (password !== fields.confirm.value) throw Object.assign(new Error('两次输入的密码不一致'), { data: { field: 'confirm' } });
        const localErr = validateLocal(account, password);
        if (localErr) throw Object.assign(new Error(localErr.msg), { data: { field: localErr.field } });
        r = await api('/api/user/register', {
          method: 'POST',
          body: {
            account, password,
            nickname: fields.nickname.value.trim(),
            email: fields.email.value.trim(),
            emailCode: fields.emailCode ? fields.emailCode.value.trim() : '',
          },
        });
      } else if (loginMode === 'email') {
        const email = fields.email.value.trim();
        const code = fields.emailCode.value.trim();
        if (!email) throw Object.assign(new Error('请输入邮箱'), { data: { field: 'email' } });
        if (!code) throw Object.assign(new Error('请输入邮箱验证码'), { data: { field: 'emailCode' } });
        r = await api('/api/user/login/email', { method: 'POST', body: { email, code } });
      } else {
        const account = fields.account.value.trim();
        const password = fields.password.value;
        if (!account) throw Object.assign(new Error('请输入账号'), { data: { field: 'account' } });
        if (!password) throw Object.assign(new Error('请输入密码'), { data: { field: 'password' } });
        r = await api('/api/user/login', { method: 'POST', body: { account, password } });
      }
      auth.loggedIn = true;
      auth.user = r.user;
      toast(isReg ? '注册成功，欢迎加入！' : '登录成功，欢迎回来', 'success');
      renderHeader();
      setTimeout(() => go(redirect.replace(/^#/, '')), 400);
    } catch (e) {
      showErr(e.message || '操作失败', e.data && e.data.field);
      submitBtn.disabled = false;
      submitBtn.textContent = isReg ? '注册并登录' : (loginMode === 'email' ? '邮箱登录' : '登 录');
    }
  };

  submitBtn.onclick = doSubmit;
  Object.values(fields).forEach((f) =>
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); })
  );
  if (fields.account) fields.account.focus();
  document.title = (isReg ? '注册' : '登录') + ' · ' + (state.site.siteName || '慈云影视');
}

/* ============================================================
   找回密码
   ============================================================ */
function pageForgot(root) {
  const fields = {};
  const errBox = h('div', { class: 'err', style: { display: 'none' } });
  const okBox = h('div', { class: 'ok-box', style: { display: 'none' } });

  const mk = (key, { type = 'text', placeholder, icon }) => {
    const input = h('input', { type, placeholder, name: key });
    fields[key] = input;
    return h('div', { class: 'input-wrap' }, [icon ? h('span', { class: 'ico', html: icon }) : null, input]);
  };

  const codeInput = h('input', { placeholder: '6 位验证码', maxlength: '6', inputmode: 'numeric' });
  fields.code = codeInput;
  const sendBtn = h('button', { class: 'btn btn-ghost btn-sm', text: '获取验证码', type: 'button' });
  let timer = null;
  sendBtn.onclick = async () => {
    const email = fields.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr('请输入正确的邮箱');
    sendBtn.disabled = true; sendBtn.textContent = '发送中…';
    try {
      const r = await api('/api/mail/code', { method: 'POST', body: { email, scene: 'reset' } });
      let left = 60;
      const tick = () => {
        if (left <= 0) { clearInterval(timer); sendBtn.disabled = false; sendBtn.textContent = '重新获取'; return; }
        sendBtn.textContent = left + 's 后重发'; left -= 1;
      };
      tick(); timer = setInterval(tick, 1000);
      if (r.devMode && r.devCode) { codeInput.value = r.devCode; toast('开发模式：验证码 ' + r.devCode, 'info'); }
      else toast(r.message || '验证码已发送', 'success');
    } catch (e) {
      sendBtn.disabled = false; sendBtn.textContent = '获取验证码';
      showErr(e.message || '发送失败');
    }
  };

  const submitBtn = h('button', { class: 'btn btn-primary btn-block', text: '重置密码' });

  const card = h('div', { class: 'auth-card' }, [
    h('div', { class: 'auth-head' }, [
      h('div', { class: 'mark', text: '慈' }),
      h('h1', { text: '找回密码' }),
      h('p', { text: '通过注册邮箱验证身份后重设密码' }),
    ]),
    errBox, okBox,
    h('div', { class: 'field' }, [h('label', { text: '注册邮箱' }), mk('email', { placeholder: 'your@email.com', icon: mailIcon() })]),
    h('div', { class: 'field' }, [h('label', { text: '邮箱验证码' }),
      h('div', { class: 'input-wrap has-btn' }, [h('span', { class: 'ico', html: shieldIcon() }), codeInput, sendBtn])]),
    h('div', { class: 'field' }, [h('label', { text: '新密码' }), mk('password', { type: 'password', placeholder: '至少 8 位，含字母和数字', icon: lockIcon() })]),
    submitBtn,
    h('div', { class: 'auth-foot' }, ['想起来了？', h('a', { href: '#/login', text: '返回登录' })]),
  ]);
  root.appendChild(h('div', { class: 'auth-page' }, [card]));

  const showErr = (m) => { errBox.style.display = 'block'; errBox.textContent = '⚠ ' + m; okBox.style.display = 'none'; };

  submitBtn.onclick = async () => {
    errBox.style.display = 'none';
    submitBtn.disabled = true; submitBtn.textContent = '提交中…';
    try {
      const r = await api('/api/user/reset-password', {
        method: 'POST',
        body: { email: fields.email.value.trim(), code: fields.code.value.trim(), password: fields.password.value },
      });
      okBox.style.display = 'block';
      okBox.textContent = '✅ ' + (r.message || '密码已重置') + '，即将跳转登录…';
      setTimeout(() => go('/login'), 1500);
    } catch (e) {
      showErr(e.message || '重置失败');
      submitBtn.disabled = false; submitBtn.textContent = '重置密码';
    }
  };
  document.title = '找回密码 · ' + (state.site.siteName || '慈云影视');
}

function validateLocal(account, password) {
  if (account.length < 4 || account.length > 20) return { msg: '账号长度需 4-20 位', field: 'account' };
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(account)) return { msg: '账号需字母开头，仅含字母、数字、下划线', field: 'account' };
  if (password.length < 8) return { msg: '密码至少 8 位', field: 'password' };
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return { msg: '密码需同时包含字母和数字', field: 'password' };
  return null;
}

function scorePassword(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Za-z]/.test(p) && /[0-9]/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}

/* ============================================================
   个人中心
   ============================================================ */
async function pageProfile(root, tab) {
  if (!auth.loggedIn) { go('/login?redirect=' + encodeURIComponent(location.hash)); return; }
  await auth.refresh();
  const u = auth.user;

  const main = h('div', { class: 'main' }, [h('div', { class: 'container profile-page' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  // 头部
  const av = avatarEl(u, 'lg');
  av.title = '点击更换头像';
  const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  av.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    if (!f) return;
    if (f.size > 500 * 1024) return toast('头像请小于 500KB', 'error');
    const dataUrl = await readAsDataURL(f);
    try {
      const r = await api('/api/user/profile', { method: 'PUT', body: { avatar: dataUrl } });
      auth.user = r.user;
      toast('头像已更新', 'success');
      renderHeader();
      pageProfile(root, tab);
    } catch (e) { toast(e.message, 'error'); }
  };

  box.appendChild(
    h('div', { class: 'profile-head' }, [
      h('div', { class: 'avatar-pick' }, [av, fileInput]),
      h('div', { class: 'info' }, [
        h('div', { class: 'n', text: u.nickname || u.account }),
        h('div', { class: 'a', text: '@' + u.account + (u.email ? ' · ' + u.email : '') }),
        u.bio ? h('div', { class: 'b', text: u.bio }) : null,
        u.vip ? h('div', { class: 'cm-badge', style: { display: 'inline-block', marginTop: '8px' }, text: '💎 会员' }) : null,
      ]),
      h('div', { class: 'profile-stats' }, [
        h('div', { class: 's' }, [h('div', { class: 'v', text: String((u.stats && u.stats.comments) || 0) }), h('div', { class: 'k', text: '条评论' })]),
        h('div', { class: 's' }, [h('div', { class: 'v', text: String(fav.list().length) }), h('div', { class: 'k', text: '个收藏' })]),
        h('div', { class: 's' }, [h('div', { class: 'v', text: new Date(u.createdAt || Date.now()).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) }), h('div', { class: 'k', text: '加入于' })]),
      ]),
    ])
  );

  // Tab
  const monetize = (state.site && state.site.monetize) || {};
  const tabs = [
    { id: 'info', label: '资料设置' },
    { id: 'security', label: '账号安全' },
    { id: 'comments', label: '我的评论' },
    monetize.enabled ? { id: 'orders', label: '我的订单' } : null,
  ].filter(Boolean);
  const bar = h('div', { class: 'tab-bar' });
  tabs.forEach((t) => bar.appendChild(
    h('button', { class: tab === t.id ? 'on' : '', text: t.label, onclick: () => go('/profile?tab=' + t.id) })
  ));
  box.appendChild(bar);

  const panel = h('div', { class: 'panel' });
  box.appendChild(panel);

  if (tab === 'info') renderInfoTab(panel, u, root);
  else if (tab === 'security') renderSecurityTab(panel, u);
  else if (tab === 'orders') renderVipPage(panel, state.site, { tab: 'orders' });
  else renderMyComments(panel);

  document.title = '个人中心 · ' + (state.site.siteName || '慈云影视');
}

function renderInfoTab(box, u, root) {
  const nick = h('input', { value: u.nickname || '', placeholder: '最多 16 字' });
  const email = h('input', { value: u.email || '', placeholder: '选填，用于找回账号' });
  const bio = h('textarea', { rows: '3', placeholder: '一句话介绍自己（最多 100 字）', maxlength: '100' });
  bio.value = u.bio || '';

  box.appendChild(
    h('div', { class: 'card', style: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '24px' } }, [
      h('div', { class: 'field' }, [h('label', { text: '昵称' }), h('div', { class: 'input-wrap' }, [nick])]),
      h('div', { class: 'field' }, [h('label', { text: '邮箱' }), h('div', { class: 'input-wrap' }, [email])]),
      h('div', { class: 'field' }, [h('label', { text: '个人简介' }), h('div', { class: 'input-wrap', style: { alignItems: 'flex-start', paddingTop: '12px' } }, [bio])]),
      h('button', {
        class: 'btn btn-primary',
        text: '保存修改',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const r = await api('/api/user/profile', { method: 'PUT', body: { nickname: nick.value.trim(), email: email.value.trim(), bio: bio.value.trim() } });
            auth.user = r.user;
            toast('资料已更新', 'success');
            renderHeader();
          } catch (err) { toast(err.message, 'error'); }
          e.target.disabled = false;
        },
      }),
    ])
  );
}

function renderSecurityTab(box, u) {
  const oldP = h('input', { type: 'password', placeholder: '当前密码' });
  const newP = h('input', { type: 'password', placeholder: '新密码（至少 8 位，含字母和数字）' });
  const cfmP = h('input', { type: 'password', placeholder: '确认新密码' });
  const meter = h('div', { class: 'pwd-meter', 'data-s': '0' }, [h('i'), h('i'), h('i'), h('i')]);
  newP.addEventListener('input', () => { meter.dataset.s = String(scorePassword(newP.value)); });

  box.appendChild(
    h('div', { class: 'card', style: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '24px' } }, [
      h('div', { style: { fontSize: '15px', fontWeight: '700', marginBottom: '18px' }, text: '🔐 修改密码' }),
      h('div', { class: 'field' }, [h('label', { text: '当前密码' }), h('div', { class: 'input-wrap' }, [oldP])]),
      h('div', { class: 'field' }, [h('label', { text: '新密码' }), h('div', { class: 'input-wrap' }, [newP]), meter]),
      h('div', { class: 'field' }, [h('label', { text: '确认新密码' }), h('div', { class: 'input-wrap' }, [cfmP])]),
      h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)', marginBottom: '14px' }, text: '修改成功后，其他设备将自动退出登录。' }),
      h('button', {
        class: 'btn btn-primary',
        text: '确认修改',
        onclick: async (e) => {
          if (newP.value !== cfmP.value) return toast('两次新密码不一致', 'error');
          const le = validateLocal(u.account, newP.value);
          if (le && le.field === 'password') return toast(le.msg, 'error');
          e.target.disabled = true;
          try {
            await api('/api/user/password', { method: 'PUT', body: { oldPassword: oldP.value, newPassword: newP.value } });
            toast('密码已修改', 'success');
            oldP.value = newP.value = cfmP.value = '';
            meter.dataset.s = '0';
          } catch (err) { toast(err.message, 'error'); }
          e.target.disabled = false;
        },
      }),
    ])
  );
}

async function renderMyComments(box) {
  box.innerHTML = '<div style="color:var(--text-mute);padding:20px 0">加载中…</div>';
  try {
    const d = await api('/api/user/comments');
    box.innerHTML = '';
    if (!d.list.length) {
      box.appendChild(emptyState('💬', '还没有发表过评论', '去影片页参与讨论吧'));
      return;
    }
    const wrap = h('div', { class: 'card', style: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '8px 22px' } });
    d.list.forEach((c) => {
      wrap.appendChild(
        h('div', { class: 'my-cm' }, [
          h('div', { style: { fontSize: '14.5px', lineHeight: '1.7', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }, text: c.content }),
          h('div', { class: 'src' }, [
            relTime(c.createdAt) + ' · ' +
            (c.status === 'pending' ? '⏳ 审核中' : c.status === 'hidden' ? '🚫 已隐藏' : '✓ 已公开') + ' · 👍 ' + ((c.likes && c.likes.length) || 0),
          ]),
        ])
      );
    });
    box.appendChild(wrap);
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(h('div', { class: 'error-box', text: e.message }));
  }
}

function readAsDataURL(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}

/* ---------- 图标 ---------- */
function userIcon() { return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>'; }
function lockIcon() { return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'; }
function mailIcon() { return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>'; }
function shieldIcon() { return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v6c0 4.4-3 8.3-7 9-4-0.7-7-4.6-7-9V6z"/><path d="M9.5 12l1.8 1.8 3.2-3.6"/></svg>'; }
function tagIcon() { return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12l-8 8-9-9V4h7z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>'; }
function eyeIcon(open) {
  return open
    ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7c2.2 0 4.2.9 5.8 2M22 12s-3.5 7-10 7c-2.2 0-4.2-.9-5.8-2M3 3l18 18"/></svg>';
}

/* ============================================================
   通过邀请链接加入家庭
   ============================================================ */
async function pageJoin(root, code) {
  const main = h('div', { class: 'main' }, [h('div', { class: 'container profile-page' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  if (!code) { go('/family'); return; }

  box.appendChild(
    h('div', { class: 'fam-notice' }, [h('div', { class: 'fam-ico lg', text: '⏳' }), h('h3', { text: '正在验证邀请码…' })])
  );

  if (!auth.loggedIn) {
    box.innerHTML = '';
    box.appendChild(
      h('div', { class: 'fam-notice' }, [
        h('div', { class: 'fam-ico lg', text: '🔒' }),
        h('h3', { text: '登录后加入家庭' }),
        h('p', { text: '邀请码：' + code }),
        h('div', { class: 'fam-notice-acts' }, [
          h('a', { class: 'btn btn-primary', href: '#/login?redirect=' + encodeURIComponent('#/join?code=' + code), text: '登录 / 注册' }),
        ]),
      ])
    );
    return;
  }

  try {
    const p = await api('/api/family/invite/' + encodeURIComponent(code) + '/peek');
    box.innerHTML = '';
    box.appendChild(
      h('div', { class: 'fam-notice' }, [
        h('div', { class: 'fam-ico lg', text: '👨‍👩‍👧‍👦' }),
        h('h3', { text: '「' + p.familyName + '」邀请你加入' }),
        h('p', { text: `户主：${p.ownerNickname} · 当前 ${p.count}/${p.maxMembers} 名成员\n加入后可共享会员权益与观看内容` }),
        h('div', { class: 'fam-notice-acts' }, [
          h('a', { class: 'btn btn-ghost', href: '#/family', text: '先不加入' }),
          h('button', {
            class: 'btn btn-primary', text: '接受邀请，加入家庭',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await api('/api/family/join', { method: 'POST', body: { code } });
                toast('已加入家庭', 'success');
                go('/family');
              } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
            },
          }),
        ]),
      ])
    );
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(
      h('div', { class: 'fam-notice' }, [
        h('div', { class: 'fam-ico lg', text: '⚠️' }),
        h('h3', { text: '邀请码不可用' }),
        h('p', { text: e.message }),
        h('div', { class: 'fam-notice-acts' }, [h('a', { class: 'btn btn-ghost', href: '#/family', text: '返回家庭页' })]),
      ])
    );
  }
}

/* ============================================================
   启动
   ============================================================ */
// 恢复主题偏好
const savedTheme = ls.get('theme', null);
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

boot();
