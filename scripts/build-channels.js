'use strict';
/**
 * 把采集到的原始栏目列表（columns.raw.json）按品类归类，
 * 生成前端可直接消费的栏目库（columns.json）。
 * 运行：node scripts/build-channels.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'columns.raw.json');
const OUT = path.join(ROOT, 'data', 'columns.json');

/** 品类定义 */
const CATEGORIES = [
  {
    id: 'news',
    name: '新闻时事',
    icon: '📰',
    desc: '权威新闻 · 时事评论 · 深度调查',
    match: ['新闻', '联播', '朝闻', '焦点', '观察', '调查', '时讯', '24小时', '世界周刊',
      '面对面', '东方时空', '今日关注', '今日亚洲', '今日环球', '第一时间', '晚间新闻',
      '午夜新闻', '国际时讯', '环球视线', '深度国际', '海峡两岸', '高端访谈', '中国新闻',
      '正点财经', '夜线', '每周质量报告', '新闻袋袋裤', '中国法治观察', '生命线', '共同关注',
      '今日说法', '一线', '法治在线', '天网', '现在开庭', '法治深壹度', '高墙内外', '中华民族'],
  },
  {
    id: 'documentary',
    name: '纪录片',
    icon: '🎬',
    desc: '探索发现 · 人文历史 · 自然地理',
    match: ['纪录', '探索', '发现', '国家记忆', '地理', '动物世界', '人与自然', '见证',
      '考古', '国宝', '文明', '历史', '影像方志', '记住乡愁', '走遍中国', '远方的家',
      '人物', '华人故事', '中国缘', '简牍探中华', '金石探文明', '非遗里的中国',
      '典籍里的中国', '世界战史', '军事纪录', '时光军史馆', '花开中国', '城市风华录',
      '大地讲堂', '乡土中国', '科幻地带', '奥秘无穷', '实验现场', '透视新科技',
      '科学动物园', '解码科技史', '创新进行时'],
  },
  {
    id: 'movie',
    name: '影视剧场',
    icon: '🍿',
    desc: '电视剧 · 电影 · 影视评论',
    match: ['剧场', '电影', '影视', '普法剧场', '今日影评', '中国电影报道', '影视留声机',
      '剧说很好看', '剧懂法', '黄金100秒', '一槌定音', '故事里的中国第三季'],
  },
  {
    id: 'anime',
    name: '动画少儿',
    icon: '🧸',
    desc: '动画片 · 少儿节目 · 亲子',
    match: ['动画', '动漫', '少儿', '智慧树', '七巧板', '宝贝', '童声', '大风车', '动感',
      '快乐体验', '英雄出少年', '快乐大巴', '小小智慧树', '智力快车', '看我72变',
      '风车剧场', '音乐快递', '新闻袋袋裤', '动物欢乐多'],
  },
  {
    id: 'variety',
    name: '综艺娱乐',
    icon: '🎤',
    desc: '综艺 · 访谈 · 音乐舞蹈',
    match: ['综艺', '开门大吉', '快乐', '挑战', '星光大道', '幸福账单', '喜剧', '大戏',
      '音乐', '舞蹈', '艺', '歌', '越战越勇', '向幸福出发', '回声嘹亮', '合唱先锋',
      '艺览天下', '我的艺术清单', '中国节拍', '乐享汇', '音乐公开课', '一起音乐吧',
      '天天把歌唱', '民歌', '风华国乐', '乐游天下', '聆听时刻', '音乐人生', '音乐周刊',
      '非常6+1', '星推荐', '欢乐大猜想', '喜上加喜'],
  },
  {
    id: 'military',
    name: '军事国防',
    icon: '🎖️',
    desc: '军事 · 国防 · 兵器',
    match: ['军事', '国防', '兵器', '战场', '老兵', '砺剑', '讲武堂', '军情', '军迷',
      '军营', '军武', '军史', '正午国防', '第二战场'],
  },
  {
    id: 'sports',
    name: '体育竞技',
    icon: '⚽',
    desc: '体育赛事 · 足球篮球 · 奥运',
    match: ['体育', '足球', '篮球', '欧冠', '运动', '奥林匹克', '冰雪', '冰球', '棋牌',
      '五环', '体坛', '全景亚运', '亚运', '逐冰追雪'],
  },
  {
    id: 'culture',
    name: '文化戏曲',
    icon: '🏮',
    desc: '百家讲坛 · 戏曲 · 传统文化',
    match: ['文化', '百家讲坛', '百家说故事', '读书', '戏曲', '京剧', '曲苑', '梨园',
      '民歌', '国乐', '诗词', '非遗', '典藏', '中国文艺报道', '梨园周刊', '九州大戏台',
      '过把瘾', '角儿来了', '青春戏苑', '戏曲青年说', '了不起的戏曲', '名家书场',
      '一鸣惊人', '文化十分', '开讲啦'],
  },
  {
    id: 'finance',
    name: '财经商业',
    icon: '📈',
    desc: '财经资讯 · 消费 · 创业',
    match: ['财经', '经济', '消费', '生财', '创业', '共富经', '中国经济大讲堂',
      '经济半小时', '经济信息联播', '天下财经', '消费主张', '正点财经'],
  },
  {
    id: 'life',
    name: '生活美食',
    icon: '🍜',
    desc: '健康养生 · 美食 · 田园',
    match: ['生活', '健康', '美食', '味道', '回家吃饭', '三餐', '时尚', '田园', '乡村',
      '农业', '三农', '乡理乡亲', '谁知盘中餐', '超级农人秀', '乐游新乡村', '田野欢歌',
      '城市风华', '生活圈', '生活提示', '健康之路', '健康中国', '夕阳红', '人口',
      '心理访谈', '小区大事', '幸福', '时尚科技秀', '田园帮帮团',
      '跟着书本去旅行', '寻味山海', '冰天雪地', '我有传家宝', '谁是终极英雄', '中华民族'],
  },
];

