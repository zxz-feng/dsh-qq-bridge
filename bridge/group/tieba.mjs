// 贴吧：借 dsh-tieba-dive 的 MCP 只读口子，不自己实现贴吧协议。
//
// 为什么必须借它：贴吧认 TLS 指纹。同一个 URL、同一串 header，用 fetch 直接 403，
// 换 curl 就通（插件 lib/tieba.js 开头的注释也这么写）。插件那边是 curl + cookie jar
// + 手机版页面解析，已经踩完坑了，我们没有理由再造一遍。
//
// 走的是 MCP stdio（JSON-RPC 2.0，一行一条），只读工具：
//   tieba_thread      读楼层正文（贴吧链接 → 说了什么）
//   tieba_list        吧内帖子列表（找图时按吧名扫）
//   tieba_sub_replies 楼中楼
//   tieba_whoami      登录态自检
//   tieba_settings    插件配置（不含 cookie）
//
// 常驻一个子进程，5 分钟没人用就关掉；崩了就下次重开。所有失败都返回 {ok:false}，
// 绝不 throw —— 贴吧挂了不能把回话带崩。

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)
const IDLE_MS = 5 * 60 * 1000
const CALL_TIMEOUT_MS = 25 * 1000

let child = null
let buf = ''
let seq = 0
const waiting = new Map()
let ready = null
let idleTimer = null
let lastErr = ''

/** 插件 mcp-server.mjs 的位置：优先环境变量（宿主解析好传进来），其次猜 profile 目录 */
export function serverPath() {
  const fromEnv = String(process.env.TIEBA_MCP || '').trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const home = String(process.env.DSH_HOME || '/root/dsh')
  const guess = path.join(home, 'profiles/web/node_modules/dsh-tieba-dive/mcp-server.mjs')
  return existsSync(guess) ? guess : ''
}

export const tiebaAvailable = () => Boolean(serverPath())

function send(obj) {
  if (!child) return false
  try { child.stdin.write(JSON.stringify(obj) + '\n'); return true } catch { return false }
}

function failAll(reason) {
  for (const [, w] of waiting) { clearTimeout(w.t); w.resolve({ ok: false, text: reason }) }
  waiting.clear()
}

function kill(reason) {
  const c = child
  child = null; ready = null; buf = ''
  if (c) { try { c.kill('SIGKILL') } catch { /* 已经没了 */ } }
  failAll(reason || '贴吧子进程退出了')
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { if (!waiting.size) kill('空闲回收') }, IDLE_MS)
  if (idleTimer.unref) idleTimer.unref()
}

function start() {
  const file = serverPath()
  if (!file) return null
  child = spawn(process.execPath, [file], {
    cwd: path.dirname(file),
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.on('error', (e) => { lastErr = String(e?.message ?? e); kill('贴吧子进程起不来：' + lastErr) })
  child.on('exit', (code) => { if (child) kill(`贴吧子进程退出（code=${code}）`) })
  child.stderr.on('data', (d) => { lastErr = String(d).trim().slice(-200) })
  child.stdout.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('{')) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const w = waiting.get(msg.id)
      if (!w) continue
      clearTimeout(w.t)
      waiting.delete(msg.id)
      if (msg.error) w.resolve({ ok: false, text: String(msg.error.message || 'MCP 报错') })
      else {
        const r = msg.result || {}
        const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        w.resolve({ ok: !r.isError, text: text || '（空）' })
      }
    }
  })
  ready = new Promise((resolve) => {
    const id = ++seq
    waiting.set(id, {
      t: setTimeout(() => resolve(false), 8000),
      resolve: (v) => resolve(Boolean(v?.ok)),
    })
    send({
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qq-bridge', version: '0.4' } },
    })
    setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 60)
  })
  armIdle()
  return ready
}

/**
 * 调一个贴吧只读工具。
 * @returns {Promise<{ok:boolean, text:string, code?:string}>}
 */
