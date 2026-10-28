/**
 * lib/home.mjs —— 插件家目录、JSON 读写、日志轮转
 * ============================================================================
 * 家目录：`<DSH_HOME>/<plugin-id>/`（没设 DSH_HOME 时退到 `~/.dsh/<plugin-id>/`）
 * 里面放：config.json / session.txt / control.json / contexts/ / *.log
 *
 * 跨平台：只用 node:fs + node:path，不调 bash、不假设大小写、不写死 /root。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, closeSync, readSync, ftruncateSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件家目录（顺手建出来） */
export function homeDir(id) {
  const dir = process.env.DSH_TELEGRAM_HOME || join(dshHome(), id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 原子写：先写 .tmp 再 rename（断电也不会留半个文件） */
export function writeJson(file, obj, { mode = 0o600 } = {}) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode })
  renameSync(tmp, file)
}

export function readText(file, fallback = '') {
  try { return readFileSync(file, 'utf8') } catch { return fallback }
}

/** 日志追加（家目录里，别写系统日志） */
export function appendLog(file, line) {
  try { writeFileSync(file, `${new Date().toISOString()} ${line}\n`, { flag: 'a' }) } catch { /* 家目录只读就算了 */ }
}

/**
 * 日志轮转：超过 maxBytes 就把它改名成 `.1`（只留一代，够用且省磁盘）
 * 跨平台：不用 fs.copyFile + unlink 组合，直接 rename。
 */
export function rotateLog(file, maxBytes = 5 * 1024 * 1024) {
  try {
    if (!existsSync(file)) return false
    if (statSync(file).size < maxBytes) return false
    renameSync(file, `${file}.1`)
    return true
  } catch { return false }
}

/** 读文件尾部 n 字节（给“日志最后几行”用，不读整个 5MB） */
export function tail(file, bytes = 8192) {
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - bytes)
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    return buf.toString('utf8')
  } catch { return '' }
}

/** 截断文件（家目录里的 inbox/drafts 太大时用） */
export function truncate(file, keepBytes = 0) {
  try {
    const fd = openSync(file, 'r+')
    const size = statSync(file).size
    ftruncateSync(fd, Math.min(keepBytes, size))
    closeSync(fd)
    return true
  } catch { return false }
}

/** 磁盘余量（MB）；拿不到返回 null（不假装知道） */
export async function freeMb(dir) {
  try {
    const { statfs } = await import('node:fs/promises')
    const s = await statfs(dir)
    return Math.round((s.bavail * s.bsize) / 1024 / 1024)
  } catch { return null }
}