/** 频道定义（直播） */
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

function classify(name) {
  for (const cat of CATEGORIES) {
    for (const kw of cat.match) {
      if (name.includes(kw)) return cat.id;
    }
  }
  return 'other';
}

function main() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const cols = raw
    .filter((c) => c && c.ctid && /^[\u4e00-\u9fa5]/.test(c.name)) // 过滤乱码名
    .map((c, i) => ({
      id: c.code,
      name: c.name,
      ctid: c.ctid,
      total: c.total || 0,
      category: classify(c.name),
      enabled: true,
      featured: false,
    }));

  // 每类按内容量排序
  cols.sort((a, b) => b.total - a.total);

  // 默认首页推荐：每类取前 4 个
  const byCat = {};
  for (const c of cols) {
    byCat[c.category] = byCat[c.category] || [];
    if (byCat[c.category].length < 4) {
      byCat[c.category].push(c.id);
      c.featured = true;
    }
  }

  // 分类汇总（只保留有内容的分类）
  const cats = CATEGORIES.map((cat) => ({
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    desc: cat.desc,
    count: cols.filter((c) => c.category === cat.id).length,
  })).filter((c) => c.count > 0);

  const other = cols.filter((c) => c.category === 'other');
  if (other.length) {
    cats.push({ id: 'other', name: '其他', icon: '📦', desc: '综合内容', count: other.length });
  }

  const out = { categories: cats, columns: cols, liveChannels: LIVE_CHANNELS };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  console.log(`✅ 栏目库生成完成：${cols.length} 个栏目 / ${cats.length} 个分类`);
  for (const c of cats) console.log(`   ${c.icon} ${c.name}: ${c.count}`);
  const rest = cols.filter((c) => c.category === 'other').map((c) => c.name);
  if (rest.length) console.log('   未分类:', rest.join(', '));
}

main();
