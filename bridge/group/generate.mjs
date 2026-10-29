/**
 * 群聊生成
 *
 * 和私聊的区别：
 *   ① 上下文不是"我和他"，是"群里发生了什么"（窗口 + 摘要）
 *   ② 要带"现在说话这个人是谁、跟他什么关系"
 *   ③ 输出可以带动作标记：[[sticker:情绪]] / [[voice:歌名]]
 *   ④ 需要查资料时先搜再生成（规则触发，不是模型自己决定）
 *
 * 人设分层：首次 / 每 8 次发言 / 设定改动 → 完整人设；其余 → 精简。
 * 上下文里从不存 system，所以人设不会随轮数膨胀。
 */
import { readJson, writeJson, STORE, nowSec, bumpStat } from './store.mjs';
import { styleBlock, styleShortPersona } from './style.mjs';
import { buildContextBlock } from './context.mjs';
import { profileLine, toneHint, load as loadMember } from './members.mjs';
import { chat, usageLine } from './llm.mjs';
import { fullPersona, shortPersona, ANCHOR, personaVersion } from './persona.mjs';
import { shouldSearch, extractQuery, gather, hotwords } from './search.mjs';
import { fetchPage, pageBlock, extractUrl } from './webpage.mjs';
import { searchPosts } from './tieba.mjs';
import { lookupInfo, lookupCv } from './lookup.mjs';
import { findPicture } from './findpic.mjs';

const MAX_TURNS_CTX = Number(process.env.GROUP_CTX_TURNS ?? 20);
const REANCHOR_EVERY = Number(process.env.GROUP_REANCHOR_EVERY ?? 8);
const MAX_CHARS = Number(process.env.GROUP_MAX_CHARS ?? 300);

function personaStatePath(gid) { return `${STORE}/groups/${gid}/persona.json`; }

function loadPersonaState(gid) {
  return readJson(personaStatePath(gid), { pv: null, turns: 0 });
}

function savePersonaState(gid, s) {
  writeJson(personaStatePath(gid), s);
}

/** 解析模型输出里的动作标记 */
export function parseReply(raw, { maxParts = 2 } = {}) {
  let text = String(raw ?? '');
  const stickers = [];
  const voices = [];
  const sings = [];
  const reads = [];   // [[read:URL]]   去读这个链接
  const infos = [];   // [[info:关键词]] 去查这个是什么
  const looks = [];   // [[look:关键词]] 去找一张图
  const tiebas = [];  // [[tieba:关键词]] 去贴吧搜帖子（当搜索引擎用）

  text = text.replace(/\[\[sticker[:：]\s*([^\]]+)\]\]/gi, (_, v) => { stickers.push(String(v).trim()); return ' '; });
  text = text.replace(/\[\[voice[:：]\s*([^\]]+)\]\]/gi, (_, v) => { voices.push(String(v).trim()); return ' '; });
  // [[sing:歌名]] —— 模型**自己**想唱时唯一能触发音频的标记（2026-10-28 加）
  text = text.replace(/\[\[sing[:：]\s*([^\]]+)\]\]/gi, (_, v) => { sings.push(String(v).trim()); return ' '; });
  text = text.replace(/\[\[read[:：]\s*([^\]]+)\]\]/gi, (_, v) => { reads.push(String(v).trim()); return ' '; });
  text = text.replace(/\[\[info[:：]\s*([^\]]+)\]\]/gi, (_, v) => { infos.push(String(v).trim()); return ' '; });
  text = text.replace(/\[\[look[:：]\s*([^\]]+)\]\]/gi, (_, v) => { looks.push(String(v).trim()); return ' '; });
  text = text.replace(/\[\[tieba[:：]\s*([^\]]+)\]\]/gi, (_, v) => { tiebas.push(String(v).trim()); return ' '; });

  const parts = text
    .split(/\|\|\|/)
    .map((x) => x.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxParts);   // 平时最多 2 条；长回答场景放到 4 条

  return { parts, stickers, voices, sings, reads, infos, looks, tiebas };
}

/**
 * 执行模型自己发起的工具请求（最多两个，宁少不滥）
 * @returns {Promise<{blocks:string[], pictures:object[], used:string[]}>}
 */

/**
 * 从上下文里认语境，给贴吧搜索当消歧词（2026-10-29 用户点名的问题）：
 * 群里聊「乌有乡」明显是黄油，光搜两个字搜回来一堆《幽灵行动断点》的地图帖。
 * 所以搜之前先看看上下文在聊什么门类，把词带上。
 */
