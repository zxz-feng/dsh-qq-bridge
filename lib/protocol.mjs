/**
 * lib/protocol.mjs —— 宿主进程 ⇄ bridge 子进程的 IPC 协议（父子共用这一份）
 * ============================================================================
 * 上行（子 → 父）
 *   { t:'ready',  info }                     小程序起来了
 *   { t:'log',    level, msg }               日志转发（父进程写 bridge.log）
 *   { t:'reply',  id, ok, data?, error? }     回复某条 cmd
 *   { t:'event',  name, data }               事件（收消息/发消息，给状态页看）
 *
 * 下行（父 → 子）
 *   { t:'cmd',      id, action, params }     调一个能力（status/send/pause/config/reload/restart）
 *   { t:'shutdown' }                         优雅退出
 *
 * 为什么用 fork 自带的 IPC 而不是再加一个端口：
 *   ① 零配置、零端口冲突；② 父子天然同权限；③ 不需要鉴权 token（同一台机器同一个进程树）
 * 需要"不启 DSH 也能自检"时才用 bridge 自己的 loopback 控制口（见 bridge/control.mjs）。
 * ============================================================================
 */

export const T = {
  READY: 'ready',
  LOG: 'log',
  REPLY: 'reply',
  EVENT: 'event',
  CMD: 'cmd',
  SHUTDOWN: 'shutdown',
}

/** 子进程支持的能力（宿主工具和 verify 脚本都按这张表来） */
export const ACTIONS = ['status', 'send', 'pause', 'config', 'reload', 'contexts', 'context_clear', 'restart_self']

export function ts() {
  return new Date().toISOString()
}
