/* ============================================================
   慈云影视 · 同源聊天室
   看同一部影片 / 同一个频道的用户，实时边看边聊
   ============================================================ */

import { h, api, toast } from './util.js';
import { auth, avatarEl } from './auth.js';
import { imagePicker, imageGrid, imgViews } from './media.js';

const EMOJIS = ['😂', '😍', '🔥', '👍', '😱', '🤣', '😭', '🎉', '👏', '🤔', '💯', '🙌', '😴', '🤯', '👀', '❤️'];

/**
 * 挂载聊天室
 * @param {HTMLElement} host 容器
 * @param {object} opts { room, title, subtitle }
 */
export function mountChat(host, opts) {
  const { room, title = '同屏聊天室', subtitle = '' } = opts;
  const state = { online: 0, unsub: null, es: null, sending: false, lastSender: null, imageEnabled: false, maxImages: 9 };

  host.innerHTML = '';
  host.className = 'chat-wrap';

  const box = h('div', { class: 'chat-box' });
  host.appendChild(box);

  /* ------------------------ 头部 ------------------------ */
  const onlineNum = h('span', { text: '0' });
  const head = h('div', { class: 'chat-head' }, [
    h('div', { class: 'ct' }, [h('span', { text: '💬' }), h('span', { text: title })]),
    h('span', { class: 'chat-live' }, [h('span', { class: 'pulse' }), h('span', { text: 'LIVE' })]),
    h('div', { class: 'chat-online' }, [h('span', { class: 'dot' }), onlineNum, h('span', { text: ' 在线' })]),
  ]);
  if (subtitle) head.appendChild(h('span', { class: 'cs', text: subtitle }));
  box.appendChild(head);

  /* ------------------------ 消息区 ------------------------ */
  const body = h('div', { class: 'chat-body' });
  box.appendChild(body);

  /* ------------------------ 输入区 ------------------------ */
  let inputEl = null;
  let picker = null;   // 图片选择器（随能力开关创建/销毁）
  const inputRow = h('div', { class: 'chat-input-row' });
  box.appendChild(inputRow);

  const emojiRow = h('div', { class: 'chat-emojis' });
  EMOJIS.forEach((e) =>
    emojiRow.appendChild(h('button', { text: e, onclick: () => { if (inputEl) { inputEl.value += e; inputEl.focus(); } } }))
  );
  box.appendChild(emojiRow);

  renderInput();
  renderEmpty();
  connect();
  probeImageCapability();

  /* ------------------------ 逻辑 ------------------------ */
  function renderEmpty() {
    body.innerHTML = '';
    body.appendChild(
      h('div', { class: 'chat-empty' }, [
        h('div', { class: 'ic', text: '🎬' }),
        h('div', { text: '还没有人说话' }),
        h('div', { style: { marginTop: '6px', fontSize: '12.5px' }, text: '来发第一条消息，和大家一起看' }),
      ])
    );
  }

  function renderInput() {
    inputRow.innerHTML = '';
    emojiRow.style.display = 'flex';
    picker = null;

    if (!auth.loggedIn) {
      inputRow.appendChild(
        h('div', { class: 'chat-login', style: { flex: '1' } }, [
          h('span', { text: '🔒 登录后即可参与聊天　' }),
          h('a', { class: 'btn btn-primary btn-sm', href: '#/login?redirect=' + encodeURIComponent(location.hash), text: '登录 / 注册' }),
        ])
      );
      return;
    }

    inputEl = h('textarea', {
      class: 'cm-textarea',
      placeholder: state.imageEnabled
        ? '说点什么…（Enter 发送，Shift+Enter 换行，可粘贴图片）'
        : '说点什么…（Enter 发送，Shift+Enter 换行）',
      maxlength: '200',
      rows: '1',
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      },
    });

    if (state.imageEnabled) {
      picker = imagePicker({ scene: 'chat', max: state.maxImages, icon: '🖼️' });
      inputEl.addEventListener('paste', picker.onPaste);
    }

    const sendBtn = h('button', { class: 'btn btn-primary chat-send', text: '发送', onclick: () => send() });

    const wrap = h('div', { class: 'input-wrap', style: { padding: '8px 14px' } }, [
      inputEl,
      picker ? picker.strip : null,
    ]);
    if (picker) picker.bindDrop(wrap);

    const tools = picker
      ? h('div', { class: 'chat-input-tools' }, [picker.btn])
      : null;

    inputRow.append(wrap, tools, sendBtn);
  }

  async function send() {
    if (!inputEl) return;
    const content = inputEl.value.trim();
    const images = picker ? picker.attachments : [];
    // 与后端一致：纯图片消息可以只发图
    if (!content && !images.length) return;
    if (state.sending) return;
    state.sending = true;
    try {
      await api('/api/chat/send', { method: 'POST', body: { room, content, attachments: images } });
      inputEl.value = '';
      inputEl.style.height = 'auto';
      if (picker) picker.clear();
    } catch (e) {
      toast(e.message || '发送失败', 'error');
    } finally {
      state.sending = false;
    }
  }

  function appendMsg(m, animate = true) {
    const empty = body.querySelector('.chat-empty');
    if (empty) empty.remove();

    const isSelf = auth.user && auth.user.account === m.account;
    // 连续同一人，合并昵称显示
    const prev = state.lastSender;
    const showMeta = prev !== m.account;
    state.lastSender = m.account;

    // SSE 推的是原始 attachments，历史接口给的是 images —— 两种都接受
    const imgs = (m.images && m.images.length) ? imgViews(m.images) : imgViews(m.attachments);

    const node = h('div', { class: 'chat-msg' + (isSelf ? ' self' : '') }, [
      avatarEl({ nickname: m.nickname, avatar: m.avatar }, 'sm'),
      h('div', { class: 'chat-msg-body' }, [
        showMeta
          ? h('div', { class: 'chat-meta' }, [
              h('span', { class: 'nm', text: m.nickname || '游客' }),
              h('span', { text: fmtTime(m.ts) }),
            ])
          : null,
        h('div', { class: 'cm-bubble' + (imgs.length && !m.content ? ' only-img' : '') }, [
          m.content ? h('span', { text: m.content }) : null,
          imgs.length ? imageGrid(imgs.length === 1 ? imgs : imgs, { size: 'sm' }) : null,
        ]),
      ]),
    ]);
    if (!animate) node.style.animation = 'none';
    body.appendChild(node);
    body.scrollTop = body.scrollHeight;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return sameDay ? hm : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + hm;
  }

  /* ------------------------ SSE 连接 ------------------------ */
  function connect() {
    // 先拉历史
    api(`/api/chat/history?room=${encodeURIComponent(room)}&limit=60`)
      .then((d) => {
        state.online = d.online || 0;
        onlineNum.textContent = state.online;

        // 服务端能力开关：开启后重建输入区，把「发图」按钮挂上去
        const canImg = d.imageEnabled !== false;
        if (canImg !== state.imageEnabled) {
          state.imageEnabled = canImg;
          if (auth.loggedIn) renderInput();
        } else {
          state.imageEnabled = canImg;
        }

        if (d.list && d.list.length) {
          body.innerHTML = '';
          d.list.forEach((m) => appendMsg(m, false));
          body.scrollTop = body.scrollHeight;
        }
      })
      .catch(() => {});

    try {
      const es = new EventSource(`/api/chat/stream?room=${encodeURIComponent(room)}`);
      state.es = es;

      es.addEventListener('message', (e) => {
        try { appendMsg(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener('presence', (e) => {
        try {
          const d = JSON.parse(e.data);
          state.online = d.online || 0;
          onlineNum.textContent = state.online;
        } catch {}
      });
      es.onerror = () => {
        // 断线自动重连（EventSource 自带），略作提示
      };
    } catch (e) {
      console.warn('SSE 不支持，降级为轮询', e);
      startPolling();
    }
  }

  function startPolling() {
    let since = Date.now();
    setInterval(async () => {
      try {
        const d = await api(`/api/chat/history?room=${encodeURIComponent(room)}&limit=100`);
        onlineNum.textContent = d.online || 0;
        (d.list || []).filter((m) => m.ts > since).forEach((m) => appendMsg(m));
        if (d.list && d.list.length) since = d.list[d.list.length - 1].ts;
      } catch {}
    }, 4000);
  }

  /** 挂载后拉一次能力开关：SSE 不承载站点配置，得单独问一次 */
  function probeImageCapability() {
    if (!auth.loggedIn) return;
    api(`/api/chat/history?room=${encodeURIComponent(room)}&limit=1`)
      .then((d) => {
        const canImg = d.imageEnabled !== false;
        if (canImg !== state.imageEnabled) { state.imageEnabled = canImg; renderInput(); }
      })
      .catch(() => {});
  }

  /** 销毁（页面切换时调用） */
  function destroy() {
    if (state.es) { state.es.close(); state.es = null; }
  }

  return { destroy };
}
