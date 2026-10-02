'use strict';
/**
 * 慈云影视 · 统一源适配层（Multi-Source Adapter）
 * ============================================================
 * 目标：用一套统一数据结构屏蔽各种上游源的差异，实现「多源可切换」。
 *
 * 支持的上游协议：
 *   1. maccms-json  苹果CMS JSON  /api.php/provide/vod/?ac=detail
 *   2. maccms-xml   苹果CMS XML   /api.php/provide/vod/at/xml/
 *   3. cctv         央视官方公开接口（内置）
 *   4. m3u          M3U / M3U8 播放列表（直播源订阅）
 *   5. direct       单个直链（HLS/FLV/MP4/DASH）
 *   6. custom       自定义 JSON 接口（可配置字段映射）
 *
 * 统一输出结构：
 *   分类   : { id, name }
 *   条目   : { id, name, pic, remarks, year, area, type, content, source, lines[] }
 *   线路   : { name, episodes: [{ name, url }] }
 */

const cctv = require('./cctv');
const { requestText, parseAuto, parseXML, cached, monitored } = require('./cctv');
const { URL } = require('url');

/* ============================================================
 * 通用工具
 * ============================================================ */

/** 规范化 base url：补全协议、去掉末尾斜杠 */
function normBase(api) {
  let u = String(api || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

/** 区分苹果CMS JSON / XML */
function detectMaccmsType(api) {
  const u = api.toLowerCase();
  if (u.includes('/at/xml') || u.endsWith('.xml') || u.includes('xml.php')) return 'maccms-xml';
  return 'maccms-json';
}

/** 解析 vid 列表
 *  苹果CMS 的 vod_play_url 形如：
 *   "第01集$http://a.m3u8#第02集$http://b.m3u8$$$线路2$http://c.m3u8"
 *   "$$$" 分线路，"#" 分集，"$" 分「名称+地址」
 */
function parsePlayUrl(playUrl, playFrom) {
  if (!playUrl) return [];
  const froms = String(playFrom || '')
    .split('$$$')
    .map((s) => s.trim())
    .filter(Boolean);
  const groups = String(playUrl).split('$$$');
  const lines = [];
  groups.forEach((g, gi) => {
    const eps = [];
    g.split('#').forEach((seg) => {
      const t = seg.trim();
      if (!t) return;
      // 名称$地址 或 纯地址
      const idx = t.indexOf('$');
      let name, url;
      if (idx > 0) {
        name = t.slice(0, idx).trim();
        url = t.slice(idx + 1).trim();
      } else {
        url = t;
        name = '第 ' + (eps.length + 1) + ' 集';
      }
      if (!/^https?:\/\//i.test(url)) return; // 跳过 m3u8 解析类地址（需专门解析器）
      eps.push({ name: name || '第 ' + (eps.length + 1) + ' 集', url });
    });
    if (eps.length) {
      lines.push({ name: froms[gi] || `线路${gi + 1}`, episodes: eps });
    }
  });
  return lines;
}

/** 判断是否为需要服务端解析的地址（非直链） */
function isDirectUrl(u) {
  return /^https?:\/\/[^\s]+\.(m3u8|flv|mp4|mpd|ts|mkv|webm)(\?|$)/i.test(u) || /^https?:\/\//i.test(u);
}

/* ============================================================
 * 适配器：苹果CMS（JSON / XML）
 * ============================================================ */
const maccms = {
  type: 'maccms',

  async categories(src) {
    const base = normBase(src.url);
    const url = `${base}?ac=class`;
    const key = `ms-cat:${base}`;
    return cached(key, 30 * 60 * 1000, () =>
      monitored('maccms:class', async () => {
        const txt = await requestText(url, { headers: src.config?.header || {} });
        const j = parseAuto(txt);
        let list = (j && j.class) || (j && j.data && j.data.class) || [];
        let cats = list.map((c) => ({
          id: String(c.type_id ?? c.id),
          name: String(c.type_name ?? c.name),
        })).filter((c) => c.id && c.name);

        // ⚠️ 部分采集站 ac=class 已失效：返回的是「视频列表」而非分类表。
        //    特征：没有 class 字段，但带了 list 数组。此时放弃该接口，
        //    改为扫描列表数据的 type_id（子分类）+ type_id_1（父分类）反推分类。
        //    两级都要收：查询接口的 t 参数对两级 ID 都生效，只收一级会漏掉大类。
        if (!cats.length) {
          const seen = new Map();          // id -> name
          const addFrom = (v) => {
            const sub = String(v.type_id ?? v.typeId ?? '');
            const subName = String(v.type_name ?? v.typeName ?? '');
            if (sub && subName && !seen.has(sub)) seen.set(sub, subName);
            const par = String(v.type_id_1 ?? v.typeId1 ?? '');
            const parName = String(v.type_name_1 ?? v.typeName1 ?? '');
            if (par && parName && !seen.has(par)) seen.set(par, parName);
          };

          // 用 detail 接口取首页（只有它返回 type_id_1 父分类字段）
          const grab = async (q) => {
            try {
              const t = await requestText(`${base}?${q}`, { headers: src.config?.header || {} });
              const jj = parseAuto(t);
              const vs = (jj && jj.list) || (jj && jj.data && jj.data.list) || [];
              vs.forEach(addFrom);
            } catch { /* 单次失败不影响整体 */ }
          };

          await grab('ac=detail&pg=1');
          // 样本不足时补几页，提高分类覆盖率
          if (seen.size < 24) {
            for (const pg of [2, 3, 4, 5]) {
              if (seen.size >= 30) break;
              await grab(`ac=detail&pg=${pg}`);
            }
          }
          cats = [...seen].map(([id, name]) => ({ id, name }));
        }
        return cats;
      })
    );
  },

  async list(src, { typeId = '', page = 1, keyword = '' } = {}) {
    const base = normBase(src.url);
    const key = `ms-list:${base}:${typeId}:${page}:${keyword}`;
    return cached(key, 5 * 60 * 1000, () =>
      monitored('maccms:list', async () => {
        const q = (t, pg) => {
          const params = new URLSearchParams();
          params.set('ac', keyword ? 'videolist' : 'list'); // 搜索用 videolist
          if (t) params.set('t', String(t));
          params.set('pg', String(pg));
          if (keyword) params.set('wd', keyword);
          if (src.config?.at) params.set('at', src.config.at);
          return `${base}?${params.toString()}`;
        };
        const fetchPage = async (t, pg) => {
          const txt = await requestText(q(t, pg), { headers: src.config?.header || {} });
          const j = parseAuto(txt);
          let raw = (j && j.list) || (j && j.data && j.data.list) || [];
          if (!raw.length && j && j.__xml) raw = j.__xml;
          return {
            page: Number(j.page || j.data?.page || pg) || pg,
            pageCount: Number(j.pagecount || j.data?.pagecount || 0) || 0,
            total: Number(j.total || j.data?.total || 0) || 0,
            list: raw.map((v) => normalizeMaccms(v, src.id)).filter((v) => v.id && v.name),
          };
        };

        const r0 = await fetchPage(typeId, page);

        // ⚠️ 父分类为空兜底：部分采集站的父分类（如「动漫」t=4）自身没有直挂数据，
        //    数据全在子分类（中国动漫/日本动漫/欧美动漫/动漫电影）下。
        //    此时把该父分类的子分类结果合并返回，否则页面会显示「暂无内容」。
        if (typeId && !keyword && r0.list.length === 0) {
          const kids = await childTypeIds(base, typeId, src.config?.header || {});
          if (kids.length) {
            const all = [];
            let total = 0;
            for (const k of kids) {
              try {
                const rk = await fetchPage(k, page);
                total += rk.total;
                all.push(...rk.list);
              } catch { /* 单个子分类失败不影响整体 */ }
            }
            if (all.length) {
              return { page, pageCount: 0, total: total || all.length, list: all, aggregated: true };
            }
          }
        }
        return r0;
      })
    );
  },

  async detail(src, ids) {
    const base = normBase(src.url);
    const key = `ms-detail:${base}:${ids}`;
    return cached(key, 30 * 60 * 1000, () =>
      monitored('maccms:detail', async () => {
        const url = `${base}?ac=detail&ids=${encodeURIComponent(ids)}`;
        const txt = await requestText(url, { headers: src.config?.header || {} });
        const j = parseAuto(txt);
        let raw = (j && j.list) || (j && j.data && j.data.list) || [];
        if (!raw.length && j && j.__xml) raw = j.__xml;
        if (!raw.length) throw new Error('详情为空');
        return normalizeMaccms(raw[0], src.id, true);
      })
    );
  },
};

/**
 * 依据「数据里的 type_id_1（父）→ type_id（子）」关系，反推某个父分类的所有子分类 ID。
 * 用于父分类无直挂数据时的聚合兜底。
 * @param {string} base 源接口基址
 * @param {string} parentId 父分类 ID
 * @param {object} headers 请求头
 * @returns {Promise<string[]>}
 */
async function childTypeIds(base, parentId, headers = {}) {
  const kids = new Set();
  try {
    // detail 接口才返回 type_id_1，抓几页以覆盖足够宽的子分类
    for (const pg of [1, 2, 3, 4, 5, 6]) {
      if (kids.size >= 8) break;
      let txt;
      try {
        txt = await requestText(`${base}?ac=detail&pg=${pg}`, { headers });
      } catch { continue; }
      const j = parseAuto(txt);
      const vs = (j && j.list) || (j && j.data && j.data.list) || [];
      for (const v of vs) {
        const sub = String(v.type_id ?? '');
        const par = String(v.type_id_1 ?? '');
        if (sub && par === String(parentId)) kids.add(sub);
      }
    }
  } catch { /* 兜底失败则返回空数组，调用方按原样返回空列表 */ }
  return [...kids];
}

function normalizeMaccms(v, sourceId, withDetail = false) {
  const out = {
    id: String(v.vod_id ?? v.id ?? ''),
    name: String(v.vod_name ?? v.name ?? '').trim(),
    pic: String(v.vod_pic ?? v.pic ?? ''),
    remarks: String(v.vod_remarks ?? v.remarks ?? ''),
    year: String(v.vod_year ?? v.year ?? ''),
    area: String(v.vod_area ?? v.area ?? ''),
    typeName: String(v.type_name ?? v.typeName ?? ''),
    actor: String(v.vod_actor ?? ''),
    director: String(v.vod_director ?? ''),
    content: String(v.vod_content ?? v.vod_blurb ?? v.content ?? '').replace(/<[^>]+>/g, ''),
    score: String(v.vod_score ?? ''),
    source: sourceId,
    lines: [],
  };
  if (withDetail) {
    out.lines = parsePlayUrl(v.vod_play_url, v.vod_play_from);
  }
  return out;
}

/* ============================================================
 * 适配器：央视官方
 * ============================================================ */
const cctvAdapter = {
  type: 'cctv',

  async categories() {
    const { store } = require('./store');
    return store.categories.map((c) => ({ id: c.id, name: c.name }));
  },

  async list(src, { typeId = '', page = 1, keyword = '' } = {}) {
    const { store } = require('./store');
    if (keyword) {
      const r = await cctv.search(keyword, { page });
      return {
        page,
        pageCount: 1,
        total: r.list.length,
        list: r.list.map((v) => ({
          id: v.guid,
          name: v.title,
          pic: v.image,
          remarks: '',
          year: '',
          typeName: '',
          content: v.brief || '',
          source: src.id,
          lines: [],
        })),
      };
    }
    // 按分类列出栏目
    let cols = store.getColumns().filter((c) => c.enabled !== false);
    if (typeId && typeId !== 'all' && typeId !== '0') cols = cols.filter((c) => c.category === typeId);
    const size = 24;
    const items = cols.slice((page - 1) * size, page * size);
    return {
      page,
      pageCount: Math.ceil(cols.length / size),
      total: cols.length,
      list: items.map((c) => ({
        id: 'col:' + c.id,
        name: c.name,
        pic: '',
        remarks: (c.total || 0) + ' 期',
        year: '',
        typeName: c.category,
        content: '',
        source: src.id,
        isColumn: true,
        lines: [],
      })),
    };
  },

  async detail(src, id) {
    // 栏目：列出栏目下视频
    if (String(id).startsWith('col:')) {
      const { store } = require('./store');
      const colId = String(id).slice(4);
      const col = store.getColumns().find((c) => c.id === colId);
      if (!col) throw new Error('栏目不存在');
      const d = await cctv.getColumnVideos(col.ctid, { p: 1, n: 60 });
      return {
        id,
        name: col.name,
        pic: d.list[0]?.image || '',
        remarks: (d.total || 0) + ' 期',
        content: '央视网公开栏目 · ' + col.name,
        typeName: col.category,
        source: src.id,
        isColumn: true,
        lines: [
          {
            name: '选集',
            episodes: d.list.map((v, i) => ({
              name: v.title.replace(/^《[^》]+》\s*/, '') || '第 ' + (i + 1) + ' 期',
              url: v.guid,
              guid: v.guid,
              image: v.image,
              length: v.length,
            })),
          },
        ],
      };
    }
    // 单视频
    const info = await cctv.getPlayInfo(id);
    return {
      id,
      name: info.title,
      pic: info.image,
      remarks: info.duration || '',
      content: '',
      source: src.id,
      lines: [{ name: '默认线路', episodes: [{ name: info.title.slice(0, 20), url: id, guid: id }] }],
    };
  },
};

/* ============================================================
 * 适配器：M3U / M3U8 订阅
 * ============================================================ */
const m3uAdapter = {
  type: 'm3u',

  async parse(src) {
    const key = `m3u:${src.url}`;
    return cached(key, 15 * 60 * 1000, () =>
      monitored('m3u:parse', async () => {
        const txt = await requestText(src.url, { headers: src.config?.header || {} });
        return parseM3U(txt, src.url);
      })
    );
  },

  async categories(src) {
    const { groups } = await this.parse(src);
    return groups.map((g, i) => ({ id: String(i), name: g.name }));
  },

  async list(src, { typeId = '0', page = 1, keyword = '' } = {}) {
    const { groups } = await this.parse(src);
    let entries = [];
    if (typeId !== '' && typeId !== 'all' && groups[Number(typeId)]) {
      entries = groups[Number(typeId)].channels;
    } else {
      entries = groups.flatMap((g) => g.channels);
    }
    if (keyword) {
      const k = keyword.toLowerCase();
      entries = entries.filter((c) => c.name.toLowerCase().includes(k));
    }
    return {
      page,
      pageCount: 1,
      total: entries.length,
      list: entries.map((c, i) => ({
        id: String(i) + '@' + c.name,
        name: c.name,
        pic: c.logo || '',
        remarks: c.group || '',
        typeName: c.group || '',
        content: '',
        source: src.id,
        lines: [{ name: '直播线路', episodes: [{ name: c.name, url: c.url, live: true }] }],
      })),
    };
  },

  async detail(src, id) {
    const { groups } = await this.parse(src);
    const all = groups.flatMap((g) => g.channels);
    const idx = parseInt(String(id).split('@')[0], 10);
    const ch = all[idx];
    if (!ch) throw new Error('频道不存在');
    return {
      id,
      name: ch.name,
      pic: ch.logo || '',
      content: ch.group || '',
      source: src.id,
      isLive: true,
      lines: [{ name: '直播线路', episodes: [{ name: ch.name, url: ch.url, live: true }] }],
    };
  },
};

/** 解析 M3U 文本 */
function parseM3U(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const groupsMap = new Map();
  let cur = null;
  const push = (ch) => {
    if (!groupsMap.has(ch.group || '未分组')) groupsMap.set(ch.group || '未分组', []);
    groupsMap.get(ch.group || '未分组').push(ch);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const nameM = /,(.+)$/.exec(line);
      const logoM = /tvg-logo="([^"]*)"/i.exec(line);
      const grpM = /group-title="([^"]*)"/i.exec(line);
      const idM = /tvg-id="([^"]*)"/i.exec(line);
      cur = {
        name: (nameM ? nameM[1] : '').trim(),
        logo: logoM ? logoM[1] : '',
        group: grpM ? grpM[1] : '',
        tvgId: idM ? idM[1] : '',
        url: '',
      };
    } else if (line.startsWith('#EXTGRP:')) {
      if (cur) cur.group = line.slice(8).trim();
    } else if (!line.startsWith('#')) {
      let url = line;
      try {
        url = new URL(line, baseUrl).toString();
      } catch {}
      if (cur) {
        cur.url = url;
        if (!cur.name) cur.name = '频道 ' + (groupsMap.size + 1);
        push(cur);
        cur = null;
      }
    }
  }
  const groups = [...groupsMap.entries()].map(([name, channels]) => ({ name, channels }));
  // 频道数为 0 的组过滤
  return { groups: groups.filter((g) => g.channels.length) };
}

