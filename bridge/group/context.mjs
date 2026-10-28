/**
 * 群上下文：窗口 + 话题摘要
 *
 * 为什么不把全部消息塞给模型：
 *   一个 100 人群一天 2000 条，全塞进去既贵又没用。
 *   所以两层：
 *     L1 窗口 —— 最近 40 条原文，每次都说
 *     L2 摘要 —— 每 60 条压成 3 句，老消息只留摘要
 *
 * 摘要用 low 推理档、300 token 上限，成本可以忽略。
 */
import {
  appendWindow, readWindow, loadTopics, saveTopics, loadStats, saveStats, nowSec,
} from './store.mjs';
import { chat } from './llm.mjs';

const WINDOW_FOR_PROMPT = Number(process.env.GROUP_WINDOW ?? 40);
const SUMMARIZE_EVERY = Number(process.env.GROUP_SUMMARIZE_EVERY ?? 60);

/** 记一条消息进窗口 */
export function record(gid, entry) {
  appendWindow(gid, {
    ts: nowSec(),
    uin: String(entry.uin),
    name: entry.name ?? '',
    text: entry.text ?? '',
    kind: entry.kind ?? 'text',
  });
}

/** 取窗口里最近 n 条（给决策器和生成器用） */
export function recent(gid, n = WINDOW_FOR_PROMPT) {
  return readWindow(gid, n);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 组装给模型看的上下文块
 * @param {string} gid
 * @param {{memberLine?:string, tone?:string}} opts
 */
export function buildContextBlock(gid, opts = {}) {
  const topics = loadTopics(gid);
  const win = recent(gid, WINDOW_FOR_PROMPT);

  const parts = [];

  if (topics.length) {
    parts.push('【之前聊过什么】\n' + topics.map((t) => `- ${t.text}`).join('\n'));
  }

  if (win.length) {
    const lines = win.map((m) => {
      const who = m.uin === 'self' ? '你' : (m.name || m.uin);
      return `${fmtTime(m.ts)} ${who}: ${m.text}`;
    });
    parts.push('【最近群里的消息】\n' + lines.join('\n'));
  }

  if (opts.memberLine) {
    parts.push('【现在说话这个人】\n' + opts.memberLine
      + (opts.tone ? `\n${opts.tone}` : ''));
  }

  return parts.join('\n\n');
}

/**
 * 每 SUMMARIZE_EVERY 条消息压一次摘要（异步、可失败）
 * @returns {Promise<boolean>} 是否真的压了
 */
export async function maybeSummarize(gid) {
  const stats = loadStats(gid);
  const win = readWindow(gid, 200);
  const since = win.length - (stats.summarizedAt ?? 0);
  if (since < SUMMARIZE_EVERY) return false;

  const batch = win.slice(-SUMMARIZE_EVERY);
  const text = batch.map((m) => `${m.name || m.uin}: ${m.text}`).join('\n').slice(0, 4000);

  let out;
  try {
    const r = await chat([
      {
        role: 'system',
        content: '你在帮一个群聊机器人做记忆压缩。把下面这段群聊压成 3 条以内的摘要，'
          + '每条一句话、不超过 30 字，只写"谁在聊什么/发生了什么"，不要评价、不要寒暄。'
          + '另外如果里面有人说了值得长期记住的事（比如在准备考试、养了猫、换了工作），'
          + '用"记住："开头单独写一条。直接输出，不要编号以外的格式。',
      },
      { role: 'user', content: text },
    ], { maxTokens: 1200, temperature: 0.3, effort: 'low' });
    out = r.text;
  } catch (e) {
    console.error('  [group] 摘要失败:', e.message);
    return false;
  }

  const lines = out.split('\n').map((x) => x.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean);
  const topics = loadTopics(gid);
  for (const l of lines.slice(0, 4)) topics.push({ ts: nowSec(), text: l });
  saveTopics(gid, topics);

  stats.summarizedAt = win.length;
  saveStats(gid, stats);
  console.log(`  [group] 已压缩摘要 ${lines.length} 条（累计 ${topics.length}）`);
  return true;
}
