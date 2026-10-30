/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * CLI 持久化:单个 JSON 文件,目录 0700、文件 0600,原子写入。
 * 位置:$YSU_CLI_HOME 或 ~/.config/ysu-cli/state.json。
 * 内容是 SecureStorage / localStorage 的键值(含会话 cookie、可选的记住密码),
 * 永远不会被打印到 stdout/stderr。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function stateDir(): string {
  return process.env.YSU_CLI_HOME || path.join(os.homedir(), ".config", "ysu-cli")
}
export function statePath(): string {
  return path.join(stateDir(), "state.json")
}

type Bucket = Record<string, string>
interface StateFile {
  version: 1
  secure: Bucket
  local: Bucket
}

let cache: StateFile | null = null
let dirty = false
/** 本进程做过的修改(按顺序);flush 时在锁内重读磁盘最新内容后重放,避免覆盖其他进程的更新 */
type Op = { b: "secure" | "local"; k?: string; v?: string; op: "set" | "remove" | "clear" }
let ops: Op[] = []
let wipe = false

function readDisk(): StateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"))
    return { version: 1, secure: raw.secure ?? {}, local: raw.local ?? {} }
  } catch {
    return { version: 1, secure: {}, local: {} }
  }
}

function load(): StateFile {
  if (!cache) cache = readDisk()
  return cache
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 跨进程互斥:O_EXCL 锁文件;持有者崩溃留下的陈旧锁(>10s)会被清理。 */
export function withLock<T>(fn: () => T, timeoutMs = 10_000): T {
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = path.join(dir, "state.lock")
  const deadline = Date.now() + timeoutMs
  let fd: number | undefined
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx", 0o600)
      break
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { force: true }); continue }
      } catch { continue }
      if (Date.now() > deadline) throw new Error(`state lock timeout: ${lock}`)
      sleepSync(15)
    }
  }
  try {
    fs.writeSync(fd, String(process.pid))
    return fn()
  } finally {
    fs.closeSync(fd)
    fs.rmSync(lock, { force: true })
  }
}

export function flush(): void {
  if (!dirty || !cache) return
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* ignore */ }
  withLock(() => {
    const base: StateFile = wipe ? { version: 1, secure: {}, local: {} } : readDisk()
    for (const o of ops) {
      if (o.op === "clear") base[o.b] = {}
      else if (o.op === "set") base[o.b][o.k!] = o.v!
      else delete base[o.b][o.k!]
    }
    const tmp = path.join(dir, `.state.${process.pid}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(base), { mode: 0o600 })
    fs.renameSync(tmp, statePath())
    fs.chmodSync(statePath(), 0o600)
    cache = base
  })
  ops = []
  wipe = false
  dirty = false
}

/** 丢弃内存缓存(测试 / 长进程中重新读取磁盘) */
export function resetCache(): void {
  cache = null; ops = []; wipe = false; dirty = false
}

export function bucket(name: "secure" | "local") {
  return {
    get(k: string): string | null {
      const v = load()[name][k]
      return v === undefined ? null : v
    },
    set(k: string, v: string): void {
      load()[name][k] = String(v)
      ops.push({ b: name, k, v: String(v), op: "set" })
      dirty = true
    },
    remove(k: string): void {
      if (k in load()[name]) { delete load()[name][k]; ops.push({ b: name, k, op: "remove" }); dirty = true }
    },
    keys(): string[] {
      return Object.keys(load()[name])
    },
    clear(): void {
      load()[name] = {}
      ops.push({ b: name, op: "clear" })
      dirty = true
    },
  }
}

export function wipeAll(): void {
  cache = { version: 1, secure: {}, local: {} }
  ops = []
  wipe = true
  dirty = true
  flush()
}
