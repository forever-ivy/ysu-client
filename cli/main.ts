/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ysu —— 燕大终端的 agent 友好命令行。
 * 复用 providers/ 与 lib/ 的全部协议代码;Node 下由 cli/shims 提供浏览器/Capacitor 替身。
 */
import "./shims/globals"
import fs from "node:fs"
import { COMMANDS, type Command, type Ctx } from "./commands"
import { EXIT_CODE_DOCS, EXIT_CODES, GLOBAL_FLAGS, type ArgSpec } from "./spec"
import { bucket, flush, statePath } from "./store"
import { nodeHttpSend, stats, transportOptions } from "./transport"
import pkg from "../package.json"

export const CLI_VERSION = "1.0.0"

// ─── 参数解析 ─────────────────────────────────────────────────────────── //

export interface Parsed {
  path: string[]
  flags: Record<string, string | boolean>
}

export function parseArgv(argv: string[]): Parsed {
  const path: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") { path.push(...argv.slice(i + 1)); break }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        // 布尔全局 flag 不吞后续值
        const g = GLOBAL_FLAGS.find((f) => f.name === key)
        if (g?.type === "boolean") { flags[key] = true; continue }
        flags[key] = next; i++
      } else flags[key] = true
    } else if (a === "-h") flags.help = true
    else path.push(a)
  }
  return { path, flags }
}

export function findCommand(path: string[]): { cmd?: Command; rest: string[] } {
  for (let len = Math.min(3, path.length); len >= 1; len--) {
    const name = path.slice(0, len).join(" ")
    const cmd = COMMANDS.find((c) => c.name === name)
    if (cmd) return { cmd, rest: path.slice(len) }
  }
  return { rest: path }
}

class CliError extends Error {
  constructor(public code: string, message: string, public details?: any) { super(message) }
}

function coerce(spec: ArgSpec, raw: string | boolean | undefined, source: string): any {
  if (raw === undefined) return undefined
  switch (spec.type) {
    case "boolean":
      if (raw === true) return true
      if (/^(1|true|yes|on)$/i.test(String(raw))) return true
      if (/^(0|false|no|off|)$/i.test(String(raw))) return false
      throw new CliError("USAGE", `--${spec.name} 需要布尔值,收到 ${source}`)
    case "number": {
      const v = Number(raw)
      if (raw === true || !Number.isFinite(v)) throw new CliError("USAGE", `--${spec.name} 需要数字`)
      return v
    }
    case "json": {
      if (raw === true) throw new CliError("USAGE", `--${spec.name} 需要 JSON`)
      let text = String(raw)
      if (text.startsWith("@")) text = text === "@-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(text.slice(1), "utf8")
      try { return JSON.parse(text) } catch { throw new CliError("USAGE", `--${spec.name} 不是合法 JSON`) }
    }
    default:
      if (raw === true) throw new CliError("USAGE", `--${spec.name} 需要值`)
      if (spec.choices && !spec.choices.includes(String(raw))) throw new CliError("USAGE", `--${spec.name} 只能是 ${spec.choices.join(" | ")}`)
      return String(raw)
  }
}

export function resolveArgs(specs: ArgSpec[], flags: Record<string, string | boolean>, env = process.env): Record<string, any> {
  const out: Record<string, any> = {}
  for (const spec of specs) {
    let raw: string | boolean | undefined = flags[spec.name]
    let src = `--${spec.name}`
    if (raw === undefined && spec.env && env[spec.env] !== undefined && !spec.secret) { raw = env[spec.env]; src = spec.env }
    let v = coerce(spec, raw, src)
    if (v === undefined && spec.default !== undefined) v = spec.default
    if (v === undefined && spec.required && !(spec.secret && spec.env && env[spec.env])) {
      throw new CliError("USAGE", `缺少必填参数 --${spec.name}${spec.env ? `(或环境变量 ${spec.env})` : ""}`)
    }
    if (v !== undefined) out[spec.name] = v
  }
  return out
}

// ─── 错误映射 ─────────────────────────────────────────────────────────── //

