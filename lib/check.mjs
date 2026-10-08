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
