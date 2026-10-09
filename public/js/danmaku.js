/* ============================================================
   慈云影视 · 弹幕引擎
   本地弹幕（当前视频） + 全站弹幕（全站在线广播）
   ============================================================ */

import { h, api, toast } from './util.js';
import { auth } from './auth.js';
import { imagePicker, imgViews, openLightbox } from './media.js';

const COLORS = ['#ffffff', '#ff6b6b', '#ffd93d', '#6bcbff', '#a78bfa', '#4ade80', '#f472b6'];

/**
 * 弹幕层
 * @param {HTMLElement} layer 覆盖在播放器上的绝对定位层
 * @param {object} opts { targetId, getTime(), onSend }
 */
export function createDanmaku(layer, opts = {}) {
  const { targetId = '', getTime = () => 0 } = opts;
  const state = {
    enabled: true,
    scope: 'local',      // local | global
    color: '#ffffff',
    position: 'scroll',
    tracks: [],          // 轨道占用时间
    trackH: 30,
    maxTracks: 0,
    es: null,
    esGlobal: null,
    timers: new Set(),
    imageEnabled: false, // 站点是否开启图片弹幕（由控制条探测后回写）
  };

  const measure = () => {
    const hh = layer.clientHeight || 300;
    state.maxTracks = Math.max(3, Math.floor(hh * 0.55 / state.trackH));
    state.tracks = new Array(state.maxTracks).fill(0);
  };
  measure();
  window.addEventListener('resize', measure);

  /* --------------------- 渲染一条弹幕 --------------------- */
  function emit(dm, anim = true) {
    if (!state.enabled) return;
    if (dm.scope === 'global' && state.scope !== 'global' && !dm._force) {
      // 全站弹幕仅在开启全站模式时展示（也可选择始终混显）
    }
    // 图片弹幕：SSE 给原始 attachments，历史接口给补全 URL 的 images
    const imgs = (dm.images && dm.images.length) ? imgViews(dm.images) : imgViews(dm.attachments);
    const pic = imgs[0];   // 一条弹幕最多一张图

    const el = h('div', {
      class: 'dm-item dm-' + (dm.position || 'scroll') + (pic ? ' dm-pic' : ''),
    });

    if (pic) {
      // 高度受轨道限制，宽度按原比例自适应，避免飘过一颗巨图
      const ratio = (pic.w && pic.h) ? (pic.w / pic.h) : 1.6;
      const boxH = Math.max(38, state.trackH - 4);
      const img = h('img', {
        src: pic.thumb || pic.url,
        alt: pic.name || '弹幕图片',
        loading: 'lazy',
        style: { height: boxH + 'px', width: Math.round(boxH * ratio) + 'px' },
      });
      img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(imgs, 0); });
      el.appendChild(img);
      if (dm.content) el.appendChild(h('span', { class: 'dm-pic-cap', text: dm.content }));
      el.style.color = dm.color || '#fff';
    } else {
      el.textContent = dm.content;
      el.style.color = dm.color || '#fff';
    }

    if ((dm.position || 'scroll') === 'scroll') {
      // 分配轨道：选一条最快空闲的
      let track = 0;
      let min = Infinity;
      for (let i = 0; i < state.maxTracks; i++) {
        if (state.tracks[i] < min) { min = state.tracks[i]; track = i; }
      }
      const now = Date.now();
      state.tracks[track] = now + 700; // 同轨 0.7s 间隔，避免重叠
      el.style.top = (track * state.trackH + 8) + 'px';
      layer.appendChild(el);

      const w = el.offsetWidth;
      const total = layer.clientWidth + w;
      const dur = Math.max(6, total / 130); // 按宽度自适应时长
      el.style.transform = `translateX(${layer.clientWidth}px)`;
      requestAnimationFrame(() => {
        el.style.transition = `transform ${dur}s linear`;
        el.style.transform = `translateX(${-w}px)`;
      });
      const t = setTimeout(() => { el.remove(); state.timers.delete(t); }, dur * 1000 + 300);
      state.timers.add(t);
    } else {
      // 顶部/底部固定弹幕
      if (!layer._fixedSlots) layer._fixedSlots = { top: 0, bottom: 0 };
      const slot = layer._fixedSlots[dm.position] || 0;
      layer._fixedSlots[dm.position] = (slot + 1) % 3;
      el.style[dm.position] = (34 + slot * state.trackH) + 'px';
      layer.appendChild(el);
      const t = setTimeout(() => { el.remove(); state.timers.delete(t); }, 4200);
      state.timers.add(t);
    }
  }

  /* --------------------- 发送 --------------------- */
  async function send(content, attachments = []) {
    const text = String(content || '').trim();
    const pics = attachments || [];
    // 与后端一致：纯图片弹幕合法
    if (!text && !pics.length) return false;
    try {
      const r = await api('/api/danmaku', {
        method: 'POST',
        body: {
          scope: state.scope,
          target: targetId,
          content: text,
          attachments: pics,
          color: state.color,
          position: state.position,
          time: Math.round(getTime() || 0),
        },
      });
      // 自己发的立刻显示（SSE 也会回推，用 _self 去重）
      if (r.danmaku) emit({ ...r.danmaku, _self: true });
      return true;
    } catch (e) {
      toast(e.message || '弹幕发送失败', 'error');
      return false;
    }
  }

  /** 探测图片弹幕能力（历史接口会带回开关） */
  function probeImageCapability() {
    api(`/api/danmaku?scope=local&target=${encodeURIComponent(targetId)}&limit=1`)
      .then((d) => { state.imageEnabled = !!d.imageEnabled; if (opts.onCapability) opts.onCapability(state.imageEnabled); })
      .catch(() => {});
  }

  /* --------------------- SSE 订阅 --------------------- */
  function connect() {
    disconnect();
    // 本地弹幕
    state.es = openStream('local', targetId, (dm) => {
      if (dm.account === (auth.user && auth.user.account) && Date.now() - dm.ts < 3000) return; // 去重自己的
      emit(dm);
    });
    // 全站弹幕（始终订阅，切到全站模式时展示）
    state.esGlobal = openStream('global', '', (dm) => {
      if (state.scope !== 'global') return;
      emit(dm);
    });
  }

  function openStream(scope, target, onMsg) {
    let es;
    try {
      const q = `scope=${scope}${target ? '&target=' + encodeURIComponent(target) : ''}`;
      es = new EventSource('/api/danmaku/stream?' + q);
      const seen = new Set();
      es.addEventListener('danmaku', (e) => {
        try {
          const dm = JSON.parse(e.data);
          if (dm.id) { if (seen.has(dm.id)) return; seen.add(dm.id); if (seen.size > 300) seen.clear(); }
          onMsg(dm);
        } catch {}
      });
      es.onerror = () => {};
    } catch {}
    return es;
  }

  function loadHistory() {
    // 拉取最近弹幕并渐进播放
    api(`/api/danmaku?scope=local&target=${encodeURIComponent(targetId)}&limit=40`)
      .then((d) => {
        (d.list || []).forEach((dm, i) => setTimeout(() => emit(dm, false), i * 260));
      })
      .catch(() => {});
  }

  function disconnect() {
    if (state.es) { state.es.close(); state.es = null; }
    if (state.esGlobal) { state.esGlobal.close(); state.esGlobal = null; }
  }

  function clear() {
    layer.innerHTML = '';
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
  }

  function destroy() {
    disconnect();
    clear();
    window.removeEventListener('resize', measure);
  }

  connect();
  loadHistory();
  probeImageCapability();

  return {
    state,
    emit,
    send,
    clear,
    destroy,
    setEnabled(v) { state.enabled = v; if (!v) clear(); },
    setScope(s) { state.scope = s; clear(); if (s === 'local') loadHistory(); },
    setColor(c) { state.color = c; },
    setPosition(p) { state.position = p; },
  };
}

