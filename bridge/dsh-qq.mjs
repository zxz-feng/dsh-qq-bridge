/**
 * QQ 好友 → DSH 生成回复
 *
 * 直接用网关 API（不走 dsh headless），原因：
 *   1. dsh headless 没有 --model 参数，无法避开模型冷却
 *   2. 每次启动进程要 40-120 秒，太慢
 *   3. 直接调网关可以自动 fallback 到可用模型
 *
 * 会话上下文自己维护（存在 sessions/<qq>.json）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { fullPersona, shortPersona, ANCHOR, personaVersion } from './persona-prompt.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const CTX_DIR = process.env.CONTEXTS_DIR || (DIR + 'contexts');
if (!existsSync(CTX_DIR)) mkdirSync(CTX_DIR, { recursive: true });

const GATEWAY = process.env.DSH_GATEWAY ?? 'http://127.0.0.1:8327/v1';  // 国际站
const API_KEY = process.env.WORKBUDDY_GATEWAY_API_KEY ?? 'wb-gateway-local';

// 按优先级尝试；冷却的会自动跳过
// 免费额度耗尽后网关会自动跨站代偿（8327 同时挂国际站+国内站账号），
// 因此这里只列真实存在的 id，按 免费 → 付费 顺序 fallback。
const TEXT_MODELS = (process.env.QQ_MODELS ?? 'deepseek-v4.1-flash,hy3,deepseek-v4-pro,deepseek-v3-2-volc').split(',');
const VISION_MODEL = process.env.VISION_MODEL ?? 'deepseek-v4.1-flash';
const REASONING_EFFORT = process.env.REASONING_EFFORT ?? 'max';   // 极致
const CONTEXT_WINDOW = 1000000;                                    // 1M
const REANCHOR_EVERY = Number(process.env.REANCHOR_EVERY ?? 8);     // 每 N 轮重发一次完整人设
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 12);
const MAX_CHARS = Number(process.env.MAX_CHARS ?? 500);

/** 读该好友的对话上下文（兼容旧的纯数组格式） */
function loadStore(qq) {
  try {
    const raw = JSON.parse(readFileSync(`${CTX_DIR}/${qq}.json`, 'utf8'));
    if (Array.isArray(raw)) return { pv: null, msgs: raw };
    if (raw && Array.isArray(raw.msgs)) return { pv: raw.pv ?? null, msgs: raw.msgs };
  } catch { /* 没文件 / 坏了 */ }
  return { pv: null, msgs: [] };
}

function loadContext(qq) { return loadStore(qq).msgs; }

function saveStore(qq, pv, msgs) {
  // 只保留最近 N 轮
  writeFileSync(`${CTX_DIR}/${qq}.json`, JSON.stringify({ pv, msgs: msgs.slice(-MAX_TURNS * 2) }, null, 2));
}

/** 调网关，自动 fallback */
async function chat(messages, { maxTokens = 4000, temperature = 0.7 } = {}) {
  const errors = [];
  for (const model of TEXT_MODELS) {
    try {
      const res = await fetch(`${GATEWAY}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model, messages, max_tokens: maxTokens, temperature,
          reasoning_effort: REASONING_EFFORT,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const t = await res.text();
        errors.push(`${model}: HTTP ${res.status}`);
        continue;
      }
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content?.trim();
      if (text) return { text, model };
      errors.push(`${model}: 空回复`);
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }
  throw new Error('所有模型都失败: ' + errors.join(' | '));
}

/** 图片/表情包识别 */
async function describeImageUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    const png = await sharp(buf).resize(384, 384, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const r2 = await fetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这是 QQ 聊天里的表情包或图片，用 20 字以内中文描述画面内容和情绪，不加引号。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          ],
        }],
        max_tokens: 80,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r2.ok) return null;
    const j = await r2.json();
    return j?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) {
    console.error('[vision]', e.message);
    return null;
  }
}

// 人设见 persona-prompt.mjs（来自 persona/renshe.txt）

/**
 * 为某好友生成回复
 * @param {string} qq       好友 QQ 号
 * @param {string} incoming 已解析的文本
 * @param {Array}  images   图片 [{url,file,sticker}]
 */
export async function askDshFor(qq, incoming, images = []) {
  // 图片识别（最多 2 张，控成本）
  let imageDesc = '';
  if (images.length > 0) {
    for (const img of images.slice(0, 2)) {
      const d = await describeImageUrl(img.url);
      if (d) imageDesc += `\n[对方发的${img.sticker ? '表情包' : '图片'}：${d}]`;
    }
  }

  const userText = (incoming + imageDesc).slice(0, MAX_CHARS);
  const store = loadStore(qq);
  const ctx = store.msgs;
  const pv = personaVersion();
  const turns = Math.floor(ctx.length / 2);          // 已完成轮数
  const isFirstContact = ctx.length === 0;
  const needReanchor = turns > 0 && turns % REANCHOR_EVERY === 0;
  // 你改了 persona/*.txt → 这个会话下一句补一次完整人设，之后回到精简
  const personaChanged = store.pv !== pv;

  const useFull = isFirstContact || needReanchor || personaChanged;
  const messages = [
    { role: 'system', content: useFull ? fullPersona() : shortPersona() },
    ...ctx,
    { role: 'user', content: userText },
    // 近因锚定：每轮都在生成前最后强化一次身份
    { role: 'system', content: ANCHOR },
  ];

  if (isFirstContact) console.log(`  [qq] ${qq} 首次对话 → 完整人设`);
  else if (personaChanged) console.log(`  [qq] ${qq} 人设已改动 → 补发完整人设`);
  else if (needReanchor) console.log(`  [qq] ${qq} 第 ${turns} 轮 → 重锚完整人设`);

  const { text: raw, model } = await chat(messages);
  // 压掉多余换行与空白，QQ 单条消息更自然
  const text = raw.replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
  console.log(`  [qq] 模型 ${model}`);

  // 存上下文（只存对话，不含 system；人设不进上下文，所以不会累积膨胀）
  ctx.push({ role: 'user', content: userText });
  ctx.push({ role: 'assistant', content: text });
  saveStore(qq, pv, ctx);

  return text;
}

export function contextFor(qq) {
  return loadContext(qq);
}