const CODE_EXIT: Record<string, number> = {
  USAGE: EXIT_CODES.USAGE,
  AUTH_REQUIRED: EXIT_CODES.AUTH_REQUIRED,
  AUTH_SESSION_EXPIRED: EXIT_CODES.AUTH_REQUIRED,
  AUTH_INVALID_CREDENTIAL: EXIT_CODES.AUTH_REQUIRED,
  SKBIRD_TOKEN_INVALID: EXIT_CODES.AUTH_REQUIRED,
  AUTH_CAPTCHA_REQUIRED: EXIT_CODES.AUTH_ACTION_REQUIRED,
  AUTH_MFA_REQUIRED: EXIT_CODES.AUTH_ACTION_REQUIRED,
  NETWORK_ERROR: EXIT_CODES.NETWORK,
  TIMEOUT: EXIT_CODES.NETWORK,
  BACKEND_BUSINESS_ERROR: EXIT_CODES.BACKEND,
  BACKEND_PROTOCOL_ERROR: EXIT_CODES.BACKEND,
  METER_ERROR: EXIT_CODES.BACKEND,
  SKBIRD_ERROR: EXIT_CODES.BACKEND,
  FEATURE_NOT_SUPPORTED: EXIT_CODES.NOT_SUPPORTED,
  DATA_NOT_FOUND: EXIT_CODES.NOT_FOUND,
  RATE_LIMITED: EXIT_CODES.RATE_LIMITED,
  DRY_RUN: EXIT_CODES.DRY_RUN,
  UNKNOWN: EXIT_CODES.UNKNOWN,
}

const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|CASTGC=[^;\s]+|(?:password|passwd|pwd|token|ticket)=[^&\s"]+)/gi
function scrub(v: unknown): any {
  if (typeof v === "string") return v.replace(SECRET_RE, (m) => m.split("=")[0] + "=***")
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === "object") {
    const o: any = {}
    for (const [k, x] of Object.entries(v)) {
      if (/^(password|passwd|pwd|token|credential|cookie|castgc|secret)$/i.test(k)) { o[k] = "***"; continue }
      o[k] = scrub(x)
    }
    return o
  }
  return v
}

export function toErrorPayload(e: any): { code: string; message: string; exitCode: number; status?: number; details?: any; retryable: boolean } {
  let code = typeof e?.code === "string" ? e.code : "UNKNOWN"
  if (e?.name === "MeterError") code = /NOT_BOUND/.test(e.message) ? "DATA_NOT_FOUND" : "METER_ERROR"
  if (e?.name === "SkbirdError") code = e.errno === 10 ? "SKBIRD_TOKEN_INVALID" : "SKBIRD_ERROR"
  if (code === "UNKNOWN" && (e?.name === "TimeoutError" || /timeout/i.test(e?.message ?? ""))) code = "TIMEOUT"
  if (code === "UNKNOWN" && /network error|fetch failed|ENOTFOUND|ECONNRE/i.test(e?.message ?? "")) code = "NETWORK_ERROR"
  if (!(code in CODE_EXIT)) code = "UNKNOWN"
  const details = e?.details ?? (e?.name === "SkbirdError" ? { errno: e.errno } : e?.name === "MeterError" ? { meterCode: e.code } : undefined)
  return {
    code,
    message: scrub(String(e?.message ?? e)),
    exitCode: CODE_EXIT[code]!,
    ...(typeof e?.status === "number" ? { status: e.status } : {}),
    ...(details !== undefined ? { details: scrub(details) } : {}),
    retryable: code === "NETWORK_ERROR" || code === "TIMEOUT" || code === "RATE_LIMITED",
  }
}

// ─── schema / help ───────────────────────────────────────────────────── //

export function schema() {
  return {
    name: "ysu",
    version: CLI_VERSION,
    appVersion: (pkg as any).version,
    description: "燕山大学教务客户端(燕大终端)的非交互命令行。所有命令支持 --json。",
    envelope: {
      success: { ok: true, command: "string", data: "any", meta: { durationMs: "number", httpRequests: "number", retries: "number", page: "{offset,limit,total,returned,hasMore}?" } },
      failure: { ok: false, command: "string|null", error: { code: "string", message: "string", exitCode: "number", status: "number?", details: "any?", retryable: "boolean" } },
      dryRun: { ok: false, command: "string", dryRun: true, plan: "object", error: { code: "DRY_RUN", exitCode: 10 } },
    },
    exitCodes: EXIT_CODE_DOCS,
    globalFlags: GLOBAL_FLAGS,
    environment: {
      YSU_USERNAME: "学号", YSU_PASSWORD: "密码(仅 auth login 读取)", YSU_SKBIRD_TOKEN: "森空鸟 token",
      YSU_CLI_HOME: "状态目录", YSU_CLI_JSON: "默认 JSON 输出", YSU_CLI_TIMEOUT_MS: "请求超时", YSU_CLI_RETRIES: "重试次数", YSU_CLI_VERBOSE: "HTTP 摘要日志",
    },
    commands: [
      ...COMMANDS.map((c) => ({
        name: c.name, summary: c.summary, requiresLogin: !!c.auth, sideEffect: !!c.sideEffect, paged: !!c.paged,
        capability: c.capability ?? null, args: c.args ?? [], examples: c.examples ?? [],
      })),
      { name: "schema", summary: "输出本描述(机器可读)", requiresLogin: false, sideEffect: false, paged: false, capability: null, args: [], examples: [] },
      { name: "version", summary: "版本信息", requiresLogin: false, sideEffect: false, paged: false, capability: null, args: [], examples: [] },
    ],
  }
}

