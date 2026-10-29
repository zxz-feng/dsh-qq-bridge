/**
 * lib/api.mjs —— 宿主半端的「数据面」（工具和设置页共用）
 * ============================================================================
 * 为什么要抽出来：同一件事有两个入口 —— 模型调工具、主人在设置页点按钮。
 * 如果两边各写一份，就一定会分叉（一边钳位了、另一边没钳位；一边脱敏了、
 * 另一边把 token 吐给了浏览器）。所以规则是：
 *
 *   工具  = 薄壳，只做「解析参数 → 调 api → 包成工具输出」
 *   路由  = 薄壳，只做「解析请求 → 调 api → 序列化」
 *   api.* = 唯一实现，校验/钳位/落盘都在这儿（或它调用的 bridge/config.mjs）
 *
 * 写盘一律走 bridge/config.mjs 的 saveConfig / saveAllowlist / saveGroupCfg
 * （它们会 normalize 钳位），**不要**在这儿裸 writeFileSync。
 * ============================================================================
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalize, loadConfig, saveConfig, seedFiles,
  loadAllowlist, saveAllowlist, loadGroupCfg, saveGroupCfg, DEFAULTS,
} from '../bridge/config.mjs'
import { runChecks, formatReport, tailLog } from './health.mjs'

/** 数字项：前端传字符串也得认，认不出就用当前值（不是 0） */
function toInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

