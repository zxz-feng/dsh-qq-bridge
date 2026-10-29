#!/usr/bin/env node
/**
 * test/client.mjs —— 设置页浏览器半端的「冒烟渲染」（零 token、无浏览器、无 react）
 * ============================================================================
 * 为什么值得单独测：client.js 一旦有运行时错误，设置页那一栏会**整块空白**，
 * 而宿主日志里一个字都没有（报错在浏览器控制台）。这种错只有真点进去才看得见，
 * 所以这里用一个 40 行的假 React 把它渲染一遍：
 *
 *   · 校验自注册协议（__ModuleLoader__.load 的 id 必须等于包名）
 *   · 校验槽位注册（settings.section / id / order / label）
 *   · 真跑一遍 Panel 的函数体（所有 useState 都喂真数据，走完整棵树）
 *   · 关掉总开关时，下面的分区要真的被 data-qq-away 收起来
 *
 * 它抓不到样式问题（那得用眼睛），但能抓到「变量写错 / 属性名不对 / 空数组没兜住」。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`) }
}

/* ── 假 React：createElement 只造节点，useState 按队列发值 ── */
let queue = []
let qi = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => { const v = qi < queue.length ? queue[qi] : init; qi += 1; return [v, () => {}] },
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/* ── 迷你渲染器：函数组件就地调用；原生标签连属性一起吐出来（input 的 value 也要看得见） ── */
function attrs(props) {
  const out = []
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'children' || v === null || v === undefined || v === false) continue
    if (typeof v === 'function' || typeof v === 'object') continue
    out.push(v === true ? k : `${k}=${v}`)
  }
  return out.length ? ` ${out.join(' ')}` : ''
}
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => render(n)).join('')
  if (typeof node.type === 'function') {
    const props = { ...node.props }
    if (node.children.length) props.children = node.children.length === 1 ? node.children[0] : node.children
    return render(node.type(props))
  }
  return `<${node.type}${attrs(node.props)}>${node.children.map((c) => render(c)).join('')}</${node.type}>`
}

/* ── 假 window / document / slots ── */
let loaded = null
const styleEl = { setAttribute() {}, remove() {}, textContent: '' }
const document = { createElement: () => styleEl, head: { appendChild() {} } }
const window = { __ModuleLoader__: { load: (o) => { loaded = o } } }

new Function('window', 'document', SRC)(window, document)

console.log('\n【自注册协议】')
ok('调用了 __ModuleLoader__.load', Boolean(loaded))
ok('id 等于包名 dsh-qq-bridge', loaded?.id === 'dsh-qq-bridge', `实际=${loaded?.id}`)
ok('factory 是函数', typeof loaded?.factory === 'function')

const mod = loaded.factory((name) => (name === 'react' ? react : {}))
ok('返回 { inject, apply }', Boolean(mod?.apply) && Array.isArray(mod?.inject))
ok('inject 要 slots', (mod.inject || []).includes('slots'))

/* ── 槽位注册 ── */
let registered = null
const slots = {
  inject: (_name, fn) => fn(),
  register: (meta, comp) => { registered = { meta, comp }; return () => {} },
}
const ctx = {
  get: (k) => (k === 'slots' ? slots : undefined),
  slots,
  effect: (fn) => { const d = fn(); return () => { try { if (typeof d === 'function') d() } catch { /* 忽略 */ } } },
}
mod.apply(ctx)

console.log('\n【槽位】')
ok('注册进 settings.section', registered?.meta?.name === 'settings.section')
ok('id=qq-bridge', registered?.meta?.id === 'qq-bridge')
ok('order=40（排在刷B站后面）', registered?.meta?.order === 40)
ok('左侧导航叫「QQ 小鲸鱼」', registered?.meta?.label === 'QQ 小鲸鱼')
ok('组件是函数', typeof registered?.comp === 'function')

