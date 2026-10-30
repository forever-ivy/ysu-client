# ysu CLI 手册(给 agent 用)

`ysu` 是燕大终端的命令行版,和 App 用同一套协议代码(`providers/`、`lib/`),由 Node 直接访问学校系统,不经过 EdgeOne 代理。为 agent 设计:

- **非交互**:所有输入都来自参数、环境变量或 stdin,从不弹出提示。
- **`--json`**:stdout 只输出一个 JSON 对象,结构固定(见下文),日志写 stderr。
- **退出码有含义**:按退出码就能决定下一步,不用解析文字。
- **写操作默认 dry-run**:不加 `--confirm` 绝不会真正提交。
- **自描述**:`ysu schema --json` 输出所有命令、参数、类型、是否写操作和退出码表。

## 安装

```bash
cd ysu-client
pnpm install
pnpm cli:build                      # 打包到 cli/dist/ysu.mjs
ln -s "$PWD/bin/ysu" /usr/local/bin/ysu   # 或者 pnpm link --global
ysu version --json
```

`bin/ysu` 发现源码比产物新时会自动重新打包。需要 Node ≥ 20。

## 输出格式

成功:

```json
{"ok":true,"command":"grades list","data":[...],
 "meta":{"durationMs":812,"httpRequests":5,"retries":0,
         "page":{"offset":0,"limit":20,"total":57,"returned":20,"hasMore":true}}}
```

失败(stdout 仍是 JSON,退出码非 0):

```json
{"ok":false,"command":"grades list",
 "error":{"code":"AUTH_REQUIRED","message":"尚未登录","exitCode":3,"retryable":false,
          "details":{"next":"ysu auth login --username <学号> --password-stdin --remember"}}}
```

`meta.page` 只在结果是数组时出现。`error.details.next` 会给出建议的下一条命令。

## 退出码

| 码 | 含义 | agent 应该 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 未知错误 | 带 `--verbose` 重试一次,然后报告 |
| 2 | 用法错误(参数缺失或非法) | 看 `ysu <命令> --help` 修正参数 |
| 3 | 未登录或会话过期 | 运行 `ysu auth login` 或 `ysu auth relogin` |
| 4 | 需要验证码或二次认证 | 按 `error.details` 完成 captcha 或 MFA 流程 |
| 5 | 网络错误或超时 | `retryable:true`,稍后重试或调大 `--timeout` |
| 6 | 学校后端返回错误 | 报告 `error.message` |
| 7 | 该功能不支持 | 看 `ysu capabilities` |
| 8 | 数据不存在 | 正常结果,告诉用户“没有” |
| 9 | 被限流或 IP 冻结 | 等待后再试,不要循环重试 |
| 10 | dry-run(写操作未加 `--confirm`) | 把 `plan` 给用户确认后再加 `--confirm` |

