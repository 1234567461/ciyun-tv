/* ============================================================
   慈云影视 · 社交（加好友 / 私信）
   ============================================================ */

import { h, api, go, goReplace, toast, esc } from './util.js';
import { auth, avatarEl } from './auth.js';

/** 相对时间 */
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

function clockTime(ts) {
  const d = new Date(ts);
  const H = String(d.getHours()).padStart(2, '0');
  const M = String(d.getMinutes()).padStart(2, '0');
  return H + ':' + M;
}

/** 小头像（带在线点） */
function miniAvatar(user, online) {
  const el = h('div', { class: 'soc-av' });
  if (user.avatar) {
    el.appendChild(h('img', { src: user.avatar, alt: user.nickname || user.account }));
  } else {
    const name = String(user.nickname || user.account || '?');
    const colors = ['#e50914', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    el.style.background = colors[hash % colors.length];
    el.appendChild(h('span', { text: name.slice(0, 1).toUpperCase() }));
  }
  if (online) el.appendChild(h('i', { class: 'soc-on' }));
  return el;
}

/* ============================================================
   社交主页面：#/social
   ------------------------------------------------------------
   左侧会话/好友列表，右侧聊天窗口（移动端为两级导航）
   ============================================================ */
export async function renderSocialPage(root, tab) {
  if (!auth.loggedIn) {
    goReplace('/login?redirect=' + encodeURIComponent('#/social'));
    return;
  }
  await auth.refresh();

  const main = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');
  box.appendChild(h('div', { class: 'page-sub', style: { padding: '10px 0' }, text: '加载中…' }));

  let summary = { friends: 0, requests: 0, unread: 0 };
  try {
    summary = await api('/api/social/summary');
  } catch (e) {
    if (String(e.message).includes('关闭')) {
      box.innerHTML = '';
      box.appendChild(h('div', { class: 'error-box', text: '本站已关闭社交功能' }));
      return;
    }
  }

  const curTab = tab || 'messages'; // messages | friends | requests | search
  const peer = new URLSearchParams(location.hash.split('?')[1] || '').get('to') || '';

  box.innerHTML = '';

  /* ---------- 顶部标签 ---------- */
  const tabs = [
    { id: 'messages', text: '私信', badge: summary.unread },
    { id: 'friends', text: '好友', badge: summary.friends },
    { id: 'requests', text: '申请', badge: summary.requests },
    { id: 'search', text: '加好友' },
  ];
  box.appendChild(
    h('div', { class: 'soc-tabs' },
      tabs.map((t) =>
        h('button', {
          class: 'soc-tab' + (t.id === curTab ? ' on' : ''),
          onclick: () => go('/social?tab=' + t.id),
        }, [
          h('span', { text: t.text }),
          t.badge ? h('em', { class: 'soc-badge', text: String(t.badge) }) : null,
        ])
      )
    )
  );

  const pane = h('div', { class: 'soc-pane' });
  box.appendChild(pane);

  if (curTab === 'messages') return renderMessages(pane, peer);
  if (curTab === 'friends') return renderFriends(pane);
  if (curTab === 'requests') return renderRequests(pane);
  return renderSearch(pane);
}

/* ============================================================
   私信
   ============================================================ */
async function renderMessages(pane, peer) {
  let convs = [];
  try {
    const d = await api('/api/social/conversations');
    convs = d.list || [];
  } catch (e) {
    pane.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
    return;
  }

  const wrap = h('div', { class: 'soc-chat' });
  const sideList = h('div', { class: 'soc-side' });
  const chatBox = h('div', { class: 'soc-chatbox' });
  wrap.append(sideList, chatBox);
  pane.appendChild(wrap);

  if (!convs.length) {
    sideList.appendChild(
      h('div', { class: 'soc-empty' }, [
        h('div', { class: 'ico', text: '💬' }),
        h('div', { text: '还没有好友' }),
        h('button', { class: 'btn btn-primary btn-sm', text: '去加好友', onclick: () => go('/social?tab=search') }),
      ])
    );
    chatBox.appendChild(h('div', { class: 'soc-hint', text: '添加好友后即可私信聊天' }));
    return;
  }

  const openConv = (acc) => {
    [...sideList.querySelectorAll('.soc-conv')].forEach((el) => el.classList.toggle('on', el.dataset.acc === acc));
    wrap.classList.add('has-open');
    loadChat(chatBox, acc, () => renderMessages(pane, acc));
  };

  convs.forEach((c) => {
    const last = c.last;
    const el = h('div', {
      class: 'soc-conv' + (peer === c.account ? ' on' : ''),
      dataset: { acc: c.account },
      onclick: () => openConv(c.account),
    }, [
      miniAvatar(c, c.online),
      h('div', { class: 'soc-conv-main' }, [
        h('div', { class: 'soc-conv-top' }, [
          h('span', { class: 'nm', text: c.nickname }),
          h('span', { class: 'tm', text: last ? relTime(last.at) : '' }),
        ]),
        h('div', { class: 'soc-conv-sub' }, [
          h('span', { class: 'ms', text: last ? (last.from === auth.user.account ? '我：' : '') + last.text : '暂无消息' }),
          c.unread ? h('em', { class: 'soc-badge', text: String(c.unread) }) : null,
        ]),
      ]),
    ]);
    sideList.appendChild(el);
  });

  // 默认打开第一个，或 URL 指定的联系人
  const target = peer && convs.find((c) => c.account === peer) ? peer : convs[0].account;
  openConv(target);
}

/** 加载某人的聊天窗口 */
async function loadChat(chatBox, acc, onBack) {
  chatBox.innerHTML = '';
  chatBox.appendChild(h('div', { class: 'soc-hint', text: '加载中…' }));

  let data;
  try {
    data = await api('/api/social/messages/' + encodeURIComponent(acc));
  } catch (e) {
    chatBox.innerHTML = '';
    chatBox.appendChild(h('div', { class: 'error-box', text: e.message }));
    return;
  }

  const me = auth.user.account;
  const list = data.list || [];
  chatBox.innerHTML = '';

  /* 头部 */
  chatBox.appendChild(
    h('div', { class: 'soc-chead' }, [
      h('button', { class: 'soc-back', text: '‹', title: '返回', onclick: onBack }),
      miniAvatar(data.peer || { account: acc }, false),
      h('div', {}, [
        h('div', { class: 'nm', text: (data.peer && data.peer.nickname) || acc }),
        h('div', { class: 'sub', text: (data.peer && data.peer.vip) ? 'VIP 会员' : '普通用户' }),
      ]),
    ])
  );

  /* 消息区 */
  const body = h('div', { class: 'soc-msgs' });
  if (!list.length) {
    body.appendChild(h('div', { class: 'soc-hint', text: '还没有消息，打个招呼吧 👋' }));
  }
  list.forEach((m) => {
    const mine = m.from === me;
    body.appendChild(
      h('div', { class: 'soc-msg' + (mine ? ' mine' : '') }, [
        h('div', { class: 'bubble', text: m.text }),
        h('div', { class: 'mt', text: clockTime(m.at) }),
      ])
    );
  });
  chatBox.appendChild(body);
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });

  /* 输入区 */
  const input = h('input', { class: 'soc-input', placeholder: '输入消息…', maxlength: '2000' });
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const r = await api('/api/social/messages', { method: 'POST', body: { to: acc, text } });
      const mine = r.message;
      body.appendChild(
        h('div', { class: 'soc-msg mine' }, [
          h('div', { class: 'bubble', text: mine.text }),
          h('div', { class: 'mt', text: clockTime(mine.at) }),
        ])
      );
      body.scrollTop = body.scrollHeight;
    } catch (e) {
      toast(e.message, 'error');
      input.value = text;
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  chatBox.appendChild(
    h('div', { class: 'soc-cfoot' }, [
      input,
      h('button', { class: 'btn btn-primary btn-sm', text: '发送', onclick: send }),
    ])
  );
}

