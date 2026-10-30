// 静态图片模块声明(.png/.jpg/.svg 等)。
// next-env.d.ts 被 .gitignore 忽略、只在 next dev/build 时生成,
// 这里显式引用,保证全新 clone 上 `pnpm typecheck` 也能通过。
/// <reference types="next/image-types/global" />
