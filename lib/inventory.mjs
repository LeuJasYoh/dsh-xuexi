// inventory.mjs —— ★ 核心：把「当前这一页有什么」如实报告出来
//
// 这是整个工具链最重要的一块：一个 tab（页面）**可以有多个任务点**
// （实测：视频页常常同时挂一个章节测验；听力页同时挂音频 + 听力练习）。
// 所以绝对不能让脚本假设「一页一个任务点」。
//
// 返回的是**事实**，不是结论：能用 DOM 读到的就读，读不到就标 unknown / needs-human。

import { detectPageKind, PAGE_KIND, findQuizFrame, readActiveCardId, readActiveTab, readQuizContent } from './observe.mjs'
import { switchTab } from './act.mjs'

// ═══════════════════════════════════════════════════════════════════════════

//
// 设计原则（用户反复强调的）：
//   **脚本只负责"看"和"做一个动作"，判断和循环由大模型来做。**
//
// 以前脚本写死了「一个 tab = 一个任务点」：
//     if (moduleType==='video') 播放
//     else if (moduleType==='work') 答题
//     else 不处理
// 实测证明这是错的 —— 一个 tab 可以同时挂好几个任务点：
//
//   Video 3 这一页：[0] 视频(已完成)  [1] 章节测验「Unit 1 video 3」4题(未完成)
//   Listening 这一页：[0] 音频(未完成) [1] 听力练习 4题(未完成)
//
// 而且同一个 tab 里，一个任务点已完成后**同一页还有别的要做**。
// 所以正确的形态是：脚本把这一页**所有**可做的东西列出来，
// 每个给一个稳定编号 t，由大模型决定做哪个、怎么做。
//
// 返回的是**事实**，不是结论：能用 DOM 读到的就读，读不到就标 unknown/needs-human。

