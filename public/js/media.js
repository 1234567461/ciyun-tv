/**
 * 慈云影视 · 图片工具（前端）
 * ============================================================
 * 各入口（评论 / 聊天 / 弹幕 / 私信 / 短视频封面 / 相册 / 云盘）
 * 共用同一套「选图 → 上传 → 拿到可引用的附件对象」流程。
 *
 * 抽出来的原因：如果每个页面各写一遍，迟早出现某些页面做了体积
 * 预检、某些没做，导致用户在不同入口遇到不一致的报错。
 */

import { h, api, toast } from './util.js';

/** 从图片列表构造可提交的附件数组（后端只需要 file 等元信息） */
export function toAttachments(images) {
  return (images || [])
    .map((im) => (im && im.attachment) ? im.attachment : im)
    .filter((a) => a && a.file)
    .map((a) => ({
      file: a.file,
      thumb: a.thumb || '',
      name: a.name || '',
      w: a.w || 0,
      h: a.h || 0,
      size: a.size || 0,
      animated: !!a.animated,
    }));
}

/** 单个附件 → 可直接渲染的图片视图 */
export function imgView(a) {
  if (!a) return null;
  // 已经是视图对象（带 url）就别重复加工
  if (a.url) return a;
  if (!a.file) return null;
  return {
    url: `/api/image/${a.file}`,
    thumb: a.thumb ? `/api/image/thumb/${a.thumb}` : '',
    name: a.name || '',
    w: a.w || 0,
    h: a.h || 0,
    size: a.size || 0,
    animated: !!a.animated,
  };
}

/**
 * 附件数组 → 视图数组。
 * SSE 推送的是原始 attachments（只有 file/thumb 文件名），
 * 而历史接口推的是补全过 URL 的 images —— 两种都能吃。
 */
export function imgViews(list) {
  return (list || []).map(imgView).filter(Boolean);
}

/**
 * 上传单个文件到图片服务。
 * @param {File} file
 * @param {string} scene comment|chat|danmaku|message|cover|avatar|gallery|drive
 * @param {object} [opt] { refType, refId, onProgress }
 * @returns {Promise<object>} { ok, attachment, image, error }
 */
