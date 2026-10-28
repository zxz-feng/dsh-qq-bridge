/**
 * 「帮你找个 X」—— 找资源 + 带缩略图
 * ============================================================================
 * 起因（2026-10-29）：群里让找黄油，她嘴上答应了「缩略图我找」然后**什么都没发**。
 * 根因两条：
 *   ① shouldSearch 只认"什么意思/是谁/最新"这类**知识型**问法，认不出"帮我找个 X"；
 *   ② 就算搜到了，她也**没有发图出口** —— 只有表情包库和语音，搜到的图发不出去。
 * 所以这里补两件事：能搜到"作品页"，能把封面图真的发出去。
 *
 * 数据源：DLsite（作品页有 og:title / og:image，稳定；国内也直连得通）
 * 交付：标题 + 一句简介 + 缩略图 + 链接
 *
 * ⚠️ 只发店铺公开的封面图，不抓内容、不搬运资源本体 —— 要的就是"这是什么"那一眼。
 * ============================================================================
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const PROXY = process.env.GOODS_PROXY || 'http://127.0.0.1:17890'

async function curlText(url, { timeoutMs = 20000, proxy = '' } = {}) {
  const args = [
    '-sSL', '--max-time', String(Math.round(timeoutMs / 1000)),
    '-A', UA, '-H', 'Accept-Language: ja,zh;q=0.8',
  ]
  if (proxy) args.push('-x', proxy)
  args.push(url)
  const { stdout } = await exec('curl', args, { timeout: timeoutMs + 5000, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/**
 * 抓文本：先直连，拿不到再走本地代理
 * （实测 dlsite 偶尔掐直连，但代理一直通；反过来也有过，所以两条腿都要）
 */
async function fetchText(url, timeoutMs = 20000) {
  try {
    const t = await curlText(url, { timeoutMs })
    if (t && t.length > 2000) return t
  } catch { /* 直连失败，走代理 */ }
  try { return await curlText(url, { timeoutMs, proxy: PROXY }) } catch { return '' }
}

async function fetchBuffer(url, timeoutMs = 25000) {
  const { stdout } = await exec('curl', [
    '-sSL', '--max-time', String(Math.round(timeoutMs / 1000)), '-A', UA, url,
  ], { timeout: timeoutMs + 5000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' })
  return stdout
}

function decodeEntities(s = '') {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, ' ')
}

/**
 * 在 DLsite 搜作品
 * @returns {Promise<Array<{id:string,url:string}>>}
 */
export async function dlsiteSearch(keyword, n = 4) {
  const kw = String(keyword ?? '').trim().slice(0, 40)
  if (!kw) return []
  const url = `https://www.dlsite.com/maniax/fsr/=/language/jp/keyword/${encodeURIComponent(kw)}`
  let html = ''
  try { html = await fetchText(url) } catch { return [] }
  const ids = []
  for (const m of html.matchAll(/product_id\/([A-Z]{2}\d{6,})/g)) {
    const id = m[1]
    if (!ids.includes(id)) ids.push(id)
    if (ids.length >= n) break
  }
  return ids.map((id) => ({ id, url: `https://www.dlsite.com/maniax/work/=/product_id/${id}.html` }))
}

/** 作品页 → 标题 / 封面 / 简介 */
export async function productInfo(id) {
  const url = `https://www.dlsite.com/maniax/work/=/product_id/${id}.html`
  let html = ''
  try { html = await fetchText(url) } catch { return null }
  const pick = (prop) => {
    const m = html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))
    return m ? decodeEntities(m[1]).trim() : ''
  }
  const title = pick('og:title').replace(/\s*\|\s*DLsite.*$/, '').trim()
  const image = pick('og:image')
  const desc = pick('og:description').slice(0, 90)
  if (!image) return null
  return { id, url, title, image, desc }
}

/**
 * 「帮我找个 X」的完整流程：搜 → 取第一个有封面的作品
 * @returns {Promise<{ok:boolean, item?:object, reason?:string}>}
 */
export async function findGoods(keyword, { n = 4 } = {}) {
  const kw = String(keyword ?? '').trim()
  if (!kw) return { ok: false, reason: '没给关键词' }
  const list = await dlsiteSearch(kw, n)
  if (!list.length) return { ok: false, reason: '搜不到这个' }
  for (const { id } of list) {
    const info = await productInfo(id)
    if (info?.image) return { ok: true, item: info }
  }
  return { ok: false, reason: '搜到了但没封面' }
}

export { fetchBuffer }