/* ============================================================
 * 适配器：直链
 * ============================================================ */
const directAdapter = {
  type: 'direct',
  async categories() {
    return [{ id: '0', name: '直链内容' }];
  },
  async list(src) {
    return {
      page: 1,
      pageCount: 1,
      total: 1,
      list: [{
        id: 'direct',
        name: src.name,
        pic: '',
        remarks: detectKind(src.url),
        typeName: '直链',
        content: '',
        source: src.id,
        lines: [{ name: '直连线路', episodes: [{ name: src.name, url: src.url, live: /\.m3u8/i.test(src.url) && src.config?.live }] }],
      }],
    };
  },
  async detail(src) {
    return (await this.list(src)).list[0];
  },
};

function detectKind(u) {
  if (/\.m3u8?/i.test(u)) return 'HLS (m3u8)';
  if (/\.flv/i.test(u)) return 'HTTP-FLV';
  if (/\.mpd/i.test(u)) return 'DASH';
  if (/\.mp4/i.test(u)) return 'MP4';
  return '未知';
}

/* ============================================================
 * 适配器：自定义 JSON 接口
 * ============================================================ */
const customAdapter = {
  type: 'custom',

  async _fetch(src, extra = '') {
    const url = src.url + extra;
    const txt = await requestText(url, { headers: src.config?.header || {} });
    return parseAuto(txt);
  },

  /** 从 JSON 中按路径取值，如 "data.list" */
  _pick(obj, path) {
    if (!path) return obj;
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  },

  async categories(src) {
    const cfg = src.config || {};
    if (!cfg.catPath) return [{ id: '0', name: '全部' }];
    const j = await this._fetch(src, cfg.catQuery || '');
    const arr = this._pick(j, cfg.catPath) || [];
    return arr.map((x) => ({
      id: String(x[cfg.catIdKey || 'id']),
      name: String(x[cfg.catNameKey || 'name']),
    }));
  },

  async list(src, { typeId = '', page = 1, keyword = '' } = {}) {
    const cfg = src.config || {};
    let q = cfg.listQuery || '';
    q = q.replace('{page}', page).replace('{type}', typeId).replace('{wd}', encodeURIComponent(keyword));
    const j = await this._fetch(src, q);
    const arr = this._pick(j, cfg.listPath || 'list') || [];
    return {
      page,
      pageCount: Number(this._pick(j, cfg.pageCountPath || '') || 1) || 1,
      total: arr.length,
      list: arr.map((x) => ({
        id: String(x[cfg.idKey || 'id']),
        name: String(x[cfg.nameKey || 'name']),
        pic: String(x[cfg.picKey || 'pic'] || ''),
        remarks: String(x[cfg.remarksKey || 'remarks'] || ''),
        typeName: '',
        content: '',
        source: src.id,
        lines: [],
      })),
    };
  },

  async detail(src, id) {
    const cfg = src.config || {};
    let q = cfg.detailQuery || ('?ac=detail&ids=' + encodeURIComponent(id));
    q = q.replace('{id}', encodeURIComponent(id));
    const j = await this._fetch(src, q);
    const arr = this._pick(j, cfg.listPath || 'list') || [];
    const v = Array.isArray(arr) ? arr[0] : arr;
    if (!v) throw new Error('详情为空');
    return {
      id,
      name: String(v[cfg.nameKey || 'name'] || ''),
      pic: String(v[cfg.picKey || 'pic'] || ''),
      content: String(v[cfg.contentKey || 'content'] || ''),
      source: src.id,
      lines: parsePlayUrl(v[cfg.playUrlKey || 'play_url'], v[cfg.playFromKey || 'play_from']),
    };
  },
};

