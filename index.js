/**
 * dsh-xuexi —— 网课模式
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  这个插件只提供「手和眼」。判断、决策、应对没见过的情况，全是大模型的事。 │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * 为什么这么设计（一次真实事故）：旧版把「某个网站长什么样」写死在工具里，
 * 又把「按什么顺序调工具」写进提示词。用户换了一个学校的账号 ——
 * 页面结构不一样，专用工具全部失效，模型原地打转十分钟，最后要用户手动帮它开页面。
 *
 * 根因不是模型笨，是**它的退路被堵死了**。所以 v2 只做三件事：
 *
 *   ① 工具只认识屏幕：对账清单、指纹、编号，全部从屏幕上现读
 *   ② 格式错在动手之前拦住，且零副作用（ARG / USAGE 失败 = 页面一下都没被碰过）
 *   ③ 大脑永远有退路：截图 → 列能点的 → 点一个看变化
 *
 * 15 个工具分三类：
 *   眼（5）  eye_open / eye_see / eye_list / eye_shot / eye_check
 *   手（6）  hand_click / hand_pick / hand_write / hand_scroll / hand_goto / hand_tab
 *   必要（4）hand_play / hand_submit / hand_note / hand_verdict
 *
 * 必要那四个留着不是因为它们"聪明"，而是因为只有两类动作需要代码兜住：
 *   ① 涉及铁律（播放不能被作弊：原速 1x / 不拖拽 / 不伪造心跳）
 *   ② 做错回不了头（交答案，一般不给重做）
 */

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import * as B from './lib/browser.mjs'
import * as SEE from './lib/see.mjs'
import * as HAND from './lib/hand.mjs'
import * as NT from './lib/note.mjs'
import * as GATE from './lib/gate.mjs'
import { checkArgs } from './lib/args.mjs'

export const name = 'dsh-xuexi'

/**
 * ★ 声明「我要注入哪些服务」—— **少这一行，整个插件就加载不了**。
 *
 * 实测事故（2.0.0 第一次装机）：漏了这行，DSH 直接报
 *   `xuexi (dsh-xuexi): cannot get property "tools" without inject`
 *   → 预设显示「加载失败」，模式整个用不了。
 *
 * 规则（查过 DSH 的服务机制）：
 *   · **属性访问**（`ctx.tools.register(...)`）必须在这里声明，否则拿不到
 *   · **可选查询**（`ctx.get?.('attachments')`）不用声明，拿不到就返回 undefined
 *
 * 所以这里只写 `tools`：其余 attachments / systemPrompt / sessions / agents
 * 都是用 `ctx.get?.()` 取的，本来就该容忍"拿不到"。
 */
export const inject = ['tools']

const DEFAULT_PORT = 9222
const DEFAULT_PROFILE = join(NT.STATE_DIR, 'browser-profile')

const PROMPT_TEXT = (() => {
  try { return readFileSync(new URL('./prompts/xuexi-mode.md', import.meta.url), 'utf8') }
  catch (e) { return `# 网课模式\n\n（提示词文件读不到：${String(e?.message ?? e)}）\n` }
})()

// ═════════════════════════════════════════════════════════════════════════════
//  出口：把返回值清洗成「无损 JSON」
// ═════════════════════════════════════════════════════════════════════════════
//
// DSH 会校验工具返回值能否**无损**转成 JSON，不能就整个调用失败：
//   tool "xxx" returned invalid output: value is not lossless JSON
// JS 里一堆东西 JSON 表达不了：undefined / NaN / Infinity / 函数 / BigInt / Date…
// 只要返回对象里**任何一个字段**踩到，整条调用就废了 —— 与其逐个字段防，不如出口统一洗。

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

// ═════════════════════════════════════════════════════════════════════════════
//  出口：把截图**真的交给模型看**
// ═════════════════════════════════════════════════════════════════════════════
//
// 实测事故（最严重的一个）：旧版截图工具只返回 { file: "…png" } —— 纯文本。
// 模型**根本看不到图**，于是只能去读被字体搅过的 DOM 硬猜，
// 日志里它自己写了「可用上下文语义还原」。猜对是运气，不是能力。
//
// DSH 的 ContentBlock 支持真正的图片块。实现：截图工具把附件 ref 放进 `__images`
// （内部约定），这里渲染成图片块，同时把 `__images` 从给模型看的文字里摘掉。

const objOut = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => {
    let v = value
    let images = []
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.__images)) {
      images = v.__images
      const { __images, ...rest } = v
      v = rest
    }
    const blocks = [{
      type: 'text',
      text: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
    }]
    for (const attachment of images) {
      if (attachment && attachment.attachmentId) blocks.push({ type: 'image', attachment })
    }
    return blocks
  },
}

/** 截图存盘 + 注册成附件 —— eye_shot 用 */
async function takeShot(ctx, work, { full = false, label = 'shot', clip = null } = {}) {
  const dir = NT.shotsDir()
  mkdirSync(dir, { recursive: true })
  const attachments = ctx.get?.('attachments')

  const attempt = async (format, quality) => {
    const buf = clip
      ? await work.screenshot({ clip, format, quality })
      : (full ? await work.screenshotFull({ format, quality }) : await work.screenshot({ format, quality }))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safe = String(label).replace(/[^\w.-]+/g, '_')
    const ext = format === 'jpeg' ? 'jpg' : 'png'
    const file = join(dir, `xuexi-${safe}-${stamp}.${ext}`)
    writeFileSync(file, buf)

    let image = null
    let err = null
    if (attachments?.saveImage) {
      try {
        image = await attachments.saveImage({
          data: new Uint8Array(buf),
          mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
          name: `xuexi-${safe}.${ext}`,
        })
      } catch (e) { err = e }
    }
    return { file, bytes: buf.length, type: format === 'jpeg' ? 'image/jpeg' : 'image/png', image, err }
  }

  let r = await attempt('png')
  // 只有"附件服务在、但拒了这张图"时才降级重截；服务本来就不可用就没什么好重试的
  if (!r.image && attachments?.saveImage) {
    const j = await attempt('jpeg', 78).catch(() => null)
    if (j?.image) r = { ...j, downscaled: true, note: `整张 PNG（${r.bytes} B）存不进附件，已改用 JPEG` }
  }

  const { err, ...rest } = r
  if (!r.image && err) console.error('[dsh-xuexi] saveImage 失败:', String(err?.message ?? err))
  return rest
}

// ═════════════════════════════════════════════════════════════════════════════

/**
 * 「定位」的 JSON Schema —— 所有要指屏幕上某个东西的参数都用它。
 *
 * ⚠️ 必须给足 `properties`：DSH 注册工具时会校验参数 schema，
 *    光写 `type: 'object'` 不给 `properties` 会注册失败 → 整个预设「加载失败」。
 *    （实测踩过：2.0.0 第一次装机就是这样卡住的。）
 *
 * 三种写法，三选一：编号 i / 可见文字 text / 当前屏幕坐标 x,y。
 * **不允许出现题号、题型、课程名、章节号** —— 那些是脑子里的概念，屏幕上没有。
 */
