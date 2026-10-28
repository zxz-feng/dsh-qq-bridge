#!/usr/bin/env node
/**
 * scripts/verify.mjs —— **不启 DSH 也能自检**（纯 Node，跨平台，零 token）
 * ============================================================================
 * 服务器上以前有一份 bash 的 verify.sh；这份是可移植版：
 *   · 只用 node:net / node:fs，不调 curl、不调 bash（Windows 也能跑）
 *   · 走 bridge 自己的本机控制口（127.0.0.1 + token，token 在 control.json）
 *   · 送修：进程没了会尝试拉起（只在 --fix 时），日志超 5MB 会轮转
 *
 * 用法：
 *   node scripts/verify.mjs                只查
 *   node scripts/verify.mjs --fix          能修的顺手修（拉起进程、轮转日志）
 *   BRIDGE_HOME=/path/to/home node scripts/verify.mjs
 *
 * 退出码：0 = 全通；1 = 有问题（方便挂 cron / systemd timer）
 * ============================================================================
 */
import { readJson, dshHome } from '../lib/home.mjs'
import { runChecks, formatReport } from '../lib/health.mjs'
import { join } from 'node:path'

const PLUGIN_ID = 'qq-bridge'
const HOME = process.env.BRIDGE_HOME || join(dshHome(), PLUGIN_ID)
const FIX = process.argv.includes('--fix')

/** 控制口客户端：把 HTTP 包装成和 Supervisor 一样的形状 */
function controlClient(home) {
  const ctl = readJson(join(home, 'control.json'), null)
  const call = async (action, params = {}) => {
    if (!ctl?.port) throw new Error('没有 control.json（bridge 没起来过？）')
    const res = await fetch(`http://${ctl.host || '127.0.0.1'}:${ctl.port}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctl.token}` },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10000),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`)
    return j.data
  }
  return {
    // 命令行模式下"进程活着"= 控制口能应答（它自己就是那个进程开的）
    info: async () => {
      try {
        const s = await call('status')
        return { alive: true, state: 'up', pid: s?.pid ?? 0, uptimeSec: s?.uptimeSec, restarts: 0 }
      } catch {
        return { alive: false, state: 'down', pid: 0, lastError: '控制口不可达（进程没跑，或 control.json 过期）' }
      }
    },
    call,
    start: async () => { throw new Error('命令行模式下不能代你拉起（用 systemd 或插件托管）') },
    restart: async (why) => { throw new Error(`需要重启（${why}），但命令行模式不代劳`) },
  }
}

const client = controlClient(HOME)
const cfg = readJson(join(HOME, 'config.json'), {}) ?? {}
// QQ 侧要探的是 OneBot 端口（不是代理端口）
let probe = null
try {
  const u = new URL(String(cfg?.onebot?.url ?? 'ws://127.0.0.1:3001').replace(/^ws/, 'http'))
  probe = { host: u.hostname, port: Number(u.port || 80), label: 'OneBot' }
} catch { /* 地址不合法就不探 */ }
const r = await runChecks({ client, home: HOME, cfg, fix: FIX, probe, platform: 'qq' })
console.log(formatReport(r, { name: 'QQ 桥' }))
console.log(`\n家目录：${HOME}`)
console.log(FIX ? '（已尝试自动修复）' : '（只检查；要顺手修加 --fix）')
process.exit(r.passed === r.total ? 0 : 1)
