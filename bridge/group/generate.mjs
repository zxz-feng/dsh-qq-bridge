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
import { styleBlock, styleShortPersona, getStyle } from './style.mjs';
import { buildContextBlock } from './context.mjs';
import { profileLine, toneHint, load as loadMember } from './members.mjs';
import { chat, usageLine } from './llm.mjs';
import { fullPersona, shortPersona, ANCHOR, personaVersion } from './persona.mjs';
import { shouldSearch, extractQuery, gather, hotwords } from './search.mjs';

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

  text = text.replace(/\[\[sticker[:：]\s*([^\]]+)\]\]/gi, (_, v) => { stickers.push(String(v).trim()); return ' '; });
  text = text.replace(/\[\[voice[:：]\s*([^\]]+)\]\]/gi, (_, v) => { voices.push(String(v).trim()); return ' '; });
  // [[sing:歌名]] —— 模型**自己**想唱时唯一能触发音频的标记（2026-10-28 加）
  text = text.replace(/\[\[sing[:：]\s*([^\]]+)\]\]/gi, (_, v) => { sings.push(String(v).trim()); return ' '; });

  const parts = text
    .split(/\|\|\|/)
    .map((x) => x.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxParts);   // 平时最多 2 条；长回答场景放到 4 条

  return { parts, stickers, voices, sings };
}

/**
 * 生成一条群回复
 * @param {object} o
 * @param {string} o.gid
 * @param {object} o.policy
 * @param {object} o.msg      {uin, name, text, atMe, images:[{url,desc}]}
 * @returns {Promise<{parts:string[], stickers:string[], voices:string[], model:string, usage:object, searched:boolean}>}
 */
export async function generate({ gid, policy = {}, msg }) {
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
  let searchBlock = '';
  let searched = false;
  if (shouldSearch(msg.text) && (policy.searchPerDay ?? 20) > 0) {
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
    useFull ? fullPersona() : (getStyle(gid).style === 'sunbar' ? styleShortPersona() : shortPersona()),
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
    return { parts: [], stickers: [], voices: [], sings: [], model, usage, searched, passed: true };
  }

  const { parts, stickers, voices, sings } = parseReply(
    raw.replace(/\[\[pass\]\]/gi, ''), { maxParts: wantsLong ? 4 : 2 },
  );

  state.turns += 1;
  state.pv = pv;
  savePersonaState(gid, state);

  return { parts, stickers, voices, sings, model, usage, searched };
}

export function contextTurns(gid) { return loadPersonaState(gid).turns; }
export { nowSec };
