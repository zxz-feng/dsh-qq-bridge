#!/usr/bin/env node
/**
 * test/run.mjs —— 零 token 离线测试（不连 QQ、不连模型）
 * ============================================================================
 * 跑：`npm test`
 * 覆盖：配置钳位 / 决策器（什么时候闭嘴）/ CQ 码解析 / 路径映射 / 人设组装
 *
 * 决策器那几条是重点：群聊里最贵的错误不是"说错话"，是"该闭嘴时说话"
 * 和"被叫到却不吭声"。这些都是纯规则，所以能在没账号的机器上验。
 * ============================================================================
 */
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import 那些模块**之前**设好环境变量：它们 import 时就读
const HOME = mkdtempSync(join(tmpdir(), 'qqbridge-'))
process.env.STORE_DIR = join(HOME, 'store')
process.env.CONTEXTS_DIR = join(HOME, 'contexts')
process.env.MEDIA_DIR = join(HOME, 'media')
process.env.CQ_MEDIA = '/app/napcat/config/media'
process.env.GROUP_CFG = join(HOME, 'group-allowlist.json')
process.env.PERSONA_DIR = join(HOME, 'persona')

const { normalize, DEFAULTS, envFor, seedFiles, loadAllowlist, saveAllowlist, loadGroupCfg, saveGroupCfg } = await import('../bridge/config.mjs')
const { decide, inQuietHours } = await import('../bridge/group/decide.mjs')
const { parseCQ } = await import('../bridge/cq-parser.mjs')
const { toFileUrl, toContainerPath, HOST_MEDIA, CQ_MEDIA } = await import('../bridge/group/paths.mjs')
const { fullPersona, shortPersona, personaVersion, personaDir } = await import('../bridge/persona-core.mjs')
const groupPersona = await import('../bridge/group/persona.mjs')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`) }
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`)
}

// ── 1. 配置 ───────────────────────────────────────────
console.log('\n【配置】')
{
  const c = normalize({})
  eq('默认模式 auto', c.mode, 'auto')
  eq('默认 OneBot 端口 3001', c.onebot.url, 'ws://127.0.0.1:3001')
  eq('默认没有 napcat 二维码来源', c.napcat.qrUrl, '')

  const bad = normalize({ mode: '乱写', control: { port: 1 }, selfHeal: { everyMin: 999 }, llm: { models: [] } })
  eq('非法模式回落', bad.mode, 'auto')
  ok('端口钳到 >=1024', bad.control.port === 1024)
  ok('自检间隔上限 120', bad.selfHeal.everyMin === 120)
  ok('模型列表空了回落默认', bad.llm.models.length === DEFAULTS.llm.models.length)

  const made = seedFiles(HOME)
  ok('首次铺三份文件', made.length === 3, JSON.stringify(made))
  ok('allowlist 铺出来了', existsSync(join(HOME, 'allowlist.json')))

  const a = saveAllowlist(HOME, { self: '123456', friends: { '1807430990': { label: '主人', enabled: true } } })
  eq('白名单能写', Object.keys(a.friends), ['1807430990'])
  const g = saveGroupCfg(HOME, { groups: { '783599631': { label: '主群', dryRun: false } } })
  ok('群策略能写', g.groups['783599631'].label === '主群')

  const env = envFor(loadConfigByFile(), HOME)
  ok('env 里有 STORE_DIR', String(env.STORE_DIR).endsWith('store'))
  ok('env 里模型链是逗号串', env.QQ_MODELS.includes(','))
}
function loadConfigByFile() { return normalize({}) }

