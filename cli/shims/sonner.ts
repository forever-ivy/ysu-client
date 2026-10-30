/** UI toast 在 CLI 中转为 verbose 日志(stderr),不影响 JSON 输出。 */
const log = (level: string) => (msg: unknown) => {
  if (process.env.YSU_CLI_VERBOSE) process.stderr.write(`[toast:${level}] ${String(msg)}\n`)
  return 0
}
export const toast = Object.assign(log("info"), {
  success: log("success"), error: log("error"), info: log("info"), warning: log("warn"),
  message: log("info"), loading: log("info"), dismiss: () => {}, promise: () => {},
})
export const Toaster = () => null
// eslint-disable-next-line import/no-anonymous-default-export
export default { toast }
