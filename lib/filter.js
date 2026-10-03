'use strict';
/**
 * 慈云影视 - 内容安全过滤
 * ============================================================
 * 用途：上游采集站质量参差，混有成人（AV）内容、擦边分类与广告条目。
 *      本模块在「分类 / 列表 / 详情」三处统一拦截，保证前端拿到的数据干净。
 *
 * 设计原则：
 *   1. 拦分类优先 —— 有害分类直接不出现在分类列表里，用户点不到
 *   2. 拦条目兜底 —— 标题命中关键词的条目逐条剔除
 *   3. 白名单可配 —— 通过环境变量 CONTENT_ALLOW_EXTRA 追加允许项
 *   4. 零误伤优先 —— 关键词尽量精确，避免误杀正常影视（如「艳」不单独用）
 */

/** 有害分类 ID（按分类名匹配后得到，避免依赖具体站的 ID 编号） */
const BLOCKED_CATEGORY_PATTERNS = [
  /擦边/i,
  /伦理/i,
  /成人/i,
  /情色/i,
  /色情/i,
  /三级/i,
  /午夜/i,
  /福利片?/i,
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
];

/** 标题/简介中的广告与引流词 */
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
];

/** 标题中的违规内容词（精确匹配，避免误伤） */
const ADULT_TITLE_PATTERNS = [
  /擦边/i,
  /三级片?/i,
  /情色|色情/i,
  /成人片|成人视频/i,
  /无码|有码|人妻|痴女|女优/i,
  /约炮|嫖娼|援交|一夜情/i,
  /淫|露点|走光/i,
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

/** 判断条目（标题/简介）是否含广告或违规内容 */
function isBlockedItem(item) {
  if (!item) return false;
  const title = String(item.name || item.title || item.vod_name || '');
  const content = String(item.content || item.desc || '').slice(0, 400);
  const remarks = String(item.remarks || '');

  // 标题命中广告词 → 屏蔽
  if (AD_PATTERNS.some((re) => re.test(title))) return true;
  // 标题命中成人内容词 → 屏蔽
  if (ADULT_TITLE_PATTERNS.some((re) => re.test(title))) return true;
  // 备注里塞网址/联系方式（常见于广告片）→ 屏蔽
  if (AD_PATTERNS.some((re) => re.test(remarks))) return true;
  // 简介前 400 字命中广告词 → 屏蔽（简介里塞广告很常见）
  if (AD_PATTERNS.some((re) => re.test(content))) return true;

  const ex = extraWords();
  if (ex.length && (ex.some((w) => title.includes(w)) || ex.some((w) => content.includes(w)))) {
    return true;
  }
  return false;
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
 * 说明：ID 取自实测（红牛/量子等苹果CMS系站点），名称见注释。
 */
const STATIC_BLOCKED_IDS = new Set([
  '21', // 伦理片
  '50', // 擦边短剧
  '51', // 部分站的擦边/成人分类占位
]);

/** 站点级别补充的静态黑名单（按源 id） */
const STATIC_BY_SOURCE = {
  hongniu: ['21', '50'],
  liangzi: ['21', '50'],
  baofeng: ['21', '50'],
  maotaizy: ['21', '50'],
  shandianv3: ['21', '50'],
  jisu: ['21', '50'],
  piaoling: ['21', '50'],
  tianyiapi: ['21', '50'],
  zy360v2: ['21', '50'],
  didizy: ['21', '50'],
};

function rememberBlocked(sourceId, cats) {
  const set = new Set(
    (cats || []).filter((c) => isBlockedCategory(c.name)).map((c) => String(c.id))
  );
  blockedIdCache.set(String(sourceId), set);
  return set;
}

function isBlockedId(sourceId, typeId) {
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
  BLOCKED_CATEGORY_PATTERNS,
  AD_PATTERNS,
  ADULT_TITLE_PATTERNS,
};