function fmtArg(a: ArgSpec): string {
  const t = a.type === "boolean" ? "" : ` <${a.choices ? a.choices.join("|") : a.type}>`
  const extra = [a.required ? "必填" : "", a.env ? `env ${a.env}` : "", a.default !== undefined ? `默认 ${JSON.stringify(a.default)}` : ""].filter(Boolean).join(", ")
  return `  --${a.name}${t}`.padEnd(34) + a.description + (extra ? ` (${extra})` : "")
}

export function helpText(prefix: string[]): string {
  const cmd = findCommand(prefix).cmd
  if (cmd && findCommand(prefix).rest.length === 0) {
    return [
      `ysu ${cmd.name} — ${cmd.summary}`,
      cmd.auth ? "需要登录" : "", cmd.sideEffect ? "有副作用:默认 dry-run,加 --confirm 执行" : "", cmd.paged ? "支持 --limit / --offset" : "",
      "", "参数:", ...(cmd.args?.length ? cmd.args.map(fmtArg) : ["  (无)"]),
      ...(cmd.examples?.length ? ["", "示例:", ...cmd.examples.map((x) => `  ${x}`)] : []),
      "", "全局参数见 `ysu --help`。",
    ].filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n")
  }
  const groups = new Map<string, Command[]>()
  for (const c of COMMANDS) {
    const g = c.name.split(" ")[0]!
    if (prefix.length && g !== prefix[0]) continue
    groups.set(g, [...(groups.get(g) ?? []), c])
  }
  const lines = ["ysu — 燕大终端 CLI(面向 agent:非交互、--json、稳定退出码)", "", "用法: ysu <命令> [子命令] [--参数 值] [--json]", ""]
  for (const [g, cs] of groups) {
    lines.push(`${g}:`)
    for (const c of cs) lines.push(`  ${c.name.padEnd(30)}${c.summary}${c.sideEffect ? " [写]" : ""}${c.auth ? "" : " [免登录]"}`)
  }
  lines.push("", "  schema                        输出全部命令与参数的 JSON 描述", "  version                       版本", "", "全局参数:", ...GLOBAL_FLAGS.map(fmtArg), "", "退出码:", ...Object.entries(EXIT_CODE_DOCS).map(([k, v]) => `  ${k.padEnd(4)}${v}`), "", `状态文件: ${statePath()}`)
  return lines.join("\n")
}

// ─── 运行时 ───────────────────────────────────────────────────────────── //

let transportInstalled = false
/** 安装 Node 直连传输;与 provider 初始化无关(skbird 等命令也需要)。 */
export async function ensureTransport(): Promise<void> {
  if (transportInstalled) return
  transportInstalled = true
  const { setHttpTransport } = await import("@/lib/cookie")
  setHttpTransport(nodeHttpSend)
}

/** CLI 下没有浏览器 MFA 弹窗:relogin 需要二次认证时记录下来,由调用方转成 AUTH_MFA_REQUIRED。 */
export const reloginMfa: { username: string | null } = { username: null }
async function installCliMfaHandler(): Promise<void> {
  const { useMFAModalStore } = await import("@/lib/stores/mfa-modal")
  useMFAModalStore.setState({
    showMFA: ((opts: { username: string }) => {
      reloginMfa.username = opts.username
      return Promise.reject(new Error("MFA_REQUIRED_IN_CLI"))
    }) as any,
  })
}

/** 用记住的密码重登;需要二次认证时保存待续登录并抛出 AUTH_MFA_REQUIRED(退出码 4)。 */
export async function cliRelogin(p: any, pending: Ctx["pending"]): Promise<boolean> {
  reloginMfa.username = null
  const ok = await (p.relogin?.() ?? Promise.resolve(false)).catch(() => false)
  if (ok) return true
  if (reloginMfa.username) {
    const username = reloginMfa.username
    reloginMfa.username = null
    pending.set("mfa", { username, remember: true })
    const { getYSUMfaMethods } = await import("@/providers/ysu/types")
    const methods = [...getYSUMfaMethods()]
    throw new CliError("AUTH_MFA_REQUIRED", "重新登录需要二次认证", {
      username,
      methods,
      next: `ysu auth mfa-request --method <${methods.join("|")}>  然后  ysu auth mfa-submit --code <验证码>;或 ysu auth wechat-start`,
    })
  }
  return false
}

