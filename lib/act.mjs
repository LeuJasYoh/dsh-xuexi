// act.mjs —— ★ 所有「做」操作：执行一个明确指令，不判断该不该做
//
// 分工原则（用户定的）：大模型是司令，本文件是那只「手」。
// 每个函数对应**一个**明确动作：进小节 / 翻页 / 播放 / 作答 / 提交。
// **这里不允许有业务分支** —— 不决定做什么、不决定做完干什么。

import { evalInFrameMatching } from './browser.mjs'
import {
  ANOMALY, findQuizFrame, readActiveCardId, readActiveTab, readRiskConfig, readTaskPoint,
  readTabs, readVideoState, scanAnomalies, waitForModule,
} from './observe.mjs'

// ── 进入小节 ────────────────────────────────────────────────────────────────
// 实测：对 .chapter_item 的**合成鼠标点击无效**，必须调用站点自身的 toOld()。
export async function enterSection(page, course, section) {
  await page.clickOrInvoke(`#${section.domId} .clicktitle`, {
    followUp: `location.href.includes('studentstudy')`,
    timeoutMs: 4000,
  })
  await page.waitFor(`location.href.includes('studentstudy')`, { timeoutMs: 25_000 })
  return page.eval('location.href')
}


export async function switchTab(page, tab, { expectModule, timeoutMs = 40_000 } = {}) {
  if (!tab.onclick) return { ok: false, switched: false, reason: '该 tab 没有 onclick' }
  const target = tab.cardid ? String(tab.cardid) : null

  const before = await readActiveCardId(page)
  await page.eval(`(() => { ${tab.onclick.replace(/;\s*$/, '')}; return true })()`)

  if (!target) {
    // 没有 cardid 就没法验证，只能退化为等模块
    const mod = await waitForModule(page, { expectModule, timeoutMs })
    return { ...mod, switched: null, note: '该 tab 没有 cardid，无法验证是否真的切换成功' }
  }

  const started = Date.now()
  let lastSeen = null
  while (Date.now() - started < timeoutMs) {
    const act = await readActiveCardId(page)
    lastSeen = act.active
    if (String(act.active) === target) {
      const mod = await waitForModule(page, {
        expectModule,
        cardid: target,
        timeoutMs: Math.max(8000, timeoutMs - (Date.now() - started)),
      })
      const activeTab = await readActiveTab(page)
      return {
        ok: mod.ok,
        switched: true,
        cardid: target,
        moduleType: mod.moduleType,
        activeTab: activeTab?.title ?? null,
        waitedMs: Date.now() - started,
        reason: mod.ok ? null : mod.reason,
        previousCardId: before.active,
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  return {
    ok: false,
    switched: false,
    cardid: target,
    previousCardId: before.active,
    waitedMs: Date.now() - started,
    reason: `切换失败：期望 cardId=${target}，${Math.round(timeoutMs / 1000)} 秒后仍读到 ${lastSeen}（说明还停在上一个任务点上）`,
  }
}


// ── 作答章节测验 ────────────────────────────────────────────────────────────
//
// 实测 DOM：每个选项是一个 li，靠**行内 onclick** 干活，不是真 input：
//   <li role="checkbox" class="before-after-checkbox"
//       onclick="addMultipleChoice(this);" qid="411484618" qtype="1">
//     <span class="num_option_dx" data="A">A</span>
//
// 所以要点选，得让 li 自己的 onclick 跑起来。
// 经验：`li.click()` 有时不触发站点自己的处理器（和 .chapter_item 一个毛病），
//       失败就退回**直接调用行内 onclick 表达式**。
export async function answerQuiz(page, { answers } = {}) {
  const frame = await findQuizFrame(page)
  if (!frame) return { ok: false, reason: 'no-quiz-frame' }

  // answers: { 1: ['A','B','C'], 5: ['A'] } —— 键是题号（从 1 开始）
  const plan = JSON.stringify(answers ?? {})

  return page.evalInFrame(frame.id, `(() => {
    const plan = ${plan};
    const out = { applied: [], missed: [] };
    const qs = [...document.querySelectorAll('.TiMu')];

    // ★ 选中判定必须用 aria-checked。
    //   旧实现用 /cur|check|selected|active/ 匹配 className，
    //   而选项的基础类名就叫 "before-after-checkbox" —— 含 "check"，
    //   于是**每个选项都被当成已经选中**，一个都没点。
    const isChosen = (li) => li.getAttribute('aria-checked') === 'true';

    // 统一答案写法：字母 / 对错 / true-false 都接受
    const wantValue = (li, ans) => {
      const span = li.querySelector('[data]');
      const d = span ? span.getAttribute('data') : null;
      const a = String(ans).trim();
      if (d === 'true' || d === 'false') {
        // 判断题：A/对/正确/T/true → true；B/错/错误/F/false → false
        if (/^(A|对|正确|T|TRUE|是)$/i.test(a)) return d === 'true';
        if (/^(B|错|错误|F|FALSE|否)$/i.test(a)) return d === 'false';
        return false;
      }
      return d === a.toUpperCase();
    };

    const clickOption = (li) => {
      const onclick = li.getAttribute('onclick') || '';
      li.click();
      if (!isChosen(li) && onclick) {
        // 退回：直接执行站点自己的行内处理器
        try { (new Function('el', onclick.replace(/\\bthis\\b/g, 'el')))(li); return 'invoke' } catch { return 'invoke-failed' }
      }
      return 'click';
    };

    for (const key of Object.keys(plan)) {
      const i = Number(key) - 1;
      const q = qs[i];
      if (!q) { out.missed.push({ q: key, why: 'no-such-question', total: qs.length }); continue; }

      const lis = [...q.querySelectorAll('li[onclick], li[role=radio], li[role=checkbox]')];

      // ── 填空题：没有可点选项，只有输入框 ──────────────────────────────
      // 实测（医学英语 听力练习 第4题）：题型标注「填空题」，DOM 里没有 li，
      // 而是一个 input[type=text] / textarea。答案直接写进去。
      if (!lis.length) {
        const inputs = [...q.querySelectorAll('input[type=text], input:not([type]), textarea')];
        if (!inputs.length) { out.missed.push({ q: key, why: 'no-options-and-no-input' }); continue }
        plan[key].forEach((val, k) => {
          const inp = inputs[k] ?? inputs[0];
          if (!inp) { out.missed.push({ q: key, val, why: 'not-enough-inputs', inputs: inputs.length }); return }
          inp.focus();
          inp.value = String(val);
          // 触发站点自己的监听（很多框架靠 input/change 事件取值）
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          out.applied.push({ q: key, ans: val, how: 'fill', ok: inp.value === String(val) });
        });
        continue;
      }

      for (const ans of plan[key]) {
        const li = lis.find(l => wantValue(l, ans));
        if (!li) {
          out.missed.push({ q: key, ans, why: 'no-such-option',
            available: lis.map(l => ({ letter: (l.querySelector('[data]')?.innerText || '').trim(),
                                       data: l.querySelector('[data]')?.getAttribute('data') })) });
          continue;
        }
        if (isChosen(li)) { out.applied.push({ q: key, ans, how: 'already' }); continue }
        const how = clickOption(li);
        out.applied.push({ q: key, ans, how, ok: isChosen(li) });
      }
    }
    return out;
  })()`, { awaitPromise: false, returnByValue: true })
}

/** 提交测验（会弹确认框，一并处理） */
export async function submitQuiz(page) {
  const frame = await findQuizFrame(page)
  if (!frame) return { ok: false, reason: 'no-quiz-frame' }

  // ① 点 work frame 里的「提交」按钮
  const clicked = await page.evalInFrame(frame.id, `(() => {
    const btn = document.querySelector('a.btnSubmit, [onclick*="btnBlueSubmit"]');
    if (!btn) return { ok: false, why: 'no-submit-button' };
    if (getComputedStyle(btn).display === 'none') return { ok: false, why: 'submit-hidden' };
    btn.click();
    // 站点自己的提交函数（实测 work frame 里 btnBlueSubmit 是 function）
    try { if (typeof btnBlueSubmit === 'function') btnBlueSubmit() } catch {}
    return { ok: true };
  })()`, { awaitPromise: false, returnByValue: true }).catch((e) => ({ ok: false, why: String(e).slice(0, 100) }))

  if (!clicked.ok) return clicked

  // ② 确认框在**主 frame** 里，不是 work frame。
  //
  //   实测 DOM：
  //     <div class="maskDiv" id="workpop">
  //       <p class="popWord" id="popcontent">确认提交？</p>
  //       <a id="popok" class="jb_btn" role="button">提交</a>
  //
  //   之前在主 frame 里用"文字等于提交/确定"来找，会命中**表单底部那个提交按钮**，
  //   结果确认框一直开着、提交没发生（用户看到的就是「点了没反应」）。
  //   所以这里必须按 id 精确定位。
  let confirmed = null
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 700))
    confirmed = await page.eval(`(() => {
      const shown = (e) => { if (!e) return false; const s = getComputedStyle(e); const r = e.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 5 && r.height > 5; };
      const pop = document.getElementById('workpop');
      const ok = document.getElementById('popok');
      if (!pop || !shown(pop)) return { ok: false, why: 'no-dialog' };
      if (!ok) return { ok: false, why: 'no-popok' };
      ok.click();
      return { ok: true, label: (ok.innerText || '').trim() };
    })()`).catch((e) => ({ ok: false, why: String(e).slice(0, 100) }))
    if (confirmed?.ok) break
  }

  await new Promise((r) => setTimeout(r, 3000))
  return { ok: true, clicked, confirmed }
}
// 三种信息源：知识卡片(有没有任务点/完成条件) + 模块(类型) + 播放器(视频配置)


