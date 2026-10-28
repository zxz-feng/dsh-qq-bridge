/**
 * dsh-qq-bridge —— 宿主半端
 * ============================================================================
 * 让 DSH 接管**一个真实 QQ 号**（真人号，NapCat 扫码登录 → OneBot v11）。
 * 插件本身不碰 QQ 协议，只做四件事：
 *   1. 托管 bridge 子进程（拉起、退避重启、优雅收摊）
 *   2. 注册工具：qq_status / qq_send_group / qq_config / qq_qr / qq_verify …
 *   3. 每 5 分钟零 token 自检（进程 / OneBot 端口 / 白名单 / 家目录）
 *   4. 卸载时收掉子进程
 *
 * ⚠️ **NapCat 是外部依赖**，不在插件里：得自己装（Docker 镜像或桌面版）。
 *    插件只按 OneBot v11 说话 —— 这样插件跟平台无关，换电脑也能用。
 * ============================================================================
 */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDeps } from './lib/deps.mjs'
import { Supervisor } from './lib/supervisor.mjs'
import { homeDir, writeJson } from './lib/home.mjs'
import { runChecks, formatReport, tailLog } from './lib/health.mjs'
import { normalize, loadConfig, saveConfig, seedFiles, loadAllowlist, saveAllowlist, loadGroupCfg, saveGroupCfg, DEFAULTS } from './bridge/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_SCRIPT = join(HERE, 'bridge', 'main.mjs')
const PLUGIN_ID = 'qq-bridge'

const { z, defineTool, notes } = await loadDeps()

