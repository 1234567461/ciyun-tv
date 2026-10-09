/**
 * 慈云影视 · 个人相册页
 * ============================================================
 * 功能：网格 / 瀑布流切换、灯箱预览、多选批量删除、拖拽与粘贴上传、
 *       按来源筛选。
 *
 * 数据来源：/api/gallery —— 只返回「我上传的图」，含各入口（评论、
 * 聊天、私信、云盘存入）产生的图片，所以这里天然是「我发过的所有图」
 * 的汇总视图。
 */

import { h, api, toast } from './util.js';
import {
  uploadImages, imageGrid, openLightbox, pickFiles,
} from './media.js';

const SCENES = [
  { id: '', name: '全部', icon: '🗂️' },
  { id: 'comment', name: '评论', icon: '💬' },
  { id: 'chat', name: '聊天', icon: '🗨️' },
  { id: 'message', name: '私信', icon: '✉️' },
  { id: 'danmaku', name: '弹幕', icon: '➡️' },
  { id: 'gallery', name: '相册', icon: '🖼️' },
];

export async function renderGalleryPage(root) {
  const wrap = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(wrap);
  const box = wrap.querySelector('.container');
  const page = h('div', { class: 'gallery-wrap' });
  box.appendChild(page);

  // —— 状态 ——
  let scene = '';
  let view = localStorage.getItem('cy_gal_view') || 'grid';
  let pageNo = 1;
  const picked = new Set();
  let all = [];

  const head = h('div', { class: 'gallery-head' });
  const toolbar = h('div', { class: 'gallery-head' });
  const listBox = h('div', { class: 'gal-box' });
  page.appendChild(head);
  page.appendChild(toolbar);
  page.appendChild(listBox);

  /** 顶栏：标题 + 统计 + 上传 */
  function buildHead(usage) {
    head.innerHTML = '';
    head.appendChild(h('h2', { html: '🖼️ 我的相册' }));
    head.appendChild(h('span', {
      class: 'gallery-stat',
      text: `${all.length} 张 · 共 ${fmtSize(usage.bytes)}`,
    }));
    head.appendChild(h('div', { class: 'spacer' }));

    const upBtn = h('button', { class: 'btn btn-primary btn-sm', html: '⬆ 上传图片' });
    upBtn.onclick = async () => {
      const files = await pickFiles({ multiple: true, accept: 'image/*' });
      if (!files.length) return;
      upBtn.disabled = true;
      upBtn.textContent = `上传中 0/${files.length}`;
      let done = 0;
      const r = await uploadImages(files, 'gallery', {
        onEach: (i, st, res) => {
          if (st === 'done' || st === 'error') {
            done++;
            upBtn.textContent = `上传中 ${done}/${files.length}`;
          }
        },
      });
      upBtn.disabled = false;
      upBtn.innerHTML = '⬆ 上传图片';
      if (r.list.length) toast(`成功上传 ${r.list.length} 张`, 'success');
      if (r.errors.length) toast(`${r.errors.length} 张失败：${r.errors[0]}`, 'error');
      await load();
    };
    head.appendChild(upBtn);
  }

  /** 工具栏：来源筛选 + 视图切换 + 多选 */
  function buildToolbar() {
    toolbar.innerHTML = '';

    const chips = h('div', { class: 'chips', style: { display: 'flex', gap: '7px', flexWrap: 'wrap' } });
    for (const s of SCENES) {
      chips.appendChild(h('button', {
        class: 'chip' + (scene === s.id ? ' active' : ''),
        type: 'button',
        html: `${s.icon} ${s.name}`,
        onclick: () => { scene = s.id; pageNo = 1; picked.clear(); load(); },
      }));
    }
    toolbar.appendChild(chips);
    toolbar.appendChild(h('div', { class: 'spacer' }));

    // 多选模式切换
    if (all.length) {
      const selBtn = h('button', {
        class: 'btn btn-ghost btn-sm',
        html: picked.size ? `已选 ${picked.size} 项` : '☑ 选择',
      });
      selBtn.onclick = () => {
        if (picked.size) { picked.clear(); }
        else { all.slice(0, 999).forEach((x) => picked.add(x.id)); }
        render();
        buildToolbar();
      };
      toolbar.appendChild(selBtn);
    }

    const viewBtn = h('button', {
      class: 'btn btn-ghost btn-sm',
      html: view === 'grid' ? '▦ 网格' : '▤ 瀑布流',
    });
    viewBtn.onclick = () => {
      view = view === 'grid' ? 'masonry' : 'grid';
      localStorage.setItem('cy_gal_view', view);
      render();
      buildToolbar();
    };
    toolbar.appendChild(viewBtn);
  }

  /** 渲染图片列表 */
  function render() {
    listBox.innerHTML = '';
    if (!all.length) {
      listBox.appendChild(h('div', { class: 'drive-empty' }, [
        h('div', { class: 'ico', text: '🖼️' }),
        h('div', { text: scene ? '这个分类下还没有图片' : '还没有上传过图片' }),
        h('div', { style: { marginTop: '14px', fontSize: '13px' }, text: '点右上角「上传图片」，或把图片直接拖到这里' }),
      ]));
      return;
    }

    const cls = view === 'masonry' ? 'gal-masonry' : 'gal-grid';
    const grid = h('div', { class: cls });

    all.forEach((im, idx) => {
      const cell = h('div', {
        class: 'gal-cell' + (picked.has(im.id) ? ' picked' : ''),
      }, [
        h('img', {
          src: im.thumb || im.url,
          alt: im.name || '',
          loading: 'lazy',
        }),
        h('div', { class: 'gal-check', html: picked.has(im.id) ? '✓' : '' }),
        h('div', { class: 'gal-meta', text: `${im.name || '未命名'} · ${fmtSize(im.size)}` }),
      ]);

      cell.onclick = (e) => {
        // Ctrl/Cmd 或已进入多选态 → 选择；否则打开灯箱
        if (e.ctrlKey || e.metaKey || picked.size) {
          if (picked.has(im.id)) picked.delete(im.id);
          else picked.add(im.id);
          cell.classList.toggle('picked', picked.has(im.id));
          cell.querySelector('.gal-check').textContent = picked.has(im.id) ? '✓' : '';
          buildToolbar();
          updateBar();
          return;
        }
        openLightbox(all.map((x) => ({ url: x.url, thumb: x.thumb, name: x.name, w: x.w, h: x.h })), idx);
      };

      grid.appendChild(cell);
    });

    listBox.appendChild(grid);
    updateBar();
  }

  /** 底部批量操作条 */
  let bar = null;
  function updateBar() {
    if (bar) { bar.remove(); bar = null; }
    if (!picked.size) return;
    bar = h('div', { class: 'gal-bar' }, [
      h('span', { style: { fontSize: '14px' }, text: `已选 ${picked.size} 张` }),
      h('button', {
        class: 'btn btn-ghost btn-sm', text: '取消',
        onclick: () => { picked.clear(); render(); buildToolbar(); },
      }),
      h('button', {
        class: 'btn btn-primary btn-sm', text: '⬇ 下载',
        onclick: () => {
          // 逐个触发下载（浏览器不支持一次下载多个时也能各自弹出）
          all.filter((x) => picked.has(x.id)).forEach((im, i) => {
            setTimeout(() => {
              const a = h('a', { href: im.url, download: im.name || 'image' });
              document.body.appendChild(a); a.click(); a.remove();
            }, i * 300);
          });
        },
      }),
      h('button', {
        class: 'btn btn-primary btn-sm',
        style: { background: '#e50914' },
        text: '🗑 删除',
        onclick: async () => {
          if (!confirm(`确定删除选中的 ${picked.size} 张图片？此操作不可恢复。`)) return;
          try {
            const r = await api('/api/gallery/batch-delete', {
              method: 'POST',
              body: JSON.stringify({ ids: [...picked] }),
            });
            toast(`已删除 ${r.count} 张`, 'success');
            picked.clear();
            await load();
          } catch (e) {
            toast(e.message || '删除失败', 'error');
          }
        },
      }),
    ]);
    document.body.appendChild(bar);
  }

  /** 拉取数据 */
  async function load() {
    listBox.innerHTML = '<div class="drive-empty"><div class="ico">⏳</div><div>加载中…</div></div>';
    try {
      const r = await api(`/api/gallery?scene=${encodeURIComponent(scene)}&size=200`);
      all = r.list || [];
      buildHead(r.usage || { bytes: 0, count: 0 });
      buildToolbar();
      render();
    } catch (e) {
      listBox.innerHTML = '';
      listBox.appendChild(h('div', { class: 'drive-empty' }, [
        h('div', { class: 'ico', text: '⚠️' }),
        h('div', { text: e.message || '加载失败' }),
      ]));
    }
  }

  // 拖拽上传到整个页面
  ['dragenter', 'dragover'].forEach((ev) =>
    page.addEventListener(ev, (e) => { e.preventDefault(); page.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    page.addEventListener(ev, (e) => { e.preventDefault(); page.classList.remove('dragging'); }));
  page.addEventListener('drop', async (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])]
      .filter((f) => /^image\//i.test(f.type));
    if (!files.length) return;
    toast(`开始上传 ${files.length} 张…`);
    const r = await uploadImages(files, 'gallery');
    if (r.list.length) toast(`成功 ${r.list.length} 张`, 'success');
    if (r.errors.length) toast(`${r.errors.length} 张失败`, 'error');
    await load();
  });

  // 页面离开时清掉固定定位的操作条，否则会残留到下一页
  const clean = () => { if (bar) { bar.remove(); bar = null; } window.removeEventListener('hashchange', clean); };
  window.addEventListener('hashchange', clean);

  await load();
}

function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
