/**
 * lib/health.mjs —— 零 token 自检 / 自愈（插件版 verify.sh）
 * ============================================================================
 * 原则：**只查进程、端口、HTTP、登录态，绝不调模型**。所以随便跑，不花钱。
 *
 * 六个检查项（和服务器上那份 verify.sh 的口径对齐，好让两边看起来一样）：
 *   1 进程       bridge 子进程活着吗
 *   2 桥连接     客户端连上了吗（Telegram 授权状态）
 *   3 依赖       代理端口通不通（配了代理才查）
 *   4 登录态     session 有没有、能不能用
 *   5 卡死判断   在途回复是不是卡住了
 *   6 家目录     可写、余量、日志轮转
 *
 * 能自动修的才修（重启子进程 / 轮转日志），修不了的如实报出来 + 给下一步动作。
 * `client` 只要有两个方法就行：
 *   · call(action, params) → Promise<data>
 *   · info()               → { alive, state, pid, restarts, lastError, uptimeSec }
 * 宿主里传 Supervisor，命令行里传控制口客户端（scripts/verify.mjs），两边同一套逻辑。
 * ============================================================================
 */
import net from 'node:net'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { freeMb, rotateLog, tail } from './home.mjs'

const TCP_TIMEOUT = 4000

function tcpProbe(host, port, timeout = TCP_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (ok, detail) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve({ ok, detail })
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => done(true, `${host}:${port} 通`))
    sock.once('timeout', () => done(false, `${host}:${port} 超时`))
    sock.once('error', (e) => done(false, `${host}:${port} ${e.code || e.message}`))
  })
}

/**
 * @param {object} o
 * @param {any} o.client            Supervisor 或 控制口客户端
 * @param {string} o.home           插件家目录
 * @param {object} o.cfg            当前配置（读 socksUrl / selfHeal / 等）
 * @param {boolean} [o.fix]         是否允许自动修（默认 true）
 * @returns {Promise<{results:Array, passed:number, total:number, fixed:string[]}>}
 */
