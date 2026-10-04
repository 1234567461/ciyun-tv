/* ============================================================
   慈云影视 · 短视频（小型 B 站）
   ------------------------------------------------------------
   两种布局：
     · 竖屏刷视频流（#/shorts）—— 上下滑动切换，移动端为主
     · 网格广场（#/shorts?view=grid）—— 桌面端浏览
     · 上传页（#/shorts/upload）
   ============================================================ */

import { h, api, go, goReplace, goBackOrHome, toast, esc, fmtNum } from './util.js';
import { auth, avatarEl } from './auth.js';

/* ---------- 工具 ---------- */

function relTime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

function fmtDur(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

/** 缩略图（无封面时用渐变占位 + 首字） */
function coverEl(item, cls = 'sh-cover') {
  if (item.cover) {
    return h('div', { class: cls, style: { backgroundImage: 'url(' + item.cover + ')' } });
  }
  const el = h('div', { class: cls + ' sh-cover-ph' });
  const t = String(item.title || '视频');
  let hash = 0;
  for (let i = 0; i < t.length; i++) hash = (hash * 31 + t.charCodeAt(i)) >>> 0;
  const hues = [[340, 20], [265, 25], [200, 30], [150, 28], [40, 24]];
  const [hue, spread] = hues[hash % hues.length];
  el.style.background = 'linear-gradient(135deg, hsl(' + hue + ' 62% 42%), hsl(' + (hue + spread) + ' 58% 28%))';
  el.appendChild(h('span', { class: 'sh-ph-t', text: t.slice(0, 2) }));
  return el;
}

/* ============================================================
   入口：#/shorts
   ============================================================ */
export async function renderShortsPage(root, params) {
  const view = params.get('view') === 'grid' ? 'grid' : 'feed';
  await auth.refresh();

  if (view === 'grid') return renderGrid(root);
  return renderFeed(root, params);
}

/* ============================================================
   竖屏刷视频流（推流量机制：推荐 / 最新 / 最热）
   ============================================================ */
const FEED_SORTS = [
  { id: 'recommend', label: '推荐' },
  { id: 'new', label: '最新' },
  { id: 'hot', label: '最热' },
];

async function renderFeed(root, params) {
  let sort = 'recommend';
  try { sort = params.get('sort') || 'recommend'; } catch {}
  if (!FEED_SORTS.some((s) => s.id === sort)) sort = 'recommend';

  const wrap = h('div', { class: 'sh-feed-wrap' });
  root.appendChild(wrap);

  // 顶部悬浮操作条：返回 / 排序切换（推流量机制入口） / 网格 / 发布
  const sortTabs = h('div', { class: 'sh-sort-tabs' },
    FEED_SORTS.map((s) => h('button', {
      class: 'sh-sort-tab' + (s.id === sort ? ' on' : ''),
      text: s.label,
      onclick: () => {
        if (s.id === sort) return;
        go('/shorts?view=feed&sort=' + s.id);   // hash 变化 → 路由重渲染 feed
      },
    }))
  );

  const head = h('div', { class: 'sh-feed-head' }, [
    h('button', {
      class: 'sh-fh-btn', title: '返回',
      html: '‹',
      onclick: () => goBackOrHome('/'),
    }),
    h('div', { class: 'sh-fh-title', text: '刷视频' }),
    sortTabs,
    h('button', { class: 'sh-fh-btn', text: '☰', title: '网格浏览', onclick: () => go('/shorts?view=grid') }),
    auth.loggedIn
      ? h('button', { class: 'sh-fh-btn sh-fh-pub', html: '<span>＋</span> 发布', onclick: () => go('/shorts/upload') })
      : h('button', { class: 'sh-fh-btn', html: '<span>＋</span> 发布', onclick: () => go('/login?redirect=' + encodeURIComponent('#/shorts/upload')) }),
  ]);
  wrap.appendChild(head);

  const stage = h('div', { class: 'sh-stage' });
  wrap.appendChild(stage);

  const loading = h('div', { class: 'sh-feed-loading' }, [
    h('div', { class: 'sh-spin' }),
    h('div', { text: '正在加载视频…' }),
  ]);
  stage.appendChild(loading);

  let list = [];
  try {
    const d = await api('/api/shorts?sort=' + encodeURIComponent(sort) + '&page=1&size=20');
    list = (d && d.list) || [];
  } catch (e) {
    stage.innerHTML = '';
    stage.appendChild(h('div', { class: 'sh-feed-empty' }, [
      h('div', { class: 'ico', text: '😕' }),
      h('div', { text: '加载失败：' + (e.message || '网络异常') }),
      h('button', { class: 'btn btn-primary btn-sm', text: '重试', onclick: () => renderShortsPage(root, new URLSearchParams()) }),
    ]));
    return;
  }

  stage.innerHTML = '';

  if (!list.length) {
    stage.appendChild(h('div', { class: 'sh-feed-empty' }, [
      h('div', { class: 'ico', text: '🎬' }),
      h('div', { text: '还没有人发布视频' }),
      h('div', { class: 'sub', text: '成为第一个分享的人吧' }),
      h('button', {
        class: 'btn btn-primary',
        text: auth.loggedIn ? '去发布' : '登录后发布',
        onclick: () => go(auth.loggedIn ? '/shorts/upload' : '/login?redirect=' + encodeURIComponent('#/shorts/upload')),
      }),
    ]));
    return;
  }

  // 逐个渲染
  const cards = list.map((it, i) => buildFeedCard(it, i));
  cards.forEach((c) => stage.appendChild(c));

  let idx = 0;
  const activate = (n) => {
    idx = Math.max(0, Math.min(cards.length - 1, n));
    cards.forEach((c, i) => c.classList.toggle('on', i === idx));
    cards.forEach((c, i) => { if (Math.abs(i - idx) > 1) c.pause(); });  // 只保留相邻两个在播
    cards[idx].play();
    // 接近末尾时自动加载下一页
    if (idx >= cards.length - 3 && !loadingMore && hasMore) loadMore();
  };

  let page = 1;
  let hasMore = list.length >= 20;
  let loadingMore = false;

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const d = await api('/api/shorts?sort=new&page=' + (page + 1) + '&size=20');
      const more = (d && d.list) || [];
      if (!more.length) { hasMore = false; return; }
      page++;
      hasMore = !!d.hasMore;
      more.forEach((it, k) => {
        const c = buildFeedCard(it, cards.length + k);
        stage.appendChild(c);
        cards.push(c);
      });
    } catch { hasMore = false; }
    finally { loadingMore = false; }
  }

  // 滚轮 / 键盘 / 触摸滑动 切换
  const onWheel = (e) => {
    if (Math.abs(e.deltaY) < 12) return;
    e.preventDefault();
    activate(idx + (e.deltaY > 0 ? 1 : -1));
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); activate(idx + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); activate(idx - 1); }
    else if (e.key === ' ') { e.preventDefault(); cards[idx].toggle(); }
  };
  let touchY = null;
  const onTouchStart = (e) => { touchY = e.touches[0].clientY; };
  const onTouchEnd = (e) => {
    if (touchY == null) return;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dy) > 46) activate(idx + (dy < 0 ? 1 : -1));
    touchY = null;
  };

  wrap.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  wrap.addEventListener('touchstart', onTouchStart, { passive: true });
  wrap.addEventListener('touchend', onTouchEnd, { passive: true });

  // 离开页面时清理（SPA 切页不触发 beforeunload，用 MutationObserver 兜底）
  const cleanup = () => {
    window.removeEventListener('keydown', onKey);
    cards.forEach((c) => c.destroy());
  };
  const mo = new MutationObserver(() => {
    if (!wrap.isConnected) { cleanup(); mo.disconnect(); }
  });
  mo.observe(root, { childList: true });
  window.addEventListener('pagehide', cleanup, { once: true });

  activate(0);
}

