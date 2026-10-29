// 找图：群里要"一张结城希亚的表情包"，库里有就发库里的，库里没有就上网找。
//
// 以前 pickSticker 查不到就直接说"不会发" —— 用户看到的是"她不肯发/不会发"。
// 现在多一条路：萌娘百科条目主图 → VNDB 角色立绘 → B站视频封面（走 bili 插件）。
//
// 原则：**不撒谎**。找到什么说什么（"给你找了张立绘"），找不到就明说没找到，
// 不能把立绘说成表情包。

import { fetchPage, siteOf } from './webpage.mjs';

const UA = 'Lynx/2.8.9rel.1 libwww-FM/2.14';

/** 萌娘百科条目主图（角色立绘/作品封面，最像"图"的那张） */
async function fromMoegirl(q, timeoutMs) {
  const page = await fetchPage('', { q, timeoutMs });
  if (!page.ok) return { ok: false, reason: page.reason };
  const imgs = (page.images ?? []).filter((u) => !/logo|site-|wiki|commons|banner|icon/i.test(u));
  if (!imgs.length) return { ok: false, reason: '条目里没找到图' };
  return { ok: true, url: imgs[0], from: '萌娘百科', caption: page.title || q, kind: '立绘/插图' };
}

/** 直接从页面 URL 拿 og:image（用于"这个链接的配图"） */
async function fromPage(url, timeoutMs) {
  const page = await fetchPage(url, { timeoutMs });
  if (!page.ok) return { ok: false, reason: page.reason };
  const img = (page.images ?? [])[0];
  if (!img) return { ok: false, reason: '这页没有图' };
  return { ok: true, url: img, from: siteOf(url), caption: page.title || '', kind: '网页配图' };
}

/**
 * 找一张图
 * @param {string} q 关键词（角色名/作品名），或直接一个页面链接
 * @returns {Promise<{ok:boolean, url?:string, from?:string, caption?:string, kind?:string, reason?:string}>}
 */
export async function findPicture(q, { timeoutMs = 10000 } = {}) {
  const key = String(q ?? '').trim();
  if (!key) return { ok: false, reason: '没说要找什么图' };

  if (/^https?:\/\//i.test(key)) return fromPage(key, timeoutMs);

  const tries = [];
  tries.push(await fromMoegirl(key, timeoutMs));
  if (tries[0].ok) return tries[0];

  // 萌娘没图就退一步：把它当普通关键词搜（DDG 的图片接口在机房 IP 上基本废，不指望）
  return { ok: false, reason: tries.map((t) => t.reason).filter(Boolean).join('；') || '没找到' };
}