export async function tiebaCall(name, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  if (!serverPath()) return { ok: false, code: 'NO_PLUGIN', text: '没装刷贴吧插件' }
  if (!child && !start()) return { ok: false, code: 'NO_START', text: '贴吧子进程起不来' + (lastErr ? '：' + lastErr : '') }
  const ok = await ready
  if (!ok) return { ok: false, code: 'NO_INIT', text: '贴吧 MCP 没握手成功' + (lastErr ? '：' + lastErr : '') }
  armIdle()
  const id = ++seq
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiting.delete(id)
      resolve({ ok: false, code: 'TIMEOUT', text: '贴吧没在 ' + Math.round(timeoutMs / 1000) + ' 秒内回话' })
    }, timeoutMs)
    waiting.set(id, { t, resolve })
    if (!send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })) {
      clearTimeout(t); waiting.delete(id)
      resolve({ ok: false, code: 'NO_WRITE', text: '贴吧子进程写不进去' })
    }
  })
}

export function tiebaClose() { if (idleTimer) clearTimeout(idleTimer); kill('主动关闭') }

// 进程退出前收拾干净，别留僵尸
process.on('exit', () => { try { tiebaClose() } catch { /* 无所谓 */ } })

// ───────────────────────── 贴吧搜索（当搜索引擎用） ─────────────────────────
//
// MCP 那 7 个工具没有「搜索」，但手机版搜索页是 JSON：
//   https://tieba.baidu.com/mo/q/search/thread?word=xxx&pn=1
// 同一个 cookie 下 curl 直接 200（吧页 HTML 才会 403 安全验证）。
// 所以这条不走 MCP，自己 curl —— 只读、只拿标题/摘要/吧名/tid。

const SEARCH_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'

function cookiePath() {
  if (process.env.TIEBA_COOKIE) return process.env.TIEBA_COOKIE
  const home = String(process.env.DSH_HOME || '/root/dsh')
  return path.join(home, 'tieba-duty', 'cookie.txt')
}

function readCookie() {
  try { return readFileSync(cookiePath(), 'utf8').trim() } catch { return '' }
}

/** 贴吧全站搜索帖子：{ ok, items:[{tid,title,forum,time,content}], hasMore } */
export async function searchPosts(word, { pn = 1 } = {}) {
  const w = String(word ?? '').trim()
  if (!w) return { ok: false, items: [], reason: '没有关键词' }
  const cookie = readCookie()
  if (!cookie) return { ok: false, items: [], reason: '没有贴吧登录态（设置页填 BDUSS）' }

  const url = `https://tieba.baidu.com/mo/q/search/thread?word=${encodeURIComponent(w)}&pn=${pn}`
  const args = ['-sS', '-L', '--max-time', '15', '-A', SEARCH_UA,
    '-H', `Cookie: ${cookie}`, '-H', 'Accept-Language: zh-CN,zh;q=0.9']
  const px = String(process.env.WEB_PROXY || '').trim()
  if (px) args.push('-x', px)
  args.push(url)

  let out = ''
  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 4 * 1024 * 1024, timeout: 20000 })
    out = String(stdout)
  } catch (e) {
    return { ok: false, items: [], reason: `搜索请求失败：${String(e?.message ?? e).slice(0, 60)}` }
  }

  let j
  try { j = JSON.parse(out) } catch {
    return { ok: false, items: [], reason: /安全验证/.test(out) ? '被安全验证拦了' : '搜索页返回不是 JSON' }
  }
  if (j.no !== 0) return { ok: false, items: [], reason: String(j.error || '搜索没成功').slice(0, 60) }

  const list = Array.isArray(j.data?.post_list) ? j.data.post_list : []
  const items = list.map((p) => ({
    tid: String(p.tid || ''),
    title: String(p.title || '').replace(/\s+/g, ' ').slice(0, 60),
    forum: String(p.forum_name || ''),
    content: String(p.content || '').replace(/\s+/g, ' ').slice(0, 120),
    time: Number(p.time || 0),
  })).filter((x) => x.tid && x.title)

  return { ok: true, items, hasMore: Boolean(j.data?.has_more) }
}
