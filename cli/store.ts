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

function load(): StateFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"))
    cache = { version: 1, secure: raw.secure ?? {}, local: raw.local ?? {} }
  } catch {
    cache = { version: 1, secure: {}, local: {} }
  }
  return cache
}

export function flush(): void {
  if (!dirty || !cache) return
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* ignore */ }
  const tmp = path.join(dir, `.state.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
  fs.renameSync(tmp, statePath())
  fs.chmodSync(statePath(), 0o600)
  dirty = false
}

export function bucket(name: "secure" | "local") {
  return {
    get(k: string): string | null {
      const v = load()[name][k]
      return v === undefined ? null : v
    },
    set(k: string, v: string): void {
      load()[name][k] = String(v)
      dirty = true
    },
    remove(k: string): void {
      if (k in load()[name]) { delete load()[name][k]; dirty = true }
    },
    keys(): string[] {
      return Object.keys(load()[name])
    },
    clear(): void {
      load()[name] = {}
      dirty = true
    },
  }
}

export function wipeAll(): void {
  cache = { version: 1, secure: {}, local: {} }
  dirty = true
  flush()
}
