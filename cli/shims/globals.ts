/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 在任何项目模块求值前安装 Node 下缺失的浏览器全局:
 * window / localStorage(落盘)/ DOMParser(linkedom)。
 * 必须是 main.ts 的第一个 import。
 */
import { DOMParser as LinkeDOMParser } from "linkedom"
import { bucket } from "../store"

const g = globalThis as any

// Node 20 没有 Promise.withResolvers(Node 22+ 才有);providers/ysu/auth-transition.ts 依赖它
if (typeof (Promise as any).withResolvers !== "function") {
  ;(Promise as any).withResolvers = function withResolvers<T>() {
    let resolve!: (v: T | PromiseLike<T>) => void
    let reject!: (e?: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
}
const ls = bucket("local")
const storage = {
  getItem: (k: string) => ls.get(k),
  setItem: (k: string, v: string) => ls.set(k, v),
  removeItem: (k: string) => ls.remove(k),
  clear: () => ls.clear(),
  key: (i: number) => ls.keys()[i] ?? null,
  get length() { return ls.keys().length },
}
if (!g.window) g.window = g
// Node ≥22 自带实验性 localStorage(读取即告警且不落盘),直接覆盖,不要先读。
Object.defineProperty(g, "localStorage", { value: storage, configurable: true, writable: true })
{
  const mem = new Map<string, string>()
  Object.defineProperty(g, "sessionStorage", { configurable: true, value: {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(), key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size } } })
}
if (!g.DOMParser) g.DOMParser = LinkeDOMParser
if (!g.addEventListener) { g.addEventListener = () => {}; g.removeEventListener = () => {}; g.dispatchEvent = () => true }
if (!g.matchMedia) g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
if (!g.location) g.location = new URL("https://localhost/")
if (!g.document) {
  // 极少量代码会探测 document;给一个空文档,真正解析统一走 DOMParser。
  g.document = new LinkeDOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html")
}
