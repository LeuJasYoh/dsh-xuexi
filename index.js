// dsh-chaoxing —— 学习通自动化插件
//
// ═══════════════════════════════════════════════════════════════════════════
//  ★ 铁律：工具里不允许有任何业务判断
// ═══════════════════════════════════════════════════════════════════════════
//
// 用户的原话：
//   「学习通千变万化，单纯使用脚本增加分支逻辑，永远不可能解决所有的边界情况，
//     只有加入大模型这个大脑才能解决所有的问题。」
//
// 所以本文件的分工是**绝对的**：
//
//   脚本（lib/）= 传感器 + 执行器
//     · observe.mjs   只"看"：把页面上有什么如实读出来
//     · act.mjs       只"做"：执行一个明确动作
//     · inventory.mjs 把"看"的结果整理成"这一页有什么"
//
//   大模型 = 唯一的决策者
//     · 决定进哪个章节、翻到哪一页
//     · 决定这一页先做哪个任务点、用什么方式做
//     · 决定遇到不确定的东西怎么办
//
// 每个工具**要么报告事实，要么执行一个明确指令**。
// 没有一个工具含 "if 是视频就…else if 是测验就…else 不处理" 这种分支。
//
// 工具清单（9 个）：
//   看：cx_open  cx_courses  cx_chapters  cx_enter  cx_page  cx_shot  cx_progress
//   做：cx_tab   cx_do

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { launchBrowser, ensureWorkTab, listPages } from './lib/browser.mjs'
import * as OBS from './lib/observe.mjs'
import * as ACT from './lib/act.mjs'
import { inventory, inventoryAll } from './lib/inventory.mjs'
import * as ST from './lib/state.mjs'

export const name = 'dsh-chaoxing'

// 只把 tools 作为硬依赖。systemPrompt 运行时软获取（见 apply）：
// 注册表挂载预设时会审计每一行，任何一行启动失败都会让整个预设被标记「加载失败」，
// 所以本插件绝不能成为那个单点故障。
export const inject = ['tools']

const PROMPT_PATH = new URL('./prompts/chaoxing-mode.md', import.meta.url)
const PROMPT_TEXT = readFileSync(PROMPT_PATH, 'utf8')
  .replace(/\{\{(?!(?:cwd|model|provider)\}\})/g, '{ {')

const DEFAULT_PORT = 9222
const DEFAULT_PROFILE = ST.STATE_DIR.replace(/\\/g, '/') + '/browser-profile'

// ── 会话句柄（纯基建，不含任何业务判断）────────────────────────────────────
let session = { browser: null, work: null, course: null, section: null, tabs: [], tree: null, treeAt: 0 }
let running = false   // 串行闸门：学习通禁止同账号并行

/**
 * 取章节树（带缓存）。
 *
 * 为什么要缓存：readChapterTree 每次都会 goto 章节列表页并重新解析
 * —— 一次 cx_enter 要重载两个页面（课程页 + 章节列表页），实测约 30 秒。
 * 而「chapterId ↔ 小节」这个映射**不会变**，没有理由每次都重读。
 *
 * ⚠️ 缓存的只有**结构**，进度数字会随着刷课变化 —— 所以返回里会标 __cached，
 *    并且 cx_chapters 每次都强制重读（看进度必须新鲜）。
 */
async function getTree(work, course, { force = false, maxAgeMs = 30 * 60_000 } = {}) {
  const fresh = session.tree
    && session.tree.courseName === course.name
    && Date.now() - session.treeAt < maxAgeMs
  if (!force && fresh) return { ...session.tree.data, __cached: true, __cachedAgeMs: Date.now() - session.treeAt }

  const tree = await OBS.readChapterTree(work, course)
  session.tree = { courseName: course.name, data: tree }
  session.treeAt = Date.now()
  return tree
}

async function getWork(ctx, { relaunch = false } = {}) {
  if (!relaunch && session.browser && session.work) {
    try {
      await listPages(session.browser)
      // ⚠️ 光确认"浏览器还在"不够 —— 浏览器活着**不代表页面会话没死**。
      //
      //    实测事故：CDP session 失效后 listPages 照样成功（它是浏览器级命令），
      //    于是每次都把同一个**死句柄**返回出去，每一条命令都报
      //    "Session with given id not found"，连 cx_open 都救不回来。
      //
      //    现在多做一次页面级存活探测：底层会顺手重连一次，重连还失败才重建句柄。
      if (await session.work.alive()) return session.work
      session.work = null
    } catch { session.browser = null; session.work = null }
  }
  const state = ST.loadState()
  const browser = await launchBrowser({
    port: state.browser?.port ?? DEFAULT_PORT,
    profileDir: state.browser?.profileDir ?? DEFAULT_PROFILE,
  })
  const work = await ensureWorkTab(browser, { targetId: relaunch ? null : state.browser?.workTargetId })
  // 每次都把实际用的标签页写回状态：
  // ensureWorkTab 可能复用了"用户正在用的那一页"（而不是记录里的旧 id），
  // 不同步的话下次又会找错。
  if (state.browser?.workTargetId !== work.targetId) {
    state.browser = {
      port: state.browser?.port ?? DEFAULT_PORT,
      profileDir: state.browser?.profileDir ?? DEFAULT_PROFILE,
      workTargetId: work.targetId,
    }
    ST.saveState(state)
  }
  session.browser = browser
  session.work = work
  return work
}

const objOut = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

