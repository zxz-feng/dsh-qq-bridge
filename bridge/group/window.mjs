/**
 * bridge/group/window.mjs —— 「刚才群里聊了什么」的原文窗口
 * ============================================================================
 * 主人 2026-11-05 的原话：
 *   「为什么看不到上下文？不要省那点 token，我要的效果就是能正常聊天的小鲸鱼，
 *     不会犯蠢，不会之前说了什么马上就忘了」
 *
 * 之前的问题：组 prompt 时只有「人设 + 当前这一句」，`buildPrefix()` 实测返回
 * 12 个字符（记忆文件是空的）。她只记得自己说过什么，看不见别人说过什么 ——
 * 于是接不上话、乱接话。
 *
 * 这个模块只干一件事：把群里**每一条**消息按原样留下来（不管她说不说），
 * 组 prompt 时渲染成一段人话塞进去。
 *
 * 与 memory.mjs 的分工：
 *   window  → 最近几小时的**原文**（细）
 *   memory  → 跨天的**摘要**与硬事实卡（粗，但记得久）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || '/root/dsh'
const ROOT = process.env.QQ_WINDOW_DIR || join(DSH_HOME, 'qq-bridge', 'window')

/** 磁盘上最多留这么多条，再多就把最旧的折掉（不是丢记忆，是丢磁盘垃圾） */
const DISK_KEEP = 600

const safeKey = (s) => String(s ?? '').replace(/[^0-9A-Za-z_+-]/g, '_').slice(0, 40)

function ensureDir() {
  if (!existsSync(ROOT)) {
    try { mkdirSync(ROOT, { recursive: true }) } catch { /* 只读环境 */ }
  }
  return ROOT
}

const fileOf = (gid) => join(ensureDir(), `${safeKey(gid)}.jsonl`)

/** 读回来（坏行直接跳过，不让一条脏数据把整个窗口搞挂） */
export function load(gid) {
  const p = fileOf(gid)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object' && (o.text || o.img || o.kind)) out.push(o)
    } catch { /* 跳过坏行 */ }
  }
  return out
}

/**
 * 记一条。`router.mjs` 在**入站第一步**就调，不管最后说不说。
 * @param {object} o
 * @param {string|number} o.gid     群号（私聊用 p+QQ号）
 * @param {number} o.id             消息 id（渲染时要能排除当前这条）
 * @param {number} o.t              秒级时间戳
 * @param {string} o.uin            发言者 QQ
 * @param {string} o.name           发言者昵称/名片
 * @param {string} o.text           正文
 * @param {string[]} o.at           这条 @ 了谁（昵称或 QQ）
 * @param {object|null} o.quote     引用了谁：{name, text|desc}
 * @param {string} o.img            图片/表情包的描述
 * @param {boolean} o.self          是不是她自己发的
 */
export function push({ gid, id, t = Math.floor(Date.now() / 1000), uin = '', name = '', text = '', at = [], quote = null, img = '', self = false, kind = '' }) {
  const body = String(text ?? '').replace(/\r/g, '').trim()
  const rec = {
    id: id ? String(id) : '',
    t: Number(t) || Math.floor(Date.now() / 1000),
    uin: String(uin || ''),
    name: String(name || (self ? '小鲸鱼' : '')).slice(0, 24),
    text: body.slice(0, 600),
    at: (at || []).filter(Boolean).map((x) => String(x).slice(0, 20)).slice(0, 6),
    quote: quote && (quote.name || quote.text || quote.desc)
      ? { name: String(quote.name || '').slice(0, 24), text: String(quote.text || quote.desc || '').slice(0, 160) }
      : null,
    img: String(img || '').slice(0, 200),
    self: !!self,
    kind: String(kind || '').slice(0, 12),
  }
  if (!rec.text && !rec.img) return null   // 空消息（纯 @、纯表情）也记，但要有内容才记
  try {
    const p = fileOf(gid)
    appendFileSync(p, `${JSON.stringify(rec)}\n`)
    compactIfNeeded(p)
    return rec
  } catch { return null }
}

function compactIfNeeded(p) {
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= DISK_KEEP) return
    const kept = lines.slice(-Math.floor(DISK_KEEP * 0.7))
    const tmp = `${p}.tmp`
    writeFileSync(tmp, `${kept.join('\n')}\n`)
    renameSync(tmp, p)
  } catch { /* 折不了就算了 */ }
}

const two = (n) => String(n).padStart(2, '0')
const hhmmss = (sec) => {
  const d = new Date(Number(sec) * 1000)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * 渲染成给模型看的人话。
 * @param {object[]} list  load() 的结果
 * @param {object} o
 * @param {string} o.excludeId  当前这条不要重复出现
 * @param {number} o.maxMsgs    最多几条（默认 120）
 * @param {number} o.hours      只要最近几小时（默认 3）
 * @param {number} o.maxChars   字数上限（默认 6000），超了从最旧的丢
 * @param {string} o.selfName   她自己叫什么（默认「小鲸鱼」）
 */
export function render(list, { excludeId = '', maxMsgs = 120, hours = 3, maxChars = 6000, selfName = '小鲸鱼' } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const since = now - Math.max(1, Number(hours) || 3) * 3600
  let rows = (list || []).filter((x) => {
    if (excludeId && String(x.id) === String(excludeId)) return false
    if (Number(x.t) < since) return false
    return true
  })
  rows = rows.slice(-Math.max(1, Number(maxMsgs) || 120))

  const lines = []
  for (const x of rows) {
    const who = x.self ? selfName : (x.name || x.uin || '群友')
    const atPart = x.at?.length ? ` → @${x.at.join('、')}` : ''
    const q = x.quote ? `（引用 ${x.quote.name || '某人'}：${x.quote.text}）` : ''
    const body = x.text || ''
    const img = x.img ? `[${x.kind === 'sticker' ? '表情包' : '图片'}] ${x.img}` : ''
    const content = [body, img].filter(Boolean).join(' ')
    lines.push(`${hhmmss(x.t)} ${who}${atPart}${q}：${content}`)
  }

  // 从最旧的开始丢，直到不超过字数上限
  let text = lines.join('\n')
  let from = 0
  while (text.length > maxChars && from < lines.length - 1) {
    from += 1
    text = lines.slice(from).join('\n')
  }
  return text
}

/** 最近一条不是她自己说的（判断"上一个人是谁"用） */
export function lastOther(list, selfUin = '') {
  for (let i = (list || []).length - 1; i >= 0; i--) {
    const x = list[i]
    if (x.self) continue
    if (selfUin && String(x.uin) === String(selfUin)) continue
    return x
  }
  return null
}

export const _paths = { ROOT, fileOf }