export const name = PLUGIN_ID
export const inject = ['tools', 'settings']

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

  const sup = new Supervisor({
    script: BRIDGE_SCRIPT,
    env: { BRIDGE_HOME: home, DSH_HOME: process.env.DSH_HOME || '' },
    logFile: join(home, 'bridge.log'),
    log,
  })

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
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      cfg = loadConfig(home)
      const supInfo = sup.info()
      let bridge = null
      try { bridge = await sup.call('status', {}, { timeoutMs: 8000 }) } catch (e) { bridge = { error: String(e?.message ?? e) } }
      return { ok: true, enabled: cfg.enabled, process: supInfo, bridge, config: cfg, home }
    },
  })

  tool({
    name: 'qq_verify',
    description: '跑一遍自检（零 token）：进程 / OneBot 连接 / 端口 / 白名单 / 家目录。能修的当场修，输出「n/6 通过」。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      cfg = loadConfig(home)
      const r = await runChecks({
        client: {
          info: () => sup.info(),
          call: (a, p, o) => sup.call(a, p, o),
          start: () => { sup.state = 'idle'; return sup.start() },
          restart: (why) => sup.restart(why),
        },
        home,
        cfg: { ...cfg, socksUrl: '' },
        fix: true,
        platform: 'qq',
        // QQ 侧把「代理端口」换成「OneBot 端口」
        probe: { host: new URL(cfg.onebot.url.replace(/^ws/, 'http')).hostname, port: Number(new URL(cfg.onebot.url.replace(/^ws/, 'http')).port || 80) },
      })
      return { ok: r.passed === r.total, report: formatReport(r, { name: 'QQ 桥' }), ...r }
    },
  })

  tool({
    name: 'qq_config',
    description: '读/改 QQ 桥配置（即时生效）。不传参数就是读。'
      + '常用：{"mode":"auto|draft|off"}、{"onebot":{"url":"ws://127.0.0.1:3001"}}、'
      + '{"llm":{"models":["deepseek-v4.1-flash"]}}、{"media":{"dir":"/路径/media","cqDir":"/容器内路径/media"}}',
    parameters: {
      type: 'object',
      properties: { patch: { type: 'object', additionalProperties: true } },
      additionalProperties: false,
    },
    async execute({ patch }) {
      cfg = patch ? saveConfig(home, patch) : loadConfig(home)
      try { await sup.call('config', { patch: patch ?? null }, { timeoutMs: 8000 }) } catch { /* 子进程没跑 */ }
      return { ok: true, config: cfg }
    },
  })

  tool({
    name: 'qq_allowlist',
    description: '读/改白名单：私聊谁可以回（allowlist）和群策略（group-allowlist）。'
      + '例：{"self":"123456","friends":{"1807430990":{"label":"主人","enabled":true}}}、'
      + '{"groups":{"783599631":{"label":"主群","dryRun":false}}}、{"defaults":{"replyProb":0.02}}',
    parameters: {
      type: 'object',
      properties: {
        allow: { type: 'object', additionalProperties: true, description: '改私聊白名单（self / friends）' },
        group: { type: 'object', additionalProperties: true, description: '改群策略（groups / defaults）' },
      },
      additionalProperties: false,
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
      type: 'object',
      properties: { userId: { type: 'string' }, text: { type: 'string' } },
      required: ['userId', 'text'],
      additionalProperties: false,
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
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        text: { type: 'string', description: '文本，或 CQ 码（如 [CQ:image,file=...]）' },
        dryRun: { type: 'boolean' },
      },
      required: ['groupId', 'text'],
      additionalProperties: false,
    },
    async execute({ groupId, text, dryRun = false }) {
      return await sup.call('send_group', { groupId, text, dryRun }, { timeoutMs: 40000 })
    },
  })

  tool({
    name: 'qq_groups',
    description: '列群策略：每个群的有效配置（继承 defaults 之后的结果）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      try { return { ok: true, groups: await sup.call('groups', {}, { timeoutMs: 8000 }) } } catch {
        const g = loadGroupCfg(home)
        return { ok: true, groups: Object.entries(g.groups ?? {}).map(([gid, v]) => ({ gid, ...v })) }
      }
    },
  })

  tool({
    name: 'qq_qr',
    description: '拿 QQ 登录二维码（NapCat 未登录时才有）。返回 PNG 路径，用 present 推给使用者扫。'
      + '需要先在 qq_config 里配 napcat.qrUrl 或 napcat.webui+token；没配就返回操作步骤。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      cfg = loadConfig(home)
      const nap = cfg.napcat ?? {}
      const out = join(home, 'qrcode.png')
      const tries = []
      if (nap.qrUrl) tries.push(nap.qrUrl)
      if (nap.webui) {
        const base = String(nap.webui).replace(/\/$/, '')
        tries.push(`${base}/api/QQLogin/GetQQLoginQrcode${nap.token ? `?token=${encodeURIComponent(nap.token)}` : ''}`)
      }
      for (const url of tries) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
          const ct = res.headers.get('content-type') ?? ''
          if (ct.includes('image')) {
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length > 1000) { writeFileSync(out, buf); return { ok: true, path: out, bytes: buf.length } }
          }
          const j = await res.json().catch(() => null)
          const b64 = j?.data?.qrcode ?? j?.qrcode ?? j?.data?.base64
          if (typeof b64 === 'string' && b64.length > 1000) {
            const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
            writeFileSync(out, buf)
            return { ok: true, path: out, bytes: buf.length }
          }
          return { ok: false, url, hint: '接口通了但没拿到图，可能已经登录了，或者字段名不一样', raw: JSON.stringify(j).slice(0, 300) }
        } catch (e) {
          log(`取二维码失败（${url}）：${e?.message ?? e}`)
        }
      }
      return {
        ok: false,
        hint: '没配二维码来源。三条路：① 打开 NapCat 的 WebUI 自己扫码；'
          + '② 把 WebUI 里二维码图片的直链填进 qq_config 的 napcat.qrUrl；'
          + '③ 桌面版 NapCat 会直接弹窗。扫完用 qq_verify 确认 OneBot 通了。',
      }
    },
  })

  tool({
    name: 'qq_stickers',
    description: '表情包库现状（条数/目录）。库是空的就说明还没导 —— 导入用命令行：node scripts/import-stickers.mjs',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const dir = join(home, 'media', 'stickers')
      const idx = join(dir, 'index.json')
      let n = 0
      try { n = Object.keys(JSON.parse((await import('node:fs')).readFileSync(idx, 'utf8'))).length } catch { n = 0 }
      return { ok: true, count: n, dir, hint: n ? '' : `还没导表情包：node scripts/import-stickers.mjs --from <图片目录>` }
    },
  })

  tool({
    name: 'qq_restart',
    description: '优雅重启 QQ 桥子进程。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const r = await sup.restart('工具请求')
      return { ok: Boolean(r), process: sup.info() }
    },
  })

  tool({
    name: 'qq_log',
    description: '看 QQ 桥日志最后几十行。',
    parameters: {
      type: 'object',
      properties: { lines: { type: 'natural' } },
      additionalProperties: false,
    },
    async execute({ lines = 40 }) {
      return { ok: true, tail: tailLog(home, Math.min(200, Math.max(10, Number(lines) || 40))) }
    },
  })

  if (cfg.enabled) {
    try { sup.start() } catch (e) { log(`启动失败：${e?.message ?? e}`) }
  } else {
    log('配置 enabled=false —— 已装载但不启动')
  }

  const everyMin = cfg.selfHeal?.everyMin ?? 5
  if (everyMin > 0) {
    const timer = setInterval(async () => {
      try {
        const cur = loadConfig(home)
        if (!cur.enabled) return
        await runChecks({
          client: {
            info: () => sup.info(),
            call: (a, p, o) => sup.call(a, p, o),
            start: () => { sup.state = 'idle'; return sup.start() },
            restart: (why) => sup.restart(why),
          },
          home,
          cfg: cur,
          fix: true,
        })
      } catch (e) { log(`自检异常：${e?.message ?? e}`) }
    }, everyMin * 60 * 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'qq-bridge: 周期自检')
  }

  ctx.effect(() => () => { void sup.stop() }, 'qq-bridge: 收 bridge 子进程')

  log(`已挂载（家=${home}，自检每 ${everyMin} 分钟）`)
}