/** 单个竖屏卡片（自带播放控制） */
function buildFeedCard(item, i) {
  const video = h('video', {
    class: 'sh-video',
    src: item.src,
    playsinline: '',
    loop: '',
    preload: 'none',
    poster: item.cover || '',
  });
  video.muted = true;  // 首帧静音起播，符合浏览器自动播放策略

  let playing = false;
  let muted = true;
  let viewCounted = false;

  const muteBtn = h('button', { class: 'sh-side-btn', title: '声音' }, [
    h('span', { class: 'ic', text: '🔇' }),
    h('span', { class: 'lb', text: '静音' }),
  ]);
  muteBtn.onclick = () => {
    muted = !muted;
    video.muted = muted;
    muteBtn.querySelector('.ic').textContent = muted ? '🔇' : '🔊';
    muteBtn.querySelector('.lb').textContent = muted ? '静音' : '有声';
  };

  const likeBtn = h('button', { class: 'sh-side-btn' + (item.liked ? ' on' : ''), title: '点赞' }, [
    h('span', { class: 'ic', text: item.liked ? '❤️' : '🤍' }),
    h('span', { class: 'lb', text: fmtNum(item.likes || 0) }),
  ]);
  likeBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!auth.loggedIn) { toast('请先登录'); goReplace('/login?redirect=' + encodeURIComponent('#/shorts')); return; }
    try {
      const r = await api('/api/shorts/' + item.id + '/like', { method: 'POST' });
      likeBtn.classList.toggle('on', r.liked);
      likeBtn.querySelector('.ic').textContent = r.liked ? '❤️' : '🤍';
      likeBtn.querySelector('.lb').textContent = fmtNum(r.likes || 0);
      likeBtn.classList.add('pop');
      setTimeout(() => likeBtn.classList.remove('pop'), 320);
    } catch (err) { toast(err.message || '操作失败'); }
  };

  const cmtBtn = h('button', { class: 'sh-side-btn', title: '评论' }, [
    h('span', { class: 'ic', text: '💬' }),
    h('span', { class: 'lb', text: fmtNum(item.comments || 0) }),
  ]);
  cmtBtn.onclick = () => go('/shorts/detail/' + item.id);

  const moreBtn = h('button', { class: 'sh-side-btn', title: '更多' }, [
    h('span', { class: 'ic', text: '⋯' }),
    h('span', { class: 'lb', text: '更多' }),
  ]);
  moreBtn.onclick = async () => {
    if (!auth.loggedIn) { toast('请先登录'); return; }
    const mine = auth.user && auth.user.account === item.account;
    if (!mine) { toast('只能删除自己发布的视频'); return; }
    if (!confirm('确定删除这条视频？')) return;
    try {
      await api('/api/shorts/' + item.id, { method: 'DELETE' });
      toast('已删除', 'ok');
      const card = document.querySelector('.sh-card[data-id="' + item.id + '"]');
      if (card) card.remove();
    } catch (e) { toast(e.message || '删除失败'); }
  };

  const playIc = h('div', { class: 'sh-play-ic', html: '▶' });

  const card = h('div', { class: 'sh-card', 'data-id': item.id }, [
    video,
    playIc,
    h('div', { class: 'sh-overlay' }, [
      h('div', { class: 'sh-info' }, [
        h('div', { class: 'sh-author' }, [
          avatarEl({ nickname: item.author, avatar: item.authorAvatar }, 'sm'),
          h('span', { class: 'sh-name', text: item.author || item.account }),
          h('span', { class: 'sh-time', text: relTime(item.createdAt) }),
        ]),
        h('div', { class: 'sh-title', text: item.title || '' }),
        item.desc ? h('div', { class: 'sh-desc', text: item.desc }) : null,
        (item.tags || []).length
          ? h('div', { class: 'sh-tags' }, item.tags.map((t) => h('span', { class: 'sh-tag', text: '#' + t })))
          : null,
      ]),
      h('div', { class: 'sh-side' }, [
        avatarEl({ nickname: item.author, avatar: item.authorAvatar }, 'lg'),
        likeBtn,
        cmtBtn,
        muteBtn,
        moreBtn,
      ]),
      h('div', { class: 'sh-progress' }, [h('i')]),
    ]),
  ]);

  const bar = card.querySelector('.sh-progress i');
  video.addEventListener('timeupdate', () => {
    const d = video.duration || 0;
    if (d > 0) bar.style.width = ((video.currentTime / d) * 100).toFixed(2) + '%';
  });
  // 播放即计数（每个会话只计一次，避免刷新刷量）
  video.addEventListener('playing', () => {
    playing = true;
    card.classList.add('playing');
    if (!viewCounted) { viewCounted = true; try { api('/api/shorts/' + item.id); } catch {} }
  });
  video.addEventListener('pause', () => { playing = false; card.classList.remove('playing'); });
  video.addEventListener('error', () => {
    card.classList.add('err');
    playIc.innerHTML = '⚠';
  });

  // 点击画面 → 播放/暂停
  card.addEventListener('click', (e) => {
    if (e.target.closest('.sh-side') || e.target.closest('.sh-info')) return;
    if (video.paused) video.play().catch(() => {}); else video.pause();
  });

  card.play = () => {
    card.classList.add('on');
    video.play().catch(() => {
      // 自动播放被拦截 → 降级为静音再试
      video.muted = true; muted = true;
      muteBtn.querySelector('.ic').textContent = '🔇';
      video.play().catch(() => {});
    });
  };
  card.pause = () => {
    card.classList.remove('on');
    try { video.pause(); } catch {}
  };
  card.toggle = () => { if (video.paused) card.play(); else card.pause(); };
  card.destroy = () => {
    try { video.pause(); } catch {}
    video.removeAttribute('src');
    try { video.load(); } catch {}
  };
  card.querySelector('.sh-video')._playing = () => playing;

  return card;
}

