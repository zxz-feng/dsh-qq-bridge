/**
 * bridge/group/agent.mjs —— 让 DSH 亲自当群友
 * ============================================================================
 * 和 `generate.mjs` 的分工：
 *   generate.mjs  一次模型调用，代码决定"查不查、发不发语音"（旧路）
 *   agent.mjs     一个 DSH 会话，模型自己决定查不查、说不说、唱不唱、发不发语音
 *
 * 为什么是"每条消息起一个进程"而不是常驻 JSON-RPC：
 *   实测冷启动 3.82s、峰值 241MB；这台机器 total 1708MB / available 356MB，
 *   常驻等于把最后一点余量吃光（2026-11-04 已经 OOM 两次）。进程式用完即还。
 *
 * 四级模型回退（主人指定顺序）：
 *   1 workbuddy-intl / deepseek-v4.1-flash   （免费档，思考强度 low）
 *   2 workbuddy-cn   / deepseek-v4.1-flash
 *   3 workbuddy-cn   / deepseek-v4-pro
 *   4 workbuddy-intl / hy3                    （免费档）
 *   同级失败重试一次再降级；四级全灭 → 抛错，由调用方回落 generate.mjs。
 *
 * 输出契约（系统提示里已经写死）：
 *   {"reply":"...","voice":false,"sing":null,"sticker":null,"silence":false}
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const DSH_BIN = process.env.DSH_BIN || '/root/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh'
const PROFILE_DIR = process.env.DSH_QQCHAT_PROFILE || '/root/dsh/profiles/qqchat'
const BRIDGE_DIR = process.env.QQ_BRIDGE_DIR || '/root/工位/repos/dsh-qq-bridge'
const DSH_HOME = process.env.DSH_HOME || '/root/dsh'
const STORE_DIR = process.env.STORE_DIR || join(DSH_HOME, 'qq-bridge')
const SESS_FILE = join(STORE_DIR, 'agent-sessions.json')
const CWD = process.env.AGENT_CWD || '/root/工位'

const DEFAULT_MODELS = [
  { level: 1, provider: 'workbuddy-intl', model: 'deepseek-v4.1-flash' },
  { level: 2, provider: 'workbuddy-cn', model: 'deepseek-v4.1-flash' },
  { level: 3, provider: 'workbuddy-cn', model: 'deepseek-v4-pro' },
  { level: 4, provider: 'workbuddy-intl', model: 'hy3' },
]

/** 这些失败换一级再来；其它（比如 prompt 太长）降级也没用，直接抛 */
const RETRYABLE = /MISSING_CREDENTIAL|RATE_LIMIT|QUOTA|EMPTY_RESPONSE|SERVER|TIMEOUT|TRANSPORT|ACCOUNT_SIGN_IN|overloaded|429|500|502|503|504/i

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 排队闸 ────────────────────────────────────────────────────────────────
// 为什么必须串行：一个 DSH 进程峰值 241MB，这台机器只剩 ~356MB。
// 群里三个人同时叫她 = 三个进程 = 723MB = 直接 OOM（10-25、11-03 各挂过一次）。
// 主人的要求是「排队」，不是「并发」，所以这里就是一条队列。
const LIMIT = Math.max(1, Number(process.env.AGENT_CONCURRENCY || 1))
const WAIT_MAX_MS = 180_000
const QUEUE_MAX = 8
let active = 0
const waiters = []

async function acquire(log = console.log) {
  if (active < LIMIT) { active += 1; return }
  if (waiters.length >= QUEUE_MAX) throw new Error(`QUEUE_FULL：前面还排着 ${QUEUE_MAX} 条`)
  log(`  [agent] 排队中（前面 ${waiters.length + 1} 条）`)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = waiters.findIndex((w) => w.fn === fn)
      if (i >= 0) waiters.splice(i, 1)
      reject(new Error('QUEUE_TIMEOUT：排队超过 180 秒'))
    }, WAIT_MAX_MS)
    const fn = () => { clearTimeout(t); resolve() }
    waiters.push({ fn })
  })
  // 被唤醒时槽位已经移交过来，不要再 +1
}

function release() {
  const next = waiters.shift()
  if (next) { next.fn(); return }   // 槽位移交，计数不变
  active = Math.max(0, active - 1)
}

// ── 会话表 ────────────────────────────────────────────────────────────────
function loadSessions() {
  try { return JSON.parse(readFileSync(SESS_FILE, 'utf8')) } catch { return {} }
}
function saveSessions(obj) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const tmp = `${SESS_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, null, 2))
    renameSync(tmp, SESS_FILE)
  } catch (e) { console.error('  [agent] 会话表写不进去:', e.message) }
}

/**
 * 从模型最后那段话里抠出 JSON。模型经常"先说一句 + 再贴 JSON"，
 * 也可能包 ```json 围栏，所以从后往前找第一个能解析且带 reply 的对象。
 */
export function extractJson(text) {
  const s = String(text ?? '')
  const cands = []
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (s[i] !== '}') continue
    for (let j = i - 1; j >= 0; j -= 1) {
      if (s[j] !== '{') continue
      const piece = s.slice(j, i + 1)
      if (piece.length > 4000) break
      try {
        const o = JSON.parse(piece)
        if (o && typeof o === 'object' && ('reply' in o || 'silence' in o)) cands.push(o)
      } catch { /* 不是 JSON，继续往左找 */ }
      break // 只试最靠左的 {，避免 O(n²)
    }
    if (cands.length) break
  }
  return cands[0] ?? null
}

