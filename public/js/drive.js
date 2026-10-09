/**
 * 慈云影视 · 云盘页
 * ============================================================
 * 功能：文件夹树导航、面包屑、列表/网格视图、拖拽与多选上传（带进度）、
 *       重命名、移动、删除（回收站 / 永久）、回收站还原与清空、
 *       分享链接（密码 + 有效期）、在线预览抽屉、配额进度与扩容入口。
 *
 * 交互取舍：删除一律先进回收站（除非用户明确选择「彻底删除」），
 * 因为网盘里误删是最高频的懊悔来源。回收站 30 天后由后台定时清理。
 */

import { h, api, toast, copyText } from './util.js';
import { openLightbox } from './media.js';

export async function renderDrivePage(root) {
  const wrap = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(wrap);
  const box = wrap.querySelector('.container');

  const layout = h('div', { class: 'drive-wrap' });
  box.appendChild(layout);
  const side = h('div', { class: 'drive-side' });
  const main = h('div', { class: 'drive-main' });
  layout.appendChild(side);
  layout.appendChild(main);

  // —— 状态 ——
  let parent = '';           // 当前目录 id
  let trashed = false;
  let view = localStorage.getItem('cy_drive_view') || 'list';
  const picked = new Set();
  let nodes = [];
  let quota = null;
  let cfg = {};

  /* ---------------- 侧栏：配额 + 菜单 ---------------- */
  function buildSide() {
    side.innerHTML = '';

    // 配额
    const q = quota || { totalBytes: 0, usedBytes: 0, remainBytes: 0, percent: 0 };
    const barCls = q.percent >= 100 ? 'full' : q.percent >= 85 ? 'warn' : '';
    const qBox = h('div', { class: 'drive-quota' }, [
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px' } }, [
        h('span', { html: '💾 <b>存储空间</b>' }),
        h('span', { style: { color: 'var(--text-2, rgba(255,255,255,.5))' }, text: `${q.percent}%` }),
      ]),
      h('div', { class: 'bar ' + barCls }, [h('i', { style: { width: Math.min(100, q.percent) + '%' } })]),
      h('div', {
        style: { fontSize: '12px', color: 'var(--text-2, rgba(255,255,255,.55))' },
        text: `${fmtSize(q.usedBytes)} / ${fmtSize(q.totalBytes)}`,
      }),
      h('div', {
        style: { fontSize: '11px', marginTop: '5px', color: 'var(--text-2, rgba(255,255,255,.42))' },
        text: `免费 ${fmtSize(q.freeBytes)}${q.vipBytes ? ' + 会员 ' + fmtSize(q.vipBytes) : ''}${q.packBytes ? ' + 空间包 ' + fmtSize(q.packBytes) : ''}`,
      }),
    ]);
    side.appendChild(qBox);

    const upBtn = h('button', {
      class: 'btn btn-primary btn-sm',
      style: { width: '100%', marginBottom: '12px' },
      html: '⬆ 上传文件',
    });
    upBtn.onclick = () => chooseUpload();
    side.appendChild(upBtn);

    // 菜单
    const menu = h('div', { class: 'drive-menu' }, [
      h('a', {
        href: 'javascript:void(0)',
        class: !trashed && !parent ? 'active' : '',
        html: '📁 <span>全部文件</span>',
        onclick: () => { parent = ''; trashed = false; picked.clear(); load(); },
      }),
      h('a', {
        href: 'javascript:void(0)',
        class: trashed ? 'active' : '',
        html: '🗑 <span>回收站</span>',
        onclick: () => { parent = ''; trashed = true; picked.clear(); load(); },
      }),
      h('a', {
        href: 'javascript:void(0)',
        html: '🔗 <span>我的分享</span>',
        onclick: () => showShares(),
      }),
      h('a', {
        href: 'javascript:void(0)',
        html: '🖼️ <span>我的相册</span>',
        onclick: () => { location.hash = '#/gallery'; },
      }),
      h('a', {
        href: 'javascript:void(0)',
        html: '💎 <span>扩容空间</span>',
        onclick: () => { location.hash = '#/vip?tab=plans'; },
      }),
    ]);
    side.appendChild(menu);
  }

  /* ---------------- 主区：工具栏 + 列表 ---------------- */
  function buildMain() {
    main.innerHTML = '';

    // 工具栏
    const tb = h('div', { class: 'drive-toolbar' }, [
      !trashed ? h('button', {
        class: 'btn btn-ghost btn-sm', html: '📁 新建文件夹',
        onclick: async () => {
          const name = prompt('文件夹名称', '新建文件夹');
          if (name === null) return;
          try {
            await api('/api/drive/folder', {
              method: 'POST',
              body: JSON.stringify({ name, parent }),
            });
            toast('已创建', 'success');
            await load();
          } catch (e) { toast(e.message || '创建失败', 'error'); }
        },
      }) : null,
      !trashed ? h('button', {
        class: 'btn btn-ghost btn-sm', html: '⬆ 上传',
        onclick: () => chooseUpload(),
      }) : null,
      trashed ? h('button', {
        class: 'btn btn-ghost btn-sm', html: '🧹 清空回收站',
        onclick: async () => {
          if (!confirm('确定彻底删除回收站内全部内容？此操作不可恢复。')) return;
          try {
            const r = await api('/api/drive/trash/clear', { method: 'POST' });
            toast(`已清除 ${r.count} 项`, 'success');
            await load();
          } catch (e) { toast(e.message || '操作失败', 'error'); }
        },
      }) : null,
      h('div', { class: 'spacer' }),
      picked.size ? h('span', { style: { fontSize: '13px' }, text: `已选 ${picked.size} 项` }) : null,
      picked.size ? h('button', {
        class: 'btn btn-ghost btn-sm', text: '取消选择',
        onclick: () => { picked.clear(); buildMain(); },
      }) : null,
      picked.size ? h('button', {
        class: 'btn btn-ghost btn-sm', html: '✂ 移动',
        onclick: () => moveDialog(),
      }) : null,
      picked.size ? h('button', {
        class: 'btn btn-ghost btn-sm', html: picked.size === 1 ? '🔗 分享' : '',
        style: picked.size === 1 ? {} : { display: 'none' },
        onclick: () => shareDialog([...picked][0]),
      }) : null,
      picked.size ? h('button', {
        class: 'btn btn-ghost btn-sm',
        style: { color: '#ff8a8a' },
        html: trashed ? '♻ 还原' : '🗑 删除',
        onclick: () => batchDelete(),
      }) : null,
      h('button', {
        class: 'btn btn-ghost btn-sm',
        html: view === 'list' ? '▦ 网格' : '▤ 列表',
        onclick: () => {
          view = view === 'list' ? 'grid' : 'list';
          localStorage.setItem('cy_drive_view', view);
          buildMain();
        },
      }),
    ]);
    main.appendChild(tb);

    // 面包屑
    if (!trashed) {
      const bc = h('div', { class: 'crumb' }, [
        h('a', {
          href: 'javascript:void(0)', html: '🏠 根目录',
          onclick: () => { parent = ''; picked.clear(); load(); },
        }),
      ]);
      for (const c of crumbs) {
        bc.appendChild(h('span', { class: 'sep', text: '/' }));
        bc.appendChild(h('a', {
          href: 'javascript:void(0)', text: c.name,
          onclick: () => { parent = c.id; picked.clear(); load(); },
        }));
      }
      main.appendChild(bc);
    } else {
      main.appendChild(h('div', { class: 'crumb', text: '🗑 回收站（保留 30 天后自动清理）' }));
    }

    // 列表
    if (!nodes.length) {
      main.appendChild(h('div', { class: 'drive-empty' }, [
        h('div', { class: 'ico', text: trashed ? '🗑' : '📂' }),
        h('div', { text: trashed ? '回收站是空的' : '这里还是空的' }),
        !trashed ? h('div', {
          style: { marginTop: '14px', fontSize: '13px' },
          text: '点「上传」，或把文件直接拖到页面里',
        }) : null,
      ]));
      return;
    }

    const listWrap = h('div', { class: view === 'grid' ? 'file-grid' : 'file-list' });
    for (const n of nodes) listWrap.appendChild(view === 'grid' ? cardOf(n) : rowOf(n));
    main.appendChild(listWrap);
  }

  let crumbs = [];

  /* ---------------- 单个条目：列表行 ---------------- */
  function rowOf(n) {
    const row = h('div', {
      class: 'file-row' + (picked.has(n.id) ? ' picked' : ''),
      onclick: (e) => {
        if (e.target.closest('button')) return;
        onClickNode(n, e);
      },
    }, [
      h('div', { class: 'file-ico' }, [
        n.type === 'folder' ? h('span', { html: '📁' })
          : (n.thumb ? h('img', { src: n.thumb, alt: '', loading: 'lazy' })
            : h('span', { html: iconOf(n.ext) })),
      ]),
      h('div', { class: 'file-main' }, [
        h('div', { class: 'file-name', text: n.name }),
        h('div', {
          class: 'file-sub',
          text: n.type === 'folder'
            ? '文件夹'
            : `${n.sizeText}${n.downloads ? ' · 下载 ' + n.downloads : ''} · ${relTime(n.updatedAt)}`,
        }),
      ]),
      h('div', { class: 'file-acts' }, actsOf(n)),
    ]);
    return row;
  }

  /* ---------------- 单个条目：网格卡片 ---------------- */
  function cardOf(n) {
    return h('div', {
      class: 'file-card' + (picked.has(n.id) ? ' picked' : ''),
      onclick: (e) => { if (!e.target.closest('button')) onClickNode(n, e); },
    }, [
      h('div', { class: 'thumb' }, [
        n.type === 'folder' ? h('span', { html: '📁' })
          : (n.thumb ? h('img', { src: n.thumb, alt: '', loading: 'lazy' })
            : h('span', { html: iconOf(n.ext) })),
      ]),
      h('div', { class: 'cap' }, [
        h('div', { class: 'n', text: n.name, title: n.name }),
        h('div', { class: 's', text: n.type === 'folder' ? '文件夹' : n.sizeText }),
      ]),
    ]);
  }

  /** 行内操作按钮 */
  function actsOf(n) {
    const btns = [];
    if (trashed) {
      btns.push(h('button', {
        title: '还原', html: '♻',
        onclick: async () => {
          try {
            await api(`/api/drive/restore/${n.id}`, { method: 'POST' });
            toast('已还原', 'success');
            await load();
          } catch (e) { toast(e.message || '失败', 'error'); }
        },
      }));
    } else {
      if (n.type === 'file') {
        btns.push(h('button', {
          title: '下载', html: '⬇',
          onclick: () => {
            const a = h('a', { href: n.url, download: n.name });
            document.body.appendChild(a); a.click(); a.remove();
          },
        }));
        btns.push(h('button', {
          title: '分享', html: '🔗',
          onclick: () => shareDialog(n.id),
        }));
      }
      btns.push(h('button', {
        title: '重命名', html: '✏',
        onclick: async () => {
          const name = prompt('新名称', n.name);
          if (name === null || name === n.name) return;
          try {
            await api(`/api/drive/node/${n.id}`, {
              method: 'PUT', body: JSON.stringify({ name }),
            });
            toast('已重命名', 'success');
            await load();
          } catch (e) { toast(e.message || '失败', 'error'); }
        },
      }));
    }
    btns.push(h('button', {
      class: 'danger', title: trashed ? '彻底删除' : '删除',
      html: '🗑',
      onclick: () => deleteNode(n),
    }));
    return btns;
  }

  /** 点击条目：文件夹进入，文件预览 */
  function onClickNode(n, e) {
    if (picked.size || e.ctrlKey || e.metaKey) {
      if (picked.has(n.id)) picked.delete(n.id);
      else picked.add(n.id);
      buildMain();
      return;
    }
    if (n.type === 'folder') {
      parent = n.id;
      load();
      return;
    }
    preview(n);
  }

  /* ---------------- 上传 ---------------- */
  function chooseUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = async () => {
      const files = [...(input.files || [])];
      input.remove();
      if (files.length) await doUpload(files);
    };
    input.click();
  }

  /** 逐个上传 + 进度面板 */
  async function doUpload(files) {
    const panel = h('div', { class: 'up-list' });
    document.body.appendChild(panel);

    let okCount = 0, failCount = 0;
    for (const f of files) {
      const nm = h('div', { class: 'nm', text: f.name });
      const bar = h('i', { style: { width: '0%' } });
      const item = h('div', { class: 'up-item' }, [nm, h('div', { class: 'pg' }, [bar])]);
      panel.appendChild(item);

      await new Promise((resolve) => {
        const fd = new FormData();
        fd.append('file', f, f.name);
        fd.append('parent', parent);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/drive/upload');
        xhr.withCredentials = true;
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const p = Math.round((e.loaded / e.total) * 100);
            bar.style.width = p + '%';
          }
        };
        xhr.onload = () => {
          let j = null;
          try { j = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) {
            bar.style.width = '100%';
            bar.className = 'done';
            okCount++;
            nm.textContent = `${f.name} ✓`;
            if (j.quota) quota = j.quota;
          } else {
            bar.className = 'err';
            bar.style.width = '100%';
            failCount++;
            nm.textContent = `${f.name} ✗ ${(j && j.error) || '失败'}`;
          }
          resolve();
        };
        xhr.onerror = () => {
          bar.className = 'err'; bar.style.width = '100%';
          failCount++;
          nm.textContent = `${f.name} ✗ 网络错误`;
          resolve();
        };
        xhr.send(fd);
      });
    }

    if (okCount) toast(`上传完成 ${okCount} 个文件`, 'success');
    if (failCount) toast(`${failCount} 个文件上传失败`, 'error');
    setTimeout(() => panel.remove(), 2600);
    await load();
  }

  /* ---------------- 删除 ---------------- */
  async function deleteNode(n) {
    if (trashed) {
      if (!confirm(`彻底删除「${n.name}」？不可恢复。`)) return;
      try {
        await api(`/api/drive/node/${n.id}?hard=1`, { method: 'DELETE' });
        toast('已彻底删除', 'success');
        await load();
      } catch (e) { toast(e.message || '失败', 'error'); }
      return;
    }
    // 非回收站：默认软删；文件夹提示会影响子内容
    const msg = n.type === 'folder'
      ? `将「${n.name}」及其内容移入回收站？`
      : `将「${n.name}」移入回收站？`;
    if (!confirm(msg)) return;
    try {
      await api(`/api/drive/node/${n.id}`, { method: 'DELETE' });
      toast('已移入回收站', 'success');
      await load();
    } catch (e) { toast(e.message || '失败', 'error'); }
  }

  async function batchDelete() {
    const ids = [...picked];
    if (!ids.length) return;
    const hard = trashed;
    if (!confirm(hard ? `彻底删除选中的 ${ids.length} 项？` : `将选中的 ${ids.length} 项移入回收站？`)) return;
    try {
      await api('/api/drive/batch', {
        method: 'POST',
        body: JSON.stringify({ ids, action: 'delete', hard }),
      });
      toast('操作完成', 'success');
      picked.clear();
      await load();
    } catch (e) { toast(e.message || '失败', 'error'); }
  }

  /* ---------------- 移动（选目标文件夹） ---------------- */
  async function moveDialog() {
    let folders = [];
    try {
      const r = await api('/api/drive/folders');
      folders = r.list || [];
    } catch (e) { return toast(e.message || '加载失败', 'error'); }

    const sel = h('select', {
      style: { width: '100%', padding: '9px', borderRadius: '8px', background: '#1c1c24', color: '#fff', border: '1px solid rgba(255,255,255,.15)' },
    }, [
      h('option', { value: '', text: '🏠 根目录' }),
      ...folders.map((f) => h('option', { value: f.id, text: '📁 ' + f.path })),
    ]);

    const mask = h('div', { class: 'pv-mask' });
    const dlg = h('div', {
      style: {
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
        zIndex: '9802', width: 'min(400px,92vw)', padding: '20px', borderRadius: '14px',
        background: '#171720', border: '1px solid rgba(255,255,255,.12)',
        boxShadow: '0 20px 60px rgba(0,0,0,.6)',
      },
    }, [
      h('div', { style: { fontSize: '16px', marginBottom: '14px' }, text: `移动 ${picked.size} 项到…` }),
      sel,
      h('div', { style: { display: 'flex', gap: '9px', marginTop: '16px', justifyContent: 'flex-end' } }, [
        h('button', { class: 'btn btn-ghost btn-sm', text: '取消', onclick: () => { mask.remove(); dlg.remove(); } }),
        h('button', {
          class: 'btn btn-primary btn-sm', text: '确定移动',
          onclick: async () => {
            try {
              await api('/api/drive/batch', {
                method: 'POST',
                body: JSON.stringify({ ids: [...picked], action: 'move', parent: sel.value }),
              });
              toast('已移动', 'success');
              mask.remove(); dlg.remove();
              picked.clear();
              await load();
            } catch (e) { toast(e.message || '失败', 'error'); }
          },
        }),
      ]),
    ]);
    document.body.appendChild(mask);
    document.body.appendChild(dlg);
    mask.onclick = () => { mask.remove(); dlg.remove(); };
  }

  /* ---------------- 分享 ---------------- */
  async function shareDialog(nodeId) {
    const mask = h('div', { class: 'pv-mask' });
    const dlg = h('div', {
      style: {
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
        zIndex: '9802', width: 'min(460px,92vw)', padding: '20px', borderRadius: '14px',
        background: '#171720', border: '1px solid rgba(255,255,255,.12)',
        boxShadow: '0 20px 60px rgba(0,0,0,.6)',
      },
    });
    const close = () => { mask.remove(); dlg.remove(); };
    mask.onclick = close;

    const pwdInput = h('input', { type: 'text', placeholder: '留空则自动生成提取码', maxLength: 16 });
    const daySel = h('select', {
      style: { padding: '8px', borderRadius: '8px', background: '#1c1c24', color: '#fff', border: '1px solid rgba(255,255,255,.15)' },
    }, [
      h('option', { value: '7', text: '7 天有效' }),
      h('option', { value: '1', text: '1 天有效' }),
      h('option', { value: '30', text: '30 天有效' }),
      h('option', { value: '0', text: '永久有效' }),
    ]);

    const result = h('div');

    dlg.appendChild(h('div', { style: { fontSize: '16px', marginBottom: '6px' }, html: '🔗 创建分享链接' }));
    dlg.appendChild(h('div', {
      style: { fontSize: '12px', color: 'rgba(255,255,255,.5)', marginBottom: '14px' },
      text: '任何拿到链接的人都能访问（可加提取码保护）',
    }));
    dlg.appendChild(h('div', { style: { fontSize: '13px', marginBottom: '6px' }, text: '提取码' }));
    dlg.appendChild(pwdInput);
    dlg.appendChild(h('div', { style: { fontSize: '13px', margin: '12px 0 6px' }, text: '有效期' }));
    dlg.appendChild(daySel);
    dlg.appendChild(result);

    const footer = h('div', { style: { display: 'flex', gap: '9px', marginTop: '16px', justifyContent: 'flex-end' } }, [
      h('button', { class: 'btn btn-ghost btn-sm', text: '关闭', onclick: close }),
      h('button', {
        class: 'btn btn-primary btn-sm', html: '生成链接',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const r = await api('/api/drive/share', {
              method: 'POST',
              body: JSON.stringify({
                nodeId,
                password: pwdInput.value.trim(),
                expireDays: Number(daySel.value) || 0,
              }),
            });
            const s = r.share;
            result.innerHTML = '';
            result.appendChild(h('div', { class: 'share-box' }, [
              h('div', { style: { fontSize: '12px', color: 'rgba(255,255,255,.55)' }, text: '分享链接' }),
              h('div', { class: 'row' }, [
                h('input', { value: location.origin + s.url, readOnly: true, onclick: (ev) => ev.target.select() }),
                h('button', {
                  class: 'btn btn-ghost btn-sm', text: '复制',
                  onclick: () => copyText(location.origin + s.url).then(() => toast('链接已复制', 'success')),
                }),
              ]),
              s.hasPassword ? h('div', { style: { marginTop: '10px' } }, [
                h('div', { style: { fontSize: '12px', color: 'rgba(255,255,255,.55)' }, text: '提取码' }),
                h('div', { class: 'share-code', text: s.password }),
              ]) : h('div', { style: { marginTop: '8px', fontSize: '12px', color: 'rgba(255,255,255,.45)' }, text: '无提取码，任何人可访问' }),
              h('div', {
                style: { marginTop: '8px', fontSize: '12px', color: 'rgba(255,255,255,.45)' },
                text: s.expiresAt ? `有效期至 ${new Date(s.expiresAt).toLocaleString()}` : '永久有效',
              }),
            ]));
            btn.textContent = '已生成';
          } catch (err) {
            toast(err.message || '创建失败', 'error');
            btn.disabled = false;
          }
        },
      }),
    ]);
    dlg.appendChild(footer);

    document.body.appendChild(mask);
    document.body.appendChild(dlg);
  }

  /** 我的分享列表 */
  async function showShares() {
    let list = [];
    try { const r = await api('/api/drive/shares'); list = r.list || []; }
    catch (e) { return toast(e.message || '加载失败', 'error'); }

    const mask = h('div', { class: 'pv-mask' });
    const dlg = h('div', {
      style: {
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
        zIndex: '9802', width: 'min(560px,94vw)', maxHeight: '80vh', overflow: 'auto',
        padding: '20px', borderRadius: '14px', background: '#171720',
        border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 20px 60px rgba(0,0,0,.6)',
      },
    });
    const close = () => { mask.remove(); dlg.remove(); };
    mask.onclick = close;

    dlg.appendChild(h('div', { style: { fontSize: '16px', marginBottom: '14px' }, html: '🔗 我的分享' }));

    if (!list.length) {
      dlg.appendChild(h('div', { style: { color: 'rgba(255,255,255,.5)', padding: '20px 0', textAlign: 'center' }, text: '还没有创建过分享' }));
    } else {
      for (const s of list) {
        dlg.appendChild(h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 0',
            borderBottom: '1px solid rgba(255,255,255,.07)',
          },
        }, [
          h('div', { style: { flex: '1', minWidth: '0' } }, [
            h('div', { style: { fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: s.name }),
            h('div', {
              style: { fontSize: '12px', color: 'rgba(255,255,255,.45)', marginTop: '3px' },
              text: `${s.expired ? '⚠ 已过期' : (s.expiresAt ? '至 ' + new Date(s.expiresAt).toLocaleDateString() : '永久')} · 浏览 ${s.views} · 下载 ${s.downloads}${s.hasPassword ? ' · 有提取码 ' + s.password : ''}`,
            }),
          ]),
          h('button', {
            class: 'btn btn-ghost btn-sm', text: '复制',
            onclick: () => copyText(location.origin + s.url).then(() => toast('已复制', 'success')),
          }),
          h('button', {
            class: 'btn btn-ghost btn-sm', style: { color: '#ff8a8a' }, text: '取消',
            onclick: async () => {
              try {
                await api(`/api/drive/share/${s.id}`, { method: 'DELETE' });
                toast('已取消分享', 'success');
                close();
                showShares();
              } catch (e) { toast(e.message || '失败', 'error'); }
            },
          }),
        ]));
      }
    }

    dlg.appendChild(h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '16px' } }, [
      h('button', { class: 'btn btn-ghost btn-sm', text: '关闭', onclick: close }),
    ]));
    document.body.appendChild(mask);
    document.body.appendChild(dlg);
  }

  /* ---------------- 预览抽屉 ---------------- */
  async function preview(n) {
    const mask = h('div', { class: 'pv-mask' });
    const panel = h('div', { class: 'pv-panel' });
    const body = h('div', { class: 'pv-body' });

    const close = () => { mask.remove(); panel.remove(); };

    panel.appendChild(h('div', { class: 'pv-head' }, [
      h('div', { class: 't', text: n.name, title: n.name }),
      h('button', { class: 'btn-icon', html: '✕', title: '关闭', onclick: close }),
    ]));
    panel.appendChild(body);
    panel.appendChild(h('div', { class: 'pv-foot' }, [
      h('button', {
        class: 'btn btn-primary btn-sm', html: '⬇ 下载',
        onclick: () => {
          const a = h('a', { href: n.url, download: n.name });
          document.body.appendChild(a); a.click(); a.remove();
        },
      }),
      h('button', { class: 'btn btn-ghost btn-sm', html: '🔗 分享', onclick: () => shareDialog(n.id) }),
      h('span', {
        style: { flex: '1', fontSize: '12px', color: 'rgba(255,255,255,.45)', alignSelf: 'center' },
        text: `${n.sizeText} · ${relTime(n.updatedAt)}`,
      }),
    ]));

    // 按类型渲染
    body.innerHTML = '<div style="color:rgba(255,255,255,.5)">加载中…</div>';
    const kind = n.preview;
    const base = `${n.url}?inline=1`;

    if (kind === 'image') {
      body.innerHTML = '';
      body.appendChild(h('img', {
        src: n.url, alt: n.name, style: { cursor: 'zoom-in' },
        onclick: () => openLightbox([{ url: n.url, thumb: n.url, name: n.name }], 0),
      }));
    } else if (kind === 'video') {
      body.innerHTML = '';
      body.appendChild(h('video', { src: base, controls: true, preload: 'metadata', playsInline: true }));
    } else if (kind === 'audio') {
      body.innerHTML = '';
      body.appendChild(h('audio', { src: base, controls: true, preload: 'metadata' }));
    } else if (kind === 'pdf') {
      body.innerHTML = '';
      body.appendChild(h('iframe', { src: base, title: n.name }));
    } else if (kind === 'text') {
      try {
        const r = await fetch(base, { credentials: 'include' });
        const txt = await r.text();
        body.innerHTML = '';
        body.appendChild(h('pre', { text: txt.slice(0, 200000) }));
      } catch {
        body.innerHTML = '<div style="color:#ff8a8a">读取失败</div>';
      }
    } else {
      body.innerHTML = '';
      body.appendChild(h('div', { style: { textAlign: 'center', color: 'rgba(255,255,255,.55)' } }, [
        h('div', { style: { fontSize: '46px', marginBottom: '12px' }, html: iconOf(n.ext) }),
        h('div', { text: '该类型不支持在线预览' }),
        h('div', { style: { fontSize: '13px', marginTop: '8px' }, text: '请下载后查看' }),
      ]));
    }

    document.body.appendChild(mask);
    document.body.appendChild(panel);
    mask.onclick = close;
  }

  /* ---------------- 拖拽上传 ---------------- */
  ['dragenter', 'dragover'].forEach((ev) =>
    main.addEventListener(ev, (e) => { e.preventDefault(); main.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    main.addEventListener(ev, (e) => { e.preventDefault(); main.classList.remove('dragging'); }));
  main.addEventListener('drop', async (e) => {
    if (trashed) return toast('回收站里不能上传', 'warn');
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (files.length) await doUpload(files);
  });

  /* ---------------- 加载 ---------------- */
  async function load() {
    main.innerHTML = '<div class="drive-empty"><div class="ico">⏳</div><div>加载中…</div></div>';
    try {
      const r = await api(`/api/drive/list?parent=${encodeURIComponent(parent)}${trashed ? '&trashed=1' : ''}`);
      nodes = r.list || [];
      quota = r.quota;
      crumbs = r.breadcrumb || [];
      cfg = r;
      buildSide();
      buildMain();
    } catch (e) {
      main.innerHTML = '';
      main.appendChild(h('div', { class: 'drive-empty' }, [
        h('div', { class: 'ico', text: '⚠️' }),
        h('div', { text: e.message || '加载失败' }),
        h('div', { style: { marginTop: '14px' } }, [
          h('button', {
            class: 'btn btn-ghost btn-sm', text: '重试',
            onclick: () => load(),
          }),
        ]),
      ]));
      buildSide();
    }
  }

  // 离开页面时清掉可能残留的固定定位元素
  const clean = () => {
    document.querySelectorAll('.up-list, .pv-mask, .pv-panel').forEach((el) => el.remove());
    window.removeEventListener('hashchange', clean);
  };
  window.addEventListener('hashchange', clean);

  await load();
}

/* ---------------- 小工具 ---------------- */
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 2592000000) return Math.floor(d / 86400000) + ' 天前';
  return new Date(ts).toLocaleDateString();
}

