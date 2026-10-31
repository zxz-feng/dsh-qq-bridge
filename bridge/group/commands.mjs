/**
 * 主人命令层
 *
 * 群里只有"主人"能命令小鲸鱼做事。别人这么说，走正常聊天（模型自己决定要不要唱）。
 *
 * 为什么单独做一层而不是让模型自己判断：
 *   · 禁言这种动作不能让模型自由裁量（它可能理解错、也可能被话术骗）
 *   · 命令要**立刻执行**，不能等 8% 概率
 *   · 执行结果要确定，不能"有时做有时不做"
 *
 * 权限边界（和 admin.mjs 一致）：
 *   禁言 ≤ 300 秒；踢人不实现；改名片/头衔/群名不提供。
 */
import { readJson, writeJson, STORE, nowSec } from './store.mjs';
import { appendFileSync } from 'node:fs';
import { setStyle, getStyle, listStyles, resolveStyle, getStyleDef } from './style.mjs';
import { mute, MUTE_MAX_SEC } from './admin.mjs';

const SILENCE_MAX_MIN = Number(process.env.SILENCE_MAX_MIN ?? 60);

function silencePath(gid) { return `${STORE}/groups/${gid}/silence.json`; }

export function loadSilence(gid) { return readJson(silencePath(gid), { until: 0, by: '', reason: '' }); }

export function saveSilence(gid, obj) { writeJson(silencePath(gid), obj); }

/** 现在是不是被主人要求闭嘴了 */
export function isSilenced(gid) {
  const s = loadSilence(gid);
  return s.until > nowSec() ? s : null;
}

export function clearSilence(gid) {
  saveSilence(gid, { until: 0, by: '', reason: '' });
}

/** 是否主人 */
export function isOwner(uin, policy = {}) {
  const list = (policy.ownerUins ?? []).map(String);
  return list.includes(String(uin));
}

/**
 * 从分钟/秒的表述里取秒数
 * "5分钟" "300秒" "5" → 300 / 300 / 300（默认单位：分钟）
 */
export function parseSeconds(s) {
  const t = String(s ?? '');
  const m = t.match(/(\d+)\s*(分钟|分|min|m)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!n) return null;
  const isSec = /秒|s(ec)?/i.test(t);
  return isSec ? n : n * 60;
}

/**
 * 解析命令（只在主人发的时候调用）
 * @param {string} text 已经去掉 @ 段和"小鲸鱼"的正文
 * @returns {{kind:string, arg:string, seconds:number|null}|null}
 */
/** 「整首/完整版」的说法 */
const FULL_RE = /(完整版|完整的|整首|全曲|整首歌|从头到尾|完整)/;

