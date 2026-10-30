#!/usr/bin/env node
/**
 * test/private.mjs —— 私聊复用群聊链路（零 token、不连 QQ）
 * ============================================================================
 * 验的是三件最容易坏的事：
 *   ① 私聊的发送动作必须是 send_private_msg，**绝不能**出现 send_group_msg
 *      （伪 gid 是 `p<QQ>`，一旦漏了 shim，Number('p123') = NaN，消息直接丢）
 *   ② 私聊要能走到群聊那些命令（风格档、菜单），说明命令表接上了
 *   ③ 群管命令（禁言/撤回）在私聊里要给一句人话，而不是发一条失败的 API
 * ============================================================================
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'qqpriv-'))
process.env.STORE_DIR = join(HOME, 'store')
process.env.CONTEXTS_DIR = join(HOME, 'contexts')
process.env.MEDIA_DIR = join(HOME, 'media')
process.env.CQ_MEDIA = '/app/napcat/config/media'
process.env.PERSONA_DIR = join(HOME, 'persona')
process.env.GROUP_CFG = join(HOME, 'group-allowlist.json')
process.env.SELF_QQ = '340876685'
// 把网关指到一个必然连不上的端口：万一命令没命中、掉进生成，也只是快速失败，
// 不会真的烧 token（这条测试的卖点就是零 token）
process.env.DSH_GATEWAY = 'http://127.0.0.1:9/v1'
mkdirSync(process.env.MEDIA_DIR, { recursive: true })

const UID = 1807430990

function writeCfg({ privateEnabled = true } = {}) {
  writeFileSync(process.env.GROUP_CFG, JSON.stringify({
    groups: {},
    defaults: { dryRun: false, replyProb: 0.02, selfNick: ['小鲸鱼'] },
    private: {
      enabled: privateEnabled, dryRun: false, replyProb: 1, coldProb: 0,
      cooldownSec: 0, hardCooldownSec: 0, memberCooldownMin: 0, quietHours: [],
      ownerUins: [String(UID)],   // 命令是主人专属的，不给就等于没接命令表
    },
  }, null, 2))
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

writeCfg()
const router = await import('../bridge/group/router.mjs')

/** 假 OneBot：记下每一次调用 */
function recorder() {
  const calls = []
  const callApi = async (action, params = {}) => {
    calls.push({ action, params })
    return { status: 'ok', retcode: 0, data: { message_id: 1000 + calls.length } }
  }
  return { calls, callApi }
}

const evt = (text, extra = {}) => ({
  post_type: 'message', message_type: 'private',
  user_id: UID, self_id: 340876685, message_id: 777,
  message: text, raw_message: text,
  sender: { user_id: UID, nickname: '主人' },
  ...extra,
})

// ── ① 策略读取 ────────────────────────────────────────────
const pol = router.policyFor(`p${UID}`)
ok('policyFor(p<QQ>) 能取到私聊策略', Boolean(pol) && pol.replyProb === 1)
ok('私聊策略不吃群默认的 2% 概率', pol?.replyProb !== 0.02)
ok('群策略照旧（p 前缀不会误伤真群号）', router.policyFor('783599631') === null)

// ── ② 命令能走通，且只发私聊 ───────────────────────────────
{
  const { calls, callApi } = recorder()
  await router.handlePrivateMessage(evt('风格'), { callApi })
  const sends = calls.filter((c) => c.action === 'send_private_msg')
  const bad = calls.filter((c) => c.action === 'send_group_msg')
  ok('风格命令有回复', sends.length >= 1, `实际 ${sends.length} 条`)
  ok('没有一条发到群里', bad.length === 0, bad.map((b) => b.params.group_id).join(','))
  ok('user_id 就是私聊对象', String(sends[0]?.params?.user_id) === String(UID))
  const text = sends.map((c) => String(c.params?.message ?? '')).join(' | ')
  ok('回复里带风格清单', /孙吧/.test(text) && /傲娇/.test(text), text.slice(0, 80))
}

// ── ③ 群管命令给一句人话 ───────────────────────────────────
{
  const { calls, callApi } = recorder()
  await router.handlePrivateMessage(evt('禁言 60'), { callApi })
  const text = calls.filter((c) => c.action === 'send_private_msg').map((c) => c.params.message).join('|')
  ok('私聊禁言 → 说明而不是硬发', /没有禁言|群里/.test(text), text.slice(0, 60))
  ok('私聊禁言没有触发群管 API', !calls.some((c) => c.action === 'set_group_ban'))
}

// ── ④ 关掉开关就彻底不回 ───────────────────────────────────
{
  writeCfg({ privateEnabled: false })
  const { calls, callApi } = recorder()
  await router.handlePrivateMessage(evt('风格'), { callApi })
  ok('private.enabled=false 时一条都不发', calls.length === 0, `${calls.length} 条`)
  writeCfg()
}

// ── ⑤ 自己发的消息不回（防自激）────────────────────────────
{
  const { calls, callApi } = recorder()
  await router.handlePrivateMessage(evt('风格', { user_id: 340876685 }), { callApi })
  ok('自己发的私聊不回复', calls.length === 0)
}

console.log(`\n===== ${fail === 0 ? '✓ 私聊链路' : '✗ 私聊链路'} ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail === 0 ? 0 : 1)
