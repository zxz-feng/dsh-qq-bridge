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
import { fetchBuffer } from './goods.mjs';

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

/** 动图取最多 3 帧拼横图；静态图直接缩放。size 是长边像素（截图要看清字，得给大些） */
async function toVisionPng(buf, { size = 384 } = {}) {
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
          .resize(Math.round(size / 2), Math.round(size / 2), { fit: 'inside', withoutEnlargement: true })
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

  return sharp(buf).resize(size, size, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}

/**
 * 识别一张图
 *
 * 两档（2026-10-29 加详细档）：
 *   表情包 → 20 字以内，只要"什么情绪"，便宜快
 *   图片/截图 → 200 字以内，要画面主体 + 图上的字 + 认得出的人物/作品名
 * 起因：群友发张带字的截图问"这上面写的啥"，20 字档只答"蓝发少女垂眼含泪挥筷"，
 * 字全丢了 —— 用户看到的就是"她不懂图片的意思"。
 *
 * @param {Buffer} buf
 * @param {string} hint '表情包' | '图片'
 * @param {{detail?:boolean}} [opts] detail=true 走详细档（长边 1024、max_tokens 400）
 * @returns {Promise<string|null>}
 */
export async function describeImage(buf, hint = '表情包', { detail = false } = {}) {
  if (!buf?.length) return null;
  let png;
  try { png = await toVisionPng(buf, { size: detail ? 1024 : 384 }); }
  catch (e) { console.error('  [media] 图片转换失败:', e.message); return null; }

  const ask = detail
    ? `这是 QQ 群里的${hint}。用 200 字以内中文说清楚：①画面主体是什么、在做什么；`
      + `②图上有文字的话**原样抄出来**（重要）；③认得出的人物/角色/作品/游戏就说名字，认不出就别猜；④整体情绪。`
      + `不要引号，不要"这张图"，不要客套话。`
    : `这是 QQ 群里的${hint}。用 20 字以内中文描述画面内容和情绪，不要引号，不要"这张图"。`;
  const maxTokens = detail ? 400 : 80;

  try {
    const res = await fetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: ask },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          ],
        }],
        max_tokens: maxTokens,
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
export async function learn(buf, { from = '', hint = '表情包', ext = 'gif', detail = null } = {}) {
  const key = md5(buf);
  const idx = loadIndex();
  if (idx[key]) {
    idx[key].seen = (idx[key].seen ?? 1) + 1;
    saveIndex(idx);
    return { desc: idx[key].desc, md5: key, isNew: false };
  }

  // 表情包永远走简档（便宜、够用）；"图片"默认走详细档
  const useDetail = detail ?? (hint !== '表情包');
  const desc = await describeImage(buf, hint, { detail: useDetail });
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

/**
 * 从网上抓一张图、压一下、真的发到群里
 * （以前只有表情包库这条路，所以"搜到的图"发不出去 —— 2026-10-29 补）
 * @returns {Promise<{ok:boolean, path?:string, reason?:string}>}
 */
export async function sendPicture(gid, imageUrl, callApi, { maxWidth = 520 } = {}) {
  if (!imageUrl) return { ok: false, reason: '没有图片地址' };
  const dir = `${HOST_MEDIA}/images`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    const buf = await fetchBuffer(imageUrl);
    if (!buf || buf.length < 500) return { ok: false, reason: '图片没下下来' };
    const name = `pic-${createHash('md5').update(buf).digest('hex').slice(0, 12)}.jpg`;
    const out = `${dir}/${name}`;
    await sharp(buf).resize(maxWidth, maxWidth, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 }).toFile(out);
    const r = await callApi('send_group_msg', { group_id: Number(gid), message: imageCQ(out) });
    const txt = JSON.stringify(r ?? {});
    const ok = r?.status === 'ok' || r?.retcode === 0 || /EventChecker|rich media transfer failed/i.test(txt);
    return ok ? { ok: true, path: out, messageId: r?.data?.message_id } : { ok: false, reason: `发送失败 ${txt.slice(0, 80)}` };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 80) };
  }
}

/** 发出去用的实际文件：优先 small（压缩过），没有就用原图 */
export function playablePath(v) {
  const small = `${STICKER_DIR}/small/${v.file}`;
  return existsSync(small) ? small : `${STICKER_DIR}/${v.file}`;
}