/* ============================================================
   网格广场
   ============================================================ */
async function renderGrid(root) {
  root.appendChild(h('div', { class: 'page-head' }, [
    h('h1', { class: 'page-title', html: '<span>🎬</span> 短视频广场' }),
    h('p', { class: 'page-sub', text: '发现大家分享的精彩片段' }),
  ]));

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  // 工具栏：排序 + 发布
  const sortBar = h('div', { class: 'sh-toolbar' });
  const sorts = [
    { k: 'new', t: '🆕 最新' },
    { k: 'hot', t: '🔥 最热' },
    { k: 'like', t: '❤️ 最多赞' },
  ];
  let curSort = 'new';
  let page = 1;
  let hasMore = true;
  let loading = false;

  const grid = h('div', { class: 'sh-grid' });
  const moreBox = h('div', { class: 'sh-more' });

  const paintSort = () => {
    sortBar.innerHTML = '';
    sorts.forEach((s) => {
      sortBar.appendChild(h('button', {
        class: 'sh-sort' + (s.k === curSort ? ' on' : ''),
        text: s.t,
        onclick: () => { if (curSort === s.k) return; curSort = s.k; page = 1; hasMore = true; grid.innerHTML = ''; load(); },
      }));
    });
    sortBar.appendChild(h('div', { class: 'sh-toolbar-right' }, [
      h('button', { class: 'sh-fh-btn', text: '📱 刷视频', onclick: () => go('/shorts') }),
      auth.loggedIn
        ? h('button', { class: 'btn btn-primary btn-sm', html: '<span>＋</span> 发布视频', onclick: () => go('/shorts/upload') })
        : h('button', { class: 'btn btn-ghost btn-sm', text: '登录后发布', onclick: () => go('/login?redirect=' + encodeURIComponent('#/shorts/upload')) }),
    ]));
  };

  const load = async () => {
    if (loading || !hasMore) return;
    loading = true;
    moreBox.innerHTML = page === 1 ? '<div class="sh-grid-skl">' + '<i></i>'.repeat(8) + '</div>' : '<div class="sh-loading">加载中…</div>';
    try {
      const d = await api('/api/shorts?sort=' + curSort + '&page=' + page + '&size=18');
      const list = (d && d.list) || [];
      hasMore = !!d.hasMore;
      moreBox.innerHTML = '';
      if (!list.length && page === 1) {
        grid.innerHTML = '';
        box.appendChild(h('div', { class: 'empty-hint' }, [
          h('div', { class: 'ico', text: '🎬' }),
          h('div', { text: '还没有视频，来发布第一条吧' }),
        ]));
        return;
      }
      list.forEach((it) => grid.appendChild(gridCard(it)));
      page++;
      if (hasMore) moreBox.appendChild(h('button', { class: 'btn btn-ghost', text: '加载更多', onclick: () => load() }));
    } catch (e) {
      moreBox.innerHTML = '<div class="sh-loading">加载失败：' + esc(e.message) + '</div>';
    } finally { loading = false; }
  };

  box.append(sortBar, grid, moreBox);
  paintSort();
  load();
}

