/**
 * lib/host-api.mjs —— 宿主能力小门（桥 → DSH 的唯一上行通道）
 * ============================================================================
 * 为什么需要它：
 *   桥是**独立子进程**，跑在 DSH 外面，拿不到 `ctx`。DSH 里那些能力
 *   （联网搜索 `ctx.web`、网页抓取）只存在于宿主进程里。
 *   所以父进程开一个**只绑 127.0.0.1 的随机端口**，带 token，子进程用
 *   `HOST_API_URL` + `HOST_API_TOKEN` 过来问。
 *
 * 设计上的三条底线：
 *   1. **可选**：`ctx.get('web')` 没有（没装搜索 provider）时接口照常活着，
 *      返回 `{ok:false, code:'NO_PROVIDER'}`，子进程据此退回自己的抓取，不报错。
 *   2. **不阻塞**：每个请求都有超时（`AbortSignal.timeout`），搜索再慢也不会
 *      把桥卡死 —— 桥那边还有自己的 18s 上限。
 *   3. **不泄密**：只回 `answer`/`sources`/`text`，不回任何凭证；token 每次启动
 *      随机生成，只经环境变量交给子进程，不落盘。
 *
 * 反过来说：**没有这条通道，装什么搜索插件都没用** —— 插件的能力长在宿主进程里。
 * ============================================================================
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const MAX_BODY = 64 * 1024

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { req.destroy(); resolve(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * 起宿主小门。
 * @param {object} o
 * @param {object} o.ctx    插件 ctx（用来 `ctx.get('web')`）
 * @param {Function} [o.log]
 * @param {number} [o.timeoutMs] 单次搜索/抓取上限，默认 20s
 * @returns {Promise<{url:string, token:string, close:Function, hasWeb:()=>boolean}>}
 */
export function startHostApi({ ctx, log = () => {}, timeoutMs = 20000 }) {
  const token = randomBytes(24).toString('hex')

  /** web 能力接缝；没装 provider 时是 undefined —— 这不算错 */
  const seam = () => {
    try { return ctx?.get?.('web') } catch { return undefined }
  }
  const hasWeb = () => {
    const w = seam()
    return Boolean(w && typeof w.search === 'function')
  }

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const auth = String(req.headers.authorization || '')
      if (auth !== `Bearer ${token}`) return json(res, 401, { ok: false, error: 'unauthorized' })

      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const name = url.pathname.replace(/^\//, '')

      if (req.method === 'GET' && name === 'ping') {
        return json(res, 200, { ok: true, data: { hasWeb: hasWeb() } })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只认 POST' })

      const body = await readBody(req)
      if (body === null) return json(res, 400, { ok: false, error: 'body 不是合法 JSON' })

      if (name === 'search') {
        const query = String(body.query ?? '').trim().slice(0, 200)
        if (!query) return json(res, 400, { ok: false, error: 'query 为空' })
        const web = seam()
        if (!web || typeof web.search !== 'function') {
          return json(res, 200, { ok: false, code: 'NO_PROVIDER', error: '宿主没有可用的联网搜索' })
        }
        try {
          const maxResults = Math.min(10, Math.max(1, Number(body.maxResults) || 5))
          const out = await web.search({ query, maxResults }, AbortSignal.timeout(timeoutMs))
          return json(res, 200, {
            ok: true,
            data: {
              answer: typeof out?.answer === 'string' ? out.answer : '',
              truncated: Boolean(out?.truncated),
              sources: Array.isArray(out?.sources)
                ? out.sources.slice(0, maxResults).map((s) => ({
                  url: String(s?.url ?? ''),
                  title: String(s?.title ?? ''),
                  snippet: String(s?.snippet ?? ''),
                }))
                : [],
            },
          })
        } catch (e) {
          const code = String(e?.code ?? '')
          // 没 key 是最常见的一种；照样 200 回，让桥安静退回自己的搜索
          if (/CREDENTIAL_MISSING|NO_API_KEY/.test(code) || /no API key/i.test(String(e?.message))) {
            return json(res, 200, { ok: false, code: 'NO_CREDENTIAL', error: '宿主搜索没配密钥' })
          }
          return json(res, 200, { ok: false, code: code || 'SEARCH_FAILED', error: String(e?.message ?? e).slice(0, 200) })
        }
      }

      if (name === 'fetch') {
        const target = String(body.url ?? '').trim()
        if (!/^https?:\/\//i.test(target)) return json(res, 400, { ok: false, error: 'url 不是 http(s)' })
        const web = seam()
        if (!web || typeof web.fetch !== 'function') {
          return json(res, 200, { ok: false, code: 'NO_PROVIDER', error: '宿主没有可用的网页抓取' })
        }
        try {
          const out = await web.fetch({ url: target }, AbortSignal.timeout(timeoutMs))
          const text = String(out?.text ?? '')
          return json(res, 200, {
            ok: true,
            data: {
              url: String(out?.url ?? target),
              statusCode: Number(out?.statusCode ?? 0),
              // 抓网页只回前 8KB：桥那边是喂给模型的，多了白烧 token
              text: text.slice(0, 8000),
              truncated: text.length > 8000,
            },
          })
        } catch (e) {
          return json(res, 200, { ok: false, code: String(e?.code ?? 'FETCH_FAILED'), error: String(e?.message ?? e).slice(0, 200) })
        }
      }

      return json(res, 404, { ok: false, error: `没有这个动作：${name}` })
    })

    const done = (port) => {
      const addr = `http://127.0.0.1:${port}`
      log(`宿主小门 ${addr}（web ${hasWeb() ? '可用' : '未配置'}）`)
      resolve({ url: addr, token, close: () => server.close(), hasWeb })
    }

    server.on('error', (e) => {
      log(`宿主小门起不来：${e?.message ?? e}`)
      // 起不来也不能拖累桥 —— 回一个空地址，桥会退回自己的搜索
      resolve({ url: '', token: '', close: () => {}, hasWeb })
    })
    // 端口 0 = 让内核挑一个空闲端口，永远不会和 17902/3001 这些打架
    server.listen(0, '127.0.0.1', () => done(server.address().port))
  })
}
