#!/usr/bin/env node
/**
 * test/api.mjs —— 设置页那组 HTTP 路由的离线测试（零 token、不连 QQ、不起桥）
 * ============================================================================
 * 为什么要单独一份：设置页最容易出的错不是「界面难看」，是
 *   · 前端能改的东西后端没钳位（填 999 就真写 999）
 *   · 脱敏漏了（token 原样吐给浏览器）
 *   · 路由挂上了但同源没判（随便一个网页就能改配置）
 * 这三类都能在没账号的机器上验完。
 *
 * 跑：`node test/api.mjs`（`npm test` 会顺带跑）
 * ============================================================================
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const HOME = mkdtempSync(join(tmpdir(), 'qqapi-'))
process.env.DSH_HOME = HOME
process.env.DSH_TELEGRAM_HOME = join(HOME, 'qq-bridge')

const { apply } = await import('../index.js')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`) }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`)

/* ── 假的宿主 ctx（够 apply() 用就行） ─────────────── */
const tools = []
let route = null
const disposers = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (t) => { tools.push(t); return () => {} } },
  effect: (fn) => { disposers.push(fn()); return () => {} },
  webServer: { register: (opts) => { route = opts; return () => {} } },
  get: () => undefined,
}

// enabled:false ⇒ 桥不会被拉起（这条很重要：测试不该碰真实 QQ）
apply(ctx, { enabled: false })

console.log('\n【装载】')
eq('注册了 12 个工具', tools.length, 12)
ok('有 qq_style', tools.some((t) => t.name === 'qq_style'))
ok('路由挂上了 /api/qq-bridge', route?.path === '/api/qq-bridge' && typeof route.handler === 'function')
ok('路由 kind=prefix', route?.kind === 'prefix')

