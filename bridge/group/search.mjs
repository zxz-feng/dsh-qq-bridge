/**
 * 搜梗 / 查资料
 *
 * ⚠️ 实测结论（2026-10-27）：这台机器能用的搜索源很有限
 *   ✅ B站搜索       —— 中文网络梗最好的来源（标题+简介+评论就是解释）
 *   ✅ B站热词       —— 每天拉一次，缓存本地
 *   ✅ 维基百科 API  —— 通用知识、人物、事件
 *   ❌ DuckDuckGo    —— 202 反爬（anomaly-modal）
 *   ❌ Bing HTML     —— 返回 JS 空壳；Bing RSS 返回不相干内容
 *   ❌ 百度/360/搜狗 —— 安全验证 / JS challenge
 *   ❌ Google        —— JS 空壳
 *   ❌ SearXNG 公共实例 —— 浏览器验证 / 429
 *
 * 所以策略是：**B站为主，维基为辅**，DDG 作为机会性补充（能通就用，不通静默跳过）。
 * 不硬编任何会 404 的源，也不假装搜到了。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, STORE, todayKey } from './store.mjs';

const exec = promisify(execFile);

const PROXY = process.env.SOCKS_HTTP_PROXY ?? 'http://127.0.0.1:17890';
// 没配就说明没装 B站那个 python 环境 —— 搜索会退到「只用网页/维基」，不报错
const PY = process.env.BILI_PY || '';
// ⚠️ 必须用 fileURLToPath：路径里有中文（工位），.pathname 会返回 %E5%B7%A5... 导致脚本找不到
const BILI_TOOL = fileURLToPath(new URL('../tools/bili.py', import.meta.url));

const CACHE_FILE = `${STORE}/search-cache.json`;
const HOT_FILE = `${STORE}/hotwords.json`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── 要不要搜（规则，零 token）──────────────────────────────

const SEARCH_HINTS = new RegExp(
  '(什么意思|啥意思|什么梗|啥梗|是谁|哪来的|为什么|为啥|怎么读|多少钱|最新|查一下|搜一下'
  + '|这是啥|这啥|什么来头|出处|什么歌|哪部'
  + '|什么时候|哪一年|哪年|几月|发布|上线|成立于|创始人|多大|那天的|发生了'
  + '|新闻|消息|最近|现在|今年|去年|目前|怎么来的|哪里来的|什么来历|有吗|有没有)',
);

/** 这条消息值不值得联网搜 */
export function shouldSearch(text = '') {
  if (!text || text.length < 4) return false;
  return SEARCH_HINTS.test(text);
}

/** 从"XX是什么意思"里抽出真正要搜的词 */
export function extractQuery(text = '') {
  return String(text)
    .replace(/[?？!！。，,、~～]/g, ' ')
    .replace(/(小鲸鱼|你知道|知不知道|帮我|帮忙|请问|能不能|可以|查一下|搜一下)/g, ' ')
    .replace(/(是什么意思|是什么梗|什么梗|啥意思|啥梗|是什么|这是啥|这啥|出处|什么来头|吗|啊|呀|呢|吧)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 60);
}

// ── 底层 ────────────────────────────────────────────────

