/**
 * Node 直连传输:替代 CapacitorHttp / Web 边缘代理。
 * - 手动处理重定向(上层 followRedirects 负责跟随),Cookie 只来自 jar;
 * - 全局超时(--timeout)与网络级重试(--retries,仅 GET 或显式幂等请求);
 * - 不记录任何请求头/正文,避免泄露凭据。
 */
import type { HttpRequest, HttpResponse, SimpleCookieJar } from "@/lib/cookie"

export interface TransportOptions {
  timeoutMs?: number
  retries: number
  userAgent: string
  verbose: boolean
  trace: boolean
  /** 只读请求超过这么多毫秒没响应就并发补发一次(0 关闭);只作用于 HEDGE_SAFE 白名单 */
  hedgeMs: number
}

export const transportOptions: TransportOptions = {
  retries: 2,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  verbose: false,
  trace: false,
  hedgeMs: 2500,
}

export interface TraceEntry { method: string; host: string; path: string; status: number | null; startMs: number; ms: number; attempt: number; hedged?: boolean }
export const stats: { requests: number; retries: number; hedged: number; trace: TraceEntry[] } = { requests: 0, retries: 0, hedged: 0, trace: [] }

/** 可以安全并发补发的纯查询接口(签到 signin/sign 等写接口不在其中) */
export const HEDGE_SAFE = [
  /\/jwmobile\/biz\/v410\/signin\/detail$/,
  /\/jwmobile\/biz\/v410\/signin\/querySigninDetail$/,
  /\/jwmobile\/biz\/v410\/lesson\/queryCurrentLesson$/,
]

export function isHedgeSafe(url: string): boolean {
  try {
    const p = new URL(url).pathname
    return HEDGE_SAFE.some((r) => r.test(p))
  } catch {
    return false
  }
}

export const fetchImpl: { fetch: typeof fetch } = { fetch: (...a) => globalThis.fetch(...a) }

/** 先发一次;hedgeMs 内没有响应头就再发一次,取先返回的,另一个中止。 */
export function hedgedFetch(url: string, init: RequestInit, hedgeMs: number): Promise<Response> {
  if (!(hedgeMs > 0)) return fetchImpl.fetch(url, init)
  const outer = init.signal ?? undefined
  const ctrls: AbortController[] = []
  const attempt = () => {
    const c = new AbortController()
    ctrls.push(c)
    const signal = outer ? AbortSignal.any([outer, c.signal]) : c.signal
    return fetchImpl.fetch(url, { ...init, signal }).then((resp) => ({ resp, c }))
  }
  return new Promise((resolve, reject) => {
    let isDone = false
    let pending = 1
    const settle = ({ resp, c }: { resp: Response; c: AbortController }) => {
      if (isDone) { resp.body?.cancel().catch(() => {}); return }
      isDone = true
      clearTimeout(timer)
      for (const x of ctrls) if (x !== c) x.abort()
      resolve(resp)
    }
    const fail = (e: unknown) => {
      if (--pending === 0 && !isDone) { isDone = true; clearTimeout(timer); reject(e) }
    }
    attempt().then(settle, fail)
    const timer = setTimeout(() => {
      if (isDone) return
      pending++
      stats.hedged++
      attempt().then(settle, fail)
    }, hedgeMs)
    timer.unref?.()
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function redactUrl(u: string): string {
  try {
    const x = new URL(u)
    for (const k of [...x.searchParams.keys()]) {
      if (/pass|pwd|token|ticket|code|key|secret/i.test(k)) x.searchParams.set(k, "***")
    }
    return x.toString()
  } catch {
    return "<url>"
  }
}

export async function nodeHttpSend(jar: SimpleCookieJar, req: HttpRequest): Promise<HttpResponse> {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const lower = k.toLowerCase()
    if (lower === "cookie" || lower === "host" || lower === "content-length" || lower === "connection") continue
    headers.set(k, v)
  }
  if (!headers.has("user-agent")) headers.set("user-agent", transportOptions.userAgent)
  if (!headers.has("accept")) headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
  if (!headers.has("accept-language")) headers.set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
  const cookie = await jar.getCookieString(req.url)
  if (cookie) headers.set("cookie", cookie)
  const body = req.body instanceof URLSearchParams ? req.body.toString() : req.body
  if (body !== undefined && !headers.has("content-type") && req.body instanceof URLSearchParams) {
    headers.set("content-type", "application/x-www-form-urlencoded; charset=UTF-8")
  }
  const timeout = transportOptions.timeoutMs ?? req.timeoutMs ?? 30_000
  const idempotent = req.method === "GET"
  const maxAttempts = idempotent ? transportOptions.retries + 1 : 1

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signals = [AbortSignal.timeout(timeout)]
    if (req.signal) signals.push(req.signal)
    const started = Date.now()
    try {
      stats.requests++
      const url = req.url.split("#")[0]!
      const init: RequestInit = { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.any(signals) }
      const resp = isHedgeSafe(url) ? await hedgedFetch(url, init, transportOptions.hedgeMs) : await fetchImpl.fetch(url, init)
      if (transportOptions.trace) {
        const u = new URL(url)
        stats.trace.push({ method: req.method, host: u.hostname, path: u.pathname, status: resp.status, startMs: Math.round(started - performance.timeOrigin), ms: Date.now() - started, attempt })
      }
      if (transportOptions.verbose) {
        process.stderr.write(`[http] ${req.method} ${redactUrl(req.url)} -> ${resp.status} ${Date.now() - started}ms\n`)
      }
      const setCookies = resp.headers.getSetCookie?.() ?? []
      for (const sc of setCookies) await jar.setCookie(sc, req.url, { ignoreError: true })
      const out: Record<string, string | string[]> = {}
      for (const [k, v] of resp.headers.entries()) {
        if (k === "set-cookie") continue
        out[k] = v
      }
      if (setCookies.length) out["set-cookie"] = setCookies
      const buf = Buffer.from(await resp.arrayBuffer())
      // 5xx 的 GET 也重试(网关抖动),最后一次照常返回
      if (idempotent && resp.status >= 502 && resp.status <= 504 && attempt < maxAttempts) {
        stats.retries++
        await sleep(400 * 2 ** (attempt - 1))
        continue
      }
      return {
        status: resp.status,
        headers: out,
        url: req.url,
        text: async () => buf.toString("utf8"),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      }
    } catch (e) {
      lastErr = e
      if (req.signal?.aborted) throw e
      if (transportOptions.verbose) {
        process.stderr.write(`[http] ${req.method} ${redactUrl(req.url)} failed (${(e as Error).name}) attempt ${attempt}/${maxAttempts}\n`)
      }
      if (attempt < maxAttempts) {
        stats.retries++
        await sleep(400 * 2 ** (attempt - 1))
      }
    }
  }
  const err = lastErr as Error
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    const t = new Error(`request timeout after ${timeout}ms: ${redactUrl(req.url)}`)
    t.name = "TimeoutError"
    throw t
  }
  throw new Error(`network error: ${err?.message ?? String(err)} (${redactUrl(req.url)})`)
}
