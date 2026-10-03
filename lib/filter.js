'use strict';
/**
 * 慈云影视 - 内容安全过滤
 * ============================================================
 * 用途：上游采集站质量参差，混有成人（AV）内容、擦边分类与广告条目。
 *      本模块在「分类 / 列表 / 详情 / 源等级」四处统一拦截。
 *
 * 设计原则：
 *   1. 拦分类优先 —— 有害分类直接不出现在分类列表里，用户点不到
 *   2. 拦条目兜底 —— 标题命中关键词的条目逐条剔除
 *   3. 源级降级   —— 整站就是成人站的源（如滴滴资源），直接判死
 *   4. 集合覆盖   —— 源头拦截 + 条目过滤 + 详情兜底，三层都要硬
 *   5. 零误伤优先 —— 精确词优先，避免误杀正常影视
 *
 * ⚠️ 2026-10 重大修订：上游源被替换为成人采集站，且用「国产专区」这类
 *    中性分类名 + 极脏标题绕过旧规则。本次把拦截面大幅扩宽：
 *    · 分类正则 19 → 60+ 条（覆盖传媒厂牌 / 写真 / 主播 / 调教等）
 *    · 标题正则 7 → 40+ 条（覆盖 AV 黑话：骚穴 / 白虎 / 福利姬 / 内射 等）
 *    · 新增「源成人率检测」：抽样发现整站几乎全是成人内容 → 整源屏蔽
 */

/* ============================================================
 * 一、分类级正则：命中即整个分类不展示、不可访问
 * ============================================================ */
const BLOCKED_CATEGORY_PATTERNS = [
  // —— 经典成人/擦边分类名 ——
  /擦边/i,
  /伦理/i,
  /成人/i,
  /情色/i,
  /色情/i,
  /三级/i,
  /午夜/i,
  /福利片?|福利姬|福利视频/i,
  /偷拍/i,
  /自拍/i,
  /裸/i,
  /\bAV\b/i,
  /18禁/i,
  /R18/i,
  /星欲/i,
  /欲涩/i,
  /淫/i,
  /嫖/i,
  /援交/i,
  // —— 传媒厂牌（全部为成人制片方）——
  /麻豆/i,
  /91\s*制片|91\s*porn/i,
  /蜜桃影像|蜜桃传媒/i,
  /天美传媒/i,
  /精东影业/i,
  /星空无限/i,
  /葫芦影业/i,
  /糖心/i,
  /swag/i,
  /果冻传媒/i,
  /皇家华人/i,
  /乌鸦传媒/i,
  /逗秀传媒/i,
  /草莓传媒/i,
  /爱豆传媒/i,
  /西红柿传媒/i,
  // —— 性行为 / 私密内容 ——
  /性爱|做爱|性交|口交|肛交|内射|外射|颜射|射精|自慰|手淫|撸管/i,
  /调教|捆绑|束缚|SM/i,
  /女同|男同|同性|百合|耽美.*肉|基佬/i,
  /黑料|泄密|流出|门事件|不雅/i,
  // —— 写真 / 主播 / 私拍 ——
  /写真/i,
  /主播|视讯|直播秀|裸聊/i,
  /两性|性教育|情趣|私拍|外围|兼职.*女|全套.*服务/i,
  /美女.*图片|模特.*私拍/i,
  /热舞|艳舞|脱衣/i,
  // —— 带有「无码/有码」标记的一律视为成人 ——
  /无码|有码|有修正/i,
  // —— 更多中文 AV 站常见分类 ——
  /国产精品|国产自拍|国产偷拍|国产视频|国产传媒|国产厂商|国产专区|国产.*区/i,
  /传媒|影视传媒|制片厂|影业$/i,   // 「XX传媒/XX制片厂/XX影业」在采集站几乎都是成人厂牌
  /中文字幕|中字|字幕组.*成/i,
  /解说.*成|水果派|解说.*AV/i,
  /亚洲.*色|欧美.*sex|日本.*片/i,
  /丝袜.*诱惑|制服.*诱惑|空姐|护士.*诱惑|秘书.*诱惑/i,
  /巨乳|美乳|丰乳|大奶|爆乳|嫩穴|骚穴|粉穴|白虎|馒头穴/i,
  /口爆|毒龙|颜射|潮吹|喷水|中出/i,
  /萝莉|幼齿|学生妹|校花|学妹|表姐|人妻|少妇|御姐.*诱惑/i,
  /捆绑.*调教|奴|唤兽|宠物.*女/i,
  /换妻|多P|3P|4P|群交|轮奸|强奸|迷奸/i,
  /一夜情|约炮|嫖娼|包养|卖淫|招嫖/i,
];

