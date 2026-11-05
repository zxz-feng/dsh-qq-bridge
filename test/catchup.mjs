// 补拉（catchup）纯函数测试
// 背景：2026-11-05 23:45 主人在私聊发的「唱不眠之夜」因为桥正好在重启而丢失。
// QQ 不会重发，只能连上后自己回头拉 —— 这里测的就是"该拉哪几条"。
import { pickMissed } from '../bridge/catchup.mjs'

let pass = 0
const fails = []
const ok = (c, m) => { if (c) pass += 1; else fails.push(m) }

const NOW = 1_800_000_000
const mk = (id, who, t, text = 'x') => ({ message_id: id, time: t, sender: { user_id: who }, raw_message: text })

// 私聊：只要对方说的
{
  const list = [mk(1, 10086, NOW - 10), mk(2, 340876685, NOW - 9)]
  const got = pickMissed(list, { sinceSec: NOW - 600, nowSec: NOW, peer: 10086 })
  ok(got.length === 1 && got[0].message_id === 1, '私聊只挑对方发的')
}

// 自己的消息（self 发）不算
{
  const list = [mk(3, 340876685, NOW - 5)]
  const got = pickMissed(list, { sinceSec: NOW - 600, nowSec: NOW, peer: null, selfUin: 340876685 })
  ok(got.length === 0, '群里不把自己的话当新消息')
}

// 群里别人的消息要挑出来
{
  const list = [mk(4, 2427517148, NOW - 5), mk(5, 340876685, NOW - 4)]
  const got = pickMissed(list, { sinceSec: NOW - 600, nowSec: NOW, peer: null, selfUin: 340876685 })
  ok(got.length === 1 && got[0].message_id === 4, '群里挑别人说的')
}

// since 之前的不拉
{
  const list = [mk(6, 10086, NOW - 900)]
  ok(pickMissed(list, { sinceSec: NOW - 600, nowSec: NOW, peer: 10086 }).length === 0, '比 lastseen 旧的不拉')
}

// 超过 30 分钟的不拉（防止重启后把半天前的消息全回一遍）
{
  const list = [mk(7, 10086, NOW - 3600)]
  ok(pickMissed(list, { sinceSec: 0, nowSec: NOW, peer: 10086 }).length === 0, '半小时以前的不拉')
}

// 已经在内存里处理过的 id 不重复
{
  const list = [mk(8, 10086, NOW - 30)]
  const got = pickMissed(list, { sinceSec: 0, nowSec: NOW, peer: 10086, isSeen: (id) => id === '8' })
  ok(got.length === 0, '处理过的 id 不重复')
}

// 乱序返回要按时间正序补，否则对话顺序会乱
{
  const list = [mk(10, 10086, NOW - 5), mk(9, 10086, NOW - 50)]
  const got = pickMissed(list, { sinceSec: 0, nowSec: NOW, peer: 10086 })
  ok(got.map((m) => m.message_id).join(',') === '9,10', '按时间正序补')
}

// 脏数据不许炸
{
  ok(pickMissed(null, { sinceSec: 0, nowSec: NOW, peer: 1 }).length === 0, 'null 不炸')
  ok(pickMissed([{ message_id: 11 }], { sinceSec: 0, nowSec: NOW, peer: 1 }).length === 0, '没有 time 的跳过')
  ok(pickMissed([mk(12, 10086, NOW - 1)], { sinceSec: 0, nowSec: NOW, peer: '10086' }).length === 1, '数字/字符串 id 都能比')
}

console.log(`\n补拉：${pass} 通过 / ${fails.length} 失败`)
for (const f of fails) console.log(`  ✗ ${f}`)
process.exit(fails.length ? 1 : 0)
