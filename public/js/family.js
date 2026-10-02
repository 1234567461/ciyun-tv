/* ============================================================
   慈云影视 · 家庭共享页面
   1 户主 + 最多 5 名成员 · 会员权益共享
   ============================================================ */

import { h, api, toast, relTime } from './util.js';
import { auth, avatarEl } from './auth.js';

export function renderFamilyPage(root, site) {
  const cfg = (site && site.family) || {};
  const main = h('div', { class: 'main' }, [h('div', { class: 'container profile-page' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  box.appendChild(
    h('div', { class: 'page-head' }, [
      h('h1', { class: 'page-title', html: '<span>👨‍👩‍👧‍👦</span> 家庭共享' }),
      h('p', { class: 'page-sub', text: `1 位户主 + 最多 ${cfg.maxMembers || 5} 位成员，共享会员权益，多设备同时观看` }),
    ])
  );

  const panel = h('div', { class: 'family-panel' });
  box.appendChild(panel);
  load();

  async function load() {
    panel.innerHTML = '';
    let info;
    try {
      info = await api('/api/family/info');
    } catch (e) {
      panel.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
      return;
    }

    if (info.enabled === false) {
      panel.appendChild(notice('🚧', '家庭功能暂未开放', '管理员已关闭该模块'));
      return;
    }

    if (!auth.loggedIn) {
      panel.appendChild(
        notice('🔒', '登录后使用家庭共享', '登录即可创建或加入家庭', [
          h('a', { class: 'btn btn-primary', href: '#/login?redirect=' + encodeURIComponent('#/family'), text: '登录 / 注册' }),
        ])
      );
      return;
    }

    if (!info.family) renderNoFamily(info);
    else renderFamily(info);
  }

  /* ----------------- 无家庭：创建或加入 ----------------- */
  function renderNoFamily(info) {
    const isVip = !!(auth.user && auth.user.vip && auth.user.vip.expire > Date.now());

    const createCard = h('div', { class: 'fam-card' }, [
      h('div', { class: 'fam-ico', text: '🏠' }),
      h('h3', { text: '创建我的家庭' }),
      h('p', { text: `成为户主，邀请最多 ${info.maxMembers} 位家人／朋友，共享会员权益与观看记录。` }),
      info.requireVip && !isVip
        ? h('div', { class: 'fam-warn', text: '⚠ 创建家庭需先开通会员' })
        : null,
      h('button', {
        class: 'btn btn-primary btn-block',
        text: info.requireVip && !isVip ? '去开通会员' : '创建家庭',
        onclick: () => (info.requireVip && !isVip ? go('/profile?tab=vip') : doCreate()),
      }),
    ]);

    const joinCard = h('div', { class: 'fam-card' }, [
      h('div', { class: 'fam-ico', text: '🎟️' }),
      h('h3', { text: '加入家庭' }),
      h('p', { text: '输入户主分享的邀请码，即可加入并共享权益。' }),
      h('div', { class: 'input-wrap', style: { marginBottom: '14px' } }, [
        (() => {
          const inp = h('input', { placeholder: '粘贴邀请码（如 A1B2C3D4）', style: { textTransform: 'uppercase', letterSpacing: '2px' } });
          joinCard._inp = inp;
          inp.onkeydown = (e) => { if (e.key === 'Enter') doJoin(inp.value); };
          return inp;
        })(),
      ]),
      h('button', {
        class: 'btn btn-ghost btn-block',
        text: '加入家庭',
        onclick: () => doJoin(joinCard._inp ? joinCard._inp.value : ''),
      }),
    ]);

    panel.appendChild(h('div', { class: 'fam-grid' }, [createCard, joinCard]));
  }

  async function doCreate() {
    try {
      await api('/api/family/create', { method: 'POST', body: { name: (auth.user.nickname || auth.user.account) + ' 的家庭' } });
      toast('家庭创建成功', 'success');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function doJoin(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return toast('请输入邀请码', 'error');
    try {
      await api('/api/family/join', { method: 'POST', body: { code: c } });
      toast('已加入家庭', 'success');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ----------------- 已有家庭 ----------------- */
  function renderFamily(info) {
    const fam = info.family;
    const isOwner = fam.isOwner;
    const max = fam.maxMembers || info.maxMembers || 5;
    const used = fam.count;

    // 头部
    const ownerChip = h('div', { class: 'fam-owner' }, [
      avatarEl({ nickname: fam.ownerNickname, avatar: fam.ownerAvatar }, 'lg'),
      h('div', {}, [
        h('div', { class: 'n', text: fam.name }),
        h('div', { class: 'a', text: '户主：' + fam.ownerNickname + (fam.ownerVip ? ' · 💎 会员' : '') }),
      ]),
      isOwner ? h('span', { class: 'cm-badge me', text: '我是户主' }) : h('span', { class: 'cm-badge', text: '成员' }),
    ]);

    panel.appendChild(
      h('div', { class: 'fam-head' }, [
        ownerChip,
        h('div', { class: 'fam-slots' }, [
          h('div', { class: 'slot-txt', text: `成员席位 ${used} / ${max}` }),
          h('div', { class: 'slot-bar' }, [h('i', { style: { width: (used / max) * 100 + '%' } })]),
        ]),
      ])
    );

    // 成员列表
    const membersWrap = h('div', { class: 'fam-members' });
    panel.appendChild(h('h3', { class: 'fam-sec', text: '👥 家庭成员' }));

    // 户主
    membersWrap.appendChild(memberRow({
      nickname: fam.ownerNickname, avatar: fam.ownerAvatar, account: fam.owner,
      isOwner: true, joinedAt: fam.createdAt,
    }, isOwner));

    fam.members.forEach((m) => membersWrap.appendChild(memberRow({ ...m, isOwner: false }, isOwner)));
    if (!fam.members.length) {
      membersWrap.appendChild(h('div', { class: 'fam-empty', text: '还没有成员，生成邀请码邀请家人加入吧' }));
    }
    panel.appendChild(membersWrap);

    // 邀请区（仅户主）
    if (isOwner) {
      const inviteBox = h('div', { class: 'fam-invite' });
      panel.appendChild(h('h3', { class: 'fam-sec', text: '🎟️ 邀请成员' }));
      panel.appendChild(inviteBox);
      renderInvites(inviteBox, info, max, used);
    } else {
      panel.appendChild(
        h('div', { class: 'fam-hint', text: '只有户主可以邀请新成员。如需退出家庭，请点击下方按钮。' })
      );
    }

    // 操作
    const acts = h('div', { class: 'fam-acts' });
    if (isOwner) {
      acts.appendChild(h('button', {
        class: 'btn btn-ghost btn-sm', text: '✏️ 重命名家庭',
        onclick: async () => {
          const n = prompt('新的家庭名称', fam.name);
          if (!n || !n.trim()) return;
          try { await api('/api/family', { method: 'PUT', body: { name: n.trim() } }); toast('已更新', 'success'); load(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }));
      acts.appendChild(h('button', {
        class: 'btn btn-danger btn-sm', text: '解散家庭',
        onclick: async () => {
          if (!confirm('确定解散家庭？所有成员将被移出。')) return;
          try { await api('/api/family', { method: 'DELETE' }); toast('已解散', 'success'); load(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }));
    } else {
      acts.appendChild(h('button', {
        class: 'btn btn-danger btn-sm', text: '退出家庭',
        onclick: async () => {
          if (!confirm('确定退出该家庭？')) return;
          try { await api('/api/family/member/' + encodeURIComponent(auth.user.account), { method: 'DELETE' }); toast('已退出', 'success'); load(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }));
    }
    panel.appendChild(acts);
  }

  function memberRow(m, isOwnerActor) {
    return h('div', { class: 'fam-member' }, [
      avatarEl({ nickname: m.nickname, avatar: m.avatar }),
      h('div', { class: 'mi' }, [
        h('div', { class: 'mn' }, [
          m.nickname || m.account,
          m.isOwner ? h('span', { class: 'cm-badge', text: '户主' }) : null,
        ]),
        h('div', { class: 'ma', text: '@' + m.account + (m.joinedAt ? ' · ' + relTime(m.joinedAt) + '加入' : '') }),
      ]),
      isOwnerActor && !m.isOwner
        ? h('button', {
            class: 'btn btn-ghost btn-sm', text: '移出',
            onclick: async () => {
              if (!confirm('移出该成员？')) return;
              try { await api('/api/family/member/' + encodeURIComponent(m.account), { method: 'DELETE' }); toast('已移出', 'success'); load(); }
              catch (e) { toast(e.message, 'error'); }
            },
          })
        : null,
    ]);
  }

  async function renderInvites(box, info, max, used) {
    box.innerHTML = '';
    if (used >= max) {
      box.appendChild(h('div', { class: 'fam-hint', text: `成员已满（${max} 人），无法继续邀请。` }));
      return;
    }
    let invites = [];
    try { invites = (await api('/api/family/invites')).invites || []; } catch {}

    const linkRow = h('div', { class: 'inv-link' });
    invites.forEach((inv) => {
      linkRow.appendChild(
        h('div', { class: 'inv-item' }, [
          h('code', { class: 'inv-code', text: inv.code }),
          h('div', { class: 'inv-exp', text: '有效期至 ' + new Date(inv.expire).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
          h('div', { class: 'inv-btns' }, [
            h('button', {
              class: 'btn btn-ghost btn-sm', text: '📋 复制',
              onclick: () => {
                const url = location.origin + location.pathname + '#/join?code=' + inv.code;
                navigator.clipboard ? navigator.clipboard.writeText(inv.code) : null;
                toast('邀请码已复制：' + inv.code, 'success');
              },
            }),
            h('button', {
              class: 'btn btn-danger btn-sm', text: '作废',
              onclick: async () => {
                try { await api('/api/family/invite/' + inv.code, { method: 'DELETE' }); toast('已作废', 'success'); load(); }
                catch (e) { toast(e.message, 'error'); }
              },
            }),
          ]),
        ])
      );
    });
    if (!invites.length) linkRow.appendChild(h('div', { class: 'fam-empty', text: '暂无有效邀请码' }));

    box.append(
      linkRow,
      h('button', {
        class: 'btn btn-primary', text: '＋ 生成邀请码',
        onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await api('/api/family/invite', { method: 'POST', body: { days: 3 } }); toast('邀请码：' + r.code, 'success'); load(); }
          catch (err) { toast(err.message, 'error'); }
          e.target.disabled = false;
        },
      })
    );
  }

  function notice(ico, title, sub, actions) {
    return h('div', { class: 'fam-notice' }, [
      h('div', { class: 'fam-ico lg', text: ico }),
      h('h3', { text: title }),
      h('p', { text: sub }),
      actions ? h('div', { class: 'fam-notice-acts' }, actions) : null,
    ]);
  }
}