const EXT_ICON = {
  jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', avif: '🖼️', bmp: '🖼️',
  mp4: '🎬', m4v: '🎬', mov: '🎬', webm: '🎬', mkv: '🎬', avi: '🎬', flv: '🎬', ts: '🎬',
  mp3: '🎵', m4a: '🎵', aac: '🎵', flac: '🎵', wav: '🎵', ogg: '🎵', opus: '🎵',
  pdf: '📕', epub: '📗', mobi: '📗', azw3: '📗', cbz: '📚', cbr: '📚',
  txt: '📄', md: '📄', csv: '📊', json: '📄', log: '📄',
  doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
};

function iconOf(ext) {
  return EXT_ICON[String(ext || '').toLowerCase()] || '📄';
}

/* ============================================================
 * 分享访问页（#/s/:token）
 * ------------------------------------------------------------
 * 这是唯一一个「未登录也能看」的页面 —— 拿到链接的人未必是本站用户。
 * 因此：
 *   - 需要提取码时，先只显示一个输入框，不泄漏任何文件信息
 *   - 验证通过后靠后端下发的 httpOnly cookie 保持身份，前端不持有凭据
 *   - 文件夹分享支持逐级浏览，下载走 /node/:id（后端会校验子树越权）
 * ============================================================ */
export async function renderSharePage(root, token) {
  const wrap = h('div', { class: 'main' }, [h('div', { class: 'container' })]);
  root.appendChild(wrap);
  const box = wrap.querySelector('.container');

  const card = h('div', { class: 'share-page' });
  box.appendChild(card);
  card.appendChild(h('div', { class: 'soc-hint', text: '加载中…' }));

  let parent = '';

  async function load() {
    let d;
    try {
      d = await api(`/api/share/${encodeURIComponent(token)}`);
    } catch (e) {
      card.innerHTML = '';
      card.appendChild(h('div', { class: 'error-box', text: '分享不存在或已失效：' + e.message }));
      return;
    }

    // 需要提取码：只给输入框
    if (d.needPassword) {
      card.innerHTML = '';
      const pw = h('input', {
        class: 'soc-input', type: 'password', placeholder: '请输入提取码',
        maxlength: '16', style: { maxWidth: '220px' },
      });
      const go = async () => {
        const v = pw.value.trim();
        if (!v) return;
        btn.disabled = true;
        try {
          await api(`/api/share/${encodeURIComponent(token)}/verify`, { method: 'POST', body: { password: v } });
          toast('验证通过', 'success');
          load();
        } catch (e) {
          toast(e.message || '提取码不正确', 'error');
          btn.disabled = false;
        }
      };
      const btn = h('button', { class: 'btn btn-primary btn-sm', text: '提取', onclick: go });
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      card.append(
        h('div', { class: 'share-lock' }, [
          h('div', { class: 'ic', text: '🔒' }),
          h('div', { class: 't', text: '该分享需要提取码' }),
          h('div', { class: 'row' }, [pw, btn]),
        ])
      );
      pw.focus();
      return;
    }

    render(d);
  }

  function render(d) {
    card.innerHTML = '';
    const s = d.share || d;

    // 头部：文件名 / 大小 / 所有者
    card.appendChild(
      h('div', { class: 'share-head' }, [
        h('div', { class: 'ic', text: s.type === 'folder' ? '📁' : iconOf(s.ext) }),
        h('div', { class: 'meta' }, [
          h('div', { class: 'nm', text: s.name || '分享文件' }),
          h('div', { class: 'sub', text: [s.sizeText, s.owner ? '来自 @' + s.owner : '', s.expiresAt ? '有效期至 ' + new Date(s.expiresAt).toLocaleDateString() : '长期有效'].filter(Boolean).join(' · ') }),
        ]),
      ])
    );

    // 单个文件：直接给下载 / 预览
    if (s.type === 'file') {
      const acts = h('div', { class: 'share-acts' });
      const dl = `/api/share/${encodeURIComponent(token)}/file`;
      if (s.preview === 'image') {
        acts.appendChild(h('button', {
          class: 'btn btn-primary btn-sm', text: '👁 预览',
          onclick: () => openLightbox([{ url: dl, thumb: s.thumb || dl, name: s.name }], 0),
        }));
      }
      acts.appendChild(h('a', { class: 'btn btn-ghost btn-sm', href: dl, text: '⬇ 下载', download: s.name || '' }));
      card.appendChild(acts);
      return;
    }

    // 文件夹：目录浏览
    const list = h('div', { class: 'share-list' });
    card.appendChild(list);
    card.appendChild(h('div', { class: 'share-tip', text: '文件夹分享支持逐级浏览与单独下载' }));

    (async () => {
      list.innerHTML = '';
      list.appendChild(h('div', { class: 'soc-hint', text: '加载目录…' }));
      try {
        const q = parent ? '?parent=' + encodeURIComponent(parent) : '';
        const dd = await api(`/api/share/${encodeURIComponent(token)}/list${q}`);
        list.innerHTML = '';

        // 返回上一级
        if (parent) {
          list.appendChild(
            h('div', { class: 'share-row up', onclick: () => { parent = ''; load(); } }, [
              h('span', { class: 'ic', text: '↩' }),
              h('span', { class: 'nm', text: '返回上一级' }),
            ])
          );
        }
        (dd.list || []).forEach((n) => {
          const isDir = n.type === 'folder';
          const row = h('div', { class: 'share-row' }, [
            h('span', { class: 'ic', text: isDir ? '📁' : iconOf(n.ext) }),
            h('span', { class: 'nm', text: n.name }),
            h('span', { class: 'sz', text: isDir ? '' : fmtSize(n.size || 0) }),
          ]);
          if (isDir) {
            row.onclick = () => { parent = n.id; load(); };
          } else {
            const dl = `/api/share/${encodeURIComponent(token)}/node/${encodeURIComponent(n.id)}`;
            row.appendChild(h('a', {
              class: 'btn btn-ghost btn-sm', text: '⬇', title: '下载', href: dl, download: n.name || '',
              onclick: (e) => e.stopPropagation(),
            }));
            if (n.preview === 'image') {
              row.appendChild(h('button', {
                class: 'btn btn-ghost btn-sm', text: '👁', title: '预览',
                onclick: (e) => { e.stopPropagation(); openLightbox([{ url: dl + '?inline=1', thumb: '', name: n.name }], 0); },
              }));
            }
          }
          list.appendChild(row);
        });
        if (!(dd.list || []).length && !parent) {
          list.appendChild(h('div', { class: 'soc-hint', text: '这个文件夹是空的' }));
        }
      } catch (e) {
        list.innerHTML = '';
        list.appendChild(h('div', { class: 'error-box', text: '目录加载失败：' + e.message }));
      }
    })();
  }

  load();
}
