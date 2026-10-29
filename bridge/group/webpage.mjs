// 网页正文：别人甩个链接过来，小鲸鱼得知道那里面写了什么。
//
// 三条路，按站点分：
//   贴吧   → 走 dsh-tieba-dive 的 MCP（贴吧认 TLS 指纹，fetch 直接 403，实测）
//   萌娘百科 → 直连（opensearch + 页面正文，带 Lynx UA）
//   其它   → 直连，剥标签取正文；登录墙/风控直接说"看不到"，不硬刚
//
// 输出一律 {ok, site, title, text, images[], reason}，text 截到 1200 字 ——
// 塞进提示词的预算是有限的，宁少不滥。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tiebaCall } from './tieba.mjs';

const run = promisify(execFile);

const UA = 'Lynx/2.8.9rel.1 libwww-FM/2.14';
const MAX_TEXT = 1200;

/** 这些站基本都要登录/风控，别浪费 8 秒 */
const WALLED = [
  [/bilibili\.com\/video/i, 'B站视频页要登录才给正文（要视频信息可以用 bili 搜索）'],
  [/weibo\.com|weibo\.cn/i, '微博要登录'],
  [/xiaohongshu\.com/i, '小红书要登录'],
  [/douyin\.com/i, '抖音要登录'],
  [/mp\.weixin\.qq\.com/i, '公众号文章经常反爬'],
  [/zhihu\.com\/question|zhuanlan\.zhihu\.com/i, '知乎要登录'],
];

export function siteOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/tieba\.baidu\.com$/.test(h)) return '贴吧';
    if (/moegirl\.org\.cn$/.test(h)) return '萌娘百科';
    if (/bilibili\.com$/.test(h)) return 'B站';
    if (/wikipedia\.org$/.test(h)) return '维基百科';
    if (/vndb\.org$/.test(h)) return 'VNDB';
    if (/bangumi\.tv$/.test(h)) return 'Bangumi';
    return h;
  } catch { return '网页'; }
}

export function extractUrl(text) {
  // 中文标点也算结束符，否则「https://a.com/x。」会把句号吃进 URL
  const m = String(text ?? '').match(/https?:\/\/[^\s<>"'）)】」，。！？、；：]+/i);
  return m ? m[0].replace(/[.,;:!?]+$/, '') : '';
}

function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** 剥标签取正文：块级标签转换行，短行（导航/按钮）丢掉 */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decode(s);
  const lines = s.split('\n')
    .map((x) => x.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((x) => x.length >= 8)
    .filter((x, i, a) => a.indexOf(x) === i);
  return lines.join('\n');
}

function pickTitle(html) {
  const og = String(html).match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decode(og[1]).trim();
  const t = String(html).match(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i);
  // <title> 里常混着 <span class="...">，剥一层再返回
  return t ? decode(t[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
}

function pickImages(html, base) {
  const out = [];
  const og = String(html).match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) out.push(og[1]);
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html))) && out.length < 6) {
    const u = m[1];
    if (!u || /^data:|\.svg(\?|$)/i.test(u)) continue;
    try { out.push(new URL(u, base).toString()); } catch { /* 相对路径算不出来就算了 */ }
  }
  return [...new Set(out)].slice(0, 5);
}

/**
 * 为什么用 curl 而不是 fetch（2026-10-29 实测）：
 * 这台机器直连萌娘百科，opensearch 要 9.8 秒、条目页 16 秒（fetch 10 秒超时直接死）；
 * 走 mihomo 代理 1.4 秒。node 的 fetch 不吃 HTTP_PROXY，所以网络层交给 curl，
 * 代理地址从 WEB_PROXY 环境变量来（宿主 config 里的 webProxy 传下来的）。
 */
function proxyUrl() { return String(process.env.WEB_PROXY || '').trim(); }

const _cache = new Map();   // url → { at, status, html }   （5 分钟）
const CACHE_MS = 5 * 60 * 1000;

async function curlText(url, opts = {}) {
  const hit = _cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return { status: hit.status, html: hit.html, cached: true };
  try {
    const r = await curlOnce(url, opts);
    _cache.set(url, { at: Date.now(), ...r });
    return r;
  } catch (e) {
    // 代理偶尔抽风（实测 10 秒超时、重试就通），给它一次机会
    await new Promise((r) => setTimeout(r, 400));
    const r = await curlOnce(url, opts);
    _cache.set(url, { at: Date.now(), ...r });
    return r;
  }
}