const LOCATOR_SCHEMA = {
  type: 'object',
  description: '定位屏幕上的一个东西，三种写法三选一：{"i":"编号"} / {"text":"可见文字"} / {"x":123,"y":456}',
  properties: {
    i: { type: 'string', description: '工具给的编号（最稳，原样照抄）' },
    text: { type: 'string', description: '屏幕上看得见的文字' },
    exact: { type: 'boolean', description: 'text 是否要求完全相等（默认包含）' },
    frame: { type: 'string', description: '文字在哪个窗口（多窗口同名时必须给）' },
    x: { type: 'number', description: '当前屏幕坐标 X' },
    y: { type: 'number', description: '当前屏幕坐标 Y' },
  },
  additionalProperties: false,
}

/**
 * 装载自检日志。
 *
 * 为什么要有：DSH 的界面只显示「加载失败」四个字，看不到真实报错，
 * 而插件的报错发生在 host 进程里，我们从外面抓不到。
 * 所以把装载过程**逐步写进一个文件**：
 *
 *     ~/.dsh/xuexi/load-diag.log
 *
 * 出问题时读它：有 'module-eval start' 没 'module-eval ok' → import 阶段炸了；
 * 有 'apply start' 没 'apply done' → apply 里炸了，堆栈就在下面几行。
 *
 * ⚠️ 诊断本身绝不能成为故障点 —— 全程 try/catch，写不进去就算了。
 */
function diag(msg) {
  try {
    const dir = join(homedir(), '.dsh', 'xuexi')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'load-diag.log'), `${new Date().toISOString()}  ${msg}\n`)
  } catch { /* 诊断失败不许影响插件 */ }
}

diag('module-eval start')

export function apply(ctx, config = {}) {
  try {
    const r = applyInner(ctx, config)
    diag('apply done')
    return r
  } catch (e) {
    diag('APPLY THREW >>> ' + (e?.stack || e?.message || String(e)))
    throw e
  }
}

