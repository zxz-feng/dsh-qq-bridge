/**
 * 群聊「说话风格」档位 —— 注册表版（2026-10-29 重做）
 * ============================================================================
 * 为什么要重做：原来只有 normal / sunbar 两个写死的分支，加一档就要改三处代码。
 * 现在是**目录即注册表**：`persona/styles/*.md` 放一个文件就多一个档，
 * 主人说一句 `#风格 傲娇` 就切，改文件不用重启、不用改代码。
 *
 * 一个档 = 一个 md 文件：
 *
 *   # 孙吧                       ← 显示名（第一行的 # 后面）
 *   ---
 *   id: sunbar                  ← 唯一 id（也是文件名，缺了就用文件名）
 *   name: 孙吧
 *   aliases: 孙吧, 嘴臭, 抽象     ← 主人可能怎么叫它
 *   short: 一行压缩版             ← 每轮都发，务必短（<60 字）
 *   persona: 顶掉默认人设的那句    ← 可选，省得跟"温柔"打架
 *   bias: replyProbMul=4,cooldownSec=20
 *   ---
 *   ## 语气
 *   （完整说明，只在完整人设那轮发）
 *   ## 例句
 *   - 就这?
 *   ## 词表
 *   - 急了
 *
 * 省 token 的三层：
 *   1. 每轮只发 `short`（~60 字）
 *   2. 完整说明 + 例句 + 词表，只在「完整人设」那轮（每 8 轮）发一次
 *   3. 例句/词表按天轮换 8 / 6 条，不整锅倒进去
 *
 * 状态存在 `group/store/groups/<群号>/style.json`：{ style, intensity, by, since }
 * ============================================================================
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson, STORE } from './store.mjs'
import { personaDir } from '../persona-core.mjs'

const FILE = (gid) => `${STORE}/groups/${gid}/style.json`

const DEFAULT_BIAS = {
  replyProbMul: 1,
  coldProbMul: 1,
  cooldownSec: 60,
  memberCooldownMin: 5,
  spamThreshold: 8,
  spamSeconds: 600,
}

const cache = new Map() // id -> { mtime, style }

/** 风格目录（跟着人设目录走，插件自带的会先被铺到 PERSONA_DIR） */
export function stylesDir() { return join(personaDir(), 'styles') }

/**
 * 解析一个风格文件
 * @returns {{id,name,aliases:string[],short,persona,guide,examples:string[],words:string[],bias:object}|null}
 */
export function parseStyle(raw, fallbackId = '') {
  const text = String(raw ?? '').replace(/\r\n/g, '\n')
  const nameM = text.match(/^\s*#\s+(.+)$/m)
  const name = nameM ? nameM[1].trim() : fallbackId

  const fmM = text.match(/^---\n([\s\S]*?)\n---\n?/m)
  const fm = {}
  if (fmM) {
    for (const line of fmM[1].split('\n')) {
      const m = line.match(/^([a-zA-Z_]+)\s*[:：]\s*(.*)$/)
      if (m) fm[m[1]] = m[2].trim()
    }
  }

  const body = fmM ? text.slice((fmM.index ?? 0) + fmM[0].length) : text.replace(/^\s*#\s+.+$/m, '')

  // 按 ## 小节切：第一个小节之前的算总述
  const sections = {}
  let cur = '_'
  const buf = { _: [] }
  for (const line of body.split('\n')) {
    const h = line.match(/^##\s+(.+)$/)
    if (h) { cur = h[1].trim(); buf[cur] = []; continue }
    ;(buf[cur] ??= []).push(line)
  }
  for (const [k, v] of Object.entries(buf)) sections[k] = v.join('\n').trim()

  const guide = [sections._ ?? '']
  for (const [k, v] of Object.entries(sections)) {
    if (k === '_' || k === '例句' || k === '词表' || !v) continue
    guide.push(`## ${k}\n${v}`)
  }

  const bullets = (s) => String(s ?? '').split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-·*]\s+/.test(l))
    .map((l) => l.replace(/^[-·*]\s+/, '').trim())
    .filter(Boolean)

  const bias = { ...DEFAULT_BIAS }
  for (const pair of String(fm.bias ?? '').split(',')) {
    const m = pair.match(/^\s*([a-zA-Z]+)\s*=\s*(-?[\d.]+)\s*$/)
    if (m) bias[m[1]] = Number(m[2])
  }

  const aliases = String(fm.aliases ?? '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)

  return {
    id: (fm.id || fallbackId || name).toLowerCase(),
    name: fm.name || name,
    aliases: aliases.length ? aliases : [name],
    short: fm.short ?? '',
    persona: fm.persona ?? '',
    guide: guide.join('\n\n').trim(),
    examples: bullets(sections['例句']),
    words: bullets(sections['词表']),
    bias,
  }
}

/** 读一个档（按 mtime 缓存，改文件立刻生效） */
function loadStyleFile(id) {
  const dir = stylesDir()
  const path = join(dir, `${id}.md`)
  if (!existsSync(path)) return null
  let st
  try { st = statSync(path) } catch { return null }
  const hit = cache.get(id)
  if (hit && hit.mtime === st.mtimeMs) return hit.style
  let raw
  try { raw = readFileSync(path, 'utf8') } catch { return null }
  const style = parseStyle(raw, id)
  cache.set(id, { mtime: st.mtimeMs, style })
  return style
}

/** 所有可用的档（normal 排第一） */
export function listStyles() {
  const dir = stylesDir()
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { /* 目录还没铺 */ }
  const out = []
  for (const f of files) {
    const s = loadStyleFile(f.replace(/\.md$/, ''))
    if (s) out.push(s)
  }
  out.sort((a, b) => (a.id === 'normal' ? -1 : b.id === 'normal' ? 1 : a.id.localeCompare(b.id)))
  return out
}

/** id / 名字 / 别名 → id；认不出返回 null */
export function resolveStyle(input) {
  const q = String(input ?? '').trim().toLowerCase()
  if (!q) return null
  const all = listStyles()
  for (const s of all) if (s.id === q) return s.id
  for (const s of all) if (s.name.toLowerCase() === q) return s.id
  for (const s of all) if (s.aliases.some((a) => a.toLowerCase() === q)) return s.id
  // 最后才做包含匹配（"孙吧模式" → 孙吧），但要求至少两个字，避免"正"命中一切
  if (q.length >= 2) {
    for (const s of all) {
      if (s.aliases.some((a) => q.includes(a.toLowerCase())) || q.includes(s.name.toLowerCase())) return s.id
    }
  }
  return null
}

export function getStyleDef(id) { return loadStyleFile(id) ?? loadStyleFile('normal') }

/** 当前档位 */
export function getStyle(gid) {
  const j = readJson(FILE(gid), null) ?? {}
  const id = j.style && existsSync(join(stylesDir(), `${j.style}.md`)) ? j.style : 'normal'
  return {
    style: id,
    intensity: j.intensity === 'heavy' ? 'heavy' : 'mid',
    by: j.by ?? '',
    since: Number(j.since ?? 0),
  }
}

/**
 * 切档
 * @returns {object|null} 新状态；认不出这个风格返回 null
 */
export function setStyle(gid, style, { by = '', intensity = 'mid' } = {}) {
  const id = resolveStyle(style)
  if (!id) return null
  const next = { style: id, intensity: intensity === 'heavy' ? 'heavy' : 'mid', by: String(by ?? ''), since: Date.now() }
  const dir = `${STORE}/groups/${gid}`
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeJson(FILE(gid), next)
  return getStyle(gid)
}

/** 按天轮换取 n 条（同一天内稳定，明天换一批） */
function rotate(list, n, salt = '') {
  if (!list?.length) return []
  const day = Math.floor(Date.now() / 86400000)
  const off = (day + salt.length) % list.length
  return Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(off + i) % list.length])
}