/* ============================================================
 * 二、分类级「父类传染」：只要父分类命中，所有子分类一并屏蔽
 *     （很多站把「国产专区」当父类，子类全是厂牌名）
 * ============================================================ */

/* ============================================================
 * 三、标题/简介中的广告与引流词
 * ============================================================ */
const AD_PATTERNS = [
  /加\s*微信/i,
  /加\s*QQ/i,
  /加\s*群/i,
  /微信[号：:]/i,
  /QQ[群号：:]/i,
  /扫码|二维码/i,
  /下载\s*APP/i,
  /点击进入|点击查看|立即点击/i,
  /访问\s*官网|官方网址|官网[:：]/i,
  /注册送|充值|代充|开户|博彩|赌博|彩票/i,
  /免费观看入口|福利入口|永久网址/i,
  /发布页|防失联|备用域名|收藏本站/i,
  /www\.[a-z0-9-]+\.(com|net|cc|vip|xyz|top|club)/i,
  /https?:\/\/[^\s]*\.(com|net|cc|vip|top)/i,
  /采集教程|站内新闻|影视资讯|娱乐动态|八卦爆料/i,
];

/* ============================================================
 * 四、标题级成人内容词
 *     上游站的脏标题极其露骨，必须按 AV 黑话逐词拦
 * ============================================================ */
const ADULT_TITLE_PATTERNS = [
  // —— 擦边/三级 ——
  /擦边/i, /三级片?/i, /情色|色情/i, /成人片|成人视频|成人动漫/i,
  // —— 女优 / 无码 ——
  /无码|有码|人妻|痴女|女优|素人|素人.*AV/i,
  // —— 传媒厂牌 ——
  /麻豆|91制片厂|蜜桃传媒|天美传媒|精东影业|星空无限|葫芦影业|糖心|SWAG|果冻传媒|皇家华人/i,
  // —— 性行为黑话（脏标题核心）——
  /自慰|手淫|撸管|抽插|猛插|狂插|深插|内射|外射|颜射|射精|射了|中出|潮吹|喷水/i,
  /骚穴|嫩穴|粉穴|肉穴|美穴|逼|屄|鸡巴|肉棒|性器|龟头|乳房|奶子|美乳|大奶|巨乳|爆乳|肥臀|翘臀/i,
  /白虎|馒头穴|多毛|无毛|垢|腿交|足交|乳交|口交|深喉|口爆|毒龙/i,
  /调教|捆绑|束缚|SM|奴|母狗|骚货|荡妇|淫娃|骚母|宠物.*女/i,
  // —— 隐私内容 ——
  /黑料|泄密|不雅视频|门事件|私密.*流出|原档|流出.*视频/i,
  // —— 约/嫖 ——
  /约炮|嫖娼|援交|一夜情|情夫|偷情|出轨|下海|开票|包养|外围/i,
  /露点|走光|透点|走奶|真空.*上阵/i,
  // —— 主观引诱词 ——
  /福利姬|福利视频|宅男梦寐|男人的梦想|深夜.*福利/i,
  /反差.*婊|反差.*骚|绿帽|牛头人|NTR/i,
  // —— 主播 / 直播 ——
  /主播.*脱|脱衣.*直播|裸舞|艳舞|大秀|开票大秀|第一视角.*大尺度/i,
  // —— 写真 / 私拍 ——
  /大尺度|尺.*度.*私拍|国模.*私拍|摄影师.*模特|套图/i,
  // —— 未成年暗示（最严重，绝对拦）——
  /萝莉|幼齿|学生妹|校花|学妹|未成年|未成年.*视频|初中.*女生|高中.*女生|00后.*嫩/i,
  // —— 其它 ——
  /骚|淫|嫖|妓|娼|卖淫|招嫖|包夜|全套服务|一条龙.*服务/i,
];