/* ── 真数据渲染一遍 ── */
const status = {
  ok: true, enabled: true, home: '/root/dsh/qq-bridge',
  process: { state: 'up', pid: 1234, restarts: 0 },
  bridge: {
    connected: true, self: '340876685', today: 4, stickers: 165,
    control: { port: 17902 }, mode: 'auto',
  },
  config: { enabled: true, onebot: { url: 'ws://127.0.0.1:3001' }, mode: 'auto', llm: { models: ['deepseek-v4.1-flash'] }, napcat: { webui: 'http://127.0.0.1:6099' } },
}
const config = status.config
const groups = {
  ok: true, bridgeUp: true,
  defaults: { replyProb: 0.02, coldProb: 0.08, memberCooldownMin: 5, quietHours: [2, 9] },
  available: [
    { id: 'normal', name: '正常', aliases: ['正常'] },
    { id: 'sunbar', name: '孙吧', aliases: ['孙吧模式'] },
    { id: 'tsundere', name: '傲娇', aliases: ['傲娇'] },
  ],
  groups: [{
    gid: '783599631', label: '最好的△洲', enabled: true, dryRun: false,
    style: { style: 'sunbar', intensity: 'mid', since: 0 },
    effective: {
      replyProb: 0.02, coldProb: 0.08, dailyActive: 3, dailyTotal: 100,
      cooldownSec: 60, memberCooldownMin: 5, quietHours: [2, 9],
      voicePerDay: 20, fullSongPerDay: 5, fullSongMaxSeg: 12,
    },
  }],
}
const friends = { self: '340876685', friends: { '1807430990': { label: '主人', enabled: true } } }

// Panel 的 useState 顺序：st / cfg / grp / fr / busy / msg / tail / report / qr / newUin / newLabel
// 然后是 GroupCard 的 d
queue = [status, config, groups, friends, '', null, '', '', '', '', '', {}]
qi = 0
let out = ''
let err = null
try { out = render(registered.comp({})) } catch (e) { err = e }

console.log('\n【渲染】')
ok('渲染不抛异常', !err, err ? String(err?.stack || err).slice(0, 400) : '')
ok('画出了「现在什么状态」', out.includes('现在什么状态'))
ok('OneBot 状态是「已连」', out.includes('OneBot 已连'))
ok('显示号 / 今日条数 / 贴纸数', out.includes('340876685') && out.includes('今天 4 条') && out.includes('贴纸 165'))
ok('总开关在', out.includes('让小鲸鱼上线'))
ok('连接分区（OneBot 地址）', out.includes('ws://127.0.0.1:3001'))
ok('群卡片画出群号', out.includes('783599631'))
ok('群名也画了', out.includes('最好的△洲'))
ok('风格下拉有三个档', out.includes('正常（normal）') && out.includes('孙吧（sunbar）') && out.includes('傲娇（tsundere）'))
ok('接话概率显示成 2%（不是 0.02）', out.includes('2') && !out.includes('0.02%'))
ok('演练/真发标记', out.includes('真发'))
ok('白名单画出好友', out.includes('1807430990') && out.includes('主人'))
ok('运维按钮齐全', out.includes('跑一遍自检') && out.includes('看日志') && out.includes('重启桥'))
ok('页脚有家目录', out.includes('/root/dsh/qq-bridge'))

/* ── 关掉总开关：下面要真收起来 ── */
queue = [{ ...status, enabled: false }, { ...config, enabled: false }, groups, friends, '', null, '', '', '', '', '', {}]
qi = 0
let outOff = ''
try { outOff = render(registered.comp({})) } catch (e) { outOff = 'ERR:' + String(e?.message ?? e) }
ok('关掉后渲染不炸', !outOff.startsWith('ERR:'), outOff.slice(0, 200))
ok('关掉后分区带上 data-qq-away（CSS 会藏）', (outOff.match(/data-qq-away/g) || []).length >= 3)
ok('关掉后仍能看到总开关（不然打不开了）', outOff.includes('让小鲸鱼上线'))

/* ── 桥没跑：不许崩 ── */
queue = [
  { ...status, bridge: { error: 'bridge 没在跑（state=idle）' }, process: { state: 'idle' } },
  config,
  { ok: false, groups: [], available: [], defaults: {}, bridgeUp: false },
  { self: '', friends: {} },
  '', null, '', '', '', '', '', {},
]
qi = 0
let outDown = ''
try { outDown = render(registered.comp({})) } catch (e) { outDown = 'ERR:' + String(e?.message ?? e) }
ok('桥没跑时渲染不炸', !outDown.startsWith('ERR:'), outDown.slice(0, 200))
ok('桥没跑时给出原因', outDown.includes('桥没响应'))
ok('桥没跑时白名单显示「空的」', outDown.includes('白名单是空的'))
ok('桥没跑时群列表给提示', outDown.includes('一个群都没配'))

console.log(`\n===== 设置页冒烟：${pass} 通过 / ${fail} 失败 =====`)
if (fail) { console.log('失败项：' + failures.join('、')); process.exitCode = 1 }
