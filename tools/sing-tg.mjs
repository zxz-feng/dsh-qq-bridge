#!/usr/bin/env node
/**
 * TG 点唱：给歌名就现找现换；不给就**从缓存曲库里挑一首**。
 *
 * 和 QQ 侧共用同一套缓存（`_herfull.mp3` + `index.json`），
 * 所以 QQ 里唱过的歌，TG 这边秒回 —— 这一步不碰 GPU。
 *
 * 用法：
 *   node sing-tg.mjs "雨爱"   → 有就秒回，没有就现做
 *   node sing-tg.mjs ""       → 从缓存挑（优先 SING_DEFAULT，其次最近用过的）
 * 输出：一行 JSON {"ok":true,"file":"...","title":"...","ms":123,"cached":true}
 */
import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const arg = String(process.argv[2] || '').trim();
const MAX_SEC = Number(process.env.SING_MAX_SEC || 60);
const PREF = String(process.env.SING_DEFAULT || '').trim();

const t0 = Date.now();
const log = (...a) => console.error('[sing-tg]', ...a);
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };

const { makeVoice, ensureHerFull, cachedSongs } = await import('../bridge/group/voice.mjs');

function pickCached() {
  const list = cachedSongs();
  if (!list.length) return null;
  if (PREF) {
    const hit = list.find((s) => s.title.includes(PREF) || PREF.includes(s.title));
    if (hit) { log('按 SING_DEFAULT 命中', hit.title); return hit }
    log('SING_DEFAULT 不在缓存里：', PREF);
  }
  log('缓存曲库', list.map((s) => s.title).join(' / '));
  return list[0];
}

async function cut(src, sec) {
  if (!(sec > 0)) return src;
  const dst = src.replace(/\.mp3$/, `_tg${sec}s.mp3`);
  if (existsSync(dst) && statSync(dst).size > 2000) return dst;
  try {
    await exec('ffmpeg', ['-y', '-loglevel', 'error', '-t', String(sec), '-i', src,
      '-c:a', 'libmp3lame', '-b:a', '128k', dst]);
    return existsSync(dst) ? dst : src;
  } catch (e) { log('截断失败，用整首：', e.message); return src }
}

try {
  if (!arg) {
    const pick = pickCached();
    if (!pick) out({ ok: false, reason: '缓存里还没有换过声的歌' });
    const full = await ensureHerFull(pick.bvid);
    const file = await cut(full.path, MAX_SEC);
    log('缓存命中', pick.title, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    out({ ok: true, file, title: pick.title, bvid: pick.bvid, ms: Date.now() - t0, cached: true });
  }

  const hit = cachedSongs().find((s) => s.title.includes(arg) || arg.includes(s.title));
  if (hit) {
    const full = await ensureHerFull(hit.bvid);
    const file = await cut(full.path, MAX_SEC);
    log('缓存命中（同名）', hit.title, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    out({ ok: true, file, title: hit.title, bvid: hit.bvid, ms: Date.now() - t0, cached: true });
  }

  log('缓存没有，开始现做：', arg);
  const r = await makeVoice(arg);
  if (!r?.ok) out({ ok: false, reason: r?.reason || '选不到' });
  const file = await cut(r.path, MAX_SEC);
  log('现做完成', r.title, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  out({ ok: true, file, title: r.title, bvid: r.bvid, ms: Date.now() - t0, cached: !!r.cached });
} catch (e) {
  out({ ok: false, reason: String(e?.message || e).slice(0, 100) });
}
