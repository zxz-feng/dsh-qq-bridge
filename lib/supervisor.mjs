/**
 * lib/supervisor.mjs —— 托管 bridge 子进程：拉起、退避重启、优雅收摊
 * ============================================================================
 * 这一层就是「自愈」的第一层，**零 token**：靠进程句柄判断死活，不调模型。
 *
 * 规则：
 *   · 崩了按 1→2→4→8→15→30→60s 退避重启
 *   · 10 分钟内崩 8 次 ⇒ 停手，置 failed，等人工/下一次自检再试（不无限刷日志）
 *   · 退出时先发 shutdown 让它把手上的回复发完（默认等 25s），再 SIGTERM，最后 SIGKILL
 *   · 子进程的 stdout/stderr 直接进 <home>/bridge.log（超过 5MB 轮转）
 * ============================================================================
 */
import { fork } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { T } from './protocol.mjs'
import { rotateLog } from './home.mjs'

const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000, 60000]
const GIVE_UP_WINDOW_MS = 10 * 60 * 1000
const GIVE_UP_COUNT = 8

export class Supervisor {
  /**
   * @param {object} o
   * @param {string} o.script      子进程入口（绝对路径）
   * @param {object} o.env         额外环境变量
   * @param {string} o.logFile     日志文件
   * @param {(s:string)=>void} [o.log]
   */
  constructor({ script, env = {}, logFile, log = () => {} }) {
    this.script = script
    this.env = env
    this.logFile = logFile
    this.log = log
    this.child = null
    this.pid = 0
    this.startedAt = 0
    this.restarts = 0
    this.crashTimes = []
    this.lastError = ''
    this.state = 'idle'        // idle | starting | up | stopping | failed
    this.seq = 0
    this.pending = new Map()
    this.wantUp = false
    this.timer = null
    this.readyInfo = null
    this.events = []
    try { mkdirSync(dirname(logFile), { recursive: true }) } catch { /* 建不了就算了 */ }
  }