/* ============================================================
   好友列表
   ============================================================ */
async function renderFriends(pane) {
  let list = [];
  try {
    const d = await api('/api/social/friends');
    list = d.list || [];
  } catch (e) {
    pane.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
    return;
  }

  if (!list.length) {
    pane.appendChild(
      h('div', { class: 'soc-empty' }, [
        h('div', { class: 'ico', text: '👥' }),
        h('div', { text: '还没有好友' }),
        h('button', { class: 'btn btn-primary btn-sm', text: '去加好友', onclick: () => go('/social?tab=search') }),
      ])
    );
    return;
  }

  const grid = h('div', { class: 'soc-friends' });
  list.forEach((u) => {
    grid.appendChild(
      h('div', { class: 'soc-fcard' }, [
        miniAvatar(u, u.online),
        h('div', { class: 'info' }, [
          h('div', { class: 'nm' }, [
            h('span', { text: u.nickname }),
            u.vip ? h('span', { class: 'tag tag-primary', text: 'VIP' }) : null,
          ]),
          h('div', { class: 'sub', text: '@' + u.account + (u.online ? ' · 在线' : '') }),
        ]),
        h('div', { class: 'acts' }, [
          h('button', {
            class: 'btn btn-primary btn-sm',
            text: '私信',
            onclick: () => go('/social?tab=messages&to=' + encodeURIComponent(u.account)),
          }),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            text: '解除',
            onclick: async () => {
              if (!confirm('确定解除与 ' + u.nickname + ' 的好友关系？')) return;
              try {
                await api('/api/social/remove', { method: 'POST', body: { account: u.account } });
                toast('已解除好友关系', 'success');
                go('/social?tab=friends');
              } catch (e) { toast(e.message, 'error'); }
            },
          }),
        ]),
      ])
    );
  });
  pane.appendChild(grid);
}

/* ============================================================
   好友申请
   ============================================================ */
