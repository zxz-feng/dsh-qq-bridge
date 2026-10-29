#!/usr/bin/env node
/**
 * 手动切群聊风格档（不用等 QQ 里发命令）
 *
 *   node scripts/style.mjs --list                     有哪些档
 *   node scripts/style.mjs <群号>                     看当前档
 *   node scripts/style.mjs <群号> <档> [mid|heavy]    切档（认 id 也认别名：傲娇 / 孙吧模式 / 高冷）
 *   node scripts/style.mjs <群号> normal              回正常
 *
 * 立即生效：bridge 每条消息都现读 style.json 和档位文件（不用重启）。
 * 家目录：BRIDGE_HOME 优先，否则 <DSH_HOME>/qq-bridge；人设目录：PERSONA_DIR 优先，否则 <DSH_HOME>/persona。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

// ⚠️ 必须在 import store 之前把 STORE_DIR 定下来：store.mjs 是 import 时读环境的
//
// 家目录要猜准：桥可能跑在 <DSH_HOME>/qq-bridge，也可能跑在 ~/.dsh/qq-bridge
// （服务器上 DSH_HOME=/root/dsh，而你的 shell 里可能没这个变量）。
// 猜错的后果很隐蔽：改了另一个 store，群里毫无反应。所以按「真的存在 config.json」挑。
function pickHome() {
  if (process.env.BRIDGE_HOME) return process.env.BRIDGE_HOME
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const cands = [join(dshHome, 'qq-bridge'), join(homedir(), '.dsh', 'qq-bridge')]
  for (const c of cands) if (existsSync(join(c, 'config.json'))) return c
  return cands[0]
}
const HOME = pickHome()
process.env.STORE_DIR = process.env.STORE_DIR || join(HOME, 'store')
process.env.PERSONA_DIR = process.env.PERSONA_DIR
  || join(process.env.DSH_HOME || join(HOME, '..'), 'persona')
  || join(HOME, '..', 'persona')

const { getStyle, setStyle, listStyles, getStyleDef } = await import('../bridge/group/style.mjs')

const args = process.argv.slice(2)
if (process.env.STYLE_DEBUG) console.log(`[家目录] ${HOME}`)

if (!args.length || args[0] === '--list' || args[0] === '-l') {
  const all = listStyles()
  console.log('可用的说话风格档：')
  for (const s of all) {
    console.log(`  ${s.id.padEnd(10)} ${s.name}${s.aliases.length > 1 ? `（也叫：${s.aliases.join('、')}）` : ''}`)
    if (s.short) console.log(`             ${s.short}`)
  }
  console.log('\n用法：node scripts/style.mjs <群号> <档> [mid|heavy]')
  process.exit(0)
}

const [gid, style, intensity = 'mid'] = args

if (!style) {
  const cur = getStyle(gid)
  const def = getStyleDef(cur.style)
  console.log(`群 ${gid}：${def?.name ?? cur.style}（${cur.style}）`
    + `，强度 ${cur.intensity}${cur.by ? `，${cur.by} 切的` : ''}`
    + `${cur.since ? `，${new Date(cur.since).toLocaleString('zh-CN')}` : ''}`)
  process.exit(0)
}

const s = setStyle(gid, style, { by: 'cli', intensity })
if (!s) {
  console.error(`没有这个风格：${style}`)
  console.error('可选：' + listStyles().map((x) => `${x.id}(${x.name})`).join(' / '))
  process.exit(1)
}
const def = getStyleDef(s.style)
console.log(`群 ${gid} → ${def?.name ?? s.style}（${s.style}，强度 ${s.intensity}）`)
if (def?.short) console.log(`它现在是：${def.short}`)