## 全局参数

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--json` / `--pretty` | `YSU_CLI_JSON=1` | JSON 输出 / 缩进 JSON |
| `--timeout <ms>` | `YSU_CLI_TIMEOUT_MS` | 单个 HTTP 请求的超时 |
| `--retries <n>` | `YSU_CLI_RETRIES` | 遇到网络错误或 502/503/504 时重试 GET 的次数(默认 2,指数退避);POST 不自动重试 |
| `--limit` / `--offset` | | 客户端分页,对所有数组结果生效 |
| `--confirm` | | 真正执行写操作 |
| `--dry-run` | | 强制 dry-run(优先级高于 `--confirm`) |
| `--no-relogin` | | 会话过期时不自动用记住的密码重登 |
| `--verbose` | `YSU_CLI_VERBOSE=1` | 在 stderr 输出 HTTP 请求日志(URL 里的 ticket 和 token 已打码) |
| `--home <dir>` | `YSU_CLI_HOME` | 状态目录,默认 `~/.config/ysu-cli` |

## 登录

```bash
# 密码只能从环境变量或 stdin 传入,不会出现在进程参数里
printf '%s' "$PW" | ysu auth login --username 2021xxxxxxxx --password-stdin --remember --json
# 或者
YSU_PASSWORD="$PW" ysu auth login --username 2021xxxxxxxx --remember --json
```

可能的结果:

- **退出码 0**:登录成功。
- **退出码 4,`AUTH_CAPTCHA_REQUIRED`**:先下载验证码,看图后带上验证码重新登录。
  ```bash
  ysu auth captcha --out /tmp/cap.jpg --json
  YSU_PASSWORD=... ysu auth login --username ... --captcha abcd --json
  ```
- **退出码 4,`AUTH_MFA_REQUIRED`**:需要二次认证,`details.methods` 列出可选方式。
  ```bash
  ysu auth mfa-request --method sms --json      # 发送验证码(会给用户手机发短信)
  ysu auth mfa-submit --code 123456 --json
  # 微信扫码:
  ysu auth wechat-start --out /tmp/qr.png --json   # 把二维码给用户扫
  ysu auth wechat-poll --wait 120 --json
  ```

CAS 会话、教务会话和二次认证的中间状态都保存在状态文件里,所以每一步可以是一次独立的进程调用。

`--remember` 会把密码存进状态文件。之后会话过期时,任何命令都会自动重新登录一次(可用 `--no-relogin` 关闭);也可以手动运行 `ysu auth relogin`。

- `ysu auth status --check`:向服务器实时校验会话。
- `ysu auth logout --forget`:清空会话并删除记住的密码。

**凭据存储**:`~/.config/ysu-cli/state.json`,目录权限 0700,文件权限 0600,原子写入。CLI 的任何输出(包括 `auth cookies`、错误信息、`--verbose` 日志)都不包含密码、token 或 cookie 值。

## 常用示例

```bash
ysu student info --json
ysu grades list --semester 2024-2025-1 --json
ysu grades gpa --json
ysu schedule courses --week 8 --json
ysu schedule week --json
ysu exams list --json
ysu school classrooms --campus 1 --building 3 --json --limit 50
ysu school classroom-schedule --code XXX --json
ysu plan completion --json
ysu labor summary --json
ysu credits records --all --json
ysu comprehensive result --year 2023-2024 --json
ysu ecard balance --json
ysu epay list --unpaid --json
ysu meter info --account 2021xxxxxxxx --json   # 电费,不需要登录
```

参数名以 `ysu <命令> --help` 或 `ysu schema --json` 为准。

## 写操作(默认 dry-run)

| 命令 | 作用 |
|---|---|
| `makeup signup --task-id T --batch-id B` | 报名补考 |
| `plan recalculate` | 重新计算培养方案完成情况 |
| `evaluation submit --input @answers.json` | 提交评教 |
| `signin sign --activity-id A --latitude .. --longitude ..` | 课堂签到 |
| `skbird mark / like / unlock --id N` | 森空鸟收藏、点赞、解锁(解锁可能消耗积分) |

不加 `--confirm` 时,命令以退出码 10 返回 `plan`(将要提交的内容),不会发出任何请求。

```bash
ysu evaluation pending --json
ysu evaluation detail --group-no ... --type ... --json          # 拿到题目
ysu evaluation score --input @answers.json --json   # 先预览分数(只读)
ysu evaluation submit --input @answers.json --json  # 退出码 10,检查 plan
ysu evaluation submit --input @answers.json --confirm --json
```

## 森空鸟

```bash
printf '%s' "$TOKEN" | ysu skbird config --token-stdin --json   # 或者 export YSU_SKBIRD_TOKEN=...
ysu skbird hot --json
ysu skbird search --query 高数 --json
ysu skbird thread --id 123 --json
```

## agent 推荐流程

1. 用 `ysu schema --json` 发现命令,用 `ysu capabilities --json` 查看支持的功能。
2. 运行 `ysu auth status --json`。未登录时向用户要学号和密码,走登录流程;退出码为 4 时把验证码或二维码给用户。
3. 读数据时总是加 `--json`,大列表配合 `--limit` 和 `--offset`。
4. 写操作先 dry-run,把 `plan` 给用户确认,再加 `--confirm`。
5. 根据退出码决定下一步:5 可以重试,3 先重新登录,9 要等待。

## 开发

```bash
pnpm test:cli        # CLI 单测:解析、退出码、dry-run、分页、权限、本地 HTTP 传输
pnpm cli:build
```

实现方式:

- `cli/build.mjs` 用 esbuild 打包,并把 Capacitor、secure-storage、sonner 替换为 `cli/shims/` 里的 Node 实现。
- `lib/cookie.ts` 新增 `setHttpTransport()`,让 Node 用原生 fetch 并手动处理 cookie 和重定向。
- 新增命令时在 `cli/commands.ts` 里加一条;`schema` 和 `--help` 会自动更新。
