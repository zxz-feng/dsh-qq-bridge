#!/usr/bin/env node
/**
 * test/window.mjs —— 原文窗口 + prompt 组装（零 token、零网络）
 * ============================================================================
 * 为什么单独测：主人 2026-11-05 的原话是
 *   「不要省那点 token，我要能正常聊天、不会之前说了什么马上就忘」
 * 而当时的实际情况是 buildPrefix() 返回 12 个字符、窗口根本不存在。
 * 所以这里守三件事：
 *   ① 别人说过的话真的被记下来了（不管她说没说）
 *   ② 组 prompt 时三层都在，且顺序是 硬事实 → 摘要 → 刚才群里 → 当前这句
 *   ③ 当前这句不会在"刚才群里"重复出现（重复会让她以为对方说了两遍）
 * ============================================================================
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'qqwin-'))
process.env.DSH_HOME = HOME
process.env.QQ_WINDOW_DIR = join(HOME, 'win')
process.env.QQ_MEMORY_DIR = join(HOME, 'mem')

const win = await import('../bridge/group/window.mjs')
const memory = await import('../bridge/group/memory.mjs')

let pass = 0
let fail = 0
const bad = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) } else { fail += 1; bad.push(name); console.log(`  ❌ ${name} ${extra}`) }
}

const now = Math.floor(Date.now() / 1000)
const GID = '783599631'

// ── 1. 记下来 ────────────────────────────────────────────────
win.push({ gid: GID, id: 1, t: now - 300, uin: '111', name: 'maybe.7', text: '你是坤鱼吗', at: [] })
win.push({ gid: GID, id: 2, t: now - 200, uin: '340876685', name: '小鲸鱼', text: '你才坤鱼', self: true })
win.push({ gid: GID, id: 3, t: now - 100, uin: '222', name: '猎鹰', text: '出来挨骂', at: ['navi2-1猎鹰'] })
win.push({ gid: GID, id: 4, t: now - 50, uin: '333', name: '空话', text: '   ' })  // 空 → 不记

const list = win.load(GID)
ok('窗口记下了 3 条（空消息不记）', list.length === 3, `实际 ${list.length}`)
ok('字段完整（谁/说了什么/时间）', list[0].name === 'maybe.7' && list[0].text === '你是坤鱼吗' && list[0].t > 0)

// ── 2. 渲染成人话 ────────────────────────────────────────────
const text = win.render(list, { excludeId: 3, hours: 3, maxMsgs: 120 })
ok('渲染里出现别人说的话', text.includes('你是坤鱼吗'), text.slice(0, 80))
ok('她自己那句标成「小鲸鱼」', /小鲸鱼：你才坤鱼/.test(text))
ok('excludeId 排掉了当前这条', !text.includes('出来挨骂'), text)
ok('行首有时间 HH:MM:SS', /^\d\d:\d\d:\d\d /m.test(text))

// @ 对象要留着（不然她分不清在骂谁）
const t2 = win.render(win.load(GID), { hours: 3 })
ok('@ 对象留在行里', /→ @navi2-1猎鹰/.test(t2), t2)

// ── 3. 裁剪 ─────────────────────────────────────────────────
const old = [{ id: 'x', t: now - 5 * 3600, uin: '9', name: '古人', text: '很久以前' }, ...list]
ok('超过 N 小时的被丢掉', !win.render(old, { hours: 3 }).includes('很久以前'))
ok('hours 放宽又能看见', win.render(old, { hours: 6 }).includes('很久以前'))

const many = Array.from({ length: 50 }, (_, i) => ({ id: String(i), t: now - i, uin: '1', name: '甲', text: `第${i}条` }))
const cut = win.render(many, { maxMsgs: 10, hours: 48 })
// 数组是按写入顺序（旧→新）追加的，所以"最近 10 条"= 末尾 10 条
ok('maxMsgs 只留最近 10 条', cut.split('\n').length === 10 && cut.includes('第49条') && !cut.includes('第39条'), cut.slice(0, 60))

const long = Array.from({ length: 200 }, (_, i) => ({ id: String(i), t: now - i, uin: '1', name: '甲', text: `这是第${i}条比较长的消息内容` }))
const capped = win.render(long, { maxMsgs: 200, hours: 48, maxChars: 500 })
ok('字数上限从最旧的丢', capped.length <= 500 && capped.includes('这是第199条') && !capped.includes('这是第0条'), `len=${capped.length}`)

// ── 4. 磁盘不会无限长 ───────────────────────────────────────
for (let i = 0; i < 700; i += 1) win.push({ gid: 'big', id: i, t: now, uin: '1', name: '甲', text: `刷屏${i}` })
const bigList = win.load('big')
ok('磁盘折到 600 条以内', bigList.length <= 600, `实际 ${bigList.length}`)
ok('折掉的是最旧的（最新的还在）', bigList[bigList.length - 1].text === '刷屏699', bigList[bigList.length - 1]?.text)

// ── 5. 三层 prompt ──────────────────────────────────────────
mkdirSync(join(HOME, 'mem', 'qq', 'log'), { recursive: true })
writeFileSync(join(HOME, 'mem', 'qq', 'shared.md'), '- [11-05 · maybe.7] 他明天要考驾照\n')
writeFileSync(join(HOME, 'mem', 'qq', `${GID}.md`), '- 今天在聊坤鱼梗，猎鹰被点名\n')

const prefix = memory.buildPrefix({ platform: 'qq', chatKey: GID, personaText: '（人设）', who: 'maybe.7' })
ok('硬事实卡进了 prompt', prefix.includes('考驾照'), prefix.slice(0, 120))
ok('摘要进了 prompt', prefix.includes('坤鱼梗'))
ok('人设进了 prompt', prefix.includes('（人设）'))

const winBlock = `[刚才群里]\n${win.render(win.load(GID), { hours: 3, excludeId: 3 })}\n\n`
const prompt = `${prefix}${winBlock}${memory.formatTurn({ who: 'maybe.7', text: '你是坤鱼吗' })}\n`
const iFact = prompt.indexOf('考驾照')
const iSum = prompt.indexOf('坤鱼梗')
const iWin = prompt.indexOf('[刚才群里]')
const iCur = prompt.lastIndexOf('【maybe.7】')
ok('顺序：事实 → 摘要 → 刚才群里 → 当前', iFact < iSum && iSum < iWin && iWin < iCur, `${iFact},${iSum},${iWin},${iCur}`)
ok('当前这句在最后', prompt.trimEnd().endsWith('你是坤鱼吗'))
ok('当前这句没在窗口里重复', prompt.split('出来挨骂').length === 1)

// ── 6. 窗口真落盘了 ─────────────────────────────────────────
const raw = readFileSync(join(HOME, 'win', `${GID}.jsonl`), 'utf8')
ok('落盘是 JSONL（重启/换容器不丢）', raw.split('\n').filter(Boolean).length === 3)

console.log(`\n原文窗口：${pass} 通过 / ${fail} 失败`)
if (fail) { console.log('失败项：', bad.join('、')); process.exit(1) }
