// cdp.mjs —— 零依赖 CDP 客户端（Node 24 自带 globalThis.WebSocket / fetch）
// 这就是「浏览器接管插件」底座的第一版：attach / targets / eval / goto / screenshot
// 不引入 CDP 之外的概念，也不含任何学习通业务逻辑。

export const DEFAULT_PORT = 9222

/**
 * 按 URL 片段**每次重新定位** frame 再求值。
 *
 * ⚠️ 为什么需要这个：`frames.find(...)` 拿到的 frameId 会在页面切 tab、
 * 模块重载时**整体失效**。此时对旧 id 重试多少次都没用（frame 已经不存在了），
 * `evalInFrame` 内建的重试也救不了。
 *
 * 实测故障：切到视频 tab 后，video 模块被重新加载 →
 * `readVideoState`/`startPlayback` 手里那个 frameId 已经死了 →
 * `Page.createIsolatedWorld: No frame for given id found` → 整个刷课中断。
 *
 * 正确做法：每次尝试都重新 `page.frames()` 定位。
 */
export async function evalInFrameMatching(page, urlIncludes, expression, opts = {}) {
  const find = async () => {
    const frames = await page.frames()
    const list = Array.isArray(urlIncludes) ? urlIncludes : [urlIncludes]
    for (const pat of list) {
      const f = frames.find((x) => x.url.includes(pat))
      if (f) return f
    }
    return null
  }

  const attempt = async () => {
    const f = await find()
    if (!f) {
      const e = new Error(`没有匹配 ${JSON.stringify(urlIncludes)} 的 frame`)
      e.code = 'FRAME_NOT_FOUND'
      throw e
    }
    return page.evalInFrame(f.id, expression, opts)
  }

  try {
    return await attempt()
  } catch (e) {
    if (e.code === 'FRAME_NOT_FOUND' || e.code === 'FRAME_GONE' || /No frame for given id/.test(e.message)) {
      // 等一下让模块重载完，然后**重新定位**再试
      await new Promise((r) => setTimeout(r, 600))
      return attempt()
    }
    throw e
  }
}

/**
 * 更新频率最高的页面上求值：先试主页面（速度快），失败再按 frame 匹配找。
 */
export async function evalInFrameOrMain(page, urlIncludes, expression, opts = {}) {
  const f = await (async () => {
    const frames = await page.frames()
    const list = Array.isArray(urlIncludes) ? urlIncludes : [urlIncludes]
    for (const pat of list) {
      const hit = frames.find((x) => x.url.includes(pat))
      if (hit) return hit
    }
    return null
  })()
  if (!f) return { error: 'frame-not-found', wanted: urlIncludes }
  return page.evalInFrame(f.id, expression, opts)
}

// ── HTTP 端点 ────────────────────────────────────────────────────────────────
export async function httpJson(port = DEFAULT_PORT, path = '/json/version') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