  /** 子进程是否活着 */
  get alive() {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null)
  }

  start() {
    if (!this.wantUp) {
      this.wantUp = true
      this._record('info', '启动托管')
    }
    return this._spawn()
  }

  _spawn() {
    if (this.alive) return true
    if (this.state === 'failed') {
      this.log('已放弃托管（崩溃太频繁），等自检重试')
      return false
    }
    this.state = 'starting'
    rotateLog(this.logFile, 5 * 1024 * 1024)

    let child
    try {
      child = fork(this.script, [], {
        env: { ...process.env, ...this.env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      })
    } catch (e) {
      this.lastError = `fork 失败: ${e?.message ?? e}`
      this._record('error', this.lastError)
      this._scheduleRestart()
      return false
    }

    this.child = child
    this.pid = child.pid ?? 0
    this.startedAt = Date.now()
    this._record('info', `子进程已拉起 pid=${this.pid}`)

    const pipe = (stream) => {
      stream?.setEncoding?.('utf8')
      stream?.on?.('data', (chunk) => {
        try { appendFileSync(this.logFile, chunk) } catch { /* 写不了就丢 */ }
      })
    }
    pipe(child.stdout)
    pipe(child.stderr)

    child.on('message', (m) => this._onMessage(m))
    child.on('error', (e) => {
      this.lastError = e?.message ?? String(e)
      this._record('error', `子进程错误: ${this.lastError}`)
    })
    child.on('exit', (code, signal) => {
      this.pid = 0
      const wasStopping = this.state === 'stopping'
      this.state = wasStopping ? 'idle' : 'starting'
      this._failPending(new Error(`子进程退出 code=${code} signal=${signal ?? '-'}`))
      if (wasStopping || !this.wantUp) {
        this._record('info', '子进程已退出（主动停止）')
        return
      }
      this.lastError = `子进程退出 code=${code} signal=${signal ?? '-'}`
      this._record('warn', this.lastError)
      this.crashTimes.push(Date.now())
      this.crashTimes = this.crashTimes.filter((t) => Date.now() - t < GIVE_UP_WINDOW_MS)
      if (this.crashTimes.length >= GIVE_UP_COUNT) {
        this.state = 'failed'
        this._record('error', `10 分钟内崩了 ${this.crashTimes.length} 次 —— 停止自动重启`)
        return
      }
      this._scheduleRestart()
    })

    return true
  }

  _scheduleRestart() {
    if (!this.wantUp || this.state === 'failed') return
    if (this.timer) clearTimeout(this.timer)
    const wait = BACKOFF[Math.min(this.restarts, BACKOFF.length - 1)]
    this.restarts += 1
    this._record('info', `${Math.round(wait / 1000)}s 后重启（第 ${this.restarts} 次）`)
    this.timer = setTimeout(() => {
      this.timer = null
      this._spawn()
    }, wait)
    this.timer.unref?.()
  }

  _onMessage(m) {
    if (!m || typeof m !== 'object') return
    if (m.t === T.READY) {
      this.state = 'up'
      this.readyInfo = m.info ?? null
      this.crashTimes = []
      this.restarts = 0
      this._record('info', '子进程就绪')
      return
    }
    if (m.t === T.LOG) {
      try { appendFileSync(this.logFile, `${m.level ?? 'info'}\t${m.msg}\n`) } catch { /* 丢 */ }
      return
    }
    if (m.t === T.EVENT) {
      this.events.push({ at: Date.now(), name: m.name, data: m.data })
      if (this.events.length > 200) this.events.shift()
      return
    }
    if (m.t === T.REPLY) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.data)
      else p.reject(new Error(m.error || '子进程返回失败'))
    }
  }

  /** 调子进程的一个能力 */
  call(action, params = {}, { timeoutMs = 20000 } = {}) {
    if (!this.alive) return Promise.reject(new Error(`bridge 没在跑（state=${this.state}）`))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge 未在 ${timeoutMs}ms 内回复 ${action}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.send({ t: T.CMD, id, action, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  _failPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** 优雅停止：先请它自己收摊（等在途发完），再 SIGTERM，最后 SIGKILL */
  async stop({ graceMs = 25000 } = {}) {
    this.wantUp = false
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const c = this.child
    if (!c || !this.alive) {
      this.state = 'idle'
      return { ok: true, already: true }
    }
    this.state = 'stopping'
    const exited = new Promise((resolve) => c.once('exit', resolve))
    try { c.send({ t: T.SHUTDOWN }) } catch { /* 可能已经断了 */ }
    const raced = await Promise.race([
      exited.then(() => 'exited'),
      new Promise((r) => setTimeout(() => r('timeout'), graceMs)),
    ])
    if (raced === 'timeout') {
      this._record('warn', `等 ${Math.round(graceMs / 1000)}s 还没退，SIGTERM`)
      try { c.kill('SIGTERM') } catch { /* 忽略 */ }
      const raced2 = await Promise.race([
        exited.then(() => 'exited'),
        new Promise((r) => setTimeout(() => r('timeout'), 5000)),
      ])
      if (raced2 === 'timeout') {
        this._record('error', 'SIGTERM 无效，SIGKILL')
        try { c.kill('SIGKILL') } catch { /* 忽略 */ }
      }
    }
    this.state = 'idle'
    this.child = null
    this.pid = 0
    return { ok: true }
  }

  /** 重启（自检发现卡死时用） */
  async restart(reason = 'manual', opts = {}) {
    this._record('warn', `重启：${reason}`)
    await this.stop(opts)
    this.state = 'idle'
    this.crashTimes = []
    this.wantUp = true
    return this._spawn()
  }

  _record(level, msg) {
    if (level === 'error') this.lastError = msg
    try { appendFileSync(this.logFile, `${new Date().toISOString()}\t[supervisor]\t${level}\t${msg}\n`) } catch { /* 丢 */ }
    this.log(`[${level}] ${msg}`)
  }

  info() {
    return {
      state: this.state,
      alive: this.alive,
      pid: this.pid,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      crashesInWindow: this.crashTimes.length,
      lastError: this.lastError,
      ready: this.readyInfo,
      recentEvents: this.events.slice(-10),
      logExists: existsSync(this.logFile),
    }
  }
}
