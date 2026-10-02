'use strict';
/**
 * 慈云影视 · 同源聊天室
 * ============================================================
 * 场景：正在看同一部影片 / 同一个频道（同一个"源"）的用户，
 *       进入同一个房间实时聊天、边看边聊、发弹幕式吐槽。
 *
 * 实现：
 *   · 房间 = room 字符串（如 video:xxx / live:cctv1 / src:cctv-official）
 *   · 消息存内存环形缓冲（最近 300 条），重启即清空，轻量无依赖
 *   · 实时推送：SSE (text/event-stream)，浏览器原生 EventSource
 *   · 在线人数：按连接计数，断开自动清理
 */

const MAX_MSG = 300;          // 每个房间保留消息数
const MAX_ROOMS = 500;        // 最多房间数
const rooms = new Map();      // room -> { msgs: [], clients: Set, lastActive }

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) {
      // 淘汰最久未活动的房间
      let oldest = null;
      for (const [k, v] of rooms) if (!oldest || v.lastActive < oldest[1].lastActive) oldest = [k, v];
      if (oldest) rooms.delete(oldest[0]);
    }
    r = { msgs: [], clients: new Set(), lastActive: Date.now() };
    rooms.set(id, r);
  }
  r.lastActive = Date.now();
  return r;
}

/** 新增消息 */
function push(roomId, msg) {
  const r = getRoom(roomId);
  msg.id = 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  msg.ts = Date.now();
  r.msgs.push(msg);
  if (r.msgs.length > MAX_MSG) r.msgs.splice(0, r.msgs.length - MAX_MSG);
  return msg;
}

/** 取最近消息 */
function history(roomId, limit = 60) {
  const r = getRoom(roomId);
  return r.msgs.slice(-limit);
}

/** 在线人数 */
function online(roomId) {
  const r = rooms.get(roomId);
  return r ? r.clients.size : 0;
}

/** 注册 SSE 客户端 */
function subscribe(roomId, client) {
  const r = getRoom(roomId);
  r.clients.add(client);
  return () => {
    r.clients.delete(client);
    if (!r.clients.size && !r.msgs.length) rooms.delete(roomId);
  };
}

/** 广播给房间内所有客户端 */
function broadcast(roomId, event, data) {
  const r = getRoom(roomId);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of r.clients) {
    try { c.write(payload); } catch { r.clients.delete(c); }
  }
}

/** 广播在线人数 */
function broadcastPresence(roomId) {
  broadcast(roomId, 'presence', { online: online(roomId) });
}

/** 房间列表（后台/调试） */
function roomStats() {
  const list = [];
  for (const [id, r] of rooms) {
    list.push({ id, online: r.clients.size, msgs: r.msgs.length, lastActive: r.lastActive });
  }
  return list.sort((a, b) => b.online - a.online || b.lastActive - a.lastActive).slice(0, 100);
}

module.exports = { push, history, online, subscribe, broadcast, broadcastPresence, roomStats, getRoom };
