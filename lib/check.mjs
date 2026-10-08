// check.mjs —— 提交前的机械检查（纯函数，好测）
//
// ═══════════════════════════════════════════════════════════════════════════
//  为什么要有它
//
//  实测（2026-10-08 一次真机会话，7 套章节测验）：
//
//      100  100  100  100       ← 对
//       75   75   40            ← 错
//
//  那次 40 分的根因特别蠢：**这套题有 5 道，模型只给了 4 个答案**
//  （漏了判断题第 5 题），直接提交就被扣了 60 分。
//
//  这不是「判断错了」，是**数漏了** —— 属于机械可查的疏忽。
//  所以由工具兜住：数一遍够不够，不够就退回，别让空题被交上去。
//
//  ⚠️ 边界：这里**只查「有没有回答」，不判断「答得对不对」**。
//     对错是模型的事，工具不越界替它判断。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 检查答案是否覆盖了全部题目。
 *
 * @param {number} total   这套题有几道（来自页面上读到的题量）
 * @param {object} answers { "1": ["A"], "2": ["B","C"], ... }
 * @returns {{ ok: boolean, total: number, missing: number[], empty: number[], extra: number[], detail: object[] }}
 */
export function checkAnswerCoverage(total, answers = {}) {
  const n = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0

  // ⚠️ 题量读不到（0）时**必须放行**。
  //
  //   这是单元测试抓出来的：n=0 时下面每个答案键都会被算成"超出题量"，
  //   于是**所有提交都会被拦死**。而"读不到题量"是我们的读取问题，
  //   不是模型漏答 —— 不能因为自己瞎就卡住人家。
  if (n === 0) {
    return { ok: true, total: 0, missing: [], empty: [], extra: [], detail: [], unchecked: true }
  }

  const missing = []   // 完全没给答案的题号
  const empty = []     // 给了，但选项数组是空的

  for (let i = 1; i <= n; i++) {
    const k = String(i)
    if (!(k in answers)) { missing.push(i); continue }
    const v = answers[k]
    if (!Array.isArray(v) || v.length === 0) empty.push(i)
  }

  // 超出题量的题号 —— 多半是题数数错了，也该拦下来
  const extra = Object.keys(answers)
    .map(Number)
    .filter((x) => Number.isInteger(x) && (x < 1 || x > n))

  const detail = []
  for (let i = 1; i <= n; i++) {
    const v = answers[String(i)]
    detail.push({ q: i, answered: Array.isArray(v) && v.length > 0, picked: Array.isArray(v) ? v : null })
  }

  return { ok: missing.length === 0 && empty.length === 0 && extra.length === 0, total: n, missing, empty, extra, detail }
}

/**
 * 给模型看的、说人话的缺口说明。
 * 返回 null 表示没问题。
 */
export function describeAnswerGap(cov) {
  if (cov.ok) return null
  const parts = []
  if (cov.missing.length) parts.push(`完全没答的是第 ${cov.missing.join('、')} 题`)
  if (cov.empty.length) parts.push(`选了但没选中的是第 ${cov.empty.join('、')} 题`)
  if (cov.extra.length) parts.push(`第 ${cov.extra.join('、')} 题超出了这套题的题量（一共 ${cov.total} 道）`)
  return `**没有提交** —— 这套题有 ${cov.total} 道，你的答案没覆盖全：${parts.join('；')}。`
    + '对着图把每一题都定下来再提交；实在定不下来的用 cx_note 记下来交给用户，**不要空着交**。'
}

// ═══════════════════════════════════════════════════════════════════════════
//  形状检查：答案和题目的「形状」对得上吗
// ═══════════════════════════════════════════════════════════════════════════
//
//  实测（2026-10-08 第三次会话）：
//
//      第 3 题是一道**判断题** —— DOM 上只有 A(对)、B(错) 两个选项。
//      模型却给了 ["A","B","C"]（把它当多选了）。
//
//      旧的守卫**确实拦住了提交**（ANSWER_MISMATCH，没让它交上去，这点是对的），
//      但提示只写了一句「浏览器里选中的与预期不符，请检查题号和选项」——
//      模型没看懂，**改成 ["A"] 重交 → 20 分**。
//
//  所以：把「选项数量 / 题型对不上」也变成**提交前**的机械检查，
//  并且把话说清楚（哪一题、几个选项、实际是哪几个字母）。
//
//  ⚠️ 边界：只查**形状**（字母存不存在、单选给了几个），
//     **不判断选得对不对** —— 那是模型的事。
//     「多选题只给了一个字母」**是合法的**（可能只有一个正确项），所以只提醒、不拦。

/** 单选类：只能选一个 */
function isSingleChoice(q) {
  const k = String(q?.kind ?? '')
  if (q?.isTruth === true) return true
  if (k.includes('判断')) return true
  if (k.includes('单选')) return true
  return false
}

/**
 * @param {Array} questions readQuizContent 给的 questions（带 kind / isTruth / options[].letter）
 * @param {object} answers  { "1": ["A"], "3": ["A","B"] }
 */
export function checkAnswerShape(questions = [], answers = {}) {
  const problems = []
  const notes = []

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] ?? {}
    const n = i + 1
    const picked = answers[String(n)]
    if (!Array.isArray(picked) || picked.length === 0) continue   // 那是覆盖检查的活
    const letters = (q.options ?? []).map((o) => o.letter).filter(Boolean)
    if (!letters.length) continue                                  // 读不到选项就不管

    const bad = picked.filter((x) => !letters.includes(String(x).toUpperCase()))
    if (bad.length) {
      problems.push({
        q: n, kind: q.kind ?? null, type: 'NO_SUCH_OPTION',
        picked, bad, available: letters, optionCount: letters.length,
      })
      continue
    }

    if (isSingleChoice(q) && picked.length > 1) {
      problems.push({
        q: n, kind: q.kind ?? '判断题', type: 'TOO_MANY_FOR_SINGLE',
        picked, available: letters, optionCount: letters.length,
      })
    } else if (String(q.kind ?? '').includes('多选') && picked.length === 1) {
      // 只提醒 —— 多选题只有一个正确项是合法的
      notes.push({ q: n, type: 'ONLY_ONE_FOR_MULTI', picked, optionCount: letters.length })
    }
  }

  return { ok: problems.length === 0, problems, notes }
}

export function describeShapeProblems(res) {
  if (res.ok) return null
  const lines = res.problems.map((p) => {
    if (p.type === 'NO_SUCH_OPTION') {
      return `第 ${p.q} 题：你选了 ${p.bad.join('、')}，但**这题只有 ${p.available.join('、')}，`
        + `共 ${p.optionCount} 个选项**（题型：${p.kind ?? '未知'}）—— 题号或题型看错了。`
    }
    if (p.type === 'TOO_MANY_FOR_SINGLE') {
      return `第 ${p.q} 题是**${p.kind}**，只能选一个，你给了 ${p.picked.join('、')}。`
    }
    return `第 ${p.q} 题形状不对：${JSON.stringify(p)}`
  })
  return '**没有提交** —— 你的答案和题目的形状对不上：\n'
    + lines.map((l) => '  · ' + l).join('\n')
    + '\n对着图**从第 1 题重新数一遍**：这题是判断/单选/多选？有几个选项？'
    + '再把每个答案对齐到正确的题号。**不要靠猜，答案要从图上读出来。**'
}
