/**
 * 语音：从 B站扒音频 → 切 30~40 秒 → 发 QQ 语音
 *
 * 为什么不做 TTS：念字太假。用户要的是"被要求唱《雨爱》就发一段司凤版"，
 * 那本质是**扒现成音频**，不是合成。
 *
 * 链路（全部实测过）：
 *   bilibili_api 搜索  →  yt-dlp 下载 bestaudio  →  ffmpeg 切段  →  CQ:record
 *   NapCat 收到 mp3 后自己转 silk，不用我们管。
 *
 * 缓存：同一 BV 号 7 天内不重复下载（不算"预置库"，是省流量）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { biliSearch, biliInfo } from './search.mjs';
import { pickSongVideo, judgeSong } from './songpick.mjs';
import { STORE } from './store.mjs';
import { HOST_MEDIA, toFileUrl } from './paths.mjs';

const exec = promisify(execFile);

// ⚠️ 必须放在容器挂载区：NapCat 在容器里，看不到宿主机其他路径
const VOICE_DIR = `${HOST_MEDIA}/voice`;
if (!existsSync(VOICE_DIR)) mkdirSync(VOICE_DIR, { recursive: true });

// 这两个都是**外部依赖**（不是插件的一部分）：
//   PY_ASR   装了 yt-dlp 的 python，用来扒 B站音频
//   CRED_FILE  B站登录态（有登录才能拿到高清音轨）
// 没配也照常跑，只是「点歌/唱歌」这块会明确报「没装就不可用」。
const PY_ASR = process.env.BILI_PY_ASR || '';
const BILI_PY = process.env.BILI_PY || '';
const BILI_TOOL = fileURLToPath(new URL('../tools/bili.py', import.meta.url));
const CRED_FILE = process.env.BILI_CRED || '';

// 从**开头**切，不挖中间那段；时长按 QQ 语音上限留 1 秒余量
const SEG_SEC = Number(process.env.VOICE_SEG_SEC ?? 59);
const MAX_AGE_DAYS = 7;

/** 从插件凭证拼 Cookie（和 asr_cookie.py 一样的映射） */
function cookieHeader() {
  try {
    const c = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
    const map = { sessdata: 'SESSDATA', bili_jct: 'bili_jct', buvid3: 'buvid3', dedeuserid: 'DedeUserID' };
    return Object.entries(c)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => `${map[k] ?? k}=${v}`)
      .join('; ');
  } catch { return ''; }
}

// 文件名带上段长：以后改 SEG_SEC 会自动换新缓存，不会误用旧片段
function cachePath(bvid) { return `${VOICE_DIR}/${bvid}_${SEG_SEC}s.mp3`; }


/**
 * 换声地址：环境变量优先，其次现读语音插件的 settings.json。
 * 为什么现读：settings.json 是设置页随时会改的，而子进程的 env 是启动时固化的，
 * 走 env 就得重启 dsh-web 才能生效 —— 用户明确要求"能改就立刻生效"。
 */
/**
 * 换声参数：模型名 / protect / index_rate 也从 settings.json 现读（同 singUrl 的理由）。
 * 2026-10-31 主人 A/B 后定：anjie2 + protect 0.55 + index 0.50 咬字最清楚。
 */
function singOpts() {
  const o = { model: 'anjie2', protect: 0.55, index: 0.5 };
  try {
    const base = process.env.DSH_HOME || '/root/.dsh';
    const f = `${base}/voice/settings.json`;
    if (existsSync(f)) {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      if (c.rvcModel) o.model = String(c.rvcModel).trim();
      if (Number.isFinite(Number(c.rvcProtect))) o.protect = Number(c.rvcProtect);
      if (Number.isFinite(Number(c.rvcIndexRate))) o.index = Number(c.rvcIndexRate);
    }
  } catch { /* 读不到就用默认 */ }
  if (process.env.SING_MODEL) o.model = String(process.env.SING_MODEL);
  return o;
}

function singUrl() {
  const fromEnv = String(process.env.SING_URL ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const base = process.env.DSH_HOME || '/root/.dsh';
    const f = `${base}/voice/settings.json`;
    if (!existsSync(f)) return '';
    return String(JSON.parse(readFileSync(f, 'utf8')).singUrl ?? '').trim();
  } catch { return ''; }
}

