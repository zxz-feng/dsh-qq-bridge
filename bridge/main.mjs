#!/usr/bin/env node
/**
 * bridge/main.mjs —— QQ 桥主循环（子进程）
 * ============================================================================
 * 一个 QQ 号（真人号，扫码登录）→ NapCat（协议端）→ OneBot v11 WebSocket → 这里。
 *
 * 它干三件事：
 *   1. **私聊**：白名单里的好友 → 防抖合并 → 生成 → 发回去
 *   2. **群聊**：交给 group/router.mjs 那条成熟链路（决策器 → 生成 → 贴纸/语音/命令）
 *   3. **对外接口**：本机控制口（127.0.0.1+token）+ 宿主 IPC，工具都从这里进来
 *
 * ⚠️ NapCat 不在插件里：它是**外部依赖**，得自己装（Docker 镜像或桌面版），
 *    插件只按 OneBot v11 说话。这样插件本身跟平台无关，换电脑也能用。
 * ============================================================================
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig, seedFiles, envFor, paths, loadAllowlist, loadGroupCfg, saveConfig } from './config.mjs'
import { startControl } from './control.mjs'
import { T } from '../lib/protocol.mjs'
import { getStyle, setStyle, listStyles } from './group/style.mjs'

const HOME = process.env.BRIDGE_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge')

// 先铺文件、再把配置翻译成环境变量 —— group/* 那些模块在 import 时就会读它们
const made = seedFiles(HOME)
let cfg = loadConfig(HOME)
const env = envFor(cfg, HOME)
env.MEDIA_DIR = env.MEDIA_DIR || join(HOME, 'media')
for (const [k, v] of Object.entries(env)) {
  if (v !== undefined && v !== null && v !== '') process.env[k] = String(v)
}

const log = (...a) => console.log(...a)
const send = (m) => { try { process.send?.(m) } catch { /* 独立跑时没有 IPC */ } }

log(`=== QQ 桥（家目录 ${HOME}）===`)
if (made.length) log(`首次运行，铺了：${made.join('、')}`)

// 动态 import：必须在 env 设好之后
let WebSocket, parseCQ, askDshFor, handleGroupMessage, policyFor, loadGroupConfigFn
let pathsMod, mediaMod
try {
  ;({ default: WebSocket } = await import('ws'))
  ;({ parseCQ } = await import('./cq-parser.mjs'))
  ;({ askDshFor } = await import('./dsh-qq.mjs'))
  ;({ handleGroupMessage, policyFor, loadConfig: loadGroupConfigFn } = await import('./group/router.mjs'))
  pathsMod = await import('./group/paths.mjs')
  mediaMod = await import('./group/media.mjs')
} catch (e) {
  log('模块加载失败（依赖没装？先 npm install）:', e?.message ?? e)
  process.exit(1)
}

// ── 状态 ──────────────────────────────────────────────
let ws = null
let connected = false
let lastError = ''
let startedAt = Date.now()
const counters = { privateIn: 0, privateOut: 0, groupIn: 0, failed: 0 }
let control = { port: 0, close: () => {} }

function reloadCfg() {
  cfg = loadConfig(HOME)
  return cfg
}

function currentMode() {
  return reloadCfg().mode
}

function todayKey() { return new Date().toLocaleDateString('zh-CN') }

/** 每日生成计数（跨天自动归零；读写都是同步小文件，崩了不会毁数据） */
function countToday() {
  try {
    const c = JSON.parse(readFileSync(join(HOME, 'daily-count.json'), 'utf8'))
    return c.date === todayKey() ? c.n : 0
  } catch { return 0 }
}
function bumpCount() {
  let c = { date: todayKey(), n: 0 }
  try { c = JSON.parse(readFileSync(join(HOME, 'daily-count.json'), 'utf8')) } catch { /* 首次 */ }
  if (c.date !== todayKey()) c = { date: todayKey(), n: 0 }
  c.n += 1
  try { writeFileSync(join(HOME, 'daily-count.json'), JSON.stringify(c)) } catch { /* 忽略 */ }
  return c.n
}

