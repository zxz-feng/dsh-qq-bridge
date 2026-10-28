/**
 * bridge/control.mjs —— 本机回环控制口（给「不启 DSH 也能自检」和外部看护用）
 * ============================================================================
 * 为什么还要一个 HTTP 口：插件在 DSH 里时，工具走 IPC 就够；但
 *   · `npm run verify` 要在没有 DSH 的机器上跑
 *   · 服务器上想用 curl / 监控探一下
 * 所以子进程自己开一个 **只绑 127.0.0.1** 的极小 HTTP 服务，带 token。
 *
 * 安全：
 *   · 默认 host=127.0.0.1（config.control.host 可以改，但没人该改）
 *   · token 每次启动随机生成，写 `<home>/control.json`（600 权限），调用方要带
 *     `Authorization: Bearer <token>`
 *   · 只认 POST 改配置/发消息；GET 只读
 * ============================================================================
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeJson } from '../lib/home.mjs'

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 65536) {
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
 * @param {object} o
 * @param {string} o.home
 * @param {object} o.cfg
 * @param {Record<string, (params:any)=>Promise<any>>} o.handlers
 * @returns {Promise<{port:number, close:Function}>}
 */
export function startControl({ home, cfg, handlers }) {
  const token = randomBytes(24).toString('hex')
  const host = cfg.control?.host || '127.0.0.1'
  const wantPort = cfg.control?.port || 17901

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const auth = String(req.headers.authorization || '')
      if (auth !== `Bearer ${token}`) return unauthorized(res)

      const url = new URL(req.url || '/', `http://${host}`)
      const name = url.pathname.replace(/^\//, '')

      if (req.method === 'GET' && name === 'ping') return json(res, 200, { ok: true })

      const fn = handlers[name]
      if (!fn) return json(res, 404, { ok: false, error: `没有这个动作：${name}` })

      try {
        const params = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams)
        if (params === null) return json(res, 400, { ok: false, error: 'body 不是合法 JSON' })
        const data = await fn(params)
        return json(res, 200, { ok: true, data })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 300) })
      }
    })

    server.on('error', (e) => {
      // 端口被占就退到随机端口（同机多开也不打架）
      if (e?.code === 'EADDRINUSE') {
        server.listen(0, host, () => {
          const port = server.address().port
          writeJson(`${home}/control.json`, { host, port, token, since: new Date().toISOString() })
          resolve({ port, close: () => server.close() })
        })
      } else {
        console.error('[control] 起不来:', e?.message ?? e)
        resolve({ port: 0, close: () => {} })
      }
    })

    server.listen(wantPort, host, () => {
      const port = server.address().port
      writeJson(`${home}/control.json`, { host, port, token, since: new Date().toISOString() })
      console.log(`[control] 监听 http://${host}:${port}（token 在 control.json）`)
      resolve({ port, close: () => server.close() })
    })
  })
}
