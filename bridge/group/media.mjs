/**
 * 富媒体：表情包收集识别 + 发图 + 戳一戳 + 表情回应
 *
 * 核心是"看懂"：群友发个表情包，小鲸鱼得知道那是"无语"还是"笑死"。
 * 所以每张新图用视觉模型识别一次，按 md5 入库，之后直接查表（0 成本）。
 *
 * 动图（GIF）取 3 帧拼一张横图再识别 —— 只看第一帧经常误判
 * （比如一个"逐渐离谱"的动图，第一帧可能平平无奇）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readJson, writeJson, STORE } from './store.mjs';
import { HOST_MEDIA, toFileUrl } from './paths.mjs';

const GATEWAY = process.env.DSH_GATEWAY ?? 'http://127.0.0.1:8327/v1';
const API_KEY = process.env.WORKBUDDY_GATEWAY_API_KEY ?? 'wb-gateway-local';
const VISION_MODEL = process.env.VISION_MODEL ?? 'deepseek-v4.1-flash';

// ⚠️ 表情包也要放在容器挂载区，否则发不出去
const STICKER_DIR = `${HOST_MEDIA}/stickers`;
const INDEX_FILE = `${STICKER_DIR}/index.json`;
if (!existsSync(STICKER_DIR)) mkdirSync(STICKER_DIR, { recursive: true });

// ── 下载 ────────────────────────────────────────────────

export async function download(url, timeoutMs = 20000) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch { return null; }
}

// ── 视觉识别 ────────────────────────────────────────────

/** 动图取最多 3 帧拼横图；静态图直接缩放 */
async function toVisionPng(buf) {
  let meta = null;
  try { meta = await sharp(buf, { animated: true }).metadata(); } catch { /* 不是动图 */ }

  const pages = meta?.pages ?? 1;
  if (pages > 1) {
    try {
      const frames = Math.min(3, pages);
      const tiles = [];
      for (let i = 0; i < frames; i += 1) {
        const idx = Math.floor((pages - 1) * (i / Math.max(1, frames - 1)));
        const f = await sharp(buf, { page: idx, pages: 1 })
          .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
          .png().toBuffer();
        tiles.push(f);
      }
      const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
      const w = metas.reduce((s, m) => s + (m.width ?? 0), 0);
      const h = Math.max(...metas.map((m) => m.height ?? 0));
      let x = 0;
      const composite = [];
      for (const t of tiles) {
        const m = await sharp(t).metadata();
        composite.push({ input: t, left: x, top: 0 });
        x += m.width ?? 0;
      }
      return await sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
        .composite(composite).png().toBuffer();
    } catch { /* 拼帧失败就用首帧 */ }
  }

  return sharp(buf).resize(384, 384, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}

/**
 * 识别一张图
 * @param {Buffer} buf
 * @param {string} hint '表情包' | '图片'
 * @returns {Promise<string|null>} 20 字以内的描述
 */
export async function describeImage(buf, hint = '表情包') {
  if (!buf?.length) return null;
  let png;
  try { png = await toVisionPng(buf); }
  catch (e) { console.error('  [media] 图片转换失败:', e.message); return null; }

  try {
    const res = await fetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `这是 QQ 群里的${hint}。用 20 字以内中文描述画面内容和情绪，不要引号，不要"这张图"。` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          ],
        }],
        max_tokens: 80,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) {
    console.error('  [media] 视觉识别失败:', e.message);
    return null;
  }
}

// ── 表情包库 ────────────────────────────────────────────

function md5(buf) { return createHash('md5').update(buf).digest('hex'); }

// ⚠️ 并发陷阱：learn() 是"读 index → 改 → 写回"，
//    批量导入时两个并发任务会各读到旧快照，后写的把先写的冲掉
//    （实测 161 个文件只入库了 87 条）。这里加内存缓存 + 写队列串行化。
let _idx = null;
let _dirty = false;

export function loadIndex() {
  if (_idx) return _idx;
  _idx = readJson(INDEX_FILE, {});
  return _idx;
}

function saveIndex(idx) {
  _idx = idx;
  _dirty = true;
  scheduleFlush();
}

let _flushTimer = null;
function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (!_dirty || !_idx) return;
    _dirty = false;
    try { writeJson(INDEX_FILE, _idx); } catch (e) { console.error('[media] 索引写盘失败:', e.message); }
  }, 200);
}

/** 进程退出前强制落盘 */
export function flushIndex() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_idx && _dirty) { _dirty = false; try { writeJson(INDEX_FILE, _idx); } catch { /* ignore */ } }
}
process.on('exit', flushIndex);

/** 查库里有没有这张图 */
export function lookup(buf) {
  const idx = loadIndex();
  return idx[md5(buf)] ?? null;
}

/**
 * 学一张新图：识别 + 入库 + 存文件
 * @returns {Promise<{desc:string, md5:string, isNew:boolean}|null>}
 */
export async function learn(buf, { from = '', hint = '表情包', ext = 'gif' } = {}) {
  const key = md5(buf);
  const idx = loadIndex();
  if (idx[key]) {
    idx[key].seen = (idx[key].seen ?? 1) + 1;
    saveIndex(idx);
    return { desc: idx[key].desc, md5: key, isNew: false };
  }

  const desc = await describeImage(buf, hint);
  if (!desc) return null;

  try { writeFileSync(`${STICKER_DIR}/${key}.${ext}`, buf); } catch { /* 存不下也不影响识别 */ }
  idx[key] = {
    desc, from, seen: 1, at: new Date().toISOString(),
    file: `${key}.${ext}`,
  };
  saveIndex(idx);
  return { desc, md5: key, isNew: true };
}

export function stickerCount() {
  try { return readdirSync(STICKER_DIR).filter((f) => f !== 'index.json').length; }
  catch { return 0; }
}

// ── 发送用 CQ 码 ────────────────────────────────────────

/** 本地图片 → CQ 码（自动换成容器内路径） */
export function imageCQ(absPath) {
  return `[CQ:image,file=${toFileUrl(absPath)}]`;
}

/** 发出去用的实际文件：优先 small（压缩过），没有就用原图 */
export function playablePath(v) {
  const small = `${STICKER_DIR}/small/${v.file}`;
  return existsSync(small) ? small : `${STICKER_DIR}/${v.file}`;
}

/** 按描述挑一张库里的图（简单关键词匹配） */
export function pickSticker(query = '') {
  const idx = loadIndex();
  const list = Object.entries(idx);
  if (!list.length) return null;
  const q = String(query ?? '').trim();

  // 匹配优先级：标签精确 → 标签包含 → 描述包含 → 逐字 → 随机
  let hit = q ? list.find(([, v]) => v.tag === q) : null;
  if (!hit && q) hit = list.find(([, v]) => v.tag && v.tag.includes(q));
  if (!hit && q) hit = list.find(([, v]) => (v.desc ?? '').includes(q));
  if (!hit && q) hit = list.find(([, v]) => q.split('').some((c) => (v.desc ?? '').includes(c)));
  if (!hit) hit = list[Math.floor(Math.random() * list.length)];

  const v = hit[1];
  return { path: playablePath(v), desc: v.desc, tag: v.tag ?? '' };
}
