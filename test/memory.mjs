/**
 * 三层记忆的纯函数测试。用临时目录，别碰真记忆。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.QQ_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'qqmem-'))
const memory = await import('../bridge/group/memory.mjs')

let pass = 0
let fail = 0
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`) } else { fail += 1; console.log(`  ✗ ${m}`) } }

console.log('===== 记忆 =====')
ok(memory.buildPrefix({ platform: 'qq', chatKey: 'g1' }) === '', '空记忆 → 不注入任何东西')

const line = memory.harvestFacts({ platform: 'qq', who: '好吃的非洲鸳鸯', text: '我下周三要去面试，记住' })
ok(typeof line === 'string' && line.includes('下周三'), '承诺类的话进事实卡')

memory.harvestFacts({ platform: 'qq', who: '路人', text: '今天天气不错' })
const shared = readFileSync(memory._paths.sharedOf('qq'), 'utf8')
ok(!shared.includes('天气不错'), '闲聊不进事实卡')

const pre = memory.buildPrefix({ platform: 'qq', chatKey: 'g1' })
ok(pre.includes('共享记忆') && pre.includes('下周三'), '别的会话也能看到这条事实')

memory.noteTurn({ platform: 'qq', chatKey: 'g1', who: 'A', text: '在吗', reply: '在' })
const log = readFileSync(memory._paths.logOf('qq', 'g1'), 'utf8')
ok(log.includes('在吗') && log.includes('→ 小鲸鱼: 在'), '每条都落日志（L2 的原料）')

ok(memory.buildPrefix({ platform: 'tg', chatKey: 'g1' }) === '', 'TG 侧看不到 QQ 的记忆（身份隔离）')

ok(memory.agentEnabled({ engine: 'agent' }) === true, 'engine=agent 才走新路')
ok(memory.agentEnabled({}) === false, '默认回 legacy（出事能一键退回）')

console.log(`\n===== ${fail ? '✗' : '✓'} 记忆 ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