/**
 * 她自己的嗓子唱：把切好的 59 秒发给本地 /sing（demucs 分离 + RVC + 混音）
 * 没配 SING_URL、或者本地没开 → 返回 null，调用方就放原曲，绝不因此不发语音
 * 缓存：同 BV 同段长只换一次
 */
let lastRvcHealAt = 0;

/**
 * 换声服务连不上就硬重启一次（按端口杀 + schtasks 拉），最多 80 秒。
 * 2026-10-31 21:26：5050 崩了 → 整首回落成周深原唱，主人以为"她没唱"。
 */
async function healRvc(url) {
  if (Date.now() - lastRvcHealAt < 120_000) return false;
  let host = '';
  try {
    host = new URL(String(url)).hostname;
  } catch { return false; }
  if (!host.startsWith('100.')) return false;
  lastRvcHealAt = Date.now();
  const port = (() => { try { return new URL(String(url)).port || '5050'; } catch { return '5050'; } })();
  console.log(`  [voice] 换声服务连不上，硬重启 ${host}:${port}`);
  const { execFile } = await import('node:child_process');
  await new Promise((res) => {
    execFile('ssh', [
      '-i', process.env.VOICE_SSH_KEY || '/root/.ssh/zxz',
      '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8',
      `${process.env.VOICE_SSH_USER || '18074'}@${host}`,
      'powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ' + port
        + ' -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; '
        + 'Start-Sleep 3; schtasks /Run /TN RVC-Serve"',
    ], { timeout: 40000 }, () => res());
  });
  for (let i = 0; i < 16; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const h = await fetch(url.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(4000) });
      if (h.ok) { console.log('  [voice] 换声服务已拉起'); return true; }
    } catch { /* 还在起 */ }
  }
  console.log('  [voice] 换声服务拉不起来，这轮放原曲');
  return false;
}

