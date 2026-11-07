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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bvVariants } from './videoref.mjs';
import { biliSearch, biliInfo, runBili } from './search.mjs';
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
// 2026-11-03 主人要求：唱歌不做时长限制，腾讯能发多长就发多长。
// 实测 NapCat 收 120s / 240s 的 record 都回 retcode 0（真 message_id），
// 所以默认段长从 59 秒放到 240 秒 —— 一首 4 分钟的歌一段就完，不用切 5 刀。
// 2026-11-03 主人要求：整首一次处理、一次发，别在中间切。
// 3600 秒 = 60 分钟内都当一整段 → need=1 → 只切一次（等于不切）、只调一次 /sing。
// 若腾讯拒收超长语音（retcode 报错），改回 240 即可（VOICE_SEG_SEC=240）。
const SEG_SEC = Number(process.env.VOICE_SEG_SEC ?? 3600);
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
function singOpts(override = null) {
  // feiyu 是「肥鱼大小姐」RVC v2（manifest 定的 index 0.3 / protect 0.33 / rmvpe）。
  // 2026-11-07 接进来当默认：她自己的声音唱自己的歌。
  const o = { model: 'feiyu', protect: 0.33, index: 0.3 };
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
  // 「这首用 amiya 的嗓子」：只在这一次调用里换模型，不写设置——
  // 主人点歌时顺手指定，不该把他全局的嗓子改掉。
  if (override) {
    const m = String(override).trim();
    if (m) {
      o.model = m;
      try {
        const base = process.env.DSH_HOME || '/root/.dsh';
        const p2 = `${base}/voice/${m.replace(/[^A-Za-z0-9_-]/g, '')}/opts.json`;
        const b = JSON.parse(readFileSync(p2, 'utf8'));
        if (Number.isFinite(Number(b.protect))) o.protect = Number(b.protect);
        if (Number.isFinite(Number(b.indexRate))) o.index = Number(b.indexRate);
      } catch { /* 没定参就沿用全局的 */ }
    }
  }
  if (process.env.SING_MODEL && !override) o.model = String(process.env.SING_MODEL);
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
    // 单次预算按段长给：240 秒的段，GPU 分离+换声要 60~90 秒，
    // 原来固定 60 秒会在中途 abort（2026-11-03 20:53 就是「This operation was aborted」，
    // 然后回落原曲 —— 主人听到杨丞琳）。段越长给越长，下限 90 秒。
    const segSec = Number(process.env.VOICE_SEG_SEC ?? 240);
    // 上限 5 分钟：段长现在等于整首（3600），不能按 0.9 倍算成 54 分钟，
    // 否则一次挂死会把整条消息堵到天荒地老。
    const ATTEMPT_MS = Math.min(300_000, Math.max(90_000, Math.round(segSec * 1000 * 0.9) + 30_000));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ATTEMPT_MS);
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
        const timer2 = setTimeout(() => ctrl2.abort(), ATTEMPT_MS + 60_000);
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

// ── 整首换声只做一次（2026-11-04 主人要求）─────────────────────────────
//
// 为什么不能把「段长」写进缓存键：SEG_SEC 改一次（59→240→3600），
// 同一首《雨爱》就重换三遍嗓子 —— 最贵的一步（本地 GPU 分离 + 换声，
// 一次 86~150 秒）白跑，而盘上其实躺着同样的 6096KB。
//
// 现在只缓存「整首已换声的一条」，发的时候再按段长切（ffmpeg，1 秒）。
// 段长怎么改、点几次，GPU 都只跑一次。
const HER_CHUNK_SEC = Number(process.env.HER_CHUNK_SEC ?? 150);   // 单次送换声的块长

