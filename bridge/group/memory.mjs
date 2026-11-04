/**
 * bridge/group/memory.mjs —— 三层记忆，让几个会话之间"记得彼此"
 * ============================================================================
 * 主人的要求（2026-11-04）：
 *   「每个群聊和私聊各由一个 DSH 会话管理；会话之间记忆互通，
 *     用一个共享记忆文件记录各聊天大意并做好区分，作为共同记忆给所有会话」
 *
 * 三层：
 *   L1  会话历史      —— DSH 自己维护（+ 宿主的压缩插件），这里不碰
 *   L2  会话摘要      —— 每 30 条蒸馏一次，存 `<platform>/<chatKey>.md`
 *   L3  共享事实卡    —— 所有会话共用 `<platform>/shared.md`，带来源与时间
 *
 * 为什么按平台分目录：QQ 与 TG 是两套语境（TG 那边是替号主看号），
 * 混在一起会出现"你在群里说过"串到私聊。要串通时显式读对方的文件即可。
 *
 * 全部失败静默：记忆挂了不能影响回话。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || '/root/dsh'
const ROOT = process.env.QQ_MEMORY_DIR || join(DSH_HOME, 'qq-memory')
const GATEWAY = process.env.AGENT_GATEWAY || 'http://127.0.0.1:8327/v1/chat/completions'
const KEY = process.env.WORKBUDDY_GATEWAY_API_KEY || 'wb-gateway-local'
const DISTILL_EVERY = 30

const safeKey = (s) => String(s ?? '').replace(/[^0-9A-Za-z_+-]/g, '_').slice(0, 40)

function dirs(platform) {
  const base = join(ROOT, platform === 'tg' ? 'tg' : 'qq')
  const log = join(base, 'log')
  for (const d of [base, log]) if (!existsSync(d)) { try { mkdirSync(d, { recursive: true }) } catch { /* 只读环境 */ } }
  return { base, log }
}
const fileOf = (platform, chatKey) => join(dirs(platform).base, `${safeKey(chatKey)}.md`)
const logOf = (platform, chatKey) => join(dirs(platform).log, `${safeKey(chatKey)}.md`)
const sharedOf = (platform) => join(dirs(platform).base, 'shared.md')

const tail = (p, n) => {
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-n).join('\n')
  } catch { return '' }
}
const count = (p) => {
  try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}

const stamp = (d = new Date()) => {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 拼在用户消息前面的注入块。空记忆就返回空串（别塞一堆空标题） */
export function buildPrefix({ platform = 'qq', chatKey, personaText = '', who = '' }) {
  const parts = []
  const shared = tail(sharedOf(platform), 40)
  if (shared) parts.push(`[共享记忆｜所有聊天都看得到]\n${shared}`)
  const mine = tail(fileOf(platform, chatKey), 15)
  if (mine) parts.push(`[这个聊天之前聊过]\n${mine}`)
  if (personaText) parts.push(`[人设]\n${String(personaText).trim()}`)
  if (!parts.length) return ''
  return `${parts.join('\n\n')}\n\n`
}

/** 给模型看的一行消息 */
export function formatTurn({ who = '', text = '', at = new Date() }) {
  return `【${who || '群友'}】${String(text ?? '').replace(/\s+/g, ' ').trim()}`
}

/** 记一条。每 DISTILL_EVERY 条触发一次蒸馏（不 await，别拖慢回话） */
export function noteTurn({ platform = 'qq', chatKey, who = '', text = '', reply = '', policy = {} }) {
  try {
    const p = logOf(platform, chatKey)
    appendFileSync(p, `- [${stamp()}] ${who}: ${String(text).slice(0, 120)} → 小鲸鱼: ${String(reply).slice(0, 120)}\n`)
    harvestFacts({ platform, who, text, reply })
    if (count(p) % DISTILL_EVERY === 0) {
      void distill({ platform, chatKey, policy }).catch(() => {})
    }
  } catch { /* 记忆失败不影响回话 */ }
}

/**
 * L3：从这条消息里挑"值得所有会话都知道"的事实。
 * 用规则而不是模型 —— 每条消息都调一次模型太贵，而且规则漏掉的
 * 关键信息（承诺、日程、身份）本来就靠人话里的固定说法。
 */
const FACT_RE = /(我(?:下周|明天|后天|周末|今天)?(?:要|会|得|想|准备)|我(?:住|在|是|叫|今年|生日)|记住|别忘了|约好|答应|我(?:喜欢|讨厌|不吃|过敏))/
export function harvestFacts({ platform = 'qq', who = '', text = '', reply = '' }) {
  const t = String(text ?? '')
  if (!FACT_RE.test(t)) return null
  if (t.length > 160) return null
  const line = `- [${stamp()} · ${who || '?'}] ${t.replace(/\s+/g, ' ').slice(0, 120)}`
  try {
    const p = sharedOf(platform)
    const prev = count(p)
    appendFileSync(p, `${line}\n`)
    if (prev > 400) compactShared(p)     // 太多就折一半，别无限长
    return line
  } catch { return null }
}

function compactShared(p) {
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    const kept = lines.slice(-200)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, `${kept.join('\n')}\n`)
    renameSync(tmp, p)
  } catch { /* 折不了就算了 */ }
}

/** L2：把最近 30 条压成几行摘要，盖到本会话摘要文件上 */
export async function distill({ platform = 'qq', chatKey }) {
  const p = logOf(platform, chatKey)
  const raw = tail(p, DISTILL_EVERY)
  if (!raw) return ''
  const prev = tail(fileOf(platform, chatKey), 15)
  const prompt = [
    '把下面这段聊天记录压成不超过 6 行摘要，给"以后接着聊"用。',
    '只留：聊了什么话题、谁说过什么要紧的话、还没结束的事。',
    '不要评论、不要分点符号以外的格式、不要写"聊天记录"这种标题。',
    prev ? `\n【之前的摘要】\n${prev}` : '',
    `\n【新记录】\n${raw}`,
  ].join('')
  const r = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      reasoning_effort: 'low',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(25_000),
  }).then((x) => x.json()).catch(() => null)
  const text = String(r?.choices?.[0]?.message?.content ?? '').trim()
  if (!text) return ''
  try {
    const tmp = `${fileOf(platform, chatKey)}.tmp`
    writeFileSync(tmp, `${text}\n`)
    renameSync(tmp, fileOf(platform, chatKey))
  } catch { /* 写不进去就算了 */ }
  return text
}

/** 调 policy 里的开关：engine=agent 才走 agent，否则老路 */
export const agentEnabled = (policy) => String(policy?.engine ?? 'legacy') === 'agent'

export const _paths = { ROOT, fileOf, logOf, sharedOf }