async function singRemoteTo(file, out) {
  const url = singUrl();
  if (!url) return null;
  if (existsSync(out)) return out;
  const t0 = Date.now();
  console.log(`  [voice] 送换声 ${new Date().toTimeString().slice(0, 8)}（${Math.round(statSync(file).size / 1024)}KB）`);
  try {
    const buf = readFileSync(file);
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'in.mp3');
    // 默认 auto：让本地服务按源人声基频算半音（男声→女声模型要 +12 左右）
    fd.append('pitch', process.env.SING_PITCH != null ? String(Number(process.env.SING_PITCH)) : 'auto');
    // 模型与两个咬字参数（2026-10-31 主人定稿：anjie2 / protect 0.55 / index 0.50）
    const opt = singOpts();
    fd.append('model_name', opt.model);
    fd.append('protect', String(opt.protect));
    fd.append('index_rate', String(opt.index));
    let r = null;
    let lastErr = null;
    // 本地服务可能在开机/唤醒后正在加载模型，第一次连不上很常见（2026-10-31 14:31 就是这样，
    // 结果整首放成了原曲）。网络级失败重试 2 次再认输。
    // 每次尝试单独计时：以前三共用 300 秒的 controller，第一次 fetch 挂住就把
    // 整条消息堵死（2026-10-31 21:42，主人连发三条都没回应）
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        r = await fetch(url.replace(/\/+$/, '') + '/sing', { method: 'POST', body: fd, signal: ctrl.signal });
        clearTimeout(timer);
        break;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt < 3) {
          console.log(`  [voice] 换声连接失败（第 ${attempt} 次）：${e.message}，5 秒后重试`);
          await new Promise((res) => setTimeout(res, 5000));
        }
      }
    }
    if (!r) {
      // 连不上：可能是 5050 那头崩了（训练抢显存那次就是）。硬重启一次再试。
      if (await healRvc(url)) {
        // 自愈已经把服务重新拉起来了，这次给它更长的预算（模型要重新加载）
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort(), 120_000);
        try {
          r = await fetch(url.replace(/\/+$/, '') + '/sing', { method: 'POST', body: fd, signal: ctrl2.signal });
        } catch (e) { lastErr = e; } finally { clearTimeout(timer2); }
      }
    }
    if (!r) throw lastErr || new Error('连接不上换声服务');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = Buffer.from(await r.arrayBuffer());
    if (blob.length < 2048) throw new Error(`返回太小（${blob.length}B）`);
    writeFileSync(out, blob);
    console.log(`  [voice] 换声完成 ${Math.round(blob.length / 1024)}KB / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return out;
  } catch (e) {
    console.log(`  [voice] 换声失败，放原曲：${e.message}`);
    return null;
  }
}

/** 单曲：固定命名，方便缓存 */
async function singRemote(file, bvid) {
  return singRemoteTo(file, `${VOICE_DIR}/${bvid}_${SEG_SEC}s_her.mp3`);
}

/**
 * 整首：每段都换声（用户 2026-10-30 问「唱完整版会不会生效」）
 * 串行做，避免把本地 GPU 挤爆；一段 7~8 秒，6 段约 45 秒
 */
async function singSegments(segs) {
  const out = [];
  for (let i = 0; i < segs.length; i += 1) {
    const her = await singRemoteTo(segs[i], segs[i].replace(/\.mp3$/, '_her.mp3'));
    out.push(her || segs[i]);
    if (her) console.log(`  [voice] 整首换声 ${i + 1}/${segs.length}`);
  }
  return out;
}

/**
 * 安全错误信息
 * ⚠️ execFile 的 e.message 会把**整条命令行**带出来，里面有 B站 Cookie。
 *    这条信息一旦发到群里就是账号泄露。所以只取 stderr 最后一行，并抹掉 Cookie。
 */
export function safeErr(e, tag = '错误') {
  const raw = String(e?.stderr || e?.stdout || e?.message || e);
  const line = raw.split('\n').map((x) => x.trim()).filter(Boolean).pop() || tag;
  return `${tag}: ${line.replace(/Cookie:\s*\S+/gi, 'Cookie:***').slice(0, 100)}`;
}

/** 清掉超过 7 天的语音缓存 */
export function gc() {
  const now = Date.now();
  try {
    for (const f of readdirSync(VOICE_DIR)) {
      const p = `${VOICE_DIR}/${f}`;
      try {
        if (now - statSync(p).mtimeMs > MAX_AGE_DAYS * 86400_000) unlinkSync(p);
      } catch { /* 单个文件失败无所谓 */ }
    }
  } catch { /* 目录不存在 */ }
}

/**
 * 下载某 BV 的音频，返回本地路径。
 * @param {string} bvid
 * @param {{head?: boolean}} [opts] head=true 只抓前 70 秒（单段点歌够用，快得多）
 *
 * 2026-10-31：原来每次都整首下载、切完就删，一首 2 分钟的歌光下载就要一分半，
 * 加上换声 25 秒 → 主人等了 125 秒。现在单段只抓开头 70 秒并且留在缓存里。
 */
async function downloadAudio(bvid, { head = false } = {}) {
  if (!PY_ASR) throw new Error('没配 BILI_PY_ASR（装了 yt-dlp 的 python），点歌/唱歌不可用');
  const tag = head ? '.head' : '.full';
  // 已经有就直接用（同一首歌反复点不该反复下）
  try {
    const hit = readdirSync(VOICE_DIR).find((f) => f.startsWith(`${bvid}${tag}.`));
    if (hit && statSync(`${VOICE_DIR}/${hit}`).size > 100 * 1024) return `${VOICE_DIR}/${hit}`;
  } catch { /* 目录或文件不在，继续下 */ }

  const out = `${VOICE_DIR}/${bvid}${tag}.%(ext)s`;
  const url = `https://www.bilibili.com/video/${bvid}`;
  const ck = cookieHeader();
  const args = [
    '-m', 'yt_dlp', '-f', 'bestaudio/best', '-o', out,
    '--no-playlist', '--no-warnings', '--no-progress', '--no-part',
    '--add-header', 'Referer:https://www.bilibili.com',
    '--add-header', `Cookie:${ck}`,
    '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  ];
  if (head) args.push('--download-sections', '*0-70', '--force-keyframes-at-cuts');
  args.push(url);
  try {
    await exec(PY_ASR, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    // B站网页会风控（HTTP 412），yt-dlp 第一步就挂。
    // 走 API 拿音频直链（有 WBI 签名，不受 412 影响），再用 ffmpeg 拉流。
    console.log(`  [voice] yt-dlp 失败（${safeErr(e, '下载失败')}）→ 改走 API 直链`);
    try {
      await downloadByApi(bvid, `${VOICE_DIR}/${bvid}${tag}.mp3`, { head });
    } catch (e2) {
      throw new Error(safeErr(e2, '下载失败'));
    }
    return `${VOICE_DIR}/${bvid}${tag}.mp3`;
  }
  const found = readdirSync(VOICE_DIR).find((f) => f.startsWith(`${bvid}${tag}.`));
  if (!found) throw new Error('下载后找不到文件');
  return `${VOICE_DIR}/${found}`;
}

/**
 * 用 bili.py 的 dlurl 拿直链，再用 ffmpeg 拉音频。
 * ffmpeg 必须带 Referer（B站 CDN 会 403），UA 也一起给。
 */
async function downloadByApi(bvid, dst, { head = false } = {}) {
  const { stdout } = await exec(BILI_PY, [BILI_TOOL, 'dlurl', bvid], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const j = JSON.parse(String(stdout || '{}'));
  if (!j.ok || !j.urls?.length) throw new Error('API 没给直链');
  const ffArgs = [
    '-y', '-loglevel', 'error',
    '-headers', 'Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0\r\n',
    '-i', j.urls[0].url, '-vn',
  ];
  if (head) ffArgs.push('-t', '70');
  ffArgs.push('-c:a', 'libmp3lame', '-b:a', '192k', dst);
  await exec('ffmpeg', ffArgs, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
}

/** 用 ffprobe 取音频总时长（秒） */
async function probeDuration(path) {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', path,
    ], { timeout: 20000 });
    return Math.round(Number(String(stdout).trim()) || 0);
  } catch { return 0; }
}

/** 切一段出来转成 mp3（QQ 语音用单声道，体积小、转换稳） */
async function cutSegment(src, dst, startSec, durSec) {
  const args = [
    '-y', '-loglevel', 'error',
    '-ss', String(Math.max(0, startSec)),
    '-t', String(durSec),
    '-i', src,
    '-vn', '-ac', '1', '-ar', '24000', '-b:a', '48k',
    dst,
  ];
  try {
    await exec('ffmpeg', args, { timeout: 60000, maxBuffer: 1024 * 1024 });
  } catch (e) {
    throw new Error(safeErr(e, '切段失败'));
  }
  return dst;
}

/**
 * 为一句"唱个XX"准备一条语音
 * @param {string} query 歌名/关键词
 * @returns {Promise<{ok:boolean, path?:string, title?:string, bvid?:string, sec?:number, reason?:string}>}
 */
/** 「女版/男版」这类版本词单独拎出来，不当歌名的一部分 */
export function splitVersion(s) {
  const t = String(s ?? '');
  const female = /女版|女生版|女声版|女声|女的唱/.test(t);
  const male = /男版|男生版|男声版/.test(t);
  // 「司凤版雨爱」「周深版」——除了男女声，任何「X版」都是版本要求。
  // 2026-10-31 主人点「唱完整版的司凤版雨爱」，版本词被剥掉后按普通《雨爱》选中原唱，
  // 她还以为模型听不懂人话。
  const namedRaw = (t.replace(/完整版|整首|全曲|整个版?/g, ' ').match(/([\u4e00-\u9fa5A-Za-z]{1,6})版/) || [])[1] || '';
  // 正则会把「的」一起吃进去（完整版的司凤版 → 的司凤），剔掉
  const named = namedRaw.replace(/^[的个了和与\s]+/, '');
  const flavor = named && !/^(女|男|女声|男声|女生|男生)$/.test(named) ? named : '';
  const kw = t.replace(/女版|女生版|女声版|女声|女的唱|男版|男生版|男声版/g, ' ')
    .replace(/完整版|整首|全曲/g, ' ')
    .replace(flavor ? new RegExp(`${flavor}版`, 'g') : /(?!)/, ' ')
    .replace(/[《》""'']/g, ' ')
    .replace(/\s+/g, ' ')
    // 「女版的忘情牛肉面」剥掉「女版」会剩个「的」，再清一次首尾虚词
    .replace(/^[的版\s、,，。]+|[的版\s、,，。]+$/g, '')
    .trim().slice(0, 40);
  return { kw, version: female ? 'female' : male ? 'male' : flavor, flavor };
}

/**
 * 只选歌、不下载不换声 —— 给「先报歌名、主人确认了再唱」用。
 * 返回 {ok, pick:{bvid,title,duration,author}}
 */
export async function previewSong(query) {
  const { kw, version } = splitVersion(query);
  if (!kw) return { ok: false, reason: '没听清要什么' };
  const sel = await pickSongVideo(kw, { title: kw, version });
  if (!sel.ok) return { ok: false, reason: sel.reason };
  return { ok: true, pick: sel.pick, why: sel.why ?? [] };
}

export async function makeVoice(query, { pick: forced = null } = {}) {
  gc();
  const { kw, version } = splitVersion(query);
  if (!kw) return { ok: false, reason: '没听清要什么' };

  // 选片：标题匹配 + 时长筛选 + 排除合集/reaction/remix，不只按播放量
  const sel = forced ? { ok: true, pick: forced, why: ['已确认'] } : await pickSongVideo(kw, { title: kw, version });
  if (!sel.ok) return { ok: false, reason: sel.reason };
  const pick = sel.pick;
  const bvid = pick.bvid;
  console.log(`  [voice] 选中 ${bvid}「${String(pick.title).slice(0, 36)}」`
    + ` ${pick.duration} | ${(sel.why ?? []).join('、')}`);

  // 缓存命中直接用
  if (existsSync(cachePath(bvid))) {
    // 缓存命中也要过一遍换声：否则「第一次没配 /sing、后来配了」的歌永远是原曲
    const herCached = await singRemote(cachePath(bvid), bvid);
    return {
      ok: true, path: herCached || cachePath(bvid), her: !!herCached, title: pick.title, bvid,
      label: (version ? '女版的' : '') + String(kw).slice(0, 16), sec: SEG_SEC, cached: true,
    };
  }

  let info;
  try { info = await biliInfo(bvid); } catch { info = { ok: false }; }
  const total = Number(info?.duration ?? 0) || parseDuration(pick.duration);

  // 一律从头开始，不切中间（用户 2026-10-27 要求：不要挖中段）
  const start = 0;
  let dur = SEG_SEC;
  if (total > 0 && total < SEG_SEC) dur = Math.max(10, total - 1);

  let src;
  try { src = await downloadAudio(bvid); }
  catch (e) { return { ok: false, reason: '下载失败: ' + e.message }; }

  try {
    await cutSegment(src, cachePath(bvid), start, dur);
  } catch (e) {
    return { ok: false, reason: '切段失败: ' + e.message };
  }

  const size = statSync(cachePath(bvid)).size;
  if (size < 2000) return { ok: false, reason: '切出来的文件太小，可能没声音' };

  // 配了本地 /sing 就用她的嗓子唱；失败/没配就放原曲（不能因为换声失败就不发语音）
  const her = await singRemote(cachePath(bvid), bvid);

  return {
    ok: true, path: her || cachePath(bvid), her: !!her, title: pick.title, bvid,
    label: (version ? '女版的' : '') + String(kw).slice(0, 16), sec: dur, start, size, cached: false,
  };
}

function parseDuration(s) {
  const m = String(s ?? '').match(/^(\d+):(\d+)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** 本地音频 → CQ 码（自动换成容器内路径） */
export function recordCQ(absPath) {
  return `[CQ:record,file=${toFileUrl(absPath)}]`;
}


// ── 整首分段 ────────────────────────────────────────────
//
// QQ 单条语音上限 60 秒，所以整首要拆成多段发。
// 缓存：整首的每一段都落盘，下次同一首直接复用（meta 文件记录段数）。

const FULL_MAX_SEG = Number(process.env.VOICE_FULL_MAX_SEG ?? 6);   // 最多发几段（约 6 分钟）

function fullMetaPath(bvid) { return `${VOICE_DIR}/${bvid}_full.json`; }

/**
 * 扒整首歌，切成多段
 * @returns {Promise<{ok:boolean, segments?:string[], title?:string, bvid?:string,
 *                    total?:number, count?:number, truncated?:boolean, cached?:boolean, reason?:string}>}
 */
export async function makeVoiceFull(query, { maxSeg = FULL_MAX_SEG, onSegment = null, pick: forced = null } = {}) {
  gc();
  const { kw: rawKw, version } = splitVersion(query);
  const kw = rawKw.replace(/(完整版|整首|全曲|整首歌|完整)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!kw) return { ok: false, reason: '没听清要什么' };

  // 主人已经确认过曲目时直接用那个，不再重选（重选可能选出另一首）
  let pick;
  let why;
  if (forced) {
    pick = forced;
    why = ['已确认'];
  } else {
    const sel = await pickSongVideo(kw, { title: kw, version });
    if (!sel.ok) return { ok: false, reason: sel.reason };
    pick = sel.pick;
    why = sel.why ?? [];
  }
  const bvid = pick.bvid;
  console.log(`  [voice] 整首选中 ${bvid}「${String(pick.title).slice(0, 36)}」`
    + ` ${pick.duration} | ${why.join('、')}`);

  // 缓存命中
  const meta = (() => {
    try { return JSON.parse(readFileSync(fullMetaPath(bvid), 'utf8')); } catch { return null; }
  })();
  if (meta && meta.count > 0) {
    const segs = [];
    for (let i = 0; i < meta.count; i += 1) {
      const p = `${VOICE_DIR}/${bvid}_full_${i}.mp3`;
      if (!existsSync(p)) { segs.length = 0; break; }
      segs.push(p);
    }
    if (segs.length) {
      const hers = [];
      for (let i = 0; i < segs.length; i += 1) {
        const her = await singRemoteTo(segs[i], segs[i].replace(/\.mp3$/, '_her.mp3'));
        const p = her || segs[i];
        hers.push(p);
        if (her) console.log(`  [voice] 整首换声 ${i + 1}/${segs.length}`);
        if (onSegment) await onSegment({ path: p, index: i, total: segs.length, sec: SEG_SEC });
      }
      return {
        ok: true, segments: hers, her: hers.some((p, i) => p !== segs[i]),
        title: pick.title, bvid,
        total: meta.total, count: segs.length, truncated: meta.truncated, cached: true,
      };
    }
  }

  // 下载整条音频
  let src;
  try { src = await downloadAudio(bvid); }
  catch (e) { return { ok: false, reason: '下载失败: ' + e.message }; }

  const total = await probeDuration(src);
  if (!total) {
    try { unlinkSync(src); } catch { /* ignore */ }
    return { ok: false, reason: '读不出时长' };
  }

  const need = Math.ceil(total / SEG_SEC);
  const count = Math.min(need, Math.max(1, Number(maxSeg) || FULL_MAX_SEG));

  const segments = [];
  const hers = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const dst = `${VOICE_DIR}/${bvid}_full_${i}.mp3`;
      await cutSegment(src, dst, i * SEG_SEC, SEG_SEC);
      segments.push(dst);
      // 换完这一段就立刻交出去，不等后面几段（主人 2026-10-31 要求）
      const her = await singRemoteTo(dst, dst.replace(/\.mp3$/, '_her.mp3'));
      const p = her || dst;
      hers.push(p);
      if (her) console.log(`  [voice] 整首换声 ${i + 1}/${count}`);
      if (onSegment) await onSegment({ path: p, index: i, total: count, sec: SEG_SEC });
    }
  } catch (e) {
    return { ok: false, reason: '切段失败: ' + e.message };
  } finally {
    try { unlinkSync(src); } catch { /* ignore */ }
  }

  writeFileSync(fullMetaPath(bvid), JSON.stringify({
    total, count, truncated: need > count, segSec: SEG_SEC,
  }));

  return {
    ok: true, segments: hers, her: hers.some((p, i) => p !== segments[i]),
    title: pick.title, bvid,
    total, count, truncated: need > FULL_MAX_SEG, cached: false,
  };
}


/** 判断一句是不是在点歌（模型判，仅在规则已经认为是歌时才调） */
export { judgeSong };
