// 多源查资料：一次查询同时问四个地方，谁有结果用谁的。
//
// 为什么不是单源（2026-10-29 用户点名）：
//   「完整信息肯定是百科类的搜索更好，不能不用百科搜一遍」
//   而且不同源擅长的不一样——萌娘懂 ACG，维基懂通识，贴吧懂「网友怎么说」，
//   DDG 兜底长尾。只问一个地方，答出来就是偏的。
//
// 约束：并行跑、总预算 14 秒、每个源自己兜自己的错；合并后总长 ≤ 1800 字，
// 免得一次工具回合把上下文吃光。

import { fetchPage, htmlToText } from './webpage.mjs'
import { searchPosts } from './tieba.mjs'

const UA = 'Lynx/2.8.9rel.1 libwww-FM/2.14'
const PER_SOURCE_MS = 12000
const MAX_TOTAL = 1800

function proxyUrl() { return String(process.env.WEB_PROXY || '').trim() }

async function curlJson(url, { timeoutMs = PER_SOURCE_MS } = {}) {
  const sec = Math.max(3, Math.ceil(timeoutMs / 1000))
  const args = ['-sS', '-L', '--max-time', String(sec), '-A', UA, '-H', 'Accept-Language: zh-CN,zh;q=0.9']
  const px = proxyUrl()
  if (px) args.push('-x', px)
  args.push(url)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)('curl', args, { maxBuffer: 4 * 1024 * 1024, timeout: (sec + 3) * 1000 })
  return JSON.parse(String(stdout))
}

/** 维基百科：先搜标题，再取摘要 */
async function wikipedia(q) {
  const api = 'https://zh.wikipedia.org/w/api.php'
  const j = await curlJson(`${api}?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=1`)
  const hit = j?.query?.search?.[0]
  if (!hit) return { ok: false, reason: '维基没有条目' }
  const title = hit.title
  const s = await curlJson(`https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
  const text = String(s?.extract || '').replace(/\s+/g, ' ').trim()
  if (!text) return { ok: false, reason: '维基条目没有摘要' }
  return { ok: true, source: '维基百科', title, text: text.slice(0, 420) }
}

/** DuckDuckGo html：长尾兜底 */
async function ddg(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const args = ['-sS', '-L', '--max-time', '12', '-A', UA]
  const px = proxyUrl()
  if (px) args.push('-x', px)
  args.push(url)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)('curl', args, { maxBuffer: 4 * 1024 * 1024, timeout: 16000 })
  const html = String(stdout)
  const out = []
  const parts = html.split('class="result__title"').slice(1, 5)
  for (const p of parts) {
    const t = (p.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || ''
    const u = (p.match(/uddg=([^&"]+)/) || [])[1] || ''
    const sn = (p.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || ''
    const title = htmlToText(t).replace(/\s+/g, ' ').trim()
    if (!title) continue
    let host = ''
    try { host = decodeURIComponent(u).replace(/^https?:\/\//, '').split('/')[0] } catch { /* 忽略 */ }
    out.push({ title: title.slice(0, 60), host, snippet: htmlToText(sn).replace(/\s+/g, ' ').trim().slice(0, 80) })
  }
  if (!out.length) return { ok: false, reason: 'DDG 没结果' }
  return { ok: true, source: '网页', items: out }
}

/** 四个源并行；谁超时谁缺席，不影响别的 */
export async function searchAll(q, { hint = '' } = {}) {
  const word = String(q ?? '').trim()
  if (!word) return { ok: false, block: '' }
  const kw = hint ? `${word} ${hint}` : word

  const guard = (p, ms) => Promise.race([
    p.catch((e) => ({ ok: false, reason: String(e?.message ?? e).slice(0, 40) })),
    new Promise((r) => setTimeout(() => r({ ok: false, reason: '超时' }), ms)),
  ])

  const [moegirl, wiki, tieba, web] = await Promise.all([
    guard((async () => {
      const r = await fetchPage('', { q: word, timeoutMs: 14000 })
      if (!r.ok) return { ok: false, reason: r.reason || '没条目' }
      return { ok: true, source: r.site || '萌娘百科', title: r.title || word, text: String(r.text).slice(0, 460) }
    })(), 15000),
    guard(wikipedia(word), 12000),
    guard(searchPosts(kw), 12000),
    guard(ddg(kw), 12000),
  ])

  const lines = []
  let used = 0
  const push = (s) => {
    if (!s || used + s.length > MAX_TOTAL) return
    lines.push(s); used += s.length
  }

  const HINT_RE = hint ? new RegExp(hint, 'i') : null
  const ACG_BAR = /(galgame|游戏|acg|绅士|黄油|里|同人|动漫)/i
  const core = word.replace(/\s+/g, '')

  if (moegirl.ok) push(`· 【${moegirl.source}】${moegirl.text.replace(/\n+/g, ' ')}`)

  // 维基：标题里不含查询词的一律丢掉。
  // 实测教训：搜「乌有乡」它会返回「乌有之乡」（一个政治网站），完全跑偏。
  if (wiki.ok && String(wiki.title).replace(/\s+/g, '').includes(core)) {
    push(`· 【维基百科·${wiki.title}】${wiki.text}`)
  }

  // 贴吧：只留跟语境沾边的（标题/吧名里带 galgame 一类，或来自 ACG 吧）。
  // 宁可这一节不出现，也不要甩一堆「越前龙马吧」的征文。
  if (tieba.ok && tieba.items.length) {
    const good = tieba.items.filter((x) => {
      const blob = `${x.title} ${x.forum} ${x.content}`
      if (!blob.replace(/\s+/g, '').includes(core)) return false
      if (!HINT_RE) return true
      return HINT_RE.test(blob) || ACG_BAR.test(String(x.forum || ''))
    })
    if (good.length) {
      const t = good.slice(0, 3).map((x, i) => `${i + 1})《${x.title}》${x.forum ? `（${x.forum}吧）` : ''}`).join(' ')
      push(`· 【贴吧·${good.length} 条】${t}`)
    }
  }
  if (web.ok) {
    const t = web.items.slice(0, 3).map((x, i) => `${i + 1}) ${x.title}${x.host ? ` — ${x.host}` : ''}`).join(' ')
    push(`· 【网页】${t}`)
  }

  if (!lines.length) {
    const why = [moegirl, wiki, tieba, web].map((x) => x.reason).filter(Boolean).slice(0, 2).join('；')
    return { ok: false, block: `\n【我查了「${word}」，四个地方都没结果${why ? `（${why}）` : ''}】` }
  }

  const srcs = [moegirl.ok && '萌娘',
    wiki.ok && String(wiki.title).replace(/\s+/g, '').includes(core) && '维基',
    tieba.ok && tieba.items.some((x) => `${x.title} ${x.forum}`.replace(/\s+/g, '').includes(core)) && '贴吧',
    web.ok && '网页'].filter(Boolean)
  return {
    ok: true,
    block: `\n【我查了「${kw}」，走了 ${srcs.length} 个来源：${srcs.join('/')}】\n${lines.join('\n')}`,
    sources: srcs,
  }
}
