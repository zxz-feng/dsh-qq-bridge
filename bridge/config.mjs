/**
 * bridge/config.mjs —— QQ 桥的配置（读写 + 钳位 + 首次铺默认值）
 * ============================================================================
 * 三份文件，各管一摊，都放在插件家目录：
 *   config.json          连接参数、模式、LLM、路径、自检间隔（本文件管）
 *   allowlist.json       私聊白名单 { self, friends:{qq:{label,enabled}} }
 *   group-allowlist.json 群策略（每群覆盖 + defaults，字段很多，原样保留）
 *
 * 为什么 allowlist / group-allowlist 不并进来：
 *   它们是要人手改的大块（尤其群策略 20 多个字段），单独成文件更好改、更好备份，
 *   改完即时生效（bridge 每轮都重读）。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from '../lib/home.mjs'

export const DEFAULTS = {
  enabled: true,
  onebot: { url: 'ws://127.0.0.1:3001', token: '' },
  mode: 'auto',
  media: { dir: '', cqDir: '' },
  python: { bili: '', asr: '', cred: '' },
  llm: {
    baseUrl: '',
    apiKey: '',
    models: ['deepseek-v4.1-flash', 'hy3', 'deepseek-v4-pro'],
    visionModel: '',
  },
  behavior: { debounceMinSec: 3, debounceMaxSec: 10 },
  napcat: { qrUrl: '', webui: '', token: '' },
  selfHeal: { everyMin: 5, autoRestart: true },
  control: { port: 17902, host: '127.0.0.1' },
}

export const EMPTY_ALLOWLIST = {
  self: '',
  friends: {},
  _note: '只处理 friends 里的 QQ 号私聊；self 是自己账号，用于过滤自己发出的消息。',
}

export const EMPTY_GROUP_CFG = {
  private: {
    _说明: '私聊策略：一对一有问必答，命令与群里完全一致',
    enabled: true,
    dryRun: false,
    replyProb: 1,
    coldProb: 0,
    dailyActive: 999,
    dailyTotal: 2000,
    cooldownSec: 0,
    hardCooldownSec: 0,
    memberCooldownMin: 0,
    quietHours: [],
  },
  _说明: '群聊白名单与策略。enabled=false 立即停用；dryRun=true 只生成不发送。',
  groups: {},
  defaults: {
    enabled: true,
    dryRun: true,
    replyProb: 0.02,
    coldProb: 0.08,
    coldAfterMin: 30,
    dailyActive: 3,
    dailyTotal: 100,
    voicePerDay: 20,
    fullSongPerDay: 5,
    fullSongMaxSeg: 12,
    searchPerDay: 20,
    quietHours: [2, 9],
    cooldownSec: 60,
    memberCooldownMin: 5,
    hardCooldownSec: 3,
    spamThreshold: 8,     // 60 秒内多少条算刷屏
    spamSeconds: 600,     // 判定刷屏后静默多久（对骂场景可调小）
    admin: { mute: true, muteMaxSec: 300, kick: false, recallSelf: true },
    ownerUins: [],
    ignoreUins: [],
    selfNick: ['小鲸鱼'],
    softIgnorePending: true,
  },
  _note: '加群时在 groups 里写 {"群号": {"label": "测试群"}}，其余继承 defaults。',
}

export const paths = {
  config: (home) => join(home, 'config.json'),
  allow: (home) => join(home, 'allowlist.json'),
  group: (home) => join(home, 'group-allowlist.json'),
}

function num(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}
function str(v, dflt = '', max = 400) {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, max) : dflt
}
function arr(v) {
  if (!Array.isArray(v)) return []
  return v.filter((x) => x !== null && x !== undefined && x !== '').map((x) => String(x).trim()).filter(Boolean)
}

export function normalize(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULTS
  const llm = { ...d.llm, ...(r.llm ?? {}) }
  const b = { ...d.behavior, ...(r.behavior ?? {}) }
  const out = {
    enabled: r.enabled !== false,
    onebot: {
      url: str(r.onebot?.url, d.onebot.url, 200),
      token: str(r.onebot?.token, '', 200),
    },
    mode: ['auto', 'draft', 'confirm', 'off'].includes(r.mode) ? r.mode : d.mode,
    media: { dir: str(r.media?.dir, '', 400), cqDir: str(r.media?.cqDir, '', 400) },
    python: {
      bili: str(r.python?.bili, '', 400),
      asr: str(r.python?.asr, '', 400),
      cred: str(r.python?.cred, '', 400),
    },
    llm: {
      baseUrl: str(llm.baseUrl ?? process.env.DSH_GATEWAY, '', 300),
      apiKey: str(llm.apiKey ?? process.env.WORKBUDDY_GATEWAY_API_KEY, '', 200),
      models: arr(llm.models).length ? arr(llm.models) : d.llm.models,
      visionModel: str(llm.visionModel, '', 80) || (arr(llm.models)[0] ?? d.llm.models[0]),
    },
    behavior: {
      debounceMinSec: num(b.debounceMinSec, 0, 120, d.behavior.debounceMinSec),
      debounceMaxSec: num(b.debounceMaxSec, 0, 300, d.behavior.debounceMaxSec),
    },
    napcat: {
      qrUrl: str(r.napcat?.qrUrl, '', 400),
      webui: str(r.napcat?.webui, '', 200),
      token: str(r.napcat?.token, '', 200),
    },
    selfHeal: {
      everyMin: num(r.selfHeal?.everyMin, 0, 120, d.selfHeal.everyMin),
      autoRestart: r.selfHeal?.autoRestart !== false,
    },
    control: {
      port: num(r.control?.port, 1024, 65535, d.control.port),
      host: str(r.control?.host, d.control.host, 40),
    },
  }
  if (out.behavior.debounceMaxSec < out.behavior.debounceMinSec) {
    out.behavior.debounceMaxSec = out.behavior.debounceMinSec
  }
  return out
}

export function loadConfig(home) {
  return normalize(readJson(paths.config(home), {}))
}

export function saveConfig(home, patch = {}) {
  const cur = readJson(paths.config(home), {}) ?? {}
  const merged = {
    ...cur,
    ...patch,
    onebot: { ...(cur.onebot ?? {}), ...(patch.onebot ?? {}) },
    media: { ...(cur.media ?? {}), ...(patch.media ?? {}) },
    python: { ...(cur.python ?? {}), ...(patch.python ?? {}) },
    llm: { ...(cur.llm ?? {}), ...(patch.llm ?? {}) },
    behavior: { ...(cur.behavior ?? {}), ...(patch.behavior ?? {}) },
    napcat: { ...(cur.napcat ?? {}), ...(patch.napcat ?? {}) },
    selfHeal: { ...(cur.selfHeal ?? {}), ...(patch.selfHeal ?? {}) },
    control: { ...(cur.control ?? {}), ...(patch.control ?? {}) },
  }
  const next = normalize(merged)
  writeJson(paths.config(home), next)
  return next
}

/**
 * 首次启用：把三份文件都铺出来（白名单是空的 = 谁都不回）
 * @param {object} [initial] 首次的 config.json 初值（来自插件 Config / 调用方）
 *   ⚠️ 必须能传：不传就会铺一份 `enabled: true` 的，于是"我只想装上看一眼"
 *      的冒烟测试会真的去连 OneBot（踩过一次：起了个游离子进程）。
 */
