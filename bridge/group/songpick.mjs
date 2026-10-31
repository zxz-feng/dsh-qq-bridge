/**
 * 选歌：先确认"是不是歌"，再确认"是不是这首"，最后才扒
 *
 * 用户 2026-10-28 的要求：
 *   "让她先理解我点的是不是歌，是歌就先查下歌的信息，然后 B站 找歌"
 *
 * 为什么不能直接拿 B站 搜索结果按播放量取第一条：
 *   搜"夜曲" → 头条是 PDD 看华语金曲榜（24 分钟）、月半小夜曲（4:24）
 *   搜"晴天" → 头条是 50 首歌盘点合集（13 分钟）
 *   播放量高 ≠ 是这首歌。
 *
 * 所以分三步：
 *   ① 意图判断 —— 这是不是"点歌"（不是就交给聊天）
 *   ② 歌信息   —— 查歌名/歌手/时长（B站 搜"歌名 歌曲"取最长见信息 + 维基补充）
 *   ③ 选视频   —— 按"标题匹配 + 时长接近 + 音频类特征"打分，不只看播放量
 */
import { biliSearch, wikiSearch } from './search.mjs';
import { chat } from './llm.mjs';

// ── ① 是不是在点歌 ───────────────────────────────────────

/**
 * 用模型判断"这句是不是在点歌"，顺便抽出歌名。
 * 只在规则识别已经认为是点歌时才调用（省钱），用来挡掉"放开我的token"这类误判。
 *
 * @returns {Promise<{isSong:boolean, title:string, artist:string}>}
 */
export async function judgeSong(raw) {
  const text = String(raw ?? '').slice(0, 100);
  try {
    const r = await chat([
      {
        role: 'system',
        content: '判断用户这句话是不是在"点歌/让机器人放歌/唱歌"。只输出 JSON，不要解释：\n'
          + '{"isSong": true/false, "title": "歌名", "artist": "歌手（不确定就留空）"}\n'
          + '判断标准：\n'
          + '- "来一首晴天" / "唱个夜曲" / "放首歌" → isSong=true\n'
          + '- "放开我的token要炸了" / "搞错号了" / "这又是啥" → isSong=false\n'
          + '- 歌名要原样保留，别翻译、别改写',
      },
      { role: 'user', content: text },
    ], { maxTokens: 600, temperature: 0.1, effort: 'low', timeoutMs: 20000 });

    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return { isSong: false, title: '', artist: '' };
    const j = JSON.parse(m[0]);
    return {
      isSong: j.isSong === true,
      title: String(j.title ?? '').trim().slice(0, 40),
      artist: String(j.artist ?? '').trim().slice(0, 20),
    };
  } catch {
    // 判断失败就按"是歌"处理（宁可多试一次，也别让点歌没反应）
    return { isSong: true, title: '', artist: '' };
  }
}

// ── ② 查歌信息 ──────────────────────────────────────────

/**
 * 查这首歌大概多长、谁唱的。
 * 数据源：B站 搜"<歌名> 歌曲"的标题里出现的 "3:52" 这类时长 + 维基百科。
 *
 * @returns {Promise<{durations:number[], artist:string, hints:string[]}>}
 */