const HINT_RULES = [
  [/\b(galgame|gal|eroge|avg|adv|视觉小说|文字冒险)\b/i, 'galgame'],
  [/(黄油|拔作|r18|18禁|hgame|h game|色情|涩涩|cg包|汉化|生肉|熟肉|立绘|cg|拔作|重口|纯爱|ntr|钟表社|clockup)/i, 'galgame'],
  [/(里番|番剧|动画|新番|番名|ova)/i, '动画'],
  [/(轻小说|小说|文库|web文)/i, '轻小说'],
  [/(单机|主机|ps5|switch|steam|游戏|手游|抽卡|二游)/i, '游戏'],
  [/(漫画|条漫|本子|同人志)/i, '漫画'],
  [/(表情包|梗图|头像|壁纸)/i, '表情包'],
];

export function pickHint(...texts) {
  const all = texts.filter(Boolean).join(' ');
  for (const [re, tag] of HINT_RULES) if (re.test(all)) return tag;
  return '';
}

async function runTools({ reads, infos, looks, tiebas = [], hint = '' }) {
  const blocks = [];
  const pictures = [];
  const used = [];
  let budget = 2;

  for (const u of reads.slice(0, 1)) {
    if (budget <= 0) break;
    budget -= 1;
    const r = await fetchPage(u);
    blocks.push(pageBlock(r));
    used.push('read:' + u.slice(0, 40));
    if (r.ok) console.log(`  [tool] 读了 ${r.site}「${String(r.title ?? '').slice(0, 24)}」${r.text.length} 字`);
    else console.log(`  [tool] 读不了 ${u.slice(0, 40)}：${r.reason}`);
  }

  for (const q of infos.slice(0, 1)) {
    if (budget <= 0) break;
    budget -= 1;
    const cvOnly = /(cv|声优|配音)/i.test(q) && q.length <= 20;
    const r = cvOnly ? await lookupCv(q.replace(/(的)?(cv|声优|配音)/gi, '').trim() || q) : await lookupInfo(q);
    blocks.push(r.block || `\n【查「${q}」没查到】`);
    used.push('info:' + q.slice(0, 30));
    // 查资料的结果本身就是最好的语境：萌娘/VNDB 说这是 galgame，
    // 那后面搜贴吧就带上这个词，不用等上下文里有人提「黄油」。
    if (!hint && /galgame|エロ|エレホン|视觉小说|18禁|eroge/i.test(String(r.block || ''))) hint = 'galgame';
    console.log(`  [tool] 查了「${q}」${r.ok ? '' : '（没查到）'}`);
  }

  for (const q of tiebas.slice(0, 1)) {
    if (budget <= 0) break;
    budget -= 1;
    const r = await searchPosts(q);
    let items = r.ok ? r.items : [];
    let query = q;

    // 语境消歧：搜「乌有乡」会撞上《幽灵行动断点》的地图帖，带上「galgame」才对。
    if (items.length && hint) {
      const hit = items.filter((x) => new RegExp(hint, 'i').test(`${x.title} ${x.forum} ${x.content}`));
      if (hit.length < 2) {
        const r2 = await searchPosts(`${q} ${hint}`);
        if (r2.ok && r2.items.length) {
          const seen = new Set(items.map((x) => x.tid));
          items = [...hit, ...r2.items.filter((x) => !seen.has(x.tid)), ...items];
          query = `${q} ${hint}`;
          console.log(`  [tool] 贴吧语境补搜「${query}」→ ${r2.items.length} 条`);
        }
      } else {
        items = [...hit, ...items.filter((x) => !hit.includes(x))];
      }
    }

    if (items.length) {
      const lines = items.slice(0, 6).map((x, i) =>
        `${i + 1}. 《${x.title}》${x.forum ? `（${x.forum}吧）` : ''}${x.content && x.content !== x.title ? `：${x.content.slice(0, 70)}` : ''}`);
      blocks.push(`\n【我在贴吧搜了「${query}」，找到 ${items.length} 条】\n${lines.join('\n')}`);
      used.push('tieba:' + q.slice(0, 30));
      console.log(`  [tool] 贴吧搜「${query}」→ ${items.length} 条`);
    } else {
      blocks.push(`\n【我在贴吧搜了「${q}」，没搜到】${r.reason ? `（${r.reason}）` : ''}`);
      console.log(`  [tool] 贴吧搜「${q}」没结果：${r.reason || ''}`);
    }
  }

  for (const q of looks.slice(0, 1)) {
    if (budget <= 0) break;
    budget -= 1;
    const r = await findPicture(q);
    used.push('look:' + q.slice(0, 30));
    if (r.ok) {
      pictures.push({ url: r.url, caption: r.caption, from: r.from, kind: r.kind });
      blocks.push(`\n【我找到一张图（${r.from}）：${r.caption || q}。系统会把它发出去，你就说一句"找着了"之类，别描述图里的细节】`);
      console.log(`  [tool] 找到图 ${r.from} ${String(r.url).slice(0, 60)}`);
    } else {
      blocks.push(`\n【我去找「${q}」的图，没找到：${r.reason}。照实说找不到，别编】`);
      console.log(`  [tool] 找图失败 ${q}：${r.reason}`);
    }
  }

  return { blocks, pictures, used };
}

