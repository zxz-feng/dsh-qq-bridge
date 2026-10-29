/**
 * lib/http.mjs —— 设置页路由用的三个小工具（发 JSON / 读 body / 判同源）
 * ============================================================================
 * 为什么单独一个文件：TG 桥的设置页要一模一样的三件套，抄一遍不如共用。
 *
 * 🔴 同源校验为什么必须做（不是"可选加固"）：
 *    浏览器里**任何一个网页**都能往 127.0.0.1 发请求 —— 包括你随手点开的
 *    恶意页面。它的请求会带上自己的 Origin，所以比对「Host 的 hostname ==
 *    Origin/Referer 的 hostname」就能把外人挡在外面，而本机、局域网 IP、
 *    反向代理域名都能正常用（不写死 127.0.0.1，那台机器换了就全 403）。
 *
 *    · 没有 Host ⇒ 不是浏览器发的（本机脚本 / 宿主内部调用），放行
 *    · 没有 Origin 也没有 Referer ⇒ 同上，放行
 *    · 有 Origin ⇒ hostname 必须和 Host 一致
 * ============================================================================
 */

export function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

export function sendBinary(res, code, buf, type = 'image/png') {
  res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' })
  res.end(buf)
}

/**
 * 读 JSON body。超限时**先把 Promise 收掉**再掐连接 ——
 * 只 destroy 不 resolve 的话这个请求会永远挂着（不回响应、也不释放）。
 */
export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      data += c
      if (data.length > limit) { data = ''; finish({}); req.destroy() }
    })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })
}

export function sameOriginOk(req) {
  try {
    const host = String(req.headers.host || '')
    if (!host) return true
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
    const pick = String(req.headers.origin || req.headers.referer || '')
    if (!pick) return true
    try {
      const u = new URL(pick)
      return u.hostname.replace(/^\[|\]$/g, '').toLowerCase() === hostname
    } catch { return false }
  } catch { return false }
}

/** 把敏感字段打码：只留末 4 位，够用来确认「填的是不是这一把」 */
export function mask(v) {
  const s = String(v ?? '')
  if (!s) return ''
  if (s.length <= 4) return '••••'
  return `••••${s.slice(-4)}`
}

export function maskConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg ?? {}))
  if (c.onebot?.token) c.onebot.token = mask(c.onebot.token)
  if (c.llm?.apiKey) c.llm.apiKey = mask(c.llm.apiKey)
  if (c.napcat?.token) c.napcat.token = mask(c.napcat.token)
  return c
}