export async function runChecks({ client, home, cfg = {}, fix = true, probe = null, platform = 'tg' }) {
  const QQ = platform === 'qq'
  const results = []
  const fixed = []
  const add = (name, ok, detail, didFix = '') => {
    results.push({ name, ok, detail, fixed: didFix })
    if (didFix) fixed.push(didFix)
  }

  // ── 1 进程 ────────────────────────────────────────────
  const info = (await client.info?.()) ?? {}
  const alive = info.alive === true
  let status = null
  if (alive) {
    try { status = await client.call('status', {}, { timeoutMs: 8000 }) } catch { status = null }
  }
  let didRestart = ''
  if (!alive && fix && cfg.enabled !== false) {
    try {
      await client.start?.()
      didRestart = '子进程没在跑，已重新拉起'
    } catch (e) { didRestart = `尝试拉起失败：${e?.message ?? e}` }
  }
  const pidText = info.pid ? `pid ${info.pid}，` : ''
  const upText = Number.isFinite(info.uptimeSec) ? `已跑 ${info.uptimeSec}s，` : ''
  add('进程', alive || Boolean(didRestart && fix), alive
    ? `${pidText}${upText}重启过 ${info.restarts ?? 0} 次`
    : (didRestart || `state=${info.state ?? '?'} ${info.lastError ?? ''}`), didRestart)

  // ── 2 桥连接 ──────────────────────────────────────────
  if (!status) {
    add('桥连接', false, '拿不到状态（子进程没起来或没回复）')
  } else if (QQ) {
    if (!status.self) add('桥连接', true, '还没配账号（allowlist.self 为空）—— 没配≠坏了')
    else if (status.onebot?.connected) add('桥连接', true, `已连 ${status.onebot.url}，账号 ${status.self}`)
    else add('桥连接', false, `OneBot 没连上（${status.onebot?.url ?? '?'}）：NapCat 没起？端口不对？`)
  } else if (!status.configured) {
    add('桥连接', true, '未登录（等 tg_login_start）—— 这是「没配」，不是「坏了」')
  } else if (status.connected && status.authorized) {
    add('桥连接', true, `已连接 ${status.account || ''}`)
  } else {
    add('桥连接', false, `未连接/未授权（connected=${status.connected} authorized=${status.authorized}）`)
  }

  // ── 3 依赖（代理 / 或调用方指定的端口，比如 QQ 的 OneBot）────────
  if (probe?.host && probe?.port) {
    const r = await tcpProbe(probe.host, Number(probe.port))
    add('依赖', r.ok, `${probe.label || '依赖端口'} ${r.detail}`)
    // 跳过下面的代理检查
    var probeDone = true
  }
  const socks = String(cfg.socksUrl ?? '').trim()
  if (probeDone) {
    // 端口已经查过了
  } else if (!socks) {
    add('依赖', true, '没有配代理（直连模式）')
  } else {
    try {
      const u = new URL(socks)
      const port = Number(u.port || (u.protocol.startsWith('socks') ? 1080 : 8080))
      const r = await tcpProbe(u.hostname, port)
      add('依赖', r.ok, `代理 ${r.detail}`)
    } catch (e) {
      add('依赖', false, `代理地址解析失败：${e?.message ?? e}`)
    }
  }

  // ── 4 登录态 ──────────────────────────────────────────
  if (!status) {
    add('登录态', false, '拿不到状态')
  } else if (QQ) {
    if (!status.self) add('登录态', false, '白名单里没写 self（自己的 QQ 号）—— 写了才知道该滤掉谁')
    else add('登录态', true, `账号 ${status.self}（NapCat 那边掉线会表现为桥连接不通）`)
  } else if (!status.hasSession) {
    add('登录态', false, '没有 session.txt —— 用 tg_login_start 登录（装完不登录就不会连，安全）')
  } else if (status.authorized) {
    add('登录态', true, `session 有效（${status.me || status.account || '已授权'}）`)
  } else {
    add('登录态', false, 'session 在但没授权 —— 可能要重新登录，或代理不通')
  }

  // ── 5 卡死判断 ────────────────────────────────────────
  if (!status) {
    add('卡死判断', false, '拿不到状态')
  } else if ((status.inflight ?? 0) === 0) {
    add('卡死判断', true, '没有在途回复')
  } else {
    const stuckSec = Math.round((Date.now() - (status.inflightSince ?? Date.now())) / 1000)
    const tooLong = stuckSec > 90
    if (tooLong && fix && (status.stuckCount ?? 0) >= 2) {
      try { await client.restart?.('在途回复卡住'); didRestart = '在途卡住，已重启子进程' } catch { /* 忽略 */ }
      add('卡死判断', false, `在途 ${status.inflight} 条卡了 ${stuckSec}s —— 已重启`, didRestart)
    } else {
      add('卡死判断', !tooLong, `在途 ${status.inflight} 条，已等 ${stuckSec}s${tooLong ? '（再卡一轮就重启）' : ''}`)
    }
  }

  // ── 6 家目录 ──────────────────────────────────────────
  try {
    accessSync(home, constants.W_OK)
    const rotated = fix ? rotateLog(join(home, 'bridge.log'), 5 * 1024 * 1024) : false
    const free = await freeMb(home)
    const size = existsSync(join(home, 'bridge.log')) ? Math.round(statSync(join(home, 'bridge.log')).size / 1024) : 0
    const lowDisk = free !== null && free < 200
    add('家目录', !lowDisk, `可写；日志 ${size}KB；余量 ${free === null ? '未知' : `${free}MB`}`
      + (rotated ? '（日志超 5MB 已轮转）' : ''), rotated ? '日志已轮转' : '')
  } catch (e) {
    add('家目录', false, `不可写：${e?.message ?? e}`)
  }

  const passed = results.filter((r) => r.ok).length
  return { results, passed, total: results.length, fixed }
}

/** 结论口径：跟服务器上那份 verify.sh 一样，一眼能看懂 */
export function formatReport(r, { name = 'Telegram 桥' } = {}) {
  const lines = []
  lines.push(`=== ${name} 自检 ===`)
  for (const x of r.results) {
    lines.push(`${x.ok ? '✅' : '❌'} ${x.name.padEnd(6, '　')} ${x.detail}${x.fixed ? `  ← 已修：${x.fixed}` : ''}`)
  }
  lines.push('')
  lines.push(`结论：${r.passed}/${r.total} ${r.passed === r.total ? '全部通过' : '有问题（见上）'}`)
  if (r.fixed.length) lines.push(`本次自动修了 ${r.fixed.length} 处：${r.fixed.join('；')}`)
  return lines.join('\n')
}

/** 日志尾部（给 tg_status 的 debug 用） */
export function tailLog(home, n = 40) {
  const t = tail(join(home, 'bridge.log'), 16384)
  return t.split('\n').filter(Boolean).slice(-n).join('\n')
}
