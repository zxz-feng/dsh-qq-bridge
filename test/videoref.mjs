// 「发链接/BV 号就放这一条」的识别测试（纯函数，零 token）
import { parseVideoRef, looksLikeVideoOrder, bvVariants, normBvid } from '../bridge/group/videoref.mjs'

let pass = 0
const fails = []
const ok = (c, m) => { if (c) pass += 1; else fails.push(m) }

// 各种链接写法
ok(parseVideoRef('https://www.bilibili.com/video/BV1Yf9sBtEHP')?.bvid === 'BV1Yf9sBtEHP', '完整链接')
ok(parseVideoRef('https://m.bilibili.com/video/BV1Yf9sBtEHP?spm=1')?.bvid === 'BV1Yf9sBtEHP', '带参数')
ok(parseVideoRef('https://www.bilibili.com/video/BV1Yf9sBtEHP/?p=3')?.page === 3, '取第几P')
ok(parseVideoRef('BV1Yf9sBtEHP')?.via === 'bvid', '裸 BV 号')
ok(parseVideoRef('唱 BV1Yf9sBtEHP 这个')?.bvid === 'BV1Yf9sBtEHP', '混在句子里')
ok(parseVideoRef('av170001')?.avid === 170001, 'av 号')
ok(parseVideoRef('https://b23.tv/abcd')?.short === 'https://b23.tv/abcd', '短链')
ok(parseVideoRef('今天天气不错') === null, '没提到视频')
ok(parseVideoRef('') === null, '空串')

// 是不是「指令」
ok(looksLikeVideoOrder('https://www.bilibili.com/video/BV1Yf9sBtEHP') !== null, '光发链接也算指令')
ok(looksLikeVideoOrder('唱 https://www.bilibili.com/video/BV1Yf9sBtEHP') !== null, '唱+链接')
ok(looksLikeVideoOrder('就这个 BV1Yf9sBtEHP') !== null, '就这个+BV')
ok(looksLikeVideoOrder('放av170001') !== null, '放+av')
ok(looksLikeVideoOrder('我在看 BV1Yf9sBtEHP 的视频') === null, '只是在聊 B 站 → 不算指令')
ok(looksLikeVideoOrder('这个 BV1Yf9sBtEHP 好听') === null, '夸好听 → 不算指令')
ok(looksLikeVideoOrder('今天好热') === null, '无关')

// BV 号大小写兜底（用户手打常全小写，bvid 区分大小写）
ok(normBvid('bv1yf9sbtehp') === 'bv1yf9sbtehp', '小写原样保留（不改大小写）')
const vs = bvVariants('bv1yf9sbtehp')
ok(vs.length === 2 && vs.every((x) => x.slice(2) === '1yf9sbtehp'), '只把前缀归一，后 10 位原样（不同大小写是不同的视频）')
ok(bvVariants('乱码').length === 1, '不是 BV 就原样')

// 短链：光发 / 混在句子里都算指令，夸它不算
ok(looksLikeVideoOrder('https://b23.tv/gcEwHaL') !== null, '光发短链')
ok(looksLikeVideoOrder('唱https://b23.tv/gcEwHaL里面的歌') !== null, '唱+短链+从句')
ok(looksLikeVideoOrder('https://b23.tv/gcEwHaL 好听') === null, '短链+夸好听 → 不算')

// 带链接/BV 的消息不能再走歌名判定（否则 judgeSong 会说"不是歌"）
const isRefMsg = (t) => /https?:\/\/|\bBV[0-9A-Za-z]{10}\b|\bav\d{3,}/i.test(t)
ok(isRefMsg('BV1hXbN6VEKV'), 'BV 消息要跳过歌名判定')
ok(isRefMsg('唱https://b23.tv/gcEwHaL里面的歌'), '短链消息要跳过歌名判定')
ok(!isRefMsg('唱首雨爱'), '普通歌名不跳过')

console.log(`\n视频引用：${pass} 通过 / ${fails.length} 失败`)
for (const f of fails) console.log(`  ✗ ${f}`)
process.exit(fails.length ? 1 : 0)