function gridCard(item) {
  return h('div', { class: 'sh-gcard', 'data-id': item.id, onclick: () => go('/shorts/detail/' + item.id) }, [
    h('div', { class: 'sh-gcover' }, [
      coverEl(item, 'sh-gimg'),
      item.duration ? h('span', { class: 'sh-gdur', text: fmtDur(item.duration) }) : null,
      h('span', { class: 'sh-gviews', text: '▶ ' + fmtNum(item.views || 0) }),
      item.status === 'pending' ? h('span', { class: 'sh-gpending', text: '审核中' }) : null,
    ]),
    h('div', { class: 'sh-gmeta' }, [
      h('div', { class: 'sh-gtitle', text: item.title || '' }),
      h('div', { class: 'sh-gsub' }, [
        h('span', { text: item.author || item.account }),
        h('span', { class: 'dot', text: '·' }),
        h('span', { text: relTime(item.createdAt) }),
      ]),
      h('div', { class: 'sh-gstat' }, [
        h('span', { text: '❤️ ' + fmtNum(item.likes || 0) }),
        h('span', { text: '💬 ' + fmtNum(item.comments || 0) }),
      ]),
    ]),
  ]);
}

/* ============================================================
   详情页（含评论）：#/shorts/detail/:id
   ============================================================ */