/** 串行闸门的统一包装：任何"做"的动作都不允许并发 */
function serial(fn) {
  return async (args) => {
    if (running) return { ok: false, error: 'BUSY', hint: '已有任务在跑。学习通禁止同账号并行，请等它结束。' }
    running = true
    try { return await fn(args) }
    finally { running = false }
  }
}

/** 截图存盘 —— cx_shot 和 cx_do(read) 共用，避免两处逻辑漂移 */
async function takeShot(work, { full = false, label = 'shot', clip = null } = {}) {
  const buf = clip
    ? await work.screenshot({ clip })
    : (full ? await work.screenshotFull() : await work.screenshot())
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safe = String(label).replace(/[^\w.-]+/g, '_')
  // ★ 截图是**过程文件**，落在工作区的 .chaoxing/shots/ 里，跟这次对话在一起
  const dir = ST.shotsDir()
  mkdirSync(dir, { recursive: true })
  const file = `${dir}\\chaoxing-${safe}-${stamp}.png`
  writeFileSync(file, buf)
  return { file, bytes: buf.length }
}

/**
 * 把返回值清洗成「无损 JSON」。
 *
 * 为什么必须有：DSH 会校验工具返回值能否**无损**转成 JSON，不能就整个调用失败，
 * 报 `tool "cx_xxx" returned invalid output: value is not lossless JSON`。
 *
 * JS 里有一堆东西 JSON 表达不了：`undefined`、`NaN`、`Infinity`、函数、Symbol、BigInt、Date…
 * 只要返回对象里**任何一个字段**踩到，整条工具调用就废了 ——
 * 实测事故里 `remaining: undefined` 就是这么把 cx_courses 彻底打死的。
 *
 * 与其逐个字段去防，不如在出口统一清洗一次。
 */
function toLossless(v, seen = new Set()) {
  if (v === null || v === undefined) return null
  const t = typeof v
  if (t === 'string' || t === 'boolean') return v
  if (t === 'number') return Number.isFinite(v) ? v : null
  if (t === 'bigint') return v.toString()
  if (t === 'function' || t === 'symbol') return null
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer?.(v)) return `[Buffer ${v.length} B]`
  if (t === 'object') {
    if (seen.has(v)) return '[循环引用]'
    seen.add(v)
    try {
      if (Array.isArray(v)) return v.map((x) => toLossless(x, seen))
      const out = {}
      for (const [k, x] of Object.entries(v)) out[k] = toLossless(x, seen)
      return out
    } finally { seen.delete(v) }
  }
  return String(v)
}

