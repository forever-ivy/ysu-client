/** Node 下没有 Capacitor 原生层:isNativePlatform() 恒为 false。 */
export const Capacitor = {
  isNativePlatform: () => false,
  getPlatform: () => "web",
  isPluginAvailable: () => false,
  convertFileSrc: (s: string) => s,
}
export const CapacitorHttp = undefined
export const CapacitorCookies = undefined
export function registerPlugin(): unknown {
  return new Proxy({}, { get: () => async () => { throw new Error("native plugin unavailable in CLI") } })
}
export class WebPlugin {}
// eslint-disable-next-line import/no-anonymous-default-export
export default { Capacitor }
