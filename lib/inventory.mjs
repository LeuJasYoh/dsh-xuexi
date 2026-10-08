// inventory.mjs —— ★ 核心：把「当前这一页有什么」如实报告出来
//
// ═══════════════════════════════════════════════════════════════════════════
//  设计原则（用户反复强调的）：
//    **脚本只负责"看"和"做一个明确动作"，判断由大模型现场做出。**
//
//  ⚠️ 这里曾经违反过这条原则，被用户点出来了：
//    旧版给每个 item 打上 `action: 'play'/'answer'/'human'`、`needsHearing: true`、
//    `boundary: "这一页有音频 → 极可能是听力理解题，你没有听觉能力，不要猜…"`
//
//    看起来贴心，实际上**把判断权从大模型手里拿走了** ——
//    Agent 只是照着 action 派活，根本没想。
//
//    现在只报**事实**：
//      · 这一页有几个东西、各自是什么（video / audio / quiz / pdf / …）
//      · 各自的客观状态（是否加载、时长、是否已批阅、题量、题型）
//      · 这一页的环境（有没有音频、有没有视频、DOM 文字是否被混淆）
//
//    「这一页有音频 + 一道填空题」是事实；
//    「所以这是听力题、我做不到、应该交给人」是**大模型的判断** —— 归它。
//
//  一个 tab（页面）**可以有多个任务点**（实测：视频页常常同时挂一个章节测验，
//  听力页同时挂音频 + 听力练习），所以绝对不能假设「一页一个任务点」。

import { detectPageKind, PAGE_KIND, findQuizFrame, readActiveCardId, readActiveTab, readQuizContent } from './observe.mjs'
import { switchTab } from './act.mjs'