/** 把 agent 的 JSON 翻成 generate.mjs 那套返回结构，router 一行都不用改 */
export function toOutput(obj) {
  const out = { parts: [], stickers: [], voices: [], sings: [], reads: [], infos: [], looks: [], tiebas: [], pictures: [], searched: false, agent: true }
  if (!obj) return out
  // 不设字数上限（2026-11-04 主人要求）：模型用 \n 分段，一段发一条，
  // 最多 4 条 —— 再多就不是聊天，是刷屏了。
  const reply = String(obj.reply ?? '').replace(/\r/g, '').trim()
  if (obj.silence === true || !reply) { out.passed = true; return out }
  const chunks = reply.split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, 4)
  out.parts = chunks.length ? chunks : [reply]
  // 语音只能是"一段话"，所以多段时合并成一句，交给 router 只发一条语音
  if (obj.voice === true) out.voices = [chunks.join('，')]
  if (obj.sing) {
    const name = String(obj.sing).trim()
    // 「首歌 / 一首歌 / 歌」这种不是歌名，是"随便唱" —— 交回 router 的随机逻辑
    if (name && !/^(一?首|一?支|个)?歌(曲)?$/.test(name)) out.sings = [name]
  }
  if (obj.sticker) out.stickers = [String(obj.sticker).trim()]
  return out
}

// ── 起一个 DSH 会话跑一轮 ──────────────────────────────────────────────────
function runOnce({ prompt, sessionId, level, timeoutMs }) {
  return new Promise((resolve) => {
    const patch = join(PROFILE_DIR, 'models', `${level}.yml`)
    const args = ['--profile', 'qqchat']
    if (existsSync(patch)) args.push('--patch', patch)
    if (sessionId) args.push('--session-id', sessionId)
    args.push('--json', prompt)

    const child = spawn(DSH_BIN, args, {
      cwd: CWD,
      env: {
        ...process.env,
        DSH_HOME,
        QQ_BRIDGE_DIR: BRIDGE_DIR,
        // headless 关掉了 credentials 插件，密钥只能从环境来
        WORKBUDDY_GATEWAY_API_KEY: process.env.WORKBUDDY_GATEWAY_API_KEY || 'wb-gateway-local',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let buf = ''
    let err = ''
    let finalText = ''
    let sid = sessionId || ''
    let turnError = null
    let usage = null
    const tools = []
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch { /* 已经死了 */ }
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        let ev
        try { ev = JSON.parse(t) } catch { continue }
        if (ev.type === 'session' && ev.sessionId) sid = ev.sessionId
        if (ev.type === 'tool_call') tools.push(ev.tool)
        if (ev.type === 'final') finalText = String(ev.text ?? '')
        if (ev.type === 'status' && ev.usage) usage = ev.usage
        if (ev.type === 'turn_end' && ev.reason?.kind === 'error') {
          turnError = ev.reason.error?.message || 'unknown error'
        }
      }
    })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `spawn 失败：${e.message}`, sessionId: sid, tools })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const error = turnError || (killed ? 'TIMEOUT' : (code !== 0 ? (err.trim().split('\n').pop() || `exit ${code}`) : ''))
      resolve({ ok: !error && Boolean(finalText), text: finalText, error, sessionId: sid, usage, tools, code })
    })
  })
}

/**
 * 跑一轮 agent。
 * @param {object} o
 * @param {string} o.chatKey  群号或 p+QQ号
 * @param {string} o.prompt   已经拼好记忆+人设+消息的完整输入
 * @param {object} [o.policy]
 * @returns {Promise<{parts,stickers,voices,sings,model,usage,tools,sessionId,level}>}
 */
export async function runAgent({ chatKey, prompt, policy = {}, log = console.log }) {
  await acquire(log)
  try {
    return await runAgentInner({ chatKey, prompt, policy, log })
  } finally {
    release()
  }
}

async function runAgentInner({ chatKey, prompt, policy = {}, log = console.log }) {
  const models = Array.isArray(policy.agentModels) && policy.agentModels.length
    ? policy.agentModels
    : DEFAULT_MODELS
  const timeoutMs = Math.min(180_000, Math.max(20_000, Number(policy.agentTimeoutMs) || 60_000))
  const sessions = loadSessions()
  let sessionId = sessions[chatKey] || ''

  let lastErr = ''
  for (const m of models) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const t0 = Date.now()
      const r = await runOnce({ prompt, sessionId, level: m.level ?? 1, timeoutMs })
      const ms = Date.now() - t0
      if (r.sessionId && r.sessionId !== sessionId) {
        sessionId = r.sessionId
        sessions[chatKey] = sessionId
        saveSessions(sessions)
      }
      if (r.ok) {
        const obj = extractJson(r.text)
        if (!obj) {
          lastErr = '输出里没有 JSON'
          log(`  [agent] L${m.level} 没有 JSON（${ms}ms）→ 重试/降级`)
          continue
        }
        const out = toOutput(obj)
        out.model = `${m.provider}/${m.model}`
        out.level = m.level
        out.usage = r.usage || null
        out.tools = r.tools
        out.sessionId = sessionId
        out.ms = ms
        log(`  [agent] L${m.level} ${m.model} 成功（${ms}ms${r.tools.length ? `，工具 ${r.tools.join(',')}` : ''}）`)
        return out
      }
      lastErr = r.error || '未知失败'
      log(`  [agent] L${m.level} ${m.model} 第 ${attempt} 次失败：${String(lastErr).slice(0, 90)}（${ms}ms）`)
      if (!RETRYABLE.test(lastErr) && attempt >= 1) break   // 不可重试的错误直接降级
      await sleep(600)
    }
  }
  throw new Error(`agent 四级全灭：${lastErr}`)
}

export const AGENT_MODELS = DEFAULT_MODELS