export function parseCommand(text) {
  const t = String(text ?? '')
    .replace(/@\d+/g, ' ')                 // CQ 解析后 @ 会变成 "@1002" 留在正文里
    .replace(/^[\s,，。、:：]+/, '')
    .replace(/^(小鲸鱼|鲸鱼)[\s,，。、:：]*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!t) return null;

  const rules = [
    // 风格档（只有主人能调）。一个 kind 管全部：切/关/查/列。
    // 顺序：关 → 通用切换 → 开 → 裸名字，反了会把「关掉孙吧」认成「开」
    { kind: 'style', re: /^(?:关|关闭|退出|停|收|别)\s*(?:掉|了)?\s*(?:风格|人格|性格|模式|孙吧|孙笑川|嘴臭|嘴毒|抽象|傲娇|冷淡|元气)\s*$/ },
    { kind: 'style', re: /^[#/／]?\s*(?:换成|切成|换|切|改|设置|换个|切个)?\s*(?:个)?\s*(?:风格|人格|性格)\s*(.*)$/ },
    { kind: 'style', re: /^(?:换成|切成)\s*(.+)$/ },
    { kind: 'style', re: /^(?:开|打开|开启|启动|进入|上|来)\s*(?:个|一下)?\s*(?:孙吧|孙笑川|嘴臭|嘴毒|抽象|傲娇|冷淡|元气|风格)(?:\s*模式)?\s*$/ },
    { kind: 'style', re: /^(?:孙吧|孙笑川|嘴臭|嘴毒|傲娇|冷淡|元气)(?:模式)?\s*(?:状态|开着|开了|开了吗|在不在)?[?？]?$/ },
    // 「帮我找个 X」——找资源 +（要图的话）带缩略图
    { kind: 'find', re: /^(?:[帮给][\u4e00-\u9fa5A-Za-z0-9_]{0,10}?|替我|求|要)?(?:找|搜|搞|弄|来|推荐|整)(?:个|一个|一张|一下|一找)?\s*(.{2,30})$/ },
    { kind: 'sing', re: /^(唱一下|唱下|唱|来一首|来一曲|来一段|来首|来点|放首歌?|放个歌|放一首|放首|放一下|点歌|放)\s*(?:个|一首|首|一段|一下|点)?\s*(.*)$/ },
    { kind: 'sticker', re: /^(发个?表情包?|来张表情|发表情|来个表情)\s*(.*)$/ },
    { kind: 'mute', re: /^禁言\s*(.*)$/ },
    { kind: 'recall', re: /^(撤回|删掉|撤销)$/ },
    { kind: 'silence', re: /^(闭嘴|安静|别说了|先别说话|消停)\s*(.*)$/ },
    { kind: 'wake', re: /^(出来|说话|可以说了|恢复|醒醒)\s*$/ },
    { kind: 'search', re: /^(查一下|查查|查|搜一下|搜搜|搜)\s*(.*)$/ },
  ];

  for (const { kind, re } of rules) {
    const m = t.match(re);
    if (!m) continue;
    // sing/search 的正文在 m[2]；find 只有一个捕获组，正文在 m[1]（2026-10-29 踩过）
    const rawArg = (m[2] ?? m[1] ?? '').trim();
    // ⚠️ 分发表拿到的是**正则捕获的原文**，脏东西还都在：
    //    2026-10-30「唱下雨爱这首歌」→ 捕获「雨爱这首歌」→ 去搜「雨爱这首歌」→ 放出一条 vlog
    //    cleanSongText 会把「这首歌/那首歌」「《》」这些口语剥掉，sing/search 必须先过一遍
    const arg = (kind === 'sing' || kind === 'search') ? cleanSongText(rawArg) : rawArg;
    // ⚠️ 歌名要过 sanity 检查：否则"放开我的token要炸了"会被当成点歌
    const bare = arg.replace(FULL_RE, ' ').trim();
    // find 只在"确实是在找东西"时才认（不然"来找我"这种会被当成搜东西）
    // ⚠️ 这里必须是 continue 不能 return null：find 的正则很宽（"来"也算动词），
    //    否则「来一首《雨爱》」会被 find 先吃掉、判不通过，然后整条命令直接没了（2026-10-30）
    if (kind === 'find' && !/(黄油|galgame|游戏|本子|里番|资源|漫画|画师|作品|图|封面|缩略图|壁纸)/i.test(t)) continue;
    // ⚠️ 只有需要"歌名/关键词"的命令才过这个检查；
    //    不然别的规则（孙吧开关之类）捕获到什么都会被当成歌名判掉（2026-10-28 踩过）
    if ((kind === 'sing' || kind === 'search') && bare && !looksLikeTitle(bare)) continue;
    // "唱完整版雨爱" / "整首雨爱" → 分段发
    const full = FULL_RE.test(arg) || FULL_RE.test(t);
    let seconds = null;
    if (kind === 'mute' || kind === 'silence') seconds = parseSeconds(arg) ?? parseSeconds(t);
    return { kind, arg: arg.replace(FULL_RE, '').trim(), seconds, full, raw: t };
  }
  return null;
}

/**
 * 执行命令
 * @param {object} cmd  parseCommand 的结果
 * @param {object} ctx  {gid, uin, name, policy, callApi, at:[], lastSentId}
 * @returns {Promise<{handled:boolean, reply?:string, detail?:string}>}
 */
export async function execute(cmd, ctx) {
  const { gid, policy, callApi } = ctx;

  switch (cmd.kind) {
    // ── 风格档（2026-10-29 改成注册表）──
    // 一个 kind 管切/关/查/列：`#风格 孙吧`、`#风格 关`、`#风格`。
    // 加一档不用改代码 —— 往 persona/styles/ 丢一个 .md 就行。
    case 'style': {
      const raw = String(cmd.raw ?? '');
      const arg = String(cmd.arg ?? '').trim();
      const cur = getStyle(gid);
      const list = listStyles();
      const menu = list.map((x) => `${x.name}(#${x.id})`).join(' / ');
      const statusLine = cur.style === 'normal'
        ? '正常档'
        : `${getStyleDef(cur.style)?.name ?? cur.style}${cur.intensity === 'heavy' ? '·重' : ''}`;

      if (/列表|有哪些|所有|都有啥|list/i.test(arg)) {
        return { handled: true, reply: `现在：${statusLine} ||| 可选：${menu}` };
      }

      // 想切成哪一档？关掉 → normal；没给参数就试着从原句里认个名字
      let want = '';
      if (/^(?:关|关闭|退出|停|收|别)/.test(raw) || /^(?:正常|原样|默认|关)$/.test(arg)) want = 'normal';
      else if (arg) want = arg;
      else {
        const bare = raw
          .replace(/^(?:开|打开|开启|启动|进入|上|来|换成|切成|换个|换|切个|切)\s*(?:个|一下)?\s*/, '')
          .replace(/模式|状态|开着|开了吗|开了|在不在|[?？]/g, '')
          .trim();
        if (bare && resolveStyle(bare) && !/状态|开着|开了|在不在/.test(raw)) want = bare;
      }

      if (!want) return { handled: true, reply: `现在：${statusLine} ||| 可选：${menu}` };

      const intensity = /重|狠|猛|凶/.test(arg) || /重|狠|猛|凶/.test(raw) ? 'heavy' : 'mid';
      const clean = want.replace(/重|狠|猛|凶|模式|档|吧|啊|了/g, '').trim() || want;
      const s = setStyle(gid, clean, { by: ctx.uin, intensity });
      if (!s) return { handled: true, reply: `没这个风格 ||| 可选：${menu}` };
      auditStyle(gid, ctx, s);

      const ACK = {
        normal: '行，正常了',
        sunbar: '行，那我可不客气了',
        tsundere: '哼，才不是想换的 ||| 就、就这一次',
        cold: '嗯。',
        genki: '好耶！换好啦 ||| 现在超有精神',
      };
      const ack = ACK[s.style] ?? `好，切到${getStyleDef(s.style)?.name ?? s.style}了`;
      if (s.style === cur.style && s.intensity === cur.intensity) {
        return { handled: true, reply: `早就这样了 ||| ${ack}` };
      }
      return { handled: true, reply: ack };
    }

    case 'find': {
      const kw = cleanLookupArg(cmd.arg);
      if (!kw) return { handled: true, reply: '找啥呀，说个名字' };
      const { findGoods } = await import('./goods.mjs');
      const { sendPicture } = await import('./media.mjs');
      const wantImg = /图|缩略图|封面|截图/.test(cmd.raw ?? '');
      const r = await findGoods(kw);
      if (!r.ok) return { handled: true, reply: `没搜着（${r.reason}）` };
      const title = r.item.title.length > 42 ? `${r.item.title.slice(0, 42)}…` : r.item.title;
      let imgNote = '';
      if (wantImg) {
        const pic = await sendPicture(gid, r.item.image, callApi);
        imgNote = pic.ok ? '' : `（图没发出去：${pic.reason}）`;
      }
      return {
        handled: true,
        reply: `${title} ||| ${r.item.url} ${imgNote}`.trim(),
      };
    }

    case 'sing': {
      if (!cmd.arg) return { handled: true, reply: '唱什么呀，给个歌名' };
      return { handled: true, action: 'voice', arg: cmd.arg, reply: '' };
    }

    case 'sticker': {
      return { handled: true, action: 'sticker', arg: cmd.arg, reply: '' };
    }

    case 'mute': {
      const target = (ctx.at ?? []).find((x) => String(x) !== String(process.env.SELF_QQ ?? ''));
      if (!target) return { handled: true, reply: '要禁言谁呀，@ 一下' };
      const sec = Math.min(cmd.seconds ?? 60, MUTE_MAX_SEC);
      const r = await mute(callApi, { gid, uin: target, seconds: sec, reason: `主人指令 by ${ctx.uin}` });
      if (!r.ok) return { handled: true, reply: `禁不了：${r.reason}` };
      return { handled: true, reply: `禁了 ${Math.round(sec / 60)} 分钟` };
    }

    case 'recall': {
      if (!ctx.lastSentId) return { handled: true, reply: '刚才没说什么呀' };
      const r = await callApi('delete_msg', { message_id: Number(ctx.lastSentId) });
      const ok = r?.status === 'ok' || r?.retcode === 0;
      return { handled: true, reply: ok ? '撤了' : '撤不掉诶' };
    }

    case 'silence': {
      const min = Math.min(Math.max(1, Math.round((cmd.seconds ?? 600) / 60)), SILENCE_MAX_MIN);
      saveSilence(gid, { until: nowSec() + min * 60, by: String(ctx.uin), reason: '主人让闭嘴' });
      return { handled: true, reply: `好，我${min}分钟不说话` };
    }

    case 'wake': {
      clearSilence(gid);
      return { handled: true, reply: '来了来了' };
    }

    case 'search': {
      if (!cmd.arg) return { handled: true, reply: '查什么呀' };
      return { handled: true, action: 'search', arg: cmd.arg, reply: '' };
    }

    default:
      return { handled: false };
  }
}


/**
 * 通用「整首要完整版」检测（不限主人）
 * 命中就分段发整首，不经过模型
 * @returns {{query:string}|null}
 */
export function parseFullSong(text) {
  const t = String(text ?? '')
    .replace(/@\d+/g, ' ')
    .replace(/(小鲸鱼|鲸鱼)/g, ' ')
    .trim();
  if (!FULL_RE.test(t)) return null;
  // 「整首雨爱」这种没有动词也算；但纯「完整版」三个字要配动词才认
  const hasVerb = /(唱|来|放|听|要|点)/.test(t);
  const query = t
    .replace(/(唱|来一首|来一段|来首|来点|放首歌?|放个歌|点歌|放|听|要)/g, ' ')
    .replace(FULL_RE, ' ')
    .replace(/[《》"",，。、?？!！~～]/g, ' ')
    .replace(/(的|吧|呀|啊|嘛|呗|一下|给我|帮我)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!query && !hasVerb) return null;
  return { query, hasVerb };
}


// ── 点歌（谁都能点，不靠模型猜）──────────────────────────
//
// 为什么要确定性识别：模型会把"放生自己"当成"放生"这个玩笑，
// 而不是"放一首歌"。所以凡是"唱/放/来 + 内容"的，直接走扒歌流程。
//
// ⚠️ 2026-10-27 22:58 收紧：之前"放"后面跟什么都当歌名，
//    结果"放开我的token要炸了"被当成点歌，乱发语音。
//    现在加两道闸：① 歌名要过 sanity 检查 ② 光秃秃一个"放"必须是被叫到才算。

/** 明显不是歌的说法 */
const NOT_SONG = /^(屁|我|你|他|她|心|手|学|假|大|开|下|走|弃|肆|声|过|眼|在|了|吧|啊)$/;

/**
 * 歌名 sanity。宁可漏判，也不能乱发语音。
 * 一条消息 10 次里 9 次不是点歌，所以判错的代价远大于漏判。
 */
// 注意别把「了」放进来：「起风了」「后来」都是正经歌名。
// 真正的句子特征在下面 SENTENCE_WORDS 和标点上。
const SENTENCE_CHARS = /[我你他她它让说给话呢吧啊吗把被就都很还又]/;
/** 句首虚词：「的是大小姐」这种 */
const LEADING_PARTICLE = /^(的|是|了|在|有|会|能|要|想|说|给|把|被|都|也|还|又|很)/;
/** 句子里常见、但歌名里很少出现的词 */
const SENTENCE_WORDS = /(token|模型|号了|搞错|限制|封了|控制|怎么|为什么|是不是|能不能|可以|帮我|谢谢|哈哈|完蛋|额度|日志|发现|问题|刚才|现在|已经)/i;

function cleanSongText(text) {
  return String(text ?? '')
    .replace(/@[^\s]+/g, ' ')            // 去掉 @某人（可能是文本形式的 @昵称，不只是 CQ 段）
    .replace(/(小鲸鱼|鲸鱼)/g, ' ')
    .replace(/[《》「」"",，。、?？!！~～]/g, ' ')
    // 「唱下雨爱这首歌」→ 句尾的「这首歌」是口语，不是歌名的一部分
    .replace(/(这首歌|那首歌|这歌|那歌|这首|那首)\s*$/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 歌名是否像个歌名 */
function looksLikeTitle(q) {
  const v = String(q ?? '').trim();
  if (!v) return false;
  if (v.length < 2 || v.length > 20) return false;
  if (SENTENCE_CHARS.test(v)) return false;          // 含"我你他" → 是句子
  if (LEADING_PARTICLE.test(v)) return false;        // 「的是大小姐」
  if (SENTENCE_WORDS.test(v)) return false;          // 含 token/号了/封了 → 是句子
  // 带空格：纯 ASCII（Little Wish / Shape of You）放行，含中文的长句子拒绝
  if (/\s/.test(v)) {
    const ascii = /^[\x20-\x7E]+$/.test(v);
    if (!ascii) return false;
    if (v.length > 24) return false;
  }
  if (/[，。！？；、,.!?;]/.test(v)) return false;      // 有标点 → 是句子
  return true;
}

/** 纯闲聊，别当歌名 */
const CHATTER = /^(在吗|在不在|在么|你好|hi|hello|干嘛|在干啥|什么|怎么|为什么|为啥|是不是|能不能|可以|帮我|谢谢|哈哈|嗯|哦|好|行|对|是的)/i;

/**
 * @param {string} text
 * @param {{addressed?:boolean}} opts 是否被叫到（@我 / 叫小鲸鱼 / 主人）
 * @returns {{query:string, full:boolean}|null}
 */
export function parseSong(text, { addressed = false } = {}) {
  const t = cleanSongText(text);
  if (!t) return null;

  const full = /(完整版|整首歌|整首|全曲)/.test(t);
  // 先把"整首/完整版"这类词剥掉，剩下的才是歌名
  const body = t.replace(/(完整版|整首歌|整首|全曲)/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // ⓪ 「歌名是X」「歌曲名：《X》」——最不含糊的一种说法，必须优先认出来。
  // 2026-10-31 实测：「唱一首歌，歌名是人是猫」被当成闲聊 → 模型自己改唱《起风了》。
  const named = body.match(/(?:歌名|歌曲名|曲名|歌的名字)\s*(?:是|叫|为|：|:)?\s*《?([^》\s，。！？]{1,20})》?/);
  if (named?.[1]) {
    const q = named[1].trim();
    if (q && !NOT_SONG.test(q)) return { query: q, full };
  }

  // 「那你唱首X」「嗯你唱X」——句首的语气词/称呼会把动词顶离行首，先剥掉再匹配。
  // 2026-10-31 实测：「那你唱首忘情牛肉面」整句没进点歌流程，她回了句「在呢在呢，你听声音就知道」。
  const lead = body.replace(/^(那|那么|嗯|啊|诶|唉|哎|好|行|可以|你|您|就|快|赶紧|现在|给我|帮我|麻烦|对了|话说)+/, '').trim();
  const verbBody = lead || body;

  // ① 明确的点歌动词：唱 / 来一首 / 放首歌 / 点歌 / 放一首 …
  const explicit = verbBody.match(/^(唱一下|唱下|唱|来一首|来一段|来首|来点|放首歌|放个歌|放一首|放首|放一下|点歌)\s*(?:个|一首|首|一段|一下|点)?\s*(.*)$/);
  if (explicit) {
    const q = (explicit[2] ?? '').trim();
    if (!q) return full ? { query: '', full: true } : null;
    if (NOT_SONG.test(q) || !looksLikeTitle(q)) return null;
    return { query: q, full };
  }

  // ② 光秃秃一个"放"：只有被叫到才算
  const loose = verbBody.match(/^放\s*(?:个|一首|首|一段|一下)?\s*(.*)$/);
  if (loose && addressed) {
    const q = (loose[1] ?? '').trim();
    if (!q) return full ? { query: '', full: true } : null;
    if (NOT_SONG.test(q) || !looksLikeTitle(q)) return null;
    return { query: q, full };
  }

  // ③ 被叫到 + 只报歌名（"@小鲸鱼 不眠之夜" / "整首 不眠之夜"）
  if (addressed && body && looksLikeTitle(body) && !CHATTER.test(body) && body.length <= 12) {
    return { query: body, full };
  }

  return null;
}

/** 切档记一笔（方便回查谁什么时候切的） */
function auditStyle(gid, ctx, s) {
  try {
    appendFileSync(
      `${STORE}/groups/${gid}/audit.jsonl`,
      JSON.stringify({ ts: new Date().toISOString(), gid, uin: ctx.uin, name: ctx.name, style: s.style, intensity: s.intensity }) + '\n',
    );
  } catch { /* 记不上不影响 */ }
}

/**
 * 只认"找东西"的轻量解析（给非主人用）
 * 跟 parseCommand 的区别：只返回 find，别的一律 null，避免群友随口一句就被当成命令。
 */
export function parseLookup(text = '') {
  const raw = String(text ?? '')
    .replace(/@\d+/g, ' ')
    .replace(/^[\s,，。、:：]*(小鲸鱼|肥鱼大小姐|肥鱼|鲸鱼)[\s,，。、:：]*/, '')   // 先剥称呼
    .replace(/^[\s,，。、:：]+/, '')
    .trim();
  if (!raw || raw.length < 4) return null;
  if (!/(黄油|galgame|游戏|本子|里番|资源|漫画|画师|作品|壁纸)/i.test(raw)) return null;
  if (!/(找|搜|来个|来张|来点|搞个|弄个|推荐|求|要|整)/.test(raw)) return null;
  const cmd = parseCommand(raw);
  return cmd?.kind === 'find' ? cmd : null;
}

/**
 * 把「找个 X」里的 X 洗干净
 *   黄油来，要缩略图 → 黄油
 *   张壁纸          → 壁纸
 *   给我弄个本子     → 本子
 * 顺序有讲究：先去逗号后面的附加要求，再 trim，然后才剥前后缀
 * （先剥后缀再 trim 会剥不掉 —— 2026-10-29 踩过）
 */
export function cleanLookupArg(raw = '') {
  return String(raw ?? '')
    .replace(/[，,。；;、].*$/, ' ')
    .trim()
    .replace(/(要|给|带)?(缩略图|封面|截图|原图)/g, ' ')
    .replace(/^(个|一个|一张|一下|来|找|张)\s*/, ' ')
    .replace(/\s*(来|的|吧)$/, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
