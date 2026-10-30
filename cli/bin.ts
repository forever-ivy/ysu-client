/* eslint-disable @typescript-eslint/no-explicit-any */
import { run } from "./main"

run(process.argv.slice(2)).then((r) => {
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  // 部分协议模块会挂定时器/长连接;结果已输出,直接以约定退出码结束
  process.stdout.write("", () => process.exit(r.exitCode))
})