// 换声结果按**模型**分开存：同一个 bvid 用 feiyu 换过、又用 amiya 换过，
// 是两条不同的音频。混在一起就会出现"点雨爱，唱出来是另一个嗓子"。
// 目录名就是模型名，切模型等于换目录，互不干扰。
function modelDir(model) {
  // 模型名要拼进路径，先洗一遍：只留字母数字和 _ -，防 ../ 写出缓存目录
  const raw = String(model || singOpts().model || 'default').trim() || 'default';
  const m = raw.replace(/[^A-Za-z0-9_-]/g, '') || 'default';
  const dir = `${VOICE_DIR}/${m}`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 整首换声结果的落盘位置（按模型 + 不含段长） */
export function herFullPath(bvid, model) {
  return `${modelDir(model)}/${bvid}_herfull.mp3`;
}

function herPartPath(bvid, i, model) {
  return `${modelDir(model)}/${bvid}_herpart_${i}.mp3`;
}

// ── 换声曲库索引 ────────────────────────────────────────
// 缓存文件名是 bvid，人看不懂；TG 那边要「随便来一首缓存里的歌」，
// 就得有 bvid → 歌名 的对照。顺带记住时长，省一次 ffprobe。
const SONG_INDEX = `${VOICE_DIR}/index.json`;

// ── 音色（换声模型）切换 ──────────────────────────────
//
// 2026-11-07 主人要求：QQ 里发条命令就能看有哪些嗓子、直接切。
// 模型名归 /sing 那头管（rvc_models/ 下的一级子目录），所以列表向服务现问，
// 不在本地写死 —— 往本地丢个新模型目录，这里立刻能看到。
//
// 切换只改 settings.json（和设置页同一个文件），singOpts() 每条都现读，
// 所以切完下一首就生效，不用重启桥。

/** 现在用的是哪个嗓子（同 singOpts，只是给命令层一个语义清楚的名字） */
export function currentModel() { return singOpts().model; }

/** 默认嗓子：切过之后还留一手，一句话能回到它 */
export const DEFAULT_MODEL = 'amiya';

/**
 * 模型的中文小名。列表只显示 feiyu / amiya2 这种标识，主人分不清哪个是哪个
 * —— 2026-11-07「我之前用的阿米娅是哪一个？」
 * 名字放这儿，别写进配置；本地 rvc_models/ 里没有的模型就不显示小名。
 */
export const MODEL_LABELS = {
  amiya: '阿米娅 · 初版（唱得最稳，10-31 定的那版）',
  amiya2: '阿米娅 · 重训（11-03 100 轮，素材多一份）',
  anjie: '安洁莉娜 · 初版',
  anjie2: '安洁莉娜 · 重训（10-31 A/B 定稿那版）',
  feiyu: '肥鱼大小姐（她自己的声音）',
};

/** 服务那边有哪些模型；连不上返回 [] */
export async function listModels() {
  const url = singUrl();
  if (!url) return [];
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.models) ? j.models.map(String) : [];
  } catch { return [] }
}

/**
 * 切模型：写 settings.json 的 rvcModel。
 * @returns {Promise<{ok:boolean, model?:string, reason?:string}>}
 */
export async function setModel(name) {
  const want = String(name ?? '').trim();
  if (!want) return { ok: false, reason: '没给模型名' };
  const models = await listModels();
  if (!models.length) return { ok: false, reason: '换声服务没开（拿不到模型列表）' };
  const hit = models.find((m) => m.toLowerCase() === want.toLowerCase());
  if (!hit) return { ok: false, reason: `没这个嗓子（有：${models.join(' / ')}）` };
  const base = process.env.DSH_HOME || '/root/.dsh';
  const f = `${base}/voice/settings.json`;
  try {
    const cfg = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) || {}) : {};
    cfg.rvcModel = hit;
    // 换模型顺手带上该模型自己的定参（存在 modelDir 旁边的 opts.json 里），
    // 没有就不动 —— 宁可沿用旧的，也别把别的模型的参数硬套上去
    try {
      const o = JSON.parse(readFileSync(`${modelDir(hit)}/opts.json`, 'utf8'));
      if (Number.isFinite(Number(o.protect))) cfg.rvcProtect = Number(o.protect);
      if (Number.isFinite(Number(o.indexRate))) cfg.rvcIndexRate = Number(o.indexRate);
    } catch { /* 没有定参文件 */ }
    writeFileSync(f, JSON.stringify(cfg, null, 2));
    return { ok: true, model: hit };
  } catch (e) {
    return { ok: false, reason: `写不进设置：${String(e?.message ?? e).slice(0, 60)}` };
  }
}

export function readSongIndex() {
  try { return JSON.parse(readFileSync(SONG_INDEX, 'utf8')) || {} } catch { return {} }
}

export function rememberSong(bvid, info = {}) {
  try {
    const idx = readSongIndex();
    idx[bvid] = { ...(idx[bvid] || {}), ...info, at: Date.now() };
    writeFileSync(SONG_INDEX, JSON.stringify(idx, null, 1));
  } catch { /* 索引写不进去不影响唱歌 */ }
}

