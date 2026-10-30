/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 全部子命令:spec + 实现。实现只调用项目已有的 provider / 协议 / 客户端代码。
 */
import fs from "node:fs"
import type { ArgSpec, CommandSpec } from "./spec"

export interface Ctx {
  args: Record<string, any>
  provider(): Promise<any>
  /** 读取 / 写入 CLI 私有状态(0600 文件) */
  pending: { get(k: string): any; set(k: string, v: any): void; del(k: string): void }
  readSecret(name: string, flag?: string, env?: string): Promise<string | undefined>
}

export interface Command extends CommandSpec {
  run(ctx: Ctx): Promise<any>
  /** dry-run 时描述将要执行的操作 */
  plan?(ctx: Ctx): any
}

const s = (name: string, description: string, extra: Partial<ArgSpec> = {}): ArgSpec => ({ name, type: "string", description, ...extra })
const n = (name: string, description: string, extra: Partial<ArgSpec> = {}): ArgSpec => ({ name, type: "number", description, ...extra })
const b = (name: string, description: string, extra: Partial<ArgSpec> = {}): ArgSpec => ({ name, type: "boolean", description, ...extra })
const j = (name: string, description: string, extra: Partial<ArgSpec> = {}): ArgSpec => ({ name, type: "json", description, ...extra })

const semester = s("semester", "学年学期代码,如 2025-2026-1;缺省为当前学期")
const term = s("term", "学期(综合测评),如 1 / 2")
const year = s("year", "学年,如 2025-2026")

/** 选择性地只传非 undefined 的字段 */
function pick(args: Record<string, any>, map: Record<string, string>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [flag, key] of Object.entries(map)) if (args[flag] !== undefined) out[key] = args[flag]
  return out
}

async function P(ctx: Ctx) {
  return ctx.provider()
}

async function skbird(ctx: Ctx) {
  const { useSkbirdStore } = await import("@/lib/extras/skbird/store")
  await (useSkbirdStore as any).persist?.rehydrate?.()
  const st = useSkbirdStore.getState()
  const token = process.env.YSU_SKBIRD_TOKEN || st.token
  if (!token) {
    const { ProviderError, ProviderErrorCode } = await import("@/providers/errors")
    throw new ProviderError(ProviderErrorCode.AUTH_REQUIRED, "森空鸟 token 未配置", undefined, 401, {
      next: "ysu skbird config --token-stdin   (或设置环境变量 YSU_SKBIRD_TOKEN)",
    })
  }
  const { SkbirdClient } = await import("@/lib/extras/skbird/client")
  void ctx
  return new SkbirdClient({ token, deviceId: st.deviceId, alias: st.alias || "ysu" })
}

const mask = (v: string) => (v ? `${v.slice(0, 3)}…${v.slice(-2)} (${v.length} chars)` : "")

