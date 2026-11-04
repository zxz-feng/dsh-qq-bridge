/**
 * 「这部漫画更新到第几话了？」
 *
 * 走的是「先问搜索引擎，再抓一页」的路子，不是猜：
 *   1. DDG 搜两遍（`最新话` / `更新至`），从**摘要**里抠「更新至第 123 话」这类现成话号；
 *   2. 顺带从结果里挑一个能直连的漫画站（manhuagui 最稳，静态 HTML），抓一页把话号列表也读出来；
 *   3. 两边取最大话号，谁大信谁。
 *
 * 为什么不直接读 bilibili 漫画 / 拷贝漫画：那两个页面是 JS 渲染的，curl 拿到的是空壳。
 * 为什么不解析「第 X 话」以外的写法：日漫常写「第 123 話」「#123」「Ch.123」，这里一并认。
 */

import { ddgSearch } from './search-all.mjs'
import { fetchPage } from './webpage.mjs'

/** 漫画/番剧这类「更新到哪」的问题才走这条路，别的查询别浪费一次搜索 */
const KIND_RE = /(漫画|漫畫|番剧|番劇|动画|動畫|动漫|動漫|轻小说|輕小說|连载|連載)/
const ASK_RE = /(更新|最新|第几话|第幾話|到哪|多少话|多少話|完结|完結|更到|出到)/

export function isComicUpdate(text) {
  const s = String(text ?? '')
  return KIND_RE.test(s) && ASK_RE.test(s)
}

/** 「更新至第 123 话」「最新话 第 45 回」→ 123 / 45 */
const NUM_RES = [
  /(?:更新|更至|已更新|连载|連載|最新|至)\s*第?\s*(\d{1,4}(?:\.\d)?)\s*[话話回集話章]/g,
  /第\s*(\d{1,4}(?:\.\d)?)\s*[话話回集章]/g,
  /\bCh(?:apter)?\.?\s*(\d{1,4}(?:\.\d)?)\b/gi,
]

export function maxNum(text) {
  const s = String(text ?? '')
  let best = 0
  for (const re of NUM_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s))) {
      const n = Number(m[1])
      // 明显不是话号的（年份、页数）过滤掉
      if (Number.isFinite(n) && n > 0 && n < 3000) best = Math.max(best, n)
    }
  }
  return best
}

/** 能直连、静态 HTML 的漫画站；bilibili/拷贝漫画是 JS 渲染，抓了也白抓 */
const SITE_RE = /^(?:https?:\/\/)?(?:www\.)?(manhuagui\.com|m\.manhuagui\.com|baozimh\.com|www\.baozimh\.com|dm5\.com|www\.dm5\.com|manhuaren\.com|www\.manhuaren\.com)\//i

export function pickTitle(q) {
  return String(q ?? '')
    .replace(/[（(].*?[)）]/g, ' ')
    .replace(/(更新到|更新至|最新|第几话|第幾話|到哪了?|到哪里了?|哪里了?|到哪|哪了|多少话|了吗|了没|漫画|漫畫|番剧|番劇|动画|動畫|动漫|動漫|更到|出到|完结|完結)/g, ' ')
    .replace(/[《》「」"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @returns {{ok:boolean, title:string, latest:number, source:string, url:string, note:string}}
 */
export async function comicUpdate(query, { timeoutMs = 22000 } = {}) {
  const title = pickTitle(query) || String(query ?? '').trim()
  const deadline = Date.now() + timeoutMs
  const left = () => Math.max(3000, deadline - Date.now())

  const notes = []
  let latest = 0
  let from = ''
  let url = ''

  // ① 搜索引擎摘要：最快，且经常直接写着「更新至第 123 话」
  const queries = [`${title} 漫画 最新话`, `${title} 漫画 更新至`]
  const results = await Promise.all(queries.map((q) =>
    Promise.race([
      ddgSearch(q).catch(() => ({ ok: false })),
      new Promise((r) => setTimeout(() => r({ ok: false }), left())),
    ])))

  const items = results.flatMap((r) => (r && r.ok ? r.items : []))
  for (const it of items) {
    const blob = `${it.title} ${it.snippet}`
    const n = maxNum(blob)
    if (n > latest) {
      latest = n
      from = it.host || '网页'
    }
  }

  // ② 挑一个静态站抓正文，把章节列表也读一遍（摘要有时是旧缓存）
  const cand = items.find((it) => it.url && SITE_RE.test(it.url))
  if (cand) {
    try {
      const r = await Promise.race([
        fetchPage(cand.url, { timeoutMs: Math.min(12000, left()) }),
        new Promise((res) => setTimeout(() => res({ ok: false }), Math.min(12000, left()))),
      ])
      if (r && r.ok) {
        const n = maxNum(r.text)
        if (n > latest) {
          latest = n
          from = r.site || cand.host || '网页'
          url = cand.url
        } else if (!url) {
          url = cand.url
        }
        if (n) notes.push(`${from} 页面里读到第 ${n} 话`)
      }
    } catch { /* 抓不到就算了，摘要里的号还在 */ }
  }

  if (!latest) return { ok: false, title, latest: 0, source: from, url, note: notes.join('；') }
  return { ok: true, title, latest, source: from, url, note: notes.join('；') }
}

/** 拼成给模型看的一行；查不到就返回空串（别硬编） */
export async function comicBlock(query) {
  const r = await comicUpdate(query)
  if (!r.ok) return ''
  const link = r.url ? ` ${r.url}` : ''
  return `· 【最新话】《${r.title}》更新到第 ${r.latest} 话（来源：${r.source}）${link}`
}
