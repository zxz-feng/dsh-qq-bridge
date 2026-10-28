#!/usr/bin/env node
/**
 * scripts/import-stickers.mjs —— 把一堆表情包图片批量导进库
 * ============================================================================
 * 用法：
 *   node scripts/import-stickers.mjs --from /某个/图片目录
 *   node scripts/import-stickers.mjs --from ./gifs --no-desc
 *
 * 干三件事：
 *   1. 按内容 md5 入库（同一张图只存一份，重复导入不会膨胀）
 *   2. 生成压缩版到 `small/`（**发送用这个**：QQ 对 5~12MB 的 GIF 直接拒收，
 *      压到 200px / 48 色 / 最多 20 帧，平均 400KB）
 *   3. `--no-desc` 之外会调一次视觉模型写一句描述（挑表情包靠它，没有描述只能靠随机）
 *
 * 库在 `<家目录>/media/stickers/`；索引是 index.json（`md5 → {desc,file,...}`）。
 * ⚠️ 索引属于你自己，不随插件发布。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import sharp from 'sharp'

const HOME = process.env.BRIDGE_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge')
const STICKER_DIR = join(HOME, 'media', 'stickers')
const SMALL_DIR = join(STICKER_DIR, 'small')
const INDEX_FILE = join(STICKER_DIR, 'index.json')
const EXT = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp'])

const args = process.argv.slice(2)
const fromIdx = args.indexOf('--from')
const FROM = fromIdx >= 0 ? args[fromIdx + 1] : ''
const NO_DESC = args.includes('--no-desc')

if (!FROM || !existsSync(FROM)) {
  console.error('用法：node scripts/import-stickers.mjs --from <图片目录> [--no-desc]')
  process.exit(1)
}

mkdirSync(STICKER_DIR, { recursive: true })
mkdirSync(SMALL_DIR, { recursive: true })

const index = (() => {
  try { return JSON.parse(readFileSync(INDEX_FILE, 'utf8')) } catch { return {} }
})()

async function compress(src, dst) {
  await sharp(src, { animated: true })
    .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
    .gif({ colours: 48, effort: 3 })
    .toFile(dst)
}

async function describe(buf) {
  const gateway = process.env.DSH_GATEWAY || 'http://127.0.0.1:8327/v1'
  const key = process.env.WORKBUDDY_GATEWAY_API_KEY || 'local'
  const model = process.env.VISION_MODEL || 'deepseek-v4.1-flash'
  try {
    const png = await sharp(buf, { animated: true }).resize(320, 320, { fit: 'inside' }).png().toBuffer()
    const res = await fetch(`${gateway}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这是 QQ 群里的表情包，用 20 字以内中文描述画面内容和情绪，不加引号。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          ],
        }],
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(45000),
    })
    if (!res.ok) return ''
    const j = await res.json()
    return (j?.choices?.[0]?.message?.content ?? '').trim()
  } catch { return '' }
}

const files = readdirSync(FROM).filter((f) => EXT.has(extname(f).toLowerCase()))
console.log(`找到 ${files.length} 个图片：${FROM}`)

let added = 0
let skipped = 0
for (const f of files) {
  const src = join(FROM, f)
  try {
    if (statSync(src).size < 2048) { skipped += 1; continue }
    const buf = readFileSync(src)
    const md5 = createHash('md5').update(buf).digest('hex')
    if (index[md5]) { skipped += 1; continue }

    const name = `${md5}${extname(f).toLowerCase()}`
    const dst = join(STICKER_DIR, name)
    if (!existsSync(dst)) copyFileSync(src, dst)
    try { await compress(dst, join(SMALL_DIR, name)) } catch { /* 压不动就直接用原图 */ }

    const desc = NO_DESC ? '' : await describe(buf)
    index[md5] = {
      desc: desc || basename(f, extname(f)),
      from: 'import',
      seen: 1,
      at: new Date().toISOString(),
      file: name,
    }
    added += 1
    process.stdout.write(`\r  已入库 ${added} 张（跳过 ${skipped}）…`)
    // 每 20 张落一次盘：中途崩了不至于全丢
    if (added % 20 === 0) writeFileSync(INDEX_FILE, JSON.stringify(index, null, 1))
  } catch (e) {
    console.error(`\n  跳过 ${f}：${e?.message ?? e}`)
    skipped += 1
  }
}

writeFileSync(INDEX_FILE, JSON.stringify(index, null, 1))
console.log(`\n完成：新增 ${added} 张，跳过 ${skipped} 张，库里共 ${Object.keys(index).length} 张`)
console.log(`目录：${STICKER_DIR}`)