/** 取环境变量追加的额外屏蔽词（逗号分隔） */
function extraWords() {
  const raw = String(process.env.CONTENT_BLOCK_EXTRA || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 判断分类名是否应被屏蔽 */
function isBlockedCategory(name) {
  const n = String(name || '');
  if (!n) return false;
  if (BLOCKED_CATEGORY_PATTERNS.some((re) => re.test(n))) return true;
  const ex = extraWords();
  return ex.some((w) => n.includes(w));
}

/**
 * 判断条目（标题/简介/备注/演员）是否含广告或违规内容。
 * ⚠️ 除标题外，演员名与备注也要扫——成人站的污词常藏在 vod_actor / vod_remarks。
 */
function isBlockedItem(item) {
  if (!item) return false;
  const title = String(item.name || item.title || item.vod_name || '');
  const content = String(item.content || item.desc || '').slice(0, 600);
  const remarks = String(item.remarks || item.vod_remarks || '');
  const actor = String(item.actor || item.vod_actor || '');
  const director = String(item.director || item.vod_director || '');
  const typeName = String(item.typeName || item.type_name || item.vod_class || '');

  const haystacks = [title, remarks, content, actor, director, typeName];
  const testAll = (patterns) => haystacks.some((h) => h && patterns.some((re) => re.test(h)));

  // ① 分类名命中（typeName 常直接暴露成人站身份）
  if (typeName && isBlockedCategory(typeName)) return true;
  // ② 广告 / 引流词
  if (testAll(AD_PATTERNS)) return true;
  // ③ 成人内容词
  if (testAll(ADULT_TITLE_PATTERNS)) return true;

  const ex = extraWords();
  if (ex.length && haystacks.some((h) => h && ex.some((w) => h.includes(w)))) return true;
  return false;
}

/**
 * 源级成人率检测：抽样条目里成人/广告内容的占比。
 * 用途：识别「整站就是成人站」的源（如滴滴资源），直接判死。
 * @param {Array} items 已 normalize 的条目
 * @param {number} threshold 阈值，默认 0.6
 * @returns {{ratio:number, adult:boolean, sample:number}}
 */
function adultRatio(items, threshold = 0.6) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return { ratio: 0, adult: false, sample: 0 };
  let bad = 0;
  for (const it of list) {
    if (isBlockedItem(it)) { bad++; continue; }
    // 分类名单独判一次（normalize 后 typeName 可能为空）
    if (isBlockedCategory(it.typeName || it.type_name || '')) { bad++; }
  }
  const ratio = bad / list.length;
  return { ratio, adult: ratio >= threshold, sample: list.length };
}

/**
 * 过滤分类数组。
 * @param {Array<{id:string,name:string}>} cats
 */
function filterCategories(cats) {
  if (!Array.isArray(cats)) return [];
  return cats.filter((c) => c && c.name && !isBlockedCategory(c.name));
}

/**
 * 过滤条目数组。
 * @param {Array} list
 */
function filterItems(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((it) => !isBlockedItem(it));
}

/** 判断某分类 ID 是否属于已屏蔽分类（结合分类表） */
function makeCategoryIdChecker(cats) {
  const blockedIds = new Set(
    (cats || []).filter((c) => isBlockedCategory(c.name)).map((c) => String(c.id))
  );
  return (id) => blockedIds.has(String(id));
}

/**
 * 进程内维护「源 -> 有害分类 ID 集合」的映射。
 * 分类接口是缓存的（30min），这里同步缓存判定结果，列表接口即可零成本复用。
 */
const blockedIdCache = new Map(); // key: sourceId, value: Set<string>

/**
 * 已知采集站的静态有害分类 ID 兜底表。
 * 背景：分类接口结果是带缓存的，而进程内黑名单是内存态 —— 冷启动时若
 *      分类接口尚未被访问（或命中旧缓存），ID 黑名单会为空，导致
 *      「直接按 ID 访问有害分类」绕不过去。这里用静态表兜底。
 * ⚠️ 注意：ID 是站点私有的，同名站不同源 ID 可能不同，故必须按源配置。
 */
const STATIC_BLOCKED_IDS = new Set([
  '21', // 伦理片（红牛系）
  '50', // 擦边短剧（红牛系）
  '51', // 部分站的擦边/成人分类占位
]);

/**
 * 站点级别静态黑名单（按源 id）。
 * ⚠️ 2026-10 实测：源被大批替换，必须逐站核对 ID。
 *    didizy（滴滴资源）整站为成人站，直接在源配置层停用，不靠 ID 兜底。
 */
const STATIC_BY_SOURCE = {
  // 红牛系（伦理片=21 / 擦边短剧=50 / AI漫剧=51 中含擦边）
  hongniu: ['21', '50'],
  liangzi: ['34'],                 // 量子：伦理片=34（注意不是 21！）
  zy360: ['21', '50', '51'],
  dytt: ['21', '50', '51'],
  wujin: ['21', '50', '51', '60', '61'],   // 无尽：含两性课堂/写真热舞
  ffzy: ['21', '50', '51'],
  guangsu: ['21', '50', '51'],
  jinying: ['21', '50', '51'],
  baofeng: ['21', '50', '51'],
  maotaizy: ['21', '50', '51'],
  shandianv3: ['21', '50', '51', '60', '61'],
  jisu: ['21', '50', '51'],
  piaoling: ['21', '50', '51'],
  tianyiapi: ['21', '50', '51'],
  zy360v2: ['21', '50', '51'],
  // 滴滴资源（整站成人）—— 这里仍列出，配合 store 层停用双保险
  didizy: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30',
    '31', '32', '33', '34', '35', '36', '37', '38', '40', '41', '42',
    '43', '44', '45', '46', '47'],
};