/* ============================================================
 * 适配器注册表 & 统一入口
 * ============================================================ */
const ADAPTERS = {
  'maccms-json': maccms,
  'maccms-xml': maccms,
  maccms,
  cctv: cctvAdapter,
  m3u: m3uAdapter,
  direct: directAdapter,
  custom: customAdapter,
};

/** 自动推断源类型 */
function inferType(src) {
  if (src.type && ADAPTERS[src.type]) return src.type;
  const u = (src.url || '').toLowerCase();
  if (!u) return 'cctv';
  if (u.startsWith('csp_')) return 'custom';
  if (/\.m3u8?(\?|$)/.test(u) && (u.includes('live') || u.includes('tv') || u.includes('iptv'))) return 'm3u';
  if (/\.m3u8?(\?|$)/.test(u)) return 'm3u';
  if (/api\.php|provide\/vod|ac=/.test(u)) return detectMaccmsType(u);
  if (/\.(mp4|flv|mpd)($|\?)/.test(u)) return 'direct';
  return 'custom';
}

function getAdapter(src) {
  const t = inferType(src);
  return { type: t, adapter: ADAPTERS[t] || customAdapter };
}

/**
 * 统一调用入口
 * @param {object} src   源配置 { id, name, type, url, config }
 * @param {string} action 'categories' | 'list' | 'detail'
 * @param {object} params
 */
