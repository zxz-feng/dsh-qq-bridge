/**
 * lib/deps.mjs —— 拿宿主那棵树里的 `@deepseek-ai/*`，拿不到就降级
 * ============================================================================
 * 为什么要有它（照 `dsh-bili-scroll` 的 `lib/hostdeps.mjs` 的做法，感谢原作者）：
 *   `@deepseek-ai/schemastery` 和 `@deepseek-ai/dsh-tools` 在插件里是 **optional peer**。
 *   桌面版 profile 是 `autoInstallPeers: false` ⇒ 永远不装 ⇒ 裸 import 会让
 *   **整条插件不激活**（DSH 只留一句 `warning: 1 entry did not activate`）✗
 *
 * 策略：
 *   ① 先试宿主那棵树（跟宿主用同一份，行为最一致）
 *   ② 再试自己 dependencies 里那份
 *   ③ 都没有 ⇒ 返回 null，**插件照常加载**（只是没有 Config 设置项 / 没有工具）
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的位置，按可能性排序 */
function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p) && existsSync(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const home = process.env.DSH_HOME
  if (home) {
    push(join(home, '..', 'lib', 'node_modules', '@deepseek-ai'))
    try {
      for (const p of readdirSync(join(home, 'profiles'))) {
        push(join(home, 'profiles', p, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有 profile 就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromTree(name) {
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, name)
    if (!url) continue
    try { return await import(url) } catch { /* 试下一个 */ }
  }
  return null
}

/** 本地等价 defineTool：宿主的会做 spec→JSONSchema 校验，这里只补必要的一条 */
function localDefineTool(options) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  return options
}

/**
 * @returns {Promise<{z: any, defineTool: Function|null, notes: string[]}>}
 */
export async function loadDeps() {
  const notes = []

  let zMod = await fromTree('schemastery')
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery') } catch { notes.push('schemastery 拿不到 —— 没有 Config（插件照常跑）') }
  }
  const z = zMod?.default ?? zMod ?? null

  let defineTool = null
  const dt = await fromTree('dsh-tools')
  if (dt?.defineTool) defineTool = dt.defineTool
  else {
    try {
      const m = await import('@deepseek-ai/dsh-tools')
      if (m?.defineTool) defineTool = m.defineTool
    } catch { /* 用本地等价 */ }
  }
  if (!defineTool) {
    defineTool = localDefineTool
    notes.push('dsh-tools 拿不到 —— 用本地等价 defineTool')
  }

  return { z, defineTool, notes }
}
