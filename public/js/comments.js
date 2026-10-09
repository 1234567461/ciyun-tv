/* ============================================================
   慈云影视 · 评论组件
   ============================================================ */

import { h, api, relTime, toast } from './util.js';
import { auth, avatarEl } from './auth.js';
import { imagePicker, imageGrid } from './media.js';

const ICON_LIKE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0l4.5-8a2.5 2.5 0 0 1 2.5 2.5V9h5a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 19.6 20H7"/></svg>';
const ICON_REPLY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-2.8-.4L3 21l1.6-4.6A8.4 8.4 0 1 1 21 11.5z"/></svg>';
const ICON_DEL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';

/**
 * 渲染评论区
 * @param {HTMLElement} host 容器
 * @param {object} opts { targetType, targetId, maxLen }
 */
export function mountComments(host, opts) {
  const { targetType = 'video', targetId, maxLen = 500 } = opts;
  const state = { page: 1, size: 10, total: 0, totalRoots: 0, replyTo: null, imageEnabled: false, maxImages: 9 };

  host.innerHTML = '';
  host.className = 'comments-wrap';

  const head = h('div', { class: 'comments-head' }, [
    h('h2', { text: '💬 评论' }),
    h('span', { class: 'cnt', text: '加载中…' }),
  ]);
  const editorBox = h('div');
  const listBox = h('div', { class: 'cm-list' });
  host.append(head, editorBox, listBox);

  async function load(reset = false) {
    if (reset) state.page = 1;
    try {
      const d = await api(`/api/comments?type=${targetType}&id=${encodeURIComponent(targetId)}&page=${state.page}&size=${state.size}`);
      state.total = d.total;
      state.totalRoots = d.totalRoots;
      state.imageEnabled = !!d.imageEnabled;
      state.maxImages = Number(d.maxImages) || 9;
      head.querySelector('.cnt').textContent = d.total ? `${d.total} 条评论` : '还没有评论';

      if (reset) listBox.innerHTML = '';
      const frag = document.createDocumentFragment();
      (d.list || []).forEach((c) => frag.appendChild(renderItem(c)));
      listBox.appendChild(frag);

      if (!d.total) {
        listBox.appendChild(h('div', { class: 'empty', style: { padding: '40px 0' } }, [
          h('div', { class: 'ico', text: '💬' }),
          h('div', { class: 't', text: '还没有评论' }),
          h('div', { text: '来说说你的看法吧' }),
        ]));
      }

      // 加载更多
      const oldMore = listBox.querySelector('.cm-more');
      if (oldMore) oldMore.remove();
      if (listBox.children.length - (d.total ? 0 : 1) < state.totalRoots) {
        listBox.appendChild(
          h('div', { class: 'cm-more' }, [
            h('button', {
              class: 'btn btn-ghost btn-sm',
              text: '加载更多评论',
              onclick: async (e) => { e.target.textContent = '加载中…'; state.page++; await load(false); },
            }),
          ])
        );
      }
      renderEditor();
    } catch (e) {
      listBox.innerHTML = '';
      listBox.appendChild(h('div', { class: 'error-box', text: '评论加载失败：' + e.message }));
    }
  }

  /* -------------------------- 发表框 -------------------------- */
  function renderEditor() {
    editorBox.innerHTML = '';
    if (!auth.loggedIn) {
      editorBox.appendChild(
        h('div', { class: 'cm-login-tip' }, [
          h('span', { text: '🔒 登录后即可参与评论' }),
          h('a', { class: 'btn btn-primary btn-sm', href: '#/login?redirect=' + encodeURIComponent(location.hash), text: '登录 / 注册' }),
        ])
      );
      return;
    }
    const ta = h('textarea', {
      class: 'cm-textarea',
      placeholder: state.imageEnabled ? '友善发言，理性讨论…（可粘贴或拖入图片）' : '友善发言，理性讨论…',
      maxlength: String(maxLen),
      oninput: () => {
        const n = ta.value.length;
        cnt.textContent = n + ' / ' + maxLen;
        cnt.className = 'cm-count' + (n > maxLen * 0.9 ? (n >= maxLen ? ' over' : ' warn') : '');
      },
      onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit(); },
    });
    const cnt = h('span', { class: 'cm-count', text: '0 / ' + maxLen });

    // 图片选择器（开启时才创建，避免不需要的元素占位）
    const picker = state.imageEnabled
      ? imagePicker({ scene: 'comment', max: state.maxImages })
      : null;

    const submit = async () => {
      const content = ta.value.trim();
      const images = picker ? picker.attachments : [];
      // 与后端一致：有图时允许纯图片，无图时必须写字
      if (!content && !images.length) return toast('请先输入内容或选择图片', 'error');
      if (content && content.length < 2 && !images.length) return toast('评论至少 2 个字', 'error');
      btn.disabled = true;
      btn.textContent = '发表中…';
      try {
        const r = await api('/api/comments', {
          method: 'POST',
          body: { targetType, targetId, content, attachments: images },
        });
        toast(r.message || '发表成功', 'success');
        ta.value = '';
        cnt.textContent = '0 / ' + maxLen;
        if (picker) picker.clear();
        await load(true);
      } catch (e) {
        toast(e.message || '发表失败', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '发表评论';
      }
    };

    const btn = h('button', { class: 'btn btn-primary btn-sm', text: '发表评论', onclick: submit });

    editorBox.appendChild(
      h('div', { class: 'cm-editor' }, [
        avatarEl(auth.user, 'sm'),
        h('div', { class: 'cm-editor-body' }, [
          ta,
          picker ? picker.strip : null,
          h('div', { class: 'cm-tools' }, [
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px' } }, [
              picker ? picker.btn : null,
              h('span', { style: { fontSize: '12px', color: 'var(--text-mute)' }, text: 'Ctrl + Enter 快速发表' }),
            ]),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [cnt, btn]),
          ]),
        ]),
      ])
    );

    // 粘贴发图 + 拖拽发图
    if (picker) {
      ta.addEventListener('paste', picker.onPaste);
      picker.bindDrop(editorBox.querySelector('.cm-editor'));
    }
  }

  /* -------------------------- 单条评论 -------------------------- */
  function renderItem(c, isReply = false) {
    const isMine = auth.user && auth.user.account === c.account;
    const deleted = c.status === 'deleted';

    const acts = h('div', { class: 'cm-acts' });
    if (!deleted) {
      const likeBtn = h('button', {
        class: 'cm-act' + (c.liked ? ' liked' : ''),
        html: ICON_LIKE + '<span>' + (c.likes || 0) + '</span>',
        onclick: async () => {
          if (!auth.loggedIn) return toast('请先登录后点赞', 'error');
          try {
            const r = await api(`/api/comments/${c.id}/like`, { method: 'POST' });
            likeBtn.classList.toggle('liked', r.liked);
            likeBtn.querySelector('span').textContent = r.likes;
          } catch (e) { toast(e.message, 'error'); }
        },
      });
      acts.appendChild(likeBtn);

      if (!isReply) {
        acts.appendChild(
          h('button', {
            class: 'cm-act',
            html: ICON_REPLY + '<span>回复</span>',
            onclick: () => openReplyBox(c),
          })
        );
      }
      if (isMine) {
        acts.appendChild(
          h('button', {
            class: 'cm-act del',
            html: ICON_DEL + '<span>删除</span>',
            onclick: async () => {
              if (!confirm('确定删除这条评论？')) return;
              try {
                await api('/api/comments/' + c.id, { method: 'DELETE' });
                toast('已删除', 'success');
                load(true);
              } catch (e) { toast(e.message, 'error'); }
            },
          })
        );
      }
    }

    const node = h('div', { class: isReply ? 'cm-reply' : 'cm-item', 'data-id': c.id }, [
      avatarEl({ nickname: c.nickname, avatar: c.avatar }, isReply ? 'sm' : ''),
      h('div', { class: 'cm-main' }, [
        h('div', { class: 'cm-top' }, [
          h('span', { class: 'cm-nick', text: c.nickname || '游客' }),
          isMine ? h('span', { class: 'cm-badge me', text: '我' }) : null,
          c.account !== 'guest' ? h('span', { class: 'cm-badge', text: '用户' }) : null,
          deleted ? h('span', { class: 'cm-badge', style: { background: 'rgba(255,255,255,.08)', color: 'var(--text-mute)' }, text: '已删除' }) : null,
          h('span', { class: 'cm-time', text: relTime(c.createdAt) }),
        ]),
        h('div', { class: 'cm-text' + (deleted ? ' deleted' : ''), text: deleted ? '该评论已删除' : c.content }),
        // 图片九宫格（旧数据没有 images 字段，imageGrid 会自行处理空值）
        !deleted && c.images && c.images.length ? imageGrid(c.images) : null,
        c.status === 'pending' ? h('div', { class: 'cm-pending', text: '⏳ 待审核，通过后公开显示' }) : null,
        acts,
      ]),
    ]);

    // 回复列表
    if (!isReply && c.replies && c.replies.length) {
      const rbox = h('div', { class: 'cm-replies' });
      c.replies.forEach((r) => rbox.appendChild(renderItem(r, true)));
      node.querySelector('.cm-main').appendChild(rbox);
    }

    // 回复输入框容器
    if (!isReply) node.querySelector('.cm-main').appendChild(h('div', { class: 'cm-reply-slot' }));
    return node;
  }

  function openReplyBox(c) {
    if (!auth.loggedIn) return toast('请先登录后回复', 'error');
    const item = listBox.querySelector(`.cm-item[data-id="${c.id}"]`);
    if (!item) return;
    const slot = item.querySelector('.cm-reply-slot');
    if (slot.dataset.open === '1') {
      slot.innerHTML = '';
      slot.dataset.open = '0';
      return;
    }
    slot.innerHTML = '';
    slot.dataset.open = '1';

    const ta = h('textarea', {
      class: 'cm-textarea',
      placeholder: '回复 @' + (c.nickname || '游客') + '：' + (state.imageEnabled ? '（可粘贴或拖入图片）' : ''),
      maxlength: String(maxLen),
      onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send(); },
    });
    const picker = state.imageEnabled
      ? imagePicker({ scene: 'comment', max: state.maxImages })
      : null;

    let submitting = false;
    const send = async () => {
      const content = ta.value.trim();
      const images = picker ? picker.attachments : [];
      // 与后端 checkContent 一致：纯图片可发，纯文字需 ≥2 字
      if (!content && !images.length) return toast('请输入回复内容或选择图片', 'error');
      if (content && content.length < 2 && !images.length) return toast('回复至少 2 个字', 'error');
      if (submitting) return;
      submitting = true;
      sendBtn.disabled = true;
      try {
        await api('/api/comments', {
          method: 'POST',
          body: { targetType, targetId, content, parentId: c.id, attachments: images },
        });
        toast('回复成功', 'success');
        await load(true);
      } catch (e) {
        toast(e.message, 'error');
        submitting = false;
        sendBtn.disabled = false;
      }
    };
    const sendBtn = h('button', { class: 'btn btn-primary btn-sm', text: '回复', onclick: send });

    const close = () => { slot.innerHTML = ''; slot.dataset.open = '0'; };

    slot.appendChild(
      h('div', { class: 'cm-replybox' }, [
        avatarEl(auth.user, 'sm'),
        h('div', { style: { flex: '1', minWidth: '0' } }, [
          ta,
          picker ? picker.strip : null,
          h('div', { class: 'cm-tools' }, [
            picker ? picker.btn : h('span', { style: { fontSize: '11.5px', color: 'var(--text-mute)' }, text: '' }),
            h('div', { style: { display: 'flex', gap: '8px' } }, [
              h('button', { class: 'btn btn-ghost btn-sm', text: '取消', onclick: close }),
              sendBtn,
            ]),
          ]),
        ]),
      ])
    );

    // 粘贴发图 + 拖拽发图
    if (picker) {
      ta.addEventListener('paste', picker.onPaste);
      picker.bindDrop(slot.querySelector('.cm-replybox'));
    }
    ta.focus();
  }

  load(true);
  return { reload: () => load(true) };
}