/** 按描述挑一张库里的图（简单关键词匹配） */
// 情绪 → 名字/标签候选词。她说「发个害羞的」时按这张表找图，
// 词序就是优先级（越靠前越贴切）。表里没有的词会退回名字/描述模糊匹配。
const MOOD_MAP = {
  开心: ['庆祝', '点赞', '加油', '音乐', '唱歌', '跳舞', '荧光棒', '礼物', '红包', '比耶大笑', '举玫瑰'],
  高兴: ['庆祝', '点赞', '比耶大笑', '偷笑', '音乐', '跳舞'],
  害羞: ['害羞', '摸头害羞', '红心情书', '玫瑰示爱', '抱膝坐', '被按头'],
  无语: ['静音', '思考', '茫然', '噢鲸', '流汗紧张', '被拦截', '程序停止', '呆滞驾驶'],
  生气: ['冒青筋', '烧', '不耐烦', '扩音器大喊', '凶狠', '枪毙', '举枪威胁', '电锯企鹅'],
  难过: ['哭', '委屈', '扒垃圾桶', '低落', '顶铁盆', '发呆可怜'],
  晚安: ['睡觉', '晚安', '晚安治愈', '工作(小睡)', '趴着哈气', '被子'],
  期待: ['期待', '捧蛋糕', '吃药', '置き', '加载'],
  疑惑: ['满头问号', '困惑', '你是变态吗', '质疑', '质疑'],
  得意: ['看戏', '退下', '龙颜大悦', '不屑', '小丑', '拿鞭子', '憋笑', '坏笑'],
  害怕: ['害怕', '惊恐', '橘猫惊恐', '震惊', '可怜巴巴', '紧张'],
  累: ['工作(疲倦)', '坐牢', '带薪拉屎', '死亡', '崩溃', '头晕', '躺'],
  吃: ['吃(爆米花)', '吃(西瓜)', '馋', '舔', '喝', '干杯', '茶', '干饭', '蹭饭'],
  加油: ['加油', '点赞', '庆祝', '荧光棒'],
  打招呼: ['打招呼', '碰鼻子', '招手', '比耶'],
  思考: ['思考', '书呆子', '画板', '主意', '打字'],
  可爱: ['卖萌', '眨眼卖萌', '摇铃卖萌', '连续点头', '抱吉他', '仓鼠乐', '摇摆'],
};

/** 把「发个开心的」里的情绪词抽出来 */
function moodWords(q) {
  const out = [];
  for (const [mood, words] of Object.entries(MOOD_MAP)) {
    if (q.includes(mood)) out.push(...words);
  }
  return out;
}

export function pickSticker(query = '', opts = {}) {
  const idx = loadIndex();
  const list = Object.entries(idx).filter(([, v]) => v && v.file);
  if (!list.length) return null;
  const q = String(query ?? '').trim();
  const tagsOf = (v) => (Array.isArray(v.tags) ? v.tags : (v.tag ? [v.tag] : []));
  const nameOf = (v) => String(v.name ?? '');

  // 匹配优先级：
  //   0 情绪表（「开心」→ 庆祝/点赞/…）逐词全库找
  //   1 名字精确 → 2 名字包含（双向）
  //   3 标签精确 → 4 标签包含
  //   5 描述包含 → 6 名字逐字 → 7 描述逐字
  //   8 兜底随机
  let hit = null;

  if (q) {
    for (const w of moodWords(q)) {
      hit = list.find(([, v]) => nameOf(v) === w) || list.find(([, v]) => nameOf(v).includes(w));
      if (hit) break;
    }
  }
  if (!hit && q) hit = list.find(([, v]) => nameOf(v) === q);
  if (!hit && q) hit = list.find(([, v]) => nameOf(v).includes(q) || (q.length >= 2 && q.includes(nameOf(v)) && nameOf(v).length >= 2));
  if (!hit && q) hit = list.find(([, v]) => tagsOf(v).includes(q));
  if (!hit && q) hit = list.find(([, v]) => tagsOf(v).some((t) => String(t).includes(q)));
  if (!hit && q) hit = list.find(([, v]) => (v.desc ?? '').includes(q));
  if (!hit && q) hit = list.find(([, v]) => q.split('').some((c) => nameOf(v).includes(c)));
  if (!hit && q) hit = list.find(([, v]) => q.split('').some((c) => (v.desc ?? '').includes(c)));

  // exclude 里是刚发过的 md5，避免同一张连发两次
  const ban = new Set((opts.exclude ?? []).map(String));
  if (hit && ban.has(hit[0])) hit = null;
  if (!hit) {
    const pool = list.filter(([k]) => !ban.has(k));
    const pick = pool.length ? pool : list;
    hit = pick[Math.floor(Math.random() * pick.length)];
  }

  const v = hit[1];
  return {
    path: playablePath(v),
    desc: v.desc,
    name: nameOf(v),
    tag: tagsOf(v)[0] ?? '',
    file: v.file,
    key: hit[0],
  };
}
