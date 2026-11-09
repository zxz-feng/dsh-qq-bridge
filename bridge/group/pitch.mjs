/**
 * 客户端测源人声基频 → 算出该升几个半音。
 *
 * 为什么要在客户端算，而不是交给本地 /sing：
 *   本地服务用 numpy 取中位数，实测把《恋爱循环》103.9Hz 报成 216.2Hz
 *   （整整差一个八度，谐波检测失败），把《world Key版》128Hz 报成 195Hz。
 *   2026-11-08 主人验收四首，三首音高偏 2~8 个半音，全是这个原因。
 *   所以改成：云端自己从原始音源测 f0，算出整数半音，显式传 pitch=N，
 *   服务端不再猜。同一首歌测一次记下来，重唱复用。
 *
 * 算法：时域自相关（ACF）。只用 ffmpeg 转码 + Node 纯计算，不装 librosa/aubio。
 *   - 先 ffmpeg 转 16kHz 单声道 s16le
 *   - 每 1024 帧一帧，RMS 低于门限的跳过（静音/极轻）
 *   - 在 [70, 420] Hz 对应的 lag 区间找 ACF 最大值 → 该帧 f0
 *   - 所有有效帧取中位数（中位数比均值抗倍频/半频异常值）
 *
 * 实测对照（2026-11-08，同一批文件 vs python 参考实现）：
 *   消愁 129.0 / 雨爱 250.0 / 恋爱循环 103.9 / world Key 128.0 / 心似烟火 210.5
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const exec = promisify(execFile);

/** 目标基频：唱阿米娅的音域按 262Hz（C4）拉 */
export const TARGET_F0 = Number(process.env.SING_TARGET_F0 || 262);
/** 半音上下限，和 serve_tailnet.py 的钳位一致 */
const PITCH_MIN = -12;
const PITCH_MAX = 18;
/** 低于这个 RMS（s16 满量程 32768）的帧当静音丢掉 */
const RMS_FLOOR = 800;
const FRAME = 1024;
/** 搜索范围：70~420Hz，覆盖大部分人类演唱 */
const F0_LO = 70;
const F0_HI = 420;

/**
 * 用 ffmpeg 把任意音频转成 16k 单声道 s16le，再自相关求中位 f0。
 * @param {string} file 音频路径（mp3/m4a/wav 都行）
 * @returns {Promise<{f0:number, frames:number}>} f0=0 表示没测出人声
 */
