#!/usr/bin/env node
/**
 * scripts/style-corpus.mjs —— 从语料里挖「风格例句」（离线跑，零 token）
 * ============================================================================
 * 用法：
 *   node scripts/style-corpus.mjs 语料.txt --out /tmp/cand.txt
 *   node scripts/style-corpus.mjs 语料.xml --kind xml --out /tmp/cand.txt
 *
 * 干什么：把语料拆成一句一行 → 按长度/干净度/带梗度筛 → 去重 → 输出候选。
 * **候选不是成品**：得人再过一遍才放进 `persona/styles/<id>.md` 的「## 例句」。
 * 2026-10-29 实测：贴吧辩论语料 8.3 万条，自动挖出 517 条"带梗短句"，
 * 其中能用的不到两成（大量是"非常感谢您的建议"这种正经话）—— 所以一定要人工过。
 *
 * ⚠️ 政治内容一律不要（主人 2026-10-29 定的底线）：
 *   语料只用来学「语气」，不学「内容」。凡是沾政治、时政、立场、地域攻击、
 *   家人/疾病/身体侮辱的句子，**在脚本里就被丢掉**，不进候选，更不进人设。
 *   宁可少挖，也不让这些东西进上下文。
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const src = args.find((a) => !a.startsWith('--'))
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : d
}
if (!src) {
  console.error('用法：node scripts/style-corpus.mjs 语料.txt [--kind xml|txt|jsonl] [--out 文件] [--max 300]')
  process.exit(1)
}

const KIND = opt('kind', src.endsWith('.xml') ? 'xml' : src.endsWith('.jsonl') ? 'jsonl' : 'txt')
const OUT = opt('out', '')
const MAX = Number(opt('max', 300))

// ── 底线：政治 / 时政 / 攻击性内容，一句话都不留 ──────────────
const POLITICAL = /(党|中共|共产|政府|政权|体制|主席|书记|总书记|领导|人大|政协|两会|政治|时政|民主|自由|独裁|专政|选举|选票|游行|示威|抗议|镇压|警察|公安|军队|战争|打仗|侵略|领土|主权|统一|台独|港独|疆独|藏独|台湾|香港|新疆|西藏|美国|日本|俄国|乌克兰|以色列|巴勒斯坦|贸易战|关税|外汇|通胀|经济危机|房地产|房价|股市|养老金|医保|疫苗|核酸|疫情|封控|清零)/

// 骂到人身上的：家人、地域、疾病、身体、性别
const PERSONAL = /(妈|娘|爹|爸|爷|奶|祖宗|全家|死|尸|坟|棺材|残疾|瘸|瞎|聋|哑|智障|脑残|神经病|精神病|艾滋|癌|癌|地域|省人|河南|东北|上海|北京|沪|鳖|黑人|白皮|女拳|婊|贱|骚)/

const SLURS = /(nmsl|nm\$l|cnm|tmd|nmb|sb|煞笔|傻逼|操你|日你|草你)/i

const MARKERS = [
  '就这', '急了', '破防', '笑死', '逆天', '抽象', '小丑', '差不多得了', '你哪位', '配吗',
  '搁这', '建议', '离谱', '纯纯', '确实', '啊这', '绷不住', '牛马', '细说', '典', '乐',
  '麻了', '爬', '闭嘴', '装', '秀', '谁问你了', '你开心就好', '你说的都对', '第一次见',
  '这也能', '不愧是你', '难绷', '别急', '行吧', '随便你',
]

const JUNK = /(http|www\.|@|【|】|\[|\]|QQ|微信|私信|加群|链接|下载|资源|回复|楼主|层主|沙发|置顶|广告|\d{4,})/i

function splitUtterances(raw) {
  if (KIND === 'xml') {
    // 贴吧/对话类语料常见形态：<utt ...>正文</utt>；没有就退化成按行切
    const m = raw.match(/<utt[^>]*>([\s\S]*?)<\/utt>/g)
    if (m?.length) return m.map((s) => s.replace(/<[^>]+>/g, ''))
  }
  if (KIND === 'jsonl') {
    const out = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const j = JSON.parse(t)
        const v = j.text ?? j.content ?? j.utt ?? j.sentence ?? ''
        if (typeof v === 'string') out.push(v)
      } catch { /* 坏行跳过 */ }
    }
    return out
  }
  return raw.split(/\n+/)
}

const raw = readFileSync(src, 'utf8')
const all = splitUtterances(raw)
const seen = new Set()
const kept = []
const stat = { total: all.length, len: 0, political: 0, personal: 0, junk: 0, nomark: 0, dup: 0 }

for (const s of all) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  if (t.length < 3 || t.length > 18) { stat.len += 1; continue }
  if (POLITICAL.test(t)) { stat.political += 1; continue }
  if (PERSONAL.test(t) || SLURS.test(t)) { stat.personal += 1; continue }
  if (JUNK.test(t)) { stat.junk += 1; continue }
  if (!MARKERS.some((m) => t.includes(m))) { stat.nomark += 1; continue }
  if (seen.has(t)) { stat.dup += 1; continue }
  seen.add(t)
  kept.push(t)
  if (kept.length >= MAX) break
}

const report = [
  `读入 ${stat.total} 条`,
  `丢掉：长度不合 ${stat.len} / 政治 ${stat.political} / 人身攻击 ${stat.personal} / 垃圾 ${stat.junk} / 无梗 ${stat.nomark} / 重复 ${stat.dup}`,
  `留下 ${kept.length} 条候选`,
  '',
  ...kept.map((t) => `- ${t}`),
].join('\n')

if (OUT) {
  writeFileSync(OUT, `${report}\n`)
  console.log(`已写 ${OUT}（${kept.length} 条）`)
  console.log(report.split('\n').slice(0, 3).join('\n'))
} else {
  console.log(report)
}
