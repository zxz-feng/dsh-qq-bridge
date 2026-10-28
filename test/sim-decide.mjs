/**
 * 决策器统计测试（零 token）
 *
 * 灌几千条合成消息，只看 decide() 的判定分布：
 *   · 说话率是否在预期区间（被叫必回、闲聊 8%）
 *   · 各条抑制规则是否真的生效
 *   · 深夜、额度、冷却能不能压住
 *
 * 用法：node tools/sim-decide.mjs [条数]
 */
import { decide } from '../bridge/group/decide.mjs';

const N = Number(process.argv[2] ?? 3000);
// 直接用真实配置，别在测试里另写一套（否则测的不是线上行为）
import { policyFor } from '../bridge/group/router.mjs';
const policy = policyFor('100000') ?? {};
delete policy.dryRun;

const CHAT = [
  '哈哈哈哈笑死我了', '今天好热啊', '有人在吗', '我吃了个汉堡',
  '这游戏真难', '你们周末干嘛', '刚下班', '困了', '卧槽这什么情况',
  '我明天要考试', '这歌好听', '下雨了', '谁有充电宝', '外卖到了',
];
const QUESTIONS = [
  '小鲸鱼你知道司凤版雨爱是什么梗吗', '这个什么意思啊', '你们谁知道这是啥',
  '为什么最近都在刷这个', '这个怎么读', '谁啊这是',
];
const AT_ME = ['@小鲸鱼 在吗', '@小鲸鱼 唱个歌', '@小鲸鱼 你觉得呢'];
const NOISE = ['。。', '嗯', '1', '哈哈', '好'];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function randHour() {
  // 让白天时段占多数，接近真实活跃分布
  const r = Math.random();
  if (r < 0.15) return 2 + Math.floor(Math.random() * 7);   // 深夜 2-8
  return 9 + Math.floor(Math.random() * 14);                // 9-22
}

const stat = {
  total: 0, speak: 0, hard: 0, soft: 0,
  byReason: new Map(),
  activeByHour: new Map(),
};

let lastSpoke = 0;
let now = Math.floor(Date.now() / 1000) - N * 30;   // 每条间隔 30 秒
const stats = { total: 0, active: 0, ignoredStreak: 0 };
const member = { affinity: 10, lastReplyAt: 0, spamUntil: 0 };

for (let i = 0; i < N; i += 1) {
  now += 20 + Math.floor(Math.random() * 120);

  // 模拟当日额度重置（每 200 条算新的一天）
  if (i > 0 && i % 200 === 0) { stats.total = 0; stats.active = 0; stats.ignoredStreak = 0; }

  const r = Math.random();
  let text; let atMe = false;
  if (r < 0.06) { text = pick(AT_ME); atMe = true; }
  else if (r < 0.20) text = pick(QUESTIONS);
  else if (r < 0.30) text = pick(NOISE);
  else text = pick(CHAT);

  const d = decide({
    text, atMe, replyToMe: false,
    gapSec: 20 + Math.floor(Math.random() * 600),
    policy, stats, member,
    lastSpoke, now, hotwords: ['司凤', '雨爱'], hasImage: Math.random() < 0.15,
  });

  stat.total += 1;
  if (d.speak) {
    stat.speak += 1;
    if (d.hard) stat.hard += 1; else stat.soft += 1;
    lastSpoke = now;
    stats.total += 1;
    if (!d.hard) stats.active += 1;
    stats.ignoredStreak = 0;
    member.lastReplyAt = now;
    const h = new Date(now * 1000).getHours();
    stat.activeByHour.set(h, (stat.activeByHour.get(h) ?? 0) + 1);
  }
  const key = d.reason.replace(/（.*?）/g, '').replace(/→.*/, '').replace(/\d+% 掷出 \d+%/g, '').trim();
  stat.byReason.set(key, (stat.byReason.get(key) ?? 0) + 1);
}

console.log(`\n灌了 ${stat.total} 条，说话 ${stat.speak} 条（${(stat.speak / stat.total * 100).toFixed(1)}%）`);
console.log(`  其中 硬触发 ${stat.hard}，软触发 ${stat.soft}`);
console.log('\n判定原因分布（前 12）：');
[...stat.byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  ${k || '(空)'}`));

console.log('\n主动发言按小时分布：');
[...stat.activeByHour.entries()].sort((a, b) => a[0] - b[0])
  .forEach(([h, v]) => console.log(`  ${String(h).padStart(2)} 点  ${'█'.repeat(Math.min(v, 40))} ${v}`));
