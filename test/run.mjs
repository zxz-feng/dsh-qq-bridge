#!/usr/bin/env node
/**
 * test/run.mjs —— 零 token 离线测试（不连 QQ、不连模型）
 * ============================================================================
 * 跑：`npm test`
 * 覆盖：配置钳位 / 决策器（什么时候闭嘴）/ CQ 码解析 / 路径映射 / 人设组装
 *
 * 决策器那几条是重点：群聊里最贵的错误不是"说错话"，是"该闭嘴时说话"
 * 和"被叫到却不吭声"。这些都是纯规则，所以能在没账号的机器上验。
 * ============================================================================
 */
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { splitVersion } from '../bridge/group/voice.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import 那些模块**之前**设好环境变量：它们 import 时就读
const HOME = mkdtempSync(join(tmpdir(), 'qqbridge-'))
process.env.STORE_DIR = join(HOME, 'store')
process.env.CONTEXTS_DIR = join(HOME, 'contexts')
process.env.MEDIA_DIR = join(HOME, 'media')
process.env.CQ_MEDIA = '/app/napcat/config/media'
process.env.GROUP_CFG = join(HOME, 'group-allowlist.json')
process.env.PERSONA_DIR = join(HOME, 'persona')

const { normalize, DEFAULTS, envFor, seedFiles, loadAllowlist, saveAllowlist, loadGroupCfg, saveGroupCfg } = await import('../bridge/config.mjs')
const { decide, inQuietHours } = await import('../bridge/group/decide.mjs')
const { parseCQ } = await import('../bridge/cq-parser.mjs')
const { parseCommand, parseLookup, cleanLookupArg } = await import('../bridge/group/commands.mjs')
const { getStyle, setStyle, styleBlock, styleBias, styleShortPersona, listStyles, resolveStyle, parseStyle } = await import('../bridge/group/style.mjs')
const { policyFor, loadConfig: loadGroupCfgRouter } = await import('../bridge/group/router.mjs')
const { toFileUrl, toContainerPath, HOST_MEDIA, CQ_MEDIA } = await import('../bridge/group/paths.mjs')
const { fullPersona, shortPersona, personaVersion, personaDir } = await import('../bridge/persona-core.mjs')
const groupPersona = await import('../bridge/group/persona.mjs')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`) }
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`)
}

// ── 1. 配置 ───────────────────────────────────────────
console.log('\n【配置】')
{
  const c = normalize({})
  eq('默认模式 auto', c.mode, 'auto')
  eq('默认 OneBot 端口 3001', c.onebot.url, 'ws://127.0.0.1:3001')
  eq('默认没有 napcat 二维码来源', c.napcat.qrUrl, '')

  const bad = normalize({ mode: '乱写', control: { port: 1 }, selfHeal: { everyMin: 999 }, llm: { models: [] } })
  eq('非法模式回落', bad.mode, 'auto')
  ok('端口钳到 >=1024', bad.control.port === 1024)
  ok('自检间隔上限 120', bad.selfHeal.everyMin === 120)
  ok('模型列表空了回落默认', bad.llm.models.length === DEFAULTS.llm.models.length)

  const made = seedFiles(HOME)
  ok('首次铺三份文件', made.length === 3, JSON.stringify(made))
  ok('allowlist 铺出来了', existsSync(join(HOME, 'allowlist.json')))

  const a = saveAllowlist(HOME, { self: '123456', friends: { '20002000': { label: '主人', enabled: true } } })
  eq('白名单能写', Object.keys(a.friends), ['20002000'])
  const g = saveGroupCfg(HOME, { groups: { '123456789': { label: '主群', dryRun: false } } })
  ok('群策略能写', g.groups['123456789'].label === '主群')

  // 逐字段合并（设置页只发改动项；整块替换会把上次的改动冲掉）
  saveGroupCfg(HOME, { groups: { '123456789': { replyProb: 0.5 } } })
  const g2 = saveGroupCfg(HOME, { groups: { '123456789': { dailyActive: 7 } } })
  eq('群策略是逐字段合并，不是整块替换', g2.groups['123456789'], { label: '主群', dryRun: false, replyProb: 0.5, dailyActive: 7 })
  saveGroupCfg(HOME, { groups: { '123456789': { admin: { muteMaxSec: 120 } } } })
  const g3 = saveGroupCfg(HOME, { groups: { '123456789': { admin: { mute: false } } } })
  ok('admin 子对象也是合并（muteMaxSec 没被冲掉）', g3.groups['123456789'].admin.mute === false && g3.groups['123456789'].admin.muteMaxSec === 120)

  const env = envFor(loadConfigByFile(), HOME)
  ok('env 里有 STORE_DIR', String(env.STORE_DIR).endsWith('store'))
  ok('env 里模型链是逗号串', env.QQ_MODELS.includes(','))
}
function loadConfigByFile() { return normalize({}) }

