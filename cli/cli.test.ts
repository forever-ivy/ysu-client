/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ysu-cli-test-"))
process.env.YSU_CLI_HOME = HOME

const { run, parseArgv, resolveArgs, schema, toErrorPayload, paginate, scrub, findCommand } = await import("./main")
const { COMMANDS } = await import("./commands")
const { GLOBAL_FLAGS, EXIT_CODE_DOCS } = await import("./spec")
const { nodeHttpSend, transportOptions, stats } = await import("./transport")
const { SimpleCookieJar, setHttpTransport } = await import("@/lib/cookie")
const store = await import("./store")

const J = async (argv: string[]) => {
  const r = await run([...argv, "--json"])
  return { ...r, body: JSON.parse(r.stdout) }
}

// 任何意外的真实网络请求都会失败
let blockedRequests = 0
beforeEach(() => {
  setHttpTransport(async () => {
    blockedRequests++
    throw new Error("network error: blocked in tests")
  })
})

describe("参数解析", () => {
  it("解析路径、--k v、--k=v、布尔全局 flag", () => {
    const p = parseArgv(["grades", "list", "--semester", "2024-2025-1", "--json", "--limit=5", "--confirm"])
    expect(p.path).toEqual(["grades", "list"])
    expect(p.flags).toEqual({ semester: "2024-2025-1", json: true, limit: "5", confirm: true })
  })
  it("类型转换、默认值、环境变量、必填", () => {
    const specs: any = [
      { name: "n", type: "number", description: "" },
      { name: "b", type: "boolean", description: "" },
      { name: "u", type: "string", env: "X_U", required: true, description: "" },
      { name: "d", type: "string", default: "z", description: "" },
    ]
    expect(resolveArgs(specs, { n: "3", b: "false" }, { X_U: "me" } as any)).toEqual({ n: 3, b: false, u: "me", d: "z" })
    expect(() => resolveArgs(specs, { n: "x" }, { X_U: "me" } as any)).toThrow(/数字/)
    expect(() => resolveArgs(specs, {}, {} as any)).toThrow(/必填/)
  })
  it("最长前缀匹配命令", () => {
    expect(findCommand(["school", "class-schedule"]).cmd?.name).toBe("school class-schedule")
    expect(findCommand(["nope"]).cmd).toBeUndefined()
  })
})

