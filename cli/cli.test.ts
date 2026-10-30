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