// ── OneBot 连接 ───────────────────────────────────────
let echoSeq = 0
const waiters = new Map()

function connect() {
  const c = reloadCfg()
  const url = c.onebot.token
    ? `${c.onebot.url}?access_token=${encodeURIComponent(c.onebot.token)}`
    : c.onebot.url
  ws = new WebSocket(url)

  ws.on('open', () => {
    connected = true
    log(`[onebot] 已连接 ${c.onebot.url}`)
  })

  ws.on('message', (data) => {
    let evt
    try { evt = JSON.parse(data.toString()) } catch { return }
    if (evt.echo && waiters.has(evt.echo)) {
      waiters.get(evt.echo)(evt)
      waiters.delete(evt.echo)
      return
    }
    if (evt.post_type === 'message' && evt.message_type === 'private') { void handlePrivate(evt); return }
    if (evt.post_type === 'message' && evt.message_type === 'group') {
      counters.groupIn += 1
      void handleGroupMessage(evt, { callApi })
    }
  })

  ws.on('close', () => {
    connected = false
    log('[onebot] 连接断开，5 秒后重连')
    setTimeout(connect, 5000)
  })

  ws.on('error', (e) => {
    lastError = e?.message ?? String(e)
    console.error('[onebot] 错误:', lastError)
  })
}

function callApi(action, params = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { resolve({ status: 'failed' }); return }
    const echo = `e${++echoSeq}`
    const timer = setTimeout(() => { waiters.delete(echo); resolve({ status: 'timeout' }) }, timeoutMs)
    waiters.set(echo, (r) => { clearTimeout(timer); resolve(r) })
    ws.send(JSON.stringify({ action, params, echo }))
  })
}

// ── 私聊 ──────────────────────────────────────────────
const pending = new Map()

function randomDelay() {
  const { debounceMinSec: lo, debounceMaxSec: hi } = reloadCfg().behavior
  const a = Math.min(lo, hi) * 1000
  const b = Math.max(lo, hi) * 1000
  return a + Math.floor(Math.random() * (b - a + 1))
}

async function handlePrivate(evt) {
  try {
    const allow = loadAllowlist(HOME)
    const SELF = String(allow.self ?? '')
    const friends = new Set(Object.keys(allow.friends ?? {}).filter((k) => allow.friends[k]?.enabled !== false))
    const labelOf = (qq) => allow.friends?.[String(qq)]?.label ?? String(qq)

    const from = String(evt.user_id ?? evt.sender?.user_id ?? '')
    if (!from || from === SELF) return
    if (!friends.has(from)) return

    const parsed = parseCQ(evt.message ?? evt.raw_message ?? '')
    if (!parsed.text && parsed.images.length === 0) return

    counters.privateIn += 1
    const now = new Date().toLocaleTimeString('zh-CN')
    log(`[${now}] [${labelOf(from)}] ${parsed.text}${parsed.images.length ? ` (+${parsed.images.length}图)` : ''}`)
    appendFileSync(join(HOME, 'inbox.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), from, text: parsed.text,
      images: parsed.images.map((i) => i.url ?? i.file), msgId: evt.message_id,
    }) + '\n')

    let e = pending.get(from)
    if (!e) { e = { msgs: [], images: [], timer: null }; pending.set(from, e) }
    if (parsed.text) e.msgs.push(parsed.text)
    if (parsed.images.length) e.images.push(...parsed.images)
    if (e.timer) clearTimeout(e.timer)
    const wait = randomDelay()
    e.timer = setTimeout(() => { void flushPrivate(from) }, wait)
    log(`  ⏳ 排队，${(wait / 1000).toFixed(1)}s 后回复`)
  } catch (err) {
    console.error('[handler]', err?.message ?? err)
  }
}