async function curlOnce(url, { timeoutMs = 9000, method = 'GET', body = '', headers = {} } = {}) {
  const sec = Math.max(3, Math.ceil(timeoutMs / 1000));
  const args = ['-sS', '-L', '--max-time', String(sec), '-A', UA,
    '-H', 'Accept-Language: zh-CN,zh;q=0.9', '-w', '\n__HTTP__%{http_code}'];
  const px = proxyUrl();
  if (px) args.push('-x', px);
  if (method !== 'GET') args.push('-X', method);
  if (body) args.push('--data-binary', body);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  const { stdout } = await run('curl', args, { maxBuffer: 8 * 1024 * 1024, timeout: (sec + 3) * 1000 });
  const m = String(stdout).match(/\n__HTTP__(\d{3})$/);
  const status = m ? Number(m[1]) : 0;
  const html = m ? String(stdout).slice(0, m.index) : String(stdout);
  return { status, html };
}

/** POST JSON（VNDB 的 kana API 要 POST） */
export async function postJson(url, obj, { timeoutMs = 12000 } = {}) {
  const r = await curlText(url, {
    timeoutMs, method: 'POST', body: JSON.stringify(obj),
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 200) return { ok: false, status: r.status, reason: `返回 ${r.status}` };
  try { return { ok: true, json: JSON.parse(r.html) }; }
  catch { return { ok: false, status: r.status, reason: '返回的不是 JSON' }; }
}

async function get(url, timeoutMs) {
  const r = await curlText(url, { timeoutMs });
  return { status: r.status, html: r.html, finalUrl: url };
}

/** 萌娘百科：先 opensearch 找条目，再取正文 */
async function moegirl(url, q, timeoutMs) {
  let target = url;
  let title = '';
  // 省一次请求：先当"词条名就是标题"直接取，404 再退回 opensearch。
  // 实测 opensearch 要 5~6 秒，能省就省（群里等 14 秒太久了）。
  if (!target && q) {
    const direct = `https://zh.moegirl.org.cn/${encodeURIComponent(q)}`;
    try {
      const d = await get(direct, timeoutMs);
      if (d.status === 200 && !/条目.*不存在|没有找到/.test(d.html.slice(0, 4000))) {
        target = direct;
        title = q;
      }
    } catch { /* 直连失败就走 opensearch */ }
  }
  if (!target && q) {
    const api = `https://zh.moegirl.org.cn/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=1&format=json`;
    const r = await get(api, timeoutMs);
    const j = JSON.parse(r.html);
    title = j?.[1]?.[0] ?? '';
    target = j?.[3]?.[0] ?? '';
    if (!target) return { ok: false, reason: `萌娘百科上没有「${q}」这个条目` };
  }
  const r = await get(target, timeoutMs);
  if (r.status !== 200) return { ok: false, reason: `萌娘百科返回 ${r.status}` };

  // 信息框在表格里，htmlToText 会把「声优」和它的值切成两行、又被短行过滤吃掉，
  // 所以**从 HTML 原文**抠：找到「声优」往后取 300 字，剥标签。
  const rawNoTag = decode(String(r.html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '\u0001'))
    .replace(/[ \t\u00a0]+/g, ' ');
  const info = [];
  const cvM = rawNoTag.match(/声优[\u0001\s]*([^\u0001]{2,80})/);
  if (cvM) info.push('声优 ' + cvM[1].replace(/\u0001+/g, ' ').trim().slice(0, 60));
  for (const k of ['出生', '生日', '身高', '血型']) {
    const m2 = rawNoTag.match(new RegExp(k + '[\\u0001\\s]*([^\\u0001]{1,40})'));
    if (m2) info.push(k + ' ' + m2[1].replace(/\u0001+/g, ' ').trim().slice(0, 30));
  }

  // 正文：丢掉 wiki 维护横幅那类噪音（"致维护人员…""编辑本条目…"）
  const NOISE = /(维护人员|编辑本条目|条目编辑规则|欢迎来到|不适合未满|本页面|页面可能包含|相关描述|请协助|万物皆可萌|如果您|本条目|最近编辑|谨防破坏|欢迎您来到)/;
  const text = htmlToText(r.html)
    .split('\n')
    .filter((line) => !NOISE.test(line))
    .join('\n');
  const merged = [info.join(' / '), text].filter(Boolean).join('\n').slice(0, MAX_TEXT);
  return {
    ok: true, site: '萌娘百科', title: title || pickTitle(r.html) || target,
    text: merged, images: pickImages(r.html, r.finalUrl), url: r.finalUrl,
  };
}

/**
 * 抓一个页面
 * @returns {Promise<{ok:boolean, site?:string, title?:string, text?:string, images?:string[], url?:string, reason?:string}>}
 */
export async function fetchPage(url, { timeoutMs = 9000, q = '' } = {}) {
  const u = String(url ?? '').trim();
  const site = siteOf(u || q);

  // ① 贴吧：走 MCP（自己 fetch 一律 403）
  if (site === '贴吧' || /tieba\.baidu\.com/.test(u)) {
    const m = u.match(/\/p\/(\d+)/) || u.match(/[?&]kz=(\d+)/);
    if (!m) return { ok: false, site, reason: '这不是帖子地址（要 /p/数字 那种）' };
    const r = await tiebaCall('tieba_thread', { tid: m[1] });
    if (!r.ok) return { ok: false, site, reason: r.text.slice(0, 120) };
    // MCP 回的是 JSON（floors 数组），直接丢给模型又费 token 又难读 → 排成人话
    let title = `贴吧帖子 ${m[1]}`;
    let body = String(r.text);
    try {
      const j = JSON.parse(body);
      title = j.title || title;
      const kw = j.kw ? `吧「${j.kw}」` : '';
      const floors = Array.isArray(j.floors) ? j.floors : [];
      const lines = floors.slice(0, 6).map((f, i) => `${i + 1}楼：${String(f).replace(/\s+/g, ' ').slice(0, 220)}`);
      body = `${kw}《${title}》共 ${floors.length} 楼\n${lines.join('\n')}`;
    } catch { /* 不是 JSON 就原样给 */ }
    return { ok: true, site, title, text: body.slice(0, MAX_TEXT * 2), images: [], url: u };
  }

  // ② 登录墙：直接认输，别耗 8 秒
  for (const [re, why] of WALLED) if (re.test(u)) return { ok: false, site, reason: why };

  // ③ 萌娘百科
  if (site === '萌娘百科' || (!u && q)) {
    try { return await moegirl(site === '萌娘百科' ? u : '', q, timeoutMs); }
    catch (e) { return { ok: false, site: '萌娘百科', reason: String(e?.message ?? e).slice(0, 80) }; }
  }

  if (!u) return { ok: false, site, reason: '没有链接' };

  // ④ 其它站
  try {
    const r = await get(u, timeoutMs);
    if (r.status === 403 || r.status === 412) return { ok: false, site, reason: `这个站挡了机器人（${r.status}）` };
    if (r.status !== 200) return { ok: false, site, reason: `返回 ${r.status}` };
    const text = htmlToText(r.html).slice(0, MAX_TEXT);
    if (text.length < 40) return { ok: false, site, reason: '正文没抓到（可能要登录或是纯前端页面）' };
    return { ok: true, site, title: pickTitle(r.html), text, images: pickImages(r.html, r.finalUrl), url: r.finalUrl };
  } catch (e) {
    const msg = String(e?.name === 'TimeoutError' ? '超时' : (e?.message ?? e));
    return { ok: false, site, reason: msg.slice(0, 80) };
  }
}

/** 给提示词用的一段话 */
export function pageBlock(r, { who = '' } = {}) {
  if (!r?.ok) return `\n【我刚去看了那个链接：看不了 —— ${r?.reason ?? '不知道为啥'}】`;
  const head = `\n【我刚看了${who ? who + '发的' : ''}那个链接：${r.site}${r.title ? '「' + r.title + '」' : ''}】`;
  return `${head}\n${String(r.text ?? '').slice(0, MAX_TEXT)}`;
}