// ── 开播：优先真实点击「播放」按钮（更像真人），失败退回 play() ────────────
//
// 视频有 .vjs-big-play-button（videojs）；音频模块是原生 <audio>，没有那个按钮，
// 直接走 play() 分支即可。
export async function startPlayback(page) {
  // 先试真实点击大播放按钮（更像真人）
  try {
    const box = await evalInFrameMatching(page, ['modules/video', 'modules/audio'], `(() => {
      const b = document.querySelector('.vjs-big-play-button') || document.querySelector('.play-btn,.audio-play,[class*=playBtn]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`)
    if (box) {
      await page.clickAt(box.x, box.y)
      await new Promise((r) => setTimeout(r, 800))
      const st = await readVideoState(page)
      if (st.ok && st.paused === false) return { ok: true, via: 'click', media: st.media }
    }
  } catch { /* 退回 JS */ }

  // 退回：带 userGesture 的程序化播放（等于播放器自己的播放路径）
  await evalInFrameMatching(page, ['modules/video', 'modules/audio'], `(() => {
    const el = document.querySelector('video') || document.querySelector('audio');
    if (el) { el.play().catch(() => {}); }
    return true;
  })()`)
  await new Promise((r) => setTimeout(r, 1200))
  const st = await readVideoState(page)
  return { ok: st.ok && st.paused === false, via: 'js', media: st.media, state: st }
}