/**
 * 弹幕控制条（输入 + 开关 + 设置）
 */
export function createDanmakuBar(container, dm) {
  let inputEl;

  const colorDots = h('div', { class: 'dm-colors' });
  COLORS.forEach((c) => {
    const dot = h('button', {
      class: 'dm-color' + (c === dm.state.color ? ' on' : ''),
      style: { background: c },
      title: c,
      onclick: () => {
        colorDots.querySelectorAll('.dm-color').forEach((x) => x.classList.remove('on'));
        dot.classList.add('on');
        dm.setColor(c);
      },
    });
    colorDots.appendChild(dot);
  });

  const scopeSel = h('select', {
    class: 'dm-select',
    title: '弹幕范围',
    onchange: (e) => dm.setScope(e.target.value),
  }, [
    h('option', { value: 'local', text: '本片弹幕' }),
    h('option', { value: 'global', text: '全站弹幕' }),
  ]);

  const posSel = h('select', {
    class: 'dm-select',
    title: '显示位置',
    onchange: (e) => dm.setPosition(e.target.value),
  }, [
    h('option', { value: 'scroll', text: '滚动' }),
    h('option', { value: 'top', text: '顶部' }),
    h('option', { value: 'bottom', text: '底部' }),
  ]);

  const toggle = h('button', {
    class: 'dm-toggle on',
    text: '弹',
    title: '开/关弹幕',
    onclick: () => {
      const on = !toggle.classList.contains('on');
      toggle.classList.toggle('on', on);
      dm.setEnabled(on);
      inputRow.style.display = on ? 'flex' : 'none';
    },
  });

  const inputRow = h('div', { class: 'dm-input-row' });
  let picker = null;
  renderInput();
  function renderInput() {
    inputRow.innerHTML = '';
    picker = null;
    if (!auth.loggedIn) {
      inputRow.appendChild(h('a', { class: 'dm-login', href: '#/login?redirect=' + encodeURIComponent(location.hash), text: '登录后发弹幕' }));
      return;
    }
    inputEl = h('input', {
      class: 'dm-input',
      maxlength: '60',
      placeholder: dm.state.imageEnabled ? '发条弹幕或图片…' : '发条弹幕，和大家一起看…',
      onkeydown: (e) => { if (e.key === 'Enter') submit(); },
    });

    if (dm.state.imageEnabled) {
      // 一条弹幕最多 1 张图（屏幕上飘多图会糊成一片）
      picker = imagePicker({ scene: 'danmaku', max: 1, icon: '🖼️' });
      inputEl.addEventListener('paste', picker.onPaste);
    }

    inputRow.append(inputEl);
    if (picker) {
      inputRow.append(picker.btn);
      // 预览条单独一行挂在输入行下方，避免把输入框挤扁
      inputRow.appendChild(h('div', { class: 'dm-pick-strip' }, [picker.strip]));
    }
    inputRow.append(h('button', { class: 'dm-send', text: '发送', onclick: submit }));
  }
  async function submit() {
    if (!inputEl) return;
    const v = inputEl.value.trim();
    const images = picker ? picker.attachments : [];
    if (!v && !images.length) return;
    const ok = await dm.send(v, images);
    if (ok) {
      inputEl.value = '';
      if (picker) picker.clear();
    }
  }

  container.innerHTML = '';
  container.append(toggle, scopeSel, posSel, colorDots, inputRow);
  return {
    refresh: renderInput,
    input: () => inputEl,
    get pickerStrip() { return picker ? picker.strip : null; },
  };
}
