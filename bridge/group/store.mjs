/**
 * 群聊存储层
 *
 * 目录结构（都在 qq-bridge/group/store/ 下）：
 *   groups/<群号>/window.jsonl   最近消息窗口（滚动，磁盘最多 400 条）
 *   groups/<群号>/topics.json    话题摘要（最多 8 条）
 *   groups/<群号>/stats.json     当日计数（发言数/搜索数/语音数）
 *   groups/<群号>/spoken.json    我最近说过的话（去重 + 冷却判断）
 *   members/<QQ号>.json          成员档案（含关系值）
 *   stickers/index.json          表情包索引
 *
 * 设计原则：所有写操作都小、同步、幂等；崩了不会毁数据。
 */
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
export const STORE = process.env.STORE_DIR || (DIR + 'store');

for (const d of [STORE, `${STORE}/groups`, `${STORE}/members`, `${STORE}/stickers`]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/** 原子写：先写 .tmp 再 rename，避免写一半断电留半截 JSON */
export function writeJson(path, obj) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

/** 今天的日期键，用于日额度重置 */
export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nowSec() { return Math.floor(Date.now() / 1000); }

// ── 群窗口 ───────────────────────────────────────────────

const WINDOW_MAX_DISK = 400;

export function windowPath(gid) { return `${STORE}/groups/${gid}/window.jsonl`; }

function ensureGroupDir(gid) {
  const d = `${STORE}/groups/${gid}`;
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/** 追加一条消息到窗口 */
export function appendWindow(gid, entry) {
  ensureGroupDir(gid);
  appendFileSync(windowPath(gid), JSON.stringify(entry) + '\n');
}

/** 读最近 n 条（从文件尾读，避免大文件全读） */
export function readWindow(gid, n = 40) {
  const p = windowPath(gid);
  if (!existsSync(p)) return [];
  let lines;
  try { lines = readFileSync(p, 'utf8').trim().split('\n'); }
  catch { return []; }
  if (lines.length > WINDOW_MAX_DISK * 2) {
    // 文件太长就截断一次（保留后一半）
    try {
      writeFileSync(p, lines.slice(-WINDOW_MAX_DISK).join('\n') + '\n');
    } catch { /* 截断失败不影响读取 */ }
    lines = lines.slice(-WINDOW_MAX_DISK);
  }
  return lines.slice(-n).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** 窗口里最后一条消息的时间戳（秒） */
export function lastMessageAt(gid) {
  const w = readWindow(gid, 1);
  return w.length ? w[w.length - 1].ts : 0;
}

// ── 话题摘要 ─────────────────────────────────────────────

export function loadTopics(gid) {
  return readJson(`${STORE}/groups/${gid}/topics.json`, []);
}

export function saveTopics(gid, topics) {
  ensureGroupDir(gid);
  writeJson(`${STORE}/groups/${gid}/topics.json`, topics.slice(-8));
}

// ── 当日统计 ─────────────────────────────────────────────

export function loadStats(gid) {
  const p = `${STORE}/groups/${gid}/stats.json`;
  const s = readJson(p, null);
  const today = todayKey();
  if (!s || s.date !== today) {
    return { date: today, total: 0, active: 0, voice: 0, search: 0 };
  }
  return s;
}

export function saveStats(gid, stats) {
  ensureGroupDir(gid);
  writeJson(`${STORE}/groups/${gid}/stats.json`, stats);
}

/** 计数 +1 并返回新值 */
export function bumpStat(gid, field, n = 1) {
  const s = loadStats(gid);
  s[field] = (s[field] ?? 0) + n;
  saveStats(gid, s);
  return s[field];
}

// ── 我说过的话（冷却 + 去重）──────────────────────────────

export function loadSpoken(gid) {
  return readJson(`${STORE}/groups/${gid}/spoken.json`, []);
}

export function pushSpoken(gid, text) {
  const list = loadSpoken(gid);
  list.push({ ts: nowSec(), text });
  writeJson(`${STORE}/groups/${gid}/spoken.json`, list.slice(-50));
}

/** 记「上一次放的歌」，用户只说"完整版"时用它 */
export function setLastSong(gid, q) {
  writeJson(`${STORE}/groups/${gid}/lastsong.json`, { q: String(q).slice(0, 40), at: nowSec() });
}

export function lastSong(gid) {
  const j = readJson(`${STORE}/groups/${gid}/lastsong.json`, null);
  return j?.q ?? '';
}

/** 记录我发出的消息 id（用来判断"是不是在回复我"） */
export function pushSentId(gid, id) {
  if (!id) return;
  const list = readJson(`${STORE}/groups/${gid}/sent.json`, []);
  list.push(Number(id));
  writeJson(`${STORE}/groups/${gid}/sent.json`, list.slice(-30));
}

/** 我最后发出去的那条消息 id（撤回用） */
export function lastSentId(gid) {
  const list = readJson(`${STORE}/groups/${gid}/sent.json`, []);
  return list.length ? list[list.length - 1] : 0;
}

export function isMyMessage(gid, id) {
  if (!id) return false;
  return readJson(`${STORE}/groups/${gid}/sent.json`, []).includes(Number(id));
}

export function lastSpokeAt(gid) {
  const list = loadSpoken(gid);
  return list.length ? list[list.length - 1].ts : 0;
}

/** 24 小时内是否说过同一句（去重，QQ 风控对重复内容敏感） */
export function saidRecently(gid, text, withinSec = 86400) {
  const t = nowSec();
  return loadSpoken(gid).some((x) => x.text === text && t - x.ts < withinSec);
}