export async function inventory(page, { tabs = null, tabIndex = null } = {}) {
  // ── ⓪ 先说清"我站在哪个页面" ─────────────────────────────────────────────
  //
  // 实测教训：本函数是**只为「小节学习页」写的**。停在别的页面时，
  // 它不会报错，而是**平静地报告"什么都没有"** —— 沉默的错误最危险。
  // 所以先识别页面类型；不是小节页就**明说**。
  const pageInfo = await detectPageKind(page)
  if (pageInfo.kind !== PAGE_KIND.SECTION) {
    return {
      pageKind: pageInfo.kind,
      pageLabel: pageInfo.why,
      url: pageInfo.href,
      title: pageInfo.title ?? null,
      chapterItems: pageInfo.chapterItems ?? null,
      tab: null, tabIndex: null, tabsTotal: null, tabs: null, cardId: null,
      items: [], taskPointIcons: null, tpTotal: null, tpUndone: null,
      isSectionPage: false,
      fact: '这一页不是「小节学习页」，所以没有任务点清单。items 为空是**页面类型**的问题，'
        + '不是"这里没任务点"。',
    }
  }

  const frames = await page.frames()
  const items = []
  let t = 0

  const push = (o) => { items.push({ t: t++, ...o }); }

  // ── ① 播放器：video / audio ────────────────────────────────────────────────
  for (const [mod, tag] of [['video', 'video'], ['audio', 'audio']]) {
    const f = frames.find((x) => x.url.includes(`/ananas/modules/${mod}/`))
    if (!f) continue
    const st = await page.evalInFrame(f.id, `(() => {
      const el = document.querySelector('video') || document.querySelector('audio');
      if (!el) return { present: true, ready: false };
      let rate = el.playbackRate, ff = null;
      try {
        const p = videojs && videojs.getPlayers ? videojs.getPlayers().video : null;
        if (p) {
          if (typeof p.playbackRate === 'function') rate = p.playbackRate();
          ff = p.options_?.plugins?.seekBarControl?.enableFastForward ?? null;
        }
      } catch {}
      return {
        present: true, ready: el.readyState >= 1,
        duration: Number.isFinite(el.duration) ? +el.duration.toFixed(1) : null,
        currentTime: +el.currentTime.toFixed(1),
        paused: el.paused,
        ratio: Number.isFinite(el.duration) && el.duration > 0 ? +(el.currentTime / el.duration).toFixed(3) : null,
        playbackRate: rate, enableFastForward: ff,
      };
    })()`, { isolated: false })   // 读 videojs 的播放速率/快进设置 → 必须主世界
      .catch(() => ({ present: true, ready: false, readError: true }))
    push({ kind: mod, module: mod, media: tag, ...st, loaded: !!st.ready })
  }

  // ── ② 测验 / 作业 ─────────────────────────────────────────────────────────
  const quizFrame = await findQuizFrame(page).catch(() => null)
  if (quizFrame) {
    const q = await readQuizContent(page).catch((e) => ({ error: String(e).slice(0, 120) }))
    push({
      kind: 'quiz', module: 'work',
      loaded: q.found === true,
      title: q.quizTitle ?? null,
      // 页面性质：是待作答的答题页，还是已批阅的回顾页 —— 事实，不是建议
      pageKind: q.pageKind ?? null,          // 'ANSWER' | 'REVIEW_GRADED' | …
      questionCount: q.questionCount ?? null,
      fullScore: q.fullScore ?? null,
      submitted: q.submitted ?? null,        // 已经交过、已批阅
      score: q.score ?? null,
      questionKinds: q.kinds ?? null,        // [{kind:'单选题',mentions:2}, …]
      // ★ 事实：DOM 文字可不可信。独立作业页连选项都会被字体混淆，普通章节页可能只有题干。
      domTextObfuscated: q.obfuscatedStem ?? null,
    })
  }

  // ── ③ 讨论区（会出现在页面上，但不一定计任务点）───────────────────────────
  const bbs = frames.find((x) => /bbscircle\/chapter/.test(x.url))
  if (bbs) {
    const preview = await page.evalInFrame(bbs.id, `document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0, 260) : ''`).catch(() => '')
    push({ kind: 'discussion', module: 'insertbbs', preview })
  }

  // ── ④ 其它模块（pdf / zt / …）─────────────────────────────────────────────
  //    报出模块类型即可；recognized=false 说明我们的读取器不认识它 ——
  //    那是**事实**，不是"该怎么办"的判断。
  for (const m of frames.filter((x) => x.url.includes('/ananas/modules/'))) {
    const mt = (m.url.match(/modules\/(\w+)\//) || [])[1]
    if (!mt || ['video', 'audio', 'work', 'insertbbs'].includes(mt)) continue
    push({ kind: mt, module: mt, recognized: false })
  }

  // ── ⑤ 页面自己的任务点记账（图标 + aria）─────────────────────────────────
  //
  // ★ 权威来源是 aria-label（"任务点已完成"/"任务点未完成"），
  //   **不是** ans-job-icon-clear 这个 CSS 类 —— 那个类跟完成毫无关系，
  //   用错会双向出错（漏判已完成的、误判未完成的）。见 docs/学习通事实.md。
  const icons = await page.evalAnywhere(`(() => {
    const txt = (e) => (e && e.innerText ? e.innerText.replace(/\\s+/g,' ').trim() : '');
    const shown = (e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 2 && r.height > 2; };
    return [...document.querySelectorAll('[class*=ans-job-icon]')]
      .filter(shown)
      .map((e, i) => ({
        i,
        kind: (String(e.className).match(/ans-job-(?!icon)(\\w+)/) || [])[1] || null,
        done: /已完成/.test(e.getAttribute('aria-label') || ''),
        aria: e.getAttribute('aria-label') || null,
        inVideoContainer: /videoContainer/.test(String(e.parentElement?.className || '')),
        condition: txt(e).slice(0, 90) || null,
      }));
  })()`, { urlIncludes: 'knowledge/cards' }).then((r) => r?.value ?? null).catch(() => null)

  // 当前标签页 & 这一页的位置 ─────────────────────────────────────────────
  const activeTab = await readActiveTab(page)
  const cardId = (await readActiveCardId(page)).active
  const idx = tabIndex ?? (tabs && activeTab ? tabs.findIndex((x) => x.cardid === activeTab.cardid) : null)

  // ★ 稳定编号 key = "<页面序号>:<本页内编号>"
  //
  // 为什么要有它：t 只在**本页内**有意义。而一个页面可以有好几个任务点、
  // 一节又有好几个页面，大模型想"跨页面直接下指令"就必须有一个**全局唯一**的编号。
  // 有了 key，cx_do({key:"2:1"}) 就能自己切到第 2 页再处理第 1 项。
  const keyOf = (tt) => `${idx ?? 'c'}:${tt}`
  for (const it of items) it.key = keyOf(it.t)

  // ── ⑥ 这一页的环境事实（不下判断，只报事实）─────────────────────────────
  //
  //   "这一页有音频 + 一道填空题"是事实。
  //   "所以这是听力题、我做不到、该交给人" —— 那是**大模型的判断**，归它。
  const pageFacts = {
    hasAudioPlayer: items.some((x) => x.kind === 'audio'),
    hasVideoPlayer: items.some((x) => x.kind === 'video'),
    hasQuiz: items.some((x) => x.kind === 'quiz'),
    hasDiscussion: items.some((x) => x.kind === 'discussion'),
    unknownModules: items.filter((x) => x.recognized === false).map((x) => x.kind),
    domTextObfuscated: items.some((x) => x.domTextObfuscated === true),
    itemTotal: items.length,
  }

  return {
    pageKind: PAGE_KIND.SECTION,
    pageLabel: pageInfo.why,
    url: await page.eval('location.href').catch(() => null),
    tab: activeTab?.title ?? null,
    tabIndex: idx,
    tabsTotal: tabs?.length ?? null,
    tabs: tabs?.map((x, i) => ({ i, title: x.title, cardid: x.cardid })) ?? null,
    cardId,
    isSectionPage: true,
    // ★ 这一页上的东西。t = 本页内编号；key = 跨页唯一编号（推荐用它）
    items,
    // 页面自己的任务点标记（大模型据此判断哪些还没做完）
    taskPointIcons: icons,
    tpTotal: icons?.length ?? null,
    tpUndone: icons ? icons.filter((x) => !x.done).length : null,
    // ★ 这一页的环境事实 —— 让大模型自己推理
    pageFacts,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 整节总览：一次调用报告**这一节所有页面**各自有什么
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么需要它（实测）：一节有 4 个页面时，逐页 cx_tab + cx_page 是 4 个来回；
// 有了它，一次调用拿到完整清单。
//
// ⚠️ 它只**收集事实**：翻页、读、汇总。不判断该做什么。
export async function inventoryAll(page, { tabs, timeoutMs = 40_000 } = {}) {
  if (!tabs || !tabs.length) {
    return {
      ok: false, error: 'NO_TABS',
      fact: '拿不到这一节的页面列表 —— 多半是你不在小节学习页上，或者内容还没渲染出来。',
    }
  }

  const startTab = await readActiveTab(page)
  const perTab = []
  let endedOnTab = null

  for (let i = 0; i < tabs.length; i++) {
    const sw = await switchTab(page, tabs[i], { timeoutMs })
    if (sw.ok === false || sw.switched === false) {
      perTab.push({
        i, title: tabs[i].title, cardid: tabs[i].cardid,
        ok: false, error: sw.blockedBy ? `BLOCKED_${sw.blockedBy}` : 'MODULE_NOT_LOADED',
        detail: sw.reason ?? null,
        items: [], tpTotal: null, tpUndone: null,
      })
      continue
    }
    const inv = await inventory(page, { tabs, tabIndex: i })
    perTab.push({
      i, title: inv.tab ?? tabs[i].title, cardid: tabs[i].cardid,
      ok: true,
      items: inv.items,
      tpTotal: inv.tpTotal,
      tpUndone: inv.tpUndone,
      taskPointIcons: inv.taskPointIcons,
      pageFacts: inv.pageFacts,
    })
    endedOnTab = inv.tab
  }

  const allItems = perTab.flatMap((x) => (x.items ?? []).map((it) => ({ page: x.i, pageTitle: x.title, ...it })))
  const undone = perTab.reduce((n, x) => n + (x.tpUndone ?? 0), 0)

  return {
    ok: true,
    pageKind: 'SECTION',
    sectionUrl: await page.eval('location.href').catch(() => null),
    startedOnTab: startTab?.title ?? null,
    endedOnTab,
    pagesTotal: tabs.length,
    pages: perTab,
    // 整节汇总
    sectionUndone: undone,
    items: allItems.map((it) => ({
      key: it.key, page: it.page, pageTitle: it.pageTitle,
      kind: it.kind, module: it.module,
      loaded: it.loaded ?? undefined,
      title: it.title ?? undefined,
      questionCount: it.questionCount ?? undefined,
      questionKinds: it.questionKinds ?? undefined,
      submitted: it.submitted ?? undefined,
      score: it.score ?? undefined,
      done: it.done ?? undefined,
      domTextObfuscated: it.domTextObfuscated ?? undefined,
    })),
    // ★ 跨页的环境事实
    sectionFacts: {
      hasAudioPlayer: allItems.some((x) => x.kind === 'audio'),
      hasVideoPlayer: allItems.some((x) => x.kind === 'video'),
      hasQuiz: allItems.some((x) => x.kind === 'quiz'),
      hasDiscussion: allItems.some((x) => x.kind === 'discussion'),
      unknownModules: [...new Set(allItems.filter((x) => x.recognized === false).map((x) => x.kind))],
      domTextObfuscated: allItems.some((x) => x.domTextObfuscated === true),
    },
    fact: 'key 的格式是 "<页面序号>:<本页内编号>"。cx_do({key:"2:1", action:"play"}) '
      + '会自己切到第 2 页再动手，不用先 cx_tab。',
  }
}
