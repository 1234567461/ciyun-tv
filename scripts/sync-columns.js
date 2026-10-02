'use strict';
/**
 * 慈云影视 —— 央视官方栏目库同步脚本
 *
 * 数据来源（全部为央视公开接口，无鉴权、无爬取风险）：
 *   1. https://api.cntv.cn/lanmu/columnSearch   —— 官方栏目清单（352 个栏目，含分类/频道/官网地址）
 *   2. 各栏目官网页（column_website）             —— 提取真实 TOPC 栏目 ID
 *   3. https://api.cntv.cn/NewVideo/getVideoListByColumn —— 逐个实测，只保留真正有内容的栏目
 *
 * 产出：data/columns.json（前端直接消费的栏目库）
 *
 * 运行：node scripts/sync-columns.js
 *       node scripts/sync-columns.js --no-verify   # 跳过实测，加快速度
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'columns.json');

const VERIFY = !process.argv.includes('--no-verify');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** 品类定义 */
const CATEGORIES = [
  { id: 'news', name: '新闻时事', icon: '📰', desc: '权威新闻 · 时事评论 · 深度调查' },
  { id: 'documentary', name: '纪录片', icon: '🎬', desc: '探索发现 · 人文历史 · 自然地理 · 军事' },
  { id: 'movie', name: '影视剧场', icon: '🍿', desc: '电视剧 · 电影 · 影视评论' },
  { id: 'anime', name: '动画少儿', icon: '🧸', desc: '动画片 · 少儿节目 · 亲子' },
  { id: 'variety', name: '综艺娱乐', icon: '🎤', desc: '综艺晚会 · 音乐 · 访谈' },
  { id: 'sports', name: '体育赛事', icon: '⚽', desc: '体育赛事 · 足球篮球 · 奥运' },
  { id: 'culture', name: '文化戏曲', icon: '🏮', desc: '百家讲坛 · 戏曲 · 传统文化' },
  { id: 'finance', name: '财经商业', icon: '📈', desc: '财经资讯 · 消费 · 创业' },
  { id: 'life', name: '生活美食', icon: '🍜', desc: '健康养生 · 美食 · 田园 · 农业' },
  { id: 'other', name: '其他', icon: '📦', desc: '综合内容' },
];

/** 央视官方一级分类 → 本站品类 */
const CAT_MAP = {
  新闻: 'news', 法治: 'news', 经济: 'finance',
  科教: 'documentary', 纪实: 'documentary', 军事: 'documentary',
  综艺: 'variety', 音乐: 'variety',
  体育: 'sports',
  戏曲: 'culture',
  少儿: 'anime', 动画: 'anime', 青少: 'anime',
  电影电视剧: 'movie',
  生活: 'life', 健康: 'life', 农业: 'life', 乡村故事: 'life',
};

/** 直播频道（央视开路频道） */
const LIVE_CHANNELS = [
  { id: 'cctv1', name: 'CCTV-1 综合', icon: '1️⃣' },
  { id: 'cctv2', name: 'CCTV-2 财经', icon: '2️⃣' },
  { id: 'cctv3', name: 'CCTV-3 综艺', icon: '3️⃣' },
  { id: 'cctv4', name: 'CCTV-4 中文国际', icon: '4️⃣' },
  { id: 'cctv5', name: 'CCTV-5 体育', icon: '5️⃣' },
  { id: 'cctv6', name: 'CCTV-6 电影', icon: '6️⃣' },
  { id: 'cctv7', name: 'CCTV-7 国防军事', icon: '7️⃣' },
  { id: 'cctv8', name: 'CCTV-8 电视剧', icon: '8️⃣' },
  { id: 'cctv9', name: 'CCTV-9 纪录', icon: '9️⃣' },
  { id: 'cctv10', name: 'CCTV-10 科教', icon: '🔟' },
  { id: 'cctv11', name: 'CCTV-11 戏曲', icon: '🎭' },
  { id: 'cctv12', name: 'CCTV-12 社会与法', icon: '⚖️' },
  { id: 'cctv13', name: 'CCTV-13 新闻', icon: '📡' },
  { id: 'cctv15', name: 'CCTV-15 音乐', icon: '🎵' },
  { id: 'cctv16', name: 'CCTV-16 奥林匹克', icon: '🏅' },
  { id: 'cctv17', name: 'CCTV-17 农业农村', icon: '🌾' },
];

/* ------------------------------------------------------------------ */