// ── 2. 决策器 ─────────────────────────────────────────
console.log('\n【决策器（零 token）】')
{
  const policy = { replyProb: 0.02, coldProb: 0.08, dailyActive: 3, dailyTotal: 100, cooldownSec: 60, quietHours: [2, 9], selfNick: ['小鲸鱼'], coldAfterMin: 30 }
  const noon = Math.floor(new Date('2026-10-28T14:00:00+08:00').getTime() / 1000)
  const night = Math.floor(new Date('2026-10-28T03:00:00+08:00').getTime() / 1000)

  const at = decide({ text: '@小鲸鱼 在吗', atMe: true, policy, now: noon })
  ok('被 @ 必回（哪怕概率 2%）', at.speak === true, JSON.stringify(at))
  ok('被 @ 算硬触发', at.hard === true)

  const named = decide({ text: '小鲸鱼你今天话好少', policy, now: noon })
  ok('叫名字也算硬触发', named.hard === true)
  ok('叫名字必回', named.speak === true)

  const quiet = decide({ text: '小鲸鱼在吗', atMe: true, policy, now: night })
  ok('静默时段被 @ 也不说话', quiet.speak === false, JSON.stringify(quiet))

  const plain = decide({ text: '哈哈哈哈', policy, now: noon, gapSec: 5 })
  ok('纯闲聊大概率不说', plain.speak === false)

  const cold = decide({ text: '哈哈哈哈', policy, now: noon, gapSec: 3600 })
  ok('冷场时更可能插一句（分数更高）', cold.score > plain.score, `${plain.score} → ${cold.score}`)

  ok('跨零点静默 [23,7] 认 1 点', inQuietHours(1, [23, 7]) === true)
  ok('跨零点静默 [23,7] 认 12 点', inQuietHours(12, [23, 7]) === false)
  ok('普通区间 [2,9] 认 5 点', inQuietHours(5, [2, 9]) === true)
  ok('start==end 视为不静默', inQuietHours(5, [5, 5]) === false)
}

// ── 3. CQ 码 ──────────────────────────────────────────
console.log('\n【CQ 码解析】')
{
  const t = parseCQ('你好啊')
  eq('纯文本', t.text, '你好啊')

  const withAt = parseCQ('[CQ:at,qq=340876685] 在吗')
  ok('解析出 at', Array.isArray(withAt.at) && withAt.at.includes('340876685'))

  const withImg = parseCQ('[CQ:image,file=abc.jpg,url=https://x/y.jpg]')
  ok('解析出图片', withImg.images.length === 1)

  const withFace = parseCQ('笑死[CQ:face,id=178]')
  ok('表情码被翻译或至少不炸', typeof withFace.text === 'string')
}

// ── 4. 路径映射 ───────────────────────────────────────
console.log('\n【路径映射】')
{
  const p = join(HOST_MEDIA, 'voice', 'a.mp3')
  eq('宿主机路径 → 容器路径', toContainerPath(p), `${CQ_MEDIA}/voice/a.mp3`)
  eq('CQ 码用 file:// + 容器路径', toFileUrl(p), `file://${CQ_MEDIA}/voice/a.mp3`)
  ok('媒体目录被建出来了', existsSync(HOST_MEDIA))
}

// ── 5. 人设 ───────────────────────────────────────────
console.log('\n【人设（QQ 群版）】')
{
  const dir = personaDir()
  ok('人设目录铺好了', existsSync(join(dir, 'renshe.txt')))
  const full = groupPersona.fullPersona()
  const short = groupPersona.shortPersona()
  ok('完整人设带 QQ 群差异（公开 AI 身份）', full.includes('AI') || full.includes('群'), full.slice(0, 60))
  ok('精简人设很短', short.length < 260, `实际 ${short.length}`)
  ok('精简比完整短很多', short.length * 2 < full.length)
  ok('人设指纹 12 位', personaVersion().length === 12)
  ok('锚定句带身份', groupPersona.ANCHOR.includes('小鲸鱼'))
}

// ── 汇总 ──────────────────────────────────────────────
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail) { console.log(`失败项：${failures.join('、')}`); process.exit(1) }
console.log('全部通过（零 token，没连网、没连 QQ）')
