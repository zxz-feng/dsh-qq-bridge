/**
 * 轻量 LLM 封装（群聊专用）
 *
 * 和 dsh-qq.mjs 里那份是同一套网关逻辑，但多两个能力：
 *   ① 可以指定 reasoning_effort（摘要用 low，回复用配置值）
 *   ② 返回 usage，方便看每轮花多少 token
 */
const GATEWAY = process.env.DSH_GATEWAY ?? 'http://127.0.0.1:8327/v1';
const API_KEY = process.env.WORKBUDDY_GATEWAY_API_KEY ?? 'wb-gateway-local';

const TEXT_MODELS = (process.env.QQ_MODELS ?? 'deepseek-v4.1-flash,hy3,deepseek-v4-pro,deepseek-v3-2-volc').split(',');

/**
 * @param {Array} messages
 * @param {{maxTokens?:number, temperature?:number, effort?:string, timeoutMs?:number}} opts
 */
/** 发一次请求，返回 { text, finish, usage } */
async function once(model, messages, { maxTokens, temperature, effort, timeoutMs }) {
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (effort) body.reasoning_effort = effort;
  const res = await fetch(`${GATEWAY}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const c = j?.choices?.[0];
  return { text: c?.message?.content?.trim() ?? '', finish: c?.finish_reason ?? '', usage: j?.usage ?? null };
}

/**
 * 对话
 *
 * ⚠️ 2026-10-28 踩到的坑：**推理档会吃掉 token 预算**。
 *   `reasoning_effort: low` + `max_tokens: 300` 实测 300 token 全进了 thinking，
 *   `finish_reason=length`、`content` 是空字符串 —— 换 4 个模型都是"空回复"，
 *   看起来像网关/额度坏了，其实是预算不够（国际站 flash 额度是好的）。
 *   ⇒ 两处一起治：
 *     ① 空内容且 finish_reason=length 时，**去掉推理档**再试一次（实测无推理档 300 token 够用）；
 *     ② 摘要/判断这类短任务的上限调到 600~1200（见各调用点）。
 */
export async function chat(messages, {
  maxTokens = 2000, temperature = 0.8, effort = 'low', timeoutMs = 45000,
} = {}) {
  const errors = [];
  for (const model of TEXT_MODELS) {
    try {
      let r = await once(model, messages, { maxTokens, temperature, effort, timeoutMs });
      if (!r.text && r.finish === 'length') {
        // 预算被 thinking 吃光了：去掉推理档重试，顺手给三倍额度
        r = await once(model, messages, {
          maxTokens: Math.min(Math.max(maxTokens * 3, 600), 4000),
          temperature, effort: undefined, timeoutMs,
        });
        if (r.text) errors.push(`${model}: 推理档吃满预算，已降级重试`);
      }
      if (r.text) return { text: r.text, model, usage: r.usage };
      errors.push(`${model}: 空回复(finish=${r.finish || '?'})`);
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }
  throw new Error('所有模型失败: ' + errors.join(' | '));
}

/** 拼一行用量，方便日志 */
export function usageLine(usage, effort) {
  const u = usage ?? {};
  const think = u.completion_tokens_details?.reasoning_tokens ?? 0;
  const cached = u.prompt_cache_hit_tokens ?? 0;
  return `推理${effort} 入${u.prompt_tokens ?? '?'}(缓存${cached}) 出${u.completion_tokens ?? '?'}(想${think})`;
}