// ── 2. 决策器 ─────────────────────────────────────────
console.log('\n【决策器（零 token）】')
{
  const policy = { replyProb: 0.02, coldProb: 0.08, dailyActive: 3, dailyTotal: 100, cooldownSec: 60, quietHours: [2, 9], selfNick: ['小鲸鱼'], coldAfterMin: 30 }
  const noon = Math.floor(new Date('2026-10-28T14:00:00+08:00').getTime() / 1000)
  const night = Math.floor(new Date('2026-10-28T03:00:00+08:00').getTime() / 1000)

  const at = decide({ text: '@小鲸鱼 在吗', atMe: true, policy, now: noon })
  ok('被 @ 必回（哪怕概率 2%）', at.speak === true, JSON.stringify(at))
  ok('被 @ 算硬触发', at.hard === true)

  const named = decide({ text: '小鲸鱼你今天话好少', policy, now: noon })
  ok('叫名字也算硬触发', named.hard === true)
  ok('叫名字必回', named.speak === true)

  const quiet = decide({ text: '小鲸鱼在吗', atMe: true, policy, now: night })
  ok('静默时段被 @ 也不说话', quiet.speak === false, JSON.stringify(quiet))

  const plain = decide({ text: '哈哈哈哈', policy, now: noon, gapSec: 5 })
  ok('纯闲聊大概率不说', plain.speak === false)

  const cold = decide({ text: '哈哈哈哈', policy, now: noon, gapSec: 3600 })
  ok('冷场时更可能插一句（分数更高）', cold.score > plain.score, `${plain.score} → ${cold.score}`)

  // 刷屏静默 vs 硬触发（2026-10-29 线上故障的回归测试）
  const locked = { spamUntil: noon + 600, affinity: 0 }
  const quiet1 = decide({ text: '随便说句', policy, now: noon, member: locked })
  ok('刷屏静默中：普通消息不理', quiet1.speak === false, JSON.stringify(quiet1))
  const quiet2 = decide({ text: '@小鲸鱼 菜', atMe: true, policy, now: noon, member: locked })
  ok('decide 本身会拦（所以 router 必须给硬触发清零）', quiet2.speak === false)
  const shout = decide({ text: '@小鲸鱼 菜', atMe: true, policy, now: noon, member: { ...locked, spamUntil: 0 } })
  ok('清零后被 @ 必须回', shout.speak === true, JSON.stringify(shout))

  ok('跨零点静默 [23,7] 认 1 点', inQuietHours(1, [23, 7]) === true)
  ok('跨零点静默 [23,7] 认 12 点', inQuietHours(12, [23, 7]) === false)
  ok('普通区间 [2,9] 认 5 点', inQuietHours(5, [2, 9]) === true)
  ok('start==end 视为不静默', inQuietHours(5, [5, 5]) === false)
}

