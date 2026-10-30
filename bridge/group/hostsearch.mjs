/**
 * hostsearch.mjs —— 找宿主（DSH）借联网搜索
 * ============================================================================
 * 桥是独立子进程，`ctx.web`（DSH 的联网搜索 / 网页抓取）在宿主进程里，桥够不着。
 * 所以父进程开了个只绑 127.0.0.1 的小门（`lib/host-api.mjs`），把地址和 token
 * 通过 `HOST_API_URL` / `HOST_API_TOKEN` 塞给桥。这个文件是桥这边的客户端。
 *
 * 三条原则：
 *   1. **拿不到就返回 null**，绝不抛错 —— 调用方（search.mjs）照常走自己的源。
 *   2. **超时短**：18s。宿主那边再慢也不能把群消息卡住。
 *   3. **不重试**：搜索是一次性的，重试只会让群友等更久；失败就当没有。
 *
 * 装了搜索插件（并且配了 key）→ 这里能用上真·联网搜索；
 * 没装 / 没配 → 返回 null，退回 DDG lite + 维基 + B站。
 * ============================================================================
 */

// 每次调用现读环境变量：子进程启动后父进程不会再改，但这样测试和热改配置都方便
const base = () => String(process.env.HOST_API_URL ?? '').replace(/\/+$/, '');
const token = () => String(process.env.HOST_API_TOKEN ?? '');

/** 宿主小门在不在（装没装搜索插件都可能是 true） */
export function hostAvailable() { return Boolean(base() && token()); }

async function call(path, body, timeoutMs) {
  if (!hostAvailable()) return null;
  try {
    const r = await fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.ok ? j.data : null;
  } catch {
    return null; // 小门没起 / 宿主忙 / 超时 —— 都不算故障
  }
}

/**
 * 借宿主的联网搜索。
 * @returns {Promise<{answer:string, sources:Array<{url,title,snippet}>}|null>}
 */
export async function hostSearch(query, maxResults = 5) {
  const d = await call('/search', { query, maxResults }, 18000);
  if (!d) return null;
  const sources = Array.isArray(d.sources)
    ? d.sources.filter((s) => s && s.url).map((s) => ({
      url: String(s.url),
      title: String(s.title ?? '').slice(0, 160),
      snippet: String(s.snippet ?? '').slice(0, 240),
    }))
    : [];
  const answer = String(d.answer ?? '').slice(0, 1200);
  if (!sources.length && !answer) return null;
  return { answer, sources };
}

/** 借宿主的网页抓取（正文，已截断） */
export async function hostFetch(url) {
  const d = await call('/fetch', { url }, 18000);
  if (!d?.text) return null;
  return { url: String(d.url ?? url), statusCode: Number(d.statusCode ?? 0), text: String(d.text) };
}

/**
 * 借宿主的嗓子（dsh-voice 插件）。
 * @returns {Promise<{path:string, ms:number, cached:boolean}|null>} 拿不到就 null
 */
export async function hostSpeak(text, preset) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  return call('/voice', { text: t, preset }, 12000);
}