export function uploadImage(file, scene = 'comment', opt = {}) {
  return new Promise((resolve) => {
    // 前端先做一次快速预检 —— 不是为了安全（后端才是权威），
    // 而是为了省掉「传完 5MB 才被告知不支持」的糟糕体验
    if (!file) return resolve({ ok: false, error: '未选择文件' });
    if (!/^image\//i.test(file.type) && file.type) {
      return resolve({ ok: false, error: '只能上传图片文件' });
    }
    if (file.size > 20 * 1024 * 1024) {
      return resolve({ ok: false, error: '图片超过 20MB，请压缩后再上传' });
    }

    const fd = new FormData();
    fd.append('image', file, file.name || 'image.jpg');
    if (opt.refType) fd.append('refType', opt.refType);
    if (opt.refId) fd.append('refId', opt.refId);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload/image?scene=${encodeURIComponent(scene)}`);
    xhr.withCredentials = true;

    if (opt.onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opt.onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch { /* 非 JSON 响应 */ }
      if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) {
        resolve({ ok: true, attachment: j.attachment, image: j.image, id: j.id });
      } else {
        resolve({ ok: false, error: (j && j.error) || `上传失败（${xhr.status}）` });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: '网络错误，上传失败' });
    xhr.ontimeout = () => resolve({ ok: false, error: '上传超时' });
    xhr.send(fd);
  });
}

/** 批量上传（并发 3，避免一次打太多请求） */
export async function uploadImages(files, scene = 'comment', opt = {}) {
  const list = [...(files || [])];
  const out = [];
  const errs = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const idx = i++;
      const f = list[idx];
      if (opt.onEach) opt.onEach(idx, 'start');
      const r = await uploadImage(f, scene, opt);
      if (r.ok) { out[idx] = r; } else { errs.push(r.error); }
      if (opt.onEach) opt.onEach(idx, r.ok ? 'done' : 'error', r);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { list: out.filter(Boolean), errors: errs };
}

/**
 * 隐藏的 file input 选择器。
 * @param {object} opt { accept, multiple, max }
 * @returns {Promise<File[]>}
 */
export function pickFiles({ accept = 'image/*', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => {
      const files = [...(input.files || [])];
      input.remove();
      resolve(files);
    };
    // 用户取消时不触发 change —— 用 focus 兜底清理
    window.addEventListener('focus', () => {
      setTimeout(() => { if (input.isConnected) { input.remove(); resolve([]); } }, 500);
    }, { once: true });
    input.click();
  });
}

/* ============================================================
 * 灯箱（图片大图预览）
 * ============================================================
 * 支持左右翻页 / 键盘 / 缩放 / 下载。评论、相册、云盘、私信共用。
 */

let lbEl = null;

/**
 * 打开灯箱。
 * @param {Array} images   [{ url, thumb, name, w, h }]
 * @param {number} index   起始下标
 */
export function openLightbox(images, index = 0) {
  const list = imgViews(images);
  if (!list.length) return;
  closeLightbox();

  let cur = Math.max(0, Math.min(index, list.length - 1));
  let scale = 1;
  let tx = 0, ty = 0;

  const img = h('img', { class: 'lb-img', alt: '' });
  const counter = h('div', { class: 'lb-counter' });
  const caption = h('div', { class: 'lb-caption' });

  const apply = () => {
    const it = list[cur];
    img.src = it.url;
    img.alt = it.name || '';
    counter.textContent = list.length > 1 ? `${cur + 1} / ${list.length}` : '';
    caption.textContent = it.name || '';
    scale = 1; tx = 0; ty = 0;
    img.style.transform = '';
  };

  const zoom = (d) => {
    scale = Math.max(0.25, Math.min(6, scale + d));
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const go = (d) => {
    cur = (cur + d + list.length) % list.length;
    apply();
  };

  const prevBtn = h('button', {
    class: 'lb-nav lb-prev', type: 'button', text: '‹',
    title: '上一张（←）',
    onclick: (e) => { e.stopPropagation(); go(-1); },
  });
  const nextBtn = h('button', {
    class: 'lb-nav lb-next', type: 'button', text: '›',
    title: '下一张（→）',
    onclick: (e) => { e.stopPropagation(); go(1); },
  });

  const download = h('a', {
    class: 'lb-btn', text: '⬇ 下载', title: '下载原图',
    href: list[cur] ? list[cur].url : '#', download: (list[cur] && list[cur].name) || 'image',
    onclick: (e) => {
      e.stopPropagation();
      // 下载链接要跟随当前图更新
      e.currentTarget.href = list[cur].url;
      e.currentTarget.download = list[cur].name || 'image';
    },
  });

  const zoomIn = h('button', { class: 'lb-btn', type: 'button', text: '＋', title: '放大', onclick: (e) => { e.stopPropagation(); zoom(0.25); } });
  const zoomOut = h('button', { class: 'lb-btn', type: 'button', text: '－', title: '缩小', onclick: (e) => { e.stopPropagation(); zoom(-0.25); } });
  const reset = h('button', { class: 'lb-btn', type: 'button', text: '⤢', title: '原始大小', onclick: (e) => { e.stopPropagation(); scale = 1; tx = 0; ty = 0; img.style.transform = ''; } });
  const close = h('button', { class: 'lb-btn lb-close', type: 'button', text: '✕', title: '关闭（Esc）', onclick: (e) => { e.stopPropagation(); closeLightbox(); } });

  const bar = h('div', { class: 'lb-bar' }, [zoomOut, zoomIn, reset, download, close]);

  const stage = h('div', { class: 'lb-stage' }, [img]);

  const el = h('div', { class: 'lb', onclick: () => closeLightbox() }, [
    stage,
    list.length > 1 ? prevBtn : null,
    list.length > 1 ? nextBtn : null,
    counter,
    caption,
    bar,
  ]);
  // 阻止点击图片本身时关闭
  stage.onclick = (e) => e.stopPropagation();

  // 滚轮缩放
  el.onwheel = (e) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 0.15 : -0.15);
  };

  // 拖拽平移（放大后查看细节）
  let dragging = false, sx = 0, sy = 0;
  img.onmousedown = (e) => {
    if (scale <= 1) return;
    e.preventDefault();
    dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
  };
  const onMove = (e) => {
    if (!dragging) return;
    tx = e.clientX - sx; ty = e.clientY - sy;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const onUp = () => { dragging = false; };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  // 触摸滑动翻页
  let touchX = 0;
  el.ontouchstart = (e) => { touchX = e.touches[0].clientX; };
  el.ontouchend = (e) => {
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60 && scale <= 1) go(dx > 0 ? -1 : 1);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === '+' || e.key === '=') zoom(0.25);
    else if (e.key === '-') zoom(-0.25);
  };
  window.addEventListener('keydown', onKey);

  el.__cleanup = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
  };

  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  lbEl = el;
  apply();
  // 入场动画
  requestAnimationFrame(() => el.classList.add('show'));
}

export function closeLightbox() {
  if (!lbEl) return;
  const el = lbEl;
  lbEl = null;
  document.body.style.overflow = '';
  el.classList.remove('show');
  if (el.__cleanup) { try { el.__cleanup(); } catch {} }
  setTimeout(() => el.remove(), 200);
}

/* ============================================================
 * 九宫格图片组件（评论 / 私信里渲染）
 * ============================================================ */
/**
 * @param {Array} images [{ url, thumb, name, w, h }] 或原始附件数组
 * @param {object} [opt] { size: 'sm'|'md', onDelete }
 */
export function imageGrid(images, opt = {}) {
  const list = imgViews(images);
  if (!list.length) return null;

  const n = list.length;
  const cls = 'img-grid' + (n === 1 ? ' n1' : n === 2 || n === 4 ? ' n2' : ' n3') + (opt.size === 'sm' ? ' sm' : '');

  return h('div', { class: cls }, list.map((im, i) =>
    h('div', { class: 'img-cell' }, [
      h('img', {
        src: im.thumb || im.url,
        alt: im.name || '',
        loading: 'lazy',
        // 点击开灯箱，并把整个图集传进去，方便左右翻页
        onclick: (e) => { e.stopPropagation(); openLightbox(list, i); },
      }),
      im.animated ? h('span', { class: 'img-gif-tag', text: 'GIF' }) : null,
      opt.onDelete ? h('button', {
        class: 'img-del', type: 'button', text: '✕', title: '移除',
        onclick: (e) => { e.stopPropagation(); opt.onDelete(i); },
      }) : null,
    ])
  ));
}

/* ============================================================
 * 「发图」按钮 + 待发送预览条
 * ============================================================
 * 返回一个可复用的上传控件，评论 / 聊天 / 私信 都用它。
 */
/**
 * @param {object} opt
 *   scene     上传场景
 *   max       最多几张
 *   onReady   待发送图片变化时回调（返回附件数组）
 *   icon      按钮文案
 */
export function imagePicker(opt = {}) {
  const scene = opt.scene || 'comment';
  const max = Number(opt.max) || 9;
  const pending = [];   // [{ attachment, previewUrl }]

  const btn = h('button', {
    class: 'btn-icon', type: 'button', title: `发送图片（最多 ${max} 张）`,
    html: opt.icon || '🖼️',
  });

  const strip = h('div', { class: 'pick-strip hidden' });

  const sync = () => {
    strip.innerHTML = '';
    if (!pending.length) { strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    pending.forEach((p, i) => {
      strip.appendChild(
        h('div', { class: 'pick-item' }, [
          h('img', { src: p.attachment.thumb ? `/api/image/thumb/${p.attachment.thumb}` : `/api/image/${p.attachment.file}`, alt: '' }),
          h('button', {
            class: 'pick-x', type: 'button', text: '✕', title: '移除',
            onclick: () => { pending.splice(i, 1); sync(); },
          }),
        ])
      );
    });
    if (opt.onReady) opt.onReady(toAttachments(pending.map((p) => p.attachment)));
  };

  btn.onclick = async () => {
    const room = max - pending.length;
    if (room <= 0) return toast(`最多 ${max} 张`, 'warn');
    const files = await pickFiles({ multiple: room > 1, accept: 'image/*' });
    if (!files.length) return;
    const use = files.slice(0, room);

    // 占位：立刻显示上传中，避免用户以为没反应
    const placeholders = use.map(() => {
      const ph = h('div', { class: 'pick-item uploading' }, [
        h('div', { class: 'pick-spin' }),
      ]);
      strip.classList.remove('hidden');
      strip.appendChild(ph);
      return ph;
    });

    let done = 0;
    for (let i = 0; i < use.length; i++) {
      const r = await uploadImage(use[i], scene);
      if (r.ok) {
        pending.push({ attachment: r.attachment });
        placeholders[i].remove();
      } else {
        placeholders[i].remove();
        toast(r.error || '上传失败', 'error');
      }
      done++;
    }
    sync();
  };

  // 支持粘贴图片（截图后直接 Ctrl+V 发送，极其顺手）
  const onPaste = (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    (async () => {
      const room = max - pending.length;
      for (const f of files.slice(0, room)) {
        const r = await uploadImage(f, scene);
        if (r.ok) pending.push({ attachment: r.attachment });
        else toast(r.error || '上传失败', 'error');
      }
      sync();
    })();
  };

  return {
    btn,
    strip,
    el: h('div', { class: 'picker-wrap' }, [strip]),
    get attachments() { return toAttachments(pending.map((p) => p.attachment)); },
    get count() { return pending.length; },
    clear() { pending.length = 0; sync(); },
    onPaste,
    /** 拖拽上传：把元素变成 dropzone */
    bindDrop(zone) {
      if (!zone) return;
      ['dragenter', 'dragover'].forEach((ev) =>
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragging'); }));
      ['dragleave', 'drop'].forEach((ev) =>
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragging'); }));
      zone.addEventListener('drop', async (e) => {
        const files = [...((e.dataTransfer && e.dataTransfer.files) || [])]
          .filter((f) => /^image\//i.test(f.type));
        if (!files.length) return;
        const room = max - pending.length;
        if (room <= 0) return toast(`最多 ${max} 张`, 'warn');
        for (const f of files.slice(0, room)) {
          const r = await uploadImage(f, scene);
          if (r.ok) pending.push({ attachment: r.attachment });
          else toast(r.error || '上传失败', 'error');
        }
        sync();
      });
    },
  };
}
