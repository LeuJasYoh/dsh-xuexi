// browser.mjs —— 零依赖 CDP 客户端（Node 24 自带 globalThis.WebSocket / fetch）
// 「网页手眼」的浏览器底座：attach / targets / eval / goto / screenshot / 子窗口几何。
// 不引入 CDP 之外的概念，也不含任何站点业务逻辑 —— 工具只认识屏幕，不认识网站。
//
// 零依赖 = 不引任何 npm 包；node:fs / node:path 这类内置模块随便用。

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_PORT = 9222

/**
 * 按 URL 片段**每次重新定位** frame 再求值。
 *
 * ⚠️ 为什么需要：`frames.find(...)` 拿到的 frameId 会在页面切 tab、模块重载时**整体失效**，
 *    对旧 id 重试多少次都没用（frame 已不存在），`evalInFrame` 的内建重试也救不了。
 *    实测：切到视频 tab 后模块被重载，旧 frameId 直接死掉，整个流程中断。
 *    正确做法：每次尝试都重新 `page.frames()` 定位。
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

// ── 原始 socket 层：id/response 关联 + 事件订阅 + 死亡广播 ──────────────────
//
// ⚠️⚠️ P0 修复（2026-10，socket 死亡挂起）：
//   旧版 send() 只进不出 —— 浏览器进程一死 / 调试端口被关，pending 里的 promise 永远挂起，
//   上层每个工具调用跟着卡死，且没有任何地方能发现"socket 已经死了"。实测：用户把调试
//   浏览器整个关掉后，点任何工具都无限转圈，只能重启 DSH。
//
//   现在三层保险：① close/error → markDead()，pending 逐条 reject(SOCKET_DEAD) 并广播；
//   ② send() 带超时（默认 60s，DSH_CDP_TIMEOUT_MS 可调），单条命令不挂死；
//   ③ isAlive() / dead getter，上层 probe 不用发命令也能问死活。
export function openSocket(wsUrl, opts = {}) {
  const sendTimeoutMs = Number(opts.sendTimeoutMs ?? process.env.DSH_CDP_TIMEOUT_MS) || 60_000
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const listeners = new Map()
  const deadListeners = new Set()
  let dead = null   // { why, at } —— 死过一次就永远是死的，不再发任何命令

  const deadError = () => {
    const e = new Error(`CDP 连接已断开（${dead?.why ?? 'unknown'}）。浏览器可能已被关闭或重启。`)
    e.code = 'SOCKET_DEAD'
    return e
  }

  const markDead = (why) => {
    if (dead) return
    dead = { why, at: Date.now() }
    // 挂在半路的调用不许再等：全部立刻失败，并清掉它们的超时器
    for (const [, slot] of pending) {
      clearTimeout(slot.timer)
      slot.reject(deadError())
    }
    pending.clear()
    for (const fn of [...deadListeners]) {
      try { fn(dead) } catch { /* 订阅者自己炸不该连坐 */ }
    }
  }

  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }

    if (msg.id !== undefined) {
      const slot = pending.get(msg.id)
      if (!slot) return
      pending.delete(msg.id)
      clearTimeout(slot.timer)
      if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`))
      else slot.resolve(msg.result)
      return
    }
    const set = listeners.get(msg.method)
    if (set) for (const fn of set) fn(msg.params ?? {}, msg.sessionId)
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => {
      markDead(`连接失败: ${wsUrl}`)
      reject(new Error(`websocket failed: ${wsUrl}`))
    }, { once: true })
  })

  // 正常 close() 也走 markDead —— 语义统一：关了就是死了
  ws.addEventListener('close', (ev) => {
    markDead(`close code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ''}`)
  })

  return {
    ready,
    /** 死因（null = 还活着） */
    get dead() { return dead },
    /** 便宜的存活探测：不发命令 */
    isAlive: () => !dead && ws.readyState === 1,
    /** 订阅死亡广播 → 返回取消订阅函数。已死则立即回调一次 */
    onDead(fn) {
      if (dead) { try { fn(dead) } catch { /* 同上 */ } ; return () => {} }
      deadListeners.add(fn)
      return () => deadListeners.delete(fn)
    },
    send(method, params = {}, sessionId) {
      if (dead) return Promise.reject(deadError())
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const slot = { method, resolve, reject, timer: null }
        slot.timer = setTimeout(() => {
          if (pending.get(id) !== slot) return   // 已经响应过了
          pending.delete(id)
          const e = new Error(`${method} 超过 ${sendTimeoutMs}ms 没有响应（浏览器无响应或已死）`)
          e.code = 'SOCKET_TIMEOUT'
          reject(e)
        }, sendTimeoutMs)
        pending.set(id, slot)
        try {
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        } catch (e) {
          clearTimeout(slot.timer)
          pending.delete(id)
          reject(new Error(`发送失败（${method}）: ${e.message}`))
        }
      })
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
      return () => listeners.get(method)?.delete(fn)
    },
    close: () => { try { ws.close() } catch { /* 早就死了 */ } },
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

  // ⚠️ sessionId 必须是**可重新赋值**的：页面跨源跳转会让 CDP session 失效，
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
  // ⚠️ 实测事故（2026-10-07）：页面在**不同源**的站点之间跳转（主站 → 内容域 → 播放器域，
  //   域名和端口都换）会让 CDP session 失效，之后每一条命令都报 "Session with given id
  //   not found"，而旧代码没有重连 —— 连上层重新绑定的入口都救不回来，整个会话卡死。
  //   现在：任何页面命令遇到会话失效，自动重新 attach 一次再重试。
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
      // 连接层的事（socket 死了 / 单条命令超时）：重连用的是同一条 socket，
      // 再试一次只是把同一句错话再说一遍 —— 直接抛，让上层看到明白话。
      if (e.code === 'SOCKET_DEAD' || e.code === 'SOCKET_TIMEOUT') throw e
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
    // 强制重新附加（上层遇到诡异的会话错误时可以主动调）
    reattach,
    // 便宜的存活探测：能让上层判断"这个页面句柄还能不能用"。
    // socket 层死了就不必再发命令（发了也是立即失败，还多一次异常开销）。
    alive: async () => {
      if (browser.sock.isAlive && !browser.sock.isAlive()) return false
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

    // ── 跨域 iframe 支持（很多站点把正文塞在跨域 iframe 里，读不到就什么都看不见）──
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

    // 在指定 frame 里求值。isolated=false 用主世界（读全局变量），true 用隔离世界
    // （跨同源限制读跨域 iframe）；默认 true。
    // ⚠️ 为什么默认隔离世界：主世界要先等 mainWorldContext(frameId, 1500)，每个窗口最多
    //    等 1.5 秒 —— 首页挂十几个窗口的站点，实测一次整页读取花 25 秒几乎全耗在这。
    //    而纯 DOM 读取（数元素、读文字、看可见性）根本不碰全局变量，隔离世界立即返回。
    //    要读播放器/window.xxx 才显式传 { isolated: false }。
    // ⚠️ 页面切 tab / 加载会瞬间替换 frame，直接调会撞 `No frame for given id found`，
    //   所以下面按 TRANSIENT 重试。
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
    async screenshot({ format = 'png', clip = null, scale = undefined, quality = undefined } = {}) {
      const params = { format }
      // JPEG 才有 quality。整页截图存成 PNG 可能几 MB，超过附件上限就废了，
      // 所以留一条「降级成 JPEG」的路（见 index.js 的 takeShot）。
      if (format === 'jpeg') params.quality = Math.max(1, Math.min(100, quality ?? 80))
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
    // 实测发现：某些列表项（自带 onclick 的 div/li，不是 <a>）对合成鼠标事件不响应，
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

    // 组合：先试真实点击，不生效就退回 onclick 调用（实测有些列表项入口只吃这条路）
    async clickOrInvoke(selector, { followUp, timeoutMs = 4000, onProgress } = {}) {
      try {
        await this.click(selector)
      } catch (e) {
        onProgress?.(`真实点击失败(${e.message.slice(0, 40)})，直接走 onclick`)
        // 2026-10-17 修：以前只喊这句就 return，既没调 invokeOnclick 又报 ok:true
        const ok = await this.invokeOnclick(selector).then(() => true).catch(() => false)
        return { mode: 'invoke', ok }
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
    async screenshotFull({ format = 'png', quality = undefined } = {}) {
      const params = { format, captureBeyondViewport: true }
      if (format === 'jpeg') params.quality = Math.max(1, Math.min(100, quality ?? 80))
      const { data } = await send('Page.captureScreenshot', params)
      return Buffer.from(data, 'base64')
    },

    // ── 子窗口几何（给上层"按住坐标点下去"用）──────────────────────────────
    //
    // → [{ frame, x, y, width, height }]，**页面坐标**（主文档左上角为原点，含滚动量）。
    //   第 0 条是主窗口自己（= 滚动偏移 + 视口尺寸），方便两套坐标互换；后面每条是一个
    //   子窗口的内容区矩形，嵌套子窗口的 x/y 已逐层累加过。
    //   量不到 → null 而不是空数组：null 的语义是"这次没量出来，别信坐标"，上层据此退回
    //   主窗口。量出来了就至少一条（没子窗口时长度正好 1），所以看有没有子窗口用 length > 1。
    async frameRects() {
      const m = await measureFrameRects(this)
      return m ? m.rects : null
    },

    /**
     * 页面坐标 (x, y) 落在哪个子窗口里 → frameId | null（null = 主窗口）。
     *
     * 嵌套时取**最内层**：点最里面那一层才是用户看到的东西。
     * 用的是**裁剪过的可见区**，不是裸矩形 —— 子窗口被父窗口滚出去的那一块不算命中，
     * 那里显示的其实是父窗口自己的内容（这时答案会落回父窗口，这才是对的）。
     * 量不出来 → null，让上层退回主窗口 —— 不猜。
     */
    async hitFrame(x, y) {
      const px = Number(x)
      const py = Number(y)
      if (!Number.isFinite(px) || !Number.isFinite(py)) return null
      const m = await measureFrameRects(this)
      if (!m) return null
      const inside = []
      for (const r of m.rects) {
        if (r.frame === m.mainId) continue
        const v = m.visRects?.get(r.frame)
        if (!v) continue                     // 被祖先裁没了 / 没量出来 → 不算命中
        if (px >= v.x && px < v.x + v.width && py >= v.y && py < v.y + v.height) inside.push({ r, v })
      }
      if (!inside.length) return null
      inside.sort((a, b) => (a.v.width * a.v.height) - (b.v.width * b.v.height))
      return inside[0].r.frame
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
        filter: (re) => events.filter((e) => re.test(e.url)),
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
      // ⚠️ 必须写 this.disposeEvents()：disposeEvents 是**本对象的属性**，不是一个
      //    变量。原来这里写成裸名 disposeEvents()，一调 close() 就 ReferenceError
      //    （实测：page.close() 直接抛 "disposeEvents is not defined"），
      //    于是 Runtime.executionContextCreated 的监听永远摘不掉。
      this.disposeEvents()
      await browser.sock.send('Target.detachFromTarget', { sessionId })
    },
  }
}

// ══ 子窗口几何：frameRects / hitFrame 的实现 ═══════════════════════════════
//
// 为什么要有这一层：页面套着跨域 iframe 时，元素在子窗口内部、子窗口自己可能被滚动被嵌套，
// 上层要"把手伸进正确的窗口、按正确的坐标点下去"，就必须先知道每个子窗口在**页面坐标**里的矩形。
//
// 两套坐标别混：页面坐标 = 主文档左上角为原点（含滚动量），Page.captureScreenshot 的 clip 用它；
// 视口坐标 = 当前可见区左上角为原点，getBoundingClientRect / Input.* 用它。两者差一个主窗口 scrollY。
//
// ⚠️ 不用 DOM.getBoxModel：CDP 文档没写清它返回哪套坐标，实测会随版本/场景漂移，
//    而差一个 scrollY 的后果不是报错，是点在完全无关的元素上还自以为成功 —— 最难查。
//    所以只信 getBoundingClientRect()（定义明确），再逐层累加"父窗口的视口原点"换算。
// ⚠️ 累加的是**视口原点**不是文档原点（两者差该窗口自己的滚动量）：换错的那版在"只有一层
//    iframe"时完全正常（两次换算恰好抵消），一到"子窗口里还有子窗口且它滚过"就整体偏掉。
//
// 拿不准就返回 null：宁可少报几个矩形（上层退回主窗口还能用），也绝不猜一个。

/** 读主窗口的视口尺寸与滚动量 —— 页面坐标与视口坐标互换的基准（纯 DOM 读，主世界最快） */
async function readMainViewport(page) {
  const expr =
    '({ vw: window.innerWidth || 0, vh: window.innerHeight || 0,' +
    ' sx: window.scrollX || 0, sy: window.scrollY || 0 })'
  try {
    const v = await page.eval(expr)
    if (!v || !Number.isFinite(v.vw) || !Number.isFinite(v.sx) || !Number.isFinite(v.sy)) return null
    return v
  } catch {
    return null
  }
}

/**
 * 读一个 frame 的宿主元素（父文档里那个 <iframe>）的矩形。
 *
 * 用 DOM.getFrameOwner 让 CDP 直接指出"这个 frame 挂在哪个元素上"，比按
 * querySelectorAll('iframe') 的顺序去对齐 frame 树可靠：动态插 iframe 的页面上顺序会错位，
 * 一错位就是点错地方。返回值是**视口坐标**；调用方加"父窗口视口原点在页面坐标里的位置"
 * 即到页面坐标，**不要**再加父窗口滚动量（那等于加两次）。
 */
async function readOwnerRect(page, frameId) {
  try {
    const owner = await page.send('DOM.getFrameOwner', { frameId })
    const backendNodeId = owner?.backendNodeId
    if (!backendNodeId) return null
    const { object } = await page.send('DOM.resolveNode', { backendNodeId })
    const objectId = object?.objectId
    if (!objectId) return null
    try {
      const r = await page.send('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        // 连边框一起量：<iframe> 默认带 2px 内嵌边框（UA 样式），
        // 直接把 border-box 当内容区，整体会偏 2px —— 点小图标时足够点错一行。
        functionDeclaration: `function () {
          const r = this.getBoundingClientRect();
          const cs = getComputedStyle(this);
          const bl = parseFloat(cs.borderLeftWidth) || 0;
          const bt = parseFloat(cs.borderTopWidth) || 0;
          const br = parseFloat(cs.borderRightWidth) || 0;
          const bb = parseFloat(cs.borderBottomWidth) || 0;
          return {
            x: r.left + bl,
            y: r.top + bt,
            width: Math.max(0, r.width - bl - br),
            height: Math.max(0, r.height - bt - bb),
          };
        }`,
      })
      const v = r?.result?.value
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null
      return v
    } finally {
      // 远端对象要显式释放，否则每量一次就在页面里留一个 handle，越积越多
      try { await page.send('Runtime.releaseObject', { objectId }) } catch { /* 无所谓 */ }
    }
  } catch {
    return null
  }
}

/** 两个矩形的交集；不相交 → null */
function intersectRect(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/**
 * 量出主窗口和所有子窗口在页面坐标里的矩形。
 *
 * → { mainId, viewport, rects, visRects }；任何关键前提读不到 → null（上层退回主窗口）。
 *   rects    = 真实矩形（几何事实，不裁剪）
 *   visRects = 每个窗口**真正露出来**的那一块 = 自己的矩形 ∩ 所有祖先露出区
 *              （frame 只会被父窗口裁掉：父窗口滚出去的部分，子窗口也不在上面）
 * 逐层往下推：只有父窗口视口原点的页面坐标已知，才能算子窗口的位置。某个子窗口的 owner
 * 元素拿不到（上下文正在换、跨进程 frame 还没挂上），那个窗口就不报 —— 少报安全，错报危险。
 */
async function measureFrameRects(page) {
  try {
    const frames = await page.frames()
    const root = frames.find((f) => !f.parentId)
    if (!root) return null

    // 主 frame 的参照：视口尺寸 + 滚动量。
    // 主世界直读最快；读不到（页面正在导航）退到 Page.getLayoutMetrics ——
    // 它的 cssLayoutViewport 里有 clientWidth/clientHeight 和 pageX/pageY(=滚动量)。
    let viewport = await readMainViewport(page)
    if (!viewport) {
      try {
        const m = await page.send('Page.getLayoutMetrics', {})
        const v = m?.cssLayoutViewport || m?.layoutViewport
        if (v) viewport = { vw: v.clientWidth, vh: v.clientHeight, sx: v.pageX || 0, sy: v.pageY || 0 }
      } catch { /* 下面统一判空 */ }
    }
    if (!viewport) return null

    // DOM.getFrameOwner / DOM.resolveNode 属于 DOM 域，没 enable 过先补一次
    try { await page.send('DOM.enable', {}) } catch { /* 已经开着，或不允许；照样往下试 */ }

    // 第 0 条是主窗口自己：**页面坐标下的可见区域** = 滚动偏移 + 视口尺寸，
    // 也就是"主窗口视口原点 + 视口大小"。留着它，上层就能在视口坐标和页面坐标
    // 之间来回换算（差的就是这一条的 x/y）。
    const rects = [
      { frame: root.id, x: viewport.sx || 0, y: viewport.sy || 0, width: viewport.vw, height: viewport.vh },
    ]

    const kids = new Map()   // parentId -> [frame]
    for (const f of frames) {
      if (!f.parentId) continue
      if (!kids.has(f.parentId)) kids.set(f.parentId, [])
      kids.get(f.parentId).push(f)
    }

    // frameId -> 该窗口**视口原点**在页面坐标里的位置（不是文档原点！）
    const origin = new Map([[root.id, { x: viewport.sx || 0, y: viewport.sy || 0 }]])
    // frameId -> 真正露出来的那一块；主窗口就是它当前的可见区
    const visRects = new Map([[root.id, rects[0]]])
    const queue = [root.id]
    while (queue.length) {
      const parentId = queue.shift()
      const list = kids.get(parentId) ?? []
      if (!list.length) continue
      const po = origin.get(parentId)
      const pv = visRects.get(parentId) ?? null
      for (const kid of list) {
        const r = await readOwnerRect(page, kid.id)
        if (!r || !(r.width > 0) || !(r.height > 0)) continue   // 折叠/隐藏的窗口不算
        // ⚠️ 只加父窗口的视口原点，**绝不**再单独加父窗口的 scrollY：
        //    owner 元素的 rect 本身就是"父窗口视口坐标"，而 origin 已经是
        //    "父窗口视口原点在页面坐标里的位置" —— 各加一次父窗口滚动量就重复了。
        //    这个错很隐蔽：单层 iframe 时加与不加结果一样（父窗口就是主窗口，
        //    两次换算恰好抵消），一旦子窗口内部还有子窗口、且子窗口滚过，就会
        //    整体偏出去一个滚动量 —— 表现是"点在了上面/下面一行"。
        const x = po.x + r.x
        const y = po.y + r.y
        const rect = { frame: kid.id, x, y, width: r.width, height: r.height }
        origin.set(kid.id, { x, y })
        rects.push(rect)
        // 可见区：父窗口都看不见的地方，子窗口也不可能显示在那儿。
        // 不做这个裁剪的话，"父窗口滚出去、但子窗口矩形还落在页面上"的区域
        // 会被算成命中子窗口 —— 而那里显示的其实是父窗口自己的内容。
        // （已知误差：没扣滚动条宽度，最多差一条滚动条；宁可差一点也不要瞎报。）
        visRects.set(kid.id, pv ? intersectRect(rect, pv) : null)
        queue.push(kid.id)
      }
    }

    return { mainId: root.id, viewport, rects, visRects }
  } catch {
    return null
  }
}

// ══ 截图登记（shotId）═══════════════════════════════════════════════════════
//
// 上层截完一张图，调 rememberShot 登记一条；之后模型说"点第 s3 张图里那个位置"
// 时，就能回到当时的 url / 滚动量 / 子窗口矩形，把图上的相对位置换算回页面坐标。
// 这里只存**事实**，不做任何判断。
//
// ⚠️ 只留最近 20 条：截图是滚动的，模型手里同时最多也就几张。留全量会让一个长
//    会话把每张图的 frameRects 都拖在内存里，越跑越慢。
const SHOT_KEEP = 20
const shotRegistry = new Map()   // shotId -> info（Map 保插入顺序 = 时间顺序，好丢最老的）
let shotSeq = 0

/**
 * 登记一次截图。info = { targetId, url, scrollY, frameRects, at }
 * → shotId（'s1' 's2' …）
 *
 * 字段按**白名单拷贝**：免得调用方顺手把 page 句柄或 Buffer 塞进来 ——
 * 那会让整个会话的截图都回收不掉。
 */
export function rememberShot(info = {}) {
  const id = `s${++shotSeq}`
  shotRegistry.set(id, {
    targetId: info.targetId ?? null,
    url: info.url ?? null,
    scrollY: Number.isFinite(info.scrollY) ? info.scrollY : null,
    frameRects: Array.isArray(info.frameRects) ? info.frameRects : null,
    at: Number.isFinite(info.at) ? info.at : Date.now(),
  })
  // 超上限就丢最老的（Map 的 keys() 按插入顺序，第一个就是最老的）
  while (shotRegistry.size > SHOT_KEEP) {
    shotRegistry.delete(shotRegistry.keys().next().value)
  }
  return id
}

/** 取回登记信息；没见过、或已被挤掉 → null（上层据此退回"重新看一次"）。 */
export function getShot(id) {
  if (id === null || id === undefined) return null
  return shotRegistry.get(String(id)) ?? null
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
// 这样：① 用户的浏览状态不被破坏 ② 标签页可复用 ③ 动作只能在单标签页里串行

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
 * 探测一个标签页是不是「用户正在看的那一个」。
 *
 * CDP 没有"哪个标签在前台"这种字段，但页面自己知道：
 * 前台标签 `document.visibilityState === 'visible'` 且有焦点，后台是 `'hidden'`。
 * 所以临时 attach 一下问一句，问完立刻解开（不留下残留 session）。
 */
/**
 * 逐个别地问一句每个标签页的可见性 / 焦点。
 *
 * 为什么必须问：CDP 的 `Target.getTargets` **不报** visible / focus 这两个字段，
 * 所以光靠 targetInfos 时每个标签页的 active 永远只能是 false —— "用户正在看哪一页"
 * 只能这么逐个 attach 问出来。
 *
 * ⚠️ 浏览器窗口失焦时（用户正在 DSH 里打字就是这种），**所有**标签页都会报
 *    `visibilityState === 'hidden'`。这时别据此判断"用户没打开任何页面"。
 */
export async function probeTabs(browser) {
  const out = new Map()
  const pages = await listPages(browser).catch(() => [])
  for (const p of pages) {
    const fg = await probeForeground(browser, p.targetId)
    if (fg) out.set(p.targetId, { visible: fg.vis === 'visible', focused: fg.focus === true, url: fg.url ?? p.url })
  }
  return out
}

async function probeForeground(browser, targetId) {
  let sessionId
  try {
    ({ sessionId } = await browser.sock.send('Target.attachToTarget', { targetId, flatten: true }))
    await browser.sock.send('Runtime.enable', {}, sessionId)
    const r = await browser.sock.send('Runtime.evaluate', {
      expression: '({ vis: document.visibilityState, focus: document.hasFocus(), url: location.href })',
      returnByValue: true,
    }, sessionId)
    return r?.result?.value ?? null
  } catch {
    return null
  } finally {
    if (sessionId) {
      try { await browser.sock.send('Target.detachFromTarget', { sessionId }) } catch { /* 已经没了 */ }
    }
  }
}

/**
 * 复用或新建一个自动化专用的工作标签页。
 *
 * 挑选顺序（**别按 document.title 找**：标签页一旦被导航到真实站点，title 就变了）：
 *   ⓪ preferForeground 且**有标签页报 visible** → 跟着用户正在看的那一页
 *   ① targetId 还活着 → ② 已存在的内容页（优先不是插件自己动过的）→ ③ 空白页 → ④ 新建
 *
 * ⚠️ ⓪ 有个隐蔽前提：`document.visibilityState` 只在**浏览器窗口本身有焦点**时才对前台
 *    标签页返回 visible。用户忙着在 DSH 里打字时窗口是失焦的，那时所有标签页都报 hidden，
 *    ⓪ 必然落空 —— 所以 ② 必须能自己挑对，不能只依赖 ⓪。
 *
 * `avoid` = 插件自己动过的 targetId 集合。② 里优先绕开它们：用户是往这个浏览器里开
 * 标签页的，而插件自己的那个常排在列表最后，只按"最后一个"挑会把用户翻好的那页晾在一边。
 *
 * ⚠️ preferForeground 只在"开始"或"状态失效"时传；干活中途传会把正在播的视频切走。
 */
export async function ensureWorkTab(browser, { targetId, preferForeground = false, title = 'DSH 自动化', avoid = [] } = {}) {
  const pages = await listPages(browser)
  const skip = new Set(avoid)

  // 什么算「有内容的页面」：http(s)。chrome:// / devtools:// / 扩展页都不算 ——
  // 那些页面上没有"屏幕"可看，自动化进去也做不了任何事。
  const isHttp = (u) => /^https?:\/\//i.test(u || '')
  // 什么算「空白页」：可以白白拿来用的那种（浏览器启动时自带的就是它）。
  const isBlank = (u) => {
    const s = u || ''
    return s === '' || s === 'about:blank' || /^(chrome|edge):\/\/(newtab|new-tab-page)\/?$/.test(s)
  }

  // ⓪ ★ 最先看**用户自己正盯着的那一页**。
  //
  //   CDP 没有"哪个标签在前台"这种字段，但页面自己知道（前台标签 visibilityState=visible），
  //   所以挨个临时 attach 问一句。
  //
  //   实测事故（用户指出）：用户把页翻到位了才叫 DSH 开始，DSH 却认准状态里记的旧标签
  //   （还停在别的页）把它导航过去 —— 用户翻好的那页从头到尾没被看见。
  //   预设的意图是"用户把页面递过来、大模型接手"，不是"大模型抢一个自己的页面"。
  //
  //   所以只在这两个时机重新绑定：上层明确的"开始"（preferForeground）或状态失效。
  //   干活中途不重新绑定 —— 否则会把正在播的视频切走。
  //   ⚠️ 只认真实页面（http(s)）：前台恰好停在空白页时跟着它走等于把自己关进空房间，
  //      那种情况直接落到 ② 去找真页面。
  if (preferForeground) {
    const cands = pages.filter((p) => isHttp(p.url))
    for (const p of cands.slice().reverse()) {   // 列表靠后的通常是较新的
      const fg = await probeForeground(browser, p.targetId)
      if (fg && fg.vis === 'visible') {
        const page = await attachToPage(browser, { targetId: p.targetId })
        page.__reusedWorkTab = true
        page.__followedUser = true
        return page
      }
    }
  }

  // ① 状态里记的那个标签页还在 → 直接用它（干活中途的稳定绑定）
  if (targetId) {
    const alive = pages.find((p) => p.targetId === targetId)
    if (alive) return attachToPage(browser, { targetId: alive.targetId })
  }

  // ② 记录失效了 → **先在浏览器里已有的页面中挑一个能用的**，别急着开新的
  //
  // ⚠️ 实测踩的坑：用户自己把页翻好了，脚本却因为状态里的 targetId 过期直接新开一个
  //    空白标签页，然后报告"什么都看不到"—— 用户正在用的那一页就在旁边，脚本却视而不见。
  //
  //    挑选规则全部通用，不认识任何网站：只看非 about:blank 的 http(s) 页面。
  //    ⚠️ 不能按 URL 关键词打分 —— 旧版那段"某站关键词优先"是写给一个网站专用的，
  //        换个网站就挑错页，而且等于把"工具认识网站"写进代码，违反"工具只认识屏幕"。
  //    ⚠️ 第二个坑（2026-10-17 真机）：**优先绕开插件自己动过的标签页**。用户是往这个
  //        浏览器里开标签页的，插件自己的那个常排在列表最后，只按"最后一个"挑，
  //        就会把用户翻好的那一页晾在一边 —— 表现就是"我明明打开了页面，
  //        插件眼里始终只有它自己那个"。
  const usable = pages.filter((p) => isHttp(p.url))
  const foreign = usable.filter((p) => !skip.has(p.targetId))
  const cands = foreign.length ? foreign : usable
  const best = cands[cands.length - 1]
  if (best) {
    const page = await attachToPage(browser, { targetId: best.targetId })
    page.__reusedWorkTab = true
    return page
  }

  // ③ 真的没有可用的真实页面 → 先接管**闲置的空白页**，最后才自己开一个
  //
  // ⚠️ 实测事故（用户指出）：让 DSH 打开浏览器后，浏览器里出现了
  //    **一个空白标签页 + 一个内容页** —— 那个多余空白页就是这里造成的：
  //    浏览器启动时自带的空白页没人管，我们又开了第二个。
  const blank = pages.find((p) => isBlank(p.url))
  if (blank) {
    const page = await attachToPage(browser, { targetId: blank.targetId })
    await page.eval(`document.title = ${JSON.stringify(title)}`).catch(() => {})
    page.__ownsWorkTab = true
    return page
  }

  const page = await openTab(browser, 'about:blank')
  await page.eval(`document.title = ${JSON.stringify(title)}`).catch(() => {})
  page.__ownsWorkTab = true
  return page
}

// ── 启动浏览器（独立 profile：不打扰用户自己那套浏览器）─────────────────────
// 与本机已运行的浏览器**互不干扰**：用独立 profile 目录，不影响用户日常浏览。
// 幂等：端口已通就直接连，不会开出第二个浏览器。

// ══ 浏览器可执行文件的发现（E-9 跨平台）═══════════════════════════════════
//
// 旧版只认 Windows 的四个绝对路径 —— 在 macOS / Linux 上直接
// "找不到 Edge / Chrome 可执行文件"，插件除了 Windows 哪儿都用不了。
//
// 发现顺序（先显式后自动，显式永远优先）：
//   ① DSH_BROWSER_PATH 环境变量 —— 部署环境（无头服务器、自定义安装位置）
//      的唯一可靠入口。设了但不存在 → 直接报错，不悄悄换一个浏览器
//      （用户显式指定了就说明他想要那一个，悄悄换掉比报错更糟）。
//   ② 各平台常见绝对路径（existsSync）
//   ③ PATH 里按名字找（Linux/macOS 的 apt / dnf / brew 装法都在 PATH 里）
const WIN_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/opt/google/chrome/chrome',
  '/opt/google/chrome/google-chrome',
  '/snap/bin/chromium',
]

// PATH 里按名字找（Windows 走 PATHEXT，类 Unix 走可执行位所在的目录条目）
const PATH_NAMES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'microsoft-edge', 'microsoft-edge-stable', 'brave-browser',
  'msedge', 'chrome',
]

/** PATH 里按名字找可执行文件（同步、不 spawn）；找不到 → null */
function whichSync(name) {
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, name + (ext ? ext.toLowerCase() : ''))
      try { if (existsSync(p)) return p } catch { /* 目录不存在之类，继续找 */ }
    }
  }
  return null
}

/**
 * 找浏览器可执行文件（跨平台）。
 * → { exe, via } 或 null（via = 'DSH_BROWSER_PATH' | 'platform' | 'PATH'）
 *
 * 只做发现，不启动。抛错话的活留给调用方 —— 这里返回 null 就够。
 */
export function findBrowserExe() {
  const envPath = process.env.DSH_BROWSER_PATH
  if (envPath) {
    if (existsSync(envPath)) return { exe: envPath, via: 'DSH_BROWSER_PATH' }
    return null   // 设了却不存在：调用方据此报错（见 launchBrowser）
  }

  const abs = process.platform === 'win32' ? WIN_CANDIDATES
    : process.platform === 'darwin' ? MAC_CANDIDATES
      : LINUX_CANDIDATES
  for (const p of abs) {
    try { if (existsSync(p)) return { exe: p, via: 'platform' } } catch { /* 继续 */ }
  }

  for (const name of PATH_NAMES) {
    const p = whichSync(name)
    if (p) return { exe: p, via: 'PATH' }
  }
  return null
}

export async function launchBrowser({ port = DEFAULT_PORT, profileDir, mute = true, extraArgs = [] } = {}) {
  const { mkdirSync } = await import('node:fs')
  const { spawn } = await import('node:child_process')
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
  // ⚠️ 目录名保持中性：目录名带站点字样会有两个坏处 ——
  //    ① 换个站点就得换 profile，登录态跟着丢；② 痕迹跟着 profile 一起留在磁盘上。
  //    注意：改目录 = 旧 profile 里的登录态不再复用，第一次会要求重新登录一次。
  const dir = profileDir || join(homedir(), '.dsh', 'browser-profile')
  mkdirSync(dir, { recursive: true })

  // E-9：跨平台发现。环境变量显式指定了却找不到 → 明确报错，不悄悄换浏览器。
  const envPath = process.env.DSH_BROWSER_PATH
  if (envPath && !existsSync(envPath)) {
    throw new Error(`DSH_BROWSER_PATH 指向的文件不存在: ${envPath}`)
  }
  const found = findBrowserExe()
  if (!found) {
    const tried = (process.platform === 'win32' ? WIN_CANDIDATES
      : process.platform === 'darwin' ? MAC_CANDIDATES
        : LINUX_CANDIDATES).length
    throw new Error(
      `找不到可用的浏览器（Chrome / Edge / Chromium，已试 ${tried} 个常见路径 + PATH）。\n` +
      '请安装其中任意一个，或用环境变量 DSH_BROWSER_PATH 指定可执行文件路径。',
    )
  }
  const exe = found.exe

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
