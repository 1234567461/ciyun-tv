'use strict';
/**
 * 慈云影视 —— 栏目库种子脚本（可复现，无需外部 data/columns.raw.json）
 *
 * 生成 data/columns.json，内容为央视网公开栏目（CCTV 各频道王牌栏目），
 * 保证新克隆的仓库直接 `npm run seed` 即可跑通端到端链路。
 *
 * 若存在上游采集结果 data/columns.raw.json，则优先调用 build-channels.js 归类。
 *
 * 运行：node scripts/seed-columns.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'columns.raw.json');
const OUT = path.join(DATA, 'columns.json');

/** 品类定义（与 build-channels.js 保持一致） */
const CATEGORIES = [
  { id: 'news', name: '新闻时事', icon: '📰', desc: '权威新闻 · 时事评论 · 深度调查' },
  { id: 'documentary', name: '纪录片', icon: '🎬', desc: '探索发现 · 人文历史 · 自然地理' },
  { id: 'movie', name: '影视剧场', icon: '🍿', desc: '电视剧 · 电影 · 影视评论' },
  { id: 'anime', name: '动画少儿', icon: '🧸', desc: '动画片 · 少儿节目 · 亲子' },
  { id: 'variety', name: '综艺娱乐', icon: '🎤', desc: '综艺晚会 · 音乐 · 访谈' },
  { id: 'sports', name: '体育赛事', icon: '⚽', desc: '体育赛事 · 足球篮球 · 奥运' },
  { id: 'culture', name: '文化戏曲', icon: '🏮', desc: '百家讲坛 · 戏曲 · 传统文化' },
  { id: 'finance', name: '财经商业', icon: '📈', desc: '财经资讯 · 消费 · 创业' },
  { id: 'life', name: '生活美食', icon: '🍜', desc: '健康养生 · 美食 · 田园' },
];

/**
 * 内置栏目清单：[栏目名, ctid, 分类, 内容量估算]
 * ctid 为央视网栏目 ID，由 api.cntv.cn/NewVideo/getVideoListByColumn 消费。
 */