/**
 * 塞进系统提示的风格块
 * @param {string} gid
 * @param {{full?:boolean}} o full=完整说明（跟着完整人设那轮），否则一行压缩版
 * @returns {string} 空串 = normal 档，不注入
 */
export function styleBlock(gid, { full = false } = {}) {
  const s = getStyle(gid)
  if (s.style === 'normal') return ''
  const def = getStyleDef(s.style)
  if (!def) return ''
  const heavy = s.intensity === 'heavy'
  const tag = `【风格·${def.name}${heavy ? '·重' : ''}】`

  if (!full) {
    return [tag, def.short || `用「${def.name}」的方式说话。`].join('\n')
      + (heavy ? '\n· 强度重：更冲、更短，别留余地。' : '')
  }

  const parts = [tag, def.guide]
  if (def.examples.length) {
    parts.push('【例句（学语感，别照抄、别连发）】\n' + rotate(def.examples, 8, gid).map((e) => `- ${e}`).join('\n'))
  }
  if (def.words.length) {
    parts.push('【这批可以顺手用的词（挑一两个，别堆）】' + rotate(def.words, 6, gid).join('、'))
  }
  if (heavy) parts.push('【强度：重】可以更冲，脏字一句最多两个，被骂必加倍还嘴。')
  return parts.filter(Boolean).join('\n\n')
}

/** 这个档的精简人设（顶掉默认那句"温柔、不阴阳"）；normal 返回空串 */
export function styleShortPersona(gid) {
  const s = getStyle(gid)
  if (s.style === 'normal') return ''
  const def = getStyleDef(s.style)
  if (!def) return ''
  if (def.persona) return def.persona
  return `你是群里的小鲸鱼，现在用「${def.name}」的说话方式：${def.short || def.guide.split('\n')[0] || ''}。直接输出正文。`
}

/**
 * 决策偏置：交给自己乘进 replyProb / coldProb，并放宽对骂时的冷却
 * @returns {{replyProbMul:number,coldProbMul:number,spamThreshold:number,spamSeconds:number,policy:object}}
 */
export function styleBias(gid) {
  const s = getStyle(gid)
  const def = getStyleDef(s.style)
  const b = def?.bias ?? DEFAULT_BIAS
  const heavy = s.intensity === 'heavy' && s.style !== 'normal'
  return {
    replyProbMul: Number(b.replyProbMul ?? 1) * (heavy ? 2 : 1),
    coldProbMul: Number(b.coldProbMul ?? 1) * (heavy ? 1.5 : 1),
    spamThreshold: Number(b.spamThreshold ?? 8),
    spamSeconds: Number(b.spamSeconds ?? 600),
    policy: {
      cooldownSec: heavy ? Math.max(5, Math.round(Number(b.cooldownSec ?? 60) / 2)) : Number(b.cooldownSec ?? 60),
      memberCooldownMin: heavy ? Math.max(0.1, Number(b.memberCooldownMin ?? 5) / 2) : Number(b.memberCooldownMin ?? 5),
    },
  }
}

/** 给命令层用的「id → 显示名」表 */
export function styleNames() {
  const out = {}
  for (const s of listStyles()) out[s.id] = s.name
  return out
}