// ── 原始 socket 层：id/response 关联 + 事件订阅 ──────────────────────────────
export function openSocket(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const listeners = new Map()

  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }

    if (msg.id !== undefined) {
      const slot = pending.get(msg.id)
      if (!slot) return
      pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`))
      else slot.resolve(msg.result)
      return
    }
    const set = listeners.get(msg.method)
    if (set) for (const fn of set) fn(msg.params ?? {}, msg.sessionId)
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error(`websocket failed: ${wsUrl}`)), { once: true })
  })

  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
      return () => listeners.get(method)?.delete(fn)
    },
    close: () => ws.close(),
  }
}

// ── 浏览器层：连到 devtools/browser endpoint ────────────────────────────────
export async function connectBrowser(port = DEFAULT_PORT) {
  const version = await httpJson(port, '/json/version')
  const sock = openSocket(version.webSocketDebuggerUrl)
  await sock.ready
  return { sock, version, port }
}

export async function listTargets(browser) {
  const { targetInfos } = await browser.sock.send('Target.getTargets')
  return targetInfos
}

export async function listPages(browser) {
  return (await listTargets(browser)).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
}

// ── 页面会话：attach 后所有命令带 sessionId（flatten 模式）──────────────────
export async function attachToPage(browser, { targetId, match } = {}) {
  let id = targetId
  if (!id) {
    const pages = await listPages(browser)
    const hit = match ? pages.find((p) => p.url.includes(match)) : pages[0]
    if (!hit) {
      throw new Error(
        `没有匹配的页面 (match=${match ?? '*'})。当前页面:\n` +
          pages.map((p) => `  - ${p.url}`).join('\n'),
      )
    }
    id = hit.targetId
  }

  // ⚠️ sessionId 必须是**可重新赋值**的：学习通跨源跳转会让 CDP session 失效，
  // 失效后每条命令都报 "Session with given id not found"。做成本地可变变量后，
  // 重新 attach 只要换掉它，所有调用点自动生效。
  let { sessionId } = await browser.sock.send('Target.attachToTarget', { targetId: id, flatten: true })
  await send('Page.enable', {})

  // 记录每个 frame 的「主世界」执行上下文 ID。
  // createIsolatedWorld 建的是隔离世界：能读 DOM，但【看不到页面自己的全局变量】
  // （如 videojs、页面内联脚本声明的 window.xxx）。要读播放器运行时配置就必须用主世界。
  const defaultCtxByFrame = new Map()
  const frameByCtx = new Map()
  const offCtx = browser.sock.on('Runtime.executionContextCreated', (p, sid) => {
    if (sid !== sessionId) return
    const aux = p.context?.auxData
    if (aux?.frameId && aux.isDefault) {
      defaultCtxByFrame.set(aux.frameId, p.context.id)
      frameByCtx.set(p.context.id, aux.frameId)
    }
  })
  const offCtxGone = browser.sock.on('Runtime.executionContextDestroyed', (p, sid) => {
    if (sid !== sessionId) return
    const f = frameByCtx.get(p.executionContextId)
    if (f) { defaultCtxByFrame.delete(f); frameByCtx.delete(p.executionContextId) }
  })
  await browser.sock.send('Runtime.enable', {}, sessionId)

  // ══ 会话自愈 ═════════════════════════════════════════════════════════════
  //
  // ⚠️ 实测事故（2026-10-07）：学习通在 i.chaoxing.com / mooc1. / mooc2-ans.
  //    之间跨源跳转会让 CDP session 失效。失效之后**每一条命令**都报
  //    "Session with given id not found"，而旧代码没有任何重连 ——
  //    结果连 cx_open 都救不回来，整个会话彻底卡死，只能重启。
  //
  //    现在：任何页面命令遇到会话失效，自动重新 attach 一次再重试。
  const DEAD_SESSION = /Session with given id not found|Session closed|Target closed|Inspected target navigated or closed|No session with given id/i

  let _reattaching = null
  async function reattach() {
    if (_reattaching) return _reattaching
    _reattaching = (async () => {
      try { await browser.sock.send('Target.detachFromTarget', { sessionId }) } catch { /* 早就没了 */ }
      const r = await browser.sock.send('Target.attachToTarget', { targetId: id, flatten: true })
      sessionId = r.sessionId
      defaultCtxByFrame.clear()
      frameByCtx.clear()
      await browser.sock.send('Page.enable', {}, sessionId)
      await browser.sock.send('Runtime.enable', {}, sessionId)
      return sessionId
    })().finally(() => { _reattaching = null })
    return _reattaching
  }

  /** 带 sessionId 的命令都走这里；遇到会话失效就重连一次再重试。 */
  async function send(method, params = {}) {
    try {
      return await browser.sock.send(method, params, sessionId)
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (!DEAD_SESSION.test(msg)) throw e
      await reattach()
      return await browser.sock.send(method, params, sessionId)
    }
  }

  async function mainWorldContext(frameId, waitMs = 1500) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const c = defaultCtxByFrame.get(frameId)
      if (c !== undefined) return c
      await new Promise((r) => setTimeout(r, 100))
    }
    return undefined
  }

  return {
    targetId: id,
    sessionId,
    // 页面级 send：自动带 sessionId，且遇到会话失效会重连一次（见上面的 send()）
    send,
    // 强制重新附加（cx_open 在遇到诡异的会话错误时可以主动调）
    reattach,
    // 便宜的存活探测：能让上层判断"这个页面句柄还能不能用"
    alive: async () => {
      try { await send('Runtime.evaluate', { expression: '1', returnByValue: true }); return true }
      catch { return false }
    },
    on: (method, fn) => browser.sock.on(method, (params, sid) => {
      if (sid === sessionId) fn(params)
    }),
    disposeEvents: () => { offCtx(); offCtxGone() },

    async eval(expression, { awaitPromise = true, userGesture = true, returnByValue = true } = {}) {
      const r = await send(
        'Runtime.evaluate',
        { expression, awaitPromise, userGesture, returnByValue },
      )
      if (r.exceptionDetails) {
        const d = r.exceptionDetails
        throw new Error(`页面内异常: ${d.exception?.description ?? d.text}`)
      }
      return returnByValue ? r.result?.value : r.result
    },

    // ── 跨域 iframe 支持（学习通把课程内容都塞在 mooc2-ans 的 iframe 里）────
    async frames() {
      const { frameTree } = await send('Page.getFrameTree', {})
      const out = []
      ;(function walk(node) {
        out.push({
          id: node.frame.id,
          url: node.frame.url,
          origin: node.frame.securityOrigin,
          parentId: node.frame.parentId,
        })
        for (const c of node.childFrames ?? []) walk(c)
      })(frameTree)
      return out
    },

    // 在指定 frame 里求值。
    //   isolated=false（默认）→ 用主世界：能读页面全局变量（videojs、window.xxx）
    //   isolated=true          → 用隔离世界：越过同源限制读跨域 iframe 的 DOM
    //
    // ⚠️ 页面切 tab / 加载时会瞬间替换 frame，直接调会撞
    //    `Page.createIsolatedWorld: No frame for given id found`。
    //    这类错误是**瞬态**的（frame 正在被换掉），重试一次基本都能成；
    //    原来不重试，导致整个工具调用直接报错失败。
    //
    // ⚠️ 默认走**隔离世界**（isolated = true）。
    //
    //    为什么把默认反过来：主世界要先等 `mainWorldContext(frameId, 1500)`，
    //    **每个窗口最多等 1.5 秒**。学习通首页挂十几个窗口 ——
    //    实测一次 cx_page 花 25 秒，几乎全耗在这个等待上。
    //
    //    而绝大多数读取（数元素、读文字、看可见性）根本不碰页面全局变量，
    //    隔离世界的创建是立即返回的。所以规则是：
    //      · 纯 DOM 读取        → 用默认（隔离世界，快）
    //      · 要读 videojs / window.xxx → 显式传 { isolated: false }
    async evalInFrame(frameId, expression, { awaitPromise = true, returnByValue = true, isolated = true } = {}) {
      const TRANSIENT = /No frame for given id|Cannot find context|Execution context was destroyed|Target closed|Session closed|Detached while handling command/i

      const attempt = async () => {
        let contextId
        let world = 'main'

        if (!isolated) contextId = await mainWorldContext(frameId, 1500)

        if (contextId === undefined) {
          world = 'isolated'
          const r = await send(
            'Page.createIsolatedWorld',
            { frameId, worldName: 'dsh-bridge', grantUniveralAccess: true },
          )
          contextId = r.executionContextId
        }

        const r = await send(
          'Runtime.evaluate',
          { expression, contextId, awaitPromise, returnByValue, userGesture: true },
        )
        if (r.exceptionDetails) {
          const d = r.exceptionDetails
          const msg = d.exception?.description ?? d.text
          const err = new Error(`frame ${frameId.slice(0, 8)} [${world}] 内异常: ${msg}`)
          err.pageError = true        // 页面内 JS 抛错：不该重试
          throw err
        }
        return returnByValue ? r.result?.value : r.result
      }

      try {
        return await attempt()
      } catch (e) {
        if (!e.pageError && TRANSIENT.test(e.message)) {
          // frame 正在被替换：等一下，重新解析上下文后再试一次
          await new Promise((r) => setTimeout(r, 400))
          try {
            return await attempt()
          } catch (e2) {
            const err = new Error(`frame 已失效（重试后仍失败）：${e2.message}`)
            err.code = 'FRAME_GONE'
            throw err
          }
        }
        throw e
      }
    },

    // 不知道元素在哪个 frame 时用：主 frame 起，逐个 frame 试，返回第一个成功且非空的
    async evalAnywhere(expression, { urlIncludes } = {}) {
      const frames = await this.frames()
      const ordered = frames.filter((f) => !urlIncludes || f.url.includes(urlIncludes))
      const errors = []
      for (const f of ordered) {
        try {
          const v = await this.evalInFrame(f.id, expression)
          if (v !== null && v !== undefined && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) {
            return { frame: f, value: v }
          }
        } catch (e) {
          errors.push(`${f.id.slice(0, 8)}: ${e.message}`)
        }
      }
      if (errors.length) throw new Error(`所有 frame 都失败:\n${errors.join('\n')}`)
      return { frame: null, value: null }
    },

    async goto(url, { timeoutMs = 30_000 } = {}) {
      const done = new Promise((resolve) => {
        const off = browser.sock.on('Page.loadEventFired', (...a) => {
          const sid = a[1]
          if (sid !== sessionId) return
          off()
          resolve()
        })
      })
      await send('Page.navigate', { url })
      await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))])
      return this.eval('location.href')
    },

    // 截图。
    //
    // clip 可以只截一块 —— 用途是"题目看不清"：
    // read_image 会把大图**降采样**，一张 1900×2000 的整页图里的字号会被压得很小。
    // 只截某一道题那一块，就能拿到接近原始清晰度的图。
    async screenshot({ format = 'png', clip = null, scale = undefined } = {}) {
      const params = { format }
      if (clip) {
        params.clip = {
          x: Math.max(0, Math.round(clip.x ?? 0)),
          y: Math.max(0, Math.round(clip.y ?? 0)),
          width: Math.max(1, Math.round(clip.width ?? clip.w ?? 0)),
          height: Math.max(1, Math.round(clip.height ?? clip.h ?? 0)),
          scale: scale ?? 1,
        }
        params.captureBeyondViewport = true
      }
      const { data } = await send('Page.captureScreenshot', params)
      return Buffer.from(data, 'base64')
    },

    // ── 真实点击：用 Input.dispatchMouseEvent 发系统级鼠标事件 ────────────
    // 区别于 element.click()：走的是浏览器输入管线，行为接近真人，
    // 会触发 mousedown/mouseup/click 全套，且能激活需要用户手势的行为。
    async clickAt(x, y, { button = 'left', clickCount = 1 } = {}) {
      const base = { x: Math.round(x), y: Math.round(y), button, clickCount, buttons: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y, buttons: 0 })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    },

    async click(selector, opts = {}) {
      const box = await this.eval(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null;
        e.scrollIntoView({ block: 'center', inline: 'center' });
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) return { hidden: true };
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      })()`)
      if (!box) throw new Error(`选择器未命中: ${selector}`)
      if (box.hidden) throw new Error(`元素不可见: ${selector}`)
      await this.clickAt(box.x, box.y, opts)
      return box
    },

    // 执行页面里的函数调用（如 onclick="toOld(...)" 里的 toOld）
    async callFunction(expression) {
      return this.eval(expression)
    },

    // ── 第三层交互：调用元素自身的 onclick 处理器 ─────────────────────────
    // 实测发现：某些元素（如学习通的 .chapter_item）对合成鼠标事件不响应，
    // 但直接执行它的 onclick 表达式可以正常导航。这是站点自己的代码路径，
    // 不是伪造——相当于替用户"按下"了那个元素唯一会做的事。
    async invokeOnclick(selector) {
      const expr = await this.eval(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        return e ? (e.getAttribute('onclick') || e.closest('[onclick]')?.getAttribute('onclick') || null) : null;
      })()`)
      if (!expr) throw new Error(`元素没有 onclick: ${selector}`)
      // onclick="a(); return false;" 形式 → 只取函数调用部分
      const call = expr.replace(/^\s*return\s+/, '').replace(/;\s*$/, '')
      return this.eval(`(() => { ${call}; return true })()`)
    },

    // 组合：先试真实点击，不生效就退回 onclick 调用（学习通小节的入口就需要这个）
    async clickOrInvoke(selector, { followUp, timeoutMs = 4000, onProgress } = {}) {
      try {
        await this.click(selector)
      } catch (e) {
        onProgress?.(`真实点击失败(${e.message.slice(0, 40)})，直接走 onclick`)
        return { mode: 'invoke', ok: true }
      }
      if (!followUp) return { mode: 'click', ok: true }

      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try { if (await this.eval(followUp)) return { mode: 'click', ok: true } } catch {}
        await new Promise((r) => setTimeout(r, 300))
      }
      onProgress?.('真实点击未生效，退回 onclick 调用')
      await this.invokeOnclick(selector)
      return { mode: 'invoke', ok: true }
    },

    // ── 轮询原语：等条件成立 ────────────────────────────────────────────
    async waitFor(predicateExpr, { timeoutMs = 20_000, intervalMs = 400, frameId } = {}) {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        try {
          last = frameId ? await this.evalInFrame(frameId, predicateExpr) : await this.eval(predicateExpr)
          if (last) return last
        } catch (e) { last = e.message }
        await new Promise((r) => setTimeout(r, intervalMs))
      }
      throw new Error(`waitFor 超时 (${timeoutMs}ms)，最后一次结果: ${JSON.stringify(last)}`)
    },

    // ── 整页截图（超出视口也能截）────────────────────────────────────────
    async screenshotFull({ format = 'png' } = {}) {
      const { data } = await send(
        'Page.captureScreenshot',
        { format, captureBeyondViewport: true },
      )
      return Buffer.from(data, 'base64')
    },

    // ── 网络监听：抓心跳 / 接口调用 ──────────────────────────────────────
    async startNetwork({ maxEvents = 800, bodyCapture = false } = {}) {
      await send('Network.enable', { maxTotalBufferSize: 10_000_000 })
      const events = []
      const push = (e) => { if (events.length < maxEvents) events.push(e) }

      const offs = [
        browser.sock.on('Network.requestWillBeSent', (p, sid) => {
          if (sid !== sessionId) return
          push({
            t: Date.now(), dir: 'req', method: p.request.method, url: p.request.url,
            postData: p.request.postData ?? null, type: p.type ?? null,
          })
        }),
        browser.sock.on('Network.responseReceived', (p, sid) => {
          if (sid !== sessionId) return
          push({ t: Date.now(), dir: 'res', status: p.response.status, url: p.response.url, mime: p.response.mimeType })
        }),
        browser.sock.on('Network.loadingFailed', (p, sid) => {
          if (sid !== sessionId) return
          push({ t: Date.now(), dir: 'fail', error: p.errorText, url: p.blockedReason ?? '' })
        }),
      ]

      return {
        events,
        // 按 URL 关键字过滤
        filter: (re) => events.filter((e) => re.test(e.url)),
        // 打成可读清单
        dump: (re) =>
          events
            .filter((e) => !re || re.test(e.url))
            .map((e) =>
              e.dir === 'req'
                ? `→ ${e.method} ${e.url}${e.postData ? `  body=${e.postData.slice(0, 200)}` : ''}`
                : `← ${e.status} ${e.url}`,
            )
            .join('\n'),
        stop: () => offs.forEach((f) => f()),
      }
    },

    async close() {
      disposeEvents()
      await browser.sock.send('Target.detachFromTarget', { sessionId })
    },
  }
}

// ── 便捷入口：连一次，拿一个页面会话 ────────────────────────────────────────
export async function usePage(opts = {}) {
  const browser = await connectBrowser(opts.port ?? DEFAULT_PORT)
  const page = await attachToPage(browser, { match: opts.match })
  return { browser, page, close: () => { page.close(); browser.sock.close() } }
}

// 等一个新页面出现（点击 target=_blank 链接、或站点 window.open 后）
export async function waitForNewPage(browser, { excludeIds = [], timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pages = await listPages(browser)
    const fresh = pages.find((p) => !excludeIds.includes(p.targetId))
    if (fresh) return fresh
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

// ── 标签页管理 ──────────────────────────────────────────────────────────────
// 原则：自动化只操作【自己创建的】标签页，绝不导航用户正在看的标签页。
// 这样：① 用户的浏览状态不被破坏 ② 标签页可复用 ③ 刷课只能在单标签页里串行

export async function openTab(browser, url = 'about:blank') {
  const { targetId } = await browser.sock.send('Target.createTarget', { url })
  const page = await attachToPage(browser, { targetId })
  return page
}

export async function closeTab(browser, targetId) {
  try {
    await browser.sock.send('Target.closeTarget', { targetId })
  } catch { /* 已关闭 */ }
}

/**
 * 复用或新建一个自动化专用的工作标签页。
 *
 * 优先按持久化的 targetId 复用——**不要按 document.title 找**：
 * 一旦标签页被导航到学习通，title 就被站点改掉了，永远匹配不上。
 */
export async function ensureWorkTab(browser, { targetId, title = 'DSH 自动化' } = {}) {
  const pages = await listPages(browser)

  // ① 上次记录的那个标签页还在 → 直接用它
  if (targetId) {
    const alive = pages.find((p) => p.targetId === targetId)
    if (alive) return attachToPage(browser, { targetId: alive.targetId })
  }

  // ② 记录失效了 → **先找浏览器里已有的、在学习通上的页面**，别急着开新的
  //
  // ⚠️ 实测踩的坑：用户自己把页翻好了，脚本却因为状态里的 targetId 过期，
  //    直接**新开了一个空白标签页**，然后报告"什么都看不到"。
  //    用户正在用的那一页就在旁边，脚本却视而不见。
  //
  //    所以加一层"挑一个最像正在用的页面"：
  //      小节学习页 > 课程/章节页 > 其它学习通页面
  //    同一档次里取列表靠后的（CDP 通常把较新的排在后面）。
  const usable = pages.filter((p) => p.type === 'page' && p.url && p.url !== 'about:blank')
  const score = (p) => {
    const u = p.url || ''
    if (/studentstudy/.test(u)) return 100   // 小节学习页：最可能就是"正在刷的那一节"
    if (/mycourse\//.test(u)) return 90      // 课程页 / 章节列表页
    if (/chaoxing\.com/.test(u)) return 80   // 其它学习通页面
    return 10                                // 与学习通无关的页
  }
  const best = usable.slice().reverse().sort((a, b) => score(b) - score(a))[0]
  if (best && score(best) >= 80) {
    const page = await attachToPage(browser, { targetId: best.targetId })
    page.__reusedWorkTab = true
    return page
  }

  // ③ 确实没有可用的学习通页面 → 才新开一个空白页
  const page = await openTab(browser, 'about:blank')
  await page.eval(`document.title = ${JSON.stringify(title)}`).catch(() => {})
  page.__ownsWorkTab = true
  return page
}

// ── 启动浏览器（学习通模式专用）────────────────────────────────────────────
// 与本机已运行的浏览器**互不干扰**：用独立 profile 目录，不影响用户日常浏览。
// 幂等：端口已通就直接连，不会开出第二个浏览器。

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

export async function launchBrowser({ port = DEFAULT_PORT, profileDir, mute = true, extraArgs = [] } = {}) {
  const { existsSync, mkdirSync } = await import('node:fs')
  const { spawn } = await import('node:child_process')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  try {
    return await connectBrowser(port)
  } catch { /* 没启动，继续 */ }

  // ⚠️ 安全护栏：**永远不能**不带 --user-data-dir 启动。
  //
  // 不带它启动，Edge 会把命令交给**用户正在用的那个实例** →
  //   1) 抢走用户日常浏览器的窗口
  //   2) 永远不会绑上 9222，然后 30 秒超时
  // 实测踩过：state.browser.profileDir 是 null 时就会走到这条路上。
  const dir = profileDir || join(homedir(), '.dsh', 'chaoxing', 'browser-profile')
  mkdirSync(dir, { recursive: true })

  const exe = BROWSER_CANDIDATES.find((p) => existsSync(p))
  if (!exe) throw new Error('找不到 Edge / Chrome 可执行文件')

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
  ]

  // ★ 静音：在**浏览器进程层面**静音，而不是把 video.muted 设成 true。
  //   好处：页面和播放器完全察觉不到，换标签、重新加载都不会失效。
  if (mute) args.push('--mute-audio')

  args.push(
    '--disable-features=CalculateNativeWinOcclusion',  // 防止"窗口被遮挡就降频"
    '--autoplay-policy=no-user-gesture-required',      // 允许自动播放
  )
  args.push(...extraArgs)

  args.push(`--user-data-dir=${dir}`)
  args.push('about:blank')

  const proc = spawn(exe, args, { detached: true, stdio: 'ignore' })
  proc.unref?.()

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { return await connectBrowser(port) } catch { /* 等端口 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`浏览器已启动但调试端口 ${port} 未就绪（30s 超时）。profile=${dir}`)
}

/** 给已连上的浏览器补一个"静音"（进程级参数之外的第二道保险） */
export async function muteAudio(page) {
  try {
    await page.eval(`(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.volume = 0; }
      return true;
    })()`)
    return { ok: true, via: 'video.muted' }
  } catch (e) {
    return { ok: false, why: String(e).slice(0, 80) }
  }
}