export function seedFiles(home, initial) {
  const made = []
  if (!existsSync(paths.config(home))) { writeJson(paths.config(home), normalize(initial ?? {})); made.push('config.json') }
  if (!existsSync(paths.allow(home))) { writeJson(paths.allow(home), EMPTY_ALLOWLIST); made.push('allowlist.json') }
  if (!existsSync(paths.group(home))) { writeJson(paths.group(home), EMPTY_GROUP_CFG); made.push('group-allowlist.json') }
  return made
}

export function loadAllowlist(home) {
  const a = readJson(paths.allow(home), null)
  if (!a) return { ...EMPTY_ALLOWLIST }
  return { self: String(a.self ?? ''), friends: a.friends ?? {}, _note: a._note }
}

export function saveAllowlist(home, patch = {}) {
  const cur = loadAllowlist(home)
  const next = {
    self: patch.self !== undefined ? String(patch.self) : cur.self,
    friends: patch.friends && typeof patch.friends === 'object'
      ? { ...cur.friends, ...patch.friends }
      : (patch.replaceFriends && typeof patch.replaceFriends === 'object' ? patch.replaceFriends : cur.friends),
    _note: cur._note ?? EMPTY_ALLOWLIST._note,
  }
  writeJson(paths.allow(home), next)
  return next
}