let providerPromise: Promise<any> | null = null
async function bootProvider(): Promise<any> {
  if (providerPromise) return providerPromise
  providerPromise = (async () => {
    await ensureTransport()
    await installCliMfaHandler()
    const { useAuthStore } = await import("@/lib/stores/auth")
    await (useAuthStore as any).persist?.rehydrate?.()
    const { initializeActiveProvider } = await import("@/providers/provider-service")
    const p = await initializeActiveProvider()
    // 进行中的 MFA / 验证码登录:恢复 CAS jar(上一次进程保存的)
    const raw = bucket("secure").get("ysu-cli.cas-jar")
    if (raw && !useAuthStore.getState().isAuthenticated) {
      const { SimpleCookieJar } = await import("@/lib/cookie")
      const { setJar } = await import("@/providers/ysu/protocol/cas")
      setJar(SimpleCookieJar.fromJSON(raw))
    }
    return p
  })()
  return providerPromise
}

async function persistAfterRun(): Promise<void> {
  if (!providerPromise) return
  try {
    const { useAuthStore } = await import("@/lib/stores/auth")
    const st = useAuthStore.getState()
    const sec = bucket("secure")
    if (st.isAuthenticated) {
      const { persistJWXTSession, persistMobileSession } = await import("@/providers/ysu/session")
      await persistJWXTSession().catch(() => {})
      await persistMobileSession().catch(() => {})
      sec.remove("ysu-cli.cas-jar")
    } else {
      const { getJar } = await import("@/providers/ysu/protocol/cas")
      const jar = getJar()
      if ((await jar.getAllCookies()).length) sec.set("ysu-cli.cas-jar", jar.toJSON())
      else sec.remove("ysu-cli.cas-jar")
    }
    // zustand persist 写入是异步的,等一拍
    await new Promise((r) => setTimeout(r, 20))
  } catch {
    // 持久化失败不影响本次结果
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")
}

function makeCtx(args: Record<string, any>, flags: Record<string, any>): Ctx {
  const pend = bucket("secure")
  const pendingApi: Ctx["pending"] = {
    get: (k) => { const v = pend.get(`ysu-cli.pending.${k}`); return v ? JSON.parse(v) : undefined },
    set: (k, v) => pend.set(`ysu-cli.pending.${k}`, JSON.stringify(v)),
    del: (k) => pend.remove(`ysu-cli.pending.${k}`),
  }
  return {
    args,
    provider: bootProvider,
    ensureTransport,
    relogin: async () => cliRelogin(await bootProvider(), pendingApi),
    pending: pendingApi,
    async readSecret(name, stdinFlag, env) {
      if (stdinFlag && flags[stdinFlag]) return (await readStdin()) || undefined
      if (typeof flags[name] === "string") return flags[name]
      if (env && process.env[env]) return process.env[env]
      return undefined
    },
  }
}

export interface RunResult { exitCode: number; stdout: string; stderr: string }

export async function run(argv: string[], env = process.env): Promise<RunResult> {
  const started = Date.now()
  const { path, flags } = parseArgv(argv)
  let g: Record<string, any> = {}
  let json = false
  let pretty = false
  let commandName: string | null = null
  const emit = (obj: any, human: string, exitCode: number, toErr = false): RunResult => {
    const out = json ? JSON.stringify(obj, null, pretty ? 2 : undefined) + "\n" : human.endsWith("\n") ? human : human + "\n"
    return { exitCode, stdout: toErr && !json ? "" : out, stderr: toErr && !json ? out : "" }
  }
  try {
    g = resolveArgs(GLOBAL_FLAGS, flags, env)
    pretty = !!g.pretty
    json = !!g.json || pretty
    if (g.home) process.env.YSU_CLI_HOME = g.home
    transportOptions.retries = Math.max(0, Math.floor(g.retries ?? 2))
    if (g.timeout !== undefined) transportOptions.timeoutMs = g.timeout
    transportOptions.verbose = !!g.verbose
    if (g.verbose) process.env.YSU_CLI_VERBOSE = "1"

    if (path.length === 0 || path[0] === "help") {
      const p = path[0] === "help" ? path.slice(1) : []
      return emit({ ok: true, command: "help", data: { text: helpText(p) } }, helpText(p), 0)
    }
    if (path[0] === "schema") return emit({ ok: true, command: "schema", data: schema() }, JSON.stringify(schema(), null, 2), 0)
    if (path[0] === "version") {
      const v = { cli: CLI_VERSION, app: (pkg as any).version, node: process.version }
      return emit({ ok: true, command: "version", data: v }, `ysu ${v.cli} (app ${v.app}, node ${v.node})`, 0)
    }

    const { cmd, rest } = findCommand(path)
    if (g.help) return emit({ ok: true, command: "help", data: { text: helpText(path) } }, helpText(path), 0)
    if (!cmd) {
      const near = COMMANDS.filter((c) => c.name.startsWith(path[0]!)).map((c) => c.name)
      throw new CliError("USAGE", `未知命令: ${path.join(" ")}`, { suggestions: near.length ? near : undefined, hint: "ysu --help 或 ysu schema" })
    }
    commandName = cmd.name
    if (rest.length) throw new CliError("USAGE", `多余的位置参数: ${rest.join(" ")}(所有参数都用 --name value 传入)`)
    const known = new Set([...(cmd.args ?? []).map((a) => a.name), ...GLOBAL_FLAGS.map((a) => a.name)])
    const unknown = Object.keys(flags).filter((k) => !known.has(k))
    if (unknown.length) throw new CliError("USAGE", `未知参数: ${unknown.map((k) => "--" + k).join(" ")}`, { allowed: [...(cmd.args ?? []).map((a) => a.name)] })
    const args = resolveArgs(cmd.args ?? [], flags, env)
    const ctx = makeCtx(args, flags)

    if (cmd.sideEffect && (!g.confirm || g["dry-run"])) {
      const plan = { command: cmd.name, ...(cmd.plan ? cmd.plan(ctx) : {}), args: scrub(args) }
      const payload = { ok: false, command: cmd.name, dryRun: true, plan, error: { code: "DRY_RUN", message: "有副作用的命令默认 dry-run;确认无误后加 --confirm 执行", exitCode: EXIT_CODES.DRY_RUN, retryable: false } }
      return emit(payload, `[dry-run] ${JSON.stringify(plan, null, 2)}\n加 --confirm 才会真正执行。`, EXIT_CODES.DRY_RUN)
    }

    if (cmd.capability) {
      const p = await bootProvider()
      if (p.capabilities?.[cmd.capability] !== true) throw new CliError("FEATURE_NOT_SUPPORTED", `当前学校不支持 ${cmd.capability}`)
    }
    if (cmd.auth) {
      await bootProvider()
      const { useAuthStore } = await import("@/lib/stores/auth")
      if (!useAuthStore.getState().isAuthenticated) throw new CliError("AUTH_REQUIRED", "尚未登录", { next: "ysu auth login --username <学号> --password-stdin --remember" })
    }

    let data: any
    let relogged = false
    for (;;) {
      try {
        data = await cmd.run(ctx)
        break
      } catch (e: any) {
        const code = e?.code
        if (cmd.auth && !relogged && !g["no-relogin"] && (code === "AUTH_SESSION_EXPIRED" || code === "AUTH_REQUIRED")) {
          const p = await bootProvider()
          relogged = true
          if (await cliRelogin(p, ctx.pending)) continue
        }
        throw e
      }
    }

    const meta: any = { durationMs: Date.now() - started, httpRequests: stats.requests, retries: stats.retries }
    if (relogged) meta.relogged = true
    if (Array.isArray(data) && (cmd.paged || g.limit !== undefined || g.offset)) {
      const r = paginate(data, g.offset, g.limit)
      data = r.items
      meta.page = r.page
    }
    await persistAfterRun()
    data = scrubResult(cmd.name, data)
    return emit({ ok: true, command: cmd.name, data, meta }, JSON.stringify(data, null, 2), 0)
  } catch (e: any) {
    await persistAfterRun()
    const err = toErrorPayload(e)
    return emit({ ok: false, command: commandName, error: err }, `错误 [${err.code}] ${err.message}${err.details ? "\n" + JSON.stringify(err.details, null, 2) : ""}`, err.exitCode, true)
  } finally {
    try { flush() } catch { /* ignore */ }
  }
}

export function paginate<T>(all: T[], offsetIn?: number, limitIn?: number) {
  const total = all.length
  const offset = Math.max(0, Math.floor(offsetIn ?? 0))
  const limit = limitIn !== undefined ? Math.max(0, Math.floor(limitIn)) : undefined
  const items = all.slice(offset, limit !== undefined ? offset + limit : undefined)
  return { items, page: { offset, limit: limit ?? null, total, returned: items.length, hasMore: offset + items.length < total } }
}

export { scrub }

/** 返回数据里不应出现凭据;auth 命令本身不返回 token。 */
function scrubResult(_name: string, data: any): any {
  return scrub(data)
}

