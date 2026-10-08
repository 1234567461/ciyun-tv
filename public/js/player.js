/* ============================================================
   慈云影视 · 全能播放器
   ============================================================
   支持协议：HLS(m3u8) / HTTP-FLV / MP4 / DASH / 原生直连
   核心能力：
     · 自动选择播放内核（原生 / hls.js / flv.js / dash.js）
     · 播放失败自动切换备用线路（多源容灾）
     · 清晰度自动/手动切换
     · 自定义控件：进度、音量、倍速、画中画、网页全屏、全屏
     · 键盘快捷键、记忆播放进度、移动端手势
   ============================================================ */

import { h, fmtTime, toast, ls } from './util.js';

/* ---------------- 外部库懒加载 ---------------- */
const _loaded = {};
function loadScript(src) {
  if (_loaded[src]) return _loaded[src];
  _loaded[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('load failed: ' + src));
    document.head.appendChild(s);
  });
  return _loaded[src];
}

const CDN = {
  hls: '/hls/hls.min.js',
  hlsFallback: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js',
  flv: 'https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js',
  dash: 'https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js',
};

async function ensureHls() {
  if (window.Hls) return window.Hls;
  try {
    await loadScript(CDN.hls);
  } catch {
    await loadScript(CDN.hlsFallback);
  }
  return window.Hls;
}

async function ensureFlv() {
  if (window.flvjs) return window.flvjs;
  await loadScript(CDN.flv);
  return window.flvjs;
}

async function ensureDash() {
  if (window.dashjs) return window.dashjs;
  await loadScript(CDN.dash);
  return window.dashjs;
}

/* ---------------- 协议识别 ---------------- */
export function detectType(url) {
  const u = String(url || '').split('?')[0].toLowerCase();
  if (u.endsWith('.m3u8') || u.endsWith('.m3u')) return 'hls';
  if (u.endsWith('.flv')) return 'flv';
  if (u.endsWith('.mpd')) return 'dash';
  if (/\.(mp4|webm|mov|m4v|mkv)$/.test(u)) return 'file';
  return 'hls'; // 默认按 HLS 处理
}

/**
 * HLS 播放内核选择。
 *
 * ⚠️ 踩坑记录：Chromium/Chrome 的 canPlayType('application/vnd.apple.mpegurl')
 * 返回 "maybe"，但它的**原生 HLS 实现不解析 MPEG-TS 里的 H.264 视频轨**
 * （表现为 readyState=4、buffered=1、paused=false 正常出声，
 *   而 videoWidth/videoHeight === 0 → 纯黑屏）。
 * 因此策略调整为「hls.js 优先」：只要 MSE 可用就走 hls.js（解 TS 稳），
 * 仅在 Safari/iOS（无 MSE，或原生 HLS 才是正解）才用原生直连。
 */
