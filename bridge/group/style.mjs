/**
 * 群聊「说话风格」档位（孙吧模式等）
 * ============================================================================
 * 为什么不并进 group-allowlist.json：
 *   那是"这个群怎么运营"的长期配置；风格是**随口就能开关的东西**，
 *   主人一句话就该切，不该去改 20 个字段的大文件。所以单独一个小组文件：
 *     group/store/groups/<群号>/style.json   { style, intensity, by, since }
 *
 * 现在的档：
 *   normal  正常（默认，人设里那套温柔短句）
 *   sunbar  孙吧模式：损、毒、快、反问收尾、不解释（详见 style-sunbar.txt）
 *
 * 分层发送（省 token）：
 *   完整风格说明只在"完整人设"那几轮发；平时只发一行压缩版提醒。
 *   孙吧模式一整轮也就多 90 字，不会把上下文撑爆。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson, STORE } from './store.mjs'

const DIR = fileURLToPath(new URL('.', import.meta.url))
const FILE = (gid) => `${STORE}/groups/${gid}/style.json`

export const STYLE_NAMES = { normal: '正常', sunbar: '孙吧模式' }

export const STYLE_ALIASES = {
  孙吧: 'sunbar', 孙笑川: 'sunbar', 嘴臭: 'sunbar', 嘴毒: 'sunbar', 抽象: 'sunbar',
  正常: 'normal', 营业: 'normal', 温柔: 'normal',
}

/** 当前档位 */
export function getStyle(gid) {
  const j = readJson(FILE(gid), null) ?? {}
  return {
    style: j.style === 'sunbar' ? 'sunbar' : 'normal',
    intensity: j.intensity === 'heavy' ? 'heavy' : 'mid',
    by: j.by ?? '',
    since: Number(j.since ?? 0),
  }
}

/** 切档（by = 谁切的，留痕） */
export function setStyle(gid, style, { by = '', intensity = 'mid' } = {}) {
  const s = STYLE_ALIASES[style] ?? style
  const next = { style: s === 'sunbar' ? 'sunbar' : 'normal', intensity, by: String(by ?? ''), since: Date.now() }
  // 群目录可能还不存在（这个群一句话都没说过）—— 不建目录会 ENOENT（2026-10-29 踩到）
  const dir = `${STORE}/groups/${gid}`
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeJson(FILE(gid), next)
  return getStyle(gid)
}

let cachedGuide = ''
function guide() {
  if (cachedGuide) return cachedGuide
  try { cachedGuide = readFileSync(`${DIR}style-sunbar.txt`, 'utf8').trim() } catch { cachedGuide = '' }
  return cachedGuide
}

/**
 * 塞进系统提示的风格块
 * @param {string} gid
 * @param {{full?:boolean}} o full=完整说明（跟着完整人设那轮），否则一行压缩版
 * @returns {string} 空串 = 正常档，不注入
 */
export function styleBlock(gid, { full = false } = {}) {
  const s = getStyle(gid)
  if (s.style !== 'sunbar') return ''
  if (!full) {
    return [
      '【孙吧模式·开】',
      '· 口气：孙吧老哥。短、损、快，3~15 字，最多两条（||| 分）。',
      '· 关键：**别替自己辩解**（"我怎么怎么了"是顶嘴，不是孙吧）——直接换战场攻击对方：',
      '  「你先管好自己」「大半夜教我做人?」「你这话说得挺有勇气」。',
      '· 武器：反问（就这?／你急什么？）、降维（说话过下脑子）、扣帽子（经典／原来是这号人）、',
      '  词库（急了／破防／笑死／逆天／抽象／小丑／典／差不多得了／你哪位／配吗／搁这／建议）。',
      '· 脏字一句最多一个，像随口带的；不堆。被骂立刻加倍还嘴，不解释不道歉。',
      '· 不碰：地域/家人/学校/职业/外貌/疾病。',
    ].join('\n')
  }
  const heavy = s.intensity === 'heavy'
  return (guide() || '【孙吧模式】用孙吧老哥的口气：短、损、反问收尾、不解释。')
    + (heavy ? '\n\n【强度：重】可以更冲，脏字一句最多两个，敢直接怼回去，被骂必加倍还嘴。' : '')
}

/** 孙吧模式的精简人设（顶掉默认那句"温柔、不阴阳"——那句在这个档里是反作用） */
export function styleShortPersona() {
  return '你是群里的小鲸鱼，现在开着孙吧模式：说话像个孙吧老哥，短句、损、反问收尾、'
    + '不解释不道歉不哄人；被怼就加倍怼回去，被夸一句带过。默认 3~15 字，最多两条（用 ||| 分）。直接输出正文。'
}

/**
 * 决策偏置：开了孙吧模式就更爱接话（但还是受冷却/额度/深夜限制）
 * 返回缩放系数，交给 router 乘进 replyProb / coldProb
 */
export function styleBias(gid) {
  const s = getStyle(gid)
  if (s.style !== 'sunbar') {
    return { replyProbMul: 1, coldProbMul: 1, spamThreshold: 8, spamSeconds: 600, policy: {} }
  }
  const heavy = s.intensity === 'heavy'
  return {
    replyProbMul: heavy ? 10 : 4,
    coldProbMul: heavy ? 3 : 2,
    // 对骂节奏：刷屏阈值放宽、静默缩短；冷却从 60s/5min 降到 20s/30s
    spamThreshold: heavy ? 30 : 20,
    spamSeconds: heavy ? 90 : 120,
    policy: {
      cooldownSec: heavy ? 10 : 20,
      memberCooldownMin: heavy ? 0.25 : 0.5,
      dailyActive: Math.max(Number(getStyle(gid).dailyActive ?? 8), 8),
    },
  }
}
