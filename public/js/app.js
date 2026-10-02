/* ============================================================
   慈云影视 · 主应用（路由 + 页面）
   ============================================================ */

import { h, api, go, parseRoute, esc, fmtNum, fav, history, toast, applyTheme, ls, durToSec, relTime } from './util.js';
import { videoCard, columnCard, rail, sklRail, footer, emptyState, loadMoreBtn } from './components.js';
import { Player, detectType } from './player.js';
import { auth, avatarEl } from './auth.js';
import { mountComments } from './comments.js';
import { mountChat } from './chat.js';
import { createDanmaku, createDanmakuBar } from './danmaku.js';
import { renderFamilyPage } from './family.js';
import { renderVipPage } from './vip.js';

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
    { href: '#/live', text: '电视直播', match: ['/live'] },
    { href: '#/family', text: '家庭共享', match: ['/family'] },
    { href: '#/category/news', text: '新闻', match: ['/category/news'] },
    { href: '#/category/documentary', text: '纪录片', match: ['/category/documentary'] },
    { href: '#/category/movie', text: '影视', match: ['/category/movie'] },
    { href: '#/category/anime', text: '动画', match: ['/category/anime'] },
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
    if (seg[0] === 'search') return pageSearch(root, params.get('q') || '');
    if (seg[0] === 'fav') return pageFav(root);
    if (seg[0] === 'history') return pageHistory(root);
    if (seg[0] === 'login') return pageAuth(root, 'login');
    if (seg[0] === 'register') return pageAuth(root, 'register');
    if (seg[0] === 'profile') return pageProfile(root, params.get('tab') || 'info');
    if (seg[0] === 'family') return renderFamilyPage(root, state.site);
    if (seg[0] === 'vip') return renderVipPage(root, state.site, { tab: params.get('tab') || 'plans' });
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
          epg && epg.isLive ? h('span', { text: '正在播出：' + epg.isLive }) : null,
        ]),
      ]),
      h('div', { class: 'player-actions' }, [
        h('a', { class: 'btn btn-ghost btn-sm', href: '#/live', text: '← 全部频道' }),
      ]),
    ])
  );

  if (live.playable) {
    const p = new Player(host, {
      lines: [
        live.src ? { name: 'HLS 线路', type: 'hls', src: live.src, url: live.hls } : null,
        live.flvSrc ? { name: 'FLV 线路', type: 'flv', src: live.flvSrc, url: live.flv } : null,
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
   搜索
   ============================================================ */
async function pageSearch(root, q) {
  const input = h('input', {
    placeholder: '输入关键词，如：纪录片、新闻、百家讲坛…',
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
        ['纪录片', '新闻联播', '百家讲坛', '探索发现', '动物世界', '国家记忆', '动画片', '足球'].map((w) =>
          h('button', { class: 'chip', text: w, onclick: () => { input.value = w; doSearch(w); } })
        )
      ),
    ])
  );

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  if (!q) {
    box.appendChild(emptyState('🔍', '搜索你想看的内容', '支持搜索央视网全部公开视频资源'));
    return;
  }

  box.appendChild(sklRail('搜索中…', '🔍'));
  try {
    const d = await api('/api/search?q=' + encodeURIComponent(q));
    box.innerHTML = '';
    if (!d.list || !d.list.length) {
      box.appendChild(emptyState('😕', '没有找到「' + q + '」相关内容', '换个关键词试试'));
      return;
    }
    box.appendChild(h('div', { class: 'section-head' }, [
      h('div', { class: 'section-title' }, [h('span', { class: 'icon', text: '🔍' }), h('span', { text: `「${q}」的搜索结果（${d.list.length}）` })]),
    ]));
    const grid = h('div', { class: 'grid' });
    d.list
      .filter((v) => v.guid)
      .forEach((v) => grid.appendChild(videoCard(v, (v) => go('/watch/' + v.guid))));
    box.appendChild(grid);
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(h('div', { class: 'error-box', text: '搜索失败：' + e.message }));
  }

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
          h('label', { text: '邮箱' + (c.needEmail ? '' : '（选填）') }),
          mkInput('email', { placeholder: '用于找回账号', icon: mailIcon(), autocomplete: 'email' }),
        ]),
        isReg ? h('div', { class: 'field' }, [
          h('label', { text: '确认密码' }),
          mkInput('confirm', { type: 'password', placeholder: '再次输入密码', icon: lockIcon(), autocomplete: 'new-password' }),
        ]) : null,
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
    accountField,
    pwdField,
    ...extraFields.filter(Boolean),
    submitBtn,
    h('div', { class: 'auth-foot' }, isReg
      ? ['已有账号？', h('a', { href: '#/login' + (redirect !== '#/' ? '?redirect=' + encodeURIComponent(redirect) : ''), text: '立即登录' })]
      : ['还没有账号？', h('a', { href: '#/register' + (redirect !== '#/' ? '?redirect=' + encodeURIComponent(redirect) : ''), text: '免费注册' })]),
  ]);

  root.appendChild(h('div', { class: 'auth-page' }, [card]));

  const showErr = (msg, field) => {
    errBox.style.display = 'block';
    errBox.textContent = '⚠ ' + msg;
    if (field && fields[field]) fields[field].focus();
  };

  const doSubmit = async () => {
    errBox.style.display = 'none';
    const account = fields.account.value.trim();
    const password = fields.password.value;
    if (!account) return showErr('请输入账号', 'account');
    if (!password) return showErr('请输入密码', 'password');

    if (isReg) {
      if (password !== fields.confirm.value) return showErr('两次输入的密码不一致', 'confirm');
      const localErr = validateLocal(account, password);
      if (localErr) return showErr(localErr.msg, localErr.field);
    }

    submitBtn.disabled = true;
    submitBtn.textContent = isReg ? '注册中…' : '登录中…';
    try {
      const body = isReg
        ? { account, password, nickname: fields.nickname.value.trim(), email: fields.email.value.trim() }
        : { account, password };
      const r = await api('/api/user/' + (isReg ? 'register' : 'login'), { method: 'POST', body });
      auth.loggedIn = true;
      auth.user = r.user;
      toast(isReg ? '注册成功，欢迎加入！' : '登录成功，欢迎回来', 'success');
      renderHeader();
      setTimeout(() => go(redirect.replace(/^#/, '')), 400);
    } catch (e) {
      showErr(e.message || '操作失败', e.data && e.data.field);
      submitBtn.disabled = false;
      submitBtn.textContent = isReg ? '注册并登录' : '登 录';
    }
  };

  submitBtn.onclick = doSubmit;
  Object.values(fields).forEach((f) =>
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); })
  );
  fields.account.focus();
  document.title = (isReg ? '注册' : '登录') + ' · ' + (state.site.siteName || '慈云影视');
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
