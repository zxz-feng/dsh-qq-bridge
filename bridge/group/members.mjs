/**
 * 群成员档案 + 关系值
 *
 * 每个人一个 json（members/<QQ号>.json），跨群共用：
 * 在 A 群认识的人，到 B 群还认得，关系值也带着走（更像人）。
 *
 * 关系值 affinity：-100 ~ 100
 *   > 30   熟人  —— 会主动搭话、接梗、话多一点
 *   -30~30 一般  —— 正常客气，短句
 *   < -30  冷淡  —— 只回 @，能一个字不说两个字，不主动
 *
 * 注意：下限是"冷淡"不是"刻薄"。群里说难听话 = 结仇 + 被举报，收益为零。
 */
import { readJson, writeJson, STORE, nowSec } from './store.mjs';

const MAX_AFFINITY = 100;
const MIN_AFFINITY = -100;

function path(uin) { return `${STORE}/members/${uin}.json`; }

export function load(uin) {
  return readJson(path(uin), {
    uin: String(uin),
    nick: '', card: '',
    firstSeen: nowSec(), lastSeen: 0,
    msgCount: 0, atMeCount: 0, repliedByMe: 0,
    affinity: 0, tier: '一般',
    tags: [], notes: [],
    lastExchange: '',
    lastReplyAt: 0,        // 我上次回他的时间（成员冷却用）
    spamUntil: 0,          // 判定刷屏后的静默截止时间
  });
}

export function save(p) {
  p.tier = tierOf(p.affinity);
  writeJson(path(p.uin), p);
}

/** 是不是"别的鲸鱼"（群名片/昵称里带鲸鱼） */
export function isOtherWhale(name, pattern = '鲸鱼') {
  return String(name ?? '').includes(pattern);
}

export function tierOf(affinity) {
  if (affinity > 30) return '熟人';
  if (affinity < -30) return '冷淡';
  return '一般';
}

/** 收到一条消息时更新档案；返回更新后的档案 */
export function noteMessage(uin, { nick, card, atMe = false, text = '' } = {}) {
  const p = load(uin);
  p.lastSeen = nowSec();
  p.msgCount += 1;
  if (nick) p.nick = nick;
  if (card) p.card = card;
  if (atMe) p.atMeCount += 1;

  // 关系值微调（规则，零 token）
  if (atMe) addAffinityRaw(p, +3);
  if (/小鲸鱼.*(可爱|厉害|棒|好听|真好)/.test(text)) addAffinityRaw(p, +3);
  if (/(傻逼|滚|闭嘴|垃圾|弱智|废物)/.test(text)) addAffinityRaw(p, -5);

  save(p);
  return p;
}

/** 我回了他一句 */
export function noteReply(uin, myText) {
  const p = load(uin);
  p.repliedByMe += 1;
  p.lastReplyAt = nowSec();
  p.lastExchange = String(myText).slice(0, 60);
  addAffinityRaw(p, +1);
  save(p);
  return p;
}

function addAffinityRaw(p, delta) {
  p.affinity = Math.max(MIN_AFFINITY, Math.min(MAX_AFFINITY, (p.affinity ?? 0) + delta));
}

export function addAffinity(uin, delta, reason = '') {
  const p = load(uin);
  addAffinityRaw(p, delta);
  if (reason) p.notes = [...(p.notes ?? []), `${new Date().toISOString().slice(0, 10)} ${reason}`].slice(-10);
  save(p);
  return p;
}

/** 刷屏判定：60 秒内超过 8 条 → 静默 10 分钟，关系值 -3 */
export function checkSpam(uin) {
  const p = load(uin);
  const t = nowSec();
  if (p.spamUntil > t) return { spam: true, until: p.spamUntil };
  // 用 msgCount 的近似：记录最近消息时间戳
  p.recent = [...(p.recent ?? []).filter((x) => t - x < 60), t];
  if (p.recent.length >= 8) {
    p.recent = [];
    p.spamUntil = t + 600;
    addAffinityRaw(p, -3);
    save(p);
    return { spam: true, until: p.spamUntil };
  }
  save(p);
  return { spam: false };
}

/** 生成给模型看的"这个人是谁"一段话 */
export function profileLine(uin, groupNick = '') {
  const p = load(uin);
  const name = p.card || p.nick || groupNick || `群友${String(uin).slice(-4)}`;
  const bits = [`${name}（${p.tier}，关系 ${p.affinity > 0 ? '+' : ''}${p.affinity}）`];
  if (p.msgCount > 0) bits.push(`发过 ${p.msgCount} 条`);
  if (p.atMeCount > 0) bits.push(`@过我 ${p.atMeCount} 次`);
  if (p.lastExchange) bits.push(`上次跟我说"${p.lastExchange}"`);
  if (isOtherWhale(name)) bits.push('**这是另一只鲸鱼（同类）**');
  if (p.notes?.length) bits.push(`印象：${p.notes.slice(-2).join('；')}`);
  return bits.join('，');
}

/** 语气提示：熟人 / 一般 / 冷淡 说话不一样 */
export function toneHint(uin) {
  const p = load(uin);
  if (p.tier === '熟人') return '跟他熟，可以放松点、接梗、话可以稍微多一点。';
  if (p.tier === '冷淡') return '跟他不太对付，能一个字说完不说两个字，不主动搭话，也不用怼。';
  return '普通群友，客气但不热络。';
}