async function flushPrivate(qq) {
  const e = pending.get(qq)
  if (!e) return
  pending.delete(qq)

  const mode = currentMode()
  if (mode === 'off') { log('  模式 off，忽略'); return }

  const incoming = e.msgs.join('\n') || '(只发了图片)'
  log(`  模式 ${mode}，生成中…`)
  let draft
  try { draft = await askDshFor(qq, incoming, e.images) } catch (err) {
    counters.failed += 1
    console.error('  ❌ 生成失败:', err?.message ?? err)
    return
  }
  if (!draft) { counters.failed += 1; console.error('  ❌ 空回复'); return }

  log(`  💬 ${draft}`)
  bumpCount()

  if (mode === 'auto') {
    const r = await callApi('send_private_msg', { user_id: Number(qq), message: draft })
    const ok = r?.status === 'ok' || r?.retcode === 0
    if (ok) counters.privateOut += 1
    appendFileSync(join(HOME, 'replies.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), to: qq, incoming, draft, status: ok ? 'sent' : 'failed',
    }) + '\n')
    log(ok ? '  ✅ 已发出' : `  ❌ 发送失败: ${JSON.stringify(r)}`)
  } else {
    appendFileSync(join(HOME, 'replies.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), to: qq, incoming, draft, status: 'pending',
    }) + '\n')
    log(`  📝 待发送（模式 ${mode}）：${draft}`)
  }
}

// ── 状态 / 动作 ───────────────────────────────────────
function status() {
  const allow = loadAllowlist(HOME)
  const g = loadGroupCfg(HOME)
  let groups = []
  try {
    groups = Object.entries(g.groups ?? {}).map(([gid, v]) => ({
      gid, label: v.label ?? '', dryRun: v.dryRun !== false, enabled: v.enabled !== false,
    }))
  } catch { /* 忽略 */ }
  return {
    configured: Boolean(allow.self && Object.keys(allow.friends ?? {}).length),
    self: allow.self || '',
    friends: Object.keys(allow.friends ?? {}).filter((k) => allow.friends[k]?.enabled !== false),
    groups,
    onebot: { url: cfg.onebot.url, connected },
    mode: cfg.mode,
    today: countToday(),
    counters,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    pid: process.pid,
    lastError,
    control: { port: control.port },
    media: { host: pathsMod?.HOST_MEDIA ?? '', cq: pathsMod?.CQ_MEDIA ?? '' },
    python: { bili: Boolean(process.env.BILI_PY), asr: Boolean(process.env.BILI_PY_ASR) },
    stickers: (() => { try { return mediaMod?.stickerCount ? mediaMod.stickerCount() : 0 } catch { return 0 } })(),
  }
}

