/**
 * 发言决策器（零 token）
 *
 * 群聊里最重要的一件事不是"会说什么"，是"什么时候闭嘴"。
 * 所以这条链路完全不用模型：纯规则打分 + 概率，几十微秒跑完。
 *
 * 判定顺序（顺序很关键）：
 *   ① 先算软触发分数（和冷却无关，纯看内容）
 *   ② 硬性抑制：深夜 / 日额度 / 刷屏 / 连续被无视 → 直接否，不补回
 *   ③ 硬触发（@我 / 回复我 / 叫我名字）→ 冷却中就"排队补回"
 *   ④ 软触发：分数不够就不说
 *   ⑤ 冷却中 → 同样排队补回（被问了一句却因为冷却装死，最像"坏了"）
 *   ⑥ 掷骰子
 *
 * 「补回」= 返回 deferSec，由 router 定个定时器到点再回，而不是丢掉。
 */

/** 是否落在静默时段（支持跨零点，如 [2,9] / [23,7]） */
export function inQuietHours(hour, [start, end]) {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * @param {object} o
 * @param {string} o.text       本条消息正文
 * @param {boolean} o.atMe      是否 @ 了我
 * @param {boolean} o.replyToMe 是否回复了我的消息
 * @param {number} o.gapSec     距离上一条群消息过了多少秒
 * @param {object} o.policy     本群策略
 * @param {object} o.stats      当日统计
 * @param {object} o.member     当前发言人档案
 * @param {number} o.lastSpoke  我上次说话的时间戳（秒）
 * @param {number} o.now        当前时间戳（秒）
 * @param {string[]} o.hotwords 今日 B站热词
 * @param {boolean} o.hasImage  本条带图/表情包
 * @returns {{speak:boolean, hard:boolean, score:number, prob:number, reason:string, deferSec?:number}}
 */
export function decide({
  text = '', atMe = false, replyToMe = false, gapSec = 9999,
  policy = {}, stats = {}, member = {}, lastSpoke = 0, now = Math.floor(Date.now() / 1000),
  hotwords = [], hasImage = false, isOwner = false, isWhale = false,
}) {
  // 被叫到 = @我 / 回复我 / 正文里出现它的名字（小鲸鱼、肥鱼大小姐…）
  const nicks = (policy.selfNick ?? ['小鲸鱼', '肥鱼大小姐']).filter(Boolean);
  const named = nicks.some((n) => n && text.includes(n));
  const hard = atMe || replyToMe || named;

  // ── ① 软触发打分（不看冷却）──
  let score = 0;
  const why = [];
  if (/[?？]|吗|呢|什么|怎么|为啥|为什么|谁|哪|多少|是不是/.test(text)) { score += 2; why.push('问句'); }
  if (named) { score += 3; why.push('叫我名字'); }
  if (/(哈哈|笑死|草|卧槽|救命|崩了|麻了|无语|绝了)/.test(text)) { score += 1; why.push('情绪强'); }
  if (hasImage) { score += 1; why.push('发图'); }
  if (hotwords.some((w) => w && text.includes(w))) { score += 2; why.push('命中热词'); }
  if ((member.affinity ?? 0) > 30) { score += 1; why.push('熟人'); }
  // 主人说话多留意一点：不加这条，他随口一句"你们多发点表情包"会被当成空气
  if (isOwner) { score += 1; why.push('主人'); }
  if (isWhale) { score += 1; why.push('同类鲸鱼'); }
  const coldAfter = Number(policy.coldAfterMin ?? 30) * 60;
  const cold = gapSec > coldAfter;
  if (cold) { score += 2; why.push('冷场'); }

  // ── ② 硬性抑制：这些情况不补回 ──
  const hour = new Date(now * 1000).getHours();
  if (inQuietHours(hour, policy.quietHours ?? [2, 9])) {
    return { speak: false, hard, score, prob: 0, reason: `静默时段（${hour}点）` };
  }
  if (member.spamUntil && member.spamUntil > now) {
    return { speak: false, hard, score, prob: 0, reason: '这人在刷屏，不理' };
  }

  // ── ③ 硬触发：冷却中也要补回 ──
  if (hard) {
    const hc = Number(policy.hardCooldownSec ?? 3);
    const wait = hc - (now - lastSpoke);
    if (wait > 0) {
      return {
        speak: false, hard: true, score, prob: 0, deferSec: wait,
        reason: `${atMe ? '@我' : (replyToMe ? '回复我' : '叫我名字')}，${wait}s 后补回`,
      };
    }
    return { speak: true, hard: true, score, prob: 1, reason: atMe ? '@我' : (replyToMe ? '回复我' : '叫我名字') };
  }

  // ── ④ 软触发：分数不够就不说（不补回）──
  if (score < 2) {
    return { speak: false, hard: false, score, prob: 0, reason: `分数不够（${score}）` };
  }
  // 额度和"连续被无视"只压主动插话 —— 被叫到时不该被这些挡住
  if ((stats.ignoredStreak ?? 0) >= 2) {
    return { speak: false, hard: false, score, prob: 0, reason: '连续被无视，先闭嘴' };
  }
  if ((stats.active ?? 0) >= Number(policy.dailyActive ?? 4)) {
    return { speak: false, hard: false, score, prob: 0, reason: '今日主动发言额度用完' };
  }
  if ((stats.total ?? 0) >= Number(policy.dailyTotal ?? 100)) {
    return { speak: false, hard: false, score, prob: 0, reason: '今日总发言额度用完' };
  }

  // ── ⑤ 冷却中：排队补回 ──
  const cd = Number(policy.cooldownSec ?? 30);
  const waitGlobal = cd - (now - lastSpoke);
  if (waitGlobal > 0) {
    return { speak: false, hard: false, score, prob: 0, deferSec: waitGlobal, reason: `冷却中，${waitGlobal}s 后补回` };
  }
  const mc = Number(policy.memberCooldownMin ?? 2) * 60;
  const waitMember = member.lastReplyAt ? mc - (now - member.lastReplyAt) : 0;
  if (waitMember > 0) {
    return { speak: false, hard: false, score, prob: 0, deferSec: waitMember, reason: `刚回过这个人，${waitMember}s 后补回` };
  }

  // ── ⑥ 掷骰子 ──
  const base = cold ? Number(policy.coldProb ?? 0.25) : Number(policy.replyProb ?? 0.08);
  const aff = member.affinity ?? 0;
  const prob = Math.max(0, Math.min(1, base * (1 + aff / 200)));
  const roll = Math.random();
  return {
    speak: roll < prob, hard: false, score, prob,
    reason: `${why.join('+')}（${score}分）→ ${(prob * 100).toFixed(0)}% 掷出 ${(roll * 100).toFixed(0)}%`,
  };
}