/**
 * 生成一条群回复
 * @param {object} o
 * @param {string} o.gid
 * @param {object} o.policy
 * @param {object} o.msg      {uin, name, text, atMe, images:[{url,desc}]}
 * @returns {Promise<{parts:string[], stickers:string[], voices:string[], model:string, usage:object, searched:boolean}>}
 */
export async function generate({ gid, policy = {}, msg, depth = 0, extra = '' }) {
  const pv = personaVersion();
  const state = loadPersonaState(gid);
  const isFirst = state.turns === 0;
  const needReanchor = state.turns > 0 && state.turns % REANCHOR_EVERY === 0;
  const personaChanged = state.pv !== pv;
  const useFull = isFirst || needReanchor || personaChanged;

  const member = loadMember(msg.uin);
  const memberLine = profileLine(msg.uin, msg.name);
  const tone = toneHint(msg.uin);

  // ── 要不要先搜 ──
  let searchBlock = extra || '';
  let searched = Boolean(extra);
  if (depth === 0 && shouldSearch(msg.text) && (policy.searchPerDay ?? 20) > 0) {
    const q = extractQuery(msg.text);
    if (q.length >= 2) {
      try {
        const r = await gather(q);
        if (r.hasResult) {
          searchBlock = `\n\n【我刚刚查到的（可以用，但要用自己的话讲，别照念）】\n${r.block}`;
          searched = true;
          bumpStat(gid, 'search');
          console.log(`  [group] 已搜「${q}」来源 ${r.sources.join('/')}${r.cached ? '（缓存）' : ''}`);
        } else {
          searchBlock = '\n\n【我查了一下，什么都没搜到。照实说不知道，别编。】';
          searched = true;
        }
      } catch (e) {
        console.error('  [group] 搜索失败:', e.message);
      }
    }
  }

  // ── 热词（让模型知道最近流行什么）──
  let hotLine = '';
  try {
    const hw = await hotwords();
    if (hw.length) hotLine = `\n\n【B站最近的热词（供参考，不要硬凑）】${hw.slice(0, 15).join('、')}`;
  } catch { /* 热词拿不到不影响 */ }

  const ctxBlock = buildContextBlock(gid, { memberLine, tone });

  // 长回复场景：被要求解释/推荐/讲讲时，把字数限制放开
  const LONG_RE = /(推荐|讲讲|说说|介绍|解释|科普|详细|为什么|怎么办|怎么写|怎么弄|攻略|教程|书单|清单|总结|分析|对比|区别|原理|流程|步骤)/;
  const wantsLong = LONG_RE.test(msg.text);

  // 风格档（孙吧模式等）：完整说明只在完整人设那轮发，平时一行压缩版
  const st = styleBlock(gid, { full: useFull });

  const system = [
    // 风格档自带精简人设（傲娇/冷淡/孙吧各有各的），normal 档返回空串 → 用默认那句
    useFull ? fullPersona() : (styleShortPersona(gid) || shortPersona()),
    '',
    '【输出规则】',
    wantsLong
      ? '- 这个问题需要说清楚：可以写 60~200 字，分 2~4 条（用 ||| 分隔），把关键点讲明白，别挤成一句'
      : '- 直接给要发的正文，1~20 字，最多两条（用 ||| 分隔）',
    '- 想配表情包：最后单独一行 [[sticker:情绪词]]（只能偶尔用）',
    '- 有人点歌/让你唱歌：系统自己会去扒音频发出去，你不用写标记，接一句就行。',
    '- 但**你自己想唱**（被要求"整个活"、自己想秀一段）：必须在回复里写 [[sing:歌名]]，系统才会真的放。'
      + '没有这个标记就**绝对不要说"唱首歌""这就来"**——说了做不到，主人会来问的。',
    '- 如果下面给了【我刚刚查到的】：挑关键的一两句说清楚那是什么，别只说"我知道""听过"',
    depth === 0
      ? '- **需要看东西/查东西时自己动手，别让人自己去查**：\n'
        + '  · 有人发了链接、或你要引用某个页面 → 写 [[read:链接]]（系统会去读，下一轮你就有正文了）\n'
        + '  · 被问"这是谁/什么游戏/谁配的音" → 写 [[info:关键词]]（系统查萌娘百科+VNDB）\n'
        + '  · 有人要某角色/某作品的图 → 写 [[look:关键词]]（系统去找图并发出来）\n'
        + '  一轮最多两个标记；标记会被系统吃掉，不要在正文里解释它'
      : '- 材料已经在上面了：用你自己的话回答，**不要再写任何 [[...]] 标记**；查不到就说查不到',
    '- [[tieba:关键词]] 去贴吧搜帖子。想知道「有没有人讨论过 / 网友怎么说 / 攻略 / 这个梗哪来的」，就用它；'
      + '不用等别人给链接，你自己搜。**关键词要带语境**：群里聊的是黄油，就写「乌有乡 galgame」而不是光写「乌有乡」'
      + '（光写两个字会搜回来一堆同名游戏地图帖）；聊的是动画就带上「动画」。',
    '- [[pass]] 只能用在"这条根本不是跟你说话"的时候（群里别人互聊、你插不上嘴）。',
    '  被 @、被叫名字、被回复时**绝对不能 pass**，哪怕只是回一句"这个我不干哦"。',
    '- 不想接、被要求做不该做的事（骂人、冒充、发广告）：用一句短话温柔挡回去，不要沉默。',
  ].join('\n') + (st ? '\n\n' + st : '');

  const userContent = `${ctxBlock}${searchBlock}${hotLine}\n\n【现在这条】${msg.name || msg.uin}: ${String(msg.text).slice(0, MAX_CHARS)}`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
    { role: 'system', content: ANCHOR },
  ];

  const effort = useFull ? 'max' : 'low';
  const { text: raw, model, usage } = await chat(messages, {
    maxTokens: wantsLong ? 1600 : 800, temperature: 0.9, effort,
  });

  console.log(`  [group] ${model} | 人设${useFull ? '全' : '简'} | ${usageLine(usage, effort)}`
    + (searched ? ' | 已联网' : ''));

  if (/\[\[pass\]\]/i.test(raw) && raw.replace(/\[\[pass\]\]/gi, '').trim().length < 3) {
    return { parts: [], stickers: [], voices: [], sings: [], reads: [], infos: [], looks: [], tiebas: [], pictures: [], model, usage, searched, passed: true };
  }

  const parsed = parseReply(raw.replace(/\[\[pass\]\]/gi, ''), { maxParts: wantsLong ? 4 : 2 });

  // ── 工具回合（只跑一跳，避免无限套娃）──
  if (depth === 0) {
    // 自动读链接只在"这条是冲她来的"时做：点名叫她、回复她，或者整条就是个链接。
    // 否则群里刷屏的长文里随便一个链接都要抓一次（9 秒超时 + 多一次生成），太亏。
    const autoUrl = extractUrl(msg.text);
    const worthAuto = autoUrl && (msg.atMe || msg.replyToMe || String(msg.text).trim().length <= 60);
    const reads = parsed.reads.length ? parsed.reads : (worthAuto ? [autoUrl] : []);
    if (reads.length || parsed.infos.length || parsed.looks.length || parsed.tiebas.length) {
      const { blocks, pictures, used } = await runTools({
        reads, infos: parsed.infos, looks: parsed.looks, tiebas: parsed.tiebas,
        hint: pickHint(ctxBlock, msg.text),
      });
      if (blocks.length) {
        const r2 = await generate({ gid, policy, msg, depth: 1, extra: '\n' + blocks.join('\n') });
        return { ...r2, pictures, tools: used, searched: true };
      }
    }
  }

  const { parts, stickers, voices, sings } = parsed;

  state.turns += 1;
  state.pv = pv;
  savePersonaState(gid, state);

  return { parts, stickers, voices, sings, reads: [], infos: [], looks: [], pictures: [], model, usage, searched };
}

export function contextTurns(gid) { return loadPersonaState(gid).turns; }
export { nowSec };