export function makeApi({ ctx, home, sup, log }) {
  const call = async (name, params, ms = 8000) => {
    try { return { ok: true, data: await sup.call(name, params, { timeoutMs: ms }) } }
    catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 300) } }
  }

  const checks = (cfg) => runChecks({
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
    probe: {
      host: new URL(cfg.onebot.url.replace(/^ws/, 'http')).hostname,
      port: Number(new URL(cfg.onebot.url.replace(/^ws/, 'http')).port || 80),
    },
  })

  return {
    home,

    /* ── 状态 ─────────────────────────────────────── */
    async status() {
      const cfg = loadConfig(home)
      const bridge = await call('status')
      return {
        ok: true,
        enabled: cfg.enabled,
        home,
        process: sup.info(),
        bridge: bridge.ok ? bridge.data : { error: bridge.error },
        config: cfg,
      }
    },

    /* ── 配置 ─────────────────────────────────────── */
    readConfig() { return loadConfig(home) },

    async writeConfig(patch) {
      if (!patch || typeof patch !== 'object') return { ok: true, config: loadConfig(home) }
      const next = saveConfig(home, patch)
      // 桥每轮重读文件，这里只是让它立刻知道（连不上就算了，文件已经落盘）
      await call('config', { patch })
      return { ok: true, config: next, note: '已保存，下一句消息就按新配置走' }
    },

    /* ── 群策略 ───────────────────────────────────── */
    async listGroups() {
      const g = loadGroupCfg(home)
      const groups = g.groups ?? {}
      // 风格档的真相在桥里（persona/styles/*.md 可能被主人手工加过档）
      const reg = await call('style', {})
      const available = reg.ok && Array.isArray(reg.data?.available) ? reg.data.available : []
      const rows = []
      for (const [gid, v] of Object.entries(groups)) {
        const st = await call('style', { gid })
        rows.push({
          gid,
          label: v.label ?? '',
          enabled: v.enabled !== false,
          dryRun: v.dryRun !== false,
          effective: { ...(g.defaults ?? {}), ...v },
          style: st.ok ? { style: st.data.style, intensity: st.data.intensity, since: st.data.since } : null,
        })
      }
      return { ok: true, defaults: g.defaults ?? {}, groups: rows, available, bridgeUp: reg.ok }
    },

    async writeGroup(gid, patch) {
      const id = String(gid ?? '').trim()
      if (!/^\d{4,12}$/.test(id)) return { ok: false, error: '群号不对（应该是 4~12 位数字）' }
      if (!patch || typeof patch !== 'object') return { ok: false, error: '没有要改的字段' }
      const clean = { ...patch }
      // 数字项在这里再收一遍（前端只管显示，钳位以服务端为准）
      const nums = {
        replyProb: [0, 1], coldProb: [0, 1], coldAfterMin: [0, 1440],
        dailyActive: [0, 200], dailyTotal: [0, 2000], voicePerDay: [0, 999],
        fullSongPerDay: [0, 999], fullSongMaxSeg: [1, 60], searchPerDay: [0, 999],
        cooldownSec: [0, 3600], memberCooldownMin: [0, 1440], hardCooldownSec: [0, 120],
        spamThreshold: [0, 100], spamSeconds: [0, 86400],
      }
      for (const [k, [lo, hi]] of Object.entries(nums)) {
        if (clean[k] === undefined) continue
        const n = Number(clean[k])
        if (!Number.isFinite(n)) delete clean[k]
        else clean[k] = Math.min(hi, Math.max(lo, n))
      }
      if (clean.quietHours !== undefined) {
        const a = Array.isArray(clean.quietHours) ? clean.quietHours : []
        const start = Math.min(23, Math.max(0, toInt(a[0], 2)))
        const end = Math.min(23, Math.max(0, toInt(a[1], 9)))
        clean.quietHours = [start, end]
      }
      const next = saveGroupCfg(home, { groups: { [id]: clean } })
      return { ok: true, group: { gid: id, ...(next.groups?.[id] ?? {}) } }
    },

    /* ── 风格档 ───────────────────────────────────── */
    async styles() {
      const r = await call('style', {})
      if (!r.ok) return { ok: false, error: r.error, available: [] }
      return { ok: true, available: r.data?.available ?? [] }
    },

    async setStyle(gid, style, intensity = 'mid') {
      const r = await call('style', { gid: String(gid), style, intensity })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r.data }
    },

    async readStyle(gid) {
      const r = await call('style', { gid: String(gid) })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r.data }
    },

    /* ── 好友白名单 ───────────────────────────────── */
    readFriends() { return loadAllowlist(home) },

    async writeFriend({ uin, label, enabled, remove, self } = {}) {
      const id = String(uin ?? '').trim()
      if (self !== undefined) return { ok: true, allow: saveAllowlist(home, { self: String(self) }) }
      if (!/^\d{4,12}$/.test(id)) return { ok: false, error: 'QQ 号不对（应该是 4~12 位数字）' }
      const cur = loadAllowlist(home)
      const friends = { ...(cur.friends ?? {}) }
      if (remove) {
        delete friends[id]
        // ⚠️ 删除只能用 replaceFriends：saveAllowlist 默认是**合并**，
        //    「删掉某个人」用合并表达不出来（2026-10-29 踩到）
        return { ok: true, allow: saveAllowlist(home, { replaceFriends: friends }) }
      }
      friends[id] = { ...(friends[id] ?? {}), ...(label !== undefined ? { label: String(label).slice(0, 40) } : {}), ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}) }
      return { ok: true, allow: saveAllowlist(home, { friends }) }
    },

    /* ── 自检 / 日志 ──────────────────────────────── */
    async verify() {
      const cfg = loadConfig(home)
      const r = await checks(cfg)
      return { ok: r.passed === r.total, report: formatReport(r, { name: 'QQ 桥' }), ...r }
    },

    readLog(lines = 40) {
      return tailLog(home, Math.min(200, Math.max(10, toInt(lines, 40))))
    },

    /* ── 二维码 ───────────────────────────────────── */
    async qr() {
      const cfg = loadConfig(home)
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

    /* ── 重启 / 铺文件 ────────────────────────────── */
    async restart(why = '设置页请求') {
      const r = await sup.restart(why)
      return { ok: Boolean(r), process: sup.info() }
    },

    /** 只给测试用：确认 seedFiles 在这套参数下能铺出三份文件 */
    seed(initial) { return seedFiles(home, normalize(initial ?? {})) },

    /** 只给测试用：群策略默认值（前端显示「继承默认」的提示要用） */
    defaults() { return DEFAULTS },
  }
}