async function renderRequests(pane) {
  let d;
  try {
    d = await api('/api/social/requests');
  } catch (e) {
    pane.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
    return;
  }
  const received = d.received || [];
  const sent = d.sent || [];

  if (!received.length && !sent.length) {
    pane.appendChild(
      h('div', { class: 'soc-empty' }, [
        h('div', { class: 'ico', text: '📭' }),
        h('div', { text: '暂无好友申请' }),
      ])
    );
    return;
  }

  const section = (title, list, isReceived) => {
    if (!list.length) return null;
    const box = h('div', { class: 'soc-req-box' }, [h('h3', { text: title })]);
    list.forEach((u) => {
      box.appendChild(
        h('div', { class: 'soc-req' }, [
          miniAvatar(u, false),
          h('div', { class: 'info' }, [
            h('div', { class: 'nm', text: u.nickname }),
            h('div', { class: 'sub', text: '@' + u.account + ' · ' + relTime(u.at) }),
          ]),
          h('div', { class: 'acts' }, isReceived ? [
            h('button', {
              class: 'btn btn-primary btn-sm', text: '接受',
              onclick: async (e) => {
                e.target.disabled = true;
                try {
                  await api('/api/social/accept', { method: 'POST', body: { account: u.account } });
                  toast('已添加为好友', 'success');
                  go('/social?tab=friends');
                } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
              },
            }),
            h('button', {
              class: 'btn btn-ghost btn-sm', text: '拒绝',
              onclick: async () => {
                try {
                  await api('/api/social/remove', { method: 'POST', body: { account: u.account } });
                  toast('已拒绝', 'info');
                  go('/social?tab=requests');
                } catch (err) { toast(err.message, 'error'); }
              },
            }),
          ] : [
            h('span', { class: 'soc-pending', text: '等待对方确认' }),
            h('button', {
              class: 'btn btn-ghost btn-sm', text: '撤回',
              onclick: async () => {
                try {
                  await api('/api/social/remove', { method: 'POST', body: { account: u.account } });
                  toast('已撤回申请', 'info');
                  go('/social?tab=requests');
                } catch (err) { toast(err.message, 'error'); }
              },
            }),
          ]),
        ])
      );
    });
    return box;
  };

  const a = section('收到的申请', received, true);
  const b = section('我发出的申请', sent, false);
  if (a) pane.appendChild(a);
  if (b) pane.appendChild(b);
}

/* ============================================================
   搜索加好友
   ============================================================ */
function renderSearch(pane) {
  const input = h('input', { class: 'soc-input', placeholder: '输入账号或昵称搜索…' });
  const results = h('div', { class: 'soc-results' });

  pane.appendChild(h('div', { class: 'soc-searchbar' }, [
    input,
    h('button', { class: 'btn btn-primary btn-sm', text: '搜索', onclick: doSearch }),
  ]));
  pane.appendChild(results);

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(doSearch, 350);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  async function doSearch() {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = '';
    results.appendChild(h('div', { class: 'soc-hint', text: '搜索中…' }));
    try {
      const d = await api('/api/social/search?q=' + encodeURIComponent(q));
      const list = d.list || [];
      results.innerHTML = '';
      if (!list.length) {
        results.appendChild(h('div', { class: 'soc-hint', text: '没有找到相关用户' }));
        return;
      }
      list.forEach((u) => {
        const acts = h('div', { class: 'acts' });
        if (u.relation === 'friend') {
          acts.appendChild(h('button', {
            class: 'btn btn-primary btn-sm', text: '私信',
            onclick: () => go('/social?tab=messages&to=' + encodeURIComponent(u.account)),
          }));
        } else if (u.relation === 'sent') {
          acts.appendChild(h('span', { class: 'soc-pending', text: '已申请' }));
        } else if (u.relation === 'received') {
          acts.appendChild(h('button', {
            class: 'btn btn-primary btn-sm', text: '接受申请',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await api('/api/social/accept', { method: 'POST', body: { account: u.account } });
                toast('已添加为好友', 'success');
                doSearch();
              } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
            },
          }));
        } else {
          acts.appendChild(h('button', {
            class: 'btn btn-primary btn-sm', text: '加好友',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                const r = await api('/api/social/request', { method: 'POST', body: { account: u.account } });
                toast(r.message || '已发送申请', 'success');
                e.target.textContent = r.status === 'accepted' ? '已是好友' : '已申请';
              } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
            },
          }));
        }
        results.appendChild(
          h('div', { class: 'soc-req' }, [
            miniAvatar(u, false),
            h('div', { class: 'info' }, [
              h('div', { class: 'nm' }, [
                h('span', { text: u.nickname }),
                u.vip ? h('span', { class: 'tag tag-primary', text: 'VIP' }) : null,
              ]),
              h('div', { class: 'sub', text: '@' + u.account }),
            ]),
            acts,
          ])
        );
      });
    } catch (e) {
      results.innerHTML = '';
      results.appendChild(h('div', { class: 'error-box', text: '搜索失败：' + e.message }));
    }
  }
}
