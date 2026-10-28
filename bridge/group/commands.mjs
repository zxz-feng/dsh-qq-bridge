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
import { setStyle, getStyle, STYLE_NAMES } from './style.mjs';
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
    // 孙吧模式开关（只有主人能调；顺序：关 → 开 → 查，反了会把「关掉孙吧」认成「开」）
    { kind: 'sunbar_off', re: /(?:关|关闭|退出|停|收|别)\s*(?:掉|了)?\s*(?:孙吧|孙笑川|嘴臭|嘴毒|抽象)/ },
    { kind: 'sunbar_on', re: /(?:开|打开|开启|启动|进入|上|来)\s*(?:个|一下)?\s*(?:孙吧|孙笑川|嘴臭|嘴毒|抽象)/ },
    { kind: 'sunbar_status', re: /^(?:孙吧|孙笑川|嘴臭|嘴毒)(?:模式)?\s*(?:状态|开着|开了|开了吗|在不在)?[?？]?$/ },
    // 「帮我找个 X」——找资源 +（要图的话）带缩略图
    { kind: 'find', re: /^(?:[帮给][\u4e00-\u9fa5A-Za-z0-9_]{0,10}?|替我|求|要)?(?:找|搜|搞|弄|来|推荐|整)(?:个|一个|一张|一下|一找)?\s*(.{2,30})$/ },
    { kind: 'sing', re: /^(唱|来一段|来首|来点|放首歌?|放个歌|点歌|放)\s*(?:个|一首|首|一段|一下|点)?\s*(.*)$/ },
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
    const arg = (m[2] ?? m[1] ?? '').trim();
    // ⚠️ 歌名要过 sanity 检查：否则"放开我的token要炸了"会被当成点歌
    const bare = arg.replace(FULL_RE, ' ').trim();
    // find 只在"确实是在找东西"时才认（不然"来找我"这种会被当成搜东西）
    if (kind === 'find' && !/(黄油|galgame|游戏|本子|里番|资源|漫画|画师|作品|图|封面|缩略图|壁纸)/i.test(t)) return null;
    // ⚠️ 只有需要"歌名/关键词"的命令才过这个检查；
    //    不然别的规则（孙吧开关之类）捕获到什么都会被当成歌名判掉（2026-10-28 踩过）
    if ((kind === 'sing' || kind === 'search') && bare && !looksLikeTitle(bare)) return null;
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
    // ── 孙吧模式（2026-10-28）──
    // 主人一句话就切，不用改配置文件。切了之后：语气换成孙吧老哥、
    // 决策器更爱接话（×4）、每轮多 90 字风格提醒（完整说明只在完整人设那轮发）。
    case 'sunbar_on': {
      const cur = getStyle(gid);
      if (cur.style === 'sunbar') return { handled: true, reply: '早就开着呢，还要再开一遍？' };
      const s = setStyle(gid, 'sunbar', { by: ctx.uin, intensity: /重|狠|猛/.test(cmd.raw ?? '') ? 'heavy' : 'mid' });
      auditStyle(gid, ctx, s);
      const lines = ['行，那我可不客气了', '从现在起嘴不饶人，别喊停'];
      return { handled: true, reply: lines.join(' ||| ') };
    }

    case 'sunbar_off': {
      const cur = getStyle(gid);
      if (cur.style !== 'sunbar') return { handled: true, reply: '本来就没开' };
      const s = setStyle(gid, 'normal', { by: ctx.uin });
      auditStyle(gid, ctx, s);
      return { handled: true, reply: '行行行，收着点 ||| 刚才说的别当真啊' };
    }

    case 'sunbar_status': {
      const cur = getStyle(gid);
      return {
        handled: true,
        reply: cur.style === 'sunbar'
          ? `开着（强度 ${cur.intensity === 'heavy' ? '重' : '中'}，${cur.by ? '主人' : '默认'}切的）`
          : '没开，正常营业',
      };
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

  // ① 明确的点歌动词：唱 / 来一首 / 放首歌 / 点歌 / 放一首 …
  const explicit = body.match(/^(唱|来一首|来一段|来首|来点|放首歌|放个歌|放一首|放首|点歌)\s*(?:个|一首|首|一段|一下|点)?\s*(.*)$/);
  if (explicit) {
    const q = (explicit[2] ?? '').trim();
    if (!q) return full ? { query: '', full: true } : null;
    if (NOT_SONG.test(q) || !looksLikeTitle(q)) return null;
    return { query: q, full };
  }

  // ② 光秃秃一个"放"：只有被叫到才算
  const loose = body.match(/^放\s*(?:个|一首|首|一段|一下)?\s*(.*)$/);
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