const server = createServer((req, res) => { route.handler(req, res) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const API = `${BASE}/api/qq-bridge`
const same = { origin: BASE }

const jget = async (p, headers = {}) => {
  const res = await fetch(API + p, { headers })
  let body = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}
const jpost = async (p, obj, headers = {}) => {
  const res = await fetch(API + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(obj ?? {}),
  })
  let body = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}

/* ── 1. 状态 / 配置 ─────────────────────────────── */
console.log('\n【状态】')
{
  const r = await jget('/status')
  eq('status 200', r.status, 200)
  eq('enabled 读出来是 false', r.body.enabled, false)
  ok('带 process 字段', r.body.process && typeof r.body.process === 'object')
  ok('桥没跑时 bridge.error 有值（不抛 500）', typeof r.body.bridge?.error === 'string')
}

console.log('\n【配置】')
{
  const r = await jget('/config')
  eq('config 200', r.status, 200)
  eq('默认 mode=auto', r.body.config.mode, 'auto')
  ok('带 defaults（前端显示「继承默认」要用）', r.body.defaults && r.body.defaults.mode === 'auto')

  const w = await jpost('/config', { patch: { mode: 'draft' } }, same)
  eq('改 mode 200', w.status, 200)
  eq('mode 落盘成 draft', w.body.config.mode, 'draft')

  const bad = await jpost('/config', { patch: { mode: '乱写' } }, same)
  eq('乱写 mode 被钳回默认', bad.body.config.mode, 'auto')

  const cl = await jpost('/config', { patch: { behavior: { debounceMinSec: 999, debounceMaxSec: 5 } } }, same)
  eq('debounceMinSec 钳到 120', cl.body.config.behavior.debounceMinSec, 120)
  eq('max 不许小于 min（被抬到 120）', cl.body.config.behavior.debounceMaxSec, 120)

  // 脱敏：先塞一个 token，再读
  await jpost('/config', { patch: { onebot: { token: 'abcdef123456' }, llm: { apiKey: 'sk-very-secret-9876' } } }, same)
  const m = await jget('/config')
  eq('onebot.token 打码', m.body.config.onebot.token, '••••3456')
  eq('llm.apiKey 打码', m.body.config.llm.apiKey, '••••9876')
  ok('响应里没有明文 token', !JSON.stringify(m.body).includes('abcdef123456'))
  ok('响应里没有明文 key', !JSON.stringify(m.body).includes('sk-very-secret'))
}

/* ── 2. 群策略 ─────────────────────────────────── */
console.log('\n【群策略】')
{
  const g0 = await jget('/groups')
  eq('groups 200', g0.status, 200)
  ok('还没配群 ⇒ groups 是空数组', Array.isArray(g0.body.groups) && g0.body.groups.length === 0)
  ok('available 是数组（桥没跑时为空）', Array.isArray(g0.body.available))
  eq('桥没跑时 bridgeUp=false', g0.body.bridgeUp, false)

  const w = await jpost('/groups', { gid: '123456789', patch: { label: '测试群', replyProb: 9, dailyActive: 3 } }, same)
  eq('加群 200', w.status, 200)
  eq('replyProb 9 被钳到 1', w.body.group.replyProb, 1)
  eq('label 保留', w.body.group.label, '测试群')

  const w2 = await jpost('/groups', { gid: '123456789', patch: { quietHours: [99, -3] } }, same)
  eq('quietHours 钳到 [23,0]', w2.body.group.quietHours, [23, 0])

  const bad = await jpost('/groups', { gid: 'abc', patch: { replyProb: 1 } }, same)
  eq('群号不是数字 ⇒ ok:false', bad.body.ok, false)
  ok('给得出原因', typeof bad.body.error === 'string' && bad.body.error.length > 0)

  const g1 = await jget('/groups')
  eq('群数 = 1', g1.body.groups.length, 1)
  eq('effective 继承了 defaults（dailyTotal=100）', g1.body.groups[0].effective.dailyTotal, 100)
  eq('effective 用群自己的值（label 不影响）', g1.body.groups[0].effective.replyProb, 1)
  ok('有 defaults 供前端显示', g1.body.defaults && typeof g1.body.defaults.replyProb === 'number')
}

/* ── 3. 风格档 ─────────────────────────────────── */
console.log('\n【风格档】')
{
  const s = await jget('/styles')
  eq('styles 200', s.status, 200)
  ok('桥没跑 ⇒ ok:false 且 available 为空数组', s.body.ok === false && Array.isArray(s.body.available))
  const bad = await jpost('/style', { gid: '123456789' }, same)
  eq('缺 style ⇒ 400', bad.status, 400)
}

/* ── 4. 好友白名单 ─────────────────────────────── */
console.log('\n【好友】')
{
  const f0 = await jget('/friends')
  eq('friends 200', f0.status, 200)
  ok('初始为空', Object.keys(f0.body.friends ?? {}).length === 0)

  const a = await jpost('/friends', { uin: '20002000', label: '主人' }, same)
  eq('加好友 200', a.status, 200)
  eq('进白名单了', a.body.allow.friends['20002000'].label, '主人')
  eq('默认启用', a.body.allow.friends['20002000'].enabled, undefined)   // 没显式给就是默认启用

  const b = await jpost('/friends', { uin: '20002000', enabled: false }, same)
  eq('暂停', b.body.allow.friends['20002000'].enabled, false)
  eq('备注没被冲掉', b.body.allow.friends['20002000'].label, '主人')

  const bad = await jpost('/friends', { uin: 'xx' }, same)
  eq('QQ 号不对 ⇒ ok:false', bad.body.ok, false)

  const d = await jpost('/friends', { uin: '20002000', remove: true }, same)
  eq('删掉了', d.body.allow.friends['20002000'], undefined)
}

/* ── 5. 运维：日志 / 404 / 同源 ─────────────────── */
console.log('\n【运维与安全】')
{
  const l = await jget('/log?lines=20')
  eq('log 200', l.status, 200)
  ok('tail 是字符串', typeof l.body.tail === 'string')

  const nf = await jget('/nope')
  eq('未知路由 404', nf.status, 404)
  eq('404 带 ok:false', nf.body.ok, false)

  const cross = await jget('/status', { origin: 'http://evil.example' })
  eq('别的网页来打 ⇒ 403', cross.status, 403)
  ok('403 说明是同源问题', /同源/.test(cross.body.error || ''))

  const crossPost = await jpost('/config', { patch: { mode: 'off' } }, { origin: 'http://evil.example' })
  eq('跨站 POST 也 403', crossPost.status, 403)

  const noOrigin = await jget('/status')
  eq('本机脚本（无 Origin）放行', noOrigin.status, 200)
}

/* ── 6. 坏 body 不该把服务搞崩 ─────────────────── */
console.log('\n【健壮性】')
{
  const res = await fetch(API + '/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: '这不是 JSON',
  })
  eq('非法 JSON body ⇒ 200（当成空 patch）', res.status, 200)
  const after = await jget('/status')
  eq('服务还活着', after.status, 200)
}

/* ── 收摊 ─────────────────────────────────────── */
server.close()
for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* 忽略 */ } }

console.log(`\n===== API 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail) { console.log('失败项：' + failures.join('、')); process.exitCode = 1 }