export const COMMANDS: Command[] = [
  // ───────────── 认证 ───────────── //
  {
    name: "auth status",
    summary: "本地登录状态;加 --check 向 CAS 实时校验",
    args: [b("check", "联网校验 CAS 会话是否仍有效")],
    async run(ctx) {
      const p = await P(ctx)
      const { useAuthStore } = await import("@/lib/stores/auth")
      const { loadRememberedCredentials } = await import("@/lib/storage/secure")
      const st = useAuthStore.getState()
      const remembered = await loadRememberedCredentials()
      const out: any = {
        authenticated: st.isAuthenticated,
        username: st.username,
        sessionExpired: st.sessionExpired,
        hasJwxtSession: !!st.jwxtSession,
        hasMobileSession: !!st.mobileSession,
        rememberedPassword: !!remembered,
        pendingLogin: ctx.pending.get("mfa") ? "mfa" : ctx.pending.get("wechat") ? "wechat" : null,
        school: p.id,
      }
      if (ctx.args.check) out.casValid = (await p.checkAuthStatus()).authenticated
      return out
    },
  },
  {
    name: "auth login",
    summary: "用学号+密码登录统一身份认证(CAS);需要验证码/二次认证时以退出码 4 返回下一步",
    args: [
      s("username", "学号/工号", { env: "YSU_USERNAME", required: true }),
      s("password", "密码(不推荐在命令行明文传,用 YSU_PASSWORD 或 --password-stdin)", { env: "YSU_PASSWORD", secret: true }),
      b("password-stdin", "从 stdin 读取密码"),
      s("captcha", "图形验证码(先用 `auth captcha --out x.png` 获取)", { env: "YSU_CAPTCHA" }),
      b("remember", "把密码保存到 0600 状态文件,会话过期时自动重登"),
    ],
    examples: ["YSU_PASSWORD=*** ysu auth login --username 2021xxxx --remember --json"],
    async run(ctx) {
      const p = await P(ctx)
      const password = await ctx.readSecret("password", "password-stdin", "YSU_PASSWORD")
      if (!password) throw usage("缺少密码:设置 YSU_PASSWORD 或使用 --password-stdin")
      const username = String(ctx.args.username)
      try {
        await p.login({ username, password, metadata: ctx.args.captcha ? { captcha: ctx.args.captcha } : {} })
      } catch (e: any) {
        if (e?.code === "AUTH_MFA_REQUIRED") {
          ctx.pending.set("mfa", { username, remember: !!ctx.args.remember, password: ctx.args.remember ? password : undefined })
          e.details = { ...(e.details ?? {}), next: `ysu auth mfa-request --method <${(e.details?.methods ?? ["sms"]).join("|")}>  然后  ysu auth mfa-submit --code <验证码>;或 ysu auth wechat-start` }
        }
        if (e?.code === "AUTH_CAPTCHA_REQUIRED") {
          e.details = { ...(e.details ?? {}), next: "ysu auth captcha --out /tmp/ysu-captcha.png  然后  ysu auth login ... --captcha <识别结果>" }
        }
        throw e
      }
      if (ctx.args.remember) {
        const { saveRememberedCredentials } = await import("@/lib/storage/secure")
        await saveRememberedCredentials(username, password)
      }
      ctx.pending.del("mfa")
      return { authenticated: true, username, remembered: !!ctx.args.remember }
    },
  },
  {
    name: "auth captcha",
    summary: "下载当前登录会话的图形验证码图片",
    args: [s("out", "保存路径(png/jpg)", { required: true })],
    async run(ctx) {
      const p = await P(ctx)
      await p.prepareLogin()
      const url = p.getCaptchaUrl()
      if (!url) throw notSupported("该学校无图形验证码")
      const { fetchWithJar } = await import("@/lib/cookie")
      const { getJar } = await import("@/providers/ysu/protocol/cas")
      const resp = await fetchWithJar(getJar(), { method: "GET", url: `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`, redirect: "follow", responseType: "arraybuffer" })
      const buf = Buffer.from(await resp.arrayBuffer())
      fs.writeFileSync(String(ctx.args.out), buf)
      return { path: String(ctx.args.out), bytes: buf.length, contentType: resp.headers["content-type"] ?? null }
    },
  },
  {
    name: "auth captcha-needed",
    summary: "查询某学号登录时是否需要图形验证码(只读)",
    args: [s("username", "学号", { env: "YSU_USERNAME", required: true })],
    async run(ctx) {
      const p = await P(ctx)
      await p.prepareLogin()
      return { username: ctx.args.username, captchaRequired: await p.checkCaptchaNeeded(String(ctx.args.username)) }
    },
  },
  {
    name: "auth mfa-methods",
    summary: "列出支持的二次认证方式",
    async run() {
      const { getYSUMfaMethods } = await import("@/providers/ysu/types")
      return { methods: [...getYSUMfaMethods()] }
    },
  },
  {
    name: "auth mfa-request",
    summary: "请求发送二次认证验证码(短信 / 今日校园 / 微信),挑战信息保存在本地状态",
    args: [s("method", "认证方式", { required: true, choices: ["sms", "cpdaily", "weixin"] }), s("username", "学号(缺省取上次 auth login)", { env: "YSU_USERNAME" })],
    async run(ctx) {
      const p = await P(ctx)
      const pend = ctx.pending.get("mfa") ?? {}
      const username = ctx.args.username ?? pend.username
      if (!username) throw usage("缺少 --username(或先执行 auth login)")
      const challenge = await p.requestMfaCode({ username, method: ctx.args.method })
      ctx.pending.set("mfa", { ...pend, username, challenge })
      return { sent: true, method: challenge.method, mobileHint: challenge.mobileHint, next: "ysu auth mfa-submit --code <验证码>" }
    },
  },
  {
    name: "auth mfa-submit",
    summary: "提交二次认证验证码,完成登录",
    args: [s("code", "收到的验证码", { required: true, env: "YSU_MFA_CODE" })],
    async run(ctx) {
      const p = await P(ctx)
      const pend = ctx.pending.get("mfa")
      if (!pend?.challenge) throw usage("没有待提交的二次认证:先执行 auth mfa-request")
      await p.submitMfaCode({ challenge: pend.challenge, code: String(ctx.args.code) })
      if (pend.remember && pend.password) {
        const { saveRememberedCredentials } = await import("@/lib/storage/secure")
        await saveRememberedCredentials(pend.username, pend.password)
      }
      ctx.pending.del("mfa")
      return { authenticated: true, username: pend.username, remembered: !!pend.remember }
    },
  },
  {
    name: "auth wechat-start",
    summary: "开始微信扫码二次认证,返回二维码图片 URL(交给用户扫码)",
    args: [s("out", "可选:把二维码图片保存到该路径")],
    async run(ctx) {
      const p = await P(ctx)
      const c = await p.initiateWechatMfa()
      ctx.pending.set("wechat", { uuid: c.uuid, state: c.state, last: undefined })
      let saved: string | undefined
      if (ctx.args.out) {
        const { fetchStateless } = await import("@/lib/cookie")
        const r = await fetchStateless({ method: "GET", url: c.qrImageUrl, redirect: "follow", responseType: "arraybuffer" })
        fs.writeFileSync(String(ctx.args.out), Buffer.from(await r.arrayBuffer()))
        saved = String(ctx.args.out)
      }
      return { qrImageUrl: c.qrImageUrl, savedTo: saved ?? null, next: "ysu auth wechat-poll --wait 120" }
    },
  },
  {
    name: "auth wechat-poll",
    summary: "轮询微信扫码状态;确认后自动完成登录",
    args: [n("wait", "最多等待秒数(0 = 只查一次)", { default: 0 })],
    async run(ctx) {
      const p = await P(ctx)
      const w = ctx.pending.get("wechat")
      if (!w?.uuid) throw usage("没有进行中的微信认证:先执行 auth wechat-start")
      const deadline = Date.now() + Number(ctx.args.wait ?? 0) * 1000
      let last = w.last
      for (;;) {
        const r = await p.pollWechatMfaQr(w.uuid, last)
        last = r.errcode
        ctx.pending.set("wechat", { ...w, last })
        if (r.status === "confirmed" && r.code) {
          await p.completeWechatMfa(r.code, w.state)
          ctx.pending.del("wechat")
          ctx.pending.del("mfa")
          const { useAuthStore } = await import("@/lib/stores/auth")
          return { status: "confirmed", authenticated: true, username: useAuthStore.getState().username }
        }
        if (r.status === "expired") { ctx.pending.del("wechat"); return { status: "expired", next: "ysu auth wechat-start" } }
        if (Date.now() >= deadline) return { status: r.status }
      }
    },
  },
  {
    name: "auth relogin",
    summary: "用已记住的密码重新登录",
    async run(ctx) {
      const p = await P(ctx)
      return { success: (await p.relogin?.()) ?? false }
    },
  },
  {
    name: "auth logout",
    summary: "退出登录并清空会话;--forget 同时删除记住的密码",
    args: [b("forget", "同时删除记住的密码")],
    async run(ctx) {
      const p = await P(ctx)
      await p.logout()
      if (ctx.args.forget) {
        const { clearRememberedCredentials } = await import("@/lib/storage/secure")
        await clearRememberedCredentials()
      }
      ctx.pending.del("mfa"); ctx.pending.del("wechat")
      return { loggedOut: true, forgotPassword: !!ctx.args.forget }
    },
  },
  {
    name: "auth cookies",
    summary: "诊断:列出 CAS / 教务会话 cookie 的名称、域、过期时间(不输出值)",
    async run(ctx) {
      const p = await P(ctx)
      const strip = (l: any[]) => l.map((c: any) => ({ name: c.name, domain: c.domain, path: c.path, expires: c.expires ?? null, hasValue: !!c.value }))
      return { auth: strip(await p.diagnostics.getAuthCookies()), academic: strip(await p.diagnostics.getAcademicCookies()) }
    },
  },

  // ───────────── 学生信息 ───────────── //
  { name: "student info", summary: "学籍/个人信息", auth: true, capability: "studentInfo", async run(ctx) { return (await P(ctx)).getStudentInfo() } },

  // ───────────── 成绩 ───────────── //
  {
    name: "grades list", summary: "成绩列表", auth: true, paged: true, capability: "grades",
    args: [semester, s("course-name", "按课程名过滤"), s("course-type", "按课程性质过滤"), n("page-size", "服务端分页大小"), n("page", "服务端页码(从 1 开始)")],
    examples: ["ysu grades list --semester 2024-2025-2 --json"],
    async run(ctx) { return (await P(ctx)).getGrades(pick(ctx.args, { semester: "semester", "course-name": "courseName", "course-type": "courseType", "page-size": "pageSize", page: "pageNumber" })) },
  },
  { name: "grades gpa", summary: "GPA 与学分统计", auth: true, capability: "gpa", args: [s("student-id", "学号(缺省为本人)")], async run(ctx) { return (await P(ctx)).getGPAStats(pick(ctx.args, { "student-id": "studentId" })) } },
  { name: "grades stats", summary: "单门课程成绩统计(平均分、最高分等)", auth: true, capability: "gradeAnalytics", args: [semester, s("class-id", "教学班 ID"), s("course-code", "课程号")], async run(ctx) { return (await P(ctx)).getGradeStatistics(pick(ctx.args, { semester: "semester", "class-id": "classId", "course-code": "courseCode" })) } },
  { name: "grades distribution", summary: "单门课程成绩分布", auth: true, paged: true, capability: "gradeAnalytics", args: [semester, s("class-id", "教学班 ID"), s("course-code", "课程号")], async run(ctx) { return (await P(ctx)).getGradeDistribution(pick(ctx.args, { semester: "semester", "class-id": "classId", "course-code": "courseCode" })) } },
  { name: "grades ranking", summary: "单门课程成绩排名", auth: true, capability: "gradeAnalytics", args: [semester, s("class-id", "教学班 ID"), s("course-code", "课程号"), s("student-id", "学号")], async run(ctx) { return (await P(ctx)).getGradeRanking(pick(ctx.args, { semester: "semester", "class-id": "classId", "course-code": "courseCode", "student-id": "studentId" })) } },

  // ───────────── 课表 / 校历 ───────────── //
  {
    name: "schedule courses", summary: "我的课表(可按周过滤,可合并实验课)", auth: true, paged: true, capability: "schedule",
    args: [n("week", "教学周"), semester, s("course-category", "课程类别"), b("include-lab", "合并实验课表")],
    async run(ctx) { return (await P(ctx)).getSchedule(pick(ctx.args, { week: "week", semester: "semester", "course-category": "courseCategory", "include-lab": "includeLabSchedule" })) },
  },
  { name: "schedule unscheduled", summary: "无固定时间的课程", auth: true, paged: true, capability: "schedule", args: [semester, s("course-category", "课程类别")], async run(ctx) { return (await P(ctx)).getUnscheduledCourses(pick(ctx.args, { semester: "semester", "course-category": "courseCategory" })) } },
  { name: "schedule periods", summary: "作息时间(每节课起止时间)", auth: true, paged: true, capability: "classPeriods", async run(ctx) { return (await P(ctx)).getClassPeriods() } },
  { name: "schedule calendar", summary: "学期校历(开学日期、周数)", auth: true, capability: "termCalendar", args: [semester], async run(ctx) { return (await P(ctx)).getTermCalendar(pick(ctx.args, { semester: "semester" })) } },
  { name: "schedule week", summary: "当前(或指定日期的)教学周", auth: true, capability: "currentWeek", args: [semester, s("date", "日期 YYYY-MM-DD")], async run(ctx) {
      const p = await P(ctx)
      const opts = pick(ctx.args, { semester: "semester", date: "date" })
      const [week, weekNumber] = await Promise.all([p.getCurrentWeek(opts), p.getCurrentWeekNumber(opts)])
      return { weekNumber, week }
    } },

  // ───────────── 考试 ───────────── //
  { name: "exams list", summary: "考试安排", auth: true, paged: true, capability: "exams", args: [semester], async run(ctx) { return (await P(ctx)).getExams(pick(ctx.args, { semester: "semester" })) } },
  { name: "makeup batches", summary: "补考/缓考报名批次", auth: true, paged: true, capability: "makeupExams", args: [semester], async run(ctx) { return (await P(ctx)).getMakeupExamBatches(pick(ctx.args, { semester: "semester" })) } },
  { name: "makeup courses", summary: "可报名 / 已报名的补考课程", auth: true, paged: true, capability: "makeupExams", args: [semester, s("batch-id", "批次 ID"), b("registered", "只看已报名")], async run(ctx) { return (await P(ctx)).getMakeupExamCourses(pick(ctx.args, { semester: "semester", "batch-id": "batchId", registered: "registered" })) } },
  {
    name: "makeup signup", summary: "报名补考(写操作)", auth: true, sideEffect: true, capability: "makeupExams",
    args: [s("task-id", "补考任务 ID(makeup courses 的 taskId)", { required: true }), s("batch-id", "批次 ID", { required: true })],
    plan: (ctx) => ({ action: "signupMakeupExam", input: { taskId: ctx.args["task-id"], batchId: ctx.args["batch-id"] } }),
    async run(ctx) { await (await P(ctx)).signupMakeupExam({ taskId: ctx.args["task-id"], batchId: ctx.args["batch-id"] }); return { signedUp: true } },
  },

  // ───────────── 劳动教育 ───────────── //
  { name: "labor records", summary: "劳动教育记录", auth: true, paged: true, capability: "laborEducation", async run(ctx) { return (await P(ctx)).getLaborRecords() } },
  { name: "labor summary", summary: "劳动教育学时汇总", auth: true, capability: "laborEducation", async run(ctx) { return (await P(ctx)).getLaborSummary() } },
  { name: "labor activities", summary: "可报名的劳动活动", auth: true, paged: true, capability: "laborEducation", async run(ctx) { return (await P(ctx)).getLaborActivities() } },

  // ───────────── 创新学分 ───────────── //
  { name: "credits batches", summary: "创新学分申报批次", auth: true, paged: true, capability: "innovationCredits", async run(ctx) { return (await P(ctx)).getCreditBatches() } },
  { name: "credits declarations", summary: "我的学分申报", auth: true, paged: true, capability: "innovationCredits", args: [s("batch-id", "批次 ID"), s("item-name", "项目名")], async run(ctx) { return (await P(ctx)).getCreditDeclarations(pick(ctx.args, { "batch-id": "batchId", "item-name": "itemName" })) } },
  { name: "credits records", summary: "学分记录;--all 取全部批次", auth: true, paged: true, capability: "innovationCredits", args: [s("batch-id", "批次 ID"), s("item-name", "项目名"), b("all", "全部批次")], async run(ctx) { const p = await P(ctx); return ctx.args.all ? p.getAllCreditRecords() : p.getCreditRecords(pick(ctx.args, { "batch-id": "batchId", "item-name": "itemName" })) } },
  { name: "credits summary", summary: "创新学分汇总", auth: true, capability: "innovationCredits", async run(ctx) { return (await P(ctx)).getCreditSummary() } },
  { name: "credits competitions", summary: "竞赛目录(服务端分页)", auth: true, capability: "innovationCredits", args: [s("keyword", "关键词"), n("page", "页码(pageIndex)")], async run(ctx) { return (await P(ctx)).getCreditCompetitions(pick(ctx.args, { keyword: "keyword", page: "pageIndex" })) } },
  { name: "credits library", summary: "图书馆活动目录(服务端分页)", auth: true, capability: "innovationCredits", args: [s("keyword", "关键词"), n("page", "页码(pageIndex)")], async run(ctx) { return (await P(ctx)).getCreditLibraryActivities(pick(ctx.args, { keyword: "keyword", page: "pageIndex" })) } },

  // ───────────── 综合测评 ───────────── //
  { name: "comprehensive terms", summary: "综合测评可查学期", auth: true, paged: true, capability: "comprehensiveEval", async run(ctx) { return (await P(ctx)).getComprehensiveTerms() } },
  { name: "comprehensive result", summary: "综合测评结果", auth: true, capability: "comprehensiveEval", args: [year, term], async run(ctx) { return (await P(ctx)).getComprehensiveResult(pick(ctx.args, { year: "year", term: "term" })) } },
  { name: "comprehensive indicators", summary: "综合测评指标明细", auth: true, paged: true, capability: "comprehensiveEval", args: [year, term], async run(ctx) { return (await P(ctx)).getComprehensiveIndicators(pick(ctx.args, { year: "year", term: "term" })) } },
  { name: "comprehensive radar", summary: "综合测评雷达图数据", auth: true, paged: true, capability: "comprehensiveEval", args: [year, term], async run(ctx) { return (await P(ctx)).getComprehensiveRadar(pick(ctx.args, { year: "year", term: "term" })) } },
  { name: "comprehensive year-scores", summary: "各学年综合测评分", auth: true, paged: true, capability: "comprehensiveEval", async run(ctx) { return (await P(ctx)).getComprehensiveYearScores() } },
  { name: "comprehensive report-years", summary: "可查综合测评报告的学年", auth: true, capability: "comprehensiveEval", async run(ctx) { return (await P(ctx)).getComprehensiveReportYears() } },
  { name: "comprehensive report", summary: "综合测评报告", auth: true, capability: "comprehensiveEval", args: [year], async run(ctx) { return (await P(ctx)).getComprehensiveReport(pick(ctx.args, { year: "year" })) } },

  // ───────────── 全校课表 / 教室 ───────────── //
  { name: "school grade-years", summary: "年级列表", auth: true, paged: true, capability: "schoolSchedule", async run(ctx) { return (await P(ctx)).getSchoolGradeYears() } },
  { name: "school departments", summary: "院系列表", auth: true, paged: true, capability: "schoolSchedule", async run(ctx) { return (await P(ctx)).getSchoolDepartments() } },
  { name: "school majors", summary: "专业列表", auth: true, paged: true, capability: "schoolSchedule", args: [s("department", "院系代码")], async run(ctx) { return (await P(ctx)).getSchoolMajors(ctx.args.department) } },
  { name: "school classes", summary: "班级列表", auth: true, paged: true, capability: "schoolSchedule", args: [semester, s("grade", "年级"), s("department", "院系代码"), s("major", "专业代码")], async run(ctx) { return (await P(ctx)).getSchoolClasses(pick(ctx.args, { semester: "semester", grade: "grade", department: "department", major: "major" })) } },
  { name: "school class-schedule", summary: "某班级课表", auth: true, paged: true, capability: "schoolSchedule", args: [s("class-id", "班级 ID", { required: true }), semester], async run(ctx) { return (await P(ctx)).getSchoolClassSchedule(ctx.args["class-id"], pick(ctx.args, { semester: "semester" })) } },
  { name: "school campuses", summary: "校区列表", auth: true, paged: true, capability: "schoolSchedule", async run(ctx) { return (await P(ctx)).getSchoolCampuses() } },
  { name: "school buildings", summary: "教学楼列表", auth: true, paged: true, capability: "schoolSchedule", args: [s("campus", "校区代码")], async run(ctx) { return (await P(ctx)).getSchoolBuildings(ctx.args.campus) } },
  { name: "school classrooms", summary: "教室列表", auth: true, paged: true, capability: "schoolSchedule", args: [semester, s("name", "教室名"), s("campus", "校区代码"), s("building", "教学楼代码")], async run(ctx) { return (await P(ctx)).getSchoolClassrooms(pick(ctx.args, { semester: "semester", name: "name", campus: "campus", building: "building" })) } },
  { name: "school classroom-schedule", summary: "某教室课表(空教室查询)", auth: true, paged: true, capability: "schoolSchedule", args: [s("code", "教室代码", { required: true }), semester], async run(ctx) { return (await P(ctx)).getSchoolClassroomSchedule(ctx.args.code, pick(ctx.args, { semester: "semester" })) } },

  // ───────────── 培养方案 / 学业 ───────────── //
  { name: "plan list", summary: "培养方案课程", auth: true, paged: true, capability: "trainingPlan", args: [n("page-size", "服务端分页大小"), n("page", "服务端页码")], async run(ctx) { return (await P(ctx)).getTrainingPlan(pick(ctx.args, { "page-size": "pageSize", page: "pageNumber" })) } },
  { name: "plan completion", summary: "学业完成情况(毕业要求进度)", auth: true, capability: "trainingPlan", async run(ctx) { return (await P(ctx)).getAcademicCompletion() } },
  {
    name: "plan recalculate", summary: "请求教务系统重新计算学业完成情况(会触发服务端计算)", auth: true, sideEffect: true, capability: "trainingPlan",
    plan: () => ({ action: "recalculateAcademicCompletion" }),
    async run(ctx) { const p = await P(ctx); if (!p.recalculateAcademicCompletion) throw notSupported("不支持重新计算"); return p.recalculateAcademicCompletion() },
  },
  { name: "plan warnings", summary: "学业预警", auth: true, paged: true, capability: "trainingPlan", async run(ctx) { return (await P(ctx)).getAcademicWarnings() } },

  // ───────────── 评教 ───────────── //
  { name: "evaluation types", summary: "评教类型", auth: true, paged: true, capability: "evaluation", args: [semester], async run(ctx) { return (await P(ctx)).getEvaluationTypes(pick(ctx.args, { semester: "semester" })) } },
  { name: "evaluation pending", summary: "某类型下待评教任务", auth: true, paged: true, capability: "evaluation", args: [s("type", "评教类型代码(evaluation types 的 code)", { required: true }), semester], async run(ctx) { return (await P(ctx)).getPendingEvaluations(ctx.args.type, pick(ctx.args, { semester: "semester" })) } },
  { name: "evaluation tasks", summary: "全部评教任务", auth: true, paged: true, capability: "evaluation", args: [semester], async run(ctx) { return (await P(ctx)).getEvaluationTasks(pick(ctx.args, { semester: "semester" })) } },
  { name: "evaluation detail", summary: "评教问卷详情(题目与选项)", auth: true, capability: "evaluation", args: [s("group-no", "任务 groupNo", { required: true }), s("type", "评教类型", { required: true }), n("sequence", "序号")], async run(ctx) { return (await P(ctx)).getEvaluationDetail({ groupNo: ctx.args["group-no"], evalType: ctx.args.type, ...pick(ctx.args, { sequence: "sequence" }) }) } },
  {
    name: "evaluation score", summary: "按答案预览评教得分(只计算不提交)", auth: true, capability: "evaluationScorePreview",
    args: [j("input", "EvaluationScoreInput JSON(或 @文件路径),字段:groupNo,wjid,evalType,answers[],teacherRelationId?,courseName?,teacherName?,sequence?", { required: true })],
    async run(ctx) { return (await P(ctx)).calculateEvaluationScore(ctx.args.input) },
  },
  {
    name: "evaluation submit", summary: "提交评教(写操作)", auth: true, sideEffect: true, capability: "evaluation",
    args: [j("input", "EvaluationSubmitInput JSON(或 @文件路径),同 evaluation score", { required: true })],
    plan: (ctx) => ({ action: "submitEvaluation", input: ctx.args.input }),
    async run(ctx) { await (await P(ctx)).submitEvaluation(ctx.args.input); return { submitted: true } },
  },

  // ───────────── 课堂签到(移动端) ───────────── //
  {
    name: "signin lesson", summary: "查询某节课的当前课堂(签到活动)", auth: true, capability: "mobileSignin",
    args: [s("teach-class-id", "教学班 ID", { required: true }), s("teach-class-type", "教学班类型", { required: true }), s("schedule-id", "排课 ID", { required: true }), n("week", "周", { required: true }), n("weekday", "星期 1-7", { required: true }), n("start", "开始节次", { required: true }), n("end", "结束节次", { required: true })],
    async run(ctx) {
      const p = await P(ctx); if (!p.mobile) throw notSupported("移动端签到不可用")
      const a = ctx.args
      return p.mobile.getCurrentLesson({ teachClassId: a["teach-class-id"], teachClassType: a["teach-class-type"], scheduleId: a["schedule-id"], week: a.week, weekDay: a.weekday, startNode: a.start, endNode: a.end })
    },
  },
  { name: "signin detail", summary: "签到活动详情", auth: true, capability: "mobileSignin", args: [s("activity-id", "签到活动 ID", { required: true })], async run(ctx) { const p = await P(ctx); if (!p.mobile) throw notSupported("移动端签到不可用"); return p.mobile.getSigninDetail({ activityId: ctx.args["activity-id"] }) } },
  { name: "signin status", summary: "我的签到状态", auth: true, capability: "mobileSignin", args: [s("activity-id", "签到活动 ID", { required: true })], async run(ctx) { const p = await P(ctx); if (!p.mobile) throw notSupported("移动端签到不可用"); return p.mobile.getStudentSigninStatus({ activityId: ctx.args["activity-id"] }) } },
  {
    name: "signin sign", summary: "执行签到(写操作;定位/签到码)", auth: true, sideEffect: true, capability: "mobileSignin",
    args: [s("activity-id", "签到活动 ID", { required: true }), n("latitude", "纬度"), n("longitude", "经度"), n("accuracy", "定位精度(米)"), s("code", "签到码")],
    plan: (ctx) => ({ action: "doStudentSign", input: { activityId: ctx.args["activity-id"], ...pick(ctx.args, { latitude: "latitude", longitude: "longitude", accuracy: "accuracy", code: "code" }) } }),
    async run(ctx) { const p = await P(ctx); if (!p.mobile) throw notSupported("移动端签到不可用"); return p.mobile.doStudentSign({ activityId: ctx.args["activity-id"], ...pick(ctx.args, { latitude: "latitude", longitude: "longitude", accuracy: "accuracy", code: "code" }) }) },
  },

  // ───────────── 校园缴费 / 一卡通 / 电费 ───────────── //
  { name: "ecard balance", summary: "一卡通余额", auth: true, capability: "ecard", async run(ctx) { await P(ctx); const { fetchEcardBalance } = await import("@/providers/ysu/ecard-access"); return fetchEcardBalance() } },
  {
    name: "epay list", summary: "校园缴费记录(含待缴)", auth: true, capability: "epay", args: [b("unpaid", "只返回待缴记录")],
    async run(ctx) { await P(ctx); const { fetchEpayPayments } = await import("@/providers/ysu/epay-access"); const r: any = await fetchEpayPayments(); return ctx.args.unpaid ? (r.unpaid ?? r.pending ?? []) : r },
  },
  {
    name: "meter info", summary: "宿舍空调电表:房间、余额、近 30 天用电、充值记录(17wanxiao,凭学号,无需教务会话)", capability: "meter",
    args: [s("account", "学号(缺省为当前登录用户)", { env: "YSU_USERNAME" })],
    async run(ctx) {
      await P(ctx)
      const { useAuthStore } = await import("@/lib/stores/auth")
      const account = ctx.args.account ?? useAuthStore.getState().username
      if (!account) throw usage("缺少 --account(或先登录)")
      const { fetchMeterData } = await import("@/lib/fees/meter/client")
      return fetchMeterData(String(account))
    },
  },

  // ───────────── 森空鸟(校园社区,玩具箱) ───────────── //
  {
    name: "skbird config", summary: "配置森空鸟 token / deviceId / 校区别名(token 只保存不回显)",
    args: [b("token-stdin", "从 stdin 读取 token"), s("token", "token(推荐用 YSU_SKBIRD_TOKEN 或 --token-stdin)", { env: "YSU_SKBIRD_TOKEN", secret: true }), s("device-id", "设备 ID(缺省保持/随机生成)"), s("alias", "校区别名", { default: undefined }), b("clear", "清除 token")],
    async run(ctx) {
      const { useSkbirdStore } = await import("@/lib/extras/skbird/store")
      await (useSkbirdStore as any).persist?.rehydrate?.()
      const st = useSkbirdStore.getState()
      let token = ctx.args.clear ? "" : (await ctx.readSecret("token", "token-stdin", "YSU_SKBIRD_TOKEN")) ?? st.token
      token = token ?? ""
      st.setConfig({ token, deviceId: ctx.args["device-id"] ?? st.deviceId, alias: ctx.args.alias ?? st.alias })
      await new Promise((r) => setTimeout(r, 50))
      const now = useSkbirdStore.getState()
      return { tokenConfigured: !!now.token, token: mask(now.token), deviceId: now.deviceId, alias: now.alias }
    },
  },
  { name: "skbird hot", summary: "热帖", paged: true, args: [n("count", "条数", { default: 10 }), n("type", "热度类型", { default: 3 })], async run(ctx) { return (await skbird(ctx)).hot(ctx.args.count ?? 10, ctx.args.type ?? 3) } },
  { name: "skbird toplist", summary: "置顶/榜单", paged: true, async run(ctx) { return (await skbird(ctx)).toplist() } },
  { name: "skbird latest", summary: "最新帖子(时间游标分页:--from-time 取上一页最后一条的时间)", paged: true, args: [s("from-time", "时间游标", { default: "0" }), s("category", "分类 ID", { default: "latest" })], async run(ctx) { return (await skbird(ctx)).latest(ctx.args["from-time"] ?? "0", ctx.args.category ?? "latest") } },
  { name: "skbird rewards", summary: "悬赏帖", paged: true, args: [s("from-time", "时间游标", { default: "0" })], async run(ctx) { return (await skbird(ctx)).rewardList(ctx.args["from-time"] ?? "0") } },
  { name: "skbird categories", summary: "分类列表", paged: true, async run(ctx) { return (await skbird(ctx)).categories() } },
  { name: "skbird search-options", summary: "搜索热词", paged: true, async run(ctx) { return (await skbird(ctx)).searchOptions() } },
  { name: "skbird search", summary: "搜索帖子", paged: true, args: [s("query", "关键词", { required: true }), n("page", "页码", { default: 1 }), s("range", "范围")], async run(ctx) { return (await skbird(ctx)).search(ctx.args.query, ctx.args.page ?? 1, ctx.args.range ?? "") } },
  { name: "skbird thread", summary: "帖子详情", args: [s("id", "帖子 ID", { required: true })], async run(ctx) { return (await skbird(ctx)).thread(ctx.args.id) } },
  { name: "skbird comments", summary: "帖子评论(自动先取 commentSign)", paged: true, args: [s("id", "帖子 ID", { required: true })], async run(ctx) { const c = await skbird(ctx); const d = await c.thread(ctx.args.id); return c.comments(ctx.args.id, d.commentSign) } },
  { name: "skbird marks", summary: "我的收藏", paged: true, async run(ctx) { return (await skbird(ctx)).markList() } },
  { name: "skbird user", summary: "我的信息(可用于校验 token)", async run(ctx) { return (await skbird(ctx)).userInfo() } },
  { name: "skbird stats", summary: "我的统计", async run(ctx) { return (await skbird(ctx)).userStats() } },
  { name: "skbird messages", summary: "消息列表", paged: true, args: [s("from-time", "时间游标", { default: "0" }), b("new", "只取新消息")], async run(ctx) { const c = await skbird(ctx); return ctx.args.new ? c.newMessages(ctx.args["from-time"] ?? "0") : c.messages(ctx.args["from-time"] ?? "0") } },
  { name: "skbird unread", summary: "未读数", async run(ctx) { return (await skbird(ctx)).unreadNum() } },
  { name: "skbird like-stat", summary: "获赞统计", async run(ctx) { return (await skbird(ctx)).likeStat() } },
  {
    name: "skbird mark", summary: "收藏 / 取消收藏(写操作)", sideEffect: true, args: [s("id", "帖子 ID", { required: true }), b("remove", "取消收藏")],
    plan: (ctx) => ({ action: "mark", id: ctx.args.id, op: ctx.args.remove ? "unmark" : "mark" }),
    async run(ctx) { await (await skbird(ctx)).mark(ctx.args.id, ctx.args.remove ? 2 : 1); return { ok: true } },
  },
  {
    name: "skbird like", summary: "点赞 / 取消点赞(写操作)", sideEffect: true, args: [s("id", "帖子 ID", { required: true }), s("comment-id", "评论 ID(给评论点赞)", { default: "0" }), b("remove", "取消点赞")],
    plan: (ctx) => ({ action: "like", id: ctx.args.id, commentId: ctx.args["comment-id"] ?? "0", op: ctx.args.remove ? "unlike" : "like" }),
    async run(ctx) { await (await skbird(ctx)).like(ctx.args.id, ctx.args.remove ? 0 : 1, ctx.args["comment-id"] ?? "0"); return { ok: true } },
  },
  {
    name: "skbird unlock", summary: "解锁被折叠的帖子全文(可能临时收藏再取消,写操作)", sideEffect: true, args: [s("id", "帖子 ID", { required: true })],
    plan: (ctx) => ({ action: "unlockThread", id: ctx.args.id, note: "热帖/悬赏中找不到时会 mark→读收藏→unmark" }),
    async run(ctx) { return (await skbird(ctx)).unlockThread(ctx.args.id) },
  },

  // ───────────── 元信息 ───────────── //
  { name: "capabilities", summary: "当前学校后端支持的功能", async run(ctx) { const p = await P(ctx); const { getEnabledCapabilities } = await import("@/providers/capabilities"); return { school: p.id, name: p.name, enabled: getEnabledCapabilities(p.capabilities), all: p.capabilities } } },
]

export function usage(message: string): Error {
  const e: any = new Error(message)
  e.code = "USAGE"
  return e
}
export function notSupported(message: string): Error {
  const e: any = new Error(message)
  e.code = "FEATURE_NOT_SUPPORTED"
  return e
}