export async function inventory(page, { tabs = null, tabIndex = null } = {}) {
  // ── ⓪ 先说清"我站在哪个页面" ─────────────────────────────────────────────
  //
  // 实测教训：本函数是**只为「小节学习页」写的**。停在别的页面时，
  // 它不会报错，而是**平静地报告"什么都没有"** —— 沉默的错误最危险。
  // 所以先识别页面类型；不是小节页就**明说**，并给出下一步建议。
  const pageInfo = await detectPageKind(page)
  if (pageInfo.kind !== PAGE_KIND.SECTION) {
    return {
      pageKind: pageInfo.kind,
      pageHint: pageInfo.why,
      url: pageInfo.href,
      title: pageInfo.title ?? null,
      chapterItems: pageInfo.chapterItems ?? null,
      tab: null, tabIndex: null, tabsTotal: null, tabs: null, cardId: null,
      items: [], taskPointIcons: null, tpTotal: null, tpUndone: null,
      needsYou: [], beyondMe: null,
      note: '当前不是「小节学习页」，所以没有任务点清单。这不是"这里没任务点"，'
        + '而是"页面类型不对"。请先 cx_enter 进入某个小节；想先看课程结构就用 cx_chapters。',
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
    })()`).catch(() => ({ present: true, ready: false, error: true }))
    push({ kind: mod, module: mod, media: tag, ...st, loaded: !!st.ready, action: 'play' })
  }

  // ── ② 测验 / 作业 ─────────────────────────────────────────────────────────
  const quizFrame = await findQuizFrame(page).catch(() => null)
  if (quizFrame) {
    const q = await readQuizContent(page).catch((e) => ({ error: String(e).slice(0, 120) }))
    push({
      kind: 'quiz', module: 'work', action: q.submitted ? 'none' : 'answer',
      loaded: q.found === true,
      title: q.quizTitle ?? null, pageKind: q.pageKind ?? null,
      questions: q.questionCount ?? null, fullScore: q.fullScore ?? null,
      submitted: q.submitted ?? null, score: q.score ?? null,
      kinds: q.kinds ?? null,
      obfuscatedStem: q.obfuscatedStem ?? null,
      note: q.found !== true
        ? '测验 frame 在，但内容还没加载出来。调 cx_do(t,"read") 会等它加载并返回题目。'
        : q.submitted ? '已完成并批阅，不要重做'
          : '待作答。⚠️ DOM 中文可能全是乱码（独立作业页连选项一起混淆）→ **题干和选项都要靠截图读**；DOM 只用于判断题型与选项个数。',
    })
  }

  // ── ③ 讨论区（不是任务点，但会出现在页面上）────────────────────────────────
  const bbs = frames.find((x) => /bbscircle\/chapter/.test(x.url))
  if (bbs) {
    const preview = await page.evalInFrame(bbs.id, `document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0, 260) : ''`).catch(() => '')
    push({
      kind: 'discussion', module: 'insertbbs', action: 'human',
      preview,
      note: '讨论帖。这一页没有对应任务点标记（不计入进度）→ 归用户，不要自动发帖',
    })
  }

  // ── ④ 其它已知模块 ────────────────────────────────────────────────────────
  for (const m of frames.filter((x) => x.url.includes('/ananas/modules/'))) {
    const mt = (m.url.match(/modules\/(\w+)\//) || [])[1]
    if (!mt || ['video', 'audio', 'work', 'insertbbs'].includes(mt)) continue
    push({ kind: mt, module: mt, action: 'unknown', note: `模块类型 ${mt} 尚无处理规则，需要判断` })
  }

  // ── ⑤ 页面自己的任务点记账（图标 + aria）─────────────────────────────────
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

  // ── ⑥ 能力边界：有些东西**大模型本质上做不到**，必须交给用户 ───────────
  //
  // 用户明确指出的：**听力题我没有听力能力，不要急着处理。**
  //
  // 工具能点按钮，不代表我们应该去点。判断依据是"这件事需不需要人的感官"：
  //   · 音频 + 同页有测验  → 极可能是**听力理解题**，答案在音频里 → 我做不到
  //   · 之后还会遇到别的情况（需要看图的、需要现场判断的），同样标出来
  //
  // 这里只**标注**，不代替大模型下结论 —— 万一有的题靠常识就能答，模型可以自己判断。
  const hasAudio = items.some((x) => x.kind === 'audio')
  if (hasAudio) {
    for (const it of items) {
      if (it.kind !== 'quiz') continue
      it.needsHearing = true
      it.action = 'human'
      it.boundary = '这一页有音频播放器 → 极可能是听力理解题，答案在音频里。'
        + '**你没有听觉能力，不要猜答案。** 用 action="human" 交给用户。'
        + '如果你的选项文本里能明确看出是常识题（不依赖音频内容），再考虑 answer 并说明理由。'
    }
  }

  // 当前标签页 & 这一页的位置 ─────────────────────────────────────────────
  const activeTab = await readActiveTab(page)
  const cardId = (await readActiveCardId(page)).active
  const idx = tabIndex ?? (tabs && activeTab ? tabs.findIndex((x) => x.cardid === activeTab.cardid) : null)

  // ★ 稳定编号 key = "<页面序号>:<本页内编号>"
  //
  // 为什么要有它：t 只在**本页内**有意义。而一个页面可以有好几个任务点、
  // 一节又有好几个页面，大模型想"跨页面直接下指令"就必须有一个**全局唯一**的编号。
  // 有了 key，cx_do({key:"2:1"}) 就能自己切到第 2 页再处理第 1 项，
  // 不用先 cx_tab 再 cx_do 两步走。
  const keyOf = (tt) => `${idx ?? 'c'}:${tt}`
  for (const it of items) it.key = keyOf(it.t)

  return {
    pageKind: PAGE_KIND.SECTION,
    pageHint: pageInfo.why,
    url: await page.eval('location.href').catch(() => null),
    tab: activeTab?.title ?? null,
    tabIndex: idx,
    tabsTotal: tabs?.length ?? null,
    tabs: tabs?.map((x, i) => ({ i, title: x.title, cardid: x.cardid })) ?? null,
    cardId,
    // ★ 这一页可以"做"的东西。t = 本页内编号；key = 跨页唯一编号（推荐用它）
    items,
    // 页面自己的任务点标记（大模型据此判断哪些还没做完）
    taskPointIcons: icons,
    tpTotal: icons?.length ?? null,
    tpUndone: icons ? icons.filter((x) => !x.done).length : null,
    // 本页尚无处理规则的提示
    needsYou: items.filter((x) => x.action === 'human' || x.action === 'unknown')
      .map((x) => ({ t: x.t, key: x.key, kind: x.kind, why: x.boundary ?? x.note })),
    // ★ 能力边界：这一页有没有**你（大模型）本质上做不到**的事
    beyondMe: items.some((x) => x.needsHearing)
      ? '这一页有听力题 —— 你没有听觉能力，答案只能靠人听。**不要猜答案**，用 cx_do(t,"human") 交给用户。'
      : null,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 整节总览：一次调用报告**这一节所有页面**各自有什么
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么需要它（实测）：
//
//   医学英语 Unit 1 小节 2 有 4 个页面（Video 3 / Video 4 / Listening / Discussion）。
//   为了看清整节，我只能 cx_tab(0) → 看 → cx_tab(1) → 看 → cx_tab(2) → 看 → cx_tab(3) → 看，
//   **四次调用、四个来回**，大模型还得自己把四份结果拼起来。
//
//   有了它：一次调用，拿到一张完整清单，直接决定"先做哪个、哪个交给人"。
//
// 代价：每翻一个页面要等它加载（几秒）。但**一次工具调用换四次**，对 Agent 是净赚。
//
// ⚠️ 它只**收集事实**：翻页、读、汇总。不判断该做什么 —— 那是大模型的事。
export async function inventoryAll(page, { tabs, timeoutMs = 40_000 } = {}) {
  if (!tabs || !tabs.length) {
    return { ok: false, error: 'NO_TABS', hint: '拿不到这一节的页面列表，先用 cx_enter 进入某个小节。' }
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
      beyondMe: inv.beyondMe,
    })
    endedOnTab = inv.tab
  }

  const allItems = perTab.flatMap((x) => (x.items ?? []).map((it) => ({ page: x.i, pageTitle: x.title, ...it })))
  const todo = allItems.filter((it) => it.action !== 'done' && it.action !== 'graded')
  const undone = perTab.reduce((n, x) => n + (x.tpUndone ?? 0), 0)

  return {
    ok: true,
    pageKind: 'SECTION',
    sectionUrl: await page.eval('location.href').catch(() => null),
    startedOnTab: startTab?.title ?? null,
    endedOnTab,
    pagesTotal: tabs.length,
    pages: perTab,
    // ★ 整节汇总：一眼看完这一节还剩什么
    sectionUndone: undone,
    items: allItems.map((it) => ({
      key: it.key, page: it.page, pageTitle: it.pageTitle,
      kind: it.kind, action: it.action, done: it.done ?? null,
      title: it.title ?? null, questions: it.questions ?? null,
      needsHearing: it.needsHearing ?? undefined,
    })),
    needsYou: allItems.filter((x) => x.action === 'human')
      .map((x) => ({ key: x.key, page: x.page, kind: x.kind, why: x.boundary ?? x.note })),
    note: '这是**整节总览**。key 的格式是 "<页面序号>:<本页内编号>"，'
      + '直接 cx_do({key:"2:1", action:"play"}) 就行 —— 它会自己切到第 2 页，不用先 cx_tab。',
  }
}