describe("schema / help / version", () => {
  it("schema 覆盖全部命令且结构稳定", async () => {
    const { body, exitCode } = await J(["schema"])
    expect(exitCode).toBe(0)
    const sc = body.data
    expect(sc.commands.length).toBe(COMMANDS.length + 2)
    for (const c of sc.commands) {
      expect(typeof c.name).toBe("string")
      expect(c.summary.length).toBeGreaterThan(0)
      expect(Array.isArray(c.args)).toBe(true)
      for (const a of c.args) expect(["string", "number", "boolean", "json"]).toContain(a.type)
    }
    expect(Object.keys(sc.exitCodes)).toEqual(Object.keys(EXIT_CODE_DOCS))
    expect(sc.globalFlags.map((f: any) => f.name)).toEqual(GLOBAL_FLAGS.map((f) => f.name))
    expect(schema().commands.filter((c: any) => c.sideEffect).map((c: any) => c.name).sort()).toEqual(
      ["evaluation submit", "makeup signup", "plan recalculate", "signin sign", "skbird like", "skbird mark", "skbird unlock"].sort()
    )
  })
  it("覆盖 AcademicProvider 的全部只读/写方法", () => {
    const src = fs.readFileSync(path.join(__dirname, "commands.ts"), "utf8")
    const types = fs.readFileSync(path.join(__dirname, "..", "providers", "types.ts"), "utf8")
    const block = types.slice(types.indexOf("export interface ProviderAcademics"), types.indexOf("export interface ProviderRelogin"))
    const methods = [...block.matchAll(/^\s+([a-zA-Z]+)\??\(/gm)].map((m) => m[1]!)
    const missing = methods.filter((m) => !src.includes(`.${m}(`) && !src.includes(`p.${m}`))
    expect(missing).toEqual([])
  })
  it("--help 与 version", async () => {
    const h = await run(["--help"])
    expect(h.exitCode).toBe(0)
    expect(h.stdout).toContain("grades list")
    const sub = await run(["grades", "list", "--help"])
    expect(sub.stdout).toContain("--semester")
    const v = await J(["version"])
    expect(v.body.data.cli).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe("退出码与结构化错误", () => {
  it("未知命令 = 2", async () => {
    const r = await J(["nope"])
    expect(r.exitCode).toBe(2)
    expect(r.body).toMatchObject({ ok: false, error: { code: "USAGE", exitCode: 2 } })
  })
  it("未知参数 = 2", async () => {
    const r = await J(["auth", "status", "--bogus", "1"])
    expect(r.exitCode).toBe(2)
    expect(r.body.error.details.allowed).toContain("check")
  })
  it("未登录访问需要登录的命令 = 3,且没有发出网络请求", async () => {
    const before = blockedRequests
    const r = await J(["grades", "list"])
    expect(r.exitCode).toBe(3)
    expect(r.body.error.code).toBe("AUTH_REQUIRED")
    expect(r.body.error.details.next).toContain("auth login")
    expect(blockedRequests).toBe(before)
  })
  it("ProviderError 码映射", () => {
    const m = (code: string) => toErrorPayload({ code, message: "x" }).exitCode
    expect(m("AUTH_SESSION_EXPIRED")).toBe(3)
    expect(m("AUTH_MFA_REQUIRED")).toBe(4)
    expect(m("AUTH_CAPTCHA_REQUIRED")).toBe(4)
    expect(m("TIMEOUT")).toBe(5)
    expect(m("BACKEND_PROTOCOL_ERROR")).toBe(6)
    expect(m("FEATURE_NOT_SUPPORTED")).toBe(7)
    expect(m("DATA_NOT_FOUND")).toBe(8)
    expect(m("RATE_LIMITED")).toBe(9)
    expect(toErrorPayload(new Error("network error: x")).code).toBe("NETWORK_ERROR")
    expect(toErrorPayload({ name: "SkbirdError", errno: 10, message: "bad" }).exitCode).toBe(3)
    expect(toErrorPayload({ name: "MeterError", code: 1, message: "NOT_BOUND" }).code).toBe("DATA_NOT_FOUND")
    expect(toErrorPayload({ code: "TIMEOUT", message: "" }).retryable).toBe(true)
  })
  it("缺少密码 = 2,且不回显", async () => {
    const r = await J(["auth", "login", "--username", "u1"])
    expect(r.exitCode).toBe(2)
    expect(r.body.error.message).toContain("YSU_PASSWORD")
  })
})

describe("副作用命令默认 dry-run", () => {
  const cases: Record<string, string[]> = {
    "makeup signup": ["--task-id", "T1", "--batch-id", "B1"],
    "evaluation submit": ["--input", '{"groupNo":"g","wjid":"w","evalType":"t","answers":[]}'],
    "plan recalculate": [],
    "signin sign": ["--activity-id", "A1", "--latitude", "39.9", "--longitude", "119.5"],
    "skbird mark": ["--id", "1"],
    "skbird like": ["--id", "1"],
    "skbird unlock": ["--id", "1"],
  }
  for (const [name, extra] of Object.entries(cases)) {
    it(`${name}: 无 --confirm → 退出码 10、返回 plan、零网络请求`, async () => {
      const before = blockedRequests
      const r = await J([...name.split(" "), ...extra])
      expect(r.exitCode).toBe(10)
      expect(r.body).toMatchObject({ ok: false, dryRun: true, error: { code: "DRY_RUN" } })
      expect(r.body.plan.command).toBe(name)
      expect(blockedRequests).toBe(before)
    })
  }
  it("--dry-run 优先于 --confirm", async () => {
    const r = await J(["makeup", "signup", "--task-id", "T", "--batch-id", "B", "--confirm", "--dry-run"])
    expect(r.exitCode).toBe(10)
  })
  it("--confirm 后才进入真实流程(此处未登录 → 3,仍未发请求)", async () => {
    const before = blockedRequests
    const r = await J(["makeup", "signup", "--task-id", "T", "--batch-id", "B", "--confirm"])
    expect(r.exitCode).toBe(3)
    expect(blockedRequests).toBe(before)
  })
})

describe("分页", () => {
  it("offset/limit/hasMore", () => {
    const r = paginate([1, 2, 3, 4, 5], 1, 2)
    expect(r.items).toEqual([2, 3])
    expect(r.page).toEqual({ offset: 1, limit: 2, total: 5, returned: 2, hasMore: true })
    expect(paginate([1, 2], 0).page.hasMore).toBe(false)
  })
  it("在命令输出中生效", async () => {
    COMMANDS.push({ name: "zz fake", summary: "test", paged: true, run: async () => [1, 2, 3, 4] } as any)
    const r = await J(["zz", "fake", "--limit", "2", "--offset", "1"])
    expect(r.body.data).toEqual([2, 3])
    expect(r.body.meta.page).toMatchObject({ total: 4, returned: 2, hasMore: true })
    COMMANDS.pop()
  })
})

describe("凭据安全", () => {
  it("scrub 去掉密码、token、cookie", () => {
    const out = scrub({ password: "p@ss", nested: { token: "abc", note: "url?ticket=ST-123&x=1 CASTGC=TGT-xyz" } })
    expect(JSON.stringify(out)).not.toMatch(/p@ss|abc|ST-123|TGT-xyz/)
  })
  it("状态文件权限 0700/0600", async () => {
    const b = store.bucket("secure")
    b.set("k", "v")
    store.flush()
    expect(fs.statSync(store.statePath()).mode & 0o777).toBe(0o600)
    expect(fs.statSync(store.stateDir()).mode & 0o777).toBe(0o700)
  })
  it("skbird config 不回显 token", async () => {
    process.env.YSU_SKBIRD_TOKEN = "SECRET-TOKEN-1234567890"
    const r = await J(["skbird", "config"])
    delete process.env.YSU_SKBIRD_TOKEN
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain("SECRET-TOKEN-1234567890")
    expect(r.body.data.tokenConfigured).toBe(true)
    await J(["skbird", "config", "--clear"])
  })
})

describe("Node 直连传输(本地 HTTP 服务)", () => {
  let server: http.Server
  let base = ""
  let hits503 = 0
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/set") { res.setHeader("set-cookie", ["A=1; Path=/", "B=2; Path=/; HttpOnly"]); res.end("ok"); return }
      if (req.url === "/echo") { res.end(JSON.stringify({ cookie: req.headers.cookie ?? "", ua: req.headers["user-agent"] })); return }
      if (req.url === "/redir") { res.statusCode = 302; res.setHeader("location", "/echo"); res.end(); return }
      if (req.url === "/flaky") { if (hits503++ < 1) { res.statusCode = 503; res.end(); return } res.end("recovered"); return }
      if (req.url === "/slow") { setTimeout(() => res.end("late"), 1500); return }
      res.statusCode = 404; res.end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => server.close())

  it("Set-Cookie 进 jar、Cookie 从 jar 发出、重定向手动返回", async () => {
    const jar = new SimpleCookieJar()
    await nodeHttpSend(jar, { method: "GET", url: `${base}/set`, redirect: "manual" })
    const echo = JSON.parse(await (await nodeHttpSend(jar, { method: "GET", url: `${base}/echo`, redirect: "manual" })).text())
    expect(echo.cookie).toBe("A=1; B=2")
    const r = await nodeHttpSend(jar, { method: "GET", url: `${base}/redir`, redirect: "manual" })
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe("/echo")
  })
  it("fetchWithJar(follow) 经注入传输跟随重定向", async () => {
    setHttpTransport(nodeHttpSend)
    const { fetchWithJar } = await import("@/lib/cookie")
    const r = await fetchWithJar(new SimpleCookieJar(), { method: "GET", url: `${base}/redir`, redirect: "follow" })
    expect(r.status).toBe(200)
  })
  it("503 自动重试", async () => {
    transportOptions.retries = 2
    const before = stats.retries
    const r = await nodeHttpSend(new SimpleCookieJar(), { method: "GET", url: `${base}/flaky`, redirect: "manual" })
    expect(await r.text()).toBe("recovered")
    expect(stats.retries - before).toBe(1)
  })
  it("超时 → TimeoutError,映射为退出码 5", async () => {
    transportOptions.retries = 0
    transportOptions.timeoutMs = 200
    let err: any
    try { await nodeHttpSend(new SimpleCookieJar(), { method: "GET", url: `${base}/slow`, redirect: "manual" }) } catch (e) { err = e }
    transportOptions.timeoutMs = undefined
    expect(err?.name).toBe("TimeoutError")
    expect(toErrorPayload(err).exitCode).toBe(5)
  })
})

// ─── Codex 审查回归测试 ───────────────────────────────────────────────── //

const fakeCtx = (over: Partial<any> = {}) => {
  const pend: Record<string, any> = {}
  return {
    args: {},
    pendingStore: pend,
    provider: async () => ({}),
    ensureTransport: async () => {},
    relogin: async () => false,
    pending: { get: (k: string) => pend[k], set: (k: string, v: any) => { pend[k] = v }, del: (k: string) => { delete pend[k] } },
    readSecret: async () => undefined,
    ...over,
  } as any
}
const cmd = (name: string) => COMMANDS.find((c) => c.name === name)!

describe("Codex 审查修复", () => {
  it("skbird 命令先安装 Node 传输(不依赖 provider 初始化)", async () => {
    let installed = 0
    let providerBooted = 0
    process.env.YSU_SKBIRD_TOKEN = "T-123456789"
    const ctx = fakeCtx({ ensureTransport: async () => { installed++ }, provider: async () => { providerBooted++; return {} } })
    const net = COMMANDS.find((c) => c.name.startsWith("skbird ") && c.name !== "skbird config" && !c.sideEffect)!
    await net.run(ctx).catch(() => {})
    delete process.env.YSU_SKBIRD_TOKEN
    expect(installed).toBeGreaterThan(0)
    expect(providerBooted).toBe(0)
  })

  it("bin/ysu 经符号链接调用也能找到仓库", async () => {
    const { execFileSync } = await import("node:child_process")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ysu-link-"))
    fs.mkdirSync(path.join(tmp, "bin"))
    const link = path.join(tmp, "bin", "ysu")
    fs.symlinkSync(path.resolve(__dirname, "..", "bin", "ysu"), link)
    const out = execFileSync(link, ["version", "--json"], { env: { ...process.env, YSU_CLI_HOME: HOME }, encoding: "utf8" })
    expect(JSON.parse(out).ok).toBe(true)
  }, 120_000)

  it("微信 MFA 完成后用待续登录的学号保存凭据", async () => {
    const { useAuthStore } = await import("@/lib/stores/auth")
    useAuthStore.getState().clearCredential()
    const p = {
      pollWechatMfaQr: async () => ({ status: "confirmed", code: "C", errcode: 405 }),
      completeWechatMfa: async () => { useAuthStore.getState().setCredential("cred", undefined); return "cred" },
    }
    const ctx = fakeCtx({ args: { wait: 0 }, provider: async () => p })
    ctx.pending.set("mfa", { username: "2021000001", remember: false })
    ctx.pending.set("wechat", { uuid: "u", state: "s" })
    const r = await cmd("auth wechat-poll").run(ctx)
    expect(r.username).toBe("2021000001")
    expect(useAuthStore.getState().username).toBe("2021000001")
    expect(ctx.pending.get("mfa")).toBeUndefined()
    useAuthStore.getState().clearCredential()
  })

  it("relogin 需要 MFA 时不挂起,返回 AUTH_MFA_REQUIRED 并保存待续登录", async () => {
    const { cliRelogin } = await import("./main")
    const { useMFAModalStore } = await import("@/lib/stores/mfa-modal")
    // 模拟 bootProvider 安装的 CLI 处理器
    const main = await import("./main")
    useMFAModalStore.setState({ showMFA: ((o: any) => { main.reloginMfa.username = o.username; return Promise.reject(new Error("x")) }) as any })
    const p = { relogin: async () => { try { await useMFAModalStore.getState().showMFA({ username: "2021000002" }); return true } catch { return false } } }
    const ctx = fakeCtx()
    let err: any
    const t0 = Date.now()
    try { await cliRelogin(p, ctx.pending) } catch (e) { err = e }
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(err?.code).toBe("AUTH_MFA_REQUIRED")
    expect(toErrorPayload(err).exitCode).toBe(4)
    expect(ctx.pending.get("mfa")).toEqual({ username: "2021000002", remember: true })
  })

  it("auth login 先重置 CAS 会话(切换账号不沿用旧 cookie);--captcha 续接时保留", async () => {
    const calls: string[] = []
    const p = { resetLoginSession: async () => { calls.push("reset") }, login: async () => { calls.push("login") } }
    const ctx = fakeCtx({ args: { username: "B" }, provider: async () => p, readSecret: async () => "pw" })
    await cmd("auth login").run(ctx)
    expect(calls).toEqual(["reset", "login"])
    calls.length = 0
    const { useAuthStore } = await import("@/lib/stores/auth")
    useAuthStore.getState().clearCredential()
    await cmd("auth login").run(fakeCtx({ args: { username: "B", captcha: "abcd" }, provider: async () => p, readSecret: async () => "pw" }))
    expect(calls).toEqual(["login"])
    useAuthStore.getState().clearCredential()
  })

  it("并发进程不会互相覆盖状态文件中的其他键", () => {
    store.resetCache()
    const b = store.bucket("secure")
    b.get("x") // 载入快照
    // 另一个进程在此期间写入了新键
    const disk = JSON.parse(fs.readFileSync(store.statePath(), "utf8"))
    disk.secure["other-process"] = "1"
    fs.writeFileSync(store.statePath(), JSON.stringify(disk))
    b.set("this-process", "2")
    store.flush()
    const after = JSON.parse(fs.readFileSync(store.statePath(), "utf8"))
    expect(after.secure["other-process"]).toBe("1")
    expect(after.secure["this-process"]).toBe("2")
    expect(fs.existsSync(path.join(store.stateDir(), "state.lock"))).toBe(false)
  })

  it("两个真实子进程并发写不同键,两者都保留", async () => {
    const { spawn } = await import("node:child_process")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ysu-race-"))
    const storeSrc = path.resolve(__dirname, "store.ts")
    const script = (k: string) => `const s=await import(${JSON.stringify(storeSrc)});const b=s.bucket("secure");b.get("z");await new Promise(r=>setTimeout(r,300));b.set(${JSON.stringify(k)},"1");s.flush();`
    const runOne = (k: string) => new Promise<number>((res) => {
      const c = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script(k)], { env: { ...process.env, YSU_CLI_HOME: dir }, stdio: "inherit" })
      c.on("exit", (code) => res(code ?? 1))
    })
    const codes = await Promise.all([runOne("k1"), runOne("k2")])
    expect(codes).toEqual([0, 0])
    const st = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))
    expect(Object.keys(st.secure).sort()).toEqual(["k1", "k2"])
  }, 30_000)
})
