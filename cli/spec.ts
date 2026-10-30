/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 命令描述(与实现分离,供 schema / help / 参数解析共用)。
 */
export type ArgType = "string" | "number" | "boolean" | "json"

export interface ArgSpec {
  name: string
  type: ArgType
  description: string
  required?: boolean
  env?: string
  default?: unknown
  choices?: readonly string[]
  /** 敏感参数:不会回显到输出,也不应在命令行明文传(用 env 或 stdin) */
  secret?: boolean
}

export interface CommandSpec {
  /** 以空格分隔的命令路径,如 "grades list" */
  name: string
  summary: string
  args?: ArgSpec[]
  /** 需要教务登录 */
  auth?: boolean
  /** 产生写操作/副作用:默认 dry-run,需 --confirm 才真正执行 */
  sideEffect?: boolean
  /** 返回数组,支持 --limit/--offset */
  paged?: boolean
  /** 需要的 provider capability */
  capability?: string
  examples?: string[]
}

export const GLOBAL_FLAGS: ArgSpec[] = [
  { name: "json", type: "boolean", env: "YSU_CLI_JSON", description: "输出单行 JSON 信封 {ok,command,data,meta} / {ok:false,error}" },
  { name: "pretty", type: "boolean", description: "JSON 缩进输出(隐含 --json)" },
  { name: "timeout", type: "number", env: "YSU_CLI_TIMEOUT_MS", description: "单个 HTTP 请求超时(毫秒),默认使用各子系统内置值(多为 30000)" },
  { name: "retries", type: "number", env: "YSU_CLI_RETRIES", default: 2, description: "网络错误 / 502-504 时 GET 请求的重试次数(指数退避)" },
  { name: "limit", type: "number", description: "列表结果最多返回条数(客户端分页)" },
  { name: "offset", type: "number", default: 0, description: "列表结果起始偏移(客户端分页)" },
  { name: "confirm", type: "boolean", description: "真正执行有副作用的命令(否则为 dry-run)" },
  { name: "dry-run", type: "boolean", description: "强制 dry-run(优先于 --confirm)" },
  { name: "no-relogin", type: "boolean", description: "会话过期时不使用已记住的密码自动重登" },
  { name: "verbose", type: "boolean", env: "YSU_CLI_VERBOSE", description: "把 HTTP 摘要日志写到 stderr(URL 中的敏感参数已打码,不含 cookie)" },
  { name: "home", type: "string", env: "YSU_CLI_HOME", description: "状态目录,默认 ~/.config/ysu-cli(目录 0700,state.json 0600)" },
  { name: "help", type: "boolean", description: "显示帮助" },
]

export const EXIT_CODES = {
  OK: 0,
  UNKNOWN: 1,
  USAGE: 2,
  AUTH_REQUIRED: 3,
  AUTH_ACTION_REQUIRED: 4,
  NETWORK: 5,
  BACKEND: 6,
  NOT_SUPPORTED: 7,
  NOT_FOUND: 8,
  RATE_LIMITED: 9,
  DRY_RUN: 10,
} as const

export const EXIT_CODE_DOCS: Record<number, string> = {
  0: "成功",
  1: "未知错误",
  2: "用法错误(未知命令 / 缺参数 / 参数类型不对)",
  3: "需要登录或会话已过期且无法自动重登(AUTH_REQUIRED / AUTH_SESSION_EXPIRED / AUTH_INVALID_CREDENTIAL / 森空鸟 token 无效)",
  4: "需要人工步骤:验证码或二次认证(AUTH_CAPTCHA_REQUIRED / AUTH_MFA_REQUIRED),error.details.next 给出下一条命令",
  5: "网络错误或超时(NETWORK_ERROR / TIMEOUT)",
  6: "上游业务或协议错误(BACKEND_BUSINESS_ERROR / BACKEND_PROTOCOL_ERROR)",
  7: "该学校/后端不支持此功能(FEATURE_NOT_SUPPORTED)",
  8: "数据不存在(DATA_NOT_FOUND)",
  9: "被限流(RATE_LIMITED)",
  10: "dry-run:有副作用的命令未加 --confirm,只返回将要执行的操作",
}