export async function renderShortDetail(root, id) {
  await auth.refresh();
  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');
  box.appendChild(h('div', { class: 'page-sub', text: '加载中…' }));

  let item;
  try {
    const d = await api('/api/shorts/' + id);
    item = d && d.short;
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(h('div', { class: 'empty-hint' }, [
      h('div', { class: 'ico', text: '😕' }),
      h('div', { text: '视频不存在或已删除' }),
      h('button', { class: 'btn btn-ghost btn-sm', text: '返回广场', onclick: () => go('/shorts?view=grid') }),
    ]));
    return;
  }
  box.innerHTML = '';

  const video = h('video', {
    class: 'sh-detail-video', src: item.src, controls: '', playsinline: '',
    poster: item.cover || '', preload: 'metadata',
  });

  const likeBtn = h('button', { class: 'sh-dact' + (item.liked ? ' on' : '') }, [
    h('span', { text: item.liked ? '❤️' : '🤍' }),
    h('span', { text: fmtNum(item.likes || 0) }),
  ]);
  likeBtn.onclick = async () => {
    if (!auth.loggedIn) { toast('请先登录'); goReplace('/login'); return; }
    try {
      const r = await api('/api/shorts/' + id + '/like', { method: 'POST' });
      likeBtn.classList.toggle('on', r.liked);
      likeBtn.firstChild.textContent = r.liked ? '❤️' : '🤍';
      likeBtn.lastChild.textContent = fmtNum(r.likes || 0);
    } catch (e) { toast(e.message || '操作失败'); }
  };

  const isMine = auth.user && auth.user.account === item.account;
  box.appendChild(h('div', { class: 'sh-detail' }, [
    h('div', { class: 'sh-detail-head' }, [
      h('button', { class: 'sh-back', html: '‹ 返回', onclick: () => goBackOrHome('/shorts?view=grid') }),
    ]),
    h('div', { class: 'sh-detail-body' }, [
      video,
      h('div', { class: 'sh-detail-side' }, [
        h('div', { class: 'sh-author' }, [
          avatarEl({ nickname: item.author, avatar: item.authorAvatar }, 'md'),
          h('div', {}, [
            h('div', { class: 'sh-name', text: item.author || item.account }),
            h('div', { class: 'sh-time', text: relTime(item.createdAt) + ' · ' + fmtNum(item.views || 0) + ' 次播放' }),
          ]),
        ]),
        h('h3', { class: 'sh-detail-title', text: item.title || '' }),
        item.desc ? h('p', { class: 'sh-detail-desc', text: item.desc }) : null,
        (item.tags || []).length
          ? h('div', { class: 'sh-tags' }, item.tags.map((t) => h('span', { class: 'sh-tag', text: '#' + t })))
          : null,
        h('div', { class: 'sh-detail-acts' }, [
          likeBtn,
          h('button', { class: 'sh-dact', onclick: () => go('/shorts?view=grid') }, [
            h('span', { text: '🎬' }), h('span', { text: '去广场' }),
          ]),
          isMine ? h('button', {
            class: 'sh-dact danger',
            onclick: async () => {
              if (!confirm('确定删除这条视频？')) return;
              try { await api('/api/shorts/' + id, { method: 'DELETE' }); toast('已删除', 'ok'); go('/shorts?view=grid'); }
              catch (e) { toast(e.message || '删除失败'); }
            },
          }, [h('span', { text: '🗑' }), h('span', { text: '删除' })]) : null,
        ]),
        h('div', { class: 'sh-comments', id: 'sh-comments' }, [
          h('div', { class: 'sh-cmt-title', text: '💬 评论' }),
        ]),
      ]),
    ]),
  ]));

  // 复用通用评论组件
  try {
    const { mountComments } = await import('./comments.js');
    mountComments(box.querySelector('#sh-comments'), { targetId: 'short:' + id, targetType: 'video' });
  } catch { /* 评论组件不可用时忽略 */ }
}

