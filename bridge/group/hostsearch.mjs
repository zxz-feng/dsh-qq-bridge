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

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
// ── GPT-SoVITS 自愈 ──────────────────────────────────────────────────────
// 2026-10-31：她的声音变成微软小艺，查出来是 GPT-SoVITS 那头 down 了，
// 插件静默回落 Edge，发出去的是**别人的音色**。桥这边先探一下，不通就
// 通过 ssh 让本地机器把服务拉起来（schtasks），等不到再让插件回落。
const GSV_SETTINGS = process.env.VOICE_SETTINGS || '/root/dsh/voice/settings.json';
const HEAL_TASK = process.env.VOICE_HEAL_TASK || 'GPT-SoVITS-API';

function gsvUrl() {
  try { return String(JSON.parse(readFileSync(GSV_SETTINGS, 'utf8')).gptsovitsUrl || ''); } catch { return ''; }
}

async function gsvAlive(url) {
  try {
    // GET /tts 会返回 400/500，只要连得上就算活着
    await fetch(String(url).replace(/\/+$/, '') + '/tts', { method: 'GET', signal: AbortSignal.timeout(4000) });
    return true;
  } catch { return false; }
}

let lastHealAt = 0;
async function ensureGsv(log = () => {}) {
  const url = gsvUrl();
  if (!url) return;
  if (await gsvAlive(url)) return;
  if (Date.now() - lastHealAt < 120_000) return;      // 两分钟内别反复 ssh
  let host = '';
  try { host = new URL(url).hostname; } catch { return; }
  if (!host.startsWith('100.')) return;               // 只对 tailnet 上的本地机器动手
  lastHealAt = Date.now();
  log('GPT-SoVITS 不通，尝试远端拉起');
  await new Promise((res) => {
    execFile('ssh', [
      '-i', process.env.VOICE_SSH_KEY || '/root/.ssh/zxz',
      '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8',
      `${process.env.VOICE_SSH_USER || '18074'}@${host}`,
      `schtasks /Run /TN ${HEAL_TASK}`,
    ], { timeout: 25000 }, () => res());
  });
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await gsvAlive(url)) { log('GPT-SoVITS 已拉起'); return; }
  }
  log('GPT-SoVITS 拉不起来，这轮只能 Edge');
}

export async function hostSpeak(text, preset) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 90 秒。原来的 25 秒是照「RVC 一次 6 秒」定的，但实测过：
  //   · 本地机器刚唤醒，GPT-SoVITS 要重新加载模型 → 单次 30 秒以上很正常
  //   · edge+rvc 引擎一次 57 秒
  // 桥先超时 → 插件那头其实还在跑 → 用户看到「她说发不了语音」。
  // 语音是一次性等待，慢一点也比失败好；真挂了插件自己会回落 Edge。
  await ensureGsv((m) => console.log(`  [voice] ${m}`));
  return call('/voice', { text: t, preset }, 90000);
}