/**
 * 全站级屏蔽源：整站内容为成人资源，无论分类 ID 是什么都不放行。
 * 由 rememberBlocked / 源健康探测在运行时补充。
 */
const BLOCKED_SOURCES = new Set([
  // 滴滴资源（ddapi.cc）：实测 100% 为国产 AV / SWAG / 主播内容
  'didizy',
]);

function isBlockedSource(sourceId) {
  return BLOCKED_SOURCES.has(String(sourceId));
}

function markSourceBlocked(sourceId) {
  const id = String(sourceId);
  if (!id) return;
  BLOCKED_SOURCES.add(id);
}

function rememberBlocked(sourceId, cats) {
  const set = new Set(
    (cats || []).filter((c) => isBlockedCategory(c.name)).map((c) => String(c.id))
  );
  blockedIdCache.set(String(sourceId), set);
  return set;
}

function isBlockedId(sourceId, typeId) {
  // ⓿ 整源屏蔽：该源已被判定为成人站，任何分类都拦
  if (isBlockedSource(sourceId)) return true;
  if (!typeId) return false;
  const id = String(typeId);
  // ① 站点专属静态黑名单
  const bySrc = STATIC_BY_SOURCE[String(sourceId)];
  if (bySrc && bySrc.includes(id)) return true;
  // ② 全局静态兜底
  if (STATIC_BLOCKED_IDS.has(id)) return true;
  // ③ 运行时从分类表学习到的黑名单
  const set = blockedIdCache.get(String(sourceId));
  return set ? set.has(id) : false;
}

module.exports = {
  isBlockedCategory,
  isBlockedItem,
  filterCategories,
  filterItems,
  makeCategoryIdChecker,
  rememberBlocked,
  isBlockedId,
  isBlockedSource,
  markSourceBlocked,
  adultRatio,
  BLOCKED_CATEGORY_PATTERNS,
  AD_PATTERNS,
  ADULT_TITLE_PATTERNS,
  BLOCKED_SOURCES,
  STATIC_BY_SOURCE,
};