export function loadGroupCfg(home) {
  return readJson(paths.group(home), null) ?? { ...EMPTY_GROUP_CFG }
}

export function saveGroupCfg(home, patch = {}) {
  const cur = loadGroupCfg(home)
  // ⚠️ 每个群要**逐字段合并**，不能整块替换：设置页是「只发改动的那几项」，
  //    整块替换会把上一次改的 label / replyProb 一起冲掉（2026-10-29 踩到）。
  const mergedGroups = { ...(cur.groups ?? {}) }
  for (const [gid, v] of Object.entries(patch.groups ?? {})) {
    if (!v || typeof v !== 'object') continue
    const prev = mergedGroups[gid] ?? {}
    mergedGroups[gid] = {
      ...prev,
      ...v,
      ...(prev.admin || v.admin ? { admin: { ...(prev.admin ?? {}), ...(v.admin ?? {}) } } : {}),
    }
  }
  const next = {
    ...cur,
    ...(patch.groups ? { groups: mergedGroups } : {}),
    ...(patch.defaults ? { defaults: { ...(cur.defaults ?? {}), ...patch.defaults } } : {}),
    ...(patch.replaceGroups ? { groups: patch.replaceGroups } : {}),
  }
  writeJson(paths.group(home), next)
  return next
}

/** 把配置翻译成子进程里那些模块认的环境变量（它们在 import 时就读） */
/**
 * 从 $DSH_HOME/voice/settings.json 取本地 /sing 地址，喂给桥的子进程。
 * 读不到就当没配 —— 点歌照旧放原曲，不会因为换声把语音整条弄没。
 */
function singEnv() {
  try {
    const base = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh')
    const f = join(base, 'voice', 'settings.json')
    if (!existsSync(f)) return {}
    const s = JSON.parse(readFileSync(f, 'utf8'))
    const url = String(s.singUrl ?? '').trim()
    if (!url) return {}
    return { SING_URL: url, SING_PITCH: String(Number(s.rvcPitch ?? 0)) }
  } catch { return {} }
}

export function envFor(cfg, home) {
  const env = {
    HOME_DIR: home,
    GROUP_CFG: paths.group(home),
    ALLOW_CFG: paths.allow(home),
    CONTROL_PORT: String(cfg.control.port),
    OB_URL: cfg.onebot.url,
    OB_TOKEN: cfg.onebot.token,
    QQ_MODE: cfg.mode,
    DEBOUNCE_MIN: String(cfg.behavior.debounceMinSec * 1000),
    DEBOUNCE_MAX: String(cfg.behavior.debounceMaxSec * 1000),
    DSH_GATEWAY: cfg.llm.baseUrl || process.env.DSH_GATEWAY || 'http://127.0.0.1:8327/v1',
    WORKBUDDY_GATEWAY_API_KEY: cfg.llm.apiKey || process.env.WORKBUDDY_GATEWAY_API_KEY || 'local',
    QQ_MODELS: cfg.llm.models.join(','),
    VISION_MODEL: cfg.llm.visionModel,
    STORE_DIR: join(home, 'store'),
    CONTEXTS_DIR: join(home, 'contexts'),
    // 她自己的嗓子唱：地址放在**语音插件**的设置里（settings.json 的 singUrl），
    // 不在这里重复一份配置，免得两处不一致
    ...singEnv(),
  }
  if (cfg.media.dir) env.MEDIA_DIR = cfg.media.dir
  if (cfg.media.cqDir) env.CQ_MEDIA = cfg.media.cqDir
  if (cfg.python.bili) env.BILI_PY = cfg.python.bili
  if (cfg.python.asr) env.BILI_PY_ASR = cfg.python.asr
  if (cfg.python.cred) env.BILI_CRED = cfg.python.cred
  return env
}
