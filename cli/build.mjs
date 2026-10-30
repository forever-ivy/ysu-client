// 打包 CLI:esbuild 把 cli/bin.ts + 项目代码打成单文件 cli/dist/ysu.mjs。
// Capacitor / sonner 等浏览器依赖替换为 cli/shims 下的 Node 实现。
import { build } from "esbuild"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const shim = (f) => path.join(here, "shims", f)
const alias = {
  "@aparajita/capacitor-secure-storage": shim("secure-storage.ts"),
  "@capacitor/core": shim("capacitor-core.ts"),
  sonner: shim("sonner.ts"),
}
for (const m of ["@capacitor/app", "@capacitor/device", "@capacitor/filesystem", "@capgo/capacitor-updater", "@capacitor/preferences", "@capacitor/local-notifications"]) alias[m] = shim("plugin-stub.ts")

await build({
  entryPoints: [path.join(here, "bin.ts")],
  outfile: path.join(here, "dist", "ysu.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "linked",
  alias,
  tsconfig: path.join(here, "..", "tsconfig.json"),
  define: { "process.env.NEXT_PUBLIC_PROXY_BASE_URL": "undefined" },
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
  external: ["react", "react-dom", "next", "next/*"],
})
console.error("built cli/dist/ysu.mjs")
