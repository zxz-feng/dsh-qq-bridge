/**
 * 群聊全链路离线回放
 *
 * 不连 QQ，直接把假事件喂给 router，走完整的
 *   决策 → 生成 → dry-run 发送
 * 链路。用来在"功能完善前不能拉进群"的阶段验证行为。
 *
 * 用法：
 *   node tools/sim-group.mjs            默认 40 条
 *   node tools/sim-group.mjs 120        指定条数（会重复脚本）
 *   GROUP=100000 node tools/sim-group.mjs
 */
import { handleGroupMessage, policyFor } from '../bridge/group/router.mjs';

const GID = process.env.GROUP ?? '100000';
const policy = policyFor(GID);
if (!policy) {
  console.error(`群 ${GID} 不在白名单或已停用，检查 group-allowlist.json`);
  process.exit(1);
}

// 假 callApi：只记录，不真的发
// 虚拟时钟：真实世界里消息是几分钟来一条，模拟时用 Date.now 偏移压缩时间，
// 否则 90 秒冷却会把后面所有消息全挡掉（测不出东西）
let clockOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;
const GAP_MS = Number(process.env.SIM_GAP ?? 45000);

const sent = [];
async function callApi(action, params) {
  sent.push({ action, params });
  return { status: 'ok', retcode: 0, data: { message_id: 900000 + sent.length } };
}

const SCRIPT = [
  ['1001', '老王', '今天好热啊'],
  ['1002', '小林', '哈哈哈哈笑死我了'],
  ['1001', '老王', '有人在吗'],
  ['1003', '阿May', '小鲸鱼你知道司凤版雨爱是什么梗吗'],
  ['1002', '小林', '这歌确实洗脑'],
  ['1004', '路人', '这是什么意思啊'],
  ['1001', '老王', '@小鲸鱼 在吗'],
  ['1003', '阿May', '小鲸鱼唱个雨爱'],
  ['1002', '小林', '我也想听'],
  ['1004', '路人', '哈哈哈哈'],
  ['1001', '老王', '下班了'],
  ['1003', '阿May', '晚上吃啥'],
  ['1002', '小林', '外卖'],
  ['1001', '老王', '又是外卖'],
  ['1004', '路人', '救命好困'],
  ['1003', '阿May', '@小鲸鱼 你觉得呢'],
  ['1002', '小林', '这游戏真难'],
  ['1001', '老王', '谁有充电宝'],
  ['1004', '路人', '我明天要考试'],
  ['1003', '阿May', '加油'],
];

const N = Number(process.argv[2] ?? SCRIPT.length);
console.log(`\n=== 离线回放：群 ${GID}（dry-run=${policy.dryRun !== false}），共 ${N} 条 ===\n`);

let seq = 0;
for (let i = 0; i < N; i += 1) {
  const [uin, name, text] = SCRIPT[i % SCRIPT.length];
  seq += 1;

  // @ 我的消息要构造 at 段
  const atMe = /@小鲸鱼/.test(text);
  const clean = text.replace(/@小鲸鱼\s*/, '');
  const message = atMe
    ? [{ type: 'at', data: { qq: '10001000' } }, { type: 'text', data: { text: ' ' + clean } }]
    : [{ type: 'text', data: { text } }];

  const evt = {
    post_type: 'message',
    message_type: 'group',
    group_id: Number(GID),
    user_id: Number(uin),
    message_id: 500000 + seq,
    raw_message: text,
    message,
    sender: { user_id: Number(uin), nickname: name, card: name },
  };

  await handleGroupMessage(evt, { callApi });
  clockOffset += GAP_MS;          // 每条之间"过了 45 秒"
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`\n=== 回放结束 ===`);
console.log(`假 callApi 收到 ${sent.length} 次调用：`);
for (const s of sent) {
  const msg = String(s.params.message ?? '').slice(0, 70);
  console.log(`  ${s.action} → ${msg}`);
}
