/**
 * 搜梗 / 查资料
 *
 * 四个源，并发跑，谁有结果算谁的：
 *   ✅ 宿主搜索   —— 借 DSH 的 `ctx.web`（要装了搜索插件并配了 key 才有）。
 *                    走 `hostsearch.mjs` → 父进程 127.0.0.1 小门。有它就不用 DDG。
 *   ✅ DDG lite   —— `lite.duckduckgo.com/lite/` + Lynx UA。中文结果最好的一路，
 *                    2026-10-29 实测稳定（html 版经常 202，lite 版正常）。
 *   ✅ B站搜索    —— 中文网络梗最好的来源（标题+简介就是解释）
 *   ✅ 维基百科   —— 通用知识、人物、事件
 *
 * ❌ 已放弃：Bing HTML/RSS（中文串味）、百度/360/搜狗（验证码）、Google（JS 空壳）、
 *            SearXNG 公共实例（429）、Mojeek（200 但无结果）
 *
 * 策略：**能拿到就用，拿不到就少说**。不硬编会 404 的源，也不假装搜到了。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, STORE, todayKey } from './store.mjs';
import { hostSearch } from './hostsearch.mjs';

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

// ── DDG html（备用：lite 版失败时兜底）────────────────────
//
// 普通 Chrome UA 会被判可疑（202 反爬），Lynx UA 能拿到正常结果页。

// ── DDG lite（2026-10-29 实测：中文结果最好的一路）──────────
//
// `lite.duckduckgo.com/lite/` 是给无 JS 浏览器用的极简页，反爬比 html 版松得多：
// 同一个 Lynx UA，html 版经常 202，lite 版稳定 200 且**中文结果真的对题**
// （搜「雨爱 司凤」直接给出 B站那支视频）。结构也很朴素：
//   <a rel="nofollow" href="//duckduckgo.com/l/?uddg=<urlencoded>" class='result-link'>标题</a>
//   之后跟着 <td class='result-snippet'>摘要</td>
// 注意 href 在 class **之前**，所以不能用 split(class) 切块 —— 用带 index 的全局匹配。

export async function ddgLite(query, n = 5) {
  let html;
  try {
    html = await curl(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      { timeoutMs: 18000, ua: 'Lynx/2.8.9rel.1 libwww-FM/2.14' });
  } catch { return ddgHtml(query, n); }
  if (!html || html.length < 1500) return ddgHtml(query, n);

  const re = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  const hits = [];
  for (let m = re.exec(html); m; m = re.exec(html)) {
    hits.push({ url: m[1], title: decodeEntities(m[2]), at: m.index, end: re.lastIndex });
  }
  if (!hits.length) return ddgHtml(query, n);

  const out = [];
  for (let i = 0; i < hits.length && out.length < n; i += 1) {
    const h = hits[i];
    if (!h.title || h.title.length < 3) continue;
    // 摘要必须落在「本条之后、下一条之前」，否则会串到下一条去
    const span = html.slice(h.end, hits[i + 1]?.at ?? html.length);
    const sn = span.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/);
    let url = h.url;
    const u = url.match(/uddg=([^&]+)/);
    if (u) { try { url = decodeURIComponent(u[1]); } catch { /* 保持原样 */ } }
    if (url.startsWith('//')) url = `https:${url}`;
    out.push({
      url,
      title: h.title.replace(/\s{2,}/g, ' ').trim(),
      snippet: sn ? decodeEntities(sn[1]).replace(/\s{2,}/g, ' ').trim().slice(0, 240) : '',
    });
  }
  return out.length ? out : ddgHtml(query, n);
}

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

/** 兼容旧名：走 lite，失败自动退 html */
export async function ddgSearch(query, n = 4) {
  return ddgLite(query, n);
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

  // 四路并发：宿主（装了搜索插件才有）、DDG lite（网页）、B站（中文梗）、维基（人物事件）
  const [host, web, bili, wiki] = await Promise.all([
    hostSearch(query, 5).catch(() => null),
    ddgLite(query, 5).catch(() => []),
    biliSearch(query, 4).catch(() => []),
    wikiSearch(query, 2).catch(() => []),
  ]);

  const parts = [];
  const sources = [];

  // 宿主搜索优先（带正文摘要，比 DDG 的「标题+一句摘」强）；拿不到就退回 DDG。
  // 两者不同时用 —— 同样的东西进两遍上下文，白烧 token。
  if (host && (host.sources.length || host.answer)) {
    sources.push('宿主');
    const lines = [];
    if (host.answer) lines.push(host.answer);
    host.sources.slice(0, 5).forEach((w, i) => lines.push(`${i + 1}. ${w.title}\n   ${w.snippet || w.url}`));
    parts.push('【联网搜索】\n' + lines.join('\n'));
  } else if (web.length) {
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
