// 曲库精确命中：点《雨爱》不能给《雨爱（司凤版）》，点了没版本就得去搜
import { findCached, cachedSongs } from '../bridge/group/voice.mjs'

let pass = 0
const fails = []
const ok = (c, m) => { if (c) pass += 1; else fails.push(m) }
const hit = (q) => { const r = findCached(q); return r ? r.bvid : '' }

// 现有曲库（由 index.json + 盘上文件决定，测试前会打印出来核对）
const lib = cachedSongs()
console.log(`  曲库 ${lib.length} 首`)

// ① 原版点原版
ok(hit('雨爱') === 'BV1sZywBxEHd', '《雨爱》→ 原版（不是司凤版）')
// ② 版本点版本
ok(hit('雨爱（司凤版）') === 'BV1faak6AEzm', '《雨爱（司凤版）》→ 司凤版')
ok(hit('司凤版雨爱') === 'BV1faak6AEzm', '倒装写法也认')
// ③ 库里没有的版本 → 必须去搜，不能拿原版顶
ok(hit('雨爱（周深版）') === '', '库里没有周深版 → 不命中')
ok(hit('雨爱 live') === '', '库里没有 live → 不命中')
ok(hit('雨爱 现场') === '', '库里没有现场 → 不命中')
// ④ 完全没点过的歌
ok(hit('学猫叫') === '', '没点过的歌 → 不命中')
// ⑤ 太短的歌名不猜
ok(hit('酒') === '', '一个字不猜')
ok(hit('') === '', '空串不命中')
// ⑥ 带版本词但库里有的
ok(hit('朋友的酒') === 'BV1hXbN6VEKV', '《朋友的酒》命中缓存')
ok(hit('不眠之夜') === 'BV19e411E7mY', '《不眠之夜》命中 2:19 那条（不是 28 秒那条）')

console.log(`\n曲库命中：${pass} 通过 / ${fails.length} 失败`)
for (const f of fails) console.log(`  ✗ ${f}`)
process.exit(fails.length ? 1 : 0)