export async function detectF0(file) {
  const sr = 16000;
  const { stdout } = await exec('ffmpeg', [
    '-v', 'error', '-i', file,
    '-ac', '1', '-ar', String(sr), '-f', 's16le', '-',
  ], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

  const n = Math.floor(stdout.length / 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) pcm[i] = stdout.readInt16LE(i * 2);

  const lagMin = Math.max(2, Math.floor(sr / F0_HI));
  const lagMax = Math.min(FRAME - 2, Math.floor(sr / F0_LO));
  const vals = [];

  for (let start = 0; start + FRAME <= pcm.length; start += FRAME) {
    // 能量门限
    let energy = 0;
    for (let i = 0; i < FRAME; i += 1) energy += pcm[start + i] * pcm[start + i];
    if (Math.sqrt(energy / FRAME) < RMS_FLOOR) continue;

    // 自相关：步长 2 足够（省一半算力，精度无影响——上采样到 16k 后
    // lag 分辨率本身就是 1/16000 秒，2 步长只是少算偶数点）
    let best = 0;
    let bestLag = 0;
    for (let lag = lagMin; lag <= lagMax; lag += 1) {
      let sum = 0;
      for (let i = 0; i + lag < FRAME; i += 2) sum += pcm[start + i] * pcm[start + i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    if (bestLag > 0) {
      const f = sr / bestLag;
      if (f > F0_LO && f < F0_HI) vals.push(f);
    }
  }

  if (vals.length < 20) return { f0: 0, frames: vals.length };
  vals.sort((a, b) => a - b);
  return { f0: vals[Math.floor(vals.length / 2)], frames: vals.length };
}

/* ─────────── 远程测频（2026-11-09 主人定方案 A） ───────────
 *
 * 为什么废弃本地自相关：
 *   上面的 ACF 在《恋爱循环》上测出 103.9Hz，而 pyworld harvest / rmvpe / pm
 *   三种独立实现一致报 329~352Hz —— 真实基频是 334Hz 附近（花澤香菜高音区）。
 *   ACF 在长 lag 处找到了虚假强峰，是典型的**次谐波误判**（低约 3 倍）。
 *   后果：算出 +15 半音，实际把 334Hz 推到 796Hz，越过 f0_max=1100 的 mel
 *   桶封顶，模型只能吐一个被压扁的音 → 听起来"压根没变"。
 *
 * 现在：本地服务暴露 POST /f0（harvest / rmvpe / pm），云端只发一段音频过去
 * 拿专业算法算出的中位基频。测一次约 10~30 秒，结果写 f0.json 永久复用。
 */

/** 本地 /f0 用哪个算法：rmvpe 比 harvest 快 3 倍，中位只差 ~1 个半音 */
const F0_METHOD = process.env.SING_F0_METHOD || 'rmvpe';
/** 只测前 N 秒（副歌之前音域稳定，且省时间） */
const F0_CLIP_SEC = Number(process.env.SING_F0_CLIP || 45);
/** 单次请求预算 */
const F0_TIMEOUT_MS = Number(process.env.SING_F0_TIMEOUT || 180000);

/** 从配置里取本地服务地址与模型（与 voice.mjs 同一份 settings） */
function remoteBase() {
  const url = process.env.SING_URL || process.env.RVC_URL || '';
  return String(url).replace(/\/+$/, '');
}

/**
 * 调本地 /f0 测源人声基频。
 * @param {string} file 音频路径（任意格式，服务端自己解）
 * @param {{url?:string, method?:string, clipSec?:number}} opt
 * @returns {Promise<{f0:number, frames:number, method:string, ms:number, sep:string}>}
 */
export async function detectF0Remote(file, opt = {}) {
  const base = String(opt.url || remoteBase()).replace(/\/+$/, '');
  if (!base) throw new Error('没配换声地址（rvcUrl），无法远程测频');

  // 截前 N 秒再发，整首发过去要传几十 MB 且分离整首太慢
  const clipSec = Number(opt.clipSec || F0_CLIP_SEC);
  const tmp = `${file}.f0clip.wav`;
  await exec('ffmpeg', [
    '-v', 'error', '-y', '-i', file, '-t', String(clipSec),
    '-ac', '1', '-ar', '44100', tmp,
  ], { maxBuffer: 64 * 1024 * 1024 });

  const buf = readFileSync(tmp);
  try { unlinkSync(tmp); } catch { /* 删不掉无所谓 */ }

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'clip.wav');
  form.append('method', String(opt.method || F0_METHOD));
  form.append('no_sep', '0');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), F0_TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(`${base}/f0`, { method: 'POST', body: form, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`/f0 ${res.status}: ${text.slice(0, 160)}`);
    json = JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
  if (!json?.ok) throw new Error(`/f0 返回不 ok: ${JSON.stringify(json).slice(0, 160)}`);
  return {
    f0: Number(json.f0) || 0,
    frames: Number(json.frames) || 0,
    method: String(json.method || ''),
    ms: Number(json.ms) || 0,
    sep: String(json.sep || ''),
  };
}

/**
 * 测源基频 → 算升几个半音（整数）。
 * @returns {Promise<{pitch:number, f0:number, target:number, frames:number}>}
 *   f0 测不出来时 pitch=0（不升不降，总比瞎升好）
 */
export async function pitchFor(file, opt = {}) {
  let f0 = 0;
  let frames = 0;
  let by = 'acf';
  // 远端专业算法优先；连不上才退回本地 ACF（ACF 会次谐波误判，见文件头注释）
  try {
    const r = await detectF0Remote(file, opt);
    if (r.f0 > 0) { f0 = r.f0; frames = r.frames; by = r.method || 'remote'; }
  } catch (e) {
    if (!opt.silent) console.log(`  [voice] 远端测频不可用（${e.message}），退回本地 ACF`);
  }
  if (!f0) {
    const r = await detectF0(file);
    f0 = r.f0;
    frames = r.frames;
  }
  if (!f0) return { pitch: 0, f0: 0, target: TARGET_F0, frames, by };
  const raw = 12 * Math.log2(TARGET_F0 / f0);
  const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(raw)));
  return { pitch, f0, target: TARGET_F0, frames, by };
}

/** 半音 → 实际落到的频率（给日志用） */
export function semitoneTo(f0, pitch) {
  return f0 * 2 ** (pitch / 12);
}

/**
 * 带缓存版的 pitchFor：测过的 BV 号记在 ${dir}/f0.json，重唱不再重测。
 * 键用 BV 号，值 { f0, pitch, at }。
 */
let cacheFile = '';
let cacheMap = null;
export function f0CacheInit(file) {
  cacheFile = file;
  try { cacheMap = JSON.parse(readFileSync(file, 'utf8')); } catch { cacheMap = {}; }
}
export function f0Cached(bvid) {
  const v = cacheMap?.[bvid];
  if (!v || !(v.f0 > 0)) return null;
  return v;
}
export function f0Store(bvid, rec) {
  if (!cacheFile) return;
  if (!cacheMap) cacheMap = {};
  cacheMap[bvid] = { ...rec, at: new Date().toISOString() };
  try { writeFileSync(cacheFile, JSON.stringify(cacheMap, null, 2)); } catch { /* 写不进就算了，下次重测 */ }
}
