import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const shim = (f: string) => fileURLToPath(new URL(`./shims/${f}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@aparajita/capacitor-secure-storage": shim("secure-storage.ts"),
      "@capacitor/core": shim("capacitor-core.ts"),
      sonner: shim("sonner.ts"),
      "@": fileURLToPath(new URL("..", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    environment: "node",
    include: ["cli/**/*.test.ts"],
    fileParallelism: false,
  },
})
