#!/usr/bin/env node
/**
 * 手动切群聊风格档（不用等 QQ 里发命令）
 *
 *   node scripts/style.mjs <群号>                     看当前档
 *   node scripts/style.mjs <群号> sunbar [mid|heavy]  开孙吧模式
 *   node scripts/style.mjs <群号> normal              关掉
 *
 * 立即生效：bridge 每条消息都现读 style.json（不用重启）。
 * 家目录：BRIDGE_HOME 优先，否则 <DSH_HOME>/qq-bridge。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

// ⚠️ 必须在 import store 之前把 STORE_DIR 定下来：store.mjs 是 import 时读环境的
const HOME = process.env.BRIDGE_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge')
process.env.STORE_DIR = process.env.STORE_DIR || join(HOME, 'store')

const { getStyle, setStyle, STYLE_NAMES } = await import('../bridge/group/style.mjs')

const [gid, style, intensity = 'mid'] = process.argv.slice(2)
if (!gid) {
  console.error('用法：node scripts/style.mjs <群号> [sunbar|normal] [mid|heavy]')
  process.exit(1)
}
if (!style) {
  const cur = getStyle(gid)
  console.log(`群 ${gid}：${STYLE_NAMES[cur.style] ?? cur.style}`
    + `（强度 ${cur.intensity}${cur.by ? `，${cur.by} 切的` : ''}`
    + `${cur.since ? `，${new Date(cur.since).toLocaleString('zh-CN')}` : ''}）`)
  process.exit(0)
}
const s = setStyle(gid, style, { by: 'cli', intensity })
console.log(`群 ${gid} → ${STYLE_NAMES[s.style]}（强度 ${s.intensity}）`)