// ── 2.5 命令：孙吧开关 / 找资源 ─────────────────────────
console.log('\n【命令解析】')
{
  // 2026-10-30 踩坑：点歌命令把口语当歌名，连放两条 vlog（「唱下雨爱这首歌」→ 搜「下雨爱这首歌」）
  eq('唱下雨爱这首歌 → 雨爱', parseCommand('唱下雨爱这首歌')?.arg, '雨爱')
  eq('来一首《雨爱》 → 雨爱（find 不能抢走）', parseCommand('来一首《雨爱》')?.arg, '雨爱')
  eq('放一首雨爱 → 雨爱', parseCommand('放一首雨爱')?.arg, '雨爱')
  eq('点歌起风了 → 起风了', parseCommand('点歌起风了')?.arg, '起风了')
  // 2026-10-31：「女版的忘情牛肉面」剥掉版本词后剩个「的」，回复成了「给你放 的忘情牛肉面」
  eq('女版的忘情牛肉面 → 歌名干净', splitVersion('女版的忘情牛肉面').kw, '忘情牛肉面')
  eq('女版 忘情牛肉面 → 认出版本', splitVersion('女版 忘情牛肉面').version, 'female')
  eq('男版的雨爱 → 认出版本', splitVersion('男版的雨爱').version, 'male')
  eq('普通点歌没有版本', splitVersion('忘情牛肉面').version, '')
  eq('完整版要认出来', parseCommand('唱 雨爱 完整版')?.full, true)
  eq('「自己唱完整版雨爱」也要认（2026-10-31 主人踩到）', parseCommand('自己唱完整版雨爱')?.arg, '雨爱')
  eq('「你自己唱一下雨爱这首歌」也要认', parseCommand('你自己唱一下雨爱这首歌')?.arg, '雨爱')
  eq('闲话不能被当歌名', parseCommand('放开我的token要炸了'), null)
  eq('开孙吧模式', parseCommand('开孙吧模式')?.kind, 'style')
  eq('开个孙吧（带量词也要认）', parseCommand('开个孙吧')?.kind, 'style')
  eq('关掉孙吧（不能认成开）', parseCommand('关掉孙吧')?.kind, 'style')
  eq('孙吧 → 切/查风格', parseCommand('孙吧')?.kind, 'style')
  eq('#风格 傲娇 → 切风格，参数留住', parseCommand('#风格 傲娇')?.arg?.trim(), '傲娇')
  eq('换个风格 → 风格命令', parseCommand('换个风格')?.kind, 'style')
  eq('切成人格 → 风格命令', parseCommand('切成冷淡')?.kind, 'style')
  eq('放首晴天 → 点歌', parseCommand('放首晴天')?.kind, 'sing')

  // 找资源：谁都能用，但必须真的是在找东西
  ok('帮X找个黄油 → 认', parseLookup('肥鱼大小姐，帮lcarus找个黄油来，要缩略图') !== null)
  eq('关键词被洗成"黄油"', cleanLookupArg(parseLookup('给lcarus找个黄油来，要缩略图')?.arg), '黄油')
  eq('量词被剥掉（张壁纸→壁纸）', cleanLookupArg('张壁纸'), '壁纸')
  eq('附加要求被剥掉', cleanLookupArg('本子 要封面'), '本子')
  ok('推荐个黄油 → 认', parseLookup('推荐个黄油') !== null)
  ok('找个galgame → 认', parseLookup('找个galgame') !== null)
  ok('闲聊不误伤（这游戏真好玩）', parseLookup('这游戏真好玩') === null)
  ok('日常请求不误伤（帮我找个借口）', parseLookup('帮我找个借口') === null)
  ok('没有资源词不认（找个对象）', parseLookup('找个对象') === null)
}

// ── 2.6 风格档（注册表版，2026-10-29）─────────────────────
console.log('\n【风格档】')
{
  const GID = '999001'

  // 目录即注册表：自带五个档
  const ids = listStyles().map((x) => x.id)
  for (const want of ['normal', 'sunbar', 'tsundere', 'cold', 'genki']) {
    ok(`自带档 ${want}`, ids.includes(want), ids.join(','))
  }
  eq('normal 排第一', listStyles()[0].id, 'normal')

  // 认名字 / 别名 / 模糊说法
  eq('孙吧模式 → sunbar', resolveStyle('孙吧模式'), 'sunbar')
  eq('傲娇 → tsundere', resolveStyle('傲娇'), 'tsundere')
  eq('高冷 → cold', resolveStyle('高冷'), 'cold')
  eq('有精神 → genki', resolveStyle('元气'), 'genki')
  eq('认不出就 null', resolveStyle('量子力学'), null)
  eq('乱切不会写坏状态', setStyle(GID, '量子力学'), null)

  // 解析器：能读 front matter、例句、词表、bias
  const parsed = parseStyle(`# 测试档\n---\nid: t1\nname: 测试\nshort: 一句话\nbias: replyProbMul=3,cooldownSec=15\n---\n总述一句。\n## 语气\n- 硬\n## 例句\n- 例一\n- 例二\n## 词表\n- 词一`)
  eq('id 读得到', parsed.id, 't1')
  eq('short 读得到', parsed.short, '一句话')
  eq('bias 读得到', parsed.bias.replyProbMul, 3)
  eq('bias 第二项', parsed.bias.cooldownSec, 15)
  eq('例句 2 条', parsed.examples.length, 2)
  eq('词表 1 条', parsed.words.length, 1)
  ok('总述进 guide', parsed.guide.includes('总述一句'))
  ok('语气小节进 guide', parsed.guide.includes('硬'))

  // 正常档什么都不注入
  setStyle(GID, 'normal', { by: 'test' })
  eq('默认是正常', getStyle(GID).style, 'normal')
  eq('正常档不注入任何东西', styleBlock(GID), '')
  eq('正常档不做偏置', styleBias(GID).replyProbMul, 1)
  eq('正常档不改精简人设', styleShortPersona(GID), '')

  // 孙吧：短块要短、长块要长
  setStyle(GID, 'sunbar', { by: 'test', intensity: 'mid' })
  eq('开得起来', getStyle(GID).style, 'sunbar')
  const short = styleBlock(GID)
  const full = styleBlock(GID, { full: true })
  ok('短块提到孙吧', short.includes('孙吧'))
  ok('短块够省（<200 字）', short.length < 200, String(short.length))
  ok('长块比短块长很多', full.length > short.length * 2, `${short.length} vs ${full.length}`)
  ok('长块有雷区说明（防举报封号）', full.includes('雷区') || full.includes('不碰'))
  ok('孙吧档精简人设不再说"温柔、不阴阳"', !styleShortPersona(GID).includes('不阴阳'))

  const bias = styleBias(GID)
  ok('孙吧档概率放大（>1）', bias.replyProbMul > 1)
  ok('孙吧档放宽刷屏阈值', bias.spamThreshold > 8)
  ok('孙吧档缩短冷却', Number(bias.policy.cooldownSec) < 60)
  setStyle(GID, 'sunbar', { by: 'test', intensity: 'heavy' })
  ok('重档比中档更凶', styleBias(GID).replyProbMul > bias.replyProbMul)

  // 每档都得能开、能注入、能关
  for (const id of ['tsundere', 'cold', 'genki']) {
    setStyle(GID, id, { by: 'test' })
    eq(`${id} 切得过去`, getStyle(GID).style, id)
    ok(`${id} 短块非空`, styleBlock(GID).length > 0)
    ok(`${id} 有自己的精简人设`, styleShortPersona(GID).length > 0)
  }
  ok('元气档更爱说话', styleBias(GID).replyProbMul > 1)
  setStyle(GID, 'cold', { by: 'test' })
  ok('冷淡档不爱说话', styleBias(GID).replyProbMul < 1)

  setStyle(GID, 'normal', { by: 'test' })
  eq('关得掉', styleBlock(GID), '')
}