export function apply(ctx, config = {}) {
  const port = config.port ?? DEFAULT_PORT

  /**
   * 这次会话的工作区在哪？
   *
   * 链路（查过 DSH 的 Service 契约确认的）：
   *   ToolDefinition.execute(args, exec: ToolRunContext)
   *     exec.agent.id                          → SessionId
   *     ctx.sessions.get(id).header.cwd        → ★ 工作区绝对路径
   *
   * 拿到之后，过程文件（截图/进度）就落在 <工作区>/.chaoxing/ 里，
   * 而不是乱丢到用户家目录。
   *
   * ⚠️ 全程 try/catch —— 预设作用域的 ctx 未必能拿到 host 服务，
   *    拿不到就退回机器目录，绝不让它成为故障点。
   */
  const _dirBySession = new Map()
  function applyOutputDir(exec) {
    try {
      const id = exec?.agent?.id
      if (id && _dirBySession.has(id)) { ST.setOutputDir(_dirBySession.get(id), { isWorkspace: true }); return }
      const cwd = id ? (ctx.get?.('sessions')?.get?.(id)?.header?.cwd ?? null) : null
      const dir = ST.resolveOutputDir(cwd)
      if (id) _dirBySession.set(id, dir)
      ST.setOutputDir(dir, { isWorkspace: Boolean(cwd) })
    } catch { /* 退回默认目录，不影响功能 */ }
  }

  // ── 系统提示词（软获取，拿不到只警告，不让整个预设挂掉）──────────────────
  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt?.section) {
    ctx.effect(() => systemPrompt.section({ name: 'chaoxing:mode-prompt', order: 120, text: PROMPT_TEXT }))
  } else {
    const warn = ctx.logger?.warn?.bind(ctx.logger) ?? console.warn
    warn('[dsh-chaoxing] systemPrompt 不可用，模式提示词未注入（工具仍可用）')
  }

  // ── 主脑闸门：★ 浏览器工具只允许「主脑」一个 Agent 操作 ──────────────────
  //
  // 为什么必须有（用户定的）：
  //   学习通**禁止同账号并行**。如果主脑开的子智能体也能调 cx_click / cx_do，
  //   两个 Agent 同时动同一个浏览器 → 切页互相打断、播放被打断、状态彻底错乱。
  //   所以"只有主脑能碰浏览器"必须是**结构约束**，不能只靠提示词求它自觉。
  //
  // 判定方式用**结构**而不是记 ID（记 ID 在换会话后会失效、把主脑也挡住）：
  //   ctx.agents.isOwnedBy(agentId, other)  —— 这个 agent 是不是 other 的子体？
  //   是子体 → 不是主脑 → 拒绝。
  //
  // 子智能体不需要 cx_* 里的任何东西：
  //   读图用全局工具 read_image；需要更清楚的截图就反馈给主脑（见提示词的判题员协议）。
  function isSubagent(agentId) {
    if (!agentId) return null
    try {
      const agents = ctx.get?.('agents')
      if (!agents?.list || !agents?.isOwnedBy) return null   // 判断不了
      for (const a of agents.list()) {
        if (a.id === agentId) continue
        try { if (agents.isOwnedBy(agentId, a)) return true } catch { /* 这一条查不动，继续 */ }
      }
      return false
    } catch { return null }
  }

  // 判断不了时的退路：先到先得。cx_open 会重新认领，所以换会话不会把自己锁死。
  let fallbackOwner = null

  const DENY_MSG = {
    ok: false,
    error: 'NOT_THE_COMMANDER',
    hint: '浏览器只能由「主脑」一个 Agent 操作 —— 学习通禁止同账号并行，'
      + '多个 Agent 同时动浏览器会互相打断、状态错乱。\n'
      + '如果你是子智能体（判题员）：你不该调用任何 cx_* 工具。'
      + '你的活只是 read_image 读图判题，然后返回 JSON；'
      + '需要更清楚的截图就返回 {"__need_shot": ["第3题"]}，由主脑去截。',
  }

  function commanderGuard(def, exec) {
    const id = exec?.agent?.id
    if (!id) return null                      // 不是 Agent 调的（测试脚本等）→ 放行
    const sub = isSubagent(id)
    if (sub === true) return DENY_MSG
    if (sub === null) {                       // 结构判断不可用 → 先到先得
      if (fallbackOwner && fallbackOwner !== id) return DENY_MSG
      if (!fallbackOwner) fallbackOwner = id
    }
    return null
  }

  // 统一入口：每次工具调用先做两件事 ——
  //   ① 按当前会话 cwd 定位过程文件目录（截图/进度落工作区）
  //   ② 主脑闸门（子智能体不许碰浏览器）
  // 这样"文件放哪"和"谁能动浏览器"都只在一处决定。
  const reg = (def) => ctx.effect(() => ctx.tools.register({
    ...def,
    output: objOut,
    execute: async (args, exec) => {
      applyOutputDir(exec)
      const denied = commanderGuard(def, exec)
      if (denied) return denied
      if (def.name === 'cx_open') fallbackOwner = exec?.agent?.id ?? fallbackOwner
      // ★ 出口统一清洗：任何 undefined / NaN / Infinity / 函数 都会让
      //   DSH 判 "value is not lossless JSON" 而整条失败，这里一次性兜住。
      return toLossless(await def.execute(args, exec))
    },
  }))

  // ═════════════════════════════════════════════════════════════════════════
  //  看
  // ═════════════════════════════════════════════════════════════════════════

  reg({
    name: 'cx_open',
    description: '接管自动化浏览器并打开学习通。返回登录状态。未登录时请用户扫码（绝不代填账号密码）。幂等。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    async execute() {
      const work = await getWork(ctx)
      await work.goto(OBS.HOME_URL, { timeoutMs: 30_000 })
      const loggedIn = await OBS.isLoggedIn(work)
      return {
        ok: true, port, loggedIn,
        url: await work.eval('location.href').catch(() => null),
        next: loggedIn ? '已登录 → cx_courses 列课程' : '请在浏览器窗口用学习通 App 扫码，登录后再调一次 cx_open',
      }
    },
  })

  reg({
    name: 'cx_courses',
    description: '列出账号里的课程及每门课的权威进度（已完成任务点 X/Y）。只读。把清单给用户，由用户决定刷哪门。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    async execute() {
      const work = await getWork(ctx)
      if (!(await OBS.isLoggedIn(work))) return { ok: false, error: 'NOT_LOGGED_IN' }
      await work.goto(OBS.HOME_URL, { timeoutMs: 30_000 })
      const load = await OBS.waitForCourseListStable(work)
      const courses = await OBS.readCourseList(work)
      return {
        ok: true, listLoad: load,
        courses: courses.map((c) => ({
          name: c.name, teacher: c.teacher, courseId: c.courseId, clazzId: c.clazzId,
          done: c.done, total: c.total, percent: c.percent,
          // ⚠️ 这行原来写的是 `remaining: c.remaining`，但 readCourseList 根本不返回
          //    这个字段 → 值是 undefined → DSH 直接拒绝：
          //    "tool cx_courses returned invalid output: value is not lossless JSON"。
          //    实测事故里这就是第一块倒下的多米诺骨牌（连课程都列不出来）。
          remaining: (typeof c.total === 'number' && typeof c.done === 'number')
            ? Math.max(0, c.total - c.done)
            : null,
        })),
      }
    },
  })

  reg({
    name: 'cx_chapters',
    description:
      '列出某门课的章节结构：每个单元、每个小节，以及小节上显示的剩余任务点数（页面徽章）。' +
      '★ 用它找到「还有没做完的章节」，然后 cx_enter 进去。只读，不改变任何状态。' +
      '注意：徽章是页面加载时的数，可能滞后；最权威的是进章节后页面头部的「已完成任务点 X/Y」。',
    parameters: {
      type: 'object',
      properties: { course: { type: 'string', description: '课程名（cx_courses 返回的 name）' } },
      required: ['course'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute({ course: courseName } = {}) {
      const work = await getWork(ctx)
      if (!(await OBS.isLoggedIn(work))) return { ok: false, error: 'NOT_LOGGED_IN' }

      await work.goto(OBS.HOME_URL, { timeoutMs: 30_000 })
      const all = await OBS.readCourseList(work)
      const course = all.find((c) => c.name === courseName)
      if (!course) return { ok: false, error: 'COURSE_NOT_FOUND', available: all.map((c) => c.name) }

      let tree
      try { tree = await getTree(work, course, { force: true }) }
      catch (e) { return { ok: false, error: e.code ?? 'CHAPTERS_FAILED', message: e.message } }

      session.course = course
      return {
        ok: true,
        course: { name: course.name, courseId: course.courseId, clazzId: course.clazzId, progress: tree.progress.raw },
        units: tree.units.map((u, ui) => ({
          unitIndex: ui + 1, unit: u.unit,
          sections: u.sections.map((s, si) => ({
            i: si + 1, title: s.title, chapterId: s.chapterId,
            badgeRemaining: s.jobCount ?? null,
          })),
        })),
        next: '挑一个还有剩余的小节 → cx_enter({ course, chapterId })。★ 同名小节很多，用 chapterId 最稳。',
      }
    },
  })

  reg({
    name: 'cx_enter',
    description:
      '进入指定课程的某个小节，返回这一小节的页面(tab)列表。\n' +
      '指定小节有两种方式：\n' +
      '  · chapterId —— ★ 推荐，精确无歧义（cx_chapters 会给出）\n' +
      '  · section   —— 标题（模糊匹配）或序号（从 1 开始）\n' +
      '★ 循环的第一步：决定进哪个小节 → 拿到页面列表 → cx_page({all:true}) 看清全节。\n' +
      '只进入并读取，不播放、不提交。',
    parameters: {
      type: 'object',
      properties: {
        course: { type: 'string', description: '课程名（可省略，会用上一次进入的课程）' },
        section: { type: 'string', description: '小节标题（模糊匹配）或序号' },
        chapterId: { type: 'string', description: '★ 推荐：小节的 chapterId，精确且不受同名影响' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    async execute({ course: courseName, section: want, chapterId } = {}) {
      const work = await getWork(ctx)
      if (!(await OBS.isLoggedIn(work))) return { ok: false, error: 'NOT_LOGGED_IN' }

      // ── 课程：优先用上次的，避免每次重载课程列表页 ───────────────────────
      let course = session.course
      if (!course || (courseName && course.name !== courseName)) {
        await work.goto(OBS.HOME_URL, { timeoutMs: 30_000 })
        const all = await OBS.readCourseList(work)
        course = courseName
          ? all.find((c) => c.name === courseName)
          : (all.find((c) => c.name === session.course?.name) ?? all[0])
        if (!course) return { ok: false, error: 'COURSE_NOT_FOUND', available: all.map((c) => c.name) }
        session.course = course
      }

      // ── 章节树：缓存 30 分钟 ────────────────────────────────────────────
      // chapterId ↔ 小节 的对应关系不会变，所以久一点无所谓；
      // 但进度数字会变，所以返回里标明"这是缓存"。
      const tree = await getTree(work, course)

      const flat = tree.units.flatMap((u) => u.sections.map((s) => ({ ...s, unit: u.unit })))
      let section = null

      if (chapterId) {
        // ★ 直通：用 chapterId 精确定位，不看标题
        section = flat.find((s) => String(s.chapterId) === String(chapterId))
        if (!section) {
          // 缓存里没有（可能是新加的章节）→ 强制重读一次
          const fresh = await getTree(work, course, { force: true })
          const flat2 = fresh.units.flatMap((u) => u.sections.map((s) => ({ ...s, unit: u.unit })))
          section = flat2.find((s) => String(s.chapterId) === String(chapterId))
          if (!section) {
            return {
              ok: false, error: 'SECTION_NOT_FOUND', chapterId,
              hint: '章节树里没有这个 chapterId。用 cx_chapters 重新看一遍。',
              sections: flat2.map((s) => ({ title: s.title, chapterId: s.chapterId })),
            }
          }
        }
      } else if (want != null && want !== '') {
        const isIndex = /^\d+$/.test(String(want))
        if (isIndex) {
          section = flat[Number(want) - 1]
        } else {
          const hits = flat.filter((s) => s.title.includes(String(want)) || String(want).includes(s.title))
          if (hits.length > 1) {
            // ★ 同名小节：**把歧义摆到台面上**，而不是静默挑第一个
            //   实测：医学英语 1.1 和 1.2 标题完全一样，静默选中就是错的。
            return {
              ok: false, error: 'SECTION_AMBIGUOUS',
              hint: `有 ${hits.length} 个小节都匹配「${want}」，标题一样，请用 chapterId 指定。`,
              candidates: hits.map((s) => ({
                title: s.title, chapterId: s.chapterId, unit: s.unit,
                badgeRemaining: s.jobCount ?? null, domId: s.domId ?? null,
              })),
            }
          }
          section = hits[0] ?? null
        }
      }

      if (!section) {
        return {
          ok: false, error: 'SECTION_NOT_FOUND',
          hint: want != null ? `没找到「${want}」` : '请给 section 或 chapterId',
          sections: flat.map((s, i) => ({ i: i + 1, unit: s.unit, title: s.title, chapterId: s.chapterId })),
        }
      }

      await work.goto(OBS.chapterListUrl(course), { timeoutMs: 30_000 })
      await work.waitFor(`document.querySelectorAll('.chapter_item[id]').length > 0`, { timeoutMs: 20_000 })
      await ACT.enterSection(work, course, section)
      const tabs = await OBS.readTabs(work)

      session.course = course
      session.section = section
      session.tabs = tabs

      return {
        ok: true,
        course: course.name,
        section: { title: section.title, chapterId: section.chapterId, unit: section.unit },
        tabs: tabs.map((t, i) => ({ i, title: t.title, cardid: t.cardid })),
        next: 'cx_tab({ i: 0 }) 翻到第一页并看这一页有什么',
      }
    },
  })

  reg({
    name: 'cx_page',
    description:
      '★ 核心：如实报告**当前这一页**上有哪些任务点、各是什么类型、各自什么状态。\n' +
      '一个页面(tab)**可以有多个任务点** —— 实测：视频页常常同时挂一个章节测验；' +
      '听力页同时挂音频 + 听力练习。所以不要假设一页只有一个任务点。\n' +
      '返回 items 列表，每项有 key（跨页唯一，如 "2:1"）和 t（本页内编号）。\n' +
      '**默认不带参数：只报当前这一页（快）。**\n' +
      '`all: true`：走遍这一节的**所有页面**，一次报告整节 —— 4 个页面就是 1 次调用而不是 4 次。\n' +
      '★ 建议：每进一个新小节，先 `cx_page({all:true})` 看清全貌，再决定先做哪个。',
    parameters: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: 'true = 报告整节所有页面（每个页面各翻一次，几秒）；默认 false = 只报当前页',
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute({ all = false } = {}) {
      const work = await getWork(ctx)
      const tabs = await OBS.readTabs(work).catch(() => session.tabs ?? null)
      if (all) return { ok: true, ...(await inventoryAll(work, { tabs })) }
      return { ok: true, ...(await inventory(work, { tabs })) }
    },
  })

  reg({
    name: 'cx_shot',
    description: '给当前页面截图，返回 PNG 路径（DSH 会自动显示图片）。截图落在**当前工作区**的 .chaoxing/shots/ 里。' +
      '⚠️ 学习通按页面类型做反扒混淆（独立作业页连**选项**都会乱码），所以 DOM 里的中文一律不可信 —— ' +
      '**要读懂题目文字（题干和选项）必须用截图**。',
    parameters: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: '是否整页截图，默认 false（可视区）' },
        label: { type: 'string', description: '文件名标签' },
        clip: {
          type: 'object',
          description: '★ 只截一块 —— 用于"题目看不清"：子智能体反馈某题看不清时，' +
            '用 cx_dom 或截图量出那道题的坐标，只截那块，清晰度会高很多。' +
            '形如 {"x":100,"y":600,"width":900,"height":300}（CSS 像素）',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute({ full = false, label = 'shot', clip = null } = {}) {
      const work = await getWork(ctx)
      const shot = await takeShot(work, { full, label, clip })
      return {
        ok: true, ...shot,
        url: await work.eval('location.href').catch(() => null),
        hint: `把路径 ${shot.file} 直接给用户看（DSH 会自动显示图片）。`,
      }
    },
  })

  reg({
    name: 'cx_progress',
    description:
      '读取本地进度 + **攒下来的「需要用户处理」清单**。\n' +
      '★ 一轮刷完（或用户要求做完）后调它，把 pendingHuman / pendingHumanText 一次性汇报给用户 —— ' +
      '**不要一遇到就打断用户**。\n' +
      '汇报后再调 cx_progress({ clearPending: true }) 把清单清空（前提是用户已经看到/处理了）。',
    parameters: {
      type: 'object',
      properties: {
        clearPending: { type: 'boolean', description: '汇报完之后清空待办清单，默认 false' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute({ clearPending = false } = {}) {
      const state = ST.loadState()
      const sum = ST.summary(state)
      if (clearPending && (state.pendingHuman ?? []).length) {
        state.pendingHuman = []
        ST.saveState(state)
        return { ok: true, ...sum, cleared: true, pendingHuman: [], pendingHumanCount: 0, pendingHumanText: '（已清空）' }
      }
      return { ok: true, ...sum, cleared: false }
    },
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  做
  // ═════════════════════════════════════════════════════════════════════════

  reg({
    name: 'cx_tab',
    description:
      '翻到当前小节的某个页面(tab)。i 是 cx_enter 返回的序号（从 0 开始），也可以直接给 cardid。' +
      '翻页后会等这一页真正就绪，并直接返回这一页的任务点清单（等于自动调一次 cx_page）。' +
      '切换失败会明确报错 —— 绝不拿上一页的数据冒充这一页。',
    parameters: {
      type: 'object',
      properties: {
        i: { type: 'number', description: 'tab 序号，从 0 开始' },
        cardid: { type: 'string', description: '也可以直接给 cardid' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    async execute({ i, cardid } = {}) {
      const work = await getWork(ctx)
      const tabs = await OBS.readTabs(work)
      const tab = cardid ? tabs.find((t) => t.cardid === cardid) : tabs[Number(i)]
      if (!tab) {
        return {
          ok: false, error: 'TAB_NOT_FOUND', got: { i, cardid },
          tabs: tabs.map((t, k) => ({ i: k, title: t.title, cardid: t.cardid })),
        }
      }

      const sw = await ACT.switchTab(work, tab, { timeoutMs: 40_000 })
      if (sw.switched === false) return { ok: false, error: 'TAB_SWITCH_FAILED', detail: sw.reason }
      if (sw.ok === false) {
        return {
          ok: false, error: sw.blockedBy ? `BLOCKED_${sw.blockedBy}` : 'MODULE_NOT_LOADED',
          detail: sw.reason, blockedBy: sw.blockedBy ?? null, tab: tab.title,
        }
      }
      session.tabs = tabs
      return { ok: true, switched: true, ...(await inventory(work, { tabs, tabIndex: tabs.indexOf(tab) })) }
    },
  })

  reg({
    name: 'cx_nav',
    description:
      '翻小节：点小节页底部的「下一节」或「上一节」。dir 取 "next"（默认）或 "prev"。' +
      '★ 一个小节做完了就用它往后走，不用重读整棵章节树。' +
      '只做翻页动作 + 返回新小节的页面(tab)列表，不做任何判断。',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', enum: ['next', 'prev'], description: '默认 next' } },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    async execute({ dir = 'next' } = {}) {
      const work = await getWork(ctx)
      if (!(await OBS.isLoggedIn(work))) return { ok: false, error: 'NOT_LOGGED_IN' }
      const r = await ACT.navSection(work, { dir })
      if (!r.ok) {
        return { ok: false, error: 'NAV_FAILED', detail: r.why,
          hint: '当前页面可能没有「上一节/下一节」按钮。确认你停在小节学习页，或改用 cx_enter 指定小节。' }
      }
      session.tabs = r.tabs ?? null
      return {
        ok: true, moved: dir, label: r.label, url: r.url,
        tabs: (r.tabs ?? []).map((t, i) => ({ i, title: t.title, cardid: t.cardid })),
        next: '用 cx_tab({ i: 0 }) 看新小节的第一页有什么',
      }
    },
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  通用手眼 —— 不与任何任务绑定
  //
  //  高层工具（cx_do 的 play/read/answer）只覆盖了**已知**的任务点类型。
  //  但学习通里有很多任务点只是**极普通的交互**：
  //     点进一个文件 → 一直往下翻 → 退出
  //     点开一个链接 → 等加载 → 返回
  //  这些既写不进脚本（类型无穷），也写不进提示词（写不全）。
  //
  //  所以给大模型**通用的眼睛和手**：自己看、自己点、自己判断。
  //  ⚠️ 这四个工具**不含任何任务知识** —— 不判断该不该点、点了会怎样。
  // ═════════════════════════════════════════════════════════════════════════

  reg({
    name: 'cx_dom',
    description:
      '★ 通用眼睛：列出**当前页面所有可以点的东西**（链接 / 按钮 / 输入框，含子窗口里的），' +
      '每个给一个编号 i。\n' +
      '用在什么时候：遇到 cx_do 报 `action:"unknown"` 的任务点（如 pdf / 专题），' +
      '或者任何你想"看看这页有什么可点的"的时候。\n' +
      '拿到编号后用 cx_click({ i }) 点它。看不见文字的图标按钮配合 cx_shot 截图判断。\n' +
      '只在按编号点击时有效 —— 页面一变（翻页/跳转），编号就失效，要重新 cx_dom。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多列多少个，默认 70' } },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute({ limit = 70 } = {}) {
      const work = await getWork(ctx)
      return { ok: true, ...(await OBS.readInteractive(work, { limit })) }
    },
  })

  reg({
    name: 'cx_click',
    description:
      '★ 通用手：点击。三种方式，任选一种：\n' +
      '  i        —— cx_dom 给出的编号（**推荐**，精确）\n' +
      '  text     —— 按可见文字点（找到多个会报 TEXT_AMBIGUOUS，不猜）\n' +
      '  x, y     —— 按坐标点（用于截图里看到、但 DOM 抓不到的图标按钮）\n' +
      '会如实回报**实际点了什么元素**（标签/文字/链接），点完返回新地址和当前所有子窗口。',
    parameters: {
      type: 'object',
      properties: {
        i: { type: 'number', description: 'cx_dom 给出的编号' },
        text: { type: 'string', description: '按可见文字点击' },
        exact: { type: 'boolean', description: 'text 是否要求完全相等，默认包含' },
        x: { type: 'number', description: '坐标点击的 X' },
        y: { type: 'number', description: '坐标点击的 Y' },
        settleMs: { type: 'number', description: '点完等多久再回报，默认 1500ms' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    execute: serial(async ({ i, text, x, y, exact = false, settleMs = 1500 } = {}) => {
      const work = await getWork(ctx)
      if (i != null) return await ACT.clickIndex(work, i, { settleMs })
      if (text) return await ACT.clickText(work, text, { exact, settleMs })
      if (x != null && y != null) return await ACT.clickPoint(work, x, y, { settleMs })
      return {
        ok: false, error: 'NEED_TARGET',
        hint: '要给 i（cx_dom 的编号）、text、或 x+y 之一。不知道点哪个就先 cx_dom 看看。',
      }
    }),
  })

  reg({
    name: 'cx_scroll',
    description:
      '★ 通用手：翻页 / 滚动。to 取 "down"（默认，往下翻一段）/ "bottom"（到底）/ "up" / "top"。\n' +
      'times 可以一次连翻多下。\n' +
      '会自己找页面上**最大的那个可滚动容器**（pdf / 专题阅读器常常是自绘的，窗口本身不滚）。\n' +
      '返回 atBottom 告诉你到底了没有 —— 没到底可以再翻。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['down', 'bottom', 'up', 'top'], description: '默认 down' },
        px: { type: 'number', description: '每次滚多少像素，默认 800' },
        times: { type: 'number', description: '重复几次，默认 1' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    execute: serial(async ({ to = 'down', px = 800, times = 1 } = {}) => {
      const work = await getWork(ctx)
      return await ACT.scrollPage(work, { to, px, times })
    }),
  })

  reg({
    name: 'cx_type',
    description:
      '★ 通用手：往输入框里写字。i 是 cx_dom 给出的编号（必须是 input / textarea）。\n' +
      '会触发 input / change 事件，所以站点自己的校验也认得。' +
      '章节测验的填空**不要用这个** —— 用 cx_do({ key, action:"answer", answers }) 才有提交与校验。',
    parameters: {
      type: 'object',
      properties: {
        i: { type: 'number', description: 'cx_dom 给出的编号' },
        text: { type: 'string', description: '要写进去的文字' },
        enter: { type: 'boolean', description: '写完后在该位置点一下，默认 false' },
      },
      required: ['i', 'text'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    execute: serial(async ({ i, text, enter = false } = {}) => {
      const work = await getWork(ctx)
      return await ACT.typeInto(work, i, text, { enter })
    }),
  })

  reg({
    name: 'cx_do',
    description:
      '★ 核心：对 cx_page 报出的**某一个**任务点执行**一个**动作。\n' +
      '**用 key 指定目标**（推荐，跨页唯一，如 "2:1"）或 t（本页内编号）。\n' +
      '★ 给 key 时会**自动切到那个页面**再动手 —— 不必先 cx_tab。\n' +
      'action:\n' +
      '  play   —— 播放该视频/音频到完成（原速、不拖拽、不伪造心跳），' +
      '播完会**回读页面自己的记账**确认任务点是否真的翻成已完成（verified）。\n' +
      '  read   —— 等该测验加载完，返回题目结构，**并直接附上截图路径**（因为 DOM 文字可能全是乱码）。\n' +
      '  answer —— 给该测验作答并提交（需同时给 answers：题号 → 选项数组）。\n' +
      '  human  —— ★ **记入「需要用户处理」清单，然后继续，不要停**。' +
      '用于听力题、看视频才能做的题、讨论帖、搞不定的未知模块。写清 note。\n' +
      '            （真正要当场打断用户的只有：图形验证码 / 未登录 / 熔断 / 人脸。那些不在这里。）\n' +
      '  skip   —— 主动跳过，**必须写 note** 说明理由；同样记入清单，收尾时会一并告诉用户。\n' +
      '做完会重新清点这一页并返回最新状态，便于你决定下一步。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '★ 推荐。cx_page 返回的 key，格式 "页面序号:本页编号"，如 "2:1"' },
        t: { type: 'number', description: '本页内编号（只在当前页有效；给了 key 就忽略它）' },
        action: { type: 'string', enum: ['play', 'read', 'answer', 'human', 'skip'] },
        answers: { type: 'object', description: 'action=answer 时：题号 → 选项数组，如 {"1":["A","B"]}' },
        maxMinutes: { type: 'number', description: 'action=play 的时长上限，默认 12 分钟' },
        note: { type: 'string', description: 'action=human / skip 的说明' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    execute: serial(async ({ key, t, action, answers, maxMinutes, note } = {}) => {
      const work = await getWork(ctx)
      if (!(await OBS.isLoggedIn(work))) return { ok: false, error: 'NOT_LOGGED_IN' }

      let tabs = await OBS.readTabs(work).catch(() => null)

      // ★ 给了 key → 先切到它所在的那个页面
      //    key 的格式是 "<页面序号>:<本页内编号>"，由 cx_page 生成（跨页唯一）
      let wantT = t
      let switched = null
      if (typeof key === 'string' && key.includes(':')) {
        const [pageIdxRaw, itemRaw] = key.split(':')
        wantT = Number(itemRaw)
        const pageIdx = Number(pageIdxRaw)
        if (Number.isInteger(pageIdx) && tabs?.[pageIdx]) {
          const cur = await getActiveTabIndex()
          if (cur !== pageIdx) {
            const sw = await ACT.switchTab(work, tabs[pageIdx], { timeoutMs: 40_000 })
            if (sw.ok === false || sw.switched === false) {
              return {
                ok: false, error: sw.blockedBy ? `BLOCKED_${sw.blockedBy}` : 'TAB_SWITCH_FAILED',
                key, detail: sw.reason ?? null,
                hint: '没能切到那个页面，没做任何动作。可先 cx_tab 手动切过去看看。',
              }
            }
            switched = tabs[pageIdx].title
          }
          tabs = await OBS.readTabs(work).catch(() => tabs)
        }
      }

      async function getActiveTabIndex() {
        const a = await OBS.readActiveTab(work).catch(() => null)
        return a && tabs ? tabs.findIndex((x) => x.cardid === a.cardid) : -1
      }

      const before = await inventory(work, { tabs })
      const item = before.items.find((x) => x.t === Number(wantT))
      if (!item) {
        return {
          ok: false, error: 'ITEM_NOT_FOUND', key: key ?? null, t: wantT ?? null,
          available: before.items.map((x) => ({ key: x.key, t: x.t, kind: x.kind, action: x.action })),
          hint: '先调 cx_page（或 cx_page({all:true})）看这一页/这一节有哪些任务点。',
        }
      }

      const state = ST.loadState()
      const cardid = before.cardId
      const course = session.course
      const record = (extra) => (course && cardid
        ? ST.markCompleted(state, course, cardid, { title: `${before.tab} / ${item.title ?? item.kind}`, type: item.kind, ...extra })
        : null)

      let result
      switch (action) {
        // ── 播放：纯执行 ──────────────────────────────────────────────────
        case 'play': {
          if (item.kind !== 'video' && item.kind !== 'audio') {
            return { ok: false, error: 'NOT_PLAYABLE', kind: item.kind, hint: '该 item 不是播放器' }
          }
          const r = await ACT.watchTaskPoint(work, { maxMs: (maxMinutes ?? 12) * 60_000, cardid })
          result = {
            ok: r.status === 'COMPLETED',
            status: r.status,
            detail: r.detail ?? r.reason ?? null,
            progressRatio: r.progressRatio ?? null,
            anomalies: r.anomalies ?? null,
            // ★ 关键：播放完成 ≠ 任务点完成
            verified: r.verified,
            taskPointAfter: r.taskPointAfter,
            verifyNote: r.verifyNote,
          }
          if (r.status === 'COMPLETED' && r.verified === true) record({ note: '播放完成且页面已记账' })
          break
        }

        // ── 读题：只读 ────────────────────────────────────────────────────
        case 'read': {
          if (item.kind !== 'quiz') return { ok: false, error: 'NOT_A_QUIZ', kind: item.kind }
          const q = await OBS.waitForQuizLoaded(work, { timeoutMs: 40_000 })
          // ★ 顺手截图：因为题干和选项的 DOM 文字**可能全是乱码**，
          //   "读题"这个动作天然就需要那张图。合并成一步，Agent 少一次调用、也不会忘。
          const shot = await takeShot(work, { full: true, label: `quiz-${item.key ?? item.t}` })
            .catch(() => null)
          result = {
            ok: !!q.found, quiz: q, shot,
            shotHint: shot ? `题目原文看这张图：${shot.file}` : null,
          }
          break
        }

        // ── 作答：执行 + 校验 + 提交 ───────────────────────────────────────
        case 'answer': {
          if (item.kind !== 'quiz') return { ok: false, error: 'NOT_A_QUIZ', kind: item.kind }
          if (item.submitted) { result = { ok: true, status: 'ALREADY_GRADED', score: item.score }; break }

          await OBS.waitForQuizLoaded(work, { timeoutMs: 40_000 })
          const applied = await ACT.answerQuiz(work, { answers: answers ?? {} })
          await new Promise((r) => setTimeout(r, 800))
          const after = await OBS.readQuizContent(work)

          const verify = Object.entries(answers ?? {}).map(([k, want]) => {
            const qq = after.questions?.[Number(k) - 1]
            const got = (qq?.options ?? []).filter((o) => o.chosen).map((o) => o.letter)
            return { q: k, want, got, ok: want.every((x) => got.includes(x)) && got.length === want.length }
          })
          if (!verify.every((v) => v.ok)) {
            result = {
              ok: false, error: 'ANSWER_MISMATCH', applied, verify,
              hint: '浏览器里选中的与预期不符，已拒绝提交。请检查题号和选项。',
            }
            break
          }

          await ACT.submitQuiz(work)
          await new Promise((r) => setTimeout(r, 2500))
          const fin = await OBS.readQuizContent(work)
          result = {
            ok: !!fin.submitted,
            status: fin.submitted ? 'SUBMITTED' : 'SUBMIT_NOT_CONFIRMED',
            score: fin.score, fullScore: fin.fullScore, attempts: fin.attempts,
            applied, verify,
            hint: fin.submitted ? null : '提交后没读到成绩，可能确认框没点上。重试一次；仍失败就截图问用户。',
          }
          if (fin.submitted) record({ note: `自动作答 ${fin.score}/${fin.fullScore}` })
          break
        }

        // ── 交给用户：★ 记下来，**继续干别的**，做完一轮再统一汇报 ─────────
        case 'human': {
          const why = note ?? item.boundary ?? item.note ?? '需要用户处理'
          ST.markHuman(state, course, cardid, {
            action: 'human',
            pageKey: item.key,
            tabTitle: cardid ? before.tab : null,
            kind: item.kind, title: item.title ?? null, why,
          })
          result = {
            ok: true, status: 'RECORDED_FOR_USER', kind: item.kind, why,
            hint: '⚠️ **不要停下来找用户。** 已经记进清单了 —— 继续做这一页/这一节剩下的任务点，'
              + '等一轮刷完（或用户要求做完）后，用 cx_progress 一次性把这些汇报。',
          }
          break
        }

        // ── 主动跳过：同样记入清单，收尾时一并说明 ──────────────────────────
        case 'skip': {
          if (!note) return { ok: false, error: 'NOTE_REQUIRED', hint: 'skip 必须写 note 说明理由' }
          ST.markHuman(state, course, cardid, {
            action: 'skip',
            pageKey: item.key,
            tabTitle: before.tab,
            kind: item.kind, title: item.title ?? null, why: note,
          })
          result = {
            ok: true, status: 'SKIPPED', kind: item.kind, note,
            hint: '已记为「主动跳过」，收尾时会一并告诉用户。**继续做别的。**',
          }
          break
        }

        default:
          return { ok: false, error: 'BAD_ACTION', action, allowed: ['play', 'read', 'answer', 'human', 'skip'] }
      }

      // 做完重新清点这一页，把最新事实交回给大模型
      await new Promise((r) => setTimeout(r, 1000))
      const after = await inventory(work, { tabs })
      return {
        ...result,
        action,
        key: item.key ?? null,
        t: Number(wantT),
        autoSwitchedTo: switched,          // 非 null 表示工具替你先切了页
        itemKind: item.kind,
        pageAfter: {
          tab: after.tab,
          tabIndex: after.tabIndex,
          items: after.items.map((x) => ({ key: x.key, t: x.t, kind: x.kind, action: x.action })),
          tpTotal: after.tpTotal,
          tpUndone: after.tpUndone,
          beyondMe: after.beyondMe,
        },
        next: '看 pageAfter.tpUndone：>0 说明这页还有活，用 pageAfter.items 里的 key 继续 cx_do；'
          + '=0 就用 cx_tab 翻下一页，或 cx_nav 到下一节。',
      }
    }),
  })
}