export async function probeSong(title) {
  const hints = [];
  const durations = [];
  let artist = '';

  // B站：标题里的 3:52 / 04:24 时长，是最直接的长度信息
  try {
    const vids = await biliSearch(`${title} 歌曲`, 10);
    for (const v of vids) {
      const d = parseDur(v.duration);
      if (d >= 20 && d <= 600) durations.push(d);
      const t = String(v.title ?? '');
      if (!artist) {
        const m = t.match(/[-–—]\s*([^-–—《》]{2,12})\s*(?:MV|mv|$)/) || t.match(/《[^》]+》\s*(?:cover\s*by\s*)?([^-\s]{2,12})/);
        if (m) artist = m[1].trim();
      }
    }
    if (durations.length) hints.push(`B站上这首歌大约 ${median(durations)} 秒`);
  } catch { /* 查不到就少一条线索 */ }

  // 维基：补歌手/发行信息
  if (!artist || durations.length === 0) {
    try {
      const w = await wikiSearch(title, 2);
      if (w.length) hints.push(`维基有词条：${w[0].title} —— ${w[0].snippet.slice(0, 60)}`);
    } catch { /* 忽略 */ }
  }

  return { durations, artist, hints, median: durations.length ? median(durations) : 0 };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function parseDur(s) {
  const m = String(s ?? '').match(/^(\d+):(\d+)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

// ── ③ 选视频 ────────────────────────────────────────────

/** 明显不是"一首歌"的标题特征 */
const BAD_TITLE = [
  // 合集/盘点类
  /合集|盘点|排行榜|Top\s*\d+|前\s*\d+|串烧|半小时|一小时|\d+\s*小时|精选|歌单|连播/,
  // 非演唱类
  /reaction|Reaction|REACTION|直播|实况|解析|教程|教学|钢琴|吉他|谱|简谱|翻弹|指弹|舞蹈|翻跳/,
  // 话题类（"抄袭届""网友评价""XX你怎么看"）
  /搞笑|沙雕|鬼畜|整活|吐槽|锐评|科普|新闻|评测|评价|怎么看|回应|抄袭|裁子|争议|塌房|翻车|瓜/,
  /夹子音|名场面|挑战|唱功|听听|试听|实力|开口跪|封神|现场|live|Live|LIVE|演唱会|翻唱|cover|Cover/,
  // 音质异常 / 变调 / 版权提示
  /dj|DJ|remix|Remix|1\.03x|加速|降调|升调|八倍速|版权|侵删|无版权|仅供/,// 
];

/** 翻唱 / 改编 / 特殊版本：用户点原曲时这些都不算（2026-10-31 起风了选了林俊杰高音版） */
const COVER_TITLE = [
  /翻唱|翻自|改编|重制|Cover|COVER|cover|A\s?cappella|阿卡贝拉/,
  /高音版|低音版|男版|女版|男生版|女生版|合唱版|对唱版|慢速版|加速版|片段|剪辑版|变调|降调|升调/,
  /极致蓝光|收藏版|珍藏版|发烧版|环绕版|纯享|纯音乐|伴奏|消音|和声版|钢琴版|吉他版|古筝版|器乐版/,
  // 2026-10-31：搜《忘情牛肉面》时混响版（4:33）压过了原唱候选，主人要的是原曲
  /混响|Reverb|reverb|8D|环绕音效|3D音效|慢摇|DJ版/,
];

/** 像"一首歌"的标题特征（加分） */
const GOOD_TITLE = [
  /MV|mv|PV|官方|无损|高音质|音源|完整版|动态歌词|歌词/,
  /4K|1080P|修复|Hi-?Res/i,
];

/**
 * 给候选视频打分
 * @param {object} v      {bvid,title,author,play,duration,desc}
 * @param {string} query  用户点的歌名
 * @param {number} expect 这首歌大概多长（秒，0=不知道）
 */
export function scoreVideo(v, query, expect = 0, artist = '') {
  const title = String(v.title ?? '');
  const dur = parseDur(v.duration);
  let s = 0;
  const why = [];

  // ① 标题里有没有这首歌（最重要）——而且必须是"完整独立"出现
  const cleanTitle = title.replace(/[\s《》「」"'"'【】\[\]()（）·、,，.。!！?？]/g, '');
  const q = String(query).replace(/[\s《》「」"'"'【】\[\]()（）·、,，.。!！?？]/g, '');
  if (!q) return { score: -99, why: ['歌名为空'] };

  if (cleanTitle.includes(q)) {
    // 检查前后有没有黏着别的字（"月半小夜曲" 里 "夜曲" 前面黏着"小"，"雨爱dj" 后面黏着"dj"）
    const idx = cleanTitle.indexOf(q);
    const before = idx > 0 ? cleanTitle[idx - 1] : '';
    const after = idx + q.length < cleanTitle.length ? cleanTitle[idx + q.length] : '';
    // 只有黏着"另一个歌名的一部分"才算黏连：
    //   "月半小夜曲" 里 "夜曲" 前面黏着"小" → 是别的歌，扣分
    //   "《雨爱》dj版" 里 "雨爱" 后面黏着"dj" → 是remix，扣分（BAD_TITLE 已扣）
    //   "在百万豪装录音棚大声听邓紫棋《光年之外》" 里"光年之外"两侧是书名号 → 正常
    // 所以这里只看"前一个字是中文且不是常见修饰词前缀"
    const prefixOK = /^(小|大|老|新|旧|前|后)$/.test(before) ? false : true;
    // 书名号/引号包着歌名 = 作者自己标了「这是这首歌」，比「前面黏着字」可信
    // （2026-10-30：「在百万豪装录音棚大声听 杨丞琳《雨爱》」被误判成黏连，输给了一条 2:21 的歌词剪辑）
    const escQ = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wrapped = new RegExp(`[《【「\\[（(]\\s*${escQ}\\s*[》】」\\]）)]`).test(title);
    // 歌名紧跟在一个右括号后面，也算"作者自己标了歌名"：
    // 「【洛天依原创】人是猫」去掉括号后是「洛天依原创人是猫」，人 前面黏着「创」，
    // 会被判成"前面黏着别的字"。2026-10-31 就是这么把原曲判给了一条
    // 「猫永远是猫，人有时候是狗！」的近似标题。
    const afterBracket = new RegExp(`[】\\]）)]\\s*${escQ}`).test(title);
    const stickBefore = !wrapped && !afterBracket && /[\u4e00-\u9fa5]/.test(before) && !/[的在听唱放首和与及]/.test(before);
    const stickAfter = /[a-zA-Z]/.test(after) && /^(dj|remix|ver|版)/i.test(cleanTitle.slice(idx + q.length));
    if (!stickBefore && !stickAfter) { s += 12; why.push(wrapped ? '书名号包着歌名' : (afterBracket ? '括号后紧跟歌名' : '歌名完整独立出现')); }
    else { s += 3; why.push(stickBefore ? '前面黏着别的字（可能是别的歌）' : '带remix/版本后缀'); }
  }
  else if (query.length >= 2) {
    // 允许标题里间隔出现（"周杰伦 - 晴 天"这种少见，主要防误判）
    const parts = query.split('').filter((c) => /[\u4e00-\u9fa5A-Za-z]/.test(c));
    const hit = parts.filter((c) => title.includes(c)).length;
    // 散字命中只能算"沾边"：以前给 +4，比"歌名出现在标题里但前面黏字"的 +3 还高，
    // 于是「猫永远是猫，人有时候是狗！」压过了原曲《人是猫》。降到 +2。
    if (hit / Math.max(1, parts.length) > 0.7) { s += 2; why.push('标题近似（字都沾边）'); }
    else return { score: -99, why: ['标题不含歌名'] };
  }

  // ② 明显的"不是单曲"标题
  for (const re of BAD_TITLE) {
    if (re.test(title)) { s -= 12; why.push('标题像合集/非歌曲'); break; }
  }
  for (const re of GOOD_TITLE) {
    if (re.test(title)) { s += 2; why.push('标题像官方音源'); break; }
  }
  // ②b 翻唱/改编/特殊版本：重量级扣分，别让「【林俊杰】-《起风了》-最燃高音版」冒充原曲
  for (const re of COVER_TITLE) {
    if (re.test(title)) { s -= 14; why.push('像翻唱/改编/特殊版本'); break; }
  }
  // ②c 标题里挂着别人的名字（【林俊杰】），而点歌人没提这个人 → 多半是翻唱
  const bracket = title.match(/【([^】]{2,10})】/) || title.match(/\[([^\]]{2,10})\]/)
  if (bracket) {
    const who = bracket[1]
    const known = String(artist || '')
    if (!who.includes('官方') && !who.includes('原唱') && !query.includes(who) && !(known && who.includes(known))) {
      s -= 8; why.push(`标题挂着「${who}」（可能是翻唱）`)
    }
  }
  // ②d 歌名里已知的原唱出现在标题 → 加分
  if (artist && title.includes(String(artist).slice(0, 4))) { s += 6; why.push('标题含原唱名') }

  // ③ 时长：单曲一般在 2~7 分钟
  if (dur) {
    if (dur < 100) { s -= 12; why.push(`太短(${dur}s)，不像完整一首`); }
    else if (dur > 900) { s -= 15; why.push(`太长(${Math.round(dur / 60)}min)`); }
    else if (dur >= 90 && dur <= 480) { s += 4; why.push('时长像单曲'); }
    // 和预期长度接近再加分
    if (expect > 0 && Math.abs(dur - expect) <= 45) { s += 5; why.push('时长与预期接近'); }
  }

  // ④ 简介也要看一眼
  const desc = String(v.desc ?? '');
  if (/reaction|直播|排行|合集|教程/i.test(desc)) { s -= 4; why.push('简介像非演唱'); }

  // ⑤ 播放量：只做微调，不能主导
  const play = Number(v.play ?? 0);
  if (play > 5_000_000) s += 1;
  else if (play > 500_000) s += 0.5;

  return { score: s, why };
}

/**
 * 回话用的短标题：优先「用户点的歌名」+ 歌手，不念整条视频标题
 */
export function shortLabel(query, v, probed = {}) {
  const q = String(query ?? '').trim().slice(0, 16);
  if (!q) return String(v?.title ?? '').slice(0, 16);
  const artist = String(probed.artist ?? '').trim().slice(0, 10);
  return artist ? `${q} · ${artist}` : q;
}

/**
 * 按歌名挑一条最像"这首歌"的视频
 * @returns {Promise<{ok:boolean, pick?:object, why?:string[], probed?:object, reason?:string}>}
 */
export async function pickSongVideo(query, { title = '' } = {}) {
  const kw = String(query ?? '').trim();
  if (!kw) return { ok: false, reason: '没听清歌名' };

  let vids;
  try { vids = await biliSearch(kw, 12); }
  catch (e) { return { ok: false, reason: '搜索失败' }; }
  if (!vids.length) return { ok: false, reason: '搜不到' };

  // 查一下这首歌大概多长，用来卡时长
  let probed = { durations: [], artist: '', hints: [], median: 0 };
  try { probed = await probeSong(title || kw); } catch { /* 查不到不影响 */ }
  const expect = probed.median || 0;

  const scored = vids.map((v) => ({ v, ...scoreVideo(v, kw, expect, probed.artist) }))
    .filter((x) => x.score > -50)
    .sort((a, b) => b.score - a.score || (b.v.play ?? 0) - (a.v.play ?? 0));

  if (!scored.length) return { ok: false, reason: `没有像《${kw}》的视频`, probed };
  if (scored[0].score < 8) {
    return { ok: false, reason: `结果都不太像《${kw}》`, probed };
  }

  return { ok: true, pick: scored[0].v, why: scored[0].why, probed, runnerUp: scored[1]?.v };
}
