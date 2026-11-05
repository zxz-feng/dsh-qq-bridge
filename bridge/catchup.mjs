// 补拉：桥重连后，把断线期间错过的消息捡回来
//
// 2026-11-05 23:45 的血案：主人在私聊里发了「唱不眠之夜」，NapCat 收到了
// （容器日志有 `接收 <- 私聊`），但桥当时正在重启 → 那条消息没有处理记录，
// 就这么丢了。QQ 不会重发，只能自己回头去拉。
//
// 做法：每次连上 OneBot，读 lastseen.json 记住"每个聊天最后处理到哪一秒"，
// 把比它新的、对方发来的、30 分钟内的消息重新喂给处理函数。
// 第一次运行（没有记录）只回看 RECOVER_SEC 秒，避免把历史消息全回一遍。
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

// 私聊丢一条就是彻底丢了（主人等的是回话），所以窗口放宽到 1 小时；
// 群消息回放容易变成"复读"，窗口收紧到 10 分钟。
const PRIVATE_SEC = 3600
const GROUP_SEC = 600
const COUNT = 8              // 每个聊天拉几条

export function fileOf(home) { return join(home, 'lastseen.json') }

export function loadLastSeen(home) {
  try { return JSON.parse(readFileSync(fileOf(home), 'utf8')) ?? {} } catch { return {} }
}

export function saveLastSeen(home, map) {
  try { writeFileSync(fileOf(home), JSON.stringify(map)) } catch { /* 写不进去就算了，下次再试 */ }
}

/**
 * 纯函数：从历史消息里挑出「该补处理的」
 * @param {Array} list OneBot 返回的消息数组
 * @param {object} opt {sinceSec, nowSec, peer, selfUin, isSeen}
 */
export function pickMissed(list, { sinceSec, nowSec, peer, selfUin, maxAgeSec = 1800, isSeen = () => false }) {
  const out = []
  for (const m of Array.isArray(list) ? list : []) {
    const t = Number(m?.time ?? 0)
    if (!t || t <= sinceSec) continue
    if (nowSec - t > maxAgeSec) continue
    const who = String(m?.sender?.user_id ?? '')
    if (peer != null && who !== String(peer)) continue          // 私聊：只要对方说的
    if (peer == null && selfUin != null && who === String(selfUin)) continue  // 群：别把自己的话当新消息
    if (isSeen(String(m?.message_id ?? ''))) continue
    out.push(m)
  }
  return out.sort((a, b) => Number(a.time) - Number(b.time))
}

function histList(r) {
  return r?.data?.messages ?? r?.messages ?? []
}

/**
 * 连上之后调一次。onPrivate/onGroup 是喂给既有处理函数的回调。
 */
export async function catchUp({ home, callApi, friends = [], groups = [], isSeen, onPrivate, onGroup, selfUin, log = () => {} }) {
  const seen = loadLastSeen(home)
  const nowSec = Math.floor(Date.now() / 1000)
  let n = 0

  const step = async (key, fetch, handle, peerOf, windowSec = GROUP_SEC) => {
    const since = Number(seen[key] ?? nowSec - windowSec)
    let list = []
    try { list = histList(await fetch()) } catch { return }
    const peer = peerOf()
    const missed = pickMissed(list, { sinceSec: since, nowSec, peer, selfUin, maxAgeSec: windowSec, isSeen })
    for (const m of missed) {
      try {
        await handle({
          post_type: 'message',
          message_type: handle === onGroup ? 'group' : 'private',
          user_id: peer,
          group_id: key.startsWith('g') ? Number(key.slice(1)) : undefined,
          message_id: m.message_id,
          message: m.message,
          raw_message: m.raw_message,
          sender: m.sender,
          time: m.time,
          _catchup: true,
        })
        n += 1
      } catch (e) { log(`补拉处理失败 ${key}: ${e?.message ?? e}`) }
    }
    const newest = list.reduce((mx, m) => Math.max(mx, Number(m?.time ?? 0)), 0)
    seen[key] = Math.max(since, newest, nowSec - 1)
  }

  for (const uin of friends) {
    await step(
      `p${uin}`,
      () => callApi('get_friend_msg_history', { user_id: Number(uin), count: COUNT }),
      onPrivate,
      () => String(uin),
      PRIVATE_SEC,
    )
  }

  for (const gid of groups) {
    await step(
      `g${gid}`,
      () => callApi('get_group_msg_history', { group_id: Number(gid), count: COUNT }),
      onGroup,
      // 群里"对方"不固定，pickMissed 里用 selfUin 之外的人 → 这里传一个不可能的值会让全部被过滤，
      // 所以群用宽松判定：只要不是自己发的。
      () => null,
    )
  }

  saveLastSeen(home, seen)
  if (n) log(`[catchup] 补回 ${n} 条断线期间的消息`)
  return n
}