function nativeHlsUsable() {
  if (typeof MediaSource !== 'undefined' && window.MediaSource) return false; // 有 MSE → 一律用 hls.js
  const v = document.createElement('video');
  return v.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/* ============================================================
   播放器类
   ============================================================ */
export class Player {
  /**
   * @param {HTMLElement} container 容器
   * @param {object} opts
   *   lines: [{id,name,type,url,src}]
   *   title, guid, autoplay, startTime
   *   onFailover(lineIdx), onEnded(), onError(err)
   */
  constructor(container, opts = {}) {
    this.el = container;
    this.opts = opts;
    this.lines = (opts.lines || []).filter((l) => l.url || l.src);
    this.current = 0;
    this.hls = null;
    this.flv = null;
    this.dash = null;
    this.failCount = 0;
    // 连续失败计数（拉取成功即清零），与 failCount 的「累计」语义区分开
    this.failStreak = 0;
    this.mediaStreak = 0;
    this._netTimer = null;
    this.retryLine = null;
    // 🔴 直播稳定性：媒体错误恢复节流 / 引擎重建计数 / 用户暂停意图
    this._lastRec = 0;
    this._hardRestart = 0;
    this._userPaused = false;
    this._destroyed = false;
    this._build();
    this._bindKeys();
    if (this.lines.length) this.play(0, { autoplay: opts.autoplay });
  }

  /* ---------------- 构建 DOM ---------------- */
  _build() {
    this.el.classList.add('vp');
    this.el.innerHTML = '';

    this.video = h('video', {
      playsinline: '',
      'webkit-playsinline': '',
      preload: 'metadata',
      poster: this.opts.poster || '',
    });
    this.el.appendChild(this.video);

    // 中央大播放按钮
    this.center = h('div', { class: 'vp-center show' }, [
      h('button', { class: 'vp-big', html: ICON.play, onclick: () => this.toggle() }),
    ]);
    this.el.appendChild(this.center);

    // 加载指示
    this.loading = h('div', { class: 'vp-loading' }, [h('div', { class: 'spinner' })]);
    this.el.appendChild(this.loading);

    // 提示层
    this.tip = h('div', { class: 'vp-tip' });
    this.el.appendChild(this.tip);

    // 控制栏
    this._buildCtrl();

    // 交互
    this.el.addEventListener('mousemove', () => this._showCtrl());
    this.el.addEventListener('mouseleave', () => {
      if (!this.video.paused) this.el.classList.remove('active');
    });
    this.el.addEventListener('click', (e) => {
      if (e.target === this.video) this.toggle();
    });

    this._bindVideoEvents();
    this._bindTouch();
  }

  _buildCtrl() {
    this.prog = h('div', { class: 'vp-prog' });
    this.buf = h('div', { class: 'vp-buf' });
    this.dot = h('div', { class: 'vp-dot' });
    this.bar = h('div', { class: 'vp-bar' }, [this.buf, this.prog, this.dot]);

    this.timeEl = h('span', { class: 'vp-time', text: '00:00 / 00:00' });

    this.speedMenu = h('div', { class: 'vp-speed-menu' });
    [0.5, 0.75, 1, 1.25, 1.5, 2, 3].forEach((r) => {
      const item = h('div', { class: this._rate === r ? 'on' : '', onclick: () => {
        this.video.playbackRate = r;
        this._rate = r;
        this.speedMenu.querySelectorAll('div').forEach((d) => d.classList.remove('on'));
        item.classList.add('on');
        this.speedMenu.classList.remove('show');
        this._tip(r + '× 倍速');
      } }, [h('span', { text: r + '×' })]);
      this.speedMenu.appendChild(item);
    });

    this.ctrl = h('div', { class: 'vp-ctrl' }, [
      this.bar,
      h('div', { class: 'vp-row' }, [
        h('button', { html: ICON.playSm, onclick: () => this.toggle(), title: '播放/暂停 (空格)' }),
        h('button', { html: ICON.back10, onclick: () => this.seek(this.video.currentTime - 10), title: '后退10秒 (←)' }),
        h('button', { html: ICON.fwd10, onclick: () => this.seek(this.video.currentTime + 10), title: '前进10秒 (→)' }),
        h('div', { class: 'vp-vol' }, [
          h('button', { html: ICON.volume, onclick: () => this.mute(), title: '静音 (M)' }),
          h('input', {
            type: 'range', min: 0, max: 1, step: 0.05, value: 1,
            oninput: (e) => { this.video.volume = Number(e.target.value); this.video.muted = false; },
          }),
        ]),
        this.timeEl,
        h('div', { class: 'vp-spacer' }),
        h('button', { html: ICON.line, onclick: () => this._cycleLine(), title: '切换线路 (L)' }),
        h('div', { class: 'vp-speed' }, [
          h('button', { html: ICON.speed, onclick: (e) => { e.stopPropagation(); this.speedMenu.classList.toggle('show'); }, title: '倍速' }),
          this.speedMenu,
        ]),
        h('button', { html: ICON.pip, onclick: () => this.pip(), title: '画中画' }),
        h('button', { html: ICON.full, onclick: () => this.fullscreen(), title: '全屏 (F)' }),
      ]),
    ]);
    this.el.appendChild(this.ctrl);

    // 进度条拖动
    let dragging = false;
    const seekAt = (e) => {
      const r = this.bar.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const pct = Math.max(0, Math.min(1, x / r.width));
      const dur = this.video.duration || 0;
      this.prog.style.width = pct * 100 + '%';
      this.dot.style.left = pct * 100 + '%';
      return pct * dur;
    };
    const onMove = (e) => { if (dragging) seekAt(e); };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const t = seekAt(e);
      if (isFinite(t)) this.video.currentTime = t;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
    this.bar.addEventListener('mousedown', (e) => { dragging = true; this._showCtrl(); seekAt(e); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); });
    this.bar.addEventListener('touchstart', (e) => { dragging = true; seekAt(e); document.addEventListener('touchmove', onMove, { passive: true }); document.addEventListener('touchend', onUp); });
  }

  /* ---------------- 视频事件 ---------------- */
  _bindVideoEvents() {
    const v = this.video;
    v.addEventListener('play', () => {
      this.center.classList.remove('show');
      const btn = this.ctrl.querySelector('.vp-row button');
      if (btn) btn.innerHTML = ICON.pauseSm;
    });
    v.addEventListener('pause', () => {
      this.center.classList.add('show');
      const btn = this.ctrl.querySelector('.vp-row button');
      if (btn) btn.innerHTML = ICON.playSm;
    });
    v.addEventListener('waiting', () => this.loading.classList.add('show'));
    v.addEventListener('playing', () => { this.loading.classList.remove('show'); this.failCount = 0; this._userPaused = false; this._nudged = false; this._hardRestart = 0; });
    // 🔴 直播上古 bug 兜底：hls.js 的 recoverMediaError / 引擎重建会触发 video.load()
    //    （emptied），把 autoplay 的 play() 打断。非用户主动暂停时自动续播一次，
    //    否则直播表现为「画面停在第一帧 / 黑屏，永远暂停」。
    v.addEventListener('emptied', () => {
      if (this._destroyed) return;
      if (this.opts.autoplay === false || this._userPaused) return;
      const now = Date.now();
      if (now - (this._lastKick || 0) < 500) return;   // 节流：引擎重建风暴时不叠加 kick
      this._lastKick = now;
      const kick = () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); };
      if (v.readyState >= 2) kick();
      else v.addEventListener('canplay', kick, { once: true });
    });
    v.addEventListener('canplay', () => this.loading.classList.remove('show'));
    v.addEventListener('timeupdate', () => this._updateProgress());
    v.addEventListener('progress', () => {
      if (v.buffered.length) {
        const end = v.buffered.end(v.buffered.length - 1);
        this.buf.style.width = (end / (v.duration || 1)) * 100 + '%';
      }
    });
    v.addEventListener('loadedmetadata', () => {
      this._updateProgress();
      // 恢复播放进度
      const saved = this.opts.guid ? ls.get('pos_' + this.opts.guid, 0) : 0;
      if (saved > 15 && saved < (v.duration || 1e9) - 30 && !this._restored) {
        this._restored = true;
        v.currentTime = saved;
        this._tip('已从 ' + fmtTime(saved) + ' 继续播放');
      }
      if (this.opts.startTime) v.currentTime = this.opts.startTime;
    });
    v.addEventListener('ended', () => {
      if (this.opts.guid) ls.del('pos_' + this.opts.guid);
      this.opts.onEnded && this.opts.onEnded();
    });
    v.addEventListener('error', () => this._handleError('视频播放错误'));
    v.addEventListener('volumechange', () => {
      const ic = this.ctrl.querySelector('.vp-vol button');
      ic.innerHTML = v.muted || v.volume === 0 ? ICON.mute : ICON.volume;
    });

    // 定期保存进度
    this._posTimer = setInterval(() => {
      if (this.opts.guid && !v.paused && v.currentTime > 5) {
        ls.set('pos_' + this.opts.guid, Math.floor(v.currentTime));
      }
    }, 5000);
  }

  _bindTouch() {
    let sx = 0, sy = 0, st = 0, moved = false;
    this.el.addEventListener('touchstart', (e) => {
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); moved = false;
    }, { passive: true });
    this.el.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) moved = true;
      // 音量（左侧垂直）
      if (Math.abs(dy) > 30 && Math.abs(dx) < 40 && sx < window.innerWidth / 2) {
        this.video.volume = Math.max(0, Math.min(1, this.video.volume - dy / 300));
        this._tip('音量 ' + Math.round(this.video.volume * 100) + '%');
      }
      // 亮度用滤镜模拟（右侧垂直）
      if (Math.abs(dy) > 30 && Math.abs(dx) < 40 && sx >= window.innerWidth / 2) {
        this._bright = Math.max(0.3, Math.min(1.6, (this._bright || 1) - dy / 400));
        this.video.style.filter = `brightness(${this._bright})`;
        this._tip('亮度 ' + Math.round(this._bright * 100) + '%');
      }
    }, { passive: true });
    this.el.addEventListener('touchend', (e) => {
      const dt = Date.now() - st;
      const dx = (e.changedTouches[0].clientX - sx);
      if (moved && Math.abs(dx) > 60 && dt < 500) {
        this.seek(this.video.currentTime + (dx > 0 ? 15 : -15));
        this._tip(dx > 0 ? '快进 15 秒' : '后退 15 秒');
      }
    });
  }

  _bindKeys() {
    this._keyHandler = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      switch (e.key) {
        case ' ': e.preventDefault(); this.toggle(); break;
        case 'ArrowLeft': this.seek(this.video.currentTime - 10); break;
        case 'ArrowRight': this.seek(this.video.currentTime + 10); break;
        case 'ArrowUp': e.preventDefault(); this.video.volume = Math.min(1, this.video.volume + 0.1); this._tip('音量 ' + Math.round(this.video.volume * 100) + '%'); break;
        case 'ArrowDown': e.preventDefault(); this.video.volume = Math.max(0, this.video.volume - 0.1); this._tip('音量 ' + Math.round(this.video.volume * 100) + '%'); break;
        case 'm': case 'M': this.mute(); break;
        case 'f': case 'F': this.fullscreen(); break;
        case 'l': case 'L': this._cycleLine(); break;
        case 'p': case 'P': this.pip(); break;
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  /* ---------------- 播放逻辑 ---------------- */
  async play(index = 0, { autoplay = true } = {}) {
    const line = this.lines[index];
    if (!line) return toast('没有可用线路', 'error');
    this.current = index;
    this.opts.onLineChange && this.opts.onLineChange(index, line);

    const url = line.src || line.url;
    const type = line.type || detectType(url);
    this.loading.classList.add('show');

    // 清理旧的
    this._destroyEngine();

    try {
      if (type === 'hls') {
        if (nativeHlsUsable()) {
          this.video.src = url;
        } else {
          const Hls = await ensureHls();
          if (!Hls || !Hls.isSupported()) {
            // hls.js 不可用（加载被拦 / MSE 缺失）→ 退回原生尝试
            this.video.src = url;
            if (autoplay) this.video.play().catch(() => {});
            return;
          }
          this.hls = new Hls({
            lowLatencyMode: false,
            // ⚠️ 关闭 Web Worker：hls.js 的 worker 走 blob: URL，
            //    在严格 CSP（script-src 无 blob:）或部分 WebView 下会被拦，
            //    表现为「无声无画」的黑屏。主线程解复用性能足够，稳定性优先。
            enableWorker: false,
            maxBufferLength: 30,
            maxMaxBufferLength: 120,
            maxBufferSize: 60 * 1000 * 1000,
            liveSyncDurationCount: 3,
            // 直播容错：分片抓取失败自动重试，且间隔递进避免雪崩
            fragLoadingMaxRetry: 8,
            fragLoadingRetryDelay: 500,
            fragLoadingMaxRetryTimeout: 12000,
            manifestLoadingMaxRetry: 6,
            levelLoadingMaxRetry: 6,
            // 直播拉流超时放宽，避免 CDN 抖动直接判死
            manifestLoadingTimeOut: 15000,
            levelLoadingTimeOut: 15000,
            fragLoadingTimeOut: 25000,
            startLevel: -1,          // 自动清晰度
            capLevelToPlayerSize: false,
            // 吞吐量自适应，保证流畅
            abrEwmaDefaultEstimate: 1000000,
            // 直播：从最新分片起播，减少首帧等待
            // 🔴 liveDurationInfinity：直播把 duration 设为 Infinity，
            //    避免滑动窗口 duration 更新与 appendBuffer 竞争 ——
            //    央视流会周期性触发 mediaSourceRequiresReset（appendBuffer 失败），
            //    表现为画面永远暂停/黑屏，即长期遗留的「直播打不开」bug。
            liveDurationInfinity: true,
            // 直播：允许回退重试已过期分片
            appendErrorMaxRetry: 5,
          });
          this.hls.loadSource(url);
          this.hls.attachMedia(this.video);
          this.hls.on(Hls.Events.ERROR, (evt, data) => {
            if (this._destroyed) return;   // 已销毁：忽略一切迟到的错误事件，
                                           // 否则会在这里重新 startLoad() 把流拉回来
            if (!data.fatal) return;   // 非致命错误 hls.js 自行处理，不干预
            // ⚠️ 直播场景网络抖动是常态（CDN 切节点、分片重试都会触发 NETWORK_ERROR）。
            //    因此这里必须用「连续失败」计数：只要中间成功拉到过数据就清零，
            //    否则累积计数会在播放稳定时被一次偶发抖动推过阈值 → 永久报错。
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR: {
                const n = ++this.failStreak;
                // 直播用渐进退避重启，避免频繁 startLoad 产生雪崩
                const delay = Math.min(1500 * n, 6000);
                clearTimeout(this._netTimer);
                this._netTimer = setTimeout(() => {
                  if (this.hls) { try { this.hls.startLoad(); } catch {} }
                }, delay);
                // 容忍度提高：连续 6 次网络失败才认为线路不可用
                if (n > 6) this._handleError('网络错误，尝试切换线路');
                break;
              }
              case Hls.ErrorTypes.MEDIA_ERROR: {
                // ⚠️ 上古 bug 修复（直播「黑屏永远暂停」）：
                //    央视流周期性抛 mediaSourceRequiresReset（appendBuffer 失败），
                //    recoverMediaError 内部 detach/attach 会触发 video.load()，
                //    无限循环打断 autoplay → 画面永远暂停。
                //    策略：① 节流 —— 1.2s 内不重复 recover；
                //          ② 升级 —— 连续无效改整引擎重建（liveDurationInfinity
                //             已消除大部分触发源，此处兜底）；
                //          ③ 直播不判死 —— 指数退避无限重建（2s→4s→…cap 15s），
                //             点播仍按原阈值判死。
                this.mediaStreak++;
                const now = Date.now();
                const isLive = !!this._hlsLive;
                // 先试「跳帧」：解码坏包（PIPELINE_ERROR_DECODE）时把进度往前拨 1s
                // 往往比重建整个引擎更快恢复，且不打断播放
                if (this.video.currentTime > 0 && !this._nudged) {
                  this._nudged = true;
                  try { this.video.currentTime += 1; } catch {}
                  try { this.hls.recoverMediaError(); } catch {}
                  break;
                }
                if (this._lastRec && now - this._lastRec < 1200) {
                  if (isLive) {
                    // 直播：重建引擎，退避间隔翻倍
                    this._hardRestart++;
                    const delay = Math.min(2000 * Math.pow(2, this._hardRestart - 1), 15000);
                    clearTimeout(this._netTimer);
                    this._netTimer = setTimeout(() => this.play(this.current, { autoplay: !this._userPaused }), delay);
                    break;
                  }
                  if (++this._hardRestart > 2) { this._handleError('媒体错误'); break; }
                  this._lastRec = now;
                  this.play(this.current, { autoplay: !this._userPaused });
                  break;
                }
                this._lastRec = now;
                try { this.hls.recoverMediaError(); } catch {}
                break;
              }
              default:
                this._handleError('播放失败');
            }
          });
          // 拉取成功即清零连续失败计数（关键：让偶发错误不再累积）
          const resetStreak = () => { this.failStreak = 0; this.mediaStreak = 0; };
          this.hls.on(Hls.Events.FRAG_LOADED, resetStreak);
          this.hls.on(Hls.Events.LEVEL_LOADED, resetStreak);
          this.hls.on(Hls.Events.FRAG_BUFFERED, resetStreak);
          // 动态缓冲调节：卡顿时加大缓冲
          this.hls.on(Hls.Events.LEVEL_LOADED, (evt, d) => {
            this._hlsLive = !!(d.details && d.details.live);   // 供 MEDIA_ERROR 分支区分直播/点播
            if (d.details && d.details.live) this.hls.config.liveSyncDurationCount = 3;
          });
          this.video._hls = this.hls;
        }
      } else if (type === 'flv') {
        const flvjs = await ensureFlv();
        if (!flvjs || !flvjs.isSupported()) throw new Error('FLV 不受支持');
        this.flv = flvjs.createPlayer({ type: 'flv', url, isLive: !!line.live }, {
          enableWorker: true,
          enableStashBuffer: false,
          stashInitialSize: 128,
          lazyLoad: false,
        });
        this.flv.attachMediaElement(this.video);
        this.flv.load();
        this.flv.on(flvjs.Events.ERROR, () => this._handleError('FLV 播放失败'));
      } else if (type === 'dash') {
        const dashjs = await ensureDash();
        if (!dashjs) throw new Error('DASH 不受支持');
        this.dash = dashjs.MediaPlayer().create();
        this.dash.initialize(this.video, url, autoplay);
        this.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
        this.dash.on('error', () => this._handleError('DASH 播放失败'));
      } else {
        this.video.src = url;
      }

      if (autoplay) {
        const p = this.video.play();
        if (p && p.catch) {
          p.catch((err) => {
            // 浏览器自动播放限制
            if (String(err).includes('NotAllowed')) {
              this.video.muted = true;
              this.video.play().catch(() => this._tip('点击画面开始播放'));
            }
          });
        }
      }
    } catch (e) {
      this._handleError(e.message || '加载失败');
    }
  }

  /** 自动切换线路（容灾） */
  _handleError(msg) {
    this.loading.classList.remove('show');
    if (this.failCount++ >= 3) {
      this.opts.onError && this.opts.onError(new Error(msg));
      return toast(msg + '，已停止重试', 'error');
    }
    if (this.opts.autoFailover !== false && this.lines.length > 1) {
      const next = (this.current + 1) % this.lines.length;
      this._tip('线路异常，自动切换至备用线路…');
      toast('自动切换线路：' + (this.lines[next].name || ('线路' + (next + 1))), 'info');
      this.opts.onFailover && this.opts.onFailover(next);
      setTimeout(() => this.play(next, { autoplay: true }), 600);
    } else {
      toast(msg, 'error');
      this.opts.onError && this.opts.onError(new Error(msg));
    }
  }

  _destroyEngine() {
    // ⚠️ 顺序很重要：先 stopLoad() 让 hls.js 停止调度新的分片请求，
    //    再 destroy()。只调 destroy() 时，已在队列里的分片请求仍会被发出，
    //    导致「页面已离开，后台还在按分片周期拉流」。
    if (this.hls) {
      try { this.hls.stopLoad(); } catch {}
      try { this.hls.detachMedia(); } catch {}
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    if (this.flv) { try { this.flv.unload(); } catch {} try { this.flv.detachMedia(); } catch {} try { this.flv.destroy(); } catch {} this.flv = null; }
    if (this.dash) { try { this.dash.reset(); } catch {} this.dash = null; }
    // 清掉 video 上可能残留的 hls 引用，避免后续逻辑误用已销毁实例
    try { if (this.video) delete this.video._hls; } catch {}
  }

  /** 切换线路 */
  switchLine(index) {
    this.failCount = 0;
    this.failStreak = 0;
    this.mediaStreak = 0;
    this.play(index, { autoplay: true });
  }

  _cycleLine() {
    if (this.lines.length <= 1) return this._tip('暂无其他线路');
    const next = (this.current + 1) % this.lines.length;
    this.switchLine(next);
    this._tip('已切换：' + (this.lines[next].name || ('线路' + (next + 1))));
  }

  /* ---------------- 控件动作 ---------------- */
  toggle() {
    // 记录是否用户主动暂停：hls 内部 load() 重置后据此决定是否自动续播
    if (this.video.paused) { this._userPaused = false; this.video.play().catch(() => {}); }
    else { this._userPaused = true; this.video.pause(); }
  }
  seek(t) {
    if (!isFinite(this.video.duration)) return;
    this.video.currentTime = Math.max(0, Math.min(this.video.duration, t));
    this._showCtrl();
  }
  mute() { this.video.muted = !this.video.muted; }
  async pip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch { this._tip('画中画不可用'); }
  }
  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (this.el.requestFullscreen) this.el.requestFullscreen();
    else if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen();
  }

  _updateProgress() {
    const v = this.video;
    const dur = v.duration || 0;
    const pct = dur ? (v.currentTime / dur) * 100 : 0;
    this.prog.style.width = pct + '%';
    this.dot.style.left = pct + '%';
    this.timeEl.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(dur)}`;
  }

  _showCtrl() {
    this.el.classList.add('active');
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      if (!this.video.paused) this.el.classList.remove('active');
    }, 2800);
  }

  _tip(msg) {
    this.tip.textContent = msg;
    this.tip.classList.add('show');
    clearTimeout(this._tipTimer);
    this._tipTimer = setTimeout(() => this.tip.classList.remove('show'), 1500);
  }

  destroy() {
    clearInterval(this._posTimer);
    clearTimeout(this._hideTimer);
    clearTimeout(this._tipTimer);
    clearTimeout(this._netTimer);
    document.removeEventListener('keydown', this._keyHandler);
    this._destroyed = true;   // ⚠️ 必须先置位：让所有异步回调（ERROR 处理器、
                              //    emptied 兜底、定时器）立即失效，防止它们
                              //    在销毁过程中重新 startLoad() / play() 把流拉回来

    // 顺序：① 先拆引擎（停止调度新分片）→ ② 再停 video（释放解码器与音频输出）。
    // 反过来做的话，video.load() 会和引擎销毁竞争，反而多发出一批请求。
    this._destroyEngine();

    // ② 停掉 <video> 本身。
    //    只 hls.destroy() 不够 —— video 元素仍可能输出残留音频，
    //    表现为「人离开播放页了，声音还在一卡一卡地响」。
    try {
      const v = this.video;
      if (v) {
        v.pause();
        v.muted = true;
        v.removeAttribute('src');
        try { [...v.querySelectorAll('source')].forEach((s) => s.remove()); } catch {}
        v.load();          // 触发资源释放，停止一切后台拉流/解码
      }
    } catch {}

    this.el.innerHTML = '';
  }
}

/* ---------------- 图标 ---------------- */
export const ICON = {
  play: '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  playSm: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pauseSm: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  back10: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 19l-9-7 9-7v14z"/><path d="M22 19l-9-7 9-7v14z"/></svg>',
  fwd10: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 19l9-7-9-7v14z"/><path d="M2 19l9-7-9-7v14z"/></svg>',
  volume: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  mute: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
  line: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>',
  speed: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 12l4-3"/></svg>',
  pip: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor"/></svg>',
  full: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
};
