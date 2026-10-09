'use strict';
/**
 * 慈云影视 - 轻量数据存储
 * ============================================================
 * 使用单个 JSON 文件持久化（data/store.json），零外部依赖，方便开源部署。
 * 结构：{ settings, columns, sources, stats, users, orders, sessions }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const COLUMNS_FILE = path.join(DATA_DIR, 'columns.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * 从剧集标题里提取「剧名」（去掉期数/日期/集数后缀）。
 *
 * 用途：让同一部剧的不同入口、不同单集归并到同一个追剧条目。
 *   例：《新闻联播》 20261004 21:00  →  新闻联播
 *       甄嬛传 第03集                →  甄嬛传
 *       [高清] 庆余年 S02E05         →  庆余年
 */
function extractDramaName(title) {
  let t = String(title || '').trim();
  if (!t) return '';
  // 去掉《》
  t = t.replace(/[《》【】\[\]]/g, ' ').trim();
  // 去掉常见的前后缀噪声
  t = t.replace(/^(高清|超清|蓝光|HD|BD|TC|HDTV|抢先版|国语|粤语|中字|未删减)\s*/gi, '');
  t = t.replace(/\s*(国语|粤语|中字|双语|无删减|完整版|抢先版|高清|超清|蓝光|HD|BD)\s*$/gi, '');
  // 去掉日期 / 期数 / 集数 / 季集编码
  t = t.replace(/\b(19|20)\d{2}\s*[-/.]?\s*\d{0,2}\s*[-/.]?\s*\d{0,2}\b/g, ' ');  // 2026-10-04 / 20261004
  t = t.replace(/\b\d{1,2}\s*:\s*\d{2}(\s*:\s*\d{2})?\b/g, ' ');                    // 21:00 / 21:00:00
  t = t.replace(/\b\d{1,2}\s*月\s*\d{1,2}\s*日\b/g, ' ');                            // 10月4日
  t = t.replace(/第\s*[0-9一二三四五六七八九十百零]+\s*[集期话回弹]/g, ' ');          // 第03集 / 第 12 期
  t = t.replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, ' ');                                   // S02E05
  t = t.replace(/\bEP?\s*\d{1,4}\b/gi, ' ');                                        // EP12
  t = t.replace(/\s+/g, ' ').trim();
  return t || String(title || '').trim();
}

/**
 * 追剧 targetId 归一化。
 *
 * 背景（「追没追都提示/按钮状态反复」的根因）：
 *   央视播放页传裸 guid（32位hex）、资源库播放页传 vodId（如 col:col_xxx），
 *   同一部剧从不同入口追会各存一条 → 取关一条后另一条仍在，
 *   check 依旧返回 following:true → 用户看到「明明取关了却还是已追剧」。
 *
 * 规则：影视类统一成 "srcId:rawId"；非影视类（short/live/user）保持原样。
 *   - 已带 "srcId:" 前缀 → 原样返回（幂等，避免二次拼接）
 *   - 32 位 hex 裸 guid → 补 cctv-official: 前缀（历史入口对齐）
 */
function normFollowTarget(type, targetId) {
  const id = String(targetId == null ? '' : targetId).trim();
  if (!id) return '';
  if (type !== 'vod') return id;
  // 32 位 hex 裸 guid 视为央视官方源（历史入口），补上前缀以便与其他入口对齐
  if (/^[0-9a-f]{32}$/i.test(id)) return 'cctv-official:' + id;
  return id;
}

/** 取 targetId 的「原始 ID」部分（去掉 srcId: 前缀） */
function rawTargetId(targetId) {
  const s = String(targetId == null ? '' : targetId).trim();
  const i = s.indexOf(':');
  // 注意：col:xxx / sh_xxx 这类本身含冒号的 ID 不应被误切
  if (i > 0 && /^[a-z0-9_-]{2,24}$/i.test(s.slice(0, i)) && !/^(col|sh|live)$/i.test(s.slice(0, i))) {
    return s.slice(i + 1);
  }
  return s;
}

/**
 * 判断两个追剧项是否指向「同一个目标」。
 * 依次放宽：完全相等 → 归一化相等 → 原始 ID 相等 → 剧名相等。
 *
 *   vod   最后一级「剧名相等」，让「追了某合集」与「追了其中某一期」视作同一部剧
 *   user  账号名不区分大小写（历史数据可能存 Tester01，查询传 tester01）
 *   其余  严格相等
 */
function sameFollowTarget(type, a, b, titleA, titleB) {
  const sa = String(a == null ? '' : a).trim();
  const sb = String(b == null ? '' : b).trim();
  if (sa === sb) return true;

  // 关注用户：账号名大小写不敏感（与 followerCount / isFollowingUser 保持一致）
  if (type === 'user') return sa.toLowerCase() === sb.toLowerCase();

  if (type !== 'vod') return false;

  const na = normFollowTarget('vod', sa);
  const nb = normFollowTarget('vod', sb);
  if (na === nb) return true;
  if (rawTargetId(na) === rawTargetId(nb)) return true;

  // 兜底：剧名相同即视为同一部剧（合集的 col:xxx vs 单集 guid）
  const ta = extractDramaName(titleA);
  const tb = extractDramaName(titleB);
  if (ta && tb && ta === tb) return true;
  return false;
}

/**
 * 规整附件数组（图片）。
 * 统一收口成固定字段，避免前端拿到半截数据渲染出错。
 * 任何异常输入都退化为空数组 —— 附件是可选增强，不该让消息发送失败。
 *
 * @param {Array|string} arr
 * @returns {Array<{file:string,thumb:string,name:string,w:number,h:number,size:number,animated:boolean}>}
 */
