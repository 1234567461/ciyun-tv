/* ============================================================
   慈云影视 · 账号与会话
   ============================================================ */

import { api } from './util.js';

/** 全局登录态 */
export const auth = {
  user: null,
  loggedIn: false,
  inflight: null,

  async refresh() {
    try {
      const r = await api('/api/user/me');
      this.loggedIn = !!r.loggedIn;
      this.user = r.user || null;
    } catch {
      this.loggedIn = false;
      this.user = null;
    }
    return this;
  },

  async ensure() {
    if (this._ready) return this;
    if (!this.inflight) this.inflight = this.refresh().then(() => { this._ready = true; return this; });
    return this.inflight;
  },

  async logout() {
    try { await api('/api/user/logout', { method: 'POST' }); } catch {}
    this.loggedIn = false;
    this.user = null;
  },

  /** 头像文本（首字） */
  initial() {
    const n = (this.user && (this.user.nickname || this.user.account)) || '?';
    return n.slice(0, 1).toUpperCase();
  },
};

/** 渲染头像节点 */
export function avatarEl(user, size = '') {
  const wrap = document.createElement('div');
  wrap.className = 'avatar ' + size;
  if (user && user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = user.nickname || user.account;
    wrap.appendChild(img);
  } else {
    const n = (user && (user.nickname || user.account)) || '?';
    wrap.textContent = n.slice(0, 1).toUpperCase();
    if (!user) wrap.style.background = 'linear-gradient(135deg,#4b5563,#374151)';
  }
  return wrap;
}
