/* ============================================================
   慈云影视 · 会员中心
   套餐购买 / 余额充值 / 兑换码 / 订单记录
   ------------------------------------------------------------
   设计理念：可付费可不付费
     · optional 模式：不付费也能完整使用，付费是自愿支持 + 拿点小福利
     · required 模式：部分增值功能需会员
   ============================================================ */

import { h, api, toast, go, relTime } from './util.js';
import { auth, avatarEl } from './auth.js';

const ORDER_STATUS = {
  pending: { text: '待支付', cls: 'warn' },
  paid: { text: '已支付', cls: 'ok' },
  refunded: { text: '已退款', cls: 'dim' },
  expired: { text: '已过期', cls: 'dim' },
  cancelled: { text: '已取消', cls: 'dim' },
};

/**
 * 渲染会员中心
 * @param {HTMLElement} root 容器
 * @param {object} site 站点配置
 * @param {object} opts { tab: 'plans'|'recharge'|'orders'|'redeem' }
 */
export function renderVipPage(root, site, opts = {}) {
  const main = h('div', { class: 'main' }, [h('div', { class: 'container vip-page' })]);
  root.appendChild(main);
  const box = main.querySelector('.container');

  const state = { tab: opts.tab || 'plans', info: null };

  (async () => {
    try {
      state.info = await api('/api/vip/info');
    } catch (e) {
      box.appendChild(h('div', { class: 'error-box', text: '加载失败：' + e.message }));
      return;
    }

    // 未开启付费模块
    if (!state.info.enabled) {
      box.appendChild(freeNotice(state.info));
      return;
    }

    box.appendChild(heroCard(state.info));
    box.appendChild(tabBar(state, box));
    const panel = h('div', { class: 'vip-panel' });
    box.appendChild(panel);
    renderTab(panel);

    document.title = '会员中心 · ' + ((site && site.siteName) || '慈云影视');
  })();

  /* -------------------- 免费使用提示 -------------------- */
  function freeNotice(info) {
    return h('div', { class: 'vip-free' }, [
      h('div', { class: 'ic', text: '🎉' }),
      h('h2', { text: '本站完全免费' }),
      h('p', { text: '当前站点未开启付费模块，所有内容、所有功能都可以免费使用。' }),
      h('div', { class: 'acts' }, [
        h('a', { class: 'btn btn-primary', href: '#/', text: '去逛逛首页' }),
        h('a', { class: 'btn btn-ghost', href: '#/discover', text: '发现更多内容' }),
      ]),
    ]);
  }

  /* -------------------- 顶部会员卡 -------------------- */
  function heroCard(info) {
    const v = info.vip || {};
    const cur = info.currency || '¥';

    // 未登录
    if (!info.loggedIn) {
      return h('div', { class: 'vip-hero guest' }, [
        h('div', { class: 'vh-left' }, [
          h('div', { class: 'vh-badge', text: '💎' }),
          h('div', {}, [
            h('h1', { text: '慈云会员' }),
            h('p', { text: '登录后可开通会员，享受增值权益' }),
          ]),
        ]),
        h('div', { class: 'vh-acts' }, [
          h('a', { class: 'btn btn-primary', href: '#/login?redirect=' + encodeURIComponent('#/vip'), text: '登录 / 注册' }),
        ]),
      ]);
    }

    // 管理员特权卡
    if (v.source === 'admin' || v.isAdmin) {
      return h('div', { class: 'vip-hero admin' }, [
        h('div', { class: 'vh-left' }, [
          h('div', { class: 'vh-badge', text: '🛡️' }),
          h('div', { class: 'vh-info' }, [
            h('h1', {}, [
              h('span', { text: v.name || '管理员（终身会员）' }),
              h('span', { class: 'vh-tag admin', text: 'ADMIN' }),
            ]),
            h('p', { text: '管理员账号默认享有终身会员与无限额度，无需购买或充值。' }),
          ]),
        ]),
        h('div', { class: 'vh-right' }, [
          h('div', { class: 'vh-wallet' }, [
            h('div', { class: 'w-k', text: '观看次数' }),
            h('div', { class: 'w-v admin', text: '∞' }),
          ]),
          h('div', { class: 'vh-wallet' }, [
            h('div', { class: 'w-k', text: '通用点数' }),
            h('div', { class: 'w-v admin', text: '∞' }),
          ]),
        ]),
      ]);
    }

    const active = v.active;
    const expireText = v.expire ? new Date(v.expire).toLocaleDateString('zh-CN') : '';
    const q = v.quota || {};

    return h('div', { class: 'vip-hero' + (active ? ' active' : '') }, [
      h('div', { class: 'vh-left' }, [
        h('div', { class: 'vh-badge', text: active ? '💎' : '🎬' }),
        h('div', { class: 'vh-info' }, [
          h('h1', {}, [
            h('span', { text: active ? (v.name || '会员') : '尚未开通会员' }),
            active && v.source === 'family' ? h('span', { class: 'vh-tag', text: '家庭共享' }) : null,
            active && v.source === 'own' ? h('span', { class: 'vh-tag ok', text: '已开通' }) : null,
          ]),
          h('p', {
            text: active
              ? (v.source === 'family'
                  ? '你正在享受家庭户主共享的会员权益'
                  : `有效期至 ${expireText} · 剩余 ${v.daysLeft} 天`)
              : '开通会员享受去广告、超清画质等增值权益',
          }),
        ]),
      ]),
      h('div', { class: 'vh-right' }, [
        quotaEnabled()
          ? h('div', { class: 'vh-wallet' }, [
              h('div', { class: 'w-k', text: '观看次数' }),
              h('div', { class: 'w-v', text: q.timesText || '0' }),
            ])
          : null,
        quotaEnabled()
          ? h('div', { class: 'vh-wallet' }, [
              h('div', { class: 'w-k', text: '通用点数' }),
              h('div', { class: 'w-v', text: q.pointsText || '0' }),
            ])
          : null,
        h('div', { class: 'vh-wallet' }, [
          h('div', { class: 'w-k', text: '账户余额' }),
          h('div', { class: 'w-v', text: cur + (v.balance || 0).toFixed(2) }),
          info.allowBalance
            ? h('button', {
                class: 'btn btn-ghost btn-sm',
                text: '充值',
                onclick: () => { state.tab = 'recharge'; refreshTabs(); renderTab(panel); },
              })
            : null,
        ]),
        info.redeemEnabled
          ? h('button', {
              class: 'btn btn-primary btn-sm',
              text: '🎁 兑换码',
              onclick: () => { state.tab = 'redeem'; refreshTabs(); renderTab(panel); },
            })
          : null,
      ]),
    ]);
  }

  /* -------------------- Tab 切换 -------------------- */
  let tabBarEl = null;
  function tabBar() {
    const v = (state.info && state.info.vip) || {};
    const isAdm = v.source === 'admin' || v.isAdmin;

    const tabs = isAdm
      ? [
          { id: 'plans', label: '🛡️ 特权说明' },
          quotaEnabled() ? { id: 'quota', label: '🎟️ 我的额度' } : null,
          { id: 'redeem', label: '🎁 兑换码' },
          { id: 'orders', label: '🧾 我的订单' },
        ].filter(Boolean)
      : [
          { id: 'plans', label: '💎 开通会员' },
          quotaEnabled() ? { id: 'quota', label: '🎟️ 我的额度' } : null,
          info_allowBalance() ? { id: 'recharge', label: '💰 余额充值' } : null,
          info_redeemEnabled() ? { id: 'redeem', label: '🎁 兑换码' } : null,
          { id: 'orders', label: '🧾 我的订单' },
        ].filter(Boolean);

    tabBarEl = h('div', { class: 'vip-tabs' });
    tabs.forEach((t) => {
      tabBarEl.appendChild(
        h('button', {
          class: 'vip-tab' + (state.tab === t.id ? ' on' : ''),
          text: t.label,
          onclick: () => { state.tab = t.id; refreshTabs(); renderTab(panel); },
        })
      );
    });
    return tabBarEl;
  }
  function refreshTabs() {
    if (!tabBarEl) return;
    [...tabBarEl.children].forEach((b) => {
      const label = b.textContent;
      const id = label.includes('开通') || label.includes('特权')
        ? 'plans'
        : label.includes('额度') ? 'quota'
        : label.includes('充值') ? 'recharge'
        : label.includes('兑换') ? 'redeem' : 'orders';
      b.classList.toggle('on', id === state.tab);
    });
  }
  const info_allowBalance = () => !!(state.info && state.info.allowBalance !== false);
  const info_redeemEnabled = () => !!(state.info && state.info.redeemEnabled !== false);
  const quotaEnabled = () => !!(state.info && state.info.quotaEnabled);

  /* -------------------- Tab 内容分发 -------------------- */
  let panel = null;
  function renderTab(p) {
    panel = p;
    panel.innerHTML = '';
    if (state.tab === 'plans') renderPlans(panel);
    else if (state.tab === 'quota') renderQuota(panel);
    else if (state.tab === 'recharge') renderRecharge(panel);
    else if (state.tab === 'redeem') renderRedeem(panel);
    else renderOrders(panel);
  }

  /* ==================== 我的额度 ==================== */
  async function renderQuota(panel) {
    if (!auth.loggedIn) {
      panel.appendChild(h('div', { class: 'vip-login-tip' }, [
        h('span', { text: '🔒 登录后可查看额度' }),
        h('a', { class: 'btn btn-primary btn-sm', href: '#/login?redirect=' + encodeURIComponent('#/vip?tab=quota'), text: '去登录' }),
      ]));
      return;
    }
    const box = h('div', { class: 'quota-wrap' }, [h('div', { class: 'quota-loading', text: '加载中…' })]);
    panel.appendChild(box);

    let d;
    try {
      d = await api('/api/quota');
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(h('div', { class: 'empty' }, [h('div', { class: 'ico', text: '⚠️' }), h('div', { class: 't', text: e.message || '加载失败' })]));
      return;
    }
    box.innerHTML = '';
    const q = d.quota || {};
    const rules = d.rules || {};
    const costs = rules.pointCosts || {};
    const cur = d.currency || '¥';
    const isUnl = q.unlimited || q.isAdmin || q.isVip;

    // —— 额度卡片 ——
    const stat = (k, v, sub, cls) => h('div', { class: 'quota-item' + (cls ? ' ' + cls : '') }, [
      h('div', { class: 'qi-k', text: k }),
      h('div', { class: 'qi-v', text: v }),
      sub ? h('div', { class: 'qi-sub', text: sub }) : null,
    ]);

    const freeText = q.freeDaily === -1
      ? '会员免额度'
      : q.freeDaily > 0
        ? `今日剩 ${Math.max(0, q.freeRemain)}/${q.freeDaily} 部`
        : '未开启免费额度';

    box.appendChild(h('div', { class: 'quota-grid' }, [
      stat('观看次数', q.timesText !== undefined ? q.timesText : String(q.times || 0), '可用「次」额度 ' + freeText, 'q-times'),
      stat('通用点数', q.pointsText !== undefined ? q.pointsText : String(q.points || 0), '用于超清 / 下载 / 去广告'),
    ]));

    box.appendChild(h('div', { class: 'quota-usage' }, [
      h('span', { text: `累计观看消耗 ${q.usedPlays || 0} 次` }),
      h('span', { text: `累计点数消耗 ${q.usedPoints || 0} 点` }),
      isUnl ? h('span', { class: 'unl', text: '♾ 当前享有豁免' }) : null,
    ]));

    // —— 点数消耗表 ——
    box.appendChild(h('div', { class: 'quota-cost-card' }, [
      h('h3', { text: '💡 点数消耗规则' }),
      h('div', { class: 'qc-list' }, [
        h('div', { class: 'qc-row' }, [h('span', { text: '超清画质' }), h('b', { text: costs.hd + ' 点 / 次' })]),
        h('div', { class: 'qc-row' }, [h('span', { text: '下载影片' }), h('b', { text: costs.download + ' 点 / 次' })]),
        h('div', { class: 'qc-row' }, [h('span', { text: '去广告' }), h('b', { text: costs.noAd + ' 点 / 次' })]),
        h('div', { class: 'qc-row' }, [h('span', { text: '纯点数看片' }), h('b', { text: costs.play + ' 点 / 部' })]),
      ]),
      h('div', { class: 'qc-acts' }, [
        d.redeemEnabled
          ? h('button', { class: 'btn btn-primary btn-sm', text: '🎁 兑换码充值', onclick: () => { state.tab = 'redeem'; refreshTabs(); renderTab(panel); } })
          : null,
        h('button', { class: 'btn btn-ghost btn-sm', text: '💎 开通会员免额度', onclick: () => { state.tab = 'plans'; refreshTabs(); renderTab(panel); } }),
      ]),
    ]));

    // —— 额度流水 ——
    const logCard = h('div', { class: 'quota-log-card' }, [h('h3', { text: '📜 额度明细' })]);
    box.appendChild(logCard);
    try {
      const lg = await api('/api/quota/log?size=20');
      if (!lg.list || !lg.list.length) {
        logCard.appendChild(h('div', { class: 'empty small' }, [h('div', { class: 't', text: '暂无额度变动记录' })]));
      } else {
        const list = h('div', { class: 'ql-list' });
        lg.list.forEach((x) => {
          const isTimes = x.type === 'times';
          const deltaTxt = x.delta === null ? String(x.after ?? '-') : (x.delta > 0 ? '+' + x.delta : String(x.delta));
          list.appendChild(h('div', { class: 'ql-item' }, [
            h('div', { class: 'ql-left' }, [
              h('div', { class: 'ql-reason', text: x.reason || '额度变动' }),
              h('div', { class: 'ql-time', text: new Date(x.createdAt).toLocaleString('zh-CN') }),
            ]),
            h('div', { class: 'ql-right' }, [
              h('span', { class: 'ql-dim', text: isTimes ? '次' : '点' }),
              h('span', {
                class: 'ql-delta ' + (x.delta > 0 ? 'up' : x.delta < 0 ? 'down' : 'flat'),
                text: deltaTxt,
              }),
            ]),
          ]));
        });
        logCard.appendChild(list);
      }
    } catch (e) {
      logCard.appendChild(h('div', { class: 'empty small' }, [h('div', { class: 't', text: '明细加载失败' })]));
    }
  }

  /* ==================== 套餐列表 ==================== */
  function renderPlans(panel) {
    const info = state.info;
    const cur = info.currency || '¥';
    const plans = info.plans || [];
    const v = info.vip || {};

    // 管理员特权说明
    if (v.source === 'admin' || v.isAdmin) {
      panel.appendChild(
        h('div', { class: 'vip-admin-card' }, [
          h('div', { class: 'va-head' }, [
            h('span', { class: 'va-ic', text: '🛡️' }),
            h('h3', { text: '管理员特权' }),
          ]),
          h('ul', { class: 'va-list' }, [
            h('li', {}, [h('b', { text: '终身会员' }), h('span', { text: '无需开通，永久享有全部会员权益' })]),
            h('li', {}, [h('b', { text: '无限额度' }), h('span', { text: '观看、收藏、评论等均无次数限制' })]),
            h('li', {}, [h('b', { text: '免付费' }), h('span', { text: '所有付费内容直接解锁，不产生订单与扣款' })]),
            h('li', {}, [h('b', { text: '后台管理' }), h('span', { text: '可进入管理后台配置套餐、订单与兑换码' })]),
          ]),
          h('div', { class: 'va-foot' }, [
            h('span', { text: '如需关闭此特权，可在后台「会员付费 → 付费设置」中关闭。' }),
            h('a', { class: 'btn btn-primary btn-sm', href: '/admin/', target: '_blank', text: '进入管理后台' }),
          ]),
        ])
      );
      return;
    }

    if (!info.loggedIn) {
      panel.appendChild(
        h('div', { class: 'vip-login-tip' }, [
          h('span', { text: '🔒 登录后可开通会员' }),
          h('a', { class: 'btn btn-primary btn-sm', href: '#/login?redirect=' + encodeURIComponent('#/vip'), text: '去登录' }),
        ])
      );
    }

    if (!plans.length) {
      panel.appendChild(h('div', { class: 'empty' }, [h('div', { class: 'ico', text: '📦' }), h('div', { class: 't', text: '暂无可购买套餐' })]));
      return;
    }

    const grid = h('div', { class: 'plan-grid' });
    plans.forEach((p) => {
      const isRec = p.recommended;
      const card = h('div', { class: 'plan-card' + (isRec ? ' rec' : '') }, [
        isRec && p.badge ? h('div', { class: 'plan-ribbon', text: p.badge }) : (!isRec && p.badge ? h('div', { class: 'plan-badge', text: p.badge }) : null),
        h('div', { class: 'plan-head' }, [
          h('h3', { text: p.name }),
          h('div', { class: 'plan-days', text: p.days + ' 天' }),
        ]),
        h('div', { class: 'plan-price' }, [
          h('span', { class: 'cur', text: cur }),
          h('span', { class: 'num', text: String(p.price) }),
          p.originalPrice ? h('span', { class: 'orig', text: cur + p.originalPrice }) : null,
        ]),
        p.perDay ? h('div', { class: 'plan-perday', text: `折合 ${cur}${p.perDay} / 天` }) : null,
        h('ul', { class: 'plan-perks' }, (p.perks || []).map((x) =>
          h('li', {}, [h('span', { class: 'tick', text: '✓' }), h('span', { text: x })])
        )),
        h('button', {
          class: 'btn ' + (isRec ? 'btn-primary' : 'btn-ghost') + ' btn-block',
          text: '立即开通',
          onclick: () => openPay(p),
        }),
      ]);
      grid.appendChild(card);
    });
    panel.appendChild(grid);

    panel.appendChild(
      h('div', { class: 'vip-note' }, [
        h('div', { text: '💡 温馨提示' }),
        h('ul', {}, [
          h('li', { text: '核心影视观看永久免费，开通会员仅获得增值权益，不影响基础观看。' }),
          h('li', { text: '会员到期后自动失效，不会自动续费、不会自动扣款。' }),
          h('li', { text: '同一账号购买多次，会员时长自动叠加。' }),
          info.testMode ? h('li', { class: 'hl', text: '当前为演示模式，下单后可直接模拟支付成功，用于体验完整流程。' }) : null,
        ].filter(Boolean)),
      ])
    );
  }

  /* ==================== 支付弹窗 ==================== */
  function openPay(plan) {
    if (!auth.loggedIn) { go('/login?redirect=' + encodeURIComponent('#/vip')); return; }

    const info = state.info;
    const cur = info.currency || '¥';
    const balance = (info.vip && info.vip.balance) || 0;
    const canBalance = info.allowBalance !== false && balance >= plan.price;

    let method = canBalance ? 'balance' : (info.payMethods[0] && info.payMethods[0].id) || 'alipay';

    const mask = h('div', { class: 'vip-modal-mask' });
    const modal = h('div', { class: 'vip-modal' });
    mask.appendChild(modal);

    const methods = [];
    if (info.allowBalance !== false) {
      methods.push({
        id: 'balance', name: '余额支付', icon: '💰',
        sub: `余额 ${cur}${balance.toFixed(2)}${balance < plan.price ? '（不足）' : ''}`,
        disabled: balance < plan.price,
      });
    }
    (info.payMethods || []).forEach((m) => methods.push({ ...m, sub: '推荐' }));

    const methodBox = h('div', { class: 'pay-methods' });
    methods.forEach((m) => {
      const item = h('div', {
        class: 'pay-method' + (method === m.id ? ' on' : '') + (m.disabled ? ' disabled' : ''),
        onclick: () => {
          if (m.disabled) return toast('余额不足，请先充值', 'error');
          method = m.id;
          [...methodBox.children].forEach((c) => c.classList.toggle('on', c.dataset.id === m.id));
        },
      }, [
        h('span', { class: 'pm-ico', text: m.icon }),
        h('div', { class: 'pm-txt' }, [
          h('div', { class: 'pm-name', text: m.name }),
          m.sub ? h('div', { class: 'pm-sub', text: m.sub }) : null,
        ]),
        h('span', { class: 'pm-radio' }),
      ]);
      item.dataset.id = m.id;
      methodBox.appendChild(item);
    });

    const submit = h('button', { class: 'btn btn-primary btn-block', text: `确认支付 ${cur}${plan.price}` });

    modal.append(
      h('div', { class: 'vm-head' }, [
        h('h3', { text: '开通 ' + plan.name }),
        h('button', { class: 'vm-close', text: '✕', onclick: () => mask.remove() }),
      ]),
      h('div', { class: 'vm-body' }, [
        h('div', { class: 'vm-summary' }, [
          h('div', { class: 's-row' }, [h('span', { text: '套餐' }), h('b', { text: plan.name })]),
          h('div', { class: 's-row' }, [h('span', { text: '有效期' }), h('b', { text: plan.days + ' 天' })]),
          plan.save ? h('div', { class: 's-row' }, [h('span', { text: '已优惠' }), h('b', { class: 'save', text: '省 ' + cur + plan.save })]) : null,
          h('div', { class: 's-row total' }, [h('span', { text: '应付金额' }), h('b', { text: cur + plan.price })]),
        ]),
        h('div', { class: 'vm-label', text: '选择支付方式' }),
        methodBox,
      ]),
      h('div', { class: 'vm-foot' }, [submit])
    );
    document.body.appendChild(mask);

    submit.onclick = async () => {
      submit.disabled = true;
      submit.textContent = '处理中…';
      try {
        const r = await api('/api/vip/order', {
          method: 'POST',
          body: { type: 'vip', planId: plan.id, payMethod: method, useBalance: method === 'balance' },
        });

        // 余额支付：立即完成
        if (r.paid) {
          toast('开通成功，会员已生效', 'success');
          mask.remove();
          await auth.refresh();
          go('/vip');
          return;
        }

        // 在线支付
        const p = r.payment || {};
        if (p.mode === 'mock') {
          await mockPay(r.order.id, mask, submit);
        } else if (p.mode === 'redirect' && p.payload && p.payload.url) {
          toast('正在跳转支付页面…');
          window.open(p.payload.url, '_blank');
          startPolling(r.order.id, mask, submit);
        } else {
          toast('订单已创建，请完成支付后返回本页', 'info');
          mask.remove();
          state.tab = 'orders';
          refreshTabs();
          renderTab(panel);
        }
      } catch (e) {
        toast(e.message || '下单失败', 'error');
        submit.disabled = false;
        submit.textContent = `确认支付 ${cur}${plan.price}`;
      }
    };
  }

  /** 演示模式：模拟支付 */
  async function mockPay(orderId, mask, btn) {
    try {
      await api('/api/pay/mock', { method: 'POST', body: { orderId } });
      toast('支付成功，会员已生效 🎉', 'success');
      mask.remove();
      await auth.refresh();
      go('/vip');
    } catch (e) {
      toast(e.message || '支付失败', 'error');
      btn.disabled = false;
      btn.textContent = '重试支付';
    }
  }

  /** 真实支付：轮询订单状态 */
  function startPolling(orderId, mask, btn) {
    btn.textContent = '等待支付结果…';
    let n = 0;
    const timer = setInterval(async () => {
      n++;
      try {
        const r = await api('/api/user/order/' + orderId);
        if (r.order.status === 'paid') {
          clearInterval(timer);
          toast('支付成功，会员已生效 🎉', 'success');
          mask.remove();
          await auth.refresh();
          go('/vip');
        } else if (['expired', 'cancelled'].includes(r.order.status)) {
          clearInterval(timer);
          toast('订单已失效，请重新下单', 'error');
          mask.remove();
        }
      } catch {}
      if (n > 60) {
        clearInterval(timer);
        toast('未检测到支付结果，可稍后在「我的订单」查看', 'info');
        mask.remove();
      }
    }, 3000);
  }

  /* ==================== 余额充值 ==================== */
  function renderRecharge(panel) {
    if (!auth.loggedIn) {
      panel.appendChild(h('div', { class: 'vip-login-tip' }, [
        h('span', { text: '🔒 登录后可充值' }),
        h('a', { class: 'btn btn-primary btn-sm', href: '#/login?redirect=' + encodeURIComponent('#/vip'), text: '去登录' }),
      ]));
      return;
    }
    const info = state.info;
    const cur = info.currency || '¥';
    const presets = info.rechargePresets || [10, 30, 50, 100];
    let amount = presets[0] || 10;

    const card = h('div', { class: 'recharge-card' });
    const grid = h('div', { class: 'rc-grid' });

    const customInput = h('input', {
      type: 'number', min: String(info.minRecharge || 1), placeholder: '自定义金额',
      oninput: () => {
        amount = Number(customInput.value) || 0;
        [...grid.children].forEach((c) => c.classList.remove('on'));
        updateSummary();
      },
    });

    presets.forEach((v, i) => {
      const b = h('button', {
        class: 'rc-item' + (i === 0 ? ' on' : ''),
        onclick: () => {
          amount = v;
          customInput.value = '';
          [...grid.children].forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          updateSummary();
        },
      }, [
        h('span', { class: 'rc-cur', text: cur }),
        h('span', { class: 'rc-num', text: String(v) }),
      ]);
      grid.appendChild(b);
    });

    const summary = h('div', { class: 'rc-summary' });
    const updateSummary = () => {
      summary.innerHTML = '';
      summary.append(
        h('span', { text: '充值金额' }),
        h('b', { text: cur + (amount || 0).toFixed(2) })
      );
    };

    const methodBox = h('div', { class: 'pay-methods' });
    let method = (info.payMethods[0] && info.payMethods[0].id) || 'alipay';
    (info.payMethods || []).forEach((m, i) => {
      const item = h('div', {
        class: 'pay-method' + (i === 0 ? ' on' : ''),
        onclick: () => {
          method = m.id;
          [...methodBox.children].forEach((c) => c.classList.toggle('on', c.dataset.id === m.id));
        },
      }, [
        h('span', { class: 'pm-ico', text: m.icon }),
        h('div', { class: 'pm-txt' }, [h('div', { class: 'pm-name', text: m.name })]),
        h('span', { class: 'pm-radio' }),
      ]);
      item.dataset.id = m.id;
      methodBox.appendChild(item);
    });

    const submit = h('button', { class: 'btn btn-primary btn-block', text: '立即充值' });
    submit.onclick = async () => {
      const amt = Number(amount);
      if (!(amt >= (info.minRecharge || 1))) return toast(`最低充值 ${cur}${info.minRecharge || 1}`, 'error');
      submit.disabled = true;
      submit.textContent = '下单中…';
      try {
        const r = await api('/api/vip/order', { method: 'POST', body: { type: 'recharge', amount: amt, payMethod: method } });
        const p = r.payment || {};
        if (p.mode === 'mock') {
          await api('/api/pay/mock', { method: 'POST', body: { orderId: r.order.id } });
          toast(`充值成功，${cur}${amt} 已到账`, 'success');
          await auth.refresh();
          go('/vip');
        } else if (p.mode === 'redirect' && p.payload && p.payload.url) {
          window.open(p.payload.url, '_blank');
          toast('请在打开的页面完成支付', 'info');
          state.tab = 'orders'; refreshTabs(); renderTab(panel);
        } else {
          toast('订单已创建，请完成支付', 'info');
          state.tab = 'orders'; refreshTabs(); renderTab(panel);
        }
      } catch (e) {
        toast(e.message, 'error');
        submit.disabled = false;
        submit.textContent = '立即充值';
      }
    };

    card.append(
      h('div', { class: 'rc-head' }, [
        h('h3', { text: '💰 余额充值' }),
        h('p', { text: '余额可用于购买会员，也可用于后续增值服务消费' }),
      ]),
      h('div', { class: 'rc-label', text: '选择充值金额' }),
      grid,
      h('div', { class: 'rc-custom' }, [customInput]),
      h('div', { class: 'rc-label', text: '支付方式' }),
      methodBox,
      summary,
      submit,
      h('div', { class: 'rc-tip', text: `单次最低充值 ${cur}${info.minRecharge || 1}。充值金额仅用于站内消费，不支持提现。` })
    );
    panel.appendChild(card);
    updateSummary();
  }

  /* ==================== 兑换码 ==================== */
  function renderRedeem(panel) {
    if (!auth.loggedIn) {
      panel.appendChild(h('div', { class: 'vip-login-tip' }, [
        h('span', { text: '🔒 登录后可兑换' }),
        h('a', { class: 'btn btn-primary btn-sm', href: '#/login?redirect=' + encodeURIComponent('#/vip'), text: '去登录' }),
      ]));
      return;
    }
    const cur = (state.info && state.info.currency) || '¥';

    const input = h('input', {
      class: 'redeem-input',
      placeholder: '输入兑换码，如 A1B2-C3D4-E5F6-G7H8',
      maxlength: '24',
      onkeydown: (e) => { if (e.key === 'Enter') doRedeem(); },
    });

    const btn = h('button', { class: 'btn btn-primary', text: '立即兑换', onclick: () => doRedeem() });

    async function doRedeem() {
      const code = input.value.trim();
      if (!code) return toast('请输入兑换码', 'error');
      btn.disabled = true;
      btn.textContent = '兑换中…';
      try {
        const r = await api('/api/user/redeem', { method: 'POST', body: { code } });
        toast(r.redeem.tip + ' 🎉', 'success');
        input.value = '';
        await auth.refresh();
        // 刷新余额显示
        state.info = await api('/api/vip/info');
        go('/vip');
      } catch (e) {
        toast(e.message || '兑换失败', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '立即兑换';
      }
    }

  panel.appendChild(
    h('div', { class: 'redeem-card' }, [
      h('div', { class: 'rd-ico', text: '🎁' }),
      h('h3', { text: '兑换码充值' }),
      h('p', { text: '输入有效的兑换码，即可获得会员时长、账户余额、观看次数或通用点数' }),
      h('div', { class: 'rd-row' }, [input, btn]),
      h('div', { class: 'rd-kinds' }, [
        h('span', { class: 'rk', text: '💎 会员时长' }),
        h('span', { class: 'rk', text: '💰 账户余额' }),
        h('span', { class: 'rk', text: '🎟️ 观看次数' }),
        h('span', { class: 'rk', text: '⭐ 通用点数' }),
      ]),
      h('div', { class: 'rd-tips' }, [
        h('div', { text: '· 兑换码不区分大小写，可不输入横线' }),
        h('div', { text: '· 每个兑换码仅可使用一次，使用后立即失效' }),
        h('div', { text: '· 兑换获得的会员时长会自动叠加到现有会员上' }),
        h('div', { text: '· 观看次数与通用点数会累加到当前额度，可在「我的额度」查看' }),
        h('div', { text: '· 如有兑换问题，请联系站点管理员' }),
      ]),
    ])
  );
}

  /* ==================== 订单记录 ==================== */
  async function renderOrders(panel) {
    if (!auth.loggedIn) {
      panel.appendChild(h('div', { class: 'vip-login-tip' }, [
        h('span', { text: '🔒 登录后查看订单' }),
        h('a', { class: 'btn btn-primary btn-sm', href: '#/login?redirect=' + encodeURIComponent('#/vip'), text: '去登录' }),
      ]));
      return;
    }
    panel.innerHTML = '<div class="vip-loading">加载中…</div>';
    let data;
    try {
      data = await api('/api/user/orders');
    } catch (e) {
      panel.innerHTML = '';
      panel.appendChild(h('div', { class: 'error-box', text: '订单加载失败：' + e.message }));
      return;
    }
    panel.innerHTML = '';
    const cur = (state.info && state.info.currency) || '¥';

    if (!data.list.length) {
      panel.appendChild(h('div', { class: 'empty' }, [
        h('div', { class: 'ico', text: '🧾' }),
        h('div', { class: 't', text: '暂无订单记录' }),
        h('div', { text: '开通会员或充值后，订单会显示在这里' }),
      ]));
      return;
    }

    const list = h('div', { class: 'order-list' });
    data.list.forEach((o) => {
      const st = ORDER_STATUS[o.status] || { text: o.status, cls: 'dim' };
      const canCancel = o.status === 'pending' && !o.expired;
      const canPay = o.status === 'pending' && !o.expired && state.info.provider === 'mock';

      const row = h('div', { class: 'order-item' }, [
        h('div', { class: 'oi-main' }, [
          h('div', { class: 'oi-title' }, [
            h('span', { class: 'oi-name', text: o.planName || '订单' }),
            h('span', { class: 'oi-badge ' + st.cls, text: st.text }),
            o.payVia === 'redeem' ? h('span', { class: 'oi-badge dim', text: '兑换码' }) : null,
            o.payVia === 'balance' ? h('span', { class: 'oi-badge dim', text: '余额支付' }) : null,
          ]),
          h('div', { class: 'oi-meta' }, [
            h('span', { text: '订单号 ' + o.id }),
            h('span', { text: relTime(o.createdAt) }),
          ]),
        ]),
        h('div', { class: 'oi-right' }, [
          h('div', { class: 'oi-amount', text: (o.amount > 0 ? cur + o.amount.toFixed(2) : '免费') }),
          h('div', { class: 'oi-acts' }, [
            canPay
              ? h('button', {
                  class: 'btn btn-primary btn-sm', text: '去支付',
                  onclick: async () => {
                    try {
                      await api('/api/pay/mock', { method: 'POST', body: { orderId: o.id } });
                      toast('支付成功', 'success');
                      await auth.refresh();
                      go('/vip?tab=orders');
                    } catch (e) { toast(e.message, 'error'); }
                  },
                })
              : null,
            canCancel
              ? h('button', {
                  class: 'btn btn-ghost btn-sm', text: '取消',
                  onclick: async () => {
                    if (!confirm('确定取消该订单？')) return;
                    try {
                      await api('/api/user/order/' + o.id + '/cancel', { method: 'POST' });
                      toast('订单已取消', 'success');
                      go('/vip?tab=orders');
                    } catch (e) { toast(e.message, 'error'); }
                  },
                })
              : null,
          ]),
        ]),
      ]);
      list.appendChild(row);
    });
    panel.appendChild(list);
  }
}