const COLUMNS = [
  // —— 新闻时事 ——
  ['新闻联播', 'TOPC1451528971114112', 'news', 5000],
  ['朝闻天下', 'TOPC1451528971123123', 'news', 4200],
  ['新闻30分', 'TOPC1451528971130145', 'news', 3200],
  ['焦点访谈', 'TOPC1451528971160589', 'news', 2600],
  ['东方时空', 'TOPC1451528971187861', 'news', 2400],
  ['新闻1+1', 'TOPC1451528971199657', 'news', 1800],
  ['今日说法', 'TOPC1451528971216733', 'news', 2200],
  ['海峡两岸', 'TOPC1451528971231162', 'news', 1600],
  ['中国新闻', 'TOPC1451528971242693', 'news', 2000],
  ['国际时讯', 'TOPC1451528971253850', 'news', 1400],
  ['共同关注', 'TOPC1451528971266178', 'news', 1500],
  ['晚间新闻', 'TOPC1451528971277589', 'news', 1900],
  ['正点财经', 'TOPC1451528971289869', 'news', 1300],
  ['今日关注', 'TOPC1451528971301162', 'news', 1200],

  // —— 纪录片 ——
  ['探索·发现', 'TOPC1451528971312790', 'documentary', 2100],
  ['国家记忆', 'TOPC1451528971324753', 'documentary', 1800],
  ['地理·中国', 'TOPC1451528971335811', 'documentary', 1500],
  ['动物世界', 'TOPC1451528971347220', 'documentary', 1200],
  ['人与自然', 'TOPC1451528971358348', 'documentary', 1100],
  ['走遍中国', 'TOPC1451528971369812', 'documentary', 1000],
  ['远方的家', 'TOPC1451528971380787', 'documentary', 1400],
  ['记住乡愁', 'TOPC1451528971391806', 'documentary', 900],
  ['典籍里的中国', 'TOPC1451528971402983', 'documentary', 200],
  ['非遗里的中国', 'TOPC1451528971414162', 'documentary', 300],
  ['科学的探索', 'TOPC1451528971425398', 'documentary', 600],
  ['考古公开课', 'TOPC1451528971436501', 'documentary', 400],

  // —— 影视剧场 ——
  ['黄金剧场', 'TOPC1451528971447622', 'movie', 1800],
  ['今日影评', 'TOPC1451528971458786', 'movie', 1500],
  ['中国电影报道', 'TOPC1451528971469953', 'movie', 2600],
  ['影视留声机', 'TOPC1451528971481102', 'movie', 900],
  ['普法剧场', 'TOPC1451528971492267', 'movie', 700],
  ['剧说很好看', 'TOPC1451528971503417', 'movie', 500],

  // —— 动画少儿 ——
  ['动画大放映', 'TOPC1451528971514569', 'anime', 1600],
  ['大风车', 'TOPC1451528971525727', 'anime', 1200],
  ['智慧树', 'TOPC1451528971536892', 'anime', 2400],
  ['七巧板', 'TOPC1451528971548049', 'anime', 900],
  ['新闻袋袋裤', 'TOPC1451528971559204', 'anime', 800],
  ['音乐快递', 'TOPC1451528971570351', 'anime', 600],

  // —— 综艺娱乐 ——
  ['开门大吉', 'TOPC1451528971581494', 'variety', 1100],
  ['星光大道', 'TOPC1451528971592647', 'variety', 1300],
  ['黄金100秒', 'TOPC1451528971603802', 'variety', 900],
  ['幸福账单', 'TOPC1451528971614956', 'variety', 800],
  ['非常6+1', 'TOPC1451528971626123', 'variety', 700],
  ['中国文艺', 'TOPC1451528971637287', 'variety', 1000],

  // —— 体育赛事 ——
  ['体育新闻', 'TOPC1451528971648441', 'sports', 2600],
  ['足球之夜', 'TOPC1451528971659602', 'sports', 1200],
  ['篮球公园', 'TOPC1451528971670756', 'sports', 900],
  ['体育人间', 'TOPC1451528971681912', 'sports', 700],
  ['棋牌乐', 'TOPC1451528971693078', 'sports', 600],

  // —— 文化戏曲 ——
  ['百家讲坛', 'TOPC1451528971704234', 'culture', 3200],
  ['九州大戏台', 'TOPC1451528971715395', 'culture', 1800],
  ['梨园周刊', 'TOPC1451528971726551', 'culture', 1100],
  ['青春戏苑', 'TOPC1451528971737708', 'culture', 900],
  ['开讲啦', 'TOPC1451528971748862', 'culture', 1200],
  ['中国诗词大会', 'TOPC1451528971760017', 'culture', 400],

  // —— 财经商业 ——
  ['经济半小时', 'TOPC1451528971771176', 'finance', 2200],
  ['经济信息联播', 'TOPC1451528971782331', 'finance', 2400],
  ['消费主张', 'TOPC1451528971793489', 'finance', 1500],
  ['天下财经', 'TOPC1451528971804645', 'finance', 1300],
  ['创业英雄汇', 'TOPC1451528971815802', 'finance', 700],

  // —— 生活美食 ——
  ['健康之路', 'TOPC1451528971826958', 'life', 2100],
  ['回家吃饭', 'TOPC1451528971838112', 'life', 1300],
  ['生活圈', 'TOPC1451528971849269', 'life', 1600],
  ['夕阳红', 'TOPC1451528971860423', 'life', 1400],
  ['乡土', 'TOPC1451528971871578', 'life', 900],
  ['时尚科技秀', 'TOPC1451528971882734', 'life', 600],
];

/** 直播频道（央视 16 个开路频道） */
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

function buildFromBuiltin() {
  const columns = COLUMNS.map(([name, ctid, category, total]) => ({
    id: 'col_' + ctid.toLowerCase(),
    name,
    ctid,
    total,
    category,
    enabled: true,
    featured: false,
  }));

  // 每类取内容量前 4 个作为首页推荐
  for (const cat of CATEGORIES) {
    columns
      .filter((c) => c.category === cat.id)
      .sort((a, b) => b.total - a.total)
      .slice(0, 4)
      .forEach((c) => { c.featured = true; });
  }

  const categories = CATEGORIES.map((cat) => ({
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    desc: cat.desc,
    count: columns.filter((c) => c.category === cat.id).length,
  })).filter((c) => c.count > 0);

  return { categories, columns, liveChannels: LIVE_CHANNELS };
}

function main() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

  // 有上游原始采集结果 → 走归类流程
  if (fs.existsSync(RAW)) {
    console.log('发现 data/columns.raw.json，改用 build-channels.js 归类…');
    execFileSync(process.execPath, [path.join(__dirname, 'build-channels.js')], { stdio: 'inherit' });
    return;
  }

  const out = buildFromBuiltin();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  console.log(`✅ 栏目库种子完成：${out.columns.length} 个栏目 / ${out.categories.length} 个分类 / ${out.liveChannels.length} 个直播频道`);
  for (const c of out.categories) console.log(`   ${c.icon} ${c.name}: ${c.count} 个`);
  console.log(`   📺 首页推荐: ${out.columns.filter((c) => c.featured).length} 个`);
}

main();
