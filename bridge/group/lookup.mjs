// 查资料：角色/游戏/作品到底是个啥、谁配的音。
//
// 为什么单开一个模块：原来只有 search.mjs（DDG 摘要 + 维基），摘要回答不了
// "乌有乡是什么游戏、谁配的音"这种问题 —— 需要**条目页**和**信息框**。
// 现在两条正路：
//   萌娘百科  中文角色/作品的第一手条目（信息框里有声优、生日、身高）
//   VNDB     galgame 的权威库（开发商、发售日、评分）
// 中文名 → 萌娘 → 里面的日文名/英文名 → VNDB 二次确认，这样「乌有乡」也能落到 Erewhon。

import { fetchPage, postJson } from './webpage.mjs';

const UA = 'Lynx/2.8.9rel.1 libwww-FM/2.14';

/** VNDB kana API：搜游戏 */
export async function vndbSearch(name, { timeoutMs = 9000 } = {}) {
  const q = String(name ?? '').trim();
  if (!q) return { ok: false, reason: '没给名字' };
  try {
    const res = await postJson('https://api.vndb.org/kana/vn', {
      filters: ['search', '=', q],
      fields: 'title,alttitle,released,developers.name,rating,votecount,length_minutes',
      results: 3,
    }, { timeoutMs });
    if (!res.ok) return { ok: false, reason: `VNDB ${res.reason}` };
    const r = res.json?.results?.[0];
    if (!r) return { ok: false, reason: `VNDB 上没有「${q}」` };
    return {
      ok: true,
      title: r.title,
      alt: r.alttitle || '',
      released: r.released || '',
      dev: (r.developers ?? []).map((d) => d.name).filter(Boolean).join('、'),
      rating: r.rating ?? null,
      votes: r.votecount ?? 0,
      hours: r.length_minutes ? Math.round(r.length_minutes / 60) : null,
    };
  } catch (e) {
    return { ok: false, reason: String(e?.name === 'TimeoutError' ? '超时' : (e?.message ?? e)).slice(0, 80) };
  }
}

/** 从萌娘正文里抠声优（信息框是「声优 夏和小 藤田茜」这种） */
export function pickCv(text) {
  const s = String(text ?? '');
  const m = s.match(/声优[：:\s]*([^\n]{2,60})/);
  if (!m) return [];
  // 信息框会被拼成「声优 夏和小 / 生日 12月1日 / 身高 146cm」——
  // 先切掉后面的字段，否则生日身高血型全被当成声优（实测踩过）
  const raw = m[1]
    .split('/')[0]
    .split(/(生日|身高|血型|星座|萌点|活动范围|出生|体重|三围)/)[0]
    .split(/[（(]/)[0];
  return raw
    .split(/[\s、,，/]+/)
    .map((x) => x.replace(/[（(].*?[)）]/g, '').trim())
    .filter((x) => x.length >= 2 && x.length <= 14 && !/\d/.test(x))
    .slice(0, 4);
}

/**
 * 查一个东西是什么
 * @param {string} q 中文名/日文名都行
 * @returns {Promise<{ok:boolean, block:string, cv:string[], title?:string, images?:string[]}>}
 */
export async function lookupInfo(q) {
  const name = String(q ?? '').trim();
  if (!name) return { ok: false, block: '', cv: [] };

  // 群里等不了太久：整段 18 秒还没完，就用手上已有的东西回答
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, block: `\n【查「${name}」太慢了，没等完】`, cv: [] }), 18000);
  });
  try { return await Promise.race([lookupInfoInner(name), deadline]); }
  finally { clearTimeout(timer); }
}

async function lookupInfoInner(name) {
  const page = await fetchPage('', { q: name, timeoutMs: 12000 });
  if (!page.ok) {
    return { ok: false, block: `\n【我去查了「${name}」：没查到 —— ${page.reason ?? '不知道为啥'}】`, cv: [] };
  }

  const cv = pickCv(page.text);
  // 萌娘条目里常写着日文原名，用它去 VNDB 确认是不是 galgame。
  // 已经抠到声优 = 这是个人物条目，VNDB 查人物没意义（kana 的中文搜索也搜不到），
  // 省掉这一次请求（2~3 秒）。人物页要 CV 已经够了。
  const jp = (String(page.text).match(/（([^）]{2,40})）/) || [])[1] || '';
  const vn = cv.length ? { ok: false, reason: '人物条目，不查 VNDB' } : await vndbSearch(jp || name);
  const lines = [`\n【我查到的「${page.title || name}」（${page.site}）】`, String(page.text).slice(0, 900)];
  if (cv.length) lines.push(`声优：${cv.join('、')}`);
  if (vn.ok) {
    lines.push(`VNDB：${vn.title}${vn.alt ? ' / ' + vn.alt : ''}｜${vn.dev || '开发商不详'}｜${vn.released || '发售日不详'}`
      + (vn.rating ? `｜评分 ${vn.rating}` : '') + (vn.hours ? `｜约 ${vn.hours} 小时` : ''));
  }
  return { ok: true, block: lines.join('\n'), cv, title: page.title, images: page.images ?? [], url: page.url };
}

/** 只问"谁配的音" */
export async function lookupCv(q) {
  const r = await lookupInfo(q);
  if (!r.ok) return r;
  if (!r.cv.length) return { ...r, block: `\n【我查了「${r.title || q}」，条目里没写声优】` };
  return { ...r, block: `\n【「${r.title || q}」的声优：${r.cv.join('、')}】` };
}