/* ============================================================
   上传页：#/shorts/upload
   ============================================================ */
export async function renderUploadPage(root) {
  await auth.refresh();
  if (!auth.loggedIn) {
    goReplace('/login?redirect=' + encodeURIComponent('#/shorts/upload'));
    return;
  }

  root.appendChild(h('div', { class: 'page-head' }, [
    h('h1', { class: 'page-title', html: '<span>📤</span> 发布视频' }),
    h('p', { class: 'page-sub', text: '支持 MP4 / WebM / MOV 等常见格式，建议竖屏 9:16' }),
  ]));

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  const fileInput = h('input', { type: 'file', accept: 'video/*', style: { display: 'none' } });
  const dropZone = h('div', { class: 'sh-drop' }, [
    h('div', { class: 'sh-drop-ico', text: '🎥' }),
    h('div', { class: 'sh-drop-t', text: '点击选择视频，或拖拽到此处' }),
    h('div', { class: 'sh-drop-s', text: '单个文件建议不超过 200MB' }),
  ]);

  let picked = null;
  const previewBox = h('div', { class: 'sh-preview' });
  const progressBox = h('div', { class: 'sh-progress-box' });

  const setFile = (f) => {
    if (!f) return;
    if (!/^video\//.test(f.type) && !/\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(f.name)) {
      toast('请选择视频文件');
      return;
    }
    picked = f;
    previewBox.innerHTML = '';
    const v = h('video', { src: URL.createObjectURL(f), controls: '', playsinline: '', class: 'sh-preview-video' });
    previewBox.appendChild(v);
    previewBox.appendChild(h('div', { class: 'sh-preview-name' }, [
      h('span', { text: '📎 ' + f.name }),
      h('span', { class: 'sz', text: (f.size / 1048576).toFixed(1) + ' MB' }),
    ]));
    dropZone.classList.add('has-file');
    dropZone.querySelector('.sh-drop-t').textContent = f.name;
  };

  dropZone.onclick = () => fileInput.click();
  fileInput.onchange = () => setFile(fileInput.files[0]);
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    setFile(e.dataTransfer.files[0]);
  });

  const titleIn = h('input', { class: 'sh-input', placeholder: '给视频起个标题（必填，最多 80 字）', maxlength: '80' });
  const descIn = h('textarea', { class: 'sh-input', rows: '3', placeholder: '补充说明（选填，最多 500 字）', maxlength: '500' });
  const tagsIn = h('input', { class: 'sh-input', placeholder: '标签，用空格或逗号分隔（选填，最多 8 个）' });

  const submitBtn = h('button', { class: 'btn btn-primary', text: '发布', disabled: '' });

  const doSubmit = () => {
    if (!picked) { toast('请先选择视频文件'); return; }
    const title = titleIn.value.trim();
    if (!title) { toast('请填写标题'); titleIn.focus(); return; }

    const fd = new FormData();
    fd.append('video', picked);
    fd.append('title', title);
    fd.append('desc', descIn.value.trim());
    fd.append('tags', tagsIn.value.trim());

    const xhr = new XMLHttpRequest();
    const bar = h('i');
    progressBox.innerHTML = '';
    progressBox.appendChild(h('div', { class: 'sh-prog-row' }, [
      h('div', { class: 'sh-prog-bar' }, [bar]),
      h('div', { class: 'sh-prog-txt', text: '准备上传…' }),
    ]));

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = pct + '%';
      progressBox.querySelector('.sh-prog-txt').textContent = '上传中 ' + pct + '%（' + (e.loaded / 1048576).toFixed(1) + ' MB）';
    };
    xhr.upload.onload = () => {
      bar.style.width = '100%';
      progressBox.querySelector('.sh-prog-txt').textContent = '上传完成，正在校验…';
    };
    xhr.onload = () => {
      let d = {};
      try { d = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        progressBox.querySelector('.sh-prog-txt').textContent = '✅ 发布成功！' + (d.short && d.short.status === 'pending' ? '（等待审核后展示）' : '');
        toast('发布成功', 'ok');
        setTimeout(() => go('/shorts?view=grid'), 900);
      } else {
        progressBox.querySelector('.sh-prog-txt').textContent = '❌ ' + (d.error || ('HTTP ' + xhr.status));
        toast(d.error || '发布失败');
        submitBtn.disabled = false; submitBtn.textContent = '发布';
      }
    };
    xhr.onerror = () => {
      progressBox.querySelector('.sh-prog-txt').textContent = '❌ 网络异常，请重试';
      submitBtn.disabled = false; submitBtn.textContent = '发布';
    };

    submitBtn.disabled = true; submitBtn.textContent = '上传中…';
    xhr.open('POST', '/api/shorts/upload');
    xhr.send(fd);
  };
  submitBtn.onclick = doSubmit;

  box.appendChild(h('div', { class: 'card sh-upload' }, [
    dropZone,
    fileInput,
    previewBox,
    h('div', { class: 'sh-form' }, [
      h('label', { class: 'sh-lb', text: '标题' }), titleIn,
      h('label', { class: 'sh-lb', text: '说明' }), descIn,
      h('label', { class: 'sh-lb', text: '标签' }), tagsIn,
    ]),
    h('div', { class: 'sh-upload-foot' }, [
      h('div', { class: 'sh-tip', text: '⚠️ 请勿上传违法违规、侵权或含广告的内容' }),
      submitBtn,
    ]),
    progressBox,
  ]));
}