function request(url, { timeout = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return resolve(request(next, { timeout, redirects: redirects - 1 }));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function parseJsonp(txt) {
  const t = String(txt || '').trim();
  const m = t.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
  try {
    return JSON.parse(m ? m[1] : t);
  } catch {
    return null;
  }
}

/** 并发池 */
async function pool(items, worker, concurrency = 10) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/* ------------------------------------------------------------------ */

/** 1. 拉取官方栏目清单（352 个） */
async function fetchCatalog() {
  const all = new Map();
  for (let p = 1; p <= 4; p++) {
    const url = `https://api.cntv.cn/lanmu/columnSearch?&fl=&p=${p}&n=100&serviceId=tvcctv&t=jsonp&cb=x`;
    const j = parseJsonp(await request(url));
    const docs = (j && j.response && j.response.docs) || [];
    for (const d of docs) all.set(d.column_id, d);
  }
  return [...all.values()];
}

/** 2. 从栏目官网页提取真实 TOPC id */
async function findTopc(doc) {
  const site = doc.column_website || '';
  if (!/^https?:/.test(site)) return null;
  let html;
  try {
    html = await request(site);
  } catch {
    return null;
  }
  const ids = html.match(/TOPC\d+/g);
  if (!ids || !ids.length) return null;
  // 取出现次数最多的作为主栏目 id
  const freq = {};
  for (const id of ids) freq[id] = (freq[id] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
}

/** 3. 实测：该栏目是否真有内容 */
async function probe(ctid) {
  const url =
    `https://api.cntv.cn/NewVideo/getVideoListByColumn?id=${encodeURIComponent(ctid)}` +
    `&n=2&sort=desc&p=1&mode=0&serviceId=tvcctv`;
  const j = parseJsonp(await request(url));
  const data = (j && j.data) || {};
  const list = data.list || [];
  if (!data.total || !list.length) return null;
  const first = list[0];
  return { total: data.total, guid: first.guid || '', sample: first.title || '' };
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('⬇️  拉取央视官方栏目清单…');
  const docs = await fetchCatalog();
  console.log(`   共 ${docs.length} 个官方栏目`);

  console.log('🔎 解析各栏目真实 ID（TOPC）…');
  const tops = await pool(docs, (d) => findTopc(d).then((topc) => ({ ...d, topc })), 12);
  const withTopc = tops.filter((x) => x && x.topc);
  console.log(`   解析成功 ${withTopc.length} / ${docs.length}`);

  let usable = withTopc;
  if (VERIFY) {
    console.log('🧪 逐个实测取数（只保留真有内容的栏目）…');
    const probed = await pool(
      withTopc,
      async (d) => {
        const r = await probe(d.topc);
        return r ? { ...d, total: r.total, sample: r.sample } : null;
      },
      10
    );
    usable = probed.filter(Boolean);
    console.log(`   可用栏目 ${usable.length} / ${withTopc.length}`);
  } else {
    usable = withTopc.map((d) => ({ ...d, total: 0 }));
  }

  // 组装栏目
  const columns = usable.map((d) => ({
    id: 'col_' + d.topc.toLowerCase(),
    name: d.column_name,
    ctid: d.topc,
    channel: d.channel_name || '',
    total: d.total || 0,
    category: CAT_MAP[d.column_firstclass] || 'other',
    enabled: true,
    featured: false,
  }));

  // 同名去重（保留内容量最大的）
  const byName = new Map();
  for (const c of columns) {
    const prev = byName.get(c.name);
    if (!prev || c.total > prev.total) byName.set(c.name, c);
  }
  const finalCols = [...byName.values()].sort((a, b) => b.total - a.total);

  // 每类取内容量前 6 作为首页推荐
  for (const cat of CATEGORIES) {
    finalCols
      .filter((c) => c.category === cat.id)
      .slice(0, 6)
      .forEach((c) => { c.featured = true; });
  }

  const categories = CATEGORIES.map((cat) => ({
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    desc: cat.desc,
    count: finalCols.filter((c) => c.category === cat.id).length,
  })).filter((c) => c.count > 0);

  const out = { categories, columns: finalCols, liveChannels: LIVE_CHANNELS };
  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  console.log(`\n✅ 栏目库同步完成：${finalCols.length} 个栏目 / ${categories.length} 个分类`);
  for (const c of categories) console.log(`   ${c.icon} ${c.name}: ${c.count} 个`);
  console.log(`   📺 直播频道: ${LIVE_CHANNELS.length} 个 | 首页推荐: ${finalCols.filter((c) => c.featured).length} 个`);
}

main().catch((e) => {
  console.error('❌ 同步失败:', e.message);
  process.exit(1);
});