// ── 2.7 群策略必须真的读得到（2026-10-29 静默故障的回归测试）──
console.log('\n【群策略读取】')
{
  // 曾经的 bug：router 里写死 `DIR + '../group-allowlist.json'`，插件里那个路径不存在，
  // JSON.parse 抛异常 → 返回 { groups: {} } → policyFor 全 null → **群消息被静默丢弃**
  // （连日志都没有，表现就是"群里完全没反应"）。
  saveGroupCfg(HOME, { groups: { '123456789': { label: '测试群', dryRun: true } } })
  ok('GROUP_CFG 指向的文件被 router 读到了', Object.keys(loadGroupCfgRouter()?.groups ?? {}).includes('123456789'))
  ok('白名单里的群拿得到策略', policyFor('123456789') !== null)
  eq('policyFor 会继承 defaults（dryRun 取群里的）', policyFor('123456789')?.dryRun, true)
  ok('不在白名单的群返回 null（该忽略就忽略）', policyFor('999999') === null)
  eq('enabled:false 的群返回 null', (() => {
    saveGroupCfg(HOME, { groups: { '222222': { enabled: false } } })
    return policyFor('222222')
  })(), null)
}

// ── 3. CQ 码 ──────────────────────────────────────────
console.log('\n【CQ 码解析】')
{
  const t = parseCQ('你好啊')
  eq('纯文本', t.text, '你好啊')

  const withAt = parseCQ('[CQ:at,qq=10001000] 在吗')
  ok('解析出 at', Array.isArray(withAt.at) && withAt.at.includes('10001000'))

  const withImg = parseCQ('[CQ:image,file=abc.jpg,url=https://x/y.jpg]')
  ok('解析出图片', withImg.images.length === 1)

  const withFace = parseCQ('笑死[CQ:face,id=178]')
  ok('表情码被翻译或至少不炸', typeof withFace.text === 'string')
}

// ── 4. 路径映射 ───────────────────────────────────────
console.log('\n【路径映射】')
{
  const p = join(HOST_MEDIA, 'voice', 'a.mp3')
  eq('宿主机路径 → 容器路径', toContainerPath(p), `${CQ_MEDIA}/voice/a.mp3`)
  eq('CQ 码用 file:// + 容器路径', toFileUrl(p), `file://${CQ_MEDIA}/voice/a.mp3`)
  ok('媒体目录被建出来了', existsSync(HOST_MEDIA))
}

