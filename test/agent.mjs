/**
 * agent.mjs 的纯函数测试 —— 不联网、不起进程。
 * 重点守两件事：① 模型输出里夹着人话也能抠出 JSON；② 「唱首歌」不能被当成歌名。
 */
import { extractJson, toOutput } from '../bridge/group/agent.mjs'

let pass = 0
let fail = 0
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`) } else { fail += 1; console.log(`  ✗ ${m}`) } }

console.log('===== agent 解析 =====')
ok(extractJson('{"reply":"在"}')?.reply === '在', '纯 JSON 直接解析')
ok(extractJson('先说一句\n{"reply":"嗯","voice":true}')?.voice === true, '夹着人话也能抠出来')
ok(extractJson('```json\n{"reply":"x"}\n```')?.reply === 'x', '代码块围栏里的 JSON')
ok(extractJson('没有 json 的一段话') === null, '没有 JSON 返回 null')
ok(extractJson('{"a":1}') === null, '没有 reply/silence 的对象不算')
ok(extractJson('{"reply":"第一句"}\n{"reply":"最后一句"}')?.reply === '最后一句', '多段 JSON 取最后一段')

console.log('===== 输出映射 =====')
ok(toOutput({ silence: true }).parts.length === 0, 'silence → 不说话')
ok(toOutput({ reply: '嗯', voice: true }).voices[0] === '嗯', 'voice=true → 走语音')
ok(toOutput({ reply: '好', sing: '雨爱' }).sings[0] === '雨爱', '真歌名 → 唱歌')
ok(toOutput({ reply: '行', sing: '首歌' }).sings.length === 0, '「首歌」不是歌名（不许点《首歌》）')
ok(toOutput({ reply: '行', sing: '一首歌' }).sings.length === 0, '「一首歌」不是歌名')
ok(toOutput({ reply: '哈', sticker: '开心' }).stickers[0] === '开心', 'sticker 透传')
ok(toOutput(null).parts.length === 0, 'null 不炸')
ok(toOutput({ reply: '第一段\n第二段\n第三段' }).parts.length === 3, '换行分段 → 发三条')
ok(toOutput({ reply: '1\n2\n3\n4\n5\n6' }).parts.length === 4, '最多四条，别刷屏')
ok(toOutput({ reply: '很长的一句话'.repeat(40) }).parts[0].length > 60, '长回复不截断')

console.log(`\n===== ${fail ? '✗' : '✓'} agent 解析 ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
