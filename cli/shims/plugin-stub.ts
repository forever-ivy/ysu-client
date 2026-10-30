/* eslint-disable @typescript-eslint/no-explicit-any */
/** 其余 Capacitor 插件的空实现(CLI 不会调用到原生功能)。 */
const stub: any = new Proxy({}, {
  get: (_t, p) => (p === "then" ? undefined : new Proxy(async () => { throw new Error("native plugin unavailable in CLI") }, { get: () => stub })),
})
export default stub
export const App = stub, Device = stub, Filesystem = stub, Directory = {} as any, Encoding = {} as any,
  CapacitorUpdater = stub, Preferences = stub, LocalNotifications = stub, Share = stub, Browser = stub
