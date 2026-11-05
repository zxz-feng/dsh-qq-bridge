#!/usr/bin/env node
/**
 * tools/replay-day.mjs —— 拿今天的群聊记录回放，看每轮 prompt 到底带了多少上下文
 * ============================================================================
 * 用途（主人 2026-11-05 验收要求之一）：
 *   改之前 buildPrefix() 返回 12 个字符，她只看得见"当前这一句"；
 *   改之后每轮应该能看到前面十几条别人说的话。
 *
 * 这个脚本**不连 QQ、不调模型、不写真实记忆**（全在临时目录里跑）：
 *   1. 从 bridge.log 里抠出今天的入站（`[group] 名字: 文本`）和她发过的（`[group] 已发: 文本`）
 *   2. 按顺序灌进临时窗口
 *   3. 对每条入站算一遍 prompt：硬事实 + 摘要 + 刚才群里 + 当前这句
 *   4. 打印长度、能不能看见前面几条
 *
 * 用法：
 *   node tools/replay-day.mjs                      # 默认读 /root/dsh/qq-bridge/bridge.log
 *   node tools/replay-day.mjs --log /path/to.log --gid 783599631 --tail 60
 * ============================================================================
 */
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (k, d = '') => {
  const i = process.argv.indexOf(`--${k}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d
}

const LOG = arg('log', '/root/dsh/qq-bridge/bridge.log')
const GID = arg('gid', '783599631')
const TAIL = Number(arg('tail', 80)) || 80

if (!existsSync(LOG)) {
  console.error(`日志不存在：${LOG}`)
  process.exit(1)
}

// 临时记忆目录：绝不污染真实数据
const HOME = mkdtempSync(join(tmpdir(), 'qqreplay-'))
process.env.DSH_HOME = HOME
process.env.QQ_WINDOW_DIR = join(HOME, 'win')
process.env.QQ_MEMORY_DIR = join(HOME, 'mem')
mkdirSync(join(HOME, 'mem', 'qq', 'log'), { recursive: true })
writeFileSync(join(HOME, 'mem', 'qq', 'shared.md'), '- [11-05 · maybe.7] 他明天要考驾照\n')
writeFileSync(join(HOME, 'mem', 'qq', `${GID}.md`), '- 今天在聊坤鱼梗，猎鹰被点名\n')

const win = await import('../bridge/group/window.mjs')
const memory = await import('../bridge/group/memory.mjs')

// ── 抠日志 ────────────────────────────────────────────────
const IN = /^\s*\[group\]\s+([^:：]{1,24})[:：]\s*(.+)$/
const OUT = /^\s*\[group\]\s+已发[:：]\s*(.+)$/
const SKIP = /^(补回|发送失败|语音|表情包|图已发|dry-run|跳过|静默|不说|决策)/

const rows = []
for (const line of readFileSync(LOG, 'utf8').split('\n')) {
  const o = line.match(OUT)
  if (o) { rows.push({ self: true, name: '小鲸鱼', text: o[1].trim() }); continue }
  const m = line.match(IN)
  if (!m) continue
  const name = m[1].trim()
  const text = m[2].trim()
  if (SKIP.test(name) || SKIP.test(text)) continue
  rows.push({ self: false, name, text })
}

const use = rows.slice(-TAIL)
if (!use.length) {
  console.log('日志里没抠到群消息（可能刚重启过、或者格式变了）')
  process.exit(0)
}

// ── 灌进窗口 ──────────────────────────────────────────────
const base = Math.floor(Date.now() / 1000) - use.length * 30
use.forEach((r, i) => {
  win.push({
    gid: GID,
    id: i + 1,
    t: base + i * 30,
    uin: r.self ? '340876685' : String(100000 + i),
    name: r.name,
    text: r.text,
    self: r.self,
  })
})

// ── 逐条算 prompt ─────────────────────────────────────────
const list = win.load(GID)
const prefix = memory.buildPrefix({ platform: 'qq', chatKey: GID, personaText: '（人设略）', who: 'maybe.7' })

let n = 0
let sum = 0
let max = 0
let withCtx = 0
console.log(`\n回放 ${use.length} 条（${GID}）—— 每条入站组出来的 prompt：\n`)
for (let i = 0; i < use.length; i += 1) {
  const r = use[i]
  if (r.self) continue
  const block = win.render(list.slice(0, i), { excludeId: i + 1, hours: 3, maxMsgs: 120, maxChars: 6000 })
  const prompt = `${prefix}[刚才群里]\n${block}\n\n${memory.formatTurn({ who: r.name, text: r.text })}\n`
  const seen = block ? block.split('\n').length : 0
  n += 1
  sum += prompt.length
  max = Math.max(max, prompt.length)
  if (seen >= 3) withCtx += 1
  if (n <= 8 || n % 10 === 0) {
    console.log(`  ${String(n).padStart(2)}. ${r.name}：${r.text.slice(0, 24)}`)
    console.log(`      prompt ${String(prompt.length).padStart(5)} 字 · 看得见前面 ${seen} 条`)
  }
}

console.log(`\n合计 ${n} 条入站：平均 ${Math.round(sum / Math.max(1, n))} 字，最大 ${max} 字`)
console.log(`其中 ${withCtx} 条能看到 3 条以上上下文（${Math.round((withCtx / Math.max(1, n)) * 100)}%）`)
console.log(`对照：改之前每轮只有「人设 + 当前这一句」，约 ${12 + 30} 字，看得见 0 条。`)