// ── 先查曲库，再去搜（2026-11-07 主人要求）──────────────────────────
//
// 原来点歌是「问模型是不是歌 → 搜 B 站 → 打分 → 才发现缓存里有」，
// 明明 3 秒能出的东西，光选片就花掉 3 秒。现在顺序倒过来：
// 先按歌名在换声曲库里找，命中就直接发，不联网、不问模型。
//
// 但「命中」必须精确：主人点《雨爱》不能给他《雨爱（司凤版）》，
// 点《雨爱（司凤版）》也不能给原版；点了「XX版」而库里没有，就得去搜。
const VER_WORDS = /(女版|女生版|女声版|女声|男版|男生版|男声版|完整版|整首|全曲|live|现场|翻唱|版)/gi;

/** 把标题洗成能比较的样子：去装饰、去书名号、去版本词、去标点空格 */
function normalizeTitle(t) {
  return String(t ?? '')
    .replace(/[《》「」【】\[\]（）()""''“”]/g, ' ')
    .replace(VER_WORDS, ' ')
    .replace(/[｜|·・\-—–_/\\,，。.、:：;；!！?？~～"' ]+/g, '')
    .toLowerCase()
    .trim();
}

/** 这条缓存记录的标题里有没有「版本词」，是哪个 */
function versionOf(title) {
  const t = String(title ?? '');
  const named = (t.replace(/完整版|整首|全曲/g, ' ').match(/([\u4e00-\u9fa5A-Za-z]{1,6})版/) || [])[1] || '';
  const v = named.replace(/^[的个了和与\s]+/, '');
  if (v && !/^(女|男|女声|男声|女生|男生)$/.test(v)) return v;
  if (/女版|女生版|女声版|女声/.test(t)) return '女声';
  if (/男版|男生版|男声版/.test(t)) return '男声';
  return '';
}

/**
 * 在换声曲库里找这首歌。
 * @param {string} query 用户点的（可能带「司凤版」这类版本词）
 * @returns {object|null} 命中返回 cachedSongs() 那种记录，否则 null
 */
export function findCached(query) {
  const { kw, version, flavor } = splitVersion(query);
  const want = normalizeTitle(kw);
  if (!want || want.length < 2) return null;   // 「酒」「歌」这种一个字的不猜
  const wantVer = String(version || flavor || '').replace(/版$/, '');
  const wantLive = /live|现场|翻唱/i.test(String(query || ''));

  const hits = cachedSongs().filter((s) => {
    const title = normalizeTitle(s.title);
    // 标题里得真包含这个歌名（宁可短一点，也别把《雨爱》匹配到《雨爱(司凤版)》上）
    return title.includes(want);
  });
  if (!hits.length) return null;

  // ② 「live/现场/翻唱」也是版本要求，库里没有就让她去搜
  if (wantLive && !hits.some((s) => /live|现场|翻唱/i.test(String(s.title)))) return null;

  // ① 要了某个版本：只认带那个版本词的；库里没有就返回 null，让上层去搜
  if (wantVer) {
    const exact = hits.find((s) => {
      const v = versionOf(s.title);
      const norm = normalizeTitle(s.title);
      return norm.includes(normalizeTitle(wantVer)) || v === wantVer;
    });
    return exact || null;
  }

  // ② 没要版本：优先「标题里没有版本词」的那条（原版）
  const plain = hits.find((s) => !versionOf(s.title));
  return plain || null;   // 只有版本货、没有原版 → 也返回 null，让它去搜原版
}

/** 缓存里「整首已换声」的歌，最近用过的排前面 */
export function cachedSongs() {
  const idx = readSongIndex();
  const out = [];
  const cur = singOpts().model;
  for (const [bvid, v] of Object.entries(idx)) {
    const p = herFullPath(bvid, cur);
    try {
      if (statSync(p).size > 100 * 1024) {
        out.push({ bvid, title: String(v.title || bvid), sec: Number(v.sec || 0), at: Number(v.at || 0) });
      }
    } catch { /* 文件没了就跳过 */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

async function concatAudio(list, out) {
  const txt = `${VOICE_DIR}/concat-${Date.now()}.txt`;
  writeFileSync(txt, list.map((q) => `file '${q}'`).join('\n'));
  try {
    await exec('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', out],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    try { unlinkSync(txt) } catch { /* 忽略 */ }
  }
}

/**
 * 把整首歌换成她的嗓子，落一条 `_herfull.mp3`，之后永久复用。
 * 没有配本地 /sing 时也照常工作（等于原唱拼一条，行为跟以前一致）。
 * @returns {Promise<{path:string, her:boolean, total:number, cached:boolean}>}
 */
export async function ensureHerFull(bvid, modelOverride = null) {
  const model = singOpts(modelOverride).model;
  const out = herFullPath(bvid, model);
  if (existsSync(out) && statSync(out).size > 100 * 1024) {
    console.log(`  [voice] 缓存命中（整首换声 · ${model}）${Math.round(statSync(out).size / 1024)}KB`);
    const total = await probeDuration(out);
    rememberSong(bvid, { sec: Math.round(total || 0) });
    return { path: out, her: true, total, cached: true };
  }
  const src = await downloadAudio(bvid);
  const total = await probeDuration(src);
  if (!total) throw new Error('读不出时长');

  const n = Math.max(1, Math.ceil(total / HER_CHUNK_SEC));
  const parts = [];
  let converted = 0;
  for (let i = 0; i < n; i += 1) {
    const seg = herPartPath(bvid, i, model);
    const dur = Math.min(HER_CHUNK_SEC, total - i * HER_CHUNK_SEC);
    if (!existsSync(seg) || statSync(seg).size < 2000) await cutSegment(src, seg, i * HER_CHUNK_SEC, dur);
    const her = await singRemoteTo(seg, seg.replace(/\.mp3$/, '_her.mp3'));
    if (her) converted += 1;
    parts.push(her || seg);
    console.log(`  [voice] 整首换声 ${i + 1}/${n}${her ? '' : '（这段失败，保留原唱）'}`);
  }
  if (parts.length === 1) copyFileSync(parts[0], out);
  else await concatAudio(parts, out);
  console.log(`  [voice] 整首换声完成 ${Math.round(statSync(out).size / 1024)}KB（模型 ${model}）`
    + `（${n} 块，${converted} 块是她的嗓子）`);
  return { path: out, her: converted > 0, total, cached: false };
}

/** 从整首换声结果里切第 index 段（便宜，不碰 GPU） */
export async function cutForSend(bvid, index, sec, modelOverride = null) {
  const model = singOpts(modelOverride).model;
  const src = herFullPath(bvid, model);
  const dst = `${modelDir(model)}/${bvid}_send_${sec}s_${index}.mp3`;
  if (existsSync(dst) && statSync(dst).size > 2000) return dst;
  await cutSegment(src, dst, index * sec, sec);
  return dst;
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

/**
 * 直接用 BV 号/av 号拿音频 —— 不走搜索、不打分。
 *
 * 为什么要有这条：一首歌在 B 站几十个版本，标题筛选永远有猜错的可能。
 * 主人直接甩链接就没歧义了（2026-11-06 要求：「我发链接或者 BV 号，你去找对应的视频」）。
 *
 * @param {{bvid?:string, avid?:number, page?:number}} ref
 */
export async function makeVoiceByRef(ref) {
  gc();
  let bvid = String(ref?.bvid ?? '').trim();
  let page = Number(ref?.page ?? 0) || 0;
  if (!bvid && ref?.avid) {
    const r = await runBili(['avid', String(ref.avid)]);
    if (!r.ok || !r.bvid) return { ok: false, reason: '这个 av 号查不到视频' };
    bvid = r.bvid;
  }
  if (!/^BV[0-9A-Za-z]{10}$/i.test(bvid)) return { ok: false, reason: 'BV 号格式不对' };

  // 大小写打错很常见（bvid 区分大小写），查不到就换写法重试
  // ⚠️ 只认「服务端回报的 bvid 和输入一致」的那一次。
  // bilibili_api 对全小写 bvid 会抛 ArgsException，而 downloadByApi / 换声用的是原始字符串，
  // 拿错的 bvid 会换出一段完全不相干的音频（实测 137s 的歌换出 28s）。
  let info = null;
  for (const v of bvVariants(bvid)) {
    const r = await runBili(['info', v]);
    const back = String(r?.bvid || '');
    if (r.ok && r.title && back.toLowerCase() === v.toLowerCase()) { info = r; bvid = back; break; }
    if (r.ok && r.title && !info) info = r;   // 先记着，全部失败时再兜底
  }
  if (!info) return { ok: false, reason: '这条视频查不到（可能已删除或仅限登录观看）' };

  const total = Number(info.duration) || 0;
  if (total > 0 && total < 8) return { ok: false, reason: '这条太短了，不像歌' };
  if (page > 1 && total === 0) page = 0;   // 多 P 的时长拿不到就按整条来

  console.log(`  [voice] 指定视频 ${bvid}「${String(info.title).slice(0, 36)}」${fmtSec(total)}`);

  const full = await ensureHerFull(bvid);
  let dur = SEG_SEC;
  const tot = Number(full.total) || total;
  if (tot > 0 && tot < dur) dur = Math.max(10, tot - 1);

  let path;
  try { path = await cutForSend(bvid, 0, dur, modelOverride); }
  catch (e) { return { ok: false, reason: '切段失败: ' + e.message }; }
  if (statSync(path).size < 2000) return { ok: false, reason: '切出来的文件太小，可能没声音' };

  rememberSong(bvid, { title: String(info.title).replace(/\s+/g, ' ').trim(), sec: Math.round(tot || 0) });
  return {
    ok: true, path, her: !!full.her, title: info.title, bvid,
    label: String(info.title).slice(0, 16), sec: dur, start: 0,
    size: statSync(path).size, cached: !!full.cached,
  };
}

function fmtSec(s) {
  const n = Number(s) || 0
  return n ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : ''
}

export async function makeVoice(query, { pick: forced = null, model: modelOverride = null } = {}) {
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

  // ① 整首换成她的嗓子（一次，永久复用；跟段长无关）
  let full;
  try {
    full = await ensureHerFull(bvid, modelOverride);
  } catch (e) {
    return { ok: false, reason: '换声/下载失败: ' + e.message };
  }
  // ② 只切要发的那一段
  const total = Number(full.total) || parseDuration(pick.duration);
  let dur = SEG_SEC;
  if (total > 0 && total < dur) dur = Math.max(10, total - 1);

  let path;
  try { path = await cutForSend(bvid, 0, dur, modelOverride); }
  catch (e) { return { ok: false, reason: '切段失败: ' + e.message }; }

  const size = statSync(path).size;
  if (size < 2000) return { ok: false, reason: '切出来的文件太小，可能没声音' };

  rememberSong(bvid, { title: String(pick.title).replace(/\s+/g, ' ').trim(), sec: Math.round(total || 0) });
  return {
    ok: true, path, her: !!full.her, title: pick.title, bvid,
    label: (version ? '女版的' : '') + String(kw).slice(0, 16),
    sec: dur, start: 0, size, cached: !!full.cached,
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
// 缓存：整首换声只做一次（_herfull.mp3），切片按段长现切 —— 见 ensureHerFull。

const FULL_MAX_SEG = Number(process.env.VOICE_FULL_MAX_SEG ?? 6);   // 最多发几段（约 6 分钟）

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

  // 整首换成她的嗓子（一次），再按段长切 —— 段长怎么改都不重跑 GPU
  let full;
  try {
    full = await ensureHerFull(bvid, modelOverride);
  } catch (e) {
    return { ok: false, reason: '换声/下载失败: ' + e.message };
  }
  const total = Number(full.total) || 0;
  if (!total) return { ok: false, reason: '读不出时长' };

  const need = Math.ceil(total / SEG_SEC);
  const count = Math.min(need, Math.max(1, Number(maxSeg) || FULL_MAX_SEG));
  const hers = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const p = await cutForSend(bvid, i, SEG_SEC);
      hers.push(p);
      // 切一段发一段，不等后面几段（主人 2026-10-31 要求）
      if (onSegment) await onSegment({ path: p, index: i, total: count, sec: SEG_SEC });
    }
  } catch (e) {
    return { ok: false, reason: '切段失败: ' + e.message };
  }

  return {
    ok: true, segments: hers, her: !!full.her, title: pick.title, bvid,
    total, count, truncated: need > count, cached: !!full.cached,
  };
}


/** 判断一句是不是在点歌（模型判，仅在规则已经认为是歌时才调） */
export { judgeSong };