function normalizeAttachments(arr, max = 9) {
  let list = arr;
  // 容忍 JSON 字符串（部分客户端把数组序列化后传来）
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a) continue;
    // 兼容两种写法：纯文件名字符串 / 对象
    const file = typeof a === 'string' ? a : a.file;
    if (!file || typeof file !== 'string') continue;
    // 只接受本模块生成的安全文件名，杜绝把任意外部 URL 塞进库里
    if (!/^[0-9]+_[0-9a-f]+\.(jpg|jpeg|png|gif|webp|avif|bmp)$/.test(path.basename(file))) continue;
    out.push({
      file: path.basename(file),
      thumb: typeof a === 'object' && a.thumb ? path.basename(String(a.thumb)) : '',
      name: typeof a === 'object' ? String(a.name || '').slice(0, 120) : '',
      w: typeof a === 'object' ? Number(a.w) || 0 : 0,
      h: typeof a === 'object' ? Number(a.h) || 0 : 0,
      size: typeof a === 'object' ? Number(a.size) || 0 : 0,
      animated: typeof a === 'object' ? !!a.animated : false,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** 默认站点设置 */
const DEFAULT_SETTINGS = {  siteName: '慈云影视',
  slogan: '免费 · 高清 · 无广告',
  logo: '',
  theme: {
    primary: '#e50914',
    accent: '#ff6b6b',
    mode: 'dark',
  },
  announcement: '本站数据均来自央视网等官方公开接口，仅供学习交流，请勿用于商业用途。',
  // 后台可管理的多条公告；每条独立控制 启用/滚动/弹窗/级别/生效时间
  announcementItems: [],
  // 配套监控服务地址（用于拉取公告/状态）；留空则用本机 announcement
  statusUrl: '',
  showAds: false,
  // 会员付费模块（开源版默认关闭，核心观看永远免费）
  monetize: {
    enabled: false,               // 是否开启付费模块
    mode: 'optional',             // optional=自愿赞助制（不付费也能用） | required=权益制（部分功能需会员）
    currency: '¥',
    provider: 'mock',             // 旧版单渠道字段（兼容保留，等于默认渠道的 type）
    testMode: true,               // 测试模式：下单后可一键模拟支付成功
    notifyUrl: '',                // 支付回调地址（provider 用）
    merchantId: '',               // 商户号
    signKey: '',                  // 签名密钥
    // —— 支付渠道列表（可增删改、启停、排序；每渠道独立配置） ——
    channels: [
      {
        id: 'ch_mock', type: 'mock', name: '模拟支付（演示）', icon: '🧪',
        enabled: true, sort: 0, testMode: true,
        desc: '无需任何商户信息，点击即可模拟支付成功，适合演示与本地开发',
        config: {},
        methods: [
          { id: 'alipay', name: '支付宝', icon: '🅰️', enabled: true },
          { id: 'wxpay', name: '微信支付', icon: '💚', enabled: true },
        ],
      },
      {
        id: 'ch_epay', type: 'epay', name: '易支付 / 彩虹易支付', icon: '🌈',
        enabled: false, sort: 10, testMode: false,
        desc: '兼容 彩虹易支付 及其衍生系统的统一下单接口，填入网关地址、商户号与密钥即可',
        config: {
          gateway: '',            // 如 https://pay.example.com/submit.php
          merchantId: '',         // pid
          signKey: '',            // 商户密钥
          signType: 'MD5',        // MD5 | SHA256
        },
        methods: [
          { id: 'alipay', name: '支付宝', icon: '🅰️', enabled: true },
          { id: 'wxpay', name: '微信支付', icon: '💚', enabled: true },
          { id: 'qqpay', name: 'QQ 钱包', icon: '🐧', enabled: true },
        ],
      },
      {
        id: 'ch_alipay', type: 'alipay', name: '支付宝（官方当面付）', icon: '🅰️',
        enabled: false, sort: 20, testMode: false,
        desc: '支付宝开放平台当面付 / 电脑网站支付，需 AppID、应用私钥与支付宝公钥',
        config: {
          appId: '', appPrivateKey: '', alipayPublicKey: '',
          gateway: 'https://openapi.alipay.com/gateway.do',
          productCode: 'FAST_INSTANT_TRADE_PAY',
        },
        methods: [{ id: 'alipay', name: '支付宝', icon: '🅰️', enabled: true }],
      },
      {
        id: 'ch_wxpay', type: 'wxpay', name: '微信支付（官方 Native）', icon: '💚',
        enabled: false, sort: 30, testMode: false,
        desc: '微信支付 V3 Native 扫码支付，需 AppID、商户号、APIv3 密钥与商户证书序列号',
        config: {
          appId: '', mchId: '', apiV3Key: '', serialNo: '', privateKey: '',
          gateway: 'https://api.mch.weixin.qq.com',
        },
        methods: [{ id: 'wxpay', name: '微信支付', icon: '💚', enabled: true }],
      },
      {
        id: 'ch_manual', type: 'manual', name: '人工收款 / 转账', icon: '🏦',
        enabled: false, sort: 40, testMode: false,
        desc: '展示收款码与说明，用户线下转账并提交凭证，管理员后台手动确认到账',
        config: {
          qrcode: '', instruct: '请使用支付宝/微信扫码支付，支付后点击「我已支付」并填写订单号，管理员将在 24 小时内确认。',
          accountName: '', accountNo: '',
        },
        methods: [{ id: 'manual', name: '转账 / 收款码', icon: '🏦', enabled: true }],
      },
      {
        id: 'ch_custom', type: 'custom', name: '自定义网关', icon: '🔧',
        enabled: false, sort: 50, testMode: false,
        desc: '完全自定义：自行提供下单跳转地址，回调仍走本站 /api/pay/callback',
        config: { gateway: '', signKey: '', extraQuery: '' },
        methods: [{ id: 'custom', name: '在线支付', icon: '🔧', enabled: true }],
      },
    ],
    allowBalance: true,           // 允许用余额支付
    redeemEnabled: true,          // 开启兑换码充值
    adminUnlimited: true,         // 管理员账号默认终身会员 + 无限额度
    minRecharge: 1,               // 最低充值金额
    rechargePresets: [10, 30, 50, 100, 200, 500],
    orderTimeout: 30,             // 订单未支付自动过期（分钟）
    autoRenewTip: true,           // 到期前提醒
    // —— 额度系统（默认关闭；开启后按额度/点数控制增值能力） ——
    quotaEnabled: false,          // 额度系统总开关（付费模块关闭时永不生效）
    requireLogin: true,           // 观看是否要求登录
    freeDailyPlays: 10,           // 每日免费观看次数（0=无免费额度）
    costPerPlay: 1,               // 每次观看消耗的次数额度
    dedupeDaily: true,            // 同一影片当日重复观看是否只扣一次
    vipFreePlays: true,           // 会员是否免观看额度
    allowPointsForPlay: true,     // 次数不足时是否允许用点数抵扣观看
    pointCosts: {                 // 通用点数消耗表
      play: 2,                    // 用点数看一部
      hd: 1,                      // 超清画质（单次）
      download: 5,                // 下载（单次）
      noAd: 10,                   // 去广告（按次）
    },
    plans: [
      {
        id: 'vip_month', name: '月度会员', days: 30, price: 12,
        originalPrice: 18, badge: '', recommended: false,
        perks: ['去广告', '超清画质', '无限收藏'],
      },
      {
        id: 'vip_quarter', name: '季度会员', days: 90, price: 32,
        originalPrice: 36, badge: '省 4 元', recommended: false,
        perks: ['去广告', '超清画质', '无限收藏', '家庭共享'],
      },
      {
        id: 'vip_year', name: '年度会员', days: 365, price: 98,
        originalPrice: 144, badge: '最划算', recommended: true,
        perks: ['去广告', '超清画质', '无限收藏', '专属线路', '家庭共享 5 人'],
      },
    ],
  },
  playback: {
    autoQuality: true,       // 自动清晰度
    autoFailover: true,      // 失败自动切换线路
    defaultLine: 'auto',     // auto | 线路id
    preload: true,
    mutedAutoplay: false,
  },
  // 社区模块（注册 / 评论 / 图片）
  community: {
    enabled: true,
    allowRegister: true,       // 是否开放注册
    allowComment: true,        // 是否允许评论
    guestComment: false,       // 是否允许游客评论（默认需登录）
    commentReview: false,      // 新评论是否需要审核后可见
    needEmail: false,          // 注册是否强制填邮箱
    verifyEmail: false,        // 注册是否必须通过邮箱验证码
    emailLogin: true,          // 是否开放邮箱验证码登录
    interval: 15,              // 同一用户两条评论最小间隔（秒）
    maxLen: 500,               // 单条评论最大字数
    keywords: ['加微信', '代刷', '赌博', '博彩', '私聊', '广告位', '出售', '办证'],

    /* ---------------- 图片能力（评论 / 聊天 / 弹幕 / 私信 / 封面） ---------------- */
    imageEnabled: true,        // 全站图片总开关（关掉后各入口都不显示图片按钮）
    imageReview: false,        // 图片是否需审核后可见（独立于 commentReview）
    commentImages: true,       // 评论支持发图
    chatImages: true,          // 聊天室支持发图
    danmakuImages: true,       // 弹幕支持发图
    messageImages: true,       // 私信支持发图
    galleryEnabled: true,      // 个人相册页开关
    // 各场景单条消息/评论最多可带几张图
    maxImagesPerComment: 9,    // 评论九宫格
    maxImagesPerMessage: 9,    // 私信/聊天一次最多 9 张
    // 单张体积上限（MB，服务端仍以 lib/image.js 的硬上限兜底）
    imageMaxMB: 5,
  },

  /* ---------------- 云盘（个人网盘，免费基础 + 会员扩容 + 空间包） ---------------- */
  drive: {
    enabled: true,             // 云盘模块总开关
    allowShare: true,          // 是否允许创建分享链接
    shareNeedPassword: false,  // 分享链接是否强制设密码
    shareMaxDays: 30,          // 分享链接最长有效期（天）
    // —— 配额（单位 MB；服务端按字节换算，0 表示禁止使用） ——
    freeQuotaMB: 2048,         // 普通用户 2GB
    planQuotaMB: {             // 各会员档位额外扩容（叠加在 freeQuotaMB 之上）
      month: 51200,            // 月卡 50GB
      quarter: 102400,         // 季卡 100GB
      year: 512000,            // 年卡 500GB
      forever: 1048576,        // 永久 1TB
    },
    // —— 空间包（可单独购买，永久有效；单位 MB） ——
    quotaPacks: [
      { id: 'pack10', name: '10GB 空间包', sizeMB: 10240, price: 6 },
      { id: 'pack50', name: '50GB 空间包', sizeMB: 51200, price: 25 },
      { id: 'pack100', name: '100GB 空间包', sizeMB: 102400, price: 45 },
    ],
    maxFileMB: 2048,           // 单个文件最大 2GB
    trashKeepDays: 30,         // 回收站保留天数
  },
  // 邮件服务（SMTP，用于登录/注册验证码、找回密码）
  mail: {
    host: 'smtp.163.com',      // 163 邮箱 SMTP
    port: 465,
    user: 'zhousazi1145142025@163.com',   // 发信邮箱账号
    pass: '',                  // SMTP 授权码（在后台「设置 → 邮件服务」填写，不落默认值）
    from: '慈云影视',           // 发件人显示名
    secure: 'ssl',             // ssl（465）/ starttls（587）
  },
  // 家庭共享（付费增值模块，1 户主 + 最多 N 成员；对标 Emby / Jellyfin / Plex）
  family: {
    enabled: true,             // 模块开关
    requireVip: true,          // 是否要求户主为会员才能创建
    maxMembers: 5,             // 最多可邀请成员数（不含户主）
    allowLeave: true,          // 成员是否可主动退出
    shareVip: true,            // 成员是否共享户主会员权益
    // —— 并发流 & 设备（对标 Jellyfin MaxActiveVideoStreams / Emby 设备数 / Plex 并发流） ——
    maxStreams: 2,             // 每成员最大同时在线观看数（0 = 不限，-1 跟随全局）
    deviceLimit: 3,            // 每成员最大绑定设备数（0 = 不限）
    streamPolicy: 'replace',   // 超额策略：replace=顶掉最早会话 / block=直接拒绝
    // —— 额度池（家庭共享额度，对标 Plex Home 权益下放） ——
    shareQuota: true,          // 成员缺额度时，是否消耗户主额度池
    familyQuotaPool: 100,      // 户主提供给家庭共用的额度池（次）
    // —— 邀请策略 ——
    inviteTtlDays: 3,          // 邀请码默认有效期（天）
    inviteRole: 'member',      // 邀请码默认角色：member / child / guest / admin
    autoApprove: true,         // 邀请码是否直接通过（false = 需户主审核）
    // —— 内容分级（对标 Jellyfin Parental Rating / Emby Parental Control） ——
    parentalEnabled: true,     // 是否启用儿童分级管控
    childMaxRating: 'PG13',    // 儿童等级上限：G / PG / PG13 / R / UNRATED
    childBlockVip: true,       // 儿童账号是否禁用会员增值功能（超清/下载）
    childBlockComment: true,   // 儿童账号是否禁言
  },
};

/** 默认内置源（全部经实测可用；央视网为官方公开接口，其余为公开采集站） */
const DEFAULT_SOURCES = [
  /* ---------------- 官方公开源（首选） ---------------- */
  {
    id: 'cctv-official',
    name: '央视网 · 官方公开',
    type: 'cctv',
    enabled: true,
    builtin: true,
    official: true,
    priority: 100,
    desc: '央视网 tv.cctv.com 公开接口：栏目点播 + 频道直播 + 节目单（官方公开，最稳）',
    config: { serviceId: 'tvcctv' },
  },
  {
    id: 'cctv-live',
    name: '央视直播 · 频道合集',
    type: 'cctv',
    enabled: true,
    builtin: true,
    official: true,
    priority: 95,
    desc: 'CCTV-1/2/4/5/6/8/13 等 20+ 频道直播，m3u8 直出',
    config: { serviceId: 'tvcctv', mode: 'live' },
  },
  /* ---------------- 公开影视采集源（苹果 CMS 标准） ---------------- */
  {
    id: 'hongniu',
    name: '红牛资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 80,
    desc: '国内速度优、更新快，11 万+ 影视，M3U8 直链',
    url: 'https://hongniuzy2.com/api.php/provide/vod/from/hnm3u8',
    config: { from: 'hnm3u8' },
  },
  {
    id: 'liangzi',
    name: '量子资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 78,
    desc: '资源量大、线路稳定，15 万+ 影视',
    url: 'https://cj.lziapi.com/api.php/provide/vod/from/lzm3u8',
    config: { from: 'lzm3u8' },
  },
  {
    id: 'zy360',
    name: '360 资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 72,
    desc: '7 万+ 影视，覆盖电影/剧集/综艺/动漫',
    url: 'https://360zyzz.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'dytt',
    name: '电影天堂资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 76,
    desc: '8.4 万+ 影视，老牌资源站，欧美/日韩剧集丰富',
    url: 'https://caiji.dyttzyapi.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'wujin',
    name: '无尽资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 74,
    desc: '12 万+ 影视，更新勤、线路多',
    url: 'https://api.wujinapi.me/api.php/provide/vod',
    config: {},
  },
  {
    id: 'ffzy',
    name: '非凡资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 73,
    desc: '9.8 万+ 影视，画质较好',
    url: 'https://api.ffzyapi.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'guangsu',
    name: '光速资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 70,
    desc: '11 万+ 影视，接口稳定',
    url: 'https://api.guangsuapi.com/api.php/provide/vod/from/gsm3u8',
    config: { from: 'gsm3u8' },
  },
  {
    id: 'jinying',
    name: '金鹰资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 60,
    desc: '低延迟线路，29 路播放源（部分海外网络可能受限）',
    url: 'http://jyzyapi.com/provide/vod/from/jinyingm3u8',
    config: { from: 'jinyingm3u8' },
  },
  {
    id: 'shandian',
    name: '闪电资源',
    type: 'maccms-json',
    enabled: false,
    builtin: true,
    priority: 55,
    desc: '20 路播放源（默认关闭：仅国内服务器可访问）',
    url: 'http://sdzyapi.com/api.php/provide/vod/from/sdm3u8',
    config: { from: 'sdm3u8' },
  },
  {
    id: 'aosika',
    name: '奥斯卡资源',
    type: 'maccms-json',
    enabled: false,
    builtin: true,
    priority: 50,
    desc: '97 路播放源（默认关闭：内容需自行审核，建议先开启内容过滤）',
    url: 'https://aosikazy.com/api.php/provide/vod',
    config: {},
  },
  /* ---------------- 扩展采集源（实测可用，2026-10 验证） ---------------- */
  {
    id: 'baofeng',
    name: '暴风资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 79,
    desc: '16.2 万+ 影视，资源量最大的源之一，更新极快',
    url: 'https://bfzyapi.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'maotaizy',
    name: '茅台资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 77,
    desc: '14.9 万+ 影视，画质好、线路稳',
    url: 'https://caiji.maotaizy.cc/api.php/provide/vod',
    config: {},
  },
  {
    id: 'shandianv3',
    name: '闪电资源 v3',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 75,
    desc: '12.3 万+ 影视，20 路播放源，加载快',
    url: 'https://sdzyapi.com/api.php/provide/vod/from/sdm3u8',
    config: { from: 'sdm3u8' },
  },
  {
    id: 'jisu',
    name: '极速资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 74,
    desc: '11.2 万+ 影视，接口响应快',
    url: 'https://jszyapi.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'piaoling',
    name: '飘零资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 71,
    desc: '9.9 万+ 影视，动漫与国漫资源丰富',
    url: 'https://p2100.net/api.php/provide/vod',
    config: {},
  },
  {
    id: 'tianyiapi',
    name: '天涯资源',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 69,
    desc: '7 万+ 影视，老牌采集站',
    url: 'https://tyyszy.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'zy360v2',
    name: '360 资源 v2',
    type: 'maccms-json',
    enabled: true,
    builtin: true,
    priority: 68,
    desc: '7.2 万+ 影视，作为 360 资源的备用线路',
    url: 'https://360zy.com/api.php/provide/vod',
    config: {},
  },
  {
    id: 'didizy',
    name: '滴滴资源',
    type: 'maccms-json',
    /**
     * ⚠️ 已停用：2026-10 实测该接口（api.ddapi.cc）整个站已变为成人采集站，
     *    最新更新 20 条 100% 为国产 AV / SWAG / 主播内容，且用「国产专区」
     *    这类中性分类名 + 露骨标题绕过分类过滤。即便有内容级过滤也不应有
     *    任何入口，故在源配置层直接关闭。
     *    如需恢复，请先核对上游内容是否已换回正规影视。
     */
    enabled: false,
    builtin: true,
    priority: 66,
    desc: '⚠️ 已停用（上游已变为成人站，不再提供影视内容）',
    url: 'https://api.ddapi.cc/api.php/provide/vod',
    config: {},
  },
];

function initialState() {
  return {
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    columns: null, // 从 columns.json 载入
    sources: JSON.parse(JSON.stringify(DEFAULT_SOURCES)),
    stats: { plays: {}, daily: {}, visits: {}, totalPlays: 0 },
    users: [],
    orders: [],
    sessions: {},
    comments: [],
    families: [],
    invites: [],
    redeemCodes: [],   // 兑换码
    quotaLog: [],      // 额度流水
    shorts: [],        // 短视频（用户发布，抖音式）
    follows: [],       // 追剧订阅 { account, type:'vod'|'short'|'live', targetId, title, cover, updatedAt, lastEp }
    // 社交：好友关系与私信
    //   friendships: { id, a, b, status:'pending'|'accepted', from, createdAt, updatedAt }
    //     · a/b 为两个账号（按字典序存储，保证唯一）
    //     · from 记录谁发起，用于「收到的请求 / 我发出的请求」区分
    friendships: [],
    //   messages: { id, from, to, text, attachments, at, read }  —— 私信（点对点）
    //     · attachments 为图片数组：[{ file, thumb, name, w, h, size }]
    messages: [],

    /* ---------------- 图片（相册 / 各入口图片消息的统一登记表） ---------------- */
    //   images: { id, file, thumb, name, account, w, h, size, animated,
    //             scene, refType, refId, status, createdAt }
    //     · file/thumb 为 data/uploads/images 下的文件名
    //     · scene 记录来源（comment/chat/danmaku/message/cover/gallery/drive）
    //     · 单独登记一份，便于「我的相册」「后台图片管理」「引用计数删除」
    images: [],

    /* ---------------- 云盘 ---------------- */
    //   driveNodes: { id, account, parent, type:'folder'|'file', name,
    //                 file, size, mime, w, h, trashed, trashedAt,
    //                 createdAt, updatedAt, downloads }
    driveNodes: [],
    //   driveShares: { id, nodeId, account, token, password, expiresAt,
    //                  views, downloads, createdAt, revoked }
    driveShares: [],

    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

let state = null;

function loadColumnsFile() {
  try {
    return JSON.parse(fs.readFileSync(COLUMNS_FILE, 'utf8'));
  } catch {
    return { categories: [], columns: [], liveChannels: [] };
  }
}

function load() {
  if (state) return state;
  if (fs.existsSync(FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      // 合并新增的默认字段（向后兼容）
      state.settings = mergeDeep(
        JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
        state.settings || {}
      );
      state.stats = state.stats || { plays: {}, daily: {}, visits: {}, totalPlays: 0 };
      state.users = state.users || [];
      state.orders = state.orders || [];
      state.comments = state.comments || [];
      state.families = state.families || [];
      state.invites = state.invites || [];
      state.redeemCodes = state.redeemCodes || [];
      state.quotaLog = state.quotaLog || [];
      // 家庭数据旧版本兼容：成员补 role/devices/pending，家庭补额度池字段
      for (const f of state.families) {
        if (!Number.isFinite(f.quotaPool)) f.quotaPool = 0;
        if (!Number.isFinite(f.poolUsed)) f.poolUsed = 0;
        for (const m of (f.members || [])) {
          if (!FAMILY_ROLES.includes(m.role)) m.role = 'member';
          m.devices = m.devices || [];
          m.pending = !!m.pending;
        }
      }
      for (const i of state.invites) {
        i.role = FAMILY_ROLES.includes(i.role) ? i.role : 'member';
        if (!Number.isFinite(i.maxUses)) i.maxUses = 1;
        i.usedCount = Number(i.usedCount) || (i.used ? 1 : 0);
      }
      state.sources = state.sources || JSON.parse(JSON.stringify(DEFAULT_SOURCES));
      state.sessions = state.sessions || {};
      // 图片 / 云盘：老版本 store.json 里没有这两张表，补齐并做字段规整
      state.images = state.images || [];
      state.driveNodes = state.driveNodes || [];
      state.driveShares = state.driveShares || [];
      state.messages = state.messages || [];
      state.shorts = state.shorts || [];
      state.follows = state.follows || [];
      // 图片记录字段规整：补齐缺失的 size/status/scene，避免前端渲染出 undefined
      for (const im of state.images) {
        if (!im || !im.file) continue;
        im.size = Number(im.size) || 0;
        im.w = Number(im.w) || 0;
        im.h = Number(im.h) || 0;
        im.scene = im.scene || 'gallery';
        im.status = im.status || 'ok';
        im.createdAt = im.createdAt || 0;
      }
      // 云盘节点字段规整
      for (const n of state.driveNodes) {
        if (!n) continue;
        if (n.type !== 'folder' && n.type !== 'file') n.type = 'file';
        n.size = Number(n.size) || 0;
        n.createdAt = n.createdAt || 0;
        n.updatedAt = n.updatedAt || n.createdAt;
        n.trashed = !!n.trashed;
        n.downloads = Number(n.downloads) || 0;
      }
      // 内置源自动补齐：新版本新增的内置源要能自动出现（只增不覆盖），
      // 同时保留用户对已有源的自定义（改名/改址/启停）与自建源。
      try {
        const have = new Set(state.sources.map((s) => s && s.id));
        for (const def of DEFAULT_SOURCES) {
          if (!have.has(def.id)) {
            state.sources.push(JSON.parse(JSON.stringify(def)));
            console.log(`[store] 新增内置采集源: ${def.name} (${def.id})`);
          }
        }
      } catch { /* 同步失败不影响启动 */ }

      // ⚠️ 安全强制停用：被标记为「上游已变成人站」的内置源，即便本地
      //    store.json 仍是 enabled:true（老版本写入的），也强制关闭。
      //    否则老用户升级后仍会看到成人内容 —— 这是黄片复现的直接原因。
      try {
        const FORCE_DISABLED = new Set(
          DEFAULT_SOURCES.filter((s) => s && s.enabled === false).map((s) => s.id)
        );
        for (const s of state.sources) {
          if (s && FORCE_DISABLED.has(s.id) && s.enabled !== false) {
            s.enabled = false;
            console.log(`[store] 安全停用采集源（上游内容违规）: ${s.name} (${s.id})`);
          }
        }
      } catch { /* 强制停用失败不影响启动 */ }
    } catch (e) {
      console.error('[store] 读取失败，使用初始状态:', e.message);
      state = initialState();
    }
  } else {
    state = initialState();
  }
  state.columns = loadColumnsFile();
  return state;
}

function mergeDeep(base, override) {
  for (const k of Object.keys(override || {})) {
    const v = override[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      base[k] = mergeDeep(base[k] && typeof base[k] === 'object' ? base[k] : {}, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

let saveTimer = null;
/** 防抖落盘 */
function save() {
  load();
  state.updatedAt = Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const dump = { ...state };
      dump.columns = undefined; // 栏目库单独存储，不重复写入
      fs.writeFileSync(FILE, JSON.stringify(dump, null, 1));
    } catch (e) {
      console.error('[store] 保存失败:', e.message);
    }
  }, 200);
}

/* ------------------------- 访问接口 ------------------------- */

const store = {
  get settings() {
    return load().settings;
  },
  setSettings(patch) {
    const s = load();
    s.settings = mergeDeep(s.settings, patch);
    save();
    return s.settings;
  },
  get columns() {
    return load().columns;
  },
  get categories() {
    return load().columns.categories || [];
  },
  get liveChannels() {
    return load().columns.liveChannels || [];
  },
  get settingsDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  },

  /** 栏目增删改（后台） */
  getColumns() {
    return load().columns.columns || [];
  },
  updateColumn(id, patch) {
    const s = load();
    const col = (s.columns.columns || []).find((c) => c.id === id);
    if (col) {
      Object.assign(col, patch);
      save();
    }
    return col;
  },
  addColumn(col) {
    const s = load();
    s.columns.columns = s.columns.columns || [];
    if (s.columns.columns.find((c) => c.id === col.id)) {
      throw new Error('栏目已存在: ' + col.id);
    }
    s.columns.columns.unshift(col);
    // 同步分类计数
    recountCategories(s);
    save();
    return col;
  },
  deleteColumn(id) {
    const s = load();
    s.columns.columns = (s.columns.columns || []).filter((c) => c.id !== id);
    recountCategories(s);
    save();
  },
  reorderFeatured(ids) {
    const s = load();
    const set = new Set(ids);
    for (const c of s.columns.columns || []) {
      c.featured = set.has(c.id);
    }
    s.settings.featuredOrder = ids;
    save();
  },

  /* ------------------------- 自定义源 ------------------------- */
  getSources() {
    return load().sources || [];
  },
  addSource(src) {
    const s = load();
    src.id = src.id || 'src_' + Date.now().toString(36);
    s.sources.push(src);
    save();
    return src;
  },
  updateSource(id, patch) {
    const s = load();
    const it = s.sources.find((x) => x.id === id);
    if (it) {
      Object.assign(it, patch);
      save();
    }
    return it;
  },
  deleteSource(id) {
    load().sources = load().sources.filter((x) => x.id !== id || x.builtin);
    save();
  },
  getSource(id) {
    return (load().sources || []).find((x) => x.id === id);
  },

  /* ------------------------- 统计 ------------------------- */
  recordPlay(guid, meta = {}) {
    const s = load();
    const st = s.stats;
    st.plays[guid] = st.plays[guid] || { count: 0, title: meta.title || '', last: 0 };
    st.plays[guid].count++;
    st.plays[guid].title = meta.title || st.plays[guid].title;
    st.plays[guid].last = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    st.daily[day] = (st.daily[day] || 0) + 1;
    st.totalPlays = (st.totalPlays || 0) + 1;
    save();
  },
  recordVisit(pathname) {
    const s = load();
    const day = new Date().toISOString().slice(0, 10);
    s.stats.visits[day] = (s.stats.visits[day] || 0) + 1;
    save();
  },
  getStats() {
    const s = load();
    const st = s.stats;
    const rev = this.revenueSummary();
    const top = Object.entries(st.plays || {})
      .map(([guid, v]) => ({ guid, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    // 近 14 天
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ date: d, plays: (st.daily || {})[d] || 0, visits: (st.visits || {})[d] || 0 });
    }
    return {
      totalPlays: st.totalPlays || 0,
      top,
      days,
      columns: (s.columns.columns || []).length,
      sources: (s.sources || []).length,
      users: (s.users || []).length,
      vipUsers: (s.users || []).filter((u) => u.vip && u.vip.expire > Date.now()).length,
      orders: (s.orders || []).length,
      comments: (s.comments || []).length,
      pendingComments: (s.comments || []).filter((c) => c.status === 'pending').length,
      families: (s.families || []).length,
      redeemTotal: (s.redeemCodes || []).length,
      redeemUsed: (s.redeemCodes || []).filter((x) => x.used).length,
      revenue: rev.revenue,
      todayRevenue: rev.todayRevenue,
    };
  },

  /* ------------------------- 用户 ------------------------- */
  getUsers() {
    return load().users || [];
  },
  findUser(account) {
    const a = String(account || '').toLowerCase();
    return (load().users || []).find((u) => u.account === a);
  },
  findUserByEmail(email) {
    const e = String(email || '').toLowerCase();
    if (!e) return null;
    return (load().users || []).find((u) => (u.email || '').toLowerCase() === e);
  },
  findUserByToken(token) {
    if (!token) return null;
    return (load().users || []).find((u) => (u.tokens || []).some((t) => t.id === token));
  },
  upsertUser(user) {
    const s = load();
    const i = s.users.findIndex((u) => u.account === user.account);
    if (i >= 0) s.users[i] = { ...s.users[i], ...user };
    else s.users.push(user);
    save();
    return user;
  },
  deleteUser(account) {
    const s = load();
    s.users = s.users.filter((u) => u.account !== account);
    s.comments = (s.comments || []).filter((c) => c.account !== account);
    save();
  },

  /* ------------------------- 评论 ------------------------- */
  getComments() {
    return load().comments || [];
  },
  addComment(c) {
    const s = load();
    const rec = {
      id: 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      parentId: c.parentId || null,
      targetType: c.targetType || 'video',
      targetId: String(c.targetId || ''),
      account: c.account || 'guest',
      nickname: c.nickname || '游客',
      avatar: c.avatar || '',
      content: String(c.content || ''),
      status: c.status || 'visible', // visible | pending | hidden | deleted
      // 图片附件（评论九宫格）；无图时为空数组
      attachments: normalizeAttachments(c.attachments, 9),
      likes: [],
      createdAt: Date.now(),
    };
    s.comments.unshift(rec);
    // 单文件不宜无限增长
    if (s.comments.length > 20000) s.comments.length = 20000;
    save();
    return rec;
  },
  findComment(id) {
    return (load().comments || []).find((c) => c.id === id);
  },
  updateComment(id, patch) {
    const c = this.findComment(id);
    if (!c) return null;
    Object.assign(c, patch);
    save();
    return c;
  },
  deleteComment(id, hard = false) {
    const s = load();
    if (hard) {
      s.comments = s.comments.filter((c) => c.id !== id && c.parentId !== id);
    } else {
      const c = this.findComment(id);
      if (c) { c.status = 'deleted'; c.content = ''; c.attachments = []; }
      // 子回复一并标记
      for (const x of s.comments) if (x.parentId === id) { x.status = 'deleted'; x.content = ''; x.attachments = []; }
    }
    save();
  },
  /** 查询某目标下的评论（含结构化为楼层+回复） */
  queryComments(targetType, targetId, opts = {}) {
    const all = (load().comments || []).filter(
      (c) => c.targetType === targetType && c.targetId === String(targetId)
    );
    const includeHidden = !!opts.includeHidden;
    const visible = all.filter((c) => includeHidden || c.status === 'visible');
    const roots = visible.filter((c) => !c.parentId).sort((a, b) => b.createdAt - a.createdAt);
    const total = visible.length;
    const page = Math.max(1, opts.page || 1);
    const size = Math.min(50, opts.size || 10);
    const slice = roots.slice((page - 1) * size, page * size);
    const list = slice.map((r) => ({
      ...r,
      likes: (r.likes || []).length,
      replies: visible
        .filter((c) => c.parentId === r.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((x) => ({ ...x, likes: (x.likes || []).length })),
    }));
    return { list, total, page, size, totalRoots: roots.length };
  },
  toggleCommentLike(id, account) {
    const c = this.findComment(id);
    if (!c) return null;
    c.likes = c.likes || [];
    const i = c.likes.indexOf(account);
    if (i >= 0) c.likes.splice(i, 1);
    else c.likes.push(account);
    save();
    return { likes: c.likes.length, liked: i < 0 };
  },
  /** 某用户最近的评论（用于频率限制） */
  lastCommentAt(account) {
    const list = (load().comments || []).filter((c) => c.account === account);
    return list.length ? Math.max(...list.map((c) => c.createdAt)) : 0;
  },

  /* ------------------------- 家庭共享 ------------------------- */
  getFamilies() {
    return load().families || [];
  },
  /** 查找用户所属家庭（户主或成员） */
  findFamilyOf(account) {
    return (load().families || []).find(
      (f) => f.owner === account || (f.members || []).some((m) => m.account === account)
    );
  },
  getFamily(id) {
    return (load().families || []).find((f) => f.id === id);
  },
  createFamily(owner, name) {
    const s = load();
    const rec = {
      id: 'fam_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      owner,
      name: name || (owner + ' 的家庭'),
      members: [],           // [{account, role, joinedAt, devices:[{id,name,lastAt}]}]
      createdAt: Date.now(),
      maxMembers: (s.settings.family && s.settings.family.maxMembers) || 5,
      quotaPool: 0,          // 家庭共享额度池（次）
      poolUsed: 0,           // 池已消耗
    };
    s.families.push(rec);
    save();
    return rec;
  },
  updateFamily(id, patch) {
    const f = this.getFamily(id);
    if (!f) return null;
    Object.assign(f, patch);
    save();
    return f;
  },
  deleteFamily(id) {
    const s = load();
    s.families = s.families.filter((f) => f.id !== id);
    s.invites = (s.invites || []).filter((i) => i.familyId !== id);
    save();
  },
  addFamilyMember(familyId, account, role) {
    const f = this.getFamily(familyId);
    if (!f) return { error: '家庭不存在' };
    const max = (load().settings.family && load().settings.family.maxMembers) || 5;
    if ((f.members || []).length >= max) return { error: `成员已达上限（最多 ${max} 人）` };
    if (f.owner === account) return { error: '户主已在家庭中' };
    if ((f.members || []).some((m) => m.account === account)) return { error: '该用户已在家庭中' };
    if (this.findFamilyOf(account)) return { error: '该用户已加入其它家庭' };
    f.members.push({
      account,
      role: FAMILY_ROLES.includes(role) ? role : 'member',
      joinedAt: Date.now(),
      devices: [],
      pending: false,
    });
    save();
    return { family: f };
  },
  /** 待审核成员（autoApprove=false 时） */
  addPendingMember(familyId, account, role) {
    const f = this.getFamily(familyId);
    if (!f) return { error: '家庭不存在' };
    const max = (load().settings.family && load().settings.family.maxMembers) || 5;
    const cnt = (f.members || []).filter((m) => !m.pending).length;
    if (cnt >= max) return { error: `成员已达上限（最多 ${max} 人）` };
    if (f.owner === account) return { error: '户主已在家庭中' };
    if ((f.members || []).some((m) => m.account === account)) return { error: '你已提交过加入申请' };
    if (this.findFamilyOf(account)) return { error: '该用户已加入其它家庭' };
    f.members.push({
      account,
      role: FAMILY_ROLES.includes(role) ? role : 'member',
      joinedAt: Date.now(),
      devices: [],
      pending: true,
    });
    save();
    return { family: f };
  },
  /** 审核通过 */
  approveFamilyMember(familyId, account) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    const m = (f.members || []).find((x) => x.account === account);
    if (m) { m.pending = false; m.approvedAt = Date.now(); save(); }
    return f;
  },
  /** 修改成员角色 */
  setFamilyRole(familyId, account, role) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    const m = (f.members || []).find((x) => x.account === account);
    if (m) { m.role = FAMILY_ROLES.includes(role) ? role : m.role; save(); }
    return f;
  },
  /** 成员设备登记（幂等：同 id 只更新 lastAt） */
  touchDevice(familyId, account, deviceId, deviceName) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    const m = (f.members || []).find((x) => x.account === account);
    if (!m) return null;
    m.devices = m.devices || [];
    const id = String(deviceId || '').slice(0, 64) || 'unknown';
    const hit = m.devices.find((d) => d.id === id);
    if (hit) { hit.lastAt = Date.now(); hit.name = deviceName || hit.name; }
    else m.devices.push({ id, name: String(deviceName || '未知设备').slice(0, 40), lastAt: Date.now() });
    save();
    return m;
  },
  /** 家庭额度池扣减 */
  useFamilyQuota(familyId, cost) {
    const f = this.getFamily(familyId);
    if (!f) return 0;
    const pool = Number(f.quotaPool) || 0;
    if (pool === -1) return -1;              // 无限池
    const remain = Math.max(0, pool - (Number(f.poolUsed) || 0));
    const use = Math.min(remain, Math.max(0, cost));
    f.poolUsed = (Number(f.poolUsed) || 0) + use;
    save();
    return use;
  },
  /** 家庭额度池充值 */
  refillFamilyQuota(familyId, amount) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    const amt = Math.trunc(Number(amount) || 0);
    f.quotaPool = (Number(f.quotaPool) || 0);
    if (f.quotaPool === -1) return f;        // 无限保持
    f.quotaPool = Math.max(0, f.quotaPool + amt);
    save();
    return f;
  },
  removeFamilyMember(familyId, account) {
    const f = this.getFamily(familyId);
    if (!f) return null;
    f.members = (f.members || []).filter((m) => m.account !== account);
    save();
    return f;
  },
  /* 邀请码 */
  getInvites() {
    return load().invites || [];
  },
  createInvite(familyId, by, ttlMs = 3 * 86400000, role = 'member', extra = {}) {
    const s = load();
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const inv = {
      code,
      familyId,
      by,
      role: FAMILY_ROLES.includes(role) ? role : 'member',
      maxUses: Math.max(1, Math.trunc(Number(extra.maxUses) || 1)),
      usedCount: 0,
      note: String(extra.note || '').slice(0, 60),
      used: false,
      expire: Date.now() + ttlMs,
      createdAt: Date.now(),
    };
    s.invites.push(inv);
    if (s.invites.length > 2000) s.invites = s.invites.slice(-2000);
    save();
    return inv;
  },
  findInvite(code) {
    const c = String(code || '').toUpperCase();
    return (load().invites || []).find((i) => i.code === c);
  },
  consumeInvite(code) {
    const inv = this.findInvite(code);
    if (inv) {
      inv.usedCount = (Number(inv.usedCount) || 0) + 1;
      if (inv.usedCount >= (inv.maxUses || 1)) inv.used = true;
      save();
    }
    return inv;
  },
  revokeInvite(code) {
    const s = load();
    s.invites = (s.invites || []).filter((i) => i.code !== String(code).toUpperCase());
    save();
  },
  /** 家庭列表（后台） */
  getFamilyList() {
    const fams = load().families || [];
    return fams.map((f) => {
      const owner = this.findUser(f.owner);
      const members = f.members || [];
      return {
        ...f,
        ownerNickname: owner ? owner.nickname || owner.account : f.owner,
        count: members.filter((m) => !m.pending).length,
        pending: members.filter((m) => m.pending).length,
        max: (load().settings.family && load().settings.family.maxMembers) || 5,
        devices: members.reduce((n, m) => n + ((m.devices || []).length), 0),
        quotaPool: Number(f.quotaPool) || 0,
        poolUsed: Number(f.poolUsed) || 0,
      };
    });
  },

  /* ------------------------- 会员 / 钱包 / 订单 ------------------------- */

  /** 全部订单（新→旧） */
  getOrders() {
    return load().orders || [];
  },
  /** 按用户查订单 */
  getOrdersOf(account, limit = 100) {
    return (load().orders || [])
      .filter((o) => o.account === account)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },
  findOrder(id) {
    return (load().orders || []).find((x) => x.id === id);
  },
  /**
   * 创建订单
   * type: vip=会员套餐 | recharge=余额充值
   */
  addOrder(order) {
    const s = load();
    if (!order.id) {
      order.id = 'ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    order.status = order.status || 'pending';   // pending | paid | refunded | expired | cancelled
    order.createdAt = Date.now();
    order.expire = order.expire || Date.now() + ((s.settings.monetize.orderTimeout || 30) * 60000);
    order.payAt = null;
    s.orders.unshift(order);
    // 单文件不宜无限增长
    if (s.orders.length > 50000) s.orders.length = 50000;
    save();
    return order;
  },
  updateOrder(id, patch) {
    const o = this.findOrder(id);
    if (!o) return null;
    Object.assign(o, patch);
    save();
    return o;
  },
  /** 将超时未支付订单标记为过期 */
  expireOrders() {
    const s = load();
    const now = Date.now();
    let n = 0;
    for (const o of s.orders || []) {
      if (o.status === 'pending' && o.expire && o.expire < now) {
        o.status = 'expired';
        n++;
      }
    }
    if (n) save();
    return n;
  },
  /** 后台订单分页查询 */
  queryOrders(opts = {}) {
    let list = (load().orders || []).slice();
    if (opts.status) list = list.filter((o) => o.status === opts.status);
    if (opts.type) list = list.filter((o) => (o.type || 'vip') === opts.type);
    if (opts.account) {
      const a = String(opts.account).toLowerCase();
      list = list.filter((o) => String(o.account || '').toLowerCase().includes(a));
    }
    if (opts.keyword) {
      const k = String(opts.keyword).toLowerCase();
      list = list.filter(
        (o) =>
          o.id.toLowerCase().includes(k) ||
          String(o.planName || '').toLowerCase().includes(k) ||
          String(o.account || '').toLowerCase().includes(k)
      );
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const page = Math.max(1, opts.page || 1);
    const size = Math.min(100, opts.size || 20);
    return {
      total,
      page,
      size,
      list: list.slice((page - 1) * size, page * size),
      summary: this.revenueSummary(),
    };
  },

  /** 收入看板 */
  revenueSummary() {
    const s = load();
    const orders = s.orders || [];
    const paid = orders.filter((o) => o.status === 'paid');
    const todayKey = new Date().toISOString().slice(0, 10);
    const sum = (arr) => arr.reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const isToday = (o) => new Date(o.payAt || o.createdAt).toISOString().slice(0, 10) === todayKey;

    // 近 14 天收入
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const dayOrders = paid.filter((o) => new Date(o.payAt || o.createdAt).toISOString().slice(0, 10) === d);
      days.push({ date: d, amount: sum(dayOrders), count: dayOrders.length });
    }

    // 按套餐维度
    const byPlan = {};
    for (const o of paid) {
      const k = o.planName || o.planId || '未知';
      if (!byPlan[k]) byPlan[k] = { name: k, count: 0, amount: 0 };
      byPlan[k].count++;
      byPlan[k].amount += Number(o.amount) || 0;
    }

    return {
      revenue: sum(paid),
      todayRevenue: sum(paid.filter(isToday)),
      todayCount: paid.filter(isToday).length,
      paidCount: paid.length,
      pendingCount: orders.filter((o) => o.status === 'pending').length,
      refundedCount: orders.filter((o) => o.status === 'refunded').length,
      refundedAmount: sum(orders.filter((o) => o.status === 'refunded')),
      orderCount: orders.length,
      // 客单价
      arpu: paid.length ? +(sum(paid) / paid.length).toFixed(2) : 0,
      days,
      byPlan: Object.values(byPlan).sort((a, b) => b.amount - a.amount),
      // 付费用户数
      payers: new Set(paid.map((o) => o.account).filter(Boolean)).size,
    };
  },

  /** 套餐查找 */
  findPlan(planId) {
    return (load().settings.monetize.plans || []).find((p) => p.id === planId);
  },

  /* ------------------------- 钱包余额 ------------------------- */
  /** 修改用户余额（delta 正负），返回新余额 */
  addBalance(account, delta) {
    const u = this.findUser(account);
    if (!u) return null;
    u.balance = Math.max(0, Math.round(((u.balance || 0) + Number(delta || 0)) * 100) / 100);
    this.upsertUser(u);
    return u.balance;
  },
  /** 钱包流水（从订单推算，无需单独表） */
  getWalletLog(account, limit = 50) {
    return this.getOrdersOf(account, 200)
      .filter((o) => o.status === 'paid' || o.status === 'refunded')
      .slice(0, limit);
  },

  /* ------------------------- 额度（观看次数 / 通用点数） ------------------------- */
  /** 归一化读取用户额度（缺失字段补默认值，兼容旧数据） */
  getQuota(account) {
    const u = this.findUser(account);
    if (!u) return null;
    const q = u.quota || {};
    return {
      times: Number.isFinite(q.times) ? q.times : 0,
      points: Number.isFinite(q.points) ? q.points : 0,
      usedPlays: Number(q.usedPlays) || 0,
      usedPoints: Number(q.usedPoints) || 0,
      dayKey: q.dayKey || '',
      dayUsed: Number(q.dayUsed) || 0,
      plays: q.plays || {},
      updatedAt: q.updatedAt || 0,
    };
  },
  /** 覆盖式写入额度（patch 中出现的键才会被覆盖） */
  setQuota(account, patch = {}) {
    const u = this.findUser(account);
    if (!u) return null;
    const q = this.getQuota(account) || {};
    Object.assign(q, patch);
    q.updatedAt = Date.now();
    u.quota = q;
    this.upsertUser(u);
    return q;
  },
  /** 增量增减额度：{ times, points }，不为负；-1 表示无限并保持无限 */
  addQuota(account, delta = {}) {
    const u = this.findUser(account);
    if (!u) return null;
    const q = this.getQuota(account) || {};
    const bump = (cur, d) => {
      if (cur === -1) return -1;                    // 已无限则保持无限
      const next = Math.round((Number(cur) || 0) + (Number(d) || 0));
      return next < 0 ? 0 : next;
    };
    if (delta.times !== undefined) q.times = bump(q.times, delta.times);
    if (delta.points !== undefined) q.points = bump(q.points, delta.points);
    q.updatedAt = Date.now();
    u.quota = q;
    this.upsertUser(u);
    return q;
  },
  /** 记录一次观看（同步完成：扣减 + 去重打点 + 统计），返回最新额度 */
  commitWatch(account, decision = {}) {
    const u = this.findUser(account);
    if (!u) return null;
    const q = this.getQuota(account) || {};
    const now = Date.now();
    const guid = String(decision.guid || '');

    if (decision.source === 'free') {
      q.dayKey = decision.dayKey || q.dayKey;
      q.dayUsed = Number(decision.dayUsed) || (Number(q.dayUsed) || 0) + 1;
    } else if (decision.source === 'times' && decision.cost > 0) {
      q.times = q.times === -1 ? -1 : Math.max(0, q.times - decision.cost);
      q.usedPlays = (q.usedPlays || 0) + decision.cost;
    } else if (decision.source === 'points' && decision.cost > 0) {
      q.points = q.points === -1 ? -1 : Math.max(0, q.points - decision.cost);
      q.usedPoints = (q.usedPoints || 0) + decision.cost;
    }
    if (guid) {
      if (!q.plays) q.plays = {};
      q.plays[guid] = now;
      // 清理 7 天前的去重记录，防止无限膨胀
      const cutoff = now - 7 * 86400000;
      const keys = Object.keys(q.plays);
      if (keys.length > 3000) {
        for (const k of keys) if (q.plays[k] < cutoff) delete q.plays[k];
      }
    }
    q.updatedAt = now;
    u.quota = q;
    this.upsertUser(u);
    return q;
  },
  /** 扣减点数（用于增值功能） */
  spendPoints(account, cost, reason) {
    const q = this.addQuota(account, { points: -Math.abs(cost) });
    if (q) {
      const q2 = this.getQuota(account);
      if (q2) q2.usedPoints = (q2.usedPoints || 0) + Math.abs(cost);
      this.setQuota(account, { usedPoints: q2 ? q2.usedPoints : 0 });
    }
    return q;
  },
  /** 额度流水 */
  addQuotaLog(entry = {}) {
    const s = load();
    s.quotaLog = s.quotaLog || [];
    const rec = {
      id: 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      account: entry.account || '',
      type: entry.type === 'points' ? 'points' : 'times',   // 变动维度
      delta: Number(entry.delta) || 0,                       // 正=增加 负=消耗
      reason: String(entry.reason || '').slice(0, 60),
      ref: String(entry.ref || '').slice(0, 60),
      after: entry.after === undefined ? null : entry.after,
      createdAt: Date.now(),
    };
    s.quotaLog.unshift(rec);
    if (s.quotaLog.length > 20000) s.quotaLog.length = 20000;
    save();
    return rec;
  },
  getQuotaLog(account, limit = 50) {
    return (load().quotaLog || [])
      .filter((x) => x.account === account)
      .slice(0, Math.max(1, Math.min(500, limit)));
  },
  /** 后台：额度列表（含用户基础信息） */
  queryQuotaUsers(opts = {}) {
    let list = (load().users || []).map((u) => {
      const q = u.quota || {};
      return {
        account: u.account,
        nickname: u.nickname || u.account,
        vip: !!(u.vip && u.vip.expire > Date.now()),
        times: Number.isFinite(q.times) ? q.times : 0,
        points: Number.isFinite(q.points) ? q.points : 0,
        usedPlays: Number(q.usedPlays) || 0,
        usedPoints: Number(q.usedPoints) || 0,
        createdAt: u.createdAt || 0,
      };
    });
    if (opts.keyword) {
      const k = String(opts.keyword).toLowerCase();
      list = list.filter((x) => x.account.includes(k) || x.nickname.toLowerCase().includes(k));
    }
    if (opts.status === 'has') list = list.filter((x) => x.times > 0 || x.points > 0 || x.times === -1 || x.points === -1);
    else if (opts.status === 'empty') list = list.filter((x) => x.times <= 0 && x.points <= 0);
    list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const page = Math.max(1, opts.page || 1);
    const size = Math.min(200, opts.size || 20);
    return { total, page, size, list: list.slice((page - 1) * size, page * size) };
  },
  /** 额度系统统计 */
  quotaStats() {
    const users = load().users || [];
    let unlimited = 0, withTimes = 0, withPoints = 0;
    let totalTimes = 0, totalPoints = 0, usedPlays = 0, usedPoints = 0;
    for (const u of users) {
      const q = u.quota;
      if (!q) continue;
      if (q.times === -1 || q.points === -1) unlimited++;
      if (q.times > 0 || q.times === -1) withTimes++;
      if (q.points > 0 || q.points === -1) withPoints++;
      if (q.times > 0) totalTimes += q.times;
      if (q.points > 0) totalPoints += q.points;
      usedPlays += Number(q.usedPlays) || 0;
      usedPoints += Number(q.usedPoints) || 0;
    }
    return { unlimited, withTimes, withPoints, totalTimes, totalPoints, usedPlays, usedPoints, users: users.length };
  },

  /* ------------------------- 兑换码 ------------------------- */
  getRedeemCodes() {
    return load().redeemCodes || [];
  },
  /** 批量创建兑换码
   *  item: { type:'vip'|'balance'|'quota_times'|'quota_points',
   *          value: 天数 | 金额 | 次数 | 点数, planName, count, batch, ttlDays }
   */
  createRedeemCodes(item = {}) {
    const s = load();
    s.redeemCodes = s.redeemCodes || [];
    const count = Math.max(1, Math.min(500, parseInt(item.count, 10) || 1));
    const out = [];
    const batch = item.batch || 'B' + Date.now().toString(36).toUpperCase();
    const type = REDEEM_TYPES.includes(item.type) ? item.type : 'vip';
    for (let i = 0; i < count; i++) {
      const code = genRedeemCode();
      const rec = {
        code,
        type,
        value: Number(item.value) || 0,
        planName: item.planName || REDEEM_TYPE_NAME[type],
        batch,
        used: false,
        usedBy: null,
        usedAt: null,
        expire: item.ttlDays ? Date.now() + item.ttlDays * 86400000 : 0,
        createdAt: Date.now(),
      };
      s.redeemCodes.unshift(rec);
      out.push(rec);
    }
    if (s.redeemCodes.length > 50000) s.redeemCodes.length = 50000;
    save();
    return out;
  },
  findRedeemCode(code) {
    // 用户输入容错：忽略大小写、空格与连字符
    const norm = (x) => String(x || '').trim().toUpperCase().replace(/[\s-]/g, '');
    const c = norm(code);
    if (!c) return null;
    return (load().redeemCodes || []).find((x) => norm(x.code) === c);
  },
  /** 核销兑换码 */
  consumeRedeemCode(code, account) {
    const rec = this.findRedeemCode(code);
    if (!rec) return null;
    rec.used = true;
    rec.usedBy = account;
    rec.usedAt = Date.now();
    save();
    return rec;
  },
  /** 后台兑换码分页查询 */
  queryRedeemCodes(opts = {}) {
    let list = (load().redeemCodes || []).slice();
    if (opts.batch) list = list.filter((x) => x.batch === opts.batch);
    if (opts.type) list = list.filter((x) => x.type === opts.type);
    if (opts.status === 'used') list = list.filter((x) => x.used);
    else if (opts.status === 'unused') list = list.filter((x) => !x.used);
    if (opts.keyword) {
      const k = String(opts.keyword).toUpperCase();
      list = list.filter((x) => x.code.includes(k) || String(x.usedBy || '').includes(k));
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const page = Math.max(1, opts.page || 1);
    const size = Math.min(200, opts.size || 50);
    const batches = [...new Set((load().redeemCodes || []).map((x) => x.batch))].filter(Boolean);
    return { total, page, size, list: list.slice((page - 1) * size, page * size), batches };
  },
  deleteRedeemCodes(ids = []) {
    const s = load();
    const set = new Set(ids);
    s.redeemCodes = (s.redeemCodes || []).filter((x) => !set.has(x.code));
    save();
  },

  /* ------------------------- 会话 ------------------------- */
  setSession(token, data) {
    const s = load();
    s.sessions[token] = { ...data, ts: Date.now() };
    save();
  },
  getSession(token) {
    const s = load();
    const it = s.sessions[token];
    if (!it) return null;
    if (Date.now() - it.ts > 7 * 86400000) {
      delete s.sessions[token];
      save();
      return null;
    }
    return it;
  },
  delSession(token) {
    const s = load();
    delete s.sessions[token];
    save();
  },
  /** 吊销全部后台会话（改管理口令后强制重新登录） */
  revokeAllSessions() {
    const s = load();
    for (const [tok, sess] of Object.entries(s.sessions || {})) {
      if (sess && sess.role === 'admin') delete s.sessions[tok];
    }
    save();
  },

  /** 重置为出厂设置（后台用） */
  reset() {
    state = initialState();
    state.columns = loadColumnsFile();
    save();
  },

  /* ============================================================
   * 短视频（用户发布，抖音式）
   * ============================================================ */
  getShorts({ status, account, keyword } = {}) {
    let list = load().shorts || [];
    if (status) list = list.filter((s) => (s.status || 'pending') === status);
    if (account) list = list.filter((s) => s.account === account);
    if (keyword) {
      const k = String(keyword).toLowerCase();
      list = list.filter((s) => (s.title || '').toLowerCase().includes(k) || (s.desc || '').toLowerCase().includes(k));
    }
    return list;
  },

  findShort(id) {
    return (load().shorts || []).find((s) => s.id === id);
  },

  /** 新增/更新短视频 */
  upsertShort(item) {
    const s = load();
    s.shorts = s.shorts || [];
    const i = s.shorts.findIndex((x) => x.id === item.id);
    if (i >= 0) s.shorts[i] = { ...s.shorts[i], ...item };
    else s.shorts.unshift(item);
    save();
    return item;
  },

  deleteShort(id) {
    const s = load();
    s.shorts = (s.shorts || []).filter((x) => x.id !== id);
    save();
  },

  /** 点赞/取消点赞（一次） */
  toggleShortLike(id, account) {
    const s = load();
    const it = (s.shorts || []).find((x) => x.id === id);
    if (!it) return null;
    it.likes = it.likes || [];
    const i = it.likes.indexOf(account);
    if (i >= 0) it.likes.splice(i, 1);
    else it.likes.push(account);
    save();
    return { liked: i < 0, likes: it.likes.length };
  },

  /** 播放计数 */
  bumpShortView(id) {
    const s = load();
    const it = (s.shorts || []).find((x) => x.id === id);
    if (!it) return;
    it.views = (it.views || 0) + 1;
    save();
  },

  /* ============================================================
   * 图片登记表（相册 / 图片消息 / 后台图片管理）
   * ============================================================
   * 每张上传成功的图片都会在这里登记一条记录。好处：
   *   1. 「我的相册」直接查这张表，无需遍历评论/私信/聊天
   *   2. 后台可统一审核、批量删除
   *   3. 记录 scene + refType/refId，能溯源「这张图发在哪」
   *   4. 用户注销时可按 account 一次性清理
   */

  /** 登记一张图片 */
  addImage(rec) {
    const s = load();
    s.images = s.images || [];
    const item = {
      id: 'img_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
      file: rec.file,
      thumb: rec.thumb || '',
      name: String(rec.name || '').slice(0, 120),
      account: rec.account || '',
      w: Number(rec.w) || 0,
      h: Number(rec.h) || 0,
      size: Number(rec.size) || 0,
      animated: !!rec.animated,
      scene: rec.scene || 'gallery',      // comment|chat|danmaku|message|cover|gallery|drive
      refType: rec.refType || '',         // short|video|live|conv|user
      refId: rec.refId || '',
      status: rec.status || 'ok',         // ok|pending|blocked
      createdAt: Date.now(),
      ...(rec.id ? { id: rec.id } : {}),
    };
    s.images.unshift(item);
    // 容量保护：图片登记表只保留最近 20000 条（文件本身不受影响）
    if (s.images.length > 20000) s.images.splice(20000);
    save();
    return item;
  },

  /** 按 id 查图片 */
  findImage(id) {
    return (load().images || []).find((x) => x.id === id) || null;
  },

  /** 按存储文件名查图片 */
  findImageByFile(file) {
    return (load().images || []).find((x) => x.file === file) || null;
  },

  /**
   * 查图片列表。
   * @param {object} opt { account, scene, status, refId, page, size }
   */
  queryImages({ account = '', scene = '', status = '', refType = '', refId = '', page = 1, size = 60 } = {}) {
    let list = (load().images || []).slice();
    if (account) list = list.filter((x) => x.account === account);
    if (scene) list = list.filter((x) => x.scene === scene);
    if (status) list = list.filter((x) => x.status === status);
    if (refType) list = list.filter((x) => x.refType === refType);
    if (refId) list = list.filter((x) => x.refId === refId);
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const p = Math.max(1, parseInt(page, 10) || 1);
    const sz = Math.min(200, Math.max(1, parseInt(size, 10) || 60));
    return {
      total: list.length,
      page: p,
      size: sz,
      list: list.slice((p - 1) * sz, p * sz),
    };
  },

  /** 统计某用户的图片占用空间（字节）与张数 */
  imageUsage(account) {
    const list = (load().images || []).filter((x) => x.account === account && x.status !== 'deleted');
    return {
      count: list.length,
      bytes: list.reduce((n, x) => n + (Number(x.size) || 0), 0),
    };
  },

  /** 更新图片状态（审核 / 屏蔽） */
  setImageStatus(id, status) {
    const s = load();
    const im = (s.images || []).find((x) => x.id === id);
    if (!im) return null;
    im.status = status;
    save();
    return im;
  },

  /** 物理删除图片记录（文件由调用方负责删） */
  deleteImage(id) {
    const s = load();
    const before = (s.images || []).length;
    s.images = (s.images || []).filter((x) => x.id !== id);
    if (s.images.length !== before) save();
    return before !== s.images.length;
  },

  /* ============================================================
   * 云盘
   * ============================================================
   * 存储模型：扁平节点表 + parent 指针（不用嵌套树）。
   * 理由：扁平结构改名/移动只改一个字段，不会因为深层嵌套导致
   * 一次移动要重写整棵子树；配额统计也只需一次遍历。
   */

  /** 某用户的全部节点（默认不含回收站） */
  driveNodes(account, { trashed = false, parent = undefined } = {}) {
    let list = (load().driveNodes || []).filter(
      (n) => n.account === account && !!n.trashed === !!trashed
    );
    if (parent !== undefined) list = list.filter((n) => (n.parent || '') === (parent || ''));
    return list;
  },

  /** 全站所有节点原始列表（后台统计 / 回收站清理用，注意有权限风险，勿直接下发前端） */
  getDriveNodesRaw() {
    return (load().driveNodes || []).slice();
  },

  /** 按 id 查节点（带归属校验可选） */
  findDriveNode(id, account) {
    const n = (load().driveNodes || []).find((x) => x.id === id);
    if (!n) return null;
    if (account && n.account !== account) return null;
    return n;
  },

  /** 新建文件夹 */
  createDriveFolder(account, parent, name) {
    const s = load();
    s.driveNodes = s.driveNodes || [];
    const now = Date.now();
    const node = {
      id: 'dn_' + now.toString(36) + crypto.randomBytes(4).toString('hex'),
      account,
      parent: parent || '',
      type: 'folder',
      name: String(name || '新建文件夹').slice(0, 120),
      file: '',
      size: 0,
      mime: '',
      w: 0,
      h: 0,
      trashed: false,
      trashedAt: 0,
      downloads: 0,
      createdAt: now,
      updatedAt: now,
    };
    s.driveNodes.push(node);
    save();
    return node;
  },

  /** 新增文件节点 */
  addDriveFile(account, parent, meta) {
    const s = load();
    s.driveNodes = s.driveNodes || [];
    const now = Date.now();
    const node = {
      id: 'dn_' + now.toString(36) + crypto.randomBytes(4).toString('hex'),
      account,
      parent: parent || '',
      type: 'file',
      name: String(meta.name || '未命名').slice(0, 200),
      file: meta.file || '',          // data/uploads/drive 下的存储名
      size: Number(meta.size) || 0,
      mime: meta.mime || 'application/octet-stream',
      w: Number(meta.w) || 0,
      h: Number(meta.h) || 0,
      ext: meta.ext || '',
      trashed: false,
      trashedAt: 0,
      downloads: 0,
      createdAt: now,
      updatedAt: now,
    };
    s.driveNodes.push(node);
    save();
    return node;
  },

  /** 更新节点（改名/移动） */
  updateDriveNode(id, patch = {}) {
    const s = load();
    const n = (s.driveNodes || []).find((x) => x.id === id);
    if (!n) return null;
    const allow = ['name', 'parent', 'trashed', 'trashedAt', 'downloads'];
    for (const k of allow) if (k in patch) n[k] = patch[k];
    n.updatedAt = Date.now();
    save();
    return n;
  },

  /** 删除节点记录（单条，文件由调用方删） */
  removeDriveNode(id) {
    const s = load();
    const before = (s.driveNodes || []).length;
    s.driveNodes = (s.driveNodes || []).filter((x) => x.id !== id);
    if (s.driveNodes.length !== before) save();
    return before !== s.driveNodes.length;
  },

  /** 删除节点记录（批量） */
  removeDriveNodes(ids = []) {
    const s = load();
    const set = new Set(ids);
    const removed = (s.driveNodes || []).filter((x) => set.has(x.id));
    s.driveNodes = (s.driveNodes || []).filter((x) => !set.has(x.id));
    if (removed.length) save();
    return removed;
  },

  /** 节点及其全部子孙（用于删除文件夹） */
  driveSubtree(id) {
    const all = load().driveNodes || [];
    const out = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      const node = all.find((x) => x.id === cur);
      if (node) out.push(node);
      for (const c of all) if ((c.parent || '') === cur) stack.push(c.id);
    }
    return out;
  },

  /** 某用户云盘已用空间（字节，不含回收站） */
  driveUsage(account) {
    const list = (load().driveNodes || []).filter(
      (n) => n.account === account && n.type === 'file' && !n.trashed
    );
    return {
      bytes: list.reduce((n, x) => n + (Number(x.size) || 0), 0),
      files: list.length,
    };
  },

  /* ---------- 分享链接 ---------- */

  addDriveShare(share) {
    const s = load();
    s.driveShares = s.driveShares || [];
    const rec = {
      id: 'ds_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
      nodeId: share.nodeId,
      account: share.account,
      token: share.token,
      password: share.password || '',
      expiresAt: Number(share.expiresAt) || 0,   // 0 = 永久
      views: 0,
      downloads: 0,
      revoked: false,
      createdAt: Date.now(),
    };
    s.driveShares.push(rec);
    save();
    return rec;
  },

  findDriveShare({ id, token }) {
    const list = load().driveShares || [];
    if (id) return list.find((x) => x.id === id) || null;
    if (token) return list.find((x) => x.token === token) || null;
    return null;
  },

  listDriveShares(account) {
    return (load().driveShares || [])
      .filter((x) => x.account === account && !x.revoked)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  /** 某节点的有效分享 */
  findShareByNode(nodeId) {
    return (load().driveShares || []).find(
      (x) => x.nodeId === nodeId && !x.revoked &&
        (!x.expiresAt || x.expiresAt > Date.now())
    ) || null;
  },

  updateDriveShare(id, patch = {}) {
    const s = load();
    const x = (s.driveShares || []).find((r) => r.id === id);
    if (!x) return null;
    for (const k of ['views', 'downloads', 'revoked', 'password', 'expiresAt']) {
      if (k in patch) x[k] = patch[k];
    }
    save();
    return x;
  },

  removeDriveShare(id) {
    const s = load();
    const before = (s.driveShares || []).length;
    s.driveShares = (s.driveShares || []).filter((x) => x.id !== id);
    if (s.driveShares.length !== before) save();
    return before !== s.driveShares.length;
  },

  /** 云盘全局统计（后台用） */
  driveStats() {
    const nodes = load().driveNodes || [];
    const users = new Map();
    let totalBytes = 0;
    let totalFiles = 0;
    for (const n of nodes) {
      if (n.type !== 'file' || n.trashed) continue;
      totalBytes += Number(n.size) || 0;
      totalFiles++;
      const cur = users.get(n.account) || { account: n.account, bytes: 0, files: 0 };
      cur.bytes += Number(n.size) || 0;
      cur.files++;
      users.set(n.account, cur);
    }
    return {
      totalBytes,
      totalFiles,
      users: [...users.values()].sort((a, b) => b.bytes - a.bytes),
      shares: (load().driveShares || []).filter((x) => !x.revoked).length,
    };
  },

  /* ============================================================
   * 追剧订阅
   * ============================================================ */
  getFollows(account) {
    return (load().follows || []).filter((f) => f.account === account);
  },

  /** 查是否已追（title 用于「同剧名」兜底匹配，可选） */
  findFollow(account, type, targetId, title) {
    return (load().follows || []).find(
      (f) => f.account === account && f.type === type && sameFollowTarget(type, f.targetId, targetId, f.title, title)
    );
  },

  /** 关注/取关，返回 {following:boolean} */
  toggleFollow(account, item) {
    const s = load();
    s.follows = s.follows || [];
    const key = normFollowTarget(item.type, item.targetId);
    // 按「同一目标」匹配：兼容历史分裂记录（同剧不同入口各存一条 / 账号名大小写不一）
    const hits = [];
    s.follows.forEach((f, idx) => {
      if (f.account === account && f.type === item.type && sameFollowTarget(item.type, f.targetId, item.targetId, f.title, item.title)) hits.push(idx);
    });
    if (hits.length) {
      // 删除全部同目标记录（顺带清理历史重复项），避免「取关了却还显示已追」
      for (let k = hits.length - 1; k >= 0; k--) s.follows.splice(hits[k], 1);
      save();
      return { following: false, removed: hits.length };
    }
    s.follows.unshift({ account, ...item, targetId: key || item.targetId, updatedAt: Date.now() });
    save();
    return { following: true };
  },

  /** 更新追剧进度（最新集） */
  touchFollow(account, type, targetId, patch = {}) {
    const s = load();
    const f = (s.follows || []).find(
      (x) => x.account === account && x.type === type && sameFollowTarget(type, x.targetId, targetId, x.title, patch.title)
    );
    if (f) { Object.assign(f, patch, { updatedAt: Date.now() }); save(); }
    return f;
  },

  /** 某人的粉丝数（多少人关注了他：type='user' 且 targetId=他的账号） */
  followerCount(account) {
    const a = String(account || '').toLowerCase();
    return (load().follows || []).filter((f) => f.type === 'user' && String(f.targetId).toLowerCase() === a).length;
  },

  /** 某人关注了多少个（内容订阅 + 关注的人） */
  followingCount(account) {
    const a = String(account || '').toLowerCase();
    return (load().follows || []).filter((f) => String(f.account).toLowerCase() === a).length;
  },

  /** 谁是某人的粉丝（账号列表，最多 limit 个） */
  followers(account, limit = 100) {
    const a = String(account || '').toLowerCase();
    return (load().follows || [])
      .filter((f) => f.type === 'user' && String(f.targetId).toLowerCase() === a)
      .slice(0, limit)
      .map((f) => f.account);
  },

  /** 是否已关注某人 */
  isFollowingUser(account, targetAccount) {
    return !!this.findFollow(account, 'user', String(targetAccount || '').toLowerCase());
  },

  /* ============================================================
   * 社交：好友关系
   * ------------------------------------------------------------
   * 关系表用 a/b 双列存储（按字典序），一条记录即代表两人之间的关系，
   * 避免「A→B 和 B→A 存两条」导致的状态不一致。
   * ============================================================ */

  /** 规范化一对账号（字典序），保证关系唯一 */
  _pair(x, y) {
    const a = String(x || '').toLowerCase();
    const b = String(y || '').toLowerCase();
    return a < b ? [a, b] : [b, a];
  },

  /** 两人之间的关系（无论方向） */
  findFriendship(x, y) {
    const [a, b] = this._pair(x, y);
    return (load().friendships || []).find((f) => f.a === a && f.b === b) || null;
  },

  /**
   * 发起好友申请。
   * 返回 { ok, status:'pending'|'accepted'|'exists', friendship }
   */
  requestFriend(from, to) {
    const s = load();
    s.friendships = s.friendships || [];
    const fromL = String(from || '').toLowerCase();
    const toL = String(to || '').toLowerCase();
    const [a, b] = this._pair(fromL, toL);
    if (a === b) return { ok: false, reason: 'self' };

    const exist = s.friendships.find((f) => f.a === a && f.b === b);
    if (exist) {
      // 对方已申请过我 → 视为互相接受（双向奔赴直接成为好友）
      if (exist.status === 'pending' && exist.from !== fromL) {
        exist.status = 'accepted';
        exist.updatedAt = Date.now();
        save();
        return { ok: true, status: 'accepted', friendship: exist };
      }
      return { ok: true, status: exist.status, friendship: exist };
    }

    const rec = {
      id: 'fr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      a, b,
      from: fromL,   // ⚠️ 记录真实发起人，不能写 a（a 是字典序较小者，非发起人）
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    s.friendships.push(rec);
    save();
    return { ok: true, status: 'pending', friendship: rec };
  },

  /** 接受好友申请 */
  acceptFriend(account, other) {
    const s = load();
    const [a, b] = this._pair(account, other);
    const f = (s.friendships || []).find((x) => x.a === a && x.b === b);
    if (!f) return { ok: false, reason: 'not_found' };
    if (f.status === 'accepted') return { ok: true, status: 'accepted', friendship: f };
    // 只有被申请方可以接受
    if (f.from === String(account || '').toLowerCase()) return { ok: false, reason: 'cannot_accept_own' };
    f.status = 'accepted';
    f.updatedAt = Date.now();
    save();
    return { ok: true, status: 'accepted', friendship: f };
  },

  /** 删除好友 / 拒绝申请 / 撤回申请 */
  removeFriend(account, other) {
    const s = load();
    const [a, b] = this._pair(account, other);
    const before = (s.friendships || []).length;
    s.friendships = (s.friendships || []).filter((x) => !(x.a === a && x.b === b));
    save();
    return { ok: s.friendships.length < before };
  },

  /** 某人的好友列表（仅 accepted），返回对方账号数组 */
  listFriends(account) {
    const me = String(account || '').toLowerCase();
    return (load().friendships || [])
      .filter((f) => f.status === 'accepted' && (f.a === me || f.b === me))
      .map((f) => (f.a === me ? f.b : f.a));
  },

  /** 待我处理的好友申请（别人发给我的） */
  listFriendRequests(account) {
    const me = String(account || '').toLowerCase();
    return (load().friendships || []).filter((f) => f.status === 'pending' && f.b === me);
  },

  /** 我发出的、对方还没处理的申请 */
  listSentRequests(account) {
    const me = String(account || '').toLowerCase();
    return (load().friendships || []).filter((f) => f.status === 'pending' && f.a === me);
  },

  /* ============================================================
   * 社交：私信
   * ============================================================ */

  /** 会话 ID：两人账号字典序拼接，保证同一会话唯一 */
  convId(x, y) {
    const [a, b] = this._pair(x, y);
    return a + '::' + b;
  },

  /**
   * 发送私信（仅限好友之间，调用方需先校验）
   * @param {string} from
   * @param {string} to
   * @param {string} text          文本内容（可空 —— 纯图片消息合法）
   * @param {Array}  attachments   图片数组 [{ file, thumb, name, w, h, size }]
   */
  sendMessage(from, to, text, attachments = []) {
    const s = load();
    s.messages = s.messages || [];
    const imgs = normalizeAttachments(attachments);
    const rec = {
      id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      conv: this.convId(from, to),
      from: String(from || '').toLowerCase(),
      to: String(to || '').toLowerCase(),
      text: String(text || '').slice(0, 2000),
      attachments: imgs,
      at: Date.now(),
      read: false,
    };
    s.messages.push(rec);
    // 单文件容量保护：超量丢弃最旧的
    if (s.messages.length > 50000) s.messages.splice(0, s.messages.length - 50000);
    save();
    return rec;
  },

  /** 某会话的消息（按时间正序） */
  listMessages(x, y, { limit = 200, before } = {}) {
    const conv = this.convId(x, y);
    let list = (load().messages || []).filter((m) => m.conv === conv);
    if (before) list = list.filter((m) => m.at < before);
    return list.slice(-limit);
  },

  /** 把某会话中「发给我的」标记为已读 */
  readMessages(me, other) {
    const s = load();
    const conv = this.convId(me, other);
    const meL = String(me || '').toLowerCase();
    let n = 0;
    (s.messages || []).forEach((m) => {
      if (m.conv === conv && m.to === meL && !m.read) { m.read = true; n++; }
    });
    if (n) save();
    return n;
  },

  /** 未读私信总数 */
  unreadCount(account) {
    const me = String(account || '').toLowerCase();
    return (load().messages || []).filter((m) => m.to === me && !m.read).length;
  },

  /**
   * 会话列表：每个好友一条，带最后一条消息与未读数。
   * 用于私信首页展示。
   */
  listConversations(account) {
    const me = String(account || '').toLowerCase();
    const friends = this.listFriends(me);
    const all = load().messages || [];
    const users = load().users || [];

    const nameOf = (acc) => {
      const u = users.find((x) => x.account === acc);
      return (u && (u.nickname || u.account)) || acc;
    };

    return friends.map((f) => {
      const conv = this.convId(me, f);
      const msgs = all.filter((m) => m.conv === conv);
      const last = msgs[msgs.length - 1] || null;
      return {
        account: f,
        nickname: nameOf(f),
        // 最后一条消息：纯图片消息 text 为空，用「[图片]」占位，避免会话列表空白
        last: last ? {
          text: last.text || ((last.attachments && last.attachments.length) ? '[图片]' : ''),
          at: last.at,
          from: last.from,
          images: (last.attachments || []).length,
        } : null,
        unread: msgs.filter((m) => m.to === me && !m.read).length,
        total: msgs.length,
      };
    }).sort((a, b) => ((b.last && b.last.at) || 0) - ((a.last && a.last.at) || 0));
  },

  /* ============================================================
   * 社交：用户检索（加好友时按账号/昵称找人）
   * ============================================================ */
  searchUsers(keyword, { exclude, limit = 20 } = {}) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return [];
    const ex = String(exclude || '').toLowerCase();
    return (load().users || [])
      .filter((u) => {
        if (!u || u.account === ex) return false;
        if (u.disabled) return false;
        const acc = String(u.account || '').toLowerCase();
        const nick = String(u.nickname || '').toLowerCase();
        return acc.includes(kw) || nick.includes(kw);
      })
      .slice(0, limit)
      .map((u) => ({
        account: u.account,
        nickname: u.nickname || u.account,
        avatar: u.avatar || '',
        vip: !!(u.vip && u.vip.expire > Date.now()),
        createdAt: u.createdAt || 0,
      }));
  },

  /** 导出/导入配置 */
  exportConfig() {
    const s = load();
    return {
      settings: s.settings,
      sources: s.sources,
      columns: s.columns.columns,
      exportedAt: new Date().toISOString(),
      version: 1,
    };
  },
  importConfig(cfg) {
    const s = load();
    if (cfg.settings) s.settings = mergeDeep(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), cfg.settings);
    if (cfg.sources) s.sources = cfg.sources;
    if (cfg.columns) s.columns.columns = cfg.columns;
    save();
  },
};

/** 兑换码支持的四种类型 */
const REDEEM_TYPES = ['vip', 'balance', 'quota_times', 'quota_points'];
/** 各类型的默认名称 */
const REDEEM_TYPE_NAME = {
  vip: '会员兑换',
  balance: '余额充值',
  quota_times: '观看次数额度',
  quota_points: '通用点数',
};

/** 生成兑换码：4 组 4 位，形如 A1B2-C3D4-E5F6-G7H8（去掉易混字符） */
function genRedeemCode() {
  const AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1
  const pick = () => AB[crypto.randomInt(0, AB.length)];
  const seg = () => Array.from({ length: 4 }, pick).join('');
  return [seg(), seg(), seg(), seg()].join('-');
}

/** 家庭成员角色（对标 Jellyfin 用户组 / Plex 子账户 / Emby 用户权限） */
const FAMILY_ROLES = ['owner', 'admin', 'member', 'child', 'guest'];
const FAMILY_ROLE_NAME = {
  owner: '户主',
  admin: '家庭管理员',
  member: '成员',
  child: '儿童',
  guest: '访客',
};
/** 角色默认能力（可被 settings 覆盖） */
const FAMILY_ROLE_PERMS = {
  owner: { watch: true, hd: true, download: true, comment: true, invite: true, manage: true, shareQuota: true },
  admin: { watch: true, hd: true, download: true, comment: true, invite: true, manage: true, shareQuota: true },
  member: { watch: true, hd: true, download: true, comment: true, invite: false, manage: false, shareQuota: true },
  child: { watch: true, hd: false, download: false, comment: false, invite: false, manage: false, shareQuota: true },
  guest: { watch: true, hd: false, download: false, comment: false, invite: false, manage: false, shareQuota: false },
};
/** 内容分级顺序（对标 Jellyfin ParentalRating） */
const RATING_LEVELS = ['G', 'PG', 'PG13', 'R', 'UNRATED'];

/** 重新统计各分类的栏目数量 */
function recountCategories(s) {
  const cats = s.columns.categories || [];
  for (const cat of cats) {
    cat.count = (s.columns.columns || []).filter((c) => c.category === cat.id).length;
  }
  s.columns.categories = cats.filter((c) => c.count > 0);
}

module.exports = {
  store, DEFAULT_SETTINGS, DEFAULT_SOURCES,
  REDEEM_TYPES, REDEEM_TYPE_NAME,
  FAMILY_ROLES, FAMILY_ROLE_NAME, FAMILY_ROLE_PERMS, RATING_LEVELS,
  normalizeAttachments,
};
