/* ============================================================
   慈云影视 · 家庭共享页面
   角色权限 + 设备管理 + 额度池 + 邀请审核
   对标 Emby / Jellyfin / Plex 家庭方案
   ============================================================ */

import { h, api, toast, relTime } from './util.js';
import { auth, avatarEl } from './auth.js';

const ROLE_ICON = { owner: '👑', admin: '🛡️', member: '👤', child: '🧸', guest: '🎫' };

export function renderFamilyPage(root, site) {
  const cfg = (site && site.family) || {};
  const main = h('div', { class: 'main' }, [h('div', { class: 'container profile-page' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  box.appendChild(
    h('div', { class: 'page-head' }, [
      h('h1', { class: 'page-title', html: '<span>👨‍👩‍👧‍👦</span> 家庭共享' }),
      h('p', { class: 'page-sub', text: `1 位户主 + 最多 ${cfg.maxMembers || 5} 位成员 · 多角色权限 · 多设备并发 · 额度共享` }),
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
      h('p', { text: `成为户主，邀请最多 ${info.maxMembers} 位家人／朋友。可分配儿童/访客角色、限制设备数与并发流、共享额度池。` }),
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

    // 角色说明
    if (Array.isArray(info.roles) && info.roles.length) {
      panel.appendChild(h('h3', { class: 'fam-sec', text: '🎭 家庭角色权限一览' }));
      panel.appendChild(roleMatrix(info.roles));
    }
  }

  /** 角色权限矩阵（对标 Jellyfin 用户策略 / Emby 用户权限） */
  function roleMatrix(roles) {
    const COLS = [
      ['watch', '观看'], ['hd', '超清'], ['download', '下载'],
      ['comment', '评论'], ['invite', '邀请'], ['manage', '管理'], ['shareQuota', '共享额度'],
    ];
    return h('div', { class: 'role-matrix' }, [
      h('div', { class: 'rm-head' }, [
        h('div', { class: 'rm-c rm-name', text: '角色' }),
        ...COLS.map(([, label]) => h('div', { class: 'rm-c', text: label })),
      ]),
      ...roles.map((r) => h('div', { class: 'rm-row' }, [
        h('div', { class: 'rm-c rm-name' }, [
          h('span', { text: (ROLE_ICON[r.id] || '👤') + ' ' + r.name }),
        ]),
        ...COLS.map(([k]) => h('div', { class: 'rm-c' }, [
          h('span', { class: r.perms[k] ? 'rm-y' : 'rm-n', text: r.perms[k] ? '✓' : '—' }),
        ])),
      ])),
    ]);
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
      const r = await api('/api/family/join', {
        method: 'POST',
        body: { code: c, deviceId: deviceId(), deviceName: deviceName() },
      });
      toast(r.message || '已加入家庭', 'success');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ----------------- 已有家庭 ----------------- */
  function renderFamily(info) {
    const fam = info.family;
    const isOwner = fam.isOwner;
    const canManage = !!(info.perms && info.perms.manage);
    const max = fam.maxMembers || info.maxMembers || 5;
    const used = fam.count;
    const active = (fam.members || []).filter((m) => !m.pending);
    const pending = (fam.members || []).filter((m) => m.pending);

    // 头部
    const ownerChip = h('div', { class: 'fam-owner' }, [
      avatarEl({ nickname: fam.ownerNickname, avatar: fam.ownerAvatar }, 'lg'),
      h('div', {}, [
        h('div', { class: 'n', text: fam.name }),
        h('div', { class: 'a', text: '户主：' + fam.ownerNickname + (fam.ownerVip ? ' · 💎 会员' : '') }),
      ]),
      h('span', { class: 'cm-badge ' + (isOwner ? 'me' : ''), text: (ROLE_ICON[fam.role] || '👤') + ' ' + (fam.roleName || '成员') }),
    ]);

    panel.appendChild(
      h('div', { class: 'fam-head' }, [
        ownerChip,
        h('div', { class: 'fam-slots' }, [
          h('div', { class: 'slot-txt', text: `成员席位 ${used} / ${max}` + (fam.pending ? ` · ${fam.pending} 待审核` : '') }),
          h('div', { class: 'slot-bar' }, [h('i', { style: { width: Math.min(100, (used / max) * 100) + '%' } })]),
        ]),
      ])
    );

    // 权限概览卡
    panel.appendChild(h('div', { class: 'fam-stat-row' }, [
      statCell('🎬', '并发流上限', (info.maxStreams > 0 ? info.maxStreams + ' 路' : '不限'), info.streamPolicy === 'block' ? '超额拒绝' : '顶掉最早'),
      statCell('📱', '设备数上限', (info.deviceLimit > 0 ? info.deviceLimit + ' 台' : '不限'), '每成员'),
      statCell('🎫', '共享额度池', fam.poolRemain === -1 ? '∞' : String(fam.poolRemain), `已用 ${fam.poolUsed}`),
      statCell('🔐', '内容分级', info.childMaxRating || 'PG13', info.parentalEnabled ? '已启用' : '已关闭'),
    ]));

    // 待审核
    if (pending.length && canManage) {
      panel.appendChild(h('h3', { class: 'fam-sec', text: `⏳ 待审核申请（${pending.length}）` }));
      const pw = h('div', { class: 'fam-members' });
      pending.forEach((m) => pw.appendChild(memberRow(m, canManage, true)));
      panel.appendChild(pw);
    }

    // 成员列表
    const membersWrap = h('div', { class: 'fam-members' });
    panel.appendChild(h('h3', { class: 'fam-sec', text: '👥 家庭成员' }));

    membersWrap.appendChild(memberRow({
      nickname: fam.ownerNickname, avatar: fam.ownerAvatar, account: fam.owner,
      isOwner: true, role: 'owner', roleName: '户主', joinedAt: fam.createdAt,
    }, false));
    active.forEach((m) => membersWrap.appendChild(memberRow({ ...m, isOwner: false }, canManage)));
    if (!active.length) {
      membersWrap.appendChild(h('div', { class: 'fam-empty', text: '还没有成员，生成邀请码邀请家人加入吧' }));
    }
    panel.appendChild(membersWrap);

    // 邀请区
    if (canManage) {
      const inviteBox = h('div', { class: 'fam-invite' });
      panel.appendChild(h('h3', { class: 'fam-sec', text: '🎟️ 邀请成员' }));
      panel.appendChild(inviteBox);
      renderInvites(inviteBox, info, max, used);
    } else {
      panel.appendChild(h('div', { class: 'fam-hint', text: '只有户主或家庭管理员可以邀请新成员。' }));
    }

    // 设备管理
    panel.appendChild(h('h3', { class: 'fam-sec', text: '📱 设备管理' }));
    const devBox = h('div', { class: 'fam-devices' });
    panel.appendChild(devBox);
    renderDevices(devBox, info);

    // 额度池（户主可调）
    panel.appendChild(h('h3', { class: 'fam-sec', text: '🎫 家庭共享额度池' }));
    panel.appendChild(quotaPoolCard(fam, isOwner));

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
          try {
            await api('/api/family/member/' + encodeURIComponent(auth.user.account), { method: 'DELETE' });
            toast('已退出', 'success'); load();
          } catch (e) { toast(e.message, 'error'); }
        },
      }));
    }
    panel.appendChild(acts);
  }

  function statCell(ico, label, val, sub) {
    return h('div', { class: 'fam-stat' }, [
      h('div', { class: 'fs-ico', text: ico }),
      h('div', { class: 'fs-body' }, [
        h('div', { class: 'fs-label', text: label }),
        h('div', { class: 'fs-val', text: val }),
        h('div', { class: 'fs-sub', text: sub || '' }),
      ]),
    ]);
  }

  function memberRow(m, canManage, isPending) {
    const row = h('div', { class: 'fam-member' + (isPending ? ' is-pending' : '') }, [
      avatarEl({ nickname: m.nickname, avatar: m.avatar }),
      h('div', { class: 'mi' }, [
        h('div', { class: 'mn' }, [
          m.nickname || m.account,
          m.isOwner
            ? h('span', { class: 'cm-badge', text: '👑 户主' })
            : h('span', { class: 'role-chip r-' + (m.role || 'member'), text: (ROLE_ICON[m.role] || '👤') + ' ' + (m.roleName || '成员') }),
          isPending ? h('span', { class: 'cm-badge pending', text: '待审核' }) : null,
        ]),
        h('div', { class: 'ma', text: '@' + m.account + (m.joinedAt ? ' · ' + relTime(m.joinedAt) + '加入' : '')
          + (m.deviceCount ? ' · 📱 ' + m.deviceCount + ' 台设备' : '') }),
      ]),
    ]);

    const btns = h('div', { class: 'fm-btns' });

    if (isPending && canManage) {
      btns.appendChild(h('button', {
        class: 'btn btn-primary btn-sm', text: '通过',
        onclick: async () => {
          try { await api('/api/family/member/' + encodeURIComponent(m.account) + '/approve', { method: 'POST' }); toast('已通过', 'success'); load(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }));
    }

    if (canManage && !m.isOwner) {
      const sel = h('select', { class: 'role-select', title: '调整角色' });
      [['member', '成员'], ['child', '儿童'], ['guest', '访客'], ['admin', '家庭管理员']].forEach(([v, t]) => {
        const o = h('option', { value: v, text: t });
        if (m.role === v) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = async () => {
        try {
          await api('/api/family/member/' + encodeURIComponent(m.account) + '/role', { method: 'PUT', body: { role: sel.value } });
          toast('角色已更新', 'success'); load();
        } catch (e) { toast(e.message, 'error'); sel.value = m.role; }
      };
      btns.appendChild(sel);
    }

    if (canManage && !m.isOwner) {
      btns.appendChild(h('button', {
        class: 'btn btn-ghost btn-sm', text: isPending ? '拒绝' : '移出',
        onclick: async () => {
          if (!confirm((isPending ? '拒绝该申请？' : '移出该成员？'))) return;
          try { await api('/api/family/member/' + encodeURIComponent(m.account), { method: 'DELETE' }); toast('已处理', 'success'); load(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }));
    }

    if (btns.childNodes.length) row.appendChild(btns);
    return row;
  }

  async function renderInvites(box, info, max, used) {
    box.innerHTML = '';
    if (used >= max) {
      box.appendChild(h('div', { class: 'fam-hint', text: `成员已满（${max} 人），无法继续邀请。` }));
      return;
    }
    let invites = [];
    try { invites = (await api('/api/family/invites')).invites || []; } catch {}

    // 生成控件
    const roleSel = h('select', { class: 'inv-role' });
    [['member', '成员'], ['child', '儿童'], ['guest', '访客'], ['admin', '家庭管理员']].forEach(([v, t]) => {
      const o = h('option', { value: v, text: t });
      if ((info.inviteRole || 'member') === v) o.selected = true;
      roleSel.appendChild(o);
    });
    const useSel = h('select', { class: 'inv-uses' });
    [1, 2, 3, 5, 10].forEach((n) => useSel.appendChild(h('option', { value: String(n), text: n + ' 次' })));

    box.appendChild(h('div', { class: 'inv-make' }, [
      h('div', { class: 'im-label', text: '角色' }), roleSel,
      h('div', { class: 'im-label', text: '可用次数' }), useSel,
      h('button', {
        class: 'btn btn-primary', text: '＋ 生成邀请码',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const r = await api('/api/family/invite', {
              method: 'POST',
              body: { role: roleSel.value, maxUses: +useSel.value, days: info.inviteTtlDays || 3 },
            });
            toast('邀请码：' + r.code, 'success'); load();
          } catch (err) { toast(err.message, 'error'); }
          e.target.disabled = false;
        },
      }),
    ]));

    const linkRow = h('div', { class: 'inv-link' });
    invites.forEach((inv) => {
      const url = location.origin + location.pathname + '#/join?code=' + inv.code;
      linkRow.appendChild(
        h('div', { class: 'inv-item' }, [
          h('div', { class: 'iv-top' }, [
            h('code', { class: 'inv-code', text: inv.code }),
            h('span', { class: 'role-chip r-' + inv.role, text: (ROLE_ICON[inv.role] || '👤') + ' ' + inv.roleName }),
            h('span', { class: 'iv-uses', text: `${inv.usedCount}/${inv.maxUses} 次` }),
          ]),
          h('div', { class: 'inv-exp', text: '有效期至 ' + new Date(inv.expire).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
          h('div', { class: 'inv-btns' }, [
            h('button', {
              class: 'btn btn-ghost btn-sm', text: '🔗 复制链接',
              onclick: () => {
                if (navigator.clipboard) navigator.clipboard.writeText(url);
                toast('邀请链接已复制', 'success');
              },
            }),
            h('button', {
              class: 'btn btn-ghost btn-sm', text: '📋 复制码',
              onclick: () => {
                if (navigator.clipboard) navigator.clipboard.writeText(inv.code);
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
    box.appendChild(linkRow);
  }

  /** 设备管理面板 */
  async function renderDevices(box, info) {
    box.innerHTML = '';
    let d;
    try { d = await api('/api/family/devices'); } catch { d = { devices: [] }; }
    const list = d.devices || [];
    if (!list.length) {
      box.appendChild(h('div', { class: 'fam-empty', text: '暂无已绑定设备' }));
      return;
    }
    const limited = info.deviceLimit > 0;
    box.appendChild(h('div', { class: 'dev-hint', text: limited
      ? `每成员最多绑定 ${info.deviceLimit} 台设备，超出后需先移除旧设备。`
      : '设备数不限。' }));
    list.forEach((dv) => {
      box.appendChild(h('div', { class: 'dev-item' }, [
        h('div', { class: 'dv-ico', text: '📺' }),
        h('div', { class: 'dv-info' }, [
          h('div', { class: 'dv-name', text: dv.name || dv.deviceId }),
          h('div', { class: 'dv-sub', text: '@' + dv.account + (dv.lastAt ? ' · 最近 ' + relTime(dv.lastAt) : '') }),
        ]),
        d.canManage || dv.account === (auth.user && auth.user.account)
          ? h('button', {
              class: 'btn btn-ghost btn-sm', text: '解绑',
              onclick: async () => {
                if (!confirm('解绑该设备？')) return;
                try {
                  await api('/api/family/device/' + encodeURIComponent(dv.deviceId) + '?account=' + encodeURIComponent(dv.account), { method: 'DELETE' });
                  toast('已解绑', 'success'); load();
                } catch (e) { toast(e.message, 'error'); }
              },
            })
          : null,
      ]));
    });
  }

  /** 家庭额度池卡片 */
  function quotaPoolCard(fam, isOwner) {
    const remain = fam.poolRemain;
    const card = h('div', { class: 'fam-pool' }, [
      h('div', { class: 'fp-main' }, [
        h('div', { class: 'fp-num', text: remain === -1 ? '∞' : String(remain) }),
        h('div', { class: 'fp-label', text: '可用共享额度（次）' }),
      ]),
      h('div', { class: 'fp-bar' }, [
        h('i', { style: { width: fam.quotaPool > 0 ? Math.min(100, (fam.poolUsed / fam.quotaPool) * 100) + '%' : '0%' } }),
      ]),
      h('div', { class: 'fp-sub', text: `池上限 ${fam.quotaPool === -1 ? '∞' : fam.quotaPool} · 已用 ${fam.poolUsed}` }),
    ]);

    if (isOwner) {
      card.appendChild(h('div', { class: 'fp-acts' }, [
        h('button', {
          class: 'btn btn-ghost btn-sm', text: '⚙️ 设置上限',
          onclick: async () => {
            const v = prompt('家庭共享额度池上限（-1 = 无限）', fam.quotaPool);
            if (v === null) return;
            try {
              await api('/api/family/quota', { method: 'PUT', body: { amount: parseInt(v, 10) } });
              toast('已更新', 'success'); load();
            } catch (e) { toast(e.message, 'error'); }
          },
        }),
        h('button', {
          class: 'btn btn-ghost btn-sm', text: '🔄 重置用量',
          onclick: async () => {
            if (!confirm('重置本周期已用额度？')) return;
            try { await api('/api/family/quota', { method: 'PUT', body: { reset: true } }); toast('已重置', 'success'); load(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }),
      ]));
    }
    return card;
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

/** 稳定的设备标识（localStorage 持久化） */
function deviceId() {
  try {
    let id = localStorage.getItem('cy_device_id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem('cy_device_id', id);
    }
    return id;
  } catch { return 'dev_unknown'; }
}

/** 设备名称（按 UA 粗判） */
function deviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS 设备';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Linux/i.test(ua)) return 'Linux 设备';
  return '浏览器';
}
