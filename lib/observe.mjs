// observe.mjs —— ★ 所有「读」操作：只报告页面上的事实，不改变任何状态
//
// 分工原则（用户定的）：插件只做三件事 —— 点、取信息、截图。
// 本文件负责「取信息」：把学习通页面上有什么，如实读出来。
// **这里不允许出现任何业务判断**（不许有「该不该做」的分支）。
//
// 所有 DOM 选择器与判据都来自实测，不是猜的（详见 docs/学习通事实.md）。

import { listPages, waitForNewPage, attachToPage, evalInFrameMatching } from './browser.mjs'

// ── 入口 URL ────────────────────────────────────────────────────────────────
export const HOME_URL = 'https://i.chaoxing.com/base'
export const LOGIN_HOST = 'passport2.chaoxing.com'

export function chapterListUrl(course) {
  return (
    'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse' +
    `?courseid=${course.courseId}&clazzid=${course.clazzId}&cpi=${course.cpi}&pageHeader=1`
  )
}

export function courseShellUrl(course) {
  return (
    'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu' +
    `?courseid=${course.courseId}&clazzid=${course.clazzId}&cpi=${course.cpi}&pageHeader=0&v=2&hideHead=0`
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 页面类型识别 —— ★ 回答"我现在站在哪个页面"
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么必须有它（实测踩的坑）：
//
//   inventory() 是**只为「小节学习页」写的** —— 它去找标签条、播放器、题目。
//   当停在「章节列表页」时，那里没有这些东西，
//   inventory 不会报错，而是**平静地报告"什么都没有"**。
//
//   这种**沉默的错误**最危险：不截图核对就会一路错下去。
//   所以 cx_page 必须**先说自己站在哪**，再讲这页有什么。
//
// 实测：学习通有几种性质完全不同的页面
//   课程外壳页   mooc2-ans/mycourse/stu        顶部横栏「任务 章节 讨论 作业 考试」
//   章节列表页   .../mycourse/studentcourse    一列单元/小节，带 ① ✅ 徽章
//   小节学习页   mooc1/mycourse/studentstudy   顶部「1 视频 / 2 章节测验」标签条
//   作业/测验页  mooc-ans/work/…               题目 + 提交按钮
//   个人空间     i.chaoxing.com/base           课程卡片列表
//   登录页       passport*.chaoxing.com        扫码/账号登录

export const PAGE_KIND = {
  LOGIN: 'LOGIN',
  HOME: 'HOME',
  COURSE_SHELL: 'COURSE_SHELL',
  CHAPTER_LIST: 'CHAPTER_LIST',
  SECTION: 'SECTION',
  WORK: 'WORK',
  UNKNOWN: 'UNKNOWN',
}

export async function detectPageKind(page) {
  const frames = await page.frames().catch(() => [])

  const top = await page.eval(`(() => {
    const href = location.href;
    const host = location.hostname;
    const body = document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '';
    return {
      href, host, title: document.title,
      hasLoginForm: !!document.querySelector('#phone, #pwd, input[name="pwd"]'),
      tabBarCount: document.querySelectorAll('#prev_tab li').length,
      chapterItemsTop: document.querySelectorAll('.chapter_item').length,
      hasCourseNav: /任务\\s{0,4}章节\\s{0,4}讨论\\s{0,4}作业\\s{0,4}考试/.test(body),
      bodyHead: body.slice(0, 100),
    };
  })()`).catch(() => ({}))

  const href = String(top.href || '')
  const host = String(top.host || '')

  if (/^passport\d*\.chaoxing\.com$/.test(host) || /\/login/.test(href) || top.hasLoginForm) {
    return { kind: PAGE_KIND.LOGIN, href, title: top.title, why: '出现登录页或登录表单' }
  }

  if (top.tabBarCount > 0) {
    return { kind: PAGE_KIND.SECTION, href, title: top.title, why: `有标签条（${top.tabBarCount} 个页面）` }
  }
  if (/\/mooc-ans\/work\//.test(href)) {
    return { kind: PAGE_KIND.WORK, href, title: top.title, why: '作业/测验页面' }
  }

  // 章节列表可能直接在顶层，也可能嵌在 iframe 里（课程外壳页）
  let chapterItems = top.chapterItemsTop || 0
  let chapterFrame = null
  if (!chapterItems) {
    for (const f of frames) {
      if (f.url === href) continue
      const n = await page.evalInFrame(f.id, 'document.querySelectorAll(".chapter_item").length').catch(() => 0)
      if (n > 0) { chapterItems = n; chapterFrame = f.url; break }
    }
  }
  if (chapterItems > 0) {
    return {
      kind: chapterFrame ? PAGE_KIND.COURSE_SHELL : PAGE_KIND.CHAPTER_LIST,
      href, title: top.title, chapterItems,
      chapterFrame: chapterFrame ? chapterFrame.slice(0, 110) : null,
      why: chapterFrame
        ? `课程页：里面有 ${chapterItems} 个小节的列表（嵌在子窗口里）`
        : `章节列表页：有 ${chapterItems} 个小节`,
    }
  }

  if (/^i\.chaoxing\.com$/.test(host)) {
    return { kind: PAGE_KIND.HOME, href, title: top.title, why: '个人空间（课程列表）' }
  }
  if (/\/mycourse\/stu/.test(href) || top.hasCourseNav) {
    return { kind: PAGE_KIND.COURSE_SHELL, href, title: top.title, why: '课程页（章节列表尚未加载）' }
  }

  return { kind: PAGE_KIND.UNKNOWN, href, title: top.title,
    why: '认不出这是什么页面，请截图确认', bodyHead: top.bodyHead }
}

// ═══════════════════════════════════════════════════════════════════════════
// 通用「眼睛」：这一页有哪些**可以点的东西**
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么需要它（用户提的关键点）：
//
//   高层工具（cx_do 的 play/read/answer）只覆盖我们**已知**的任务点类型。
//   而学习通的任务点里，有很多是**极普通的交互**：
//     · pdf ／ 专题：点进去 → 一直往下翻 → 翻到底 → 退出
//     · 外链、附件：点开那个链接 → 等加载 → 返回
//
//   这些**既写不进脚本**（类型无穷），**也写不进提示词**（写不全）。
//   唯一可行的做法：给大模型一双**通用的眼睛**和一只**通用的手**，
//   让它现场看、现场点、现场判断。
//
// 本函数只负责"看"：把所有可点的元素列出来，并给每个打一个临时标记
// （data-dsh-h="N"），这样 cx_click 可以**精确**点到它，不会点错。
//
// 它**不判断哪个该点** —— 那是大模型的事。
export async function readInteractive(page, { limit = 70, frame: onlyFrame = null } = {}) {
  const frames = await page.frames()
  const elements = []

  const labelOf = (url) => {
    if (!url) return '?'
    if (/modules\/video/.test(url)) return '视频模块'
    if (/modules\/audio/.test(url)) return '音频模块'
    if (/modules\/pdf/.test(url)) return 'PDF模块'
    if (/modules\/zt/.test(url)) return '专题模块'
    if (/mooc-ans\/work/.test(url)) return '作业/测验'
    if (/knowledge\/cards/.test(url)) return '知识卡片'
    if (/bbscircle|insertbbs/.test(url)) return '讨论区'
    return '主页面'
  }

  // ★ 窗口排序：**内容模块优先**
  //
  // 实测踩的坑：主页面里有一个「目录」侧栏，装着整门课 125 个小节。
  // 限额 70 全被它吃光，真正的 PDF 内容一条都没列出来 ——
  // 工具"能用"，但大模型根本看不到想点的东西。
  //
  // 所以：内容模块（pdf/video/work/讨论）排前面，导航壳排后面。
  const frameScore = (url) => {
    const u = url || ''
    if (/modules\/(pdf|zt|video|audio)/.test(u)) return 100
    if (/mooc-ans\/work|bbscircle|insertbbs/.test(u)) return 90
    if (/knowledge\/cards/.test(u)) return 60
    return 10
  }
  // 过滤掉 about:blank 之类的空窗口（实测一页能挂 6 个，纯属浪费配额和探测时间）
  const real = frames.filter((f) => f.url && !/^about:/.test(f.url))
  const ordered = (real.length ? real : frames).slice().sort((a, b) => frameScore(b.url) - frameScore(a.url))

  // 每个窗口给一份自己的额度，防止单个窗口把限额吃光
  const perFrame = Math.max(10, Math.min(30, Math.ceil(limit / Math.max(1, Math.min(ordered.length, 3)))))

  for (let fi = 0; fi < ordered.length; fi++) {
    const f = ordered[fi]
    const frameLabel = labelOf(f.url)
    if (onlyFrame && frameLabel !== onlyFrame && !f.url.includes(String(onlyFrame))) continue

    // ① 先在这个窗口里把可点的元素标出来（临时用局部序号当标记）
    const found = await page.evalInFrame(f.id, `(() => {
      const txt = (e) => (e.innerText || e.value || e.getAttribute('title')
        || e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g,' ').trim();
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) return false;
        let n = e;
        while (n && n.nodeType === 1) {
          const s = getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
          n = n.parentElement;
        }
        return true;
      };
      document.querySelectorAll('[data-dsh-h]').forEach((e) => e.removeAttribute('data-dsh-h'));
      const sel = 'a, button, input, textarea, select, [onclick], [role="button"], [role="link"], [class*="btn"], [class*="Btn"]';
      const all = [...document.querySelectorAll(sel)];
      const out = [];
      for (const e of all) {
        if (!visible(e)) continue;
        const t = txt(e);
        const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
        if (!t && !isField && !e.getAttribute('onclick') && !e.getAttribute('href')) continue;
        const r = e.getBoundingClientRect();
        e.setAttribute('data-dsh-h', String(out.length));
        out.push({
          tag: e.tagName,
          text: t.slice(0, 80),
          href: (e.getAttribute('href') || '').slice(0, 100) || null,
          onclick: (e.getAttribute('onclick') || '').slice(0, 90) || null,
          type: e.getAttribute('type') || null,
          value: isField ? String(e.value || '').slice(0, 40) : null,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        });
        e.setAttribute('data-dsh-h', String(out.length - 1));
      }
      return out;
    })()`).catch(() => null)

    if (!found || !found.length) continue

    // ② 只取前 perFrame 个，并把标记改成**唯一键** "f<窗口号>:<窗口内编号>"
    //    键必须和页面上写的完全一致，否则 cx_click 会点不到或点错。
    const take = Math.min(found.length, perFrame, limit - elements.length)
    if (take <= 0) break
    await page.evalInFrame(f.id, `(() => {
      document.querySelectorAll('[data-dsh-h]').forEach((e, k) => {
        if (k < ${take}) e.setAttribute('data-dsh-h', ${JSON.stringify(`f${fi}:`)} + k);
        else e.removeAttribute('data-dsh-h');
      });
      return ${take};
    })()`).catch(() => {})

    for (let k = 0; k < take; k++) {
      elements.push({ i: `f${fi}:${k}`, frame: frameLabel, frameUrl: f.url.slice(0, 100), ...found[k] })
    }
  }

  const byFrame = {}
  for (const e of elements) byFrame[e.frame] = (byFrame[e.frame] ?? 0) + 1

  return {
    count: elements.length,
    truncated: elements.length >= limit,
    byFrame,
    elements,
    note: '这是**这一页所有可点的东西**（含子窗口里的，内容窗口排在前面）。i 是编号，用 cx_click({ i }) 点它。'
      + '看不见文字的图标按钮请结合 cx_shot 截图判断。'
      + '⚠️ 编号只在当前页面有效；一旦翻页/跳转就要重新 cx_dom。',
  }
}

// ── 登录态 ──────────────────────────────────────────────────────────────────
//
// ⚠️ 这里曾经是「章节测验做不了」的元凶之一。
//
// 旧实现只认 `location.hostname === 'i.chaoxing.com'`，或页面文本含「个人空间」。
// 但学习页在 **mooc1.chaoxing.com/mycourse/studentstudy**，两者都不满足
// → 误判成未登录 → cx_run 直接返回 NOT_LOGGED_IN。
// 用户看到的现象是「题目都刷新出来了你也不做」——因为工具在门口就拦住了。
//
// 现在改成「排除法」：只要不在登录页、没有登录表单，就认为已登录。
export async function isLoggedIn(page) {
  const r = await page.eval(`(() => {
    const host = location.hostname;
    if (!/chaoxing\\.com$/.test(host)) return { ok: false, why: 'not-chaoxing:' + host };
    if (/^passport\\d*\\.chaoxing\\.com$/.test(host) || /\\/login/.test(location.pathname)) {
      return { ok: false, why: 'on-login-page' };
    }
    if (document.querySelector('#phone, #pwd, input[name="pwd"]')) {
      return { ok: false, why: 'login-form-present' };
    }
    const t = document.body ? document.body.innerText.slice(0, 3000) : '';
    if (/下次自动登录|新用户注册|扫码登录/.test(t) && !/返回课程|章节详情/.test(t)) {
      return { ok: false, why: 'login-page-text' };
    }
    return { ok: true, why: 'ok', host };
  })()`).catch((e) => ({ ok: false, why: 'eval-failed:' + String(e).slice(0, 80) }))
  return r.ok === true
}

/** 供排错用：返回登录判定的详细理由 */
export async function loginState(page) {
  return page.eval(`(() => {
    const host = location.hostname;
    return {
      href: location.href, host,
      onLoginHost: /^passport\\d*\\.chaoxing\\.com$/.test(host) || /\\/login/.test(location.pathname),
      hasLoginForm: !!document.querySelector('#phone, #pwd, input[name="pwd"]'),
    };
  })()`).catch((e) => ({ error: String(e).slice(0, 100) }))
}

// ── 课程列表 ────────────────────────────────────────────────────────────────
// 结构：外壳页 i.chaoxing.com/base → iframe mooc2-ans .../visit/interaction
// 卡片：div.course#c_<courseId>，内含 input.courseId / input.clazzId / span.course-name / .l-txt 进度
//
// ⚠️ 实测坑：进度是**异步分批加载**的。刚进页面时只有几张卡片带 .l-txt，
// 等一会儿才会有更多。所以必须先等它稳定，否则会误判成"这些课没有任务点"。

export async function waitForCourseListStable(page, { stableMs = 3000, maxMs = 30_000 } = {}) {
  const frame = (await page.frames()).find((f) => f.url.includes('visit/interaction'))
  if (!frame) throw new Error('没找到课程列表 iframe（visit/interaction）')

  const countCards = `document.querySelectorAll('div.course').length`
  const countProgress = `document.querySelectorAll('div.course .l-txt').length`

  const deadline = Date.now() + maxMs
  let last = -1
  let stableSince = Date.now()
  let cards = 0

  while (Date.now() < deadline) {
    const [c, p] = await Promise.all([
      page.evalInFrame(frame.id, countCards).catch(() => 0),
      page.evalInFrame(frame.id, countProgress).catch(() => 0),
    ])
    cards = c
    const sig = `${c}/${p}`
    if (sig !== last) { last = sig; stableSince = Date.now() }
    else if (Date.now() - stableSince >= stableMs) {
      return { cards, withProgress: p, waitedMs: maxMs - (deadline - Date.now()) }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const p = await page.evalInFrame(frame.id, countProgress).catch(() => 0)
  return { cards, withProgress: p, waitedMs: maxMs, timedOut: true }
}

export async function readCourseList(page) {
  // 课程 iframe 是跨域的，用隔离世界读它（不需要页面全局变量）
  const frame = (await page.frames()).find((f) => f.url.includes('visit/interaction'))
  if (!frame) throw new Error('没找到课程列表 iframe（visit/interaction）——可能还没登录或页面未加载完')

  return page.evalInFrame(
    frame.id,
    `(() => {
      const txt = (e) => (e && e.innerText ? e.innerText.replace(/\\s+/g,' ').trim() : '');
      const sectionOf = (card) => {
        let n = card;
        while (n) { if (n.id && /ListDiv|finished|quit|courseList/i.test(n.id)) return n.id; n = n.parentElement; }
        return '(unknown)';
      };
      return [...document.querySelectorAll('div.course')].map(card => {
        const q = (s) => card.querySelector(s);
        const link = q('a[href*="stucoursemiddle"]');
        const url = link ? new URL(link.href) : null;
        const progRaw = txt(q('.l-txt'));
        const m = progRaw.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        return {
          name: (q('span.course-name')?.getAttribute('title') || txt(q('span.course-name')) || '').trim(),
          teacher: txt(q('p.color3')),
          courseId: q('input.courseId')?.value ?? url?.searchParams.get('courseid') ?? null,
          clazzId: q('input.clazzId')?.value ?? url?.searchParams.get('clazzid') ?? null,
          cpi: url?.searchParams.get('cpi') ?? null,
          section: sectionOf(card),
          done: m ? +m[1] : null,
          total: m ? +m[2] : null,
          percent: txt(q('.bar-tip')) || null,
          hasChapterUrl: !!link,
        };
      });
    })()`,
  )
}

// ── 章节树 + 权威进度 ───────────────────────────────────────────────────────
// 返回 { progress: {done,total,raw}, units: [...] }
//
// ⚠️ 进度来源的选择（实测结论）：
//   课程列表页的进度条 div.btm-cover 是**异步且不稳定**的——
//   同一页面在 25 张卡片里只渲染 3~4 个，滚动后还会变；对应接口
//   /mooc2-ans/visit/course-statistic 已 404。**不可依赖。**
//   而章节页头部的「已完成任务点: X/Y」在 5 门课上全部准确 → 用它做权威来源。
export async function readChapterTree(page, course) {
  await page.goto(chapterListUrl(course), { timeoutMs: 30_000 })
  try {
    await page.waitFor(`document.querySelectorAll('.chapter_item[id]').length > 0`, { timeoutMs: 20_000 })
  } catch {
    const t = await page.eval(`(document.body?.innerText || '').replace(/\\s+/g,' ').slice(0, 120)`).catch(() => '')
    const err = new Error(`课程「${course.name}」没有可访问的章节内容（页面显示：${t || '空白'}）`)
    err.code = 'COURSE_EMPTY'
    throw err
  }

  const progress = await page.eval(`(() => {
    const raw = (document.querySelector('.chapter_head')?.innerText || '').replace(/\\s+/g,' ').trim();
    const m = raw.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
    return { raw, done: m ? +m[1] : null, total: m ? +m[2] : null };
  })()`)

  const units = await page.eval(`(() => {
    const txt = (e) => (e && e.innerText ? e.innerText.replace(/\\s+/g,' ').trim() : '');
    return [...document.querySelectorAll('.chapter_unit')].map(u => ({
      unit: txt(u.querySelector('.catalog_name')),
      sections: [...u.querySelectorAll('.chapter_item[id]')].map(e => ({
        domId: e.id,
        chapterId: (e.id.match(/(\\d{6,})/) || [])[1] || null,
        title: e.getAttribute('title') || txt(e),
        onclick: e.getAttribute('onclick'),
        jobCount: (txt(e).match(/(\\d+)\\s*$/) || [])[1] ?? null,
      })),
    })).filter(u => u.sections.length);
  })()`)

  return { progress, units }
}


// ── 任务点 tab ──────────────────────────────────────────────────────────────
export async function readTabs(page) {
  await page.waitFor(`document.querySelectorAll('#prev_tab li').length > 0`, { timeoutMs: 25_000 })
  await new Promise((r) => setTimeout(r, 5000))   // tab 列表会陆续补齐
  return page.eval(`[...document.querySelectorAll('#prev_tab li')].map(li => ({
    title: li.getAttribute('title'),
    cardid: li.getAttribute('cardid'),
    onclick: li.getAttribute('onclick'),
    active: li.classList.contains('active'),
  }))`)
}

// ── 等待模块真正加载完成 ────────────────────────────────────────────────────
//
// ⚠️ 这是本文件最重要的一次修复。
//
// 原来的 switchTab 只固定等 3 秒就往下走。实测发现 **work（章节测验）模块
// 3 秒根本加载不完**——它的内容在 doHomeWorkNew 里，是异步拉的。
// 结果是：题目还没出现就被切到下一个 tab，测验被静默跳过。
//
// 现在的做法：先等模块 iframe 出现，再按模块类型等**内容特征**出现。

const MODULE_READY = {
  // 测验/作业：等到出现题目结构，或明确看到空态/已批阅态。
  // 实测的题目结构：.TiMu（每道题）/ .CeYan（容器）/ .Zy_ulTop（选项列表）
  // ★ 已完成的测验走的是**批阅视图**（selectWorkQuestionYiPiYue），
  //   显示"第1次作答 本次成绩100分"，**没有提交按钮** —— 也必须判为"就绪"，
  //   否则一个已得满分的测验会被报成「模块加载失败」（实测踩过）。
  work: `(() => {
    if (document.readyState !== 'complete') return false;
    if (document.querySelector('.TiMu, .CeYan, .Zy_ulTop')) return true;
    const t = document.body ? document.body.innerText : '';
    if (/题量|满分|多选题|单选题|判断题|填空题|简答题/.test(t)) return true;
    if (/本次成绩|第\\d+次作答|我的答案/.test(t)) return true;   // 已批阅
    if (/暂无|已提交|已完成|未发布|没有/.test(t)) return true;   // 空态也算就绪
    return document.querySelectorAll('input[type=radio],input[type=checkbox],textarea').length > 0;
  })()`,
  // 视频：等到播放器把 duration 读出来
  video: `(() => {
    const v = document.querySelector('video');
    if (!v) return false;
    if (Number.isFinite(v.duration) && v.duration > 0) return true;
    try { const d = videojs.getPlayers().video?.options_?.plugins?.seekBarControl?.duration; return Number(d) > 0 } catch { return false }
  })()`,
  // PDF / 其他：DOM 就绪即可
  pdf: `document.readyState === 'complete' && (document.querySelector('canvas, .pdfViewer, embed, object') !== null || (document.body && document.body.innerText.length > 0))`,
  // 音频（医学英语的 Listening）：原生 <audio>，等到它有 src 就算就绪
  audio: `(() => {
    if (document.readyState !== 'complete') return false;
    const a = document.querySelector('audio');
    if (a && (a.currentSrc || a.src)) return true;
    const t = document.body ? document.body.innerText : '';
    return /时长|播放/.test(t) && t.length > 10;
  })()`,
  // 讨论区：**外壳 frame 是空的**，真正的内容在 bbscircle/chapter 里，
  // 所以这里只要外壳 DOM 就绪即可（内容由 findContentFrame 单独去读）。
  insertbbs: `document.readyState === 'complete'`,
  default: `document.readyState === 'complete' && document.body && document.body.innerText.length > 0`,
}

// 某些模块的**内容**不在外壳 frame 里，而在另一个 frame 里。
// 实测：
//   work     → 题目在 mooc-ans/work/…（外壳 ananas/modules/work/ 是空的）
//   insertbbs→ 讨论在 mooc-ans/bbscircle/chapter（外壳 ananas/modules/insertbbs/ 是空的）
export const MODULE_CONTENT_FRAME = {
  work: /\/mooc-ans\/work\//,
  insertbbs: /bbscircle\/chapter/,
  audio: /modules\/audio\//,
}

/** 在一组候选 frame 里挑「真的有内容」的那个（空 frame 会骗人，见下） */
async function pickContentFrame(page, candidates, { minLen = 40 } = {}) {
  for (const f of candidates) {
    try {
      const n = await page.evalInFrame(f.id, `document.body ? document.body.innerText.trim().length : 0`)
      if (n >= minLen) return f
    } catch { /* frame 正在替换 */ }
  }
  return null
}

// ⚠️ work 模块有两层 frame，而且**外层是空的**：
//     ananas/modules/work/index.html   ← 空壳（innerText 长度 0）
//     mooc-ans/work/<页面>             ← 真正的题目/结果在这里
// 旧实现用 `find(modules/work) ?? find(doHomeWorkNew)`，第一个永远命中空壳，
// `??` 永远不执行 → 读到空内容 → 报「没有题目」。
// 实测数据：doHomeWorkNew 有 471 字符、含「题量: 5」，而 modules/work 是 0 字符。
//
// ★ 而且 mooc-ans/work/ 下的页面**不止一种**：
//     doHomeWorkNew              → 待作答的测验（题干混淆，要截图读题）
//     selectWorkQuestionYiPiYue  → 已提交后的**批阅回顾视图**
//                                  （显示"本次成绩 100 分""我的答案: A"，没有提交按钮）
//   实测：导论2 的测验就是这个视图，其实是**已得满分**。
//   旧的正则只匹配 doHomeWorkNew，于是把已完成的测验报成「模块加载失败」。
const WORK_PAGE = /\/mooc-ans\/work\/|\/ananas\/modules\/work\//

export async function findQuizFrame(page) {
  const frames = await page.frames()
  const cands = frames.filter((f) => WORK_PAGE.test(f.url))
  // 内容页（mooc-ans/work/…）优先于空壳（ananas/modules/work/…）
  cands.sort((a, b) => Number(/\/mooc-ans\/work\//.test(b.url)) - Number(/\/mooc-ans\/work\//.test(a.url)))
  return (await pickContentFrame(page, cands)) ?? cands[0] ?? null
}

/** 找出当前页面里指定类型的模块 frame（没有就返回 undefined） */
async function findModuleFrame(page, moduleType) {
  const frames = await page.frames()
  if (moduleType === 'work') return findQuizFrame(page)
  // 内容在别的 frame 里的模块（讨论区等）
  const contentRe = MODULE_CONTENT_FRAME[moduleType]
  if (contentRe) {
    const hit = frames.filter((f) => contentRe.test(f.url))
    const withContent = await pickContentFrame(page, hit, { minLen: 20 })
    if (withContent) return withContent
    // 内容还没出来 → 退回外壳（让 MODULE_READY 决定是否算就绪）
    return frames.find((f) => f.url.includes(`/ananas/modules/${moduleType}/`)) ?? hit[0] ?? null
  }
  return frames.find((f) => f.url.includes(`/ananas/modules/${moduleType}/`))
}

// ── 读「当前激活的任务点卡片 id」────────────────────────────────────────────
//
// ★ 这是全文件最关键的判据。
//
// 实测（probe-tabswitch）：点击 tab 后，knowledge/cards 里的 `#cardId`
// 会在 ~500ms 内变成该 tab 的 cardid；模块 frame 也随之从 video 换成 work。
//
// 之前我们只等"某个模块 frame 就绪"——而**旧的 video 模块本来就已就绪**，
// 于是函数立刻返回，读到的全是上一个 tab 的陈旧数据。
// 结果：章节测验被识别成视频，用户看到「题目都出来了你为什么不做」。
export async function readActiveCardId(page) {
  const frames = await page.frames()
  const cardsFrames = frames.filter((f) => f.url.includes('knowledge/cards'))
  const seen = []
  for (const cf of cardsFrames) {
    try {
      const id = await page.evalInFrame(cf.id, `document.getElementById('cardId')?.value ?? null`)
      if (id) seen.push({ frameId: cf.id, url: cf.url, cardId: String(id) })
    } catch { /* frame 正在被替换 */ }
  }
  // 多个卡片 frame 同时存在时，取 num 最大的那个（最新的 tab）
  seen.sort((a, b) => {
    const na = Number((a.url.match(/[?&]num=(\d+)/) || [])[1] ?? 0)
    const nb = Number((b.url.match(/[?&]num=(\d+)/) || [])[1] ?? 0)
    return nb - na
  })
  return { active: seen[0]?.cardId ?? null, all: seen }
}

/** 读「当前激活的 tab」（#prev_tab li.active） */
export async function readActiveTab(page) {
  return page.eval(`(() => {
    const li = document.querySelector('#prev_tab li.active');
    return li ? { title: li.getAttribute('title'), cardid: li.getAttribute('cardid') } : null;
  })()`).catch(() => null)
}

// ── 拦截检测：有些状态会让模块内容**永远出不来**，必须早退而不是干等 ──────
//
// ⚠️ 必须用**可见性**判断，不能用「元素存在」。
//    实测：学生页面 DOM 里常驻一堆隐藏遮罩（display:none, 0x0）：
//      #chapterVerificationCode / .AlertCon02 / .maskDiv.jobCountDiv …
//    用存在性判断会把"没弹出来"误判成"验证码弹了"，
//    于是工具停下来叫用户输验证码 —— 而屏幕上根本没有验证码。
//    这个误报曾经让整个章节测验流程卡死。
export async function checkBlockers(page) {
  return page.eval(`(() => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const shown = s.display !== 'none' && s.visibility !== 'hidden'
        && Number(s.opacity) !== 0 && r.width > 2 && r.height > 2;
      return shown ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const bodyText = document.body ? document.body.innerText : '';
    // 验证码：优先看真正的弹窗容器；只有它可见才算
    const captchaDialog = box('#chapterVerificationCode') || box('.AlertCon02');
    const captchaImg = box('#identifyCodeRandom');
    const captchaText = /为保障您的账号安全，请输入验证码/.test(bodyText);
    return {
      captcha: !!(captchaDialog || (captchaImg && captchaText) || captchaText),
      fuse: /本次学习时长已达上限|请休息\\s*\\d+\\s*分钟/.test(bodyText),
      quota: /今日视频(任务点完成数|观看时长)已达上限/.test(bodyText)
        || !!(box('.jobCountDiv') || box('.jobLimitTip') || box('.videoLimitTip')),
      _detail: { captchaDialog, captchaImg, captchaText },
    };
  })()`).catch(() => ({ captcha: false, quota: false, fuse: false }))
}

/**
 * 等某个模块真正可用。
 * @param cardid 若给出，则同时要求 knowledge/cards 的 #cardId 与之匹配
 * @returns {{ ok: boolean, moduleType: string|null, waitedMs: number, reason?: string }}
 */
export async function waitForModule(page, { expectModule, cardid, timeoutMs = 30_000, pollMs = 400 } = {}) {
  const started = Date.now()
  const probe = (mt) => MODULE_READY[mt] ?? MODULE_READY.default
  let lastSeen = null
  let blockerStreak = 0
  let lastBlocker = null

  while (Date.now() - started < timeoutMs) {
    // ⓪ 先看是不是被验证码 / 闸门拦住了。
    //    这类状态下模块 frame 会正常建立、但内容永远出不来 —— 必须早退。
    //    要求**连续两次**检测到才算数，避免被瞬时弹窗误判。
    const b = await checkBlockers(page)
    const kind = b.captcha ? 'CAPTCHA' : b.quota ? 'QUOTA' : b.fuse ? 'FUSE' : null
    if (kind && kind === lastBlocker) {
      blockerStreak++
    } else {
      blockerStreak = kind ? 1 : 0
      lastBlocker = kind
    }
    if (kind && blockerStreak >= 2) {
      const framesNow = await page.frames()
      const mtNow = framesNow.filter((f) => f.url.includes('/ananas/modules/'))
        .map((m) => (m.url.match(/modules\/(\w+)\//) || [])[1]).filter(Boolean)[0] ?? null
      return {
        ok: false,
        blockedBy: kind,
        moduleType: mtNow,
        waitedMs: Date.now() - started,
        reason: kind === 'CAPTCHA'
          ? '页面被章节图形验证码拦住了，模块内容不会加载出来。需要用户手动输入验证码。'
          : kind === 'QUOTA'
            ? '今日额度已达上限，内容不可用。'
            : '单次学习时长已达上限，内容不可用。',
      }
    }

    // ① 若指定了目标卡片，先确认真的切过去了
    if (cardid) {
      const act = await readActiveCardId(page)
      lastSeen = act.active
      if (String(act.active) !== String(cardid)) {
        await new Promise((r) => setTimeout(r, pollMs))
        continue
      }
    }

    // ② 再等模块内容就绪
    const frames = await page.frames()
    const mods = frames.filter((f) => f.url.includes('/ananas/modules/'))
    const present = mods.map((m) => (m.url.match(/modules\/(\w+)\//) || [])[1]).filter(Boolean)
    const mt = expectModule && present.includes(expectModule) ? expectModule : (present[0] ?? null)

    if (mt) {
      const frame = await findModuleFrame(page, mt)
      if (frame) {
        try {
          const ready = await page.evalInFrame(frame.id, probe(mt))
          if (ready) {
            return { ok: true, moduleType: mt, waitedMs: Date.now() - started }
          }
        } catch { /* 模块正在替换，继续等 */ }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }

  const frames = await page.frames()
  const present = frames.filter((f) => f.url.includes('/ananas/modules/'))
    .map((m) => (m.url.match(/modules\/(\w+)\//) || [])[1]).filter(Boolean)
  return {
    ok: false, moduleType: present[0] ?? null, waitedMs: Date.now() - started,
    reason: `等待模块内容超时（${timeoutMs}ms）。当前模块: ${present.join('/') || '无'}`,
  }
}

/**
 * 切换到一个任务点 tab，并确保**真的切过去了**。
 *
 * 这是全流程最容易出错的一步：只等"模块就绪"会在旧模块仍然就绪时立刻返回，
 * 于是读到上一个 tab 的陈旧数据。所以必须用 tab 自己的 cardid 做判据。
 */

// ── 读测验内容（章节测验）───────────────────────────────────────────────────
//
// 实测 DOM 结构（马原 导论1，2025-10 抓取）：
//   .TiMu[data="1"]                              每题
//     .Zy_TItle
//       i[role=option]                           题号
//       div.font-cxsecret.fontLabel              ★ 混淆的题干（自定义字体）
//         span.newZy_TItle 【多选题】
//     ul.Zy_ulTop
//       li.before-after-checkbox[qid][qtype]     选项，onclick="addMultipleChoice(this)"
//         span.num_option_dx[data="A"]           选项字母
//   a.btnSubmit.workBtnIndex onclick="btnBlueSubmit();"    提交
//
// ★ 关键事实：**中文可能被字体混淆，而且范围不固定。**
//
//   实测两种页面：
//     · 独立作业页（马原）：**题干和选项全都乱码**
//         题干   DOM: 主张"世掷上除了擸动着擵擶质之外…「截图：世界上除了运动着的物质…」
//         选项 A DOM: 擽攁人擵意识存在擵敂攂唯物襻擹   「截图：否认人的意识存在的自然唯物主义」
//     · 普通章节页（医学英语）：只有题干乱码，选项正常
//
//   也就是说：**混淆是按页面类型触发的，不能靠个案假设。**
//
//   结论：DOM 里的中文**一律不可信**，所有要读懂的文字都必须靠截图。
//   DOM 只用来判断"有没有内容、什么题型、几个选项、哪一题是填空题"。
export async function readQuizContent(page) {
  const frame = await findQuizFrame(page)
  if (!frame) return { found: false, reason: '没找到测验 frame（doHomeWorkNew / modules/work）' }

  return page.evalInFrame(frame.id, `(() => {
    const txt = (e) => (e && e.innerText ? e.innerText.replace(/\\s+/g,' ').trim() : '');
    const body = document.body ? document.body.innerText : '';

    const qh = body.match(/题量\\s*[:：]\\s*(\\d+)/);
    const fh = body.match(/满分\\s*[:：]\\s*([\\d.]+)/);

    // 逐题解析：选项字母 + DOM 原始文本（**可能乱码，仅供结构判断**）
    //
    // ⚠️ 选项的 DOM 有两种形态，必须都覆盖：
    //   选择题：<li class="before-after-checkbox" onclick="addMultipleChoice(this)" role="checkbox">
    //             <span class="num_option_dx" data="A">A</span> 选项文字
    //   判断题：<li class="font-cxsecret before-after" onclick="addChoice(this)" role="radio">
    //             <span class="num_option" data="true">A</span> <a>对</a>
    //   注意判断题的 data 是 "true"/"false"、没有 x 后缀的 num_option，
    //   用之前那套选择器会**一个选项都抓不到**（实测选项数=0）。
    const questions = [...document.querySelectorAll('.TiMu')].map((q, i) => {
      const stemEl = q.querySelector('.font-cxsecret') || q.querySelector('.Zy_TItle');
      const kind = txt(q.querySelector('.newZy_TItle'));
      const liList = [...q.querySelectorAll('li[onclick], li[role=radio], li[role=checkbox]')];
      const inputCount = q.querySelectorAll('input[type=text], input:not([type]), textarea').length;
      const isTruth = liList.some(li => {
        const d = li.querySelector('[data]')?.getAttribute('data');
        return d === 'true' || d === 'false';
      });
      const opts = liList.map(li => {
        const span = li.querySelector('[data]');
        const dataVal = span ? span.getAttribute('data') : null;
        // 显示字母：优先 span 文本（A/B），判断题里 span 文本也是 A/B
        const letter = (span && txt(span)) || (txt(li).match(/^([A-F])/) || [])[1] || null;
        // 去掉首字母后剩下的就是选项正文
        const label = txt(li).replace(/^[A-F]\\s*/, '');
        return {
          letter, text: label, data: dataVal,
          truth: dataVal === 'true' ? '对' : dataVal === 'false' ? '错' : null,
          // ★ 选中状态看 aria-checked（不要用 className 里的 check 关键字，
          //   基础类名 before-after-checkbox 本身就含 "check"）
          chosen: li.getAttribute('aria-checked') === 'true',
          qid: li.getAttribute('qid'), qtype: li.getAttribute('qtype'),
          role: li.getAttribute('role'),
          onclick: (li.getAttribute('onclick') || '').slice(0, 40),
        };
      });
      return {
        index: i + 1,
        kind: kind || null,
        isTruth,
        // 作答方式：选择题 / 填空题（实测听力练习里就有填空题）
        answerKind: opts.length ? 'choice' : (inputCount ? 'fill' : 'unknown'),
        inputs: inputCount,
        // 题干：DOM 文本是**乱码**，仅用于判断是否有内容
        stemGarbled: txt(stemEl).slice(0, 120),
        stemObfuscated: !!q.querySelector('.font-cxsecret'),
        options: opts,
        hasChecked: !!q.querySelector('li[aria-checked=true]'),
        // 整题的可读文本：批阅视图下含「我的答案：A」「25.0分」
        text: txt(q).slice(0, 500),
      };
    });

    const kinds = [];
    for (const k of ['单选题','多选题','判断题','填空题','简答题']) {
      const n = body.split(k).length - 1;
      if (n > 0) kinds.push({ kind: k, mentions: n });
    }

    const submitBtn = document.querySelector('a.btnSubmit, [onclick*="btnBlueSubmit"]');
    const saveBtn = document.querySelector('a.btnSave, [onclick*="noSubmit"]');
    const emptyState = /暂无|已提交|未发布|没有题目|不存在/.test(body);

    // ── 已提交/已批阅 判定 ──────────────────────────────────────────────
    // 参照样本（导论2，用户已做完，100分）：
    //   URL 结尾 selectWorkQuestionYiPiYue
    //   文本含「第1次作答」「本次成绩100分」，每题带「我的答案：A」「25.0分」
    //   **没有提交按钮**
    const attemptNo = (body.match(/第\\s*(\\d+)\\s*次作答/) || [])[1];
    const gained = (body.match(/本次成绩\\s*([\\d.]+)\\s*分/) || [])[1];
    const reviewed = /selectWorkQuestionYiPiYue/.test(location.href)
      || (attemptNo !== undefined && gained !== undefined)
      || (!submitBtn && questions.length > 0 && questions.some(q => /我的答案/.test(q.text)));
    const myAnswers = questions.map(q => (q.text.match(/我的答案\\s*[:：]\\s*([A-F对错、,，\\s]+?)(?=\\s*[\\d.]+\\s*分|\\s*AI讲解|$)/) || [])[1])
      .map(s => (s || '').replace(/[、,，\\s]/g, '') || null);
    const scores = questions.map(q => (q.text.match(/([\\d.]+)\\s*分/) || [])[1] || null);

    return {
      found: questions.length > 0,
      emptyState,
      // ★ 状态：submitted=true 表示这题已经做完了，不要再答、更不要重复提交
      submitted: !!reviewed,
      attempts: attemptNo ? +attemptNo : null,
      score: gained !== undefined ? +gained : null,
      fullScore: fh ? +fh[1] : null,
      pageKind: /selectWorkQuestionYiPiYue/.test(location.href) ? 'REVIEW_GRADED'
        : /doHomeWorkNew/.test(location.href) ? 'ANSWER' : 'UNKNOWN',
      hasSubmitButton: !!submitBtn,
      title: document.title,
      quizTitle: txt(document.querySelector('.ceyan_name h3')) || null,
      questionCount: qh ? +qh[1] : questions.length || null,
      kinds,
      questions: questions.map((q, i) => ({ ...q, myAnswer: myAnswers[i], score: scores[i] })),
      controls: {
        questions: questions.length,
        options: questions.reduce((a, q) => a + q.options.length, 0),
        textareas: document.querySelectorAll('textarea').length,
        submit: !!submitBtn, save: !!saveBtn,
      },
      submitOnclick: submitBtn ? (submitBtn.getAttribute('onclick') || '') : null,
      obfuscatedStem: questions.some(q => q.stemObfuscated),
      note: reviewed
        ? '该测验**已完成并批阅**（有成绩、无提交按钮），不要重复作答。'
        : '待作答。⚠️ DOM 里的中文**可能全是乱码**（独立作业页连选项一起混淆）→ **题干和选项都必须靠截图读**；DOM 只用来判断题型、选项个数、哪题是填空。',
    };
  })()`)
}


const JOB_TYPES = ['video', 'work', 'pdf', 'audio', 'doc', 'live', 'book', 'vote', 'exam', 'insertbbs', 'zt']

export async function readTaskPoint(page, { cardid } = {}) {
  const frames = await page.frames()
  // ⚠️ 必须按 cardid 选卡片 frame：切 tab 时旧卡片可能还在，
  //    以前取 frames.find(...) 第一个，就会读到上一个 tab 的数据。
  const allCards = frames.filter((f) => f.url.includes('knowledge/cards'))
  let cards = null
  let cardsMismatch = null
  if (cardid) {
    for (const cf of allCards) {
      try {
        const id = await page.evalInFrame(cf.id, `document.getElementById('cardId')?.value ?? null`)
        if (String(id) === String(cardid)) { cards = cf; break }
      } catch { /* 正在替换 */ }
    }
    if (!cards) {
      cardsMismatch = {
        wanted: String(cardid),
        found: allCards.length,
        hint: '没找到 cardId 匹配的卡片 frame —— 说明 Tab 可能没真正切过去',
      }
    }
  } else {
    cards = allCards[0] ?? null
  }

  const modules = frames.filter((f) => f.url.includes('/ananas/modules/'))
  const moduleType = modules.map((m) => (m.url.match(/modules\/(\w+)\//) || [])[1]).filter(Boolean)[0] ?? null

  const out = { moduleType, hasTaskPoint: false, jobType: null, completed: false, condition: null, cardId: null, knowledgeId: null, video: null, cardsMismatch }

  if (cards) {
    Object.assign(out, await page.evalInFrame(cards.id, `(() => {
      const el = document.querySelector('[class*=ans-job-icon]');
      const cls = el ? String(el.className) : null;

      // ★★★ 完成状态只看 aria-label ★★★
      //
      // 实测（医学英语，0/66 的新课）：
      //   <div class="ans-job-icon ans-job-video ans-job-icon-clear"
      //        aria-label="任务点未完成">
      //
      // 也就是说 **ans-job-icon-clear 并不代表"已完成"**（它是样式类）。
      // 我之前拿它当完成标记，结果把一门 0/66 的课里所有视频都判成"已完成"、
      // 全部跳过 —— 看起来一切正常，实际什么都没刷。
      //
      // 权威判据是 aria-label：
      //   "任务点未完成" / "任务点已完成"
      const aria = el ? (el.getAttribute('aria-label') || '') : '';
      const completed = /已完成/.test(aria) && !/未/.test(aria);

      const T = ${JSON.stringify(JOB_TYPES)};
      return {
        hasTaskPoint: !!el,
        jobType: cls ? (T.find(t => new RegExp('ans-job-(?!icon)' + t + '(\\\\s|$)').test(cls)) || null) : null,
        jobRawClass: cls,
        completed,
        completedRaw: aria || null,
        // 样式类只作参考，判断完成**不要**用它
        styleHadClear: cls ? /ans-job-icon-clear/.test(cls) : false,
        condition: el && el.innerText ? el.innerText.replace(/\\s+/g,' ').slice(0, 160) : null,
        cardId: document.getElementById('cardId')?.value ?? null,
        knowledgeId: document.getElementById('knowledgeId')?.value ?? null,
      };
    })()`))
  }

  // 视频：读运行时配置（主世界，能拿到 videojs）
  const vf = frames.find((f) => f.url.includes('modules/video'))
  if (vf) {
    out.video = await page.evalInFrame(vf.id, `(() => {
      try {
        const p = videojs.getPlayers().video;
        const sbc = (p.options_?.plugins?.seekBarControl) || {};
        const sc  = (p.options_?.plugins?.studyControl) || {};
        const sb  = (typeof p.seekBarControl === 'function' ? p.seekBarControl() : p.seekBarControl) || {};
        return {
          enableFastForward: sbc.enableFastForward,
          reportTimeInterval: sbc.reportTimeInterval,
          chapterCapture: sbc.chapterCapture,
          isSupportFace: sbc.isSupportFace,
          silentFaceCapture: sbc.silentFaceCapture,
          duration: sbc.duration,
          objectId: sbc.objectId,
          attachmentId: sbc.attachmentId,
          videoAutoPlay: sbc.videoAutoPlay,
          switchWindow: sc.enableSwitchWindow,
          jumpCount: Array.isArray(sb.jumpTimePointList) ? sb.jumpTimePointList.length : null,
          randomFaceCount: Array.isArray(sb.randomFaceCaptureTimeList) ? sb.randomFaceCaptureTimeList.length : null,
          dom: (() => { const v = document.querySelector('video'); return v ? { paused: v.paused, currentTime: v.currentTime, duration: v.duration } : null })(),
        };
      } catch (e) { return { err: String(e).slice(0, 120) } }
    })()`)
  }

  return out
}

// ── 等测验内容真的加载出来 ──────────────────────────────────────────────────
//
// 实测：测验 tab 切过去之后，`modules/work` 外壳立刻就在，但题目在
// `mooc-ans/work/…` 里还要等一会儿才出来。所以「有 frame」不等于「有题」。
export async function waitForQuizLoaded(page, { timeoutMs = 40_000, pollMs = 700 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const q = await readQuizContent(page).catch(() => null)
    if (q?.found) return { ...q, waitedMs: Date.now() - started }
    const b = await checkBlockers(page).catch(() => ({}))
    if (b?.captcha || b?.fuse || b?.quota) {
      const kind = b.captcha ? 'CAPTCHA' : b.quota ? 'QUOTA' : 'FUSE'
      return { found: false, blockedBy: kind, waitedMs: Date.now() - started,
        reason: `被 ${kind} 拦住，题目不会加载出来` }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  const last = await readQuizContent(page).catch(() => ({ found: false }))
  return { ...last, waitedMs: Date.now() - started, reason: '等待题目加载超时' }
}


// ── 闸门：每日额度 ──────────────────────────────────────────────────────────
// 实测可用；返回 false 表示还没到上限。
export async function checkQuota(page, course, chapterId) {
  try {
    const r = await page.eval(`(async () => {
      const res = await fetch('/mooc-ans/edit/validatejobcount?courseId=${course.courseId}&clazzid=${course.clazzId}&nodeid=${chapterId}',
                                { credentials: 'include' });
      return await res.text();
    })()`)
    const blocked = String(r).trim() === 'true'
    return { ok: !blocked, raw: String(r).trim() }
  } catch (e) {
    return { ok: null, error: String(e).slice(0, 120) }
  }
}

// ── 风险闸门：这个视频能不能碰 ──────────────────────────────────────────────
export function assessRisk(tp) {
  const w = tp.video ?? {}
  if (w.chapterCapture === 1 || w.isSupportFace === true) {
    return { level: 'REFUSE', reason: 'CAMERA', message: '该视频开启了抓拍/人脸识别，自动化无法诚实完成，已跳过' }
  }
  if ((w.jumpCount ?? 0) > 0) {
    return { level: 'CAUTION', reason: 'EMBEDDED_QUIZ', message: `该视频有 ${w.jumpCount} 个内嵌题时间点，播放中会弹题` }
  }
  return { level: 'OK', reason: null, message: null }
}

export const ANOMALY = {
  CAPTCHA: 'CAPTCHA',              // 图形验证码
  FUSE: 'FUSE',                    // 单次学习时长熔断
  QUOTA: 'QUOTA',                  // 今日额度上限
  EMBEDDED_QUIZ: 'EMBEDDED_QUIZ',  // 视频内嵌题
  FACE_CAPTURE: 'FACE_CAPTURE',    // 抓拍/人脸
  POPUP_UNKNOWN: 'POPUP_UNKNOWN',  // 不认识的弹窗
  STALLED: 'STALLED',              // 视频卡住不动
  RATE_CHANGED: 'RATE_CHANGED',    // 播放速度被改动
  SEEK_DETECTED: 'SEEK_DETECTED',  // 进度异常跳变
  LOST: 'LOST',                    // 播放器/页面丢了
}

// ── 读播放器状态 ────────────────────────────────────────────────────────────
//
// ★ 视频和音频走**同一套**逻辑。
//
// 实测（医学英语）：`Listening` 这个任务点的播放器在
//   ananas/modules/audio/index_new.html
// 里面是一个标准 <audio> 元素（时长 1:51），**没有 videojs**。
// 之前只认 modules/video，于是整个听力任务点被当成"其它模块"直接跳过 ——
// 而医学英语里有十几个听力任务点。
//
// 所以这里同时尝试 video / audio 两个模块 frame，并兼容有无 videojs 两种环境。
export const PLAYER_MODULES = ['modules/video', 'modules/audio']

export async function readVideoState(page) {
  try {
    return await evalInFrameMatching(page, PLAYER_MODULES, `(() => {
      const el = document.querySelector('video') || document.querySelector('audio');
      if (!el) return { ok: false, reason: 'no-media-element' };
      const isAudio = el.tagName === 'AUDIO';
      // 内嵌题盖上来时，播放器里会出现这些节点
      const quizVisible = !!(
        document.querySelector('.ans-videoquiz-opt') ||
        document.querySelector('#videoquiz-submit:not([style*="display: none"])') ||
        document.querySelector('.tkTopic_con')
      );
      let rate = el.playbackRate;
      try {
        const p = videojs && videojs.getPlayers ? videojs.getPlayers().video : null;
        if (p && typeof p.playbackRate === 'function') rate = p.playbackRate();
      } catch { /* 音频模块没有 videojs，正常 */ }
      return {
        ok: true,
        media: isAudio ? 'audio' : 'video',
        currentTime: el.currentTime,
        duration: Number.isFinite(el.duration) ? el.duration : null,
        paused: el.paused,
        ended: el.ended,
        playbackRate: rate,
        readyState: el.readyState,
        buffered: el.buffered.length ? el.buffered.end(el.buffered.length - 1) : null,
        muted: el.muted,
        volume: el.volume,
        quizVisible,
      };
    })()`)
  } catch (e) {
    // 没有播放器 frame（例如停在测验 tab）、或 frame 已失效
    return { ok: false, reason: e.code === 'FRAME_NOT_FOUND' ? 'no-player-frame' : `read-failed: ${String(e.message).slice(0, 90)}` }
  }
}

// ── 读风险配置（开播前必查）────────────────────────────────────────────────
export async function readRiskConfig(page) {
  try {
  return await evalInFrameMatching(page, 'modules/video', `(() => {
    try {
      const p = videojs.getPlayers().video
      const sbc = (p.options_?.plugins?.seekBarControl) || {}
      const sc  = (p.options_?.plugins?.studyControl) || {}
      const sb  = (typeof p.seekBarControl === 'function' ? p.seekBarControl() : p.seekBarControl) || {}
      return {
        duration: sbc.duration,
        enableFastForward: sbc.enableFastForward,
        reportTimeInterval: sbc.reportTimeInterval,
        chapterCapture: sbc.chapterCapture,
        isSupportFace: sbc.isSupportFace,
        silentFaceCapture: sbc.silentFaceCapture,
        randomCaptureTime: sbc.randomCaptureTime,
        switchWindow: sc.enableSwitchWindow,
        jumpCount: Array.isArray(sb.jumpTimePointList) ? sb.jumpTimePointList.length : null,
      }
    } catch (e) { return { err: String(e).slice(0, 120) } }
  })()`)
  } catch {
    // 没有 video frame（例如停在测验 tab）→ 返回 null，调用方按"无风险配置"处理
    return null
  }
}


// ── 异常扫描：只查已知的几种，零 token ──────────────────────────────────────
export async function scanAnomalies(page) {
  const found = []

  // 1) 主页面上的弹窗类（验证码 / 熔断 / 额度）
  //
  // ⚠️ 必须用**可见性**判断。学生页面 DOM 里常驻一堆隐藏遮罩
  //    （#chapterVerificationCode / .AlertCon02 / .maskDiv.jobCountDiv，全是 display:none, 0x0）。
  //    旧实现用 `!!document.querySelector('#identifyCodeRandom')` 这种存在性判断，
  //    会把"根本没弹出来"误报成 CAPTCHA，导致整个刷课流程停下来叫人输验证码。
  const main = await page.eval(`(() => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const shown = s.display !== 'none' && s.visibility !== 'hidden'
        && Number(s.opacity) !== 0 && r.width > 2 && r.height > 2;
      return shown ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const bodyText = document.body ? document.body.innerText : '';
    const captchaText = /为保障您的账号安全，请输入验证码/.test(bodyText);
    return {
      captcha: !!(box('#chapterVerificationCode') || box('.AlertCon02') || captchaText),
      quotaPopup: box('.jobCountDiv'),
      jobLimitTip: box('.jobLimitTip'),
      videoLimitTip: box('.videoLimitTip'),
      fuseText: /本次学习时长已达上限|请休息\\s*\\d+\\s*分钟/.test(bodyText),
      quotaText: /今日视频(任务点完成数|观看时长)已达上限/.test(bodyText),
      // 其它不认识的遮挡层（只算真正显示的、且够大的）
      otherMask: [...document.querySelectorAll('.maskDiv, .wmask, .customMaskDiv')]
        .filter(e => { const s = getComputedStyle(e); const r = e.getBoundingClientRect();
                       return s.display !== 'none' && s.visibility !== 'hidden'
                         && r.width > 100 && r.height > 100 })
        .map(e => (e.className || '').toString().slice(0, 60)),
    };
  })()`).catch(() => ({}))

  if (main.captcha) found.push({ type: ANOMALY.CAPTCHA, detail: '出现图形验证码弹窗' })
  if (main.fuseText) found.push({ type: ANOMALY.FUSE, detail: '单次学习时长已达上限' })
  if (main.quotaText || main.jobLimitTip || main.videoLimitTip) found.push({ type: ANOMALY.QUOTA, detail: '今日额度已达上限' })
  if (main.otherMask?.length) found.push({ type: ANOMALY.POPUP_UNKNOWN, detail: `未知遮挡层: ${main.otherMask.join(', ')}` })

  // 2) 播放器里的内嵌题
  const vs = await readVideoState(page)
  if (vs.ok && vs.quizVisible) found.push({ type: ANOMALY.EMBEDDED_QUIZ, detail: '视频内嵌题已弹出，视频被暂停' })

  return found
}