async function call(src, action, params = {}) {
  const { adapter } = getAdapter(src);
  if (typeof adapter[action] !== 'function') {
    throw new Error(`源 ${src.name} 不支持操作 ${action}`);
  }
  return adapter[action](src, ...(action === 'detail' ? [params.id] : [params]));
}

/** 给单源请求加超时兜底：慢源不阻塞整体搜索 */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** 多源聚合搜索 */
async function searchAll(sources, keyword, { page = 1, timeout = 6000 } = {}) {
  const enabled = sources.filter((s) => s.enabled !== false);
  const results = await Promise.allSettled(
    enabled.map(async (src) => {
      const meta = { source: { id: src.id, name: src.name } };
      try {
        // 单源超时：某个源挂了/慢，直接放弃它，不拖累其他源返回
        const r = await withTimeout(call(src, 'list', { keyword, page }), timeout, null);
        if (!r) return { ...meta, list: [], error: 'timeout' };
        return { ...meta, list: r.list || [] };
      } catch (e) {
        return { ...meta, list: [], error: e.message };
      }
    })
  );
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { source: null, list: [] }));
}

module.exports = {
  call,
  getAdapter,
  inferType,
  searchAll,
  parsePlayUrl,
  parseM3U,
  normBase,
  detectMaccmsType,
  ADAPTERS,
};