const actions = {
  async status() { return status() },

  async send_private({ userId, text }) {
    if (!userId || !text) throw new Error('send_private 需要 userId 和 text')
    const r = await callApi('send_private_msg', { user_id: Number(userId), message: String(text) })
    const ok = r?.status === 'ok' || r?.retcode === 0
    if (ok) counters.privateOut += 1
    return { ok, raw: ok ? undefined : r }
  },

  async send_group({ groupId, text, dryRun }) {
    if (!groupId || !text) throw new Error('send_group 需要 groupId 和 text')
    if (dryRun) return { ok: true, dryRun: true, wouldSend: String(text) }
    const r = await callApi('send_group_msg', { group_id: Number(groupId), message: String(text) })
    // ⚠️ NapCat 群发常返回 retcode 1200 / EventChecker Failed，但**消息其实发出去了**
    const text2 = JSON.stringify(r ?? {})
    const ok = r?.status === 'ok' || r?.retcode === 0 || /EventChecker|rich media transfer failed/i.test(text2)
    return { ok, messageId: r?.data?.message_id ?? null, note: ok && r?.retcode !== 0 ? '假失败（消息已发出）' : undefined }
  },

  async groups() {
    const g = loadGroupCfg(HOME)
    return Object.entries(g.groups ?? {}).map(([gid, v]) => ({
      gid, ...v, effective: { ...(g.defaults ?? {}), ...v },
    }))
  },

  async config({ patch }) {
    if (!patch || typeof patch !== 'object') return { ok: true, config: reloadCfg() }
    const next = saveConfig(HOME, patch)
    return { ok: true, config: next, note: '改完即时生效（bridge 每轮重读配置）' }
  },

  async allowlist() {
    return { allow: loadAllowlist(HOME), group: loadGroupCfg(HOME) }
  },

  // 说话风格档：切/查/列。校验放在桥里，宿主工具只转发（一份真相）
  async style({ gid, style, intensity } = {}) {
    // 不传 gid = 只要风格档清单（设置页的下拉框要，免得宿主那边再抄一份解析器）
    if (!gid) {
      return {
        ok: true,
        available: listStyles().map((x) => ({
          id: x.id, name: x.name, aliases: x.aliases, short: x.short, bias: x.bias,
        })),
      }
    }
    const id = String(gid)
    if (!style) {
      return { ok: true, gid: id, ...getStyle(id), available: listStyles().map((x) => ({ id: x.id, name: x.name, aliases: x.aliases })) }
    }
    const s = setStyle(id, style, { by: 'tool', intensity })
    if (!s) {
      const names = listStyles().map((x) => `${x.id}(${x.name})`).join(' / ')
      throw new Error(`没有这个风格：${style}；可选 ${names}`)
    }
    return { ok: true, gid: id, ...s }
  },

  async restart_self() {
    log('[control] 收到 restart_self，退出等宿主拉起')
    setTimeout(() => { void shutdown('restart_self') }, 50)
    return { ok: true }
  },
}

async function runAction(name, params = {}) {
  const fn = actions[name]
  if (!fn) throw new Error(`未知动作：${name}`)
  return fn(params)
}

// ── IPC ───────────────────────────────────────────────
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return
  if (m.t === T.SHUTDOWN) { void shutdown('ipc-shutdown'); return }
  if (m.t === T.CMD) {
    runAction(m.action, m.params)
      .then((data) => send({ t: T.REPLY, id: m.id, ok: true, data }))
      .catch((e) => send({ t: T.REPLY, id: m.id, ok: false, error: String(e?.message ?? e) }))
  }
})

// ── 退出 ──────────────────────────────────────────────
let shuttingDown = false
async function shutdown(why) {
  if (shuttingDown) return
  shuttingDown = true
  log(`收到 ${why}，收摊…`)
  try { control.close() } catch { /* 忽略 */ }
  try { ws?.close() } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('uncaughtException', (e) => {
  counters.failed += 1
  lastError = e?.message ?? String(e)
  console.error('[guard] 未捕获异常:', lastError)
})
process.on('unhandledRejection', (r) => {
  console.error('[guard] 未处理拒绝:', r?.message ?? String(r))
})

// ── 起 ────────────────────────────────────────────────
log(`账号: ${loadAllowlist(HOME).self || '(未配，白名单为空 = 谁都不回)'}`)
const gcfg = loadGroupCfg(HOME)
const glist = Object.entries(gcfg.groups ?? {}).filter(([, v]) => v.enabled !== false)
log(glist.length
  ? `群白名单: ${glist.map(([k, v]) => `${v.label ?? k}${v.dryRun === false ? '' : '(dry-run)'}`).join(', ')}`
  : '群白名单: (空，群消息一律忽略)')
log(`模式: ${cfg.mode}`)

control = await startControl({ home: HOME, cfg, handlers: actions })

if (cfg.enabled) connect()
else log('配置 enabled=false，不连 OneBot')

send({ t: T.READY, info: { home: HOME, controlPort: control.port, self: loadAllowlist(HOME).self } })
log('就绪')