// ── 5. 人设 ───────────────────────────────────────────
console.log('\n【人设（QQ 群版）】')
{
  const dir = personaDir()
  ok('人设目录铺好了', existsSync(join(dir, 'renshe.txt')))
  const full = groupPersona.fullPersona()
  const short = groupPersona.shortPersona()
  ok('完整人设带 QQ 群差异（公开 AI 身份）', full.includes('AI') || full.includes('群'), full.slice(0, 60))
  ok('精简人设很短', short.length < 260, `实际 ${short.length}`)
  ok('精简比完整短很多', short.length * 2 < full.length)
  ok('人设指纹 12 位', personaVersion().length === 12)
  ok('锚定句带身份', groupPersona.ANCHOR.includes('小鲸鱼'))
}

// ── 宿主小门（桥 → DSH 的唯一上行通道）────────────────
//
// 这里测的是「协议」不是「搜索质量」：小门能不能起、token 认不认、没有
// 搜索 provider 时会不会老实说 NO_PROVIDER、桥那边拿不到会不会安静返回 null。
{
  const { startHostApi } = await import('../lib/host-api.mjs')

  const fakeWeb = {
    async search({ query, maxResults }) {
      return {
        sources: Array.from({ length: maxResults }, (_, i) => ({
          url: `https://example.com/${i}`, title: `标题${i}`, snippet: `摘要${i}`,
        })),
        truncated: false,
      }
    },
  }

  // ① 有 provider
  const api = await startHostApi({ ctx: { get: (k) => (k === 'web' ? fakeWeb : undefined) }, log: () => {} })
  ok('小门起在 127.0.0.1', /^http:\/\/127\.0\.0\.1:\d+$/.test(api.url), api.url)
  ok('小门报告 web 可用', api.hasWeb() === true)

  const auth = { 'content-type': 'application/json', authorization: `Bearer ${api.token}` }
  const ping = await (await fetch(`${api.url}/ping`, { headers: auth })).json()
  ok('ping 正常', ping.ok === true && ping.data.hasWeb === true)

  const sr = await (await fetch(`${api.url}/search`, {
    method: 'POST', headers: auth, body: JSON.stringify({ query: '雨爱 司凤', maxResults: 3 }),
  })).json()
  ok('search 回结果', sr.ok === true && sr.data.sources.length === 3)
  ok('search 字段齐全', sr.data.sources[0].url.startsWith('https://') && sr.data.sources[0].title === '标题0')

  const bad = await fetch(`${api.url}/search`, {
    method: 'POST', headers: { authorization: 'Bearer wrong-token' }, body: '{}',
  })
  ok('token 不对 → 401', bad.status === 401)

  const empty = await (await fetch(`${api.url}/search`, {
    method: 'POST', headers: auth, body: JSON.stringify({ query: '  ' }),
  })).json()
  ok('空 query → 400', empty.ok === false)

  // ② 桥那边：连真小门能拿到
  process.env.HOST_API_URL = api.url
  process.env.HOST_API_TOKEN = api.token
  const { hostSearch, hostAvailable } = await import('../bridge/group/hostsearch.mjs')
  ok('桥认得小门', hostAvailable() === true)
  const got = await hostSearch('随便搜搜', 2)
  ok('桥拿到搜索结果', Boolean(got) && got.sources.length === 2)
  ok('桥拿到 answer 字段（没有就是空串）', typeof got.answer === 'string')

  // ③ 宿主没装搜索 provider：老实说没有，桥返回 null 而不是抛错
  const api2 = await startHostApi({ ctx: { get: () => undefined }, log: () => {} })
  ok('没 provider 时小门照样起', Boolean(api2.url))
  ok('没 provider 时 hasWeb=false', api2.hasWeb() === false)
  const np = await (await fetch(`${api2.url}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${api2.token}` },
    body: JSON.stringify({ query: 'x' }),
  })).json()
  ok('没 provider → NO_PROVIDER', np.ok === false && np.code === 'NO_PROVIDER')

  // ④ 搜索抛错（比如没配 key）也不能让桥炸
  const api3 = await startHostApi({
    ctx: { get: () => ({ async search() { const e = new Error('没 key'); e.code = 'CREDENTIAL_MISSING'; throw e } }) },
    log: () => {},
  })
  const cf = await (await fetch(`${api3.url}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${api3.token}` },
    body: JSON.stringify({ query: 'x' }),
  })).json()
  ok('没 key → NO_CREDENTIAL（不是 500）', cf.ok === false && cf.code === 'NO_CREDENTIAL')

  api.close(); api2.close(); api3.close()
}

// ── 汇总 ──────────────────────────────────────────────
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail) { console.log(`失败项：${failures.join('、')}`); process.exit(1) }
console.log('全部通过（零 token，没连网、没连 QQ）')