async function curl(url, { timeoutMs = 15000, proxy = true, ua = UA } = {}) {
  const args = ['-sL', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-A', ua,
    '-H', 'Accept-Language: zh-CN,zh;q=0.9'];
  if (proxy) args.push('-x', PROXY);
  args.push(url);
  const { stdout } = await exec('curl', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── B站 ─────────────────────────────────────────────────

function runBili(args, timeout = 25000) {
  // 没装那个 python 环境就跳过 B站这一路（其余搜索源照常）
  if (!PY) return Promise.resolve({ ok: false, error: 'no-python' });
  return exec(PY, [BILI_TOOL, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 })
    .then(({ stdout }) => JSON.parse(stdout))
    .catch((e) => ({ ok: false, error: e.message }));
}

/** B站搜视频 → [{bvid,title,author,play,duration,desc}] */
export async function biliSearch(keyword, n = 5) {
  const r = await runBili(['search', keyword, String(n)]);
  return r.ok ? r.videos : [];
}

export async function biliInfo(bvid) {
  return runBili(['info', bvid]);
}

/** 今日 B站热词（每天拉一次，缓存在本地） */
export async function hotwords() {
  const cache = readJson(HOT_FILE, null);
  if (cache && cache.date === todayKey() && Array.isArray(cache.words)) return cache.words;
  const r = await runBili(['hot']);
  const words = r.ok ? r.hot : [];
  if (words.length) writeJson(HOT_FILE, { date: todayKey(), words });
  return words;
}

// ── 维基百科 ────────────────────────────────────────────

/** 维基百科搜索 → [{title, snippet, url}] */
export async function wikiSearch(query, n = 3) {
  const url = 'https://zh.wikipedia.org/w/api.php?action=query&list=search'
    + `&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${n}&utf8=1`;
  try {
    const raw = await curl(url, { timeoutMs: 12000 });
    const j = JSON.parse(raw);
    const list = j?.query?.search ?? [];
    return list.map((x) => ({
      title: x.title,
      snippet: decodeEntities(x.snippet ?? '').slice(0, 160),
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(x.title)}`,
    }));
  } catch { return []; }
}

// ── Brave 搜索（实测可用，2026-10-28）─────────────────────
//
// 这是目前唯一"能返回真实网页结果"的免费源。
// DDG/Bing/百度/搜狗/Google/SearXNG 全被反爬（详见 HANDOVER）。
// Brave 的 HTML 结构：每条结果是一个 snippet 块，里面 标题 + 域名 + 摘要。

export async function ddgHtml(query, n = 5) {
  // ⚠️ 2026-10-28 实测：普通 Chrome UA 会被 DDG 判为可疑（202 anomaly-modal），
  //    换成 Lynx 的 UA 就能拿到正常结果页。这个发现是碰出来的，记在这儿。
  let html;
  try {
    html = await curl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { timeoutMs: 18000, ua: 'Lynx/2.8.9rel.1 libwww-FM/2.14' });
  } catch { return []; }
  if (!html || html.length < 3000) return [];
  if (/anomaly-modal/.test(html)) return [];        // 又被拦了，静默放弃

  const out = [];
  // 用 result__title 切块（result__body 在新版页面里已经没有了，踩过）
  for (const b of html.split(/class="result__title"/).slice(1)) {
    const m = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const title = decodeEntities(m[2]).replace(/\s{2,}/g, ' ').trim();
    if (!title || title.length < 3) continue;
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = sn ? decodeEntities(sn[1]).replace(/\s{2,}/g, ' ').trim() : '';
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) { try { url = decodeURIComponent(u[1]); } catch { /* 保持原样 */ } }
    out.push({ url, title, snippet: snippet.slice(0, 240) });
    if (out.length >= n) break;
  }
  return out;
}

/** 兼容旧名 */
export async function ddgSearch(query, n = 4) {
  return ddgHtml(query, n);
}

// ── 缓存 ────────────────────────────────────────────────

function keyOf(q) { return createHash('sha1').update(q).digest('hex').slice(0, 16); }
function loadCache() { return readJson(CACHE_FILE, {}); }

/**
 * 综合搜一条（带 24 小时缓存）
 * @returns {Promise<{query:string, block:string, hasResult:boolean, cached:boolean, sources:string[]}>}
 */
export async function gather(query, { force = false } = {}) {
  const k = keyOf(query);
  const cache = loadCache();
  const hit = cache[k];
  const now = Date.now();
  if (!force && hit && now - hit.at < 24 * 3600 * 1000) {
    return { ...hit.data, cached: true };
  }

  // 三路并发：Brave（网页/百科/新闻都行）、B站（中文梗）、维基（人物事件）
  const [web, bili, wiki] = await Promise.all([
    ddgHtml(query, 5).catch(() => []),
    biliSearch(query, 4).catch(() => []),
    wikiSearch(query, 2).catch(() => []),
  ]);

  const parts = [];
  const sources = [];

  if (web.length) {
    sources.push('网页');
    parts.push('【网页搜索结果】\n' + web.map((w, i) =>
      `${i + 1}. ${w.title}\n   ${w.snippet}`).join('\n'));
  }
  if (bili.length) {
    sources.push('B站');
    parts.push('【B站相关视频】\n' + bili.map((v, i) =>
      `${i + 1}. ${v.title}（${v.author}，${v.play}播放）\n   ${v.desc}`).join('\n'));
  }
  if (wiki.length) {
    sources.push('维基');
    parts.push('【维基百科】\n' + wiki.map((w) => `- ${w.title}：${w.snippet}`).join('\n'));
  }

  const data = { query, block: parts.join('\n\n'), hasResult: parts.length > 0, sources };

  cache[k] = { at: now, data };
  const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at).slice(0, 200);
  const trimmed = {};
  for (const kk of keys) trimmed[kk] = cache[kk];
  writeJson(CACHE_FILE, trimmed);

  return { ...data, cached: false };
}