// ── 守护循环 ────────────────────────────────────────────────────────────────
/**
 * 盯着一个视频任务点，直到完成 / 出异常 / 超时。
 *
 * @returns {{
 *   status: 'COMPLETED'|'ANOMALY'|'TIMEOUT'|'REFUSED'|'LOST',
 *   reason?: string, anomalies?: any[], elapsedMs: number, state?: any, progressRatio?: number
 * }}
 */
export async function watchTaskPoint(page, {
  pollMs = 12_000,
  maxMs = 12 * 60_000,
  targetRatio = 0.95,
  onTick,
  signal,
  cardid = null,
  verify = true,
} = {}) {
  const started = Date.now()

  // 开播前必查：人脸/抓拍直接拒绝
  const cfg = await readRiskConfig(page)
  if (cfg && (cfg.chapterCapture === 1 || cfg.isSupportFace === true)) {
    return { status: 'REFUSED', reason: 'CAMERA', detail: '该视频开启抓拍/人脸识别，无法用自动化诚实完成', elapsedMs: 0, config: cfg }
  }

  const started_ = await startPlayback(page)
  if (!started_.ok) {
    return { status: 'LOST', reason: 'PLAY_FAILED', detail: '无法开始播放', elapsedMs: Date.now() - started, state: started_.state }
  }

  let lastTime = -1
  let lastAdvanceAt = Date.now()
  let firstDuration = null
  let baselined = false          // 是否已经拿到第一份"可用的"播放状态
  let resumeJumps = 0            // 断点续播造成的向前跳变次数
  let resumeSeek = null          // 最后一次断点续播的详情

  while (Date.now() - started < maxMs) {
    if (signal?.aborted) return { status: 'TIMEOUT', reason: 'ABORTED', elapsedMs: Date.now() - started }

    // ① 异常扫描
    const anomalies = await scanAnomalies(page)
    if (anomalies.length) {
      return { status: 'ANOMALY', anomalies, elapsedMs: Date.now() - started }
    }

    // ② 播放器状态
    const st = await readVideoState(page)
    if (!st.ok) {
      return { status: 'LOST', reason: st.reason, elapsedMs: Date.now() - started }
    }

    if (firstDuration === null && st.duration) firstDuration = st.duration

    // ②′ 还在加载 → 什么判定都不做，只等。
    //
    // 实测教训：播放器点了播放之后，要**几十秒**才把 duration 读出来
    // （readyState 0 → 4）。这期间 currentTime 恒为 0、paused 已经是 false，
    // 旧实现会误报 STALLED「45 秒没有前进」，把一次正常加载判成故障。
    // 更糟的是：如果视频有断点续播，加载完 currentTime 会瞬间跳到上次的位置
    // （实测 0s → 1922s），又会被误判成「外部拖拽」。
    const loading = !(st.readyState >= 3) || !st.duration
    if (loading) {
      lastAdvanceAt = Date.now()   // 重新计时，别把加载时长算成卡住
      await new Promise((r) => setTimeout(r, pollMs))
      continue
    }

    // 加载完成后的**第一份**有效读数只作为基线，不做跳变/卡住判定
    if (!baselined) {
      baselined = true
      lastTime = st.currentTime
      lastAdvanceAt = Date.now()
    }

    // ③ 原速校验：被改成别的速度立刻纠回（并记录）
    if (st.playbackRate !== null && Math.abs(st.playbackRate - 1) > 0.001) {
      await evalInFrameMatching(page, 'modules/video', `(() => { const v = document.querySelector('video'); if (v) v.playbackRate = 1; try { videojs.getPlayers().video.playbackRate(1) } catch {} ; return true })()`).catch(() => {})
      return {
        status: 'ANOMALY',
        anomalies: [{ type: ANOMALY.RATE_CHANGED, detail: `播放速度被改成 ${st.playbackRate}x，已纠回 1x` }],
        elapsedMs: Date.now() - started,
      }
    }

    // ④ 进度跳变检测
    //
    // ⚠️ 我们从不 set currentTime，所以跳变**一定是别人造成的**。
    //    但"别人"有两种，必须区分：
    //
    //    a) 学习通自己的**断点续播** —— 实测：开播后约 13 秒，播放器向服务端
    //       取回上次进度，然后自己 seek 过去（日志实测 12.7s → 1964.0s）。
    //       这是**正常行为**，之前被误判成"外部拖拽"并中断了整个刷课。
    //    b) 真的被外部拖拽 —— 尤其**向后跳**，或者我们已经在稳定播放时反复跳。
    //
    //    规则：开播 90 秒内的**向前**大跳，判为断点续播（重新建立基线，只记录）；
    //         向后跳、或 90 秒之后还在跳，才算异常。
    if (lastTime >= 0) {
      const delta = st.currentTime - lastTime
      const wallDelta = pollMs / 1000
      const jumped = delta < -1 || delta > wallDelta * 2.5
      if (jumped) {
        const earlyForward = delta > 0 && Date.now() - started < 90_000 && resumeJumps < 3
        if (earlyForward) {
          resumeJumps++
          resumeSeek = { from: +lastTime.toFixed(1), to: +st.currentTime.toFixed(1), atMs: Date.now() - started }
          onTick?.({ ...st, ratio: null, elapsedMs: Date.now() - started, note: `断点续播：${resumeSeek.from}s → ${resumeSeek.to}s` })
          // 重新建立基线，不要拿跳变前后算速度
          lastTime = st.currentTime
          lastAdvanceAt = Date.now()
          await new Promise((r) => setTimeout(r, pollMs))
          continue
        }
        return {
          status: 'ANOMALY',
          anomalies: [{ type: ANOMALY.SEEK_DETECTED, detail: `进度异常跳变 ${lastTime.toFixed(1)}s → ${st.currentTime.toFixed(1)}s（我们从不拖拽，疑似外部干预）` }],
          elapsedMs: Date.now() - started,
        }
      }
    }

    // ⑤ 卡住检测
    if (st.currentTime > lastTime + 0.2) { lastAdvanceAt = Date.now(); lastTime = st.currentTime }
    else if (!st.paused && Date.now() - lastAdvanceAt > 45_000) {
      return {
        status: 'ANOMALY',
        anomalies: [{ type: ANOMALY.STALLED, detail: `视频 45 秒没有前进（currentTime 停在 ${st.currentTime.toFixed(1)}s）` }],
        elapsedMs: Date.now() - started,
      }
    }
    else if (st.paused && !st.ended) {
      // 被暂停了（可能是弹窗抢焦点，或播放器自己停了）→ 重试一次
      await startPlayback(page)
    }

    // ⑥ 完成判定
    const dur = st.duration ?? firstDuration
    const ratio = dur ? st.currentTime / dur : null
    onTick?.({ ...st, ratio, elapsedMs: Date.now() - started })

    if (st.ended || (ratio !== null && ratio >= targetRatio)) {
      // ── ★ 汇报：播完了 ≠ 任务点完成了 ────────────────────────────────
      //
      // 用户明确要求：视频播放完成、**任务点也确实翻成已完成**之后，才汇报给大模型。
      //
      // 实测教训（医学英语 听力）：音频播到 97.6%，但任务点状态纹丝不动。
      // 所以这里必须回读**页面自己的记账**（aria-label），不能拿播放器状态冒充。
      // 服务端记账有延迟，所以轮询几次。
      let verified = null
      let taskPointAfter = null
      if (verify && cardid) {
        for (let k = 0; k < 6; k++) {
          await new Promise((r) => setTimeout(r, 1500))
          taskPointAfter = await readTaskPoint(page, { cardid }).catch(() => null)
          if (taskPointAfter?.completed) break
        }
        verified = taskPointAfter?.completed ?? false
      }
      return {
        status: 'COMPLETED',
        progressRatio: ratio,
        elapsedMs: Date.now() - started,
        state: st,
        resumeSeek,
        // ★ 播放完了，但任务点有没有被服务端记账
        verified,
        taskPointAfter: taskPointAfter
          ? { completed: taskPointAfter.completed, aria: taskPointAfter.completedRaw, moduleType: taskPointAfter.moduleType }
          : null,
        verifyNote: verified === true
          ? '页面已将该任务点标记为「已完成」，可以计入进度。'
          : verified === false
            ? '⚠️ 播放已到 90%+，但页面**仍显示任务点未完成**。可能还需要做同页的其它任务点（例如听力题），或服务端记账延迟。不要直接当成完成。'
            : '未校验（没提供 cardid）。',
      }
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }

  const st = await readVideoState(page)
  const dur = st.duration ?? firstDuration
  return {
    status: 'TIMEOUT',
    reason: `单次守护超过 ${Math.round(maxMs / 60000)} 分钟上限，未播完，可再次调用继续`,
    elapsedMs: Date.now() - started,
    progressRatio: dur ? st.currentTime / dur : null,
    state: st,
  }
}

// ── 翻小节：点小节页底部的「下一节 / 上一节」──────────────────────────────────
//
// 实测：小节页底部有两个按钮，行内 onclick 是
//   PCount.next('...','chapterId','courseId','clazzId','')      → 下一节
//   PCount.previous('...','chapterId','courseId','clazzId','')  → 上一节
//
// 有了它，大模型就能"顺着往下走"，不必每次重读整棵章节树。
export async function navSection(page, { dir = 'next' } = {}) {
  const want = dir === 'prev' || dir === 'previous' ? '上一节' : '下一节'
  const r = await page.eval(`(() => {
    const txt = (e) => (e && e.innerText ? e.innerText.replace(/\\s+/g,' ').trim() : '');
    const btns = [...document.querySelectorAll('a,div')]
      .filter(e => (e.getAttribute('onclick') || '').includes('PCount.'));
    const b = btns.find(e => txt(e) === ${JSON.stringify(want)});
    if (!b) return { ok: false, why: 'no-nav-button', candidates: [...new Set(btns.map(txt))] };
    const oc = b.getAttribute('onclick') || '';
    (new Function(oc))();
    return { ok: true, label: txt(b), onclick: oc.slice(0, 90) };
  })()`).catch((e) => ({ ok: false, why: String(e).slice(0, 130) }))
  if (!r.ok) return r
  await new Promise((x) => setTimeout(x, 5000))
  return {
    ...r,
    url: await page.eval('location.href').catch(() => null),
    tabs: await readTabs(page).catch(() => null),
  }
}
// ═══════════════════════════════════════════════════════════════════════════
// 通用「手」：点击 / 翻页 / 输入
// ═══════════════════════════════════════════════════════════════════════════
//
// 配合 observe.mjs 的 readInteractive()：眼睛先把可点的东西列出来并编号，
// 手负责**照做**。
//
// ⚠️ 这三个函数**不做任何判断** —— 不判断该不该点、点了会怎样。
//    它们只保证"点得准、翻得动、输得进"，并把**实际点了什么**如实回报，
//    好让大模型（和用户）能核对。

/**
 * 找出 `[data-dsh-h="<i>"]` 标记的元素在**哪个窗口**里，以及它是不是主窗口。
 *
 * ⚠️ 为什么要带"是不是主窗口"：`Input.dispatchMouseEvent` 用的是**页面视口坐标**，
 *    而 `getBoundingClientRect()` 给的是**该窗口自己的坐标**。
 *    对子窗口里的元素，两者差着整个 iframe 的偏移 —— 所以子窗口里的元素
 *    **不能**用真实鼠标点击（会点到旁边去，实测"点了没反应"就是这么来的）。
 */
async function locateMarked(page, i) {
  const frames = await page.frames()
  const mainId = frames[0]?.id ?? null
  for (const f of frames) {
    const info = await page.evalInFrame(f.id, `(() => {
      const e = document.querySelector('[data-dsh-h="${String(i)}"]');
      if (!e) return null;
      const txt = (x) => (x.innerText || x.value || x.getAttribute('title') || x.textContent || '').replace(/\\s+/g,' ').trim();
      const r = e.getBoundingClientRect();
      return { tag: e.tagName, text: txt(e).slice(0, 80),
        href: (e.getAttribute('href') || '').slice(0, 200) || null,
        target: e.getAttribute('target') || null,
        onclick: (e.getAttribute('onclick') || '').slice(0, 120) || null,
        visible: r.width > 2 && r.height > 2,
        x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`).catch(() => null)
    if (info) return { frame: f, info, isMain: f.id === mainId }
  }
  return null
}

/**
 * 按 cx_dom 给出的编号点击。
 *
 * 两条路径（因为坐标空间不同）：
 *   · **主窗口**里的元素 → 真实鼠标点击。走浏览器输入管线，触发完整事件链
 *     （mousedown/mouseup/click），能激活需要用户手势的行为。
 *   · **子窗口**里的元素 → 在它自己的窗口里调 `element.click()`。
 *     如果它是 `<a href>` 而点击把**子窗口**导航了、主页面没动，
 *     再退回"把主页面导航到那个 href" —— 因为"点一个链接"的本意
 *     几乎不可能是"只让侧边栏那一小块跳走"。这一步会如实标成 `top-nav`。
 *
 * 无论走哪条，都**如实回报实际点了什么**，好让大模型和用户核对。
 */
export async function clickIndex(page, i, { settleMs = 1500 } = {}) {
  const hit = await locateMarked(page, i)
  if (!hit) return { ok: false, error: 'ELEMENT_NOT_FOUND', i,
    hint: '这个编号已经失效了（页面变了、翻过页，或者上一次 cx_dom 的编号过期）。重新 cx_dom 看一次。' }

  const key = `[data-dsh-h="${String(i)}"]`
  const beforeUrl = await page.eval('location.href').catch(() => null)
  const beforeFrameUrl = hit.frame.url
  let mode = null, note = null

  if (hit.isMain) {
    // ── 主窗口：真实鼠标点击 ─────────────────────────────────────────────
    try {
      await page.click(key)
      mode = 'mouse'
    } catch (e) {
      note = `真实点击失败(${String(e.message).slice(0, 60)})，退回 element.click()`
      const r = await page.evalInFrame(hit.frame.id, `(() => {
        const e = document.querySelector(${JSON.stringify(key)});
        if (!e) return { ok: false, why: 'gone' };
        e.click(); return { ok: true };
      })()`).catch((x) => ({ ok: false, why: String(x).slice(0, 100) }))
      if (r.ok) mode = 'element.click'
      else return { ok: false, error: 'CLICK_FAILED', i, detail: r.why, element: hit.info, frame: '主窗口' }
    }
  } else {
    // ── 子窗口：只能在它自己的窗口里点 ──────────────────────────────────
    const r = await page.evalInFrame(hit.frame.id, `(() => {
      const e = document.querySelector(${JSON.stringify(key)});
      if (!e) return { ok: false, why: 'gone' };
      e.scrollIntoView({ block: 'center' });
      e.click();
      return { ok: true };
    })()`).catch((x) => ({ ok: false, why: String(x).slice(0, 120) }))

    if (!r.ok) {
      // element.click() 不行 → 试执行它自己的 onclick
      const oc = await page.evalInFrame(hit.frame.id, `(() => {
        const e = document.querySelector(${JSON.stringify(key)});
        if (!e) return null;
        const o = e.getAttribute('onclick') || e.closest('[onclick]')?.getAttribute('onclick') || null;
        if (!o) return null;
        try { (new Function(o))(); return o.slice(0, 120) } catch (err) { return null }
      })()`).catch(() => null)
      if (oc) { mode = 'onclick'; note = `onclick: ${oc}` }
      else {
        return { ok: false, error: 'CLICK_FAILED', i, element: hit.info, frame: '子窗口',
          detail: r.why,
          hint: '元素在子窗口里，element.click() 和 onclick 都没走通。截图看看这个元素现在是什么状态。' }
      }
    } else {
      mode = 'element.click(子窗口)'
    }

    await new Promise((x) => setTimeout(x, settleMs))

    // 子窗口内的 <a href>：如果只是子窗口自己跳走了、主页面没动，
    // 这几乎不可能是用户的本意 —— 把主页面也导航过去。
    const midTop = await page.eval('location.href').catch(() => null)
    const midFrame = (await page.frames().catch(() => [])).find((f) => f.id === hit.frame.id)?.url
    if (midTop === beforeUrl && midFrame && midFrame !== beforeFrameUrl && hit.info.href && /^https?:/i.test(hit.info.href)) {
      await page.goto(hit.info.href, { timeoutMs: 25_000 }).catch(() => {})
      mode = mode === 'onclick' ? 'onclick + top-nav' : 'top-nav'
      note = `子窗口自己跳走了，已把主页面也导航到 ${hit.info.href.slice(0, 90)}`
    }
  }

  await new Promise((r) => setTimeout(r, settleMs))
  const afterUrl = await page.eval('location.href').catch(() => null)
  const pages = await page.frames().catch(() => [])
  return {
    ok: true, i, mode, note,
    clicked: hit.info,                       // ★ 如实回报"到底点了什么"
    frame: hit.isMain ? '主窗口' : `子窗口(${hit.frame.url.slice(0, 60)})`,
    urlBefore: beforeUrl, urlAfter: afterUrl,
    navigated: beforeUrl !== afterUrl,
    framesNow: pages.map((f) => f.url.slice(0, 80)),
  }
}

/** 按可见文字点击（找不到唯一匹配就报错，不猜） */
export async function clickText(page, text, { exact = false, timeoutMs = 3000, settleMs = 1500 } = {}) {
  const frames = await page.frames()
  let hit = null, hitsCount = 0
  for (const f of frames) {
    const r = await page.evalInFrame(f.id, `(() => {
      const txt = (e) => (e.innerText || e.value || e.getAttribute('title') || e.textContent || '').replace(/\s+/g,' ').trim();
      const want = ${JSON.stringify(String(text))};
      const all = [...document.querySelectorAll('a, button, input, [onclick], [role="button"], [class*="btn"]')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 3 && r.height > 3; });
      const m = all.filter((e) => ${exact ? 'txt(e) === want' : 'txt(e).includes(want)'});
      return { n: m.length, first: m[0] ? (m[0].setAttribute('data-dsh-h','T'), txt(m[0]).slice(0,80)) : null };
    })()`).catch(() => null)
    if (r && r.n > 0) { hitsCount += r.n; if (!hit) hit = { frame: f, text: r.first } }
  }
  if (!hit) return { ok: false, error: 'TEXT_NOT_FOUND', text, hint: 'cx_dom 看看这一页到底有什么可点的。' }
  if (hitsCount > 1) return { ok: false, error: 'TEXT_AMBIGUOUS', text, hits: hitsCount,
    hint: `有 ${hitsCount} 个元素都含「${text}」，请改用 cx_dom 看编号后用 cx_click({ i })。` }

  const beforeUrl = await page.eval('location.href').catch(() => null)
  try { await page.click('[data-dsh-h="T"]') }
  catch { try { await page.invokeOnclick('[data-dsh-h="T"]') } catch (e) {
    return { ok: false, error: 'CLICK_FAILED', text, detail: String(e.message).slice(0, 140) } } }
  await new Promise((r) => setTimeout(r, settleMs))
  const afterUrl = await page.eval('location.href').catch(() => null)
  return { ok: true, clicked: { text: hit.text }, urlBefore: beforeUrl, urlAfter: afterUrl, navigated: beforeUrl !== afterUrl }
}

/** 按坐标点击（用于截图里看到的、DOM 抓不到的图标按钮） */
export async function clickPoint(page, x, y, { settleMs = 1500 } = {}) {
  const beforeUrl = await page.eval('location.href').catch(() => null)
  await page.clickAt(Number(x), Number(y))
  await new Promise((r) => setTimeout(r, settleMs))
  const afterUrl = await page.eval('location.href').catch(() => null)
  return { ok: true, clicked: { x: Number(x), y: Number(y) }, urlBefore: beforeUrl, urlAfter: afterUrl, navigated: beforeUrl !== afterUrl }
}

/**
 * 翻页 / 滚动。
 *
 * 学习通的 pdf、专题阅读器经常是**自绘的滚动容器**，窗口本身不滚。
 * 所以这里不只滚 window，而是**找到页面上最大的那个可滚动元素**一起滚。
 */
export async function scrollPage(page, { to = 'bottom', px = 800, times = 1, settleMs = 700, frame: onlyFrame = null } = {}) {
  const allFrames = await page.frames().catch(() => [])
  const realF = allFrames.filter((f) => f.url && !/^about:/.test(f.url))
  const frames = realF.length ? realF : allFrames

  const labelOf = (url) => {
    if (/modules\/pdf/.test(url)) return 'PDF模块'
    if (/modules\/zt/.test(url)) return '专题模块'
    if (/modules\/video/.test(url)) return '视频模块'
    if (/modules\/audio/.test(url)) return '音频模块'
    if (/mooc-ans\/work/.test(url)) return '作业/测验'
    if (/knowledge\/cards/.test(url)) return '知识卡片'
    if (/bbscircle|insertbbs/.test(url)) return '讨论区'
    return '主页面'
  }
  const score = (url) => {
    const u = url || ''
    if (/modules\/(pdf|zt)/.test(u)) return 100
    if (/modules\/(video|audio)/.test(u)) return 70
    if (/mooc-ans\/work/.test(u)) return 60
    return 10
  }

  const probe = `(() => {
    const sc = [...document.querySelectorAll('*')].filter((e) => {
      if (e === document.documentElement || e === document.body) return false;
      const s = getComputedStyle(e);
      if (!/(auto|scroll)/.test(s.overflowY)) return false;
      return e.scrollHeight > e.clientHeight + 20;
    }).sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientHeight));
    const el = sc[0] || null;
    const doc = document.documentElement;
    return { hasEl: !!el, className: el ? String(el.className || el.tagName).slice(0, 50) : null,
      winScrollable: doc.scrollHeight > window.innerHeight + 40 };
  })()`

  const candidates = []
  for (const f of frames) {
    const lb = labelOf(f.url)
    if (onlyFrame && lb !== onlyFrame) continue
    const pr = await page.evalInFrame(f.id, probe).catch(() => null)
    if (!pr) continue
    const scrollable = pr.hasEl || pr.winScrollable
    candidates.push({ frame: f, label: lb, score: score(f.url) + (scrollable ? 30 : 0), pr, scrollable })
  }
  candidates.sort((a, b) => b.score - a.score)
  const pick = candidates.find((c) => c.scrollable) || candidates[0]
  if (!pick) return { ok: false, error: 'NO_FRAME', hint: '拿不到任何可滚动的窗口。' }

  const steps = []
  for (let n = 0; n < Math.max(1, Number(times) || 1); n++) {
    const r = await page.evalInFrame(pick.frame.id, `(() => {
      const sc = [...document.querySelectorAll('*')].filter((e) => {
        if (e === document.documentElement || e === document.body) return false;
        const s = getComputedStyle(e);
        if (!/(auto|scroll)/.test(s.overflowY)) return false;
        return e.scrollHeight > e.clientHeight + 20;
      }).sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientHeight));
      const el = sc[0] || null;
      const to = ${JSON.stringify(String(to))}, px = ${Number(px) || 800};
      const before = el ? el.scrollTop : window.scrollY;
      if (to === 'bottom') { if (el) el.scrollTop = el.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); }
      else if (to === 'top') { if (el) el.scrollTop = 0; window.scrollTo(0, 0); }
      else if (to === 'up') { if (el) el.scrollTop -= px; window.scrollBy(0, -px); }
      else { if (el) el.scrollTop += px; window.scrollBy(0, px); }
      const after = el ? el.scrollTop : window.scrollY;
      const h = el ? el.scrollHeight : document.documentElement.scrollHeight;
      const ch = el ? el.clientHeight : window.innerHeight;
      return { before, after, moved: after !== before, height: h, clientHeight: ch, atBottom: after + ch >= h - 8 };
    })()`).catch((e) => ({ error: String(e).slice(0, 120) }))
    steps.push(r)
    await new Promise((x) => setTimeout(x, settleMs))
  }

  const last = steps[steps.length - 1] || {}
  return {
    ok: !last.error, to, times,
    frame: pick.label,
    container: pick.pr?.className ?? null,
    moved: steps.some((s) => s.moved),
    atBottom: last.atBottom ?? null,
    scrollHeight: last.height ?? null,
    clientHeight: last.clientHeight ?? null,
    hint: last.atBottom === false
      ? `还没到底。可以再 cx_scroll 一次。`
      : (last.moved === false ? '没有可滚动的内容，或者已经到底了。' : null),
  }
}
/** 往输入框里写字（按 readInteractive 的编号定位） */
export async function typeInto(page, i, text, { enter = false, settleMs = 500 } = {}) {
  const hit = await locateMarked(page, i)
  if (!hit) return { ok: false, error: 'ELEMENT_NOT_FOUND', i }
  const r = await page.evalInFrame(hit.frame.id, `(() => {
    const e = document.querySelector('[data-dsh-h="${String(i)}"]');
    if (!e) return { ok: false, why: 'gone' };
    const tag = e.tagName;
    if (!/^(INPUT|TEXTAREA)$/.test(tag)) return { ok: false, why: '不是输入框：' + tag };
    const setter = Object.getOwnPropertyDescriptor(tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(e, ${JSON.stringify(String(text))});
    else e.value = ${JSON.stringify(String(text))};
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, now: String(e.value).slice(0, 60) };
  })()`).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }))
  if (!r.ok) return { ok: false, error: 'TYPE_FAILED', i, detail: r.why }
  if (enter) { await page.clickAt(hit.info.x, hit.info.y).catch(() => {}) }
  await new Promise((x) => setTimeout(x, settleMs))
  return { ok: true, i, typed: String(text).slice(0, 60), valueNow: r.now }
}