function applyInner(ctx, config = {}) {
  diag('apply start  config=' + JSON.stringify(config))
  diag('  ctx.tools 能拿到吗: ' + (typeof ctx.tools?.register))
  diag('  systemPrompt 能拿到吗: ' + (typeof ctx.get?.('systemPrompt')?.section))
  const port = config.port ?? DEFAULT_PORT

  /** 这次会话的状态（浏览器句柄 + 复核登记簿） */
  const session = { browser: null, work: null, verdicts: {}, lastToken: null, busy: false, ignoreByLh: {} }

  // ── 过程文件落在哪：<工作区>/.xuexi/ ──────────────────────────────────────
  //
  // 用户的意见（对）：DSH 对话一定有工作区，干活产生的过程文件就该留在工作区里。
  // 链路：ToolDefinition.execute(args, exec) → exec.agent.id → ctx.sessions.get(id).header.cwd
  // ⚠️ 全程 try/catch —— 拿不到就退回机器目录，绝不让它成为故障点。
  const _dirBySession = new Map()
  function applyOutputDir(exec) {
    try {
      const id = exec?.agent?.id
      if (id && _dirBySession.has(id)) { NT.setOutputDir(_dirBySession.get(id), { isWorkspace: true }); return }
      const cwd = id ? (ctx.get?.('sessions')?.get?.(id)?.header?.cwd ?? null) : null
      const dir = NT.resolveOutputDir(cwd)
      if (id) _dirBySession.set(id, dir)
      NT.setOutputDir(dir, { isWorkspace: Boolean(cwd) })
    } catch { /* 退回默认目录，不影响功能 */ }
  }

  // ── 系统提示词 ────────────────────────────────────────────────────────────
  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt?.section) {
    ctx.effect(() => systemPrompt.section({ name: 'xuexi:mode-prompt', order: 120, text: PROMPT_TEXT }))
  } else {
    const warn = ctx.logger?.warn?.bind(ctx.logger) ?? console.warn
    warn('[dsh-xuexi] systemPrompt 不可用，模式提示词未注入（工具仍可用）')
  }

  // ── 角色闸门：浏览器只能由「主脑」一个 Agent 操作 ─────────────────────────
  //
  // 为什么必须是**结构约束**而不是靠提示词求它自觉：
  //   同一个账号禁止并行操作。主脑开的复核员如果能调 hand_click / hand_pick，
  //   两个 Agent 同时动同一个浏览器 → 切页互相打断、播放被打断、状态彻底错乱。
  //
  // 判定用**结构**而不是记 ID（记 ID 换会话会失效，把主脑也挡住）：
  //   ctx.agents.isOwnedBy(agentId, other) —— 这个 agent 是不是 other 的子体？
  function isSubagent(agentId) {
    if (!agentId) return null
    try {
      const agents = ctx.get?.('agents')
      if (!agents?.list || !agents?.isOwnedBy) return null   // 判断不了
      for (const a of agents.list()) {
        if (a.id === agentId) continue
        try { if (agents.isOwnedBy(agentId, a)) return true } catch { /* 这条查不动，继续 */ }
      }
      return false
    } catch { return null }
  }

  // 判断不了时的退路：先到先得。eye_open 会重新认领，所以换会话不会把自己锁死。
  let fallbackOwner = null

  const DENY_MAIN = {
    ok: false, category: 'TOOL', error: 'NOT_THE_LEAD',
    hint: '浏览器只能由「主脑」一个 Agent 操作 —— 同账号并行会互相打断、状态错乱。\n'
      + '如果你是复核员：你不该调用任何手眼工具。你手上只有 read_image 和 hand_verdict。\n'
      + '看不清就回 {"__need_shot":[编号]}，主脑会补一张特写给你。',
  }
  const DENY_REVIEWER = {
    ok: false, category: 'USAGE', error: 'LEAD_CANNOT_JUDGE',
    hint: 'hand_verdict 是给**复核员**登记结论用的，主脑不该调它。\n'
      + '你是主脑：自己也要读图定一份，在页面上用 hand_pick / hand_write 弄好 —— 不用登记。\n'
      + '你的答案不在任何登记表里，它就在页面上；eye_check 会拿页面和两份登记比。',
  }

  function roleGuard(defName, exec) {
    const id = exec?.agent?.id
    if (!id) return null                       // 不是 Agent 调的（测试脚本等）→ 放行
    const sub = isSubagent(id)

    if (defName === 'hand_verdict') {          // ★ 唯一反过来的一条：只给复核员
      if (sub === true) return null
      if (sub === null) {
        // 结构判断不可用：谁先调 eye_open 谁是主脑
        if (!fallbackOwner || fallbackOwner === id) return DENY_REVIEWER
        return null
      }
      return DENY_REVIEWER
    }

    if (sub === true) return DENY_MAIN
    if (sub === null) {
      if (fallbackOwner && fallbackOwner !== id) return DENY_MAIN
      if (!fallbackOwner) fallbackOwner = id
    }
    return null
  }

  // ── 拿浏览器 + 绑标签页 ───────────────────────────────────────────────────
  async function getWork({ targetId = null, relaunch = false, preferForeground = false } = {}) {
    if (!targetId && !relaunch && !preferForeground && session.browser && session.work) {
      try {
        await B.listPages(session.browser)     // 浏览器还活着吗
        // ⚠️ 光确认"浏览器还在"不够 —— 浏览器活着不代表页面会话没死。
        //    实测事故：CDP session 失效后 listPages 照样成功（它是浏览器级命令），
        //    于是每次都把同一个**死句柄**返回出去，每条命令都报
        //    "Session with given id not found"，连 eye_open 都救不回来。
        if (await session.work.alive()) return session.work
        session.work = null
      } catch { session.browser = null; session.work = null }
    }

    const state = NT.loadState()
    const browser = await B.launchBrowser({
      port: state.browser?.port ?? port,
      profileDir: state.browser?.profileDir ?? DEFAULT_PROFILE,
    })
    const work = await B.ensureWorkTab(browser, {
      targetId: targetId ?? ((relaunch || preferForeground) ? null : state.browser?.workTargetId),
      preferForeground: preferForeground || relaunch,
    })
    // 每次都把实际用的标签页写回状态：ensureWorkTab 可能复用了"用户在用的那一页"
    if (state.browser?.workTargetId !== work.targetId) {
      state.browser = {
        port: state.browser?.port ?? port,
        profileDir: state.browser?.profileDir ?? DEFAULT_PROFILE,
        workTargetId: work.targetId,
      }
      NT.saveState(state)
    }
    session.browser = browser
    session.work = work
    return work
  }

  /** 浏览器里开着哪几个标签页（形状按底层来，这里只做防守式映射） */
  async function tabsOf(browser) {
    const pages = await B.listPages(browser).catch(() => [])
    return (pages ?? []).map((p, i) => ({
      i,
      id: p.targetId ?? p.id ?? null,
      url: String(p.url ?? ''),
      title: p.title ?? null,
      blank: !p.url || /^about:/.test(String(p.url)),
      active: p.visible === true || p.active === true,
    }))
  }

  /** 统一的错误包装：分清"是世界的问题"还是"工具的问题" */
  function wrapError(e) {
    const msg = String(e?.message ?? e ?? '未知错误')
    const isTool = /Session with given id|Cannot find context|Execution context was destroyed|Target closed|Session closed|Detached while handling command|ECONNREFUSED|socket|WebSocket|超时|timed? ?out/i.test(msg)
    return {
      ok: false,
      category: isTool ? 'TOOL' : 'WORLD',
      error: msg.slice(0, 300),
      hint: isTool
        ? '浏览器/连接出问题了。等一下再试；还不行就用 eye_open 重新接管。'
        : '参数没问题，是屏幕上这件事没做成。**别改调用** —— 退回三件万能事：'
          + 'eye_shot 看一眼 → eye_list 列出所有能点的 → hand_click 点一个看页面怎么变。',
    }
  }

  // ── 软保护的前置一眼：点之前先看清目标像不像"提交" ────────────────────────
  //
  // ★ 2.0.1 修复的缺陷：早先的软保护在 clickLocator **返回之后**才检查 ——
  //   "拦住"两个字说出口时，点击已经发生、答案已经交上去了，还谎报了"没点成"。
  //   现在先看一眼（只读，零副作用），像"提交"就走 hand_submit；看漏了点完才发现，
  //   也只如实警告，绝不谎报"拦住了"。
  const SUBMIT_LIKE = /提交|交卷|上交|确认提交|submit/i
  async function peekTargetLabel(work, loc) {
    try {
      if (!loc || typeof loc !== 'object') return ''
      if (loc.text) {
        const hit = await SEE.findElementByLocator(work, { text: loc.text, exact: loc.exact === true, frame: loc.frame })
        return String(hit?.text ?? loc.text)
      }
      if (loc.i) {
        const hit = await SEE.findElementByLocator(work, { i: loc.i })
        return String(hit?.text ?? '')
      }
      if (Number.isFinite(loc.x) && Number.isFinite(loc.y)) {
        const t = await work.eval(`(() => {
          const e = document.elementFromPoint(${Math.round(loc.x)}, ${Math.round(loc.y)});
          if (!e) return '';
          return String(e.innerText || e.value || e.getAttribute('title') || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
        })()`).catch(() => '')
        return String(t ?? '')
      }
    } catch { /* 看不清就不拦 —— 拦错比放行更糟 */ }
    return ''
  }

  // ── 统一注册：每个工具都走这一条路 ────────────────────────────────────────
  //
  //   ① 定位过程文件目录
  //   ② ★ 先验格式 —— 页面一下都不许被碰过
  //   ③ 角色闸门
  //   ④ 干活（定义在 def.run 里）
  //   ⑤ 出口清洗
  const reg = (def) => ctx.effect(() => {
    diag('register >>> ' + def.name)
    ctx.tools.register({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    timeoutMs: def.timeoutMs,
    isConcurrencySafe: def.isConcurrencySafe,
    output: objOut,
    async execute(args, exec) {
      applyOutputDir(exec)

      // ② 先验格式。ARG / USAGE 失败 = 页面一下都没被碰过，模型改一下调用就能重来。
      const chk = checkArgs(def.name, args)
      if (!chk.ok) return chk

      // ③ 角色闸门
      const denied = roleGuard(def.name, exec)
      if (denied) return denied
      if (def.name === 'eye_open') fallbackOwner = exec?.agent?.id ?? fallbackOwner

      // ④ + ⑤
      const run = async () => {
        if (def.serial && session.busy) {
          return {
            ok: false, category: 'TOOL', error: 'BUSY',
            hint: '已有任务在跑。同一个账号禁止并行（会互相顶、进度作废），等它结束再来。',
          }
        }
        if (def.serial) session.busy = true
        try { return toLossless(await def.run(chk.args, exec)) }
        catch (e) { return wrapError(e) }
        finally { if (def.serial) session.busy = false }
      }
      return run()
    },
    })
    diag('register ok <<< ' + def.name)
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  眼（5）—— 只报事实
  // ═════════════════════════════════════════════════════════════════════════

  reg({
    name: 'eye_open',
    description:
      '接管浏览器，并**绑定到用户正在看的那个标签页**。返回开着哪几个标签页、我接的是哪个、'
      + '登录没有、以及以前记下的笔记。\n'
      + '★ 不会导航用户那一页 —— 没登录时请用户扫码（绝不代填账号密码）。幂等。',
    parameters: {
      type: 'object',
      properties: { tab: { type: 'string', description: '要接哪个标签页的 id（可选，不给就接用户正在看的那个）' } },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async run({ tab }) {
      const work = await getWork({ targetId: tab ?? null, preferForeground: !tab })
      const login = await SEE.loginState(work).catch(() => ({ onLoginPage: null, needsUser: false }))
      const tabs = await tabsOf(session.browser)
      const bound = tabs.find((t) => t.id === work.targetId) ?? null
      const url = await work.eval('location.href').catch(() => null)
      const title = await work.eval('document.title').catch(() => null)

      NT.setCurrent({ url, title })

      return {
        ok: true,
        port,
        url, title,
        loggedIn: login.onLoginPage === false ? true : (login.onLoginPage === true ? false : null),
        needsUser: Boolean(login.needsUser),
        bound: bound ?? { id: work.targetId, url, title },
        tabs,
        notes: NT.noteDigest(10),
        next: tab
          ? '已接到你指定的标签页。'
          : '已连上你正在看的这一页 —— **没动它**。先 eye_see 看这一页有什么。',
      }
    },
  })

  reg({
    name: 'eye_see',
    description:
      '★ 这一页有什么：把所有「要处理的地方」列出来，每处标明是**挑**（pick）还是**写**（write）'
      + '还是**按钮**还是**媒体**，有几个选项、现在选了什么、有没有"已完成"标记。\n'
      + '只报事实，不判断"这是什么题、该做什么"。读题的文字必须看图（DOM 文字可能被搅过）。',
    parameters: {
      type: 'object',
      properties: { full: { type: 'boolean', description: 'true = 连整页一起看（默认只看当前这一屏）' } },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async run({ full }) {
      const work = await getWork()
      const r = await SEE.readAreas(work, { full })
      const areas = r.areas ?? []
      // ★ marks / layout 必须透传出去 —— 曾经漏了这两行，
      //   工具算出来了却到不了模型手里，提示词里那句「eye_see 的 marks 会报给你」就是空的。
      const marks = r.marks ?? []
      const markDone = marks.filter((m) => m.done === true).length
      const markUndone = marks.filter((m) => m.done === false).length
      return {
        ok: true,
        url: r.url, title: r.title,
        frames: r.frames ?? [],
        areas,
        counts: {
          pick: areas.filter((a) => a.kind === 'pick').length,
          write: areas.filter((a) => a.kind === 'write').length,
          button: areas.filter((a) => a.kind === 'button').length,
          media: areas.filter((a) => a.kind === 'media').length,
        },
        marks,
        marksSummary: marks.length ? { total: marks.length, done: markDone, undone: markUndone } : null,
        layout: r.layout ?? null,
        // 对账清单：交之前要复核的那几处（只有 pick），原样发给复核员
        ledger: GATE.buildLedger(areas),
        hint: areas.length
          ? '一处一处处理。挑的用 hand_pick，写的用 hand_write，媒体用 hand_play。'
            + (marks.length
              ? `\n这一页有 ${marks.length} 个完成标记（已完成 ${markDone} / 未完成 ${markUndone}）——`
                + '`areas[].done` 已经帮你配好对了。'
                + '⚠️ 标记是**页面加载时**渲染的，没刷新就是旧值，别拿它当"没算上"的证据。'
              : '')
          : '这一页没看到要处理的地方 —— 要么类型不对（用 eye_list 看看有什么能点的），要么已经做完了。',
      }
    },
  })

  reg({
    name: 'eye_list',
    description:
      '★ 通用眼睛：这一页**所有能点能填的东西**，每个一个编号（含藏在内嵌窗口里的）。\n'
      + '不判断哪个该点 —— 那是你的事。找不到东西、认不出页面时，就用它。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多列多少个，默认 70' },
        frame: { type: 'string', description: '只看某个窗口（窗口名从返回的 byFrame 里取）' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async run({ limit, frame }) {
      const work = await getWork()
      return { ok: true, ...(await SEE.readInteractive(work, { limit, frame })) }
    },
  })

  reg({
    name: 'eye_shot',
    description:
      '给这一页截图。**图会直接放在返回里 —— 你确实能看到它**，不是只给路径。\n'
      + '看不清某一处时用 clip 只截那一块（清楚得多）。',
    parameters: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: '整页截图（默认只截当前这一屏）' },
        clip: {
          type: 'object',
          description: '只截一块：{x,y,width,height}（当前屏幕坐标）',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          additionalProperties: false,
        },
        label: { type: 'string', description: '文件名标记，方便你认' },
        useShotId: { type: 'string', description: '如果这次坐标是从某张旧截图上读的，把那张图的 shotId 带上' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async run({ full, clip, label, useShotId }) {
      if (useShotId) {
        const s = B.getShot?.(useShotId)
        if (!s) {
          return {
            ok: false, category: 'ARG',
            error: `找不到 shotId "${useShotId}" 对应的那张截图（可能太旧，已经清掉了）`,
            expected: 'useShotId 只能填最近 20 张截图里的 shotId；不想引用旧图就把它省掉',
            example: 'eye_shot({"clip":{"x":100,"y":200,"width":600,"height":300}})',
          }
        }
      }
      const work = await getWork()
      const url = await work.eval('location.href').catch(() => null)
      const frameRects = await work.frameRects?.().catch?.(() => []) ?? []
      const scrollY = await work.eval('window.scrollY').catch(() => null)

      // ★ 整页截图**分段** —— 实测教训：一张 2.06 MB 的整页图，模型原话
      //   「the preview is cropped」，截了等于没截，还白烧上下文。
      //   现在按 1800px 一段切成最多 4 张，每张都清楚，并告诉模型每段覆盖哪一段。
      if (full && !clip) {
        const m = await work.send('Page.getLayoutMetrics', {}).catch(() => null)
        const cs = m?.cssContentSize ?? m?.contentSize ?? null
        const W = Math.max(1, Math.round(cs?.width ?? 0))
        const H = Math.max(1, Math.round(cs?.height ?? 0))
        const SEG = 1800
        if (H > SEG) {
          const segs = []
          for (let i = 0; i < 4 && i * SEG < H; i++) {
            segs.push({ x: 0, y: i * SEG, width: W, height: Math.min(SEG, H - i * SEG) })
          }
          const shots = []
          for (const [i, c] of segs.entries()) {
            // eslint-disable-next-line no-await-in-loop
            const s = await takeShot(ctx, work, { clip: c, label: `${label}-seg${i + 1}` })
            shots.push({ ...s, from: c.y, to: c.y + c.height })
          }
          const images = shots.map((s) => s.image).filter(Boolean)
          const out = {
            ok: true,
            segmented: true,
            totalHeight: H,
            segments: shots.map((s, i) => ({
              i: i + 1, from: s.from, to: s.to, bytes: s.bytes, imageAttached: Boolean(s.image),
            })),
            file: shots[0]?.file ?? null,
            type: shots[0]?.type ?? null,
            imageAttached: images.length > 0,
            shotId: B.rememberShot?.({ targetId: work.targetId, url, scrollY, frameRects, at: Date.now() }) ?? null,
            frameRects,
            url,
            note: (() => {
              const covered = shots.length ? shots[shots.length - 1].to : 0
              let s = `整页有 ${H}px 高，已切成 ${shots.length} 段发给你（每段 ${SEG}px）。`
                + '按 segments 里的 from/to 对着看 —— 这样每段都清楚，不会糊成一片。'
              // ★ 2.0.1 修复：最多 4 段 = 7200px，更长的页**必须明说没截全**，
              //   否则模型会把"没截到"当成"不存在"。
              if (covered < H) {
                s += `\\n⚠️ 这页太长，只截到了 ${covered}px —— 下面还有 ${H - covered}px 没截到。`
                  + '用 hand_scroll 往下滚，再 eye_shot 接着看，别把没截到的部分当成"不存在"。'
              }
              return s
            })(),
          }
          if (!images.length) {
            out.hint = '分段图没能作为图片送回来。用 read_image 读 file 路径；再不行用手记下来交给用户。'
          }
          if (images.length) out.__images = images
          return out
        }
      }

      const r = await takeShot(ctx, work, { full, label, clip })
      const shotId = B.rememberShot?.({ targetId: work.targetId, url, scrollY, frameRects, at: Date.now() }) ?? null

      const out = {
        ok: true,
        file: r.file, bytes: r.bytes, type: r.type,
        imageAttached: Boolean(r.image),
        shotId,
        frameRects,
        url,
      }
      if (r.downscaled) out.note = r.note
      if (!r.image) {
        out.hint = '图没能作为图片送回来（imageAttached:false）。用 read_image 读 file 那个路径；再不行就手记下来交给用户。'
      }
      if (r.image) out.__images = [r.image]
      return out
    },
  })

  reg({
    name: 'eye_check',
    description:
      '★ 交之前的复核（**只读，跑多少次都不影响页面**）。\n'
      + '走查七条：挑的有没有空着 / 选了页面上没有的项 / 写的是不是空的 / '
      + '复核员够不够两份 / 三份一不一致 / 还有没有拿不准的 / 你指定的"交"按钮在不在。\n'
      + '★ 全部通过才给**票据**（token）；没有票据就交不出去。不一致时**永远不给票据**。',
    parameters: {
      type: 'object',
      properties: {
        ignore: {
          type: 'array', items: { type: 'number' },
          description: '哪几处不是要答的题（比如一个无关的勾选框），不用复核。填对账清单的编号 n。',
        },
        submitButton: LOCATOR_SCHEMA,
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async run({ ignore, submitButton }) {
      const work = await getWork()
      const r = await SEE.readAreas(work, { full: false })
      const areas = r.areas ?? []
      // ★ 三处共用同一个口径（gate.reviewContext）：题目身份 = 全量清单哈希，
      //   ignore 只筛"要复核哪几处"，并按身份记进 session —— hand_verdict / hand_submit 取同一份。
      //   （2.0.1 修复：早先这里带 ignore、另两处不带，哈希对不上 → 用了 ignore 就永远交不了卷。）
      const rc = GATE.reviewContext(areas, session.ignoreByLh, ignore)
      session.ignoreByLh = { ...session.ignoreByLh, [rc.lh]: rc.ignore }
      const ledger = rc.ledger
      const lh = rc.lh
      const fingerprint = GATE.pageFingerprint({ targetId: work.targetId, url: r.url, areas })

      const store = session.verdicts[lh] ?? {}
      const entries = Object.entries(store).map(([id, v]) => ({ id, ...v }))

      let submitFound = true
      if (submitButton) {
        const hit = await SEE.findElementByLocator(work, submitButton).catch(() => ({ found: false }))
        submitFound = Boolean(hit?.found && hit.visible !== false)
      }

      const gate = GATE.checkGate({ areas, ledger, entries, ignore, submitButton, submitFound })
      const token = GATE.makeToken({ fingerprint, ledgerHash: lh, gate })
      if (token) session.lastToken = { token, fingerprint, ledgerHash: lh, at: Date.now() }

      return {
        ok: true,
        verdict: gate.verdict,
        canSubmit: gate.pass,
        token,
        ledger,
        areas: {
          total: areas.length,
          pick: areas.filter((a) => a.kind === 'pick').length,
          write: areas.filter((a) => a.kind === 'write').length,
        },
        judges: gate.judges,
        problems: gate.problems.map((p) => p.text),
        // ★ 这一页现在有哪些"能点的东西"，**带刚刚重新读到的编号**。
        //   为什么要给：编号只在"最近一次看"有效（eye_see / eye_check / hand_verdict 都会重新编号）。
        //   交之前复核员登记过一轮，页面早被重新读过 —— 拿旧的编号去点会报 ELEMENT_NOT_FOUND。
        //   用这里给的按钮编号去 hand_submit，就一定是最新的。
        buttons: areas.filter((a) => a.kind === 'button').map((a) => ({ i: a.i, label: a.label })),
        hint: gate.pass
          ? '复核通过。把它交给 hand_submit({ confirm:true, reviewed:"票据", button:… }) 就能交 —— '
            + '**button 用上面 buttons 里的编号**（那是刚刚重新读到的，旧的已经作废）。'
          : '**还不交。** 上面那几条不是拒绝你，是叫你回去把那几处定下来。\n'
            + '实在定不下来就 hand_note({ tag:"pending" }) 记给用户 —— 宁可交人，不要猜。',
      }
    },
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  手（6）—— 只做一个动作
  // ═════════════════════════════════════════════════════════════════════════

  reg({
    name: 'hand_click',
    description:
      '点一下。定位三种写法任选一种：编号 {i} / 可见文字 {text,frame,exact} / 当前屏幕坐标 {x,y}。\n'
      + '★ 返回里会告诉你**页面怎么变了**（urlBefore/urlAfter/navigated）—— 这是你认识世界的主要反馈。',
    parameters: {
      type: 'object',
      properties: {
        i: { type: 'string', description: 'eye_see / eye_list 返回的编号（最稳）' },
        text: { type: 'string', description: '屏幕上看得见的文字' },
        exact: { type: 'boolean', description: 'text 是否要求完全相等（默认包含）' },
        frame: { type: 'string', description: '文字在哪个窗口（多窗口同名时必须给）' },
        x: { type: 'number', description: '当前屏幕坐标 X' },
        y: { type: 'number', description: '当前屏幕坐标 Y' },
        settleMs: { type: 'number', description: '点完等多久再回报，默认 1500ms' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    serial: true,
    async run({ loc, settleMs }) {
      const work = await getWork()
      // ★ 软保护必须在**点击之前**（2.0.1 修复：早先点完才检查，"拦住"说出口时
      //   答案其实已经交上去了）。先只读地看一眼目标，像"提交"就走 hand_submit。
      const peek = await peekTargetLabel(work, loc)
      if (SUBMIT_LIKE.test(peek) && !session.lastToken) {
        return {
          ok: false, category: 'USAGE', error: 'SUBMIT_MUST_GO_THROUGH_HAND_SUBMIT',
          expected: '交答案只能用 hand_submit —— 它会先复核（空着的、越界的、复核员够不够、三份一不一致），过了才点。',
          example: '先 eye_check({}) 拿票据，再 hand_submit({ confirm:true, reviewed:"票据", button:{i:"…"} })',
          hint: '你要点的是「' + peek.slice(0, 40) + '」。交是全站唯一做错回不了头的动作，不能顺手点过去。',
        }
      }
      const r = await HAND.clickLocator(work, loc, { settleMs })
      const out = { ok: true, ...r }
      // 看漏了（图标按钮没文字之类）点完才发现像"提交" → 如实警告，绝不谎报"拦住了"
      const clickedText = String(r?.clicked?.text ?? '')
      if (SUBMIT_LIKE.test(clickedText) && !SUBMIT_LIKE.test(peek)) {
        out.warning = '这一下点到了「' + clickedText.slice(0, 40) + '」—— 它看起来像"提交"类按钮，而点击已经发生、拦不住了。'
          + '如果这就是交答案：先 eye_check 看一眼页面现在的状态，必要时 hand_note 告诉用户；以后交答案走 hand_submit。'
      }
      return out
    },
  })

  reg({
    name: 'hand_pick',
    description:
      '★ 在某个「可挑区」里挑选项。单选、多选、判断、下拉 —— **对它来说都是同一件事**。\n'
      + '只认识页面上**真实存在**的选项：给了一个页面上没有的，它会报 rejected 并告诉你实际有哪几个，**绝不瞎点**。',
    parameters: {
      type: 'object',
      properties: {
        area: LOCATOR_SCHEMA,
        choose: { type: 'array', items: LOCATOR_SCHEMA, description: '要挑哪几个选项（每个都是一个定位）' },
        mode: { type: 'string', enum: ['set', 'add', 'clear'], description: 'set 覆盖（默认）/ add 追加 / clear 全取消' },
      },
      required: ['area'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    serial: true,
    async run({ area, choose, mode }) {
      const work = await getWork()
      const r = await HAND.pickOptions(work, { area, choose, mode })
      // ★ 页面上的答案变了 → 旧票据作废（rejected = 整批没动过，票据仍然有效）
      if (!r?.rejected?.length) session.lastToken = null
      return { ok: true, ...r, changed: `这一处现在选中 ${r?.areaState?.selected ?? '?'} / 共 ${r?.areaState?.total ?? '?'} 个选项` }
    },
  })

  reg({
    name: 'hand_write',
    description:
      '★ 在你指定的那块「可写区」里写文字。写完会**回读**一次，报告实际写进去的内容（不是"我应该写上了"）。',
    parameters: {
      type: 'object',
      properties: {
        area: LOCATOR_SCHEMA,
        text: { type: 'string', description: '写什么' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace 覆盖（默认）/ append 接着写' },
      },
      required: ['area', 'text'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    serial: true,
    async run({ area, text, mode }) {
      const work = await getWork()
      const r = await HAND.writeInto(work, { area, text, mode })
      session.lastToken = null       // ★ 写过字 → 旧票据作废
      return { ok: true, ...r, changed: `这一处现在的内容是：${String(r?.valueNow ?? '').slice(0, 120)}` }
    },
  })

  reg({
    name: 'hand_scroll',
    description:
      '滚动。翻长文档、找下面的东西时用。\n'
      + '★ 页面常常有好几个区域（侧栏、正文…），默认滚的那一个**不一定是你想滚的那个**。\n'
      + '要滚指定区域，把那一处的定位给 `area`，或把窗口名给 `frame`。\n'
      + '返回里会告诉你**实际滚的是哪个容器**；滚不动也会明说，不会沉默。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['down', 'up', 'bottom', 'top'], description: '默认 down' },
        px: { type: 'number', description: '每次滚多少像素，默认 800' },
        times: { type: 'number', description: '重复几次，默认 1' },
        area: { ...LOCATOR_SCHEMA, description: '滚「这个东西所在的区域」—— 找它最近的可滚动祖先；没有再滚它所在窗口' },
        frame: { type: 'string', description: '滚哪个窗口的文档（窗口名从 eye_see / eye_list 的 frame 里取）' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    serial: true,
    async run({ to, px, times, area, frame }) {
      const work = await getWork()
      const r = await HAND.scrollPage(work, { to, px, times, area, frame })
      return { ok: true, ...r, changed: `滚到了 ${r?.viewportY ?? '?'} / 共 ${r?.maxY ?? '?'}` }
    },
  })

  reg({
    name: 'hand_goto',
    description:
      '★ **唯一的导航工具**。跳网址 / 后退 / 刷新，三选一。\n'
      + '工具**不会自作主张跳页** —— 要跳，你自己明确说出来。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要去的网址（http/https）' },
        back: { type: 'boolean', description: 'true = 后退' },
        reload: { type: 'boolean', description: 'true = 刷新' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    serial: true,
    async run({ url, back, reload }) {
      const work = await getWork()
      const before = await work.eval('location.href').catch(() => null)
      let r
      if (url) r = await HAND.gotoUrl(work, url)
      else if (back) r = await HAND.goBack(work)
      else r = await HAND.reloadPage(work)
      return { ok: true, urlBefore: before, ...r, changed: `从 ${before ?? '?'} 到了 ${r?.url ?? '?'}` }
    },
  })

  reg({
    name: 'hand_tab',
    description:
      '换浏览器标签页（不是网页里的页签，是浏览器顶上那一排）。\n'
      + '给 i（序号，从 0 开始，见 eye_open 返回的 tabs）或 id。换完之后的工具都作用在新标签页上。',
    parameters: {
      type: 'object',
      properties: {
        i: { type: 'number', description: '标签页序号，从 0 开始' },
        id: { type: 'string', description: '标签页 id（eye_open 返回的 tabs 里的 id）' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    serial: true,
    async run({ i, id }) {
      if (!session.browser) await getWork()
      const tabs = await tabsOf(session.browser)
      let want = null
      if (id) want = tabs.find((t) => t.id === id) ?? null
      else want = tabs[i] ?? null
      if (!want || !want.id) {
        return {
          ok: false, category: 'WORLD', error: 'TAB_NOT_FOUND',
          tabs: tabs.map((t) => ({ i: t.i, id: t.id, url: t.url.slice(0, 120), blank: t.blank })),
          hint: '没有这个标签页。从上面 tabs 里挑一个真实的 i 或 id。',
        }
      }
      const work = await getWork({ targetId: want.id, relaunch: true })
      const url = await work.eval('location.href').catch(() => want.url)
      return { ok: true, bound: { id: work.targetId, url }, tabs: await tabsOf(session.browser), changed: `换到了 ${url}` }
    },
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  必要（4）—— 只有这两类动作需要代码兜住
  //   ① 涉及铁律  ② 做错回不了头
  // ═════════════════════════════════════════════════════════════════════════

  reg({
    name: 'hand_play',
    description:
      '让这一页上的媒体（视频 / 音频）**真播到底**。\n'
      + '★ **等待时长不用你填** —— 工具自己按视频长度算。\n'
      + '正常播就一直守着（播完才返回）；**一出事立刻返回**并告诉你原因'
      + '（被暂停 / 卡住 / 被拖 / 报错 / 要人动手）。\n'
      + '★ 播完之后会读一次这个媒体的**任务点标记**并如实报给你（`markBefore` / `markAfter`）——'
      + '正常情况播完就算完成，标记变了就是收工。标记没变才需要再看一眼。\n'
      + '★ 倍速：默认 1x；**别人改了不纠**，只如实报告。用户明确要求倍速时才传 `rate`。\n'
      + '参数里**故意没有跳转、没有心跳** —— 想都别想。',
    parameters: {
      type: 'object',
      properties: {
        maxSeconds: { type: 'number', description: '★ 一般不用填。绝对保险丝（秒）；不给就按视频长度自动算' },
        stallSeconds: { type: 'number', description: '多久没进展算卡住，默认 25 秒' },
        rate: { type: 'number', description: '★ 只有「用户明确要求倍速」时才传（如 2）。传了才会把速度钉在这个值上' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    serial: true,
    async run({ maxSeconds, stallSeconds, rate }) {
      const work = await getWork()
      const r = await HAND.playMedia(work, { maxSeconds, stallSeconds, rate })
      const url = await work.eval('location.href').catch(() => null)
      if (r?.finished) NT.markDone(url, 'media')

      // ★ 播完之后**读一次任务点标记，如实报出来** —— 但必须带上"它可能过时"这个前提。
      //
      //   实测机制（只读探测坐实的）：任务点标记是**页面加载时**由服务端渲染的。
      //   播完不刷新页面 → 标记还是上一次加载时的旧值。
      //   所以看到「任务点未完成」**不代表没算上**，只代表"页面没刷新"。
      //
      //   曾经把一次会话里「3 个视频 ended 而标记未变」当成普遍规律，用户指出是误诊；
      //   后来探测证明：那 3 个视频是在页面最后一次刷新之后播的，标记自然还是旧的。
      const mark = r?.markAfter ?? null
      let changed = r?.finished
        ? `播完了（${Math.round(r?.playedSeconds ?? 0)} 秒 / 共 ${Math.round(r?.durationSeconds ?? 0)} 秒）`
        : `没播完：${r?.reason ?? '未知'}`
      if (r?.reason === 'FINISHED' && mark && /已完成/.test(mark) && !/未完成/.test(mark)) {
        changed += `，页面上标记已是「${mark}」`
      }

      let hint
      if (r?.reason === 'FINISHED') {
        if (mark && /已完成/.test(mark) && !/未完成/.test(mark)) {
          hint = '播完就算完成 —— 页面上标记也对上了。继续下一条。'
        } else {
          hint = '**播完就算完成** —— 正常情况不用再确认，继续下一条。\n'
            + '（页面上那句标记是**页面加载时**渲染的，没刷新就还是旧值，'
            + '看到「未完成」不代表没算上。真想核实就刷新一次再看。）'
        }
      } else {
        hint = '被中断了。按 reason 处理：被暂停/卡住 → 处理掉挡路的东西再 hand_play 一次；'
          + '要人动手的话记 hand_note 交给用户。'
      }
      if (Array.isArray(r?.rateEvents) && r.rateEvents.length) {
        hint += `\n（播放速度被改过 ${r.rateEvents.length} 次，现在 ${r.rateNow}x。`
          + '如果是用户手动改的，不用管；不是你要求的、又反复被改，就如实告诉用户。）'
      }

      return { ok: true, ...r, changed, hint }
    },
  })

  reg({
    name: 'hand_submit',
    description:
      '★ 把这一页上**你已经弄好的东西**交上去。\n'
      + '它**不接受任何答案** —— 答案是你用 hand_pick / hand_write 亲手弄在页面上的，工具直接读页面。\n'
      + '交之前会**自己再复核一遍**：没有有效票据就交不出去，页面一动不动。',
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: '必须为 true —— 这是"我确认交"的明确表态' },
        reviewed: { type: 'string', description: 'eye_check 给的票据 token' },
        button: LOCATOR_SCHEMA,
      },
      required: ['confirm', 'reviewed', 'button'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    serial: true,
    async run({ reviewed, button }) {
      const work = await getWork()
      const before = await work.eval('location.href').catch(() => null)
      const r = await SEE.readAreas(work, { full: false })
      const areas = r.areas ?? []
      // ★ 和发票据那次同一个口径（gate.reviewContext）：身份 = 全量清单哈希，
      //   ignore 从 session 取 —— eye_check({ignore}) 存进去的那份。
      //   （2.0.1 修复：早先这里不带 ignore → 票据永远 STALE_TOKEN、被忽略处又报空。）
      const rc = GATE.reviewContext(areas, session.ignoreByLh)
      const ledger = rc.ledger
      const lh = rc.lh
      const fingerprint = GATE.pageFingerprint({ targetId: work.targetId, url: r.url, areas })
      const entries = Object.entries(session.verdicts[lh] ?? {}).map(([id, v]) => ({ id, ...v }))

      // ★ 不信任何口头承诺：票据对不上现在的页面/登记，就不交
      const tk = GATE.verifyToken(reviewed, { fingerprint, ledgerHash: lh })
      if (!tk.ok) {
        return {
          ok: false, category: 'USAGE', error: tk.code, error_detail: tk.text,
          hint: '先跑 eye_check({}) 拿票据。空着的、越界的、复核员不够两份、三份不一致 —— 任一条不过就没有票据。',
        }
      }

      // ★ 票据只是"你看过一次"；这里**自己再走一遍**七条
      const hit = await SEE.findElementByLocator(work, button).catch(() => ({ found: false }))
      const gate = GATE.checkGate({
        areas, ledger, entries, ignore: rc.ignore, submitButton: button,
        submitFound: Boolean(hit?.found && hit.visible !== false),
      })
      if (!gate.pass) {
        return {
          ok: false, category: 'USAGE', error: gate.verdict,
          problems: gate.problems.map((p) => p.text),
          hint: '刚才复核没通过 —— 页面一下都没动。回去把那几处定下来，重新 eye_check 拿新票据。',
        }
      }

      const click = await HAND.clickLocator(work, button, { settleMs: 2500 })

      // 交完回读：分数 / 是不是弹出了二次确认
      const after = await SEE.readAreas(work, { full: false }).catch(() => ({ areas: [] }))
      const scoreText = await work.eval(
        `(() => { const t = document.body ? document.body.innerText : '';`
        + ` const m = t.match(/(\\d+(?:\\.\\d+)?)\\s*\\/\\s*(\\d+(?:\\.\\d+)?)/);`
        + ` return m ? { score: parseFloat(m[1]), full: parseFloat(m[2]) } : null })()`,
      ).catch(() => null)

      // ★ 找"交完新冒出来的按钮"（比如二次确认框）：编号带每次扫描的随机 token，
      //   跨两次扫描比 i 永远对不上（2.0.1 修复：每次提交都误报确认框）→
      //   改按稳定身份比（gate.newButtons）；跳到了新页面不算 —— 那是新页自己的按钮。
      const confirmBtn = GATE.newButtons(r.areas ?? [], after.areas ?? [], { navigated: click.navigated })[0] ?? null

      NT.markDone(r.url, 'submit')
      session.lastToken = null       // ★ 交过了 → 这套题的票据用掉了

      const out = {
        ok: true,
        urlBefore: before, urlAfter: click.urlAfter, navigated: click.navigated,
        score: scoreText?.score ?? null,
        fullScore: scoreText?.full ?? null,
        changed: click.navigated ? `交完跳到了 ${click.urlAfter}` : '交了（页面没跳转）',
      }
      if (typeof out.score === 'number' && typeof out.fullScore === 'number' && out.score < out.fullScore) {
        out.scoreGap = out.fullScore - out.score
        out.hint = '没拿满分。这一页现在是批阅视图，**看一眼哪几处错了**：'
          + '知识点上的错就用 hand_note({ tag:"lesson" }) 记下来。一般不给重做，**不要重复提交**。'
      }
      if (confirmBtn) {
        out.needConfirm = { i: confirmBtn.i, text: confirmBtn.label }
        out.hint = '弹出了一个确认框。用 hand_click 点它上面那个按钮：'
          + `hand_click({ i: ${JSON.stringify(confirmBtn.i)} })。`
      }
      return out
    },
  })

  reg({
    name: 'hand_note',
    description:
      '★ 你的笔记本，也是给用户的待办清单。三种用法：add（写一条）/ read:true（读全部）/ clear（清某一类）。\n'
      + 'tag：lesson（你摸出来的规律，下次 eye_open 会带回来）/ pending（要交给用户的）/ skip（你主动跳过的）。\n'
      + '⚠️ **笔记里永远不许写答案** —— 只写规律和待办。',
    parameters: {
      type: 'object',
      properties: {
        add: { type: 'string', description: '要记下的一条' },
        tag: { type: 'string', enum: ['lesson', 'pending', 'skip', 'general'], description: '分类，默认 general' },
        read: { type: 'boolean', description: 'true = 读出全部' },
        clear: { type: 'string', enum: ['lesson', 'pending', 'skip', 'general', 'all'], description: '清空某一类' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async run(args) {
      if (args.read) {
        const notes = NT.loadNotes()
        return {
          ok: true, total: notes.length, notes,
          summary: NT.summary(),
          remember: '⚠️ 笔记是经验不是事实 —— 页面可能变了，先看一眼再信它。',
        }
      }
      if (args.clear) return { ok: true, ...NT.clearNotes(args.clear) }
      const r = NT.addNote(args.tag, args.add)
      return { ok: true, ...r, summary: NT.summary(), hint: '记下了。继续干活，别停下来找用户。' }
    },
  })

  reg({
    name: 'hand_verdict',
    description:
      '★ **复核员专用**：把你的复核结论登记下来。主脑调它会返回 LEAD_CANNOT_JUDGE（那是对的）。\n'
      + 'picks 的键 = 主脑给你的**编号清单**里的 n（不是题号，是"从上到下第几处"）；'
      + '值 = 图上看得见的标签（"A" / "B" / "对" / "错"）。\n'
      + '不登记的话，主脑根本交不出去。',
    parameters: {
      type: 'object',
      properties: {
        picks: {
          type: 'object',
          description: '{"1":["B"],"2":["对"]} —— 键是「从上到下第几处」，值是图上看得见的标签',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
        uncertain: { type: 'array', items: { type: 'number' }, description: '拿不准的那几处编号（**不要猜**）' },
        round: { type: 'number', description: '第几轮看的（重看之后填 2，可选）' },
        note: { type: 'string', description: '一句话说明（可选）' },
      },
      required: ['picks'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async run({ picks, uncertain, round, note }, exec) {
      const work = await getWork()
      const r = await SEE.readAreas(work, { full: false })
      const areas = r.areas ?? []
      // ★ 和 eye_check / hand_submit 同一个口径（gate.reviewContext）：
      //   身份 = 全量清单哈希；ignore 从 session 取（eye_check 存的那份，没有就全量复核）。
      //   bad 按"页面上真实有的"判（复核员手里可能是更早的全量清单，多给不算错），
      //   missing 按"这一轮要复核的"判 —— 两个集合分开，别混。
      const rc = GATE.reviewContext(areas, session.ignoreByLh)
      const lh = rc.lh
      const onPage = new Set(rc.full.map((x) => String(x.n)))
      const required = new Set(rc.ledger.map((x) => String(x.n)))

      const bad = Object.keys(picks).filter((k) => !onPage.has(k))
      if (bad.length) {
        return {
          ok: false, category: 'ARG',
          error: `你登记的编号 ${bad.join('/')} 不在这一页的清单里`,
          expected: `这一页上的编号是：${[...onPage].join('、') || '（没有）'}`,
          example: '{"picks":{"1":["B"],"2":["对"]},"uncertain":[3]}',
        }
      }
      const missing = [...required].filter((n) => !(n in picks) && !uncertain.includes(Number(n)))
      if (missing.length) {
        return {
          ok: false, category: 'USAGE', error: 'REVIEW_INCOMPLETE',
          missing,
          expected: `第 ${missing.join('、')} 处你既没给结论、也没说拿不准`,
          hint: '定下来的写进 picks；拿不准的写进 uncertain —— 但**不要猜**。看不清就回 {"__need_shot":[编号]}。',
        }
      }

      // ★ 身份由 ctx.agents 判定，**不靠自报** —— 复核员只有一份「当前结论」，重登记整体覆盖
      const judgeId = exec?.agent?.id ?? 'unknown-reviewer'
      session.verdicts[lh] = session.verdicts[lh] ?? {}
      session.verdicts = GATE.recordVerdict(session.verdicts, {
        ledgerHash: lh, judgeId, picks, uncertain, round, note,
      })
      session.lastToken = null       // 登记变了 → 旧票据作废（页面指纹里也含 filled，这里再保一道）

      const s = GATE.judgeSummary(session.verdicts, lh)
      return {
        ok: true,
        registered: s.registered,
        judges: s.judges,
        note: '已登记。主脑会拿你这份、另一个复核员那份、以及它自己在页面上选的那份，三份比对。',
      }
    },
  })

  return { name }
}

// ⚠️⚠️ 绝对不要加 `export default`！
//
// 实测事故（2.0.0 装机后预设一直「加载失败」，黑匣子抓到的原文）：
//
//     APPLY THREW >>> Error: cannot get property "tools" without inject
//         at applyInner (index.js)
//
// 明明写了 `export const inject = ['tools']`，却还是报 "without inject"。
// 原因：DSH 取插件对象用的是 **`模块的 default ?? 模块本身`**。
// 我多写了一个 `export default { name, apply }`，DSH 就拿这个对象当插件 ——
// 而它**没有 inject 字段**，于是那句声明整个被忽略，Cordis 不给注入 tools。
//
// 正确形态（和旧版能跑的那份一字不差）：只导出 name / inject / apply 三个具名导出。
// 测试 F0 专门守这一条。

diag('module-eval ok')
