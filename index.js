/**
 * dsh-qq-bridge —— 宿主半端
 * ============================================================================
 * 让 DSH 接管**一个真实 QQ 号**（真人号，NapCat 扫码登录 → OneBot v11）。
 * 插件本身不碰 QQ 协议，只做五件事：
 *   1. 托管 bridge 子进程（拉起、退避重启、优雅收摊）
 *   2. 注册工具：qq_status / qq_send_group / qq_config / qq_qr / qq_verify …
 *   3. 每 5 分钟零 token 自检（进程 / OneBot 端口 / 白名单 / 家目录）
 *   4. 给「设置 → QQ 小鲸鱼」那一页开一组 /api/qq-bridge/* 路由
 *   5. 卸载时收掉子进程
 *
 * ⚠️ **NapCat 是外部依赖**，不在插件里：得自己装（Docker 镜像或桌面版）。
 *    插件只按 OneBot v11 说话 —— 这样插件跟平台无关，换电脑也能用。
 *
 * 🔴 一份真相：工具和 HTTP 路由**都调 lib/api.mjs**，谁都不许自己写盘。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDeps } from './lib/deps.mjs'
import { Supervisor } from './lib/supervisor.mjs'
import { startHostApi } from './lib/host-api.mjs'
import { homeDir } from './lib/home.mjs'
import { makeApi } from './lib/api.mjs'
import { sendJson, sendBinary, readBody, sameOriginOk, maskConfig } from './lib/http.mjs'
import { normalize, loadConfig, saveAllowlist, saveGroupCfg, loadAllowlist, loadGroupCfg, DEFAULTS, seedFiles } from './bridge/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_SCRIPT = join(HERE, 'bridge', 'main.mjs')
const PLUGIN_ID = 'qq-bridge'
const API_PREFIX = '/api/qq-bridge'

const { z, defineTool, notes } = await loadDeps()

export const name = PLUGIN_ID
export const inject = ['tools', 'settings', 'webServer']

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true),
  mode: z.string().default('auto').extra('volatile', true),
  onebotUrl: z.string().default('ws://127.0.0.1:3001').extra('volatile', true),
  onebotToken: z.string().default('').extra('volatile', true),
  mediaDir: z.string().default('').extra('volatile', true),
  cqMediaDir: z.string().default('').extra('volatile', true),
  biliPython: z.string().default('').extra('volatile', true),
  asrPython: z.string().default('').extra('volatile', true),
  biliCred: z.string().default('').extra('volatile', true),
  llmBaseUrl: z.string().default('').extra('volatile', true),
  llmApiKey: z.string().default('').extra('volatile', true),
  llmModels: z.string().default('deepseek-v4.1-flash,hy3').extra('volatile', true),
  selfHealEveryMin: z.natural().max(120).default(5).extra('volatile', true),
  // 抓网页走的代理：这台机器直连萌娘要 16 秒（fetch 10 秒直接超时），走 mihomo 1.4 秒。
  // 空着 = 直连；填 http://127.0.0.1:17890 这种就行。
  webProxy: z.string().default('').extra('volatile', true),
  controlPort: z.natural().max(65535).default(17902).extra('volatile', true),
})

export function apply(ctx, config = {}) {
  const log = (m) => ctx.logger?.info?.(m)
  const home = homeDir(PLUGIN_ID)
  for (const f of notes) log(`依赖：${f}`)

  // 先把 Config 翻成 config.json 初值，再铺文件 —— 顺序不能反（反了会让
  // 「只想装上看一眼」变成「真的连上 OneBot」）
  const initial = normalize({
      enabled: config.enabled !== false,
      mode: config.mode || DEFAULTS.mode,
      onebot: { url: config.onebotUrl || DEFAULTS.onebot.url, token: config.onebotToken || '' },
      media: { dir: config.mediaDir || '', cqDir: config.cqMediaDir || '' },
      python: { bili: config.biliPython || '', asr: config.asrPython || '', cred: config.biliCred || '' },
      llm: {
        baseUrl: config.llmBaseUrl || '',
        apiKey: config.llmApiKey || '',
        models: String(config.llmModels || '').split(',').map((s) => s.trim()).filter(Boolean),
      },
      selfHeal: { everyMin: config.selfHealEveryMin ?? 5 },
      control: { port: config.controlPort ?? 17902 },
  })
  const made = seedFiles(home, initial)
  let cfg = loadConfig(home)
  log(`家目录 ${home}${made.length ? `（首次铺了 ${made.join('、')}）` : ''}`)

  // env 用**同一个对象**交给 Supervisor：它每次 spawn 才展开，所以小门就绪后
  // 往这里补 HOST_API_URL / HOST_API_TOKEN，桥下次（或首次）拉起就带着门牌。
  // 贴吧：把 dsh-tieba-dive 的 MCP 入口路径算好交给桥（桥在 profile 的 node_modules 里
  // 自己 require 不到同级的兄弟包；exports 只放出了 '.' 和 './package.json'，所以从
  // package.json 反推目录）。没装这个插件就留空 —— 桥会安静地退回"贴吧读不了"。
  const tiebaMcp = (() => {
    try {
      const req = createRequire(import.meta.url)
      const pkg = req.resolve('dsh-tieba-dive/package.json')
      return join(dirname(pkg), 'mcp-server.mjs')
    } catch { return '' }
  })()
  if (tiebaMcp) log(`贴吧 MCP：${tiebaMcp}`)

  const hostEnv = {
    BRIDGE_HOME: home,
    DSH_HOME: process.env.DSH_HOME || '',
    ...(tiebaMcp ? { TIEBA_MCP: tiebaMcp } : {}),
    // 抓网页的代理：配置页填了就用它，否则沿用环境变量
    ...((config.webProxy || process.env.WEB_PROXY || process.env.HTTPS_PROXY)
      ? { WEB_PROXY: config.webProxy || process.env.WEB_PROXY || process.env.HTTPS_PROXY } : {}),
  }
  const sup = new Supervisor({
    script: BRIDGE_SCRIPT,
    env: hostEnv,
    logFile: join(home, 'bridge.log'),
    log,
  })

  const api = makeApi({ ctx, home, sup, log })

  // 宿主小门：把 ctx.web（联网搜索 / 抓网页）借给桥用。桥是独立进程，拿不到 ctx，
  // 只能靠这条 127.0.0.1 的带 token 通道。没有搜索 provider 时它照样活着，
  // 桥会安静地退回自己的抓取 —— 装不装搜索插件都不影响桥能不能跑。
  let hostApi = null
  let started = false
  const startBridgeOnce = (why) => {
    if (started || !cfg.enabled) return
    started = true
    try { sup.start(); log(`桥已拉起（${why}）`) } catch (e) { log(`启动失败：${e?.message ?? e}`) }
  }
  void startHostApi({ ctx, log }).then((h) => {
    hostApi = h
    if (h.url) {
      hostEnv.HOST_API_URL = h.url
      hostEnv.HOST_API_TOKEN = h.token
    }
    startBridgeOnce(h.url ? '小门就绪' : '小门起不来，退回自带搜索')
  })

  /* ─────────────── 工具（薄壳） ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (typeof v === 'string') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  tool({
    name: 'qq_status',
    description: '看 QQ 桥状态：OneBot 连上没、账号、好友白名单、群列表、今天用了几条、贴纸几条、Python 依赖有没有。',
    parameters: {},
    async execute() {
      cfg = loadConfig(home)
      return await api.status()
    },
  })

  tool({
    name: 'qq_verify',
    description: '跑一遍自检（零 token）：进程 / OneBot 连接 / 端口 / 白名单 / 家目录。能修的当场修，输出「n/6 通过」。',
    parameters: {},
    async execute() {
      cfg = loadConfig(home)
      return await api.verify()
    },
  })

  tool({
    name: 'qq_config',
    description: '读/改 QQ 桥配置（即时生效）。不传参数就是读。'
      + '常用：{"mode":"auto|draft|off"}、{"onebot":{"url":"ws://127.0.0.1:3001"}}、'
      + '{"llm":{"models":["deepseek-v4.1-flash"]}}、{"media":{"dir":"/路径/media","cqDir":"/容器内路径/media"}}',
    parameters: {
      patch: { type: 'object', additionalProperties: true },
    },
    async execute({ patch }) {
      const r = patch ? await api.writeConfig(patch) : { ok: true, config: api.readConfig() }
      cfg = r.config ?? loadConfig(home)
      return r
    },
  })

  tool({
    name: 'qq_allowlist',
    description: '读/改白名单：私聊谁可以回（allowlist）和群策略（group-allowlist）。'
      + '例：{"self":"123456","friends":{"20002000":{"label":"主人","enabled":true}}}、'
      + '{"groups":{"123456789":{"label":"主群","dryRun":false}}}、{"defaults":{"replyProb":0.02}}',
    parameters: {
      allow: { type: 'object', additionalProperties: true, description: '改私聊白名单（self / friends）' },
    },
    async execute({ allow, group }) {
      const out = {}
      if (allow) out.allow = saveAllowlist(home, allow)
      if (group) out.group = saveGroupCfg(home, group)
      if (!allow && !group) return { ok: true, allow: loadAllowlist(home), group: loadGroupCfg(home) }
      return { ok: true, ...out }
    },
  })

  tool({
    name: 'qq_send_private',
    description: '用这个 QQ 号给某个好友发一条私聊消息。',
    parameters: {
      userId: { required: true, type: 'string' },
    },
    async execute({ userId, text }) {
      return await sup.call('send_private', { userId, text }, { timeoutMs: 30000 })
    },
  })

  tool({
    name: 'qq_send_group',
    description: '用这个 QQ 号往群里发一条消息。传 dryRun:true 只试不真发。'
      + '⚠️ NapCat 群发常返回 retcode 1200 /「EventChecker Failed」，但消息**其实已经发出去了**，这里会标成「假失败」。',
    parameters: {
      groupId: { required: true, type: 'string' },
    },
    async execute({ groupId, text, dryRun = false }) {
      return await sup.call('send_group', { groupId, text, dryRun }, { timeoutMs: 40000 })
    },
  })

  tool({
    name: 'qq_groups',
    description: '列群策略：每个群的有效配置（继承 defaults 之后的结果）。',
    parameters: {},
    async execute() {
      const r = await api.listGroups()
      if (!r.groups?.length) {
        const g = loadGroupCfg(home)
        return { ok: true, groups: Object.entries(g.groups ?? {}).map(([gid, v]) => ({ gid, ...v })) }
      }
      return { ok: true, groups: r.groups }
    },
  })

  tool({
    name: 'qq_qr',
    description: '拿 QQ 登录二维码（NapCat 未登录时才有）。返回 PNG 路径，用 present 推给使用者扫。'
      + '需要先在 qq_config 里配 napcat.qrUrl 或 napcat.webui+token；没配就返回操作步骤。',
    parameters: {},
    async execute() { return await api.qr() },
  })

  tool({
    name: 'qq_stickers',
    description: '表情包库现状（条数/目录）。库是空的就说明还没导 —— 导入用命令行：node scripts/import-stickers.mjs',
    parameters: {},
    async execute() {
      const dir = join(home, 'media', 'stickers')
      const idx = join(dir, 'index.json')
      let n = 0
      try { n = Object.keys(JSON.parse(readFileSync(idx, 'utf8'))).length } catch { n = 0 }
      return { ok: true, count: n, dir, hint: n ? '' : `还没导表情包：node scripts/import-stickers.mjs --from <图片目录>` }
    },
  })

  tool({
    name: 'qq_style',
    description: '看/切某个群的说话风格档。不传 style 就是查（会列出所有可用档）。'
      + '内置：normal 正常 / sunbar 孙吧（损、短、反问） / tsundere 傲娇 / cold 冷淡 / genki 元气；'
      + '也认别名（"傲娇" "高冷" "孙吧模式"）。intensity: "mid" | "heavy"（heavy 更冲、概率更高）。'
      + '风格档是 persona/styles/*.md，加一档只要丢一个文件，改完即时生效、不用重启。',
    parameters: {
      gid: { required: true, type: 'string', description: '群号' },
    },
    async execute({ gid, style, intensity = 'mid' }) {
      // 校验和写盘都在桥里（一份真相），这里只转发
      return style ? await api.setStyle(gid, style, intensity) : await api.readStyle(gid)
    },
  })

  tool({
    name: 'qq_restart',
    description: '优雅重启 QQ 桥子进程。',
    parameters: {},
    async execute() { return await api.restart('工具请求') },
  })

  tool({
    name: 'qq_log',
    description: '看 QQ 桥日志最后几十行。',
    parameters: {
      lines: { type: 'integer' },
    },
    async execute({ lines = 40 }) {
      return { ok: true, tail: api.readLog(lines) }
    },
  })

  /* ─────────────── HTTP（设置页用） ─────────────── */

  const route = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    const m = req.method || 'GET'
    const body = m === 'POST' ? await readBody(req) : {}

    if (m === 'GET' && path === '/status') return sendJson(res, 200, await api.status())
    if (m === 'GET' && path === '/config') return sendJson(res, 200, { ok: true, config: maskConfig(api.readConfig()), defaults: DEFAULTS })
    if (m === 'POST' && path === '/config') {
      const r = await api.writeConfig(body.patch ?? body)
      return sendJson(res, 200, { ...r, config: maskConfig(r.config ?? {}) })
    }
    if (m === 'GET' && path === '/groups') return sendJson(res, 200, await api.listGroups())
    if (m === 'POST' && path === '/groups') return sendJson(res, 200, await api.writeGroup(body.gid, body.patch ?? body))
    if (m === 'GET' && path === '/styles') return sendJson(res, 200, await api.styles())
    if (m === 'POST' && path === '/style') {
      if (!body.gid || !body.style) return sendJson(res, 400, { ok: false, error: '要 gid 和 style' })
      return sendJson(res, 200, await api.setStyle(body.gid, body.style, body.intensity))
    }
    if (m === 'GET' && path === '/friends') return sendJson(res, 200, { ok: true, ...api.readFriends() })
    if (m === 'POST' && path === '/friends') return sendJson(res, 200, await api.writeFriend(body))
    if (m === 'POST' && path === '/verify') return sendJson(res, 200, await api.verify())
    if (m === 'GET' && path === '/log') return sendJson(res, 200, { ok: true, tail: api.readLog(url.searchParams.get('lines') || 40) })
    if (m === 'GET' && path === '/qr') {
      const r = await api.qr()
      if (r.ok && r.path && existsSync(r.path)) {
        try { return sendBinary(res, 200, readFileSync(r.path)) } catch { /* 落到下面 */ }
      }
      // 已经登录了就没有二维码 —— 给 204，前端据此显示「已登录」
      if (r.hint && /已经登录|没拿到图/.test(r.hint)) return sendJson(res, 204, { ok: true, loggedIn: true })
      return sendJson(res, 200, r)
    }
    if (m === 'POST' && path === '/restart') return sendJson(res, 200, await api.restart('设置页请求'))
    return sendJson(res, 404, { ok: false, error: `没有这条路由：${m} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        // 别的网页在你浏览器里也能打 127.0.0.1，所以先判同源
        if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受同源请求' })
        try { await route(req, res) } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 300) }) }
      },
    }), 'qq-bridge: /api/qq-bridge 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  // 桥的拉起交给 startHostApi().then(...)：先让小门就绪，第一次 spawn 就带上门牌。
  // 这里只负责「不启动」的那句日志。
  if (!cfg.enabled) log('配置 enabled=false —— 已装载但不启动')

  const everyMin = cfg.selfHeal?.everyMin ?? 5
  if (everyMin > 0) {
    const timer = setInterval(async () => {
      try {
        const cur = loadConfig(home)
        if (!cur.enabled) return
        await api.verify()
      } catch (e) { log(`自检异常：${e?.message ?? e}`) }
    }, everyMin * 60 * 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'qq-bridge: 周期自检')
  }

  ctx.effect(() => () => { void sup.stop() }, 'qq-bridge: 收 bridge 子进程')
  ctx.effect(() => () => { try { hostApi?.close?.() } catch { /* 已经关了 */ } }, 'qq-bridge: 收宿主小门')

  log(`已挂载（家=${home}，自检每 ${everyMin} 分钟，设置页 ${API_PREFIX}）`)
}
