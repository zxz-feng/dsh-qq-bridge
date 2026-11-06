// 认「我要的是这一个视频」——链接或 BV 号
//
// 为什么需要它：一首歌在 B 站有几十个版本，标题筛选永远有猜错的可能。
// 主人直接甩链接/BV 号就没有歧义了 —— 不用搜、不用打分，直奔那一条。
//
// 认得的写法（都实测过）：
//   https://www.bilibili.com/video/BV1Yf9sBtEHP
//   https://b23.tv/xxxxxx              （短链，要跳一次）
//   https://www.bilibili.com/video/BV1Yf9sBtEHP/?p=2   （多 P 取 p）
//   BV1Yf9sBtEHP / bv1yf9sbtehp        （裸号，大小写都行）
//   av170001                           （老 av 号）
//   「唱这个 https://... 」               （混在句子里也行）
const BV_RE = /(BV[0-9A-Za-z]{10})/i
const AV_RE = /(?:^|[^0-9A-Za-z])av(\d{3,12})(?![0-9])/i
const B23_RE = /https?:\/\/b23\.tv\/[0-9A-Za-z]+/i
const PAGE_RE = /[?&]p=(\d{1,3})/i

/** 抠出 BV 号原文（bvid 大小写敏感，不能自作聪明改） */
export function normBvid(s) {
  const m = String(s ?? '').match(BV_RE)
  return m ? String(m[1]) : ''
}

/** 从任意一句话里抠出视频引用；没提到就返回 null */
export function parseVideoRef(text) {
  const t = String(text ?? '')
  const page = Number((t.match(PAGE_RE) || [])[1] || 0) || 0

  const bv = normBvid(t)
  if (bv) return { bvid: bv, page, via: 'bvid' }

  const av = (t.match(AV_RE) || [])[1]
  if (av) return { avid: Number(av), page, via: 'av' }

  const b23 = t.match(B23_RE)
  if (b23) return { short: b23[0], page, via: 'b23' }

  return null
}

/** 这句话像不像「放这个」的指令（不是单纯在聊 B 站） */
const ORDER_WORDS = /(唱|放|来|点|整|要|听|这个|这首|就它|就这个|用这个|换这个)/
export function looksLikeVideoOrder(text) {
  const ref = parseVideoRef(text)
  if (!ref) return null
  // 纯链接也算指令（发链接本身就是"就这个"）
  if (!orderWordsLoose(text)) return null
  return ref
}

// 「这个 BV 好听」「我在看这个 BV」—— 有情绪动词但没让你放，不算指令
const JUST_TALKING = /(好听|难听|好听吗|看过|在看在听|哪个|是哪|是什么|有意思|好听诶|好听啊|不错|好家伙|笑了)/

function orderWordsLoose(text) {
  const t = String(text ?? '')
  // 只剩链接、没有别的字 → 直接当指令
  const rest = t.replace(B23_RE, ' ').replace(/https?:\/\/\S+/g, ' ').replace(BV_RE, ' ').replace(/av\d+/gi, ' ')
    .replace(/[《》""''：:，,。！？\s]/g, '')
  if (!rest) return true
  if (JUST_TALKING.test(t) && !/(唱|放|点歌|来一首|整一首|就这个|就要这个|用这个|换这个|这个吧)/.test(t)) return false
  return ORDER_WORDS.test(t)
}

/** 归一化 BV 号的大小写：bilibili 的 bvid 区分大小写，
 *  但用户手打时常常全小写 → Vid 接口认不了。这里只在「查不到」时兜底重试两种写法。 */
export function bvVariants(bv) {
  const v = String(bv || '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/i.test(v)) return [v].filter(Boolean)
  // ⚠️ 不能瞎试大小写：B 站 bvid 是大小写敏感的，同一串不同大小写是**不同的视频**
  // （实测 BV19e411E7mY 是一首中文歌，BV19e411e7my 是另一条 28 秒的短视频）。
  // 只能把前缀 BV 归一，后面 10 位必须原样。
  return [v, 'BV' + v.slice(2)]
}

export { ORDER_WORDS }
