/* eslint-disable @typescript-eslint/no-explicit-any */
/** Node 版 @aparajita/capacitor-secure-storage:落到 0600 的 state.json。 */
import { bucket } from "../store"

const b = bucket("secure")
export const SecureStorage = {
  async getItem(k: string) { return b.get(k) },
  async setItem(k: string, v: string) { b.set(k, v) },
  async removeItem(k: string) { b.remove(k) },
  async get(k: string): Promise<unknown> {
    const v = b.get(k)
    if (v === null) return null
    try { return JSON.parse(v) } catch { return v }
  },
  async set(k: string, v: unknown) { b.set(k, JSON.stringify(v)) },
  async remove(k: string) { b.remove(k) },
  async clear() { b.clear() },
  async keys() { return b.keys() },
  async setSynchronize() {},
  async setKeyPrefix() {},
}
// eslint-disable-next-line import/no-anonymous-default-export
export default { SecureStorage }
