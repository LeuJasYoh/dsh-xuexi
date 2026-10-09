/**
 * gate.mjs —— 复核闸门：**纯函数，可单独测**
 *
 * 规则一句话：
 *
 *   三份不一致 → 永远不发票据；
 *   没有票据 → 交不出去。
 *
 * 这一层刻意做成纯函数（不碰浏览器、不碰磁盘），因为它是全站唯一
 * 「做错回不了头」的动作的最后一道闸门 —— 它必须能被反复验证。
 *
 * 三方是谁：
 *   ① 主脑自己 —— 它的答案**不在任何登记表里**，就在页面上
 *      （工具直接读屏幕上的 areas[].filled）
 *   ② grader-1 —— 独立看图，hand_verdict 登记
 *   ③ grader-2 —— 同上，且不知道 grader-1 登记了什么
 *
 * 为什么这么设计（实测教训 1.4.0）：
 *   那一次主脑把判题员的 JSON 原样转发，6 次提交和判题员给的 6 份一字不差 ——
 *   实质只有一份判断，没有任何交叉验证；一个把判断题当多选的错就没人兜住，20 分。
 *   所以主脑的答案必须**落在页面上**：想报一个假答案，它做不到。
 *
 * 为什么不需要 afterReview 布尔（实测教训 1.5.0）：
 *   旧代码是 `不一致 && !afterReview → 拦`，模型传个 true 就放行，
 *   没有任何机制证明"补过特写、重看过"。现在把放行条件换成**可验证的事实**：
 *   复核员用同一身份重新登记（覆盖自己的结论），新结论一致了，才重新发票据。
 */

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** FNV-1a 32 位，稳定、够短、不依赖 crypto */
export function hash32(s) {
  let h = 0x811c9dc5
  const str = String(s)
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * 标签归一化 —— 让"B"、"b"、"B."、"Ｂ"能对上。
 * 复核员写的是图上看得见的标签；页面给的也是标签。两边都要过这一道。
 */
export function normLabel(s) {
  if (s === null || s === undefined) return ''
  let t = String(s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角 → 半角
    .replace(/\s+/g, '')
    .replace(/^[.、．)）:：,\-]+/, '')
    .replace(/[.、．)）:：,\-]+$/, '')
    .trim()
  if (/^[a-z]$/.test(t)) t = t.toUpperCase()
  return t
}

/** 两份标签集合是否一致（不看顺序、不看重复） */
export function samePick(a = [], b = []) {
  const A = [...new Set(a.map(normLabel).filter(Boolean))].sort()
  const B = [...new Set(b.map(normLabel).filter(Boolean))].sort()
  return A.length === B.length && A.every((x, i) => x === B[i])
}

/** 排序后的标签串，用于指纹 */
function pickKey(list = []) {
  return [...new Set(list.map(normLabel).filter(Boolean))].sort().join(',')
}

// ── 对账清单 ────────────────────────────────────────────────────────────────

/**
 * 从这一页的区域里，挑出**需要三方复核**的那几处，编成一号清单。
 *
 * 只有「挑」的题需要交叉验证。
 * 「写」的题只查有没有空白（开放题答案本来就各不相同，比文字没意义）。
 *
 * ⚠️ 清单里**只给结构和编号，不给任何文字** ——
 *    DOM 里的中文可能被字体搅过，给复核员乱码只会带偏它。
 *    文字一律以图为准。
 *
 * 编号 n 是**稳定**的：它在"全部挑的题"里从 1 开始数，
 * 不因为 ignore 了几处而改变 —— 否则主脑和复核员对不上号。
 */
export function buildLedger(areas = [], ignore = []) {
  const skip = new Set(ignore)
  const ledger = []
  let n = 0
  for (const a of areas) {
    if (a.kind !== 'pick') continue
    n += 1
    if (skip.has(n)) continue
    ledger.push({
      n,
      i: a.i,
      kind: 'pick',
      optionsCount: Array.isArray(a.options) ? a.options.length : 0,
      frame: a.frame ?? null,
    })
  }
  return ledger
}

/** 全部挑的题（含被 ignore 的）—— 用来算 n 的边界 */
export function pickAreas(areas = []) {
  return areas.filter((a) => a.kind === 'pick')
}

// ── 复核上下文：eye_check / hand_verdict / hand_submit 三处共用的统一口径 ──────
//
// ★ 2.0.1 修复的缺陷：早先三处各自 buildLedger —— eye_check 带 ignore、
//   另两处不带，算出的清单哈希对不上 → 用了 eye_check({ignore}) 之后
//   复核登记永远查不到（NEED_TWO_REVIEWERS 死循环）、票据永远 STALE_TOKEN。
//   规则定死在这里，三处只能从这里拿：
//     · 题目集合的**身份**（lh）= **全量**清单的哈希 —— ignore 不参与
//       （ignore 只表达"这几处不用复核"，不改变"这是哪一套题"）
//     · ignore 按 lh 存在 ignoreByLh 里：eye_check 写入，另两处读出
//     · ledger（这一轮要复核的那几处）= 全量清单按 ignore 过滤，编号 n 稳定

export function reviewContext(areas = [], ignoreByLh = {}, ignoreArg = undefined) {
  const full = buildLedger(areas)
  const lh = ledgerHash(full)
  const ignore = Array.isArray(ignoreArg) ? [...new Set(ignoreArg)] : (ignoreByLh[lh] ?? [])
  const ledger = buildLedger(areas, ignore)
  return { full, lh, ignore, ledger }
}

/**
 * 找"交完新冒出来的按钮"（比如二次确认框）。
 *
 * ★ 2.0.1 修复的缺陷：早先拿编号 i 跨两次扫描求差集 —— 编号带每次扫描
 *   随机生成的 token 前缀，跨扫描永远对不上 → 每次提交都误报"弹出了确认框"。
 *   改按稳定身份（tag + 可见文字 + href + onclick）比；跳转到新页面时不算 ——
 *   那是新页面自己的按钮，不是确认框。
 */
export function newButtons(before = [], after = [], { navigated = false } = {}) {
  if (navigated) return []
  const key = (b) => [b?.tag ?? '', String(b?.label ?? ''), String(b?.href ?? ''), String(b?.onclick ?? '')].join('|')
  const seen = new Set(before.filter((a) => a?.kind === 'button').map(key))
  return after.filter((a) => a?.kind === 'button' && !seen.has(key(a)))
}

// ── 指纹 ────────────────────────────────────────────────────────────────────

/**
 * 页面指纹：**只用屏幕上的内容**，不用任何业务字段。
 *
 * 变了才算变：又点了一处、又写了一个字、翻了页。
 * 滚动、截图、只读查询**不算变** —— 否则票据会一直作废，模型来回空转。
 *
 * （这一条是评审提的"误判防空转"，我按这个规则落。）
 */
export function pageFingerprint({ targetId, url, areas = [] }) {
  const parts = [String(targetId ?? ''), String(url ?? '')]
  for (const a of areas) {
    parts.push([
      a.i ?? '',
      a.kind ?? '',
      Array.isArray(a.options) ? a.options.length : 0,
      pickKey(Array.isArray(a.filled) ? a.filled : (a.filled ? [a.filled] : [])),
    ].join(':'))
  }
  return hash32(parts.join('|'))
}

/** 清单指纹 —— 用来把登记绑在这一套题上（换题自动作废，常驻复核员也不会串题） */
export function ledgerHash(ledger = []) {
  return hash32(ledger.map((x) => `${x.n}@${x.i}#${x.optionsCount}`).join('|'))
}

// ── 登记簿 ──────────────────────────────────────────────────────────────────

/**
 * 记一条复核结论。
 *
 * ★ 每个复核员只有**一份「当前结论」，每次登记整体覆盖**（不累加）。
 *   上一版我打算用 round 计数去防"重登记被当成第三个人" ——
 *   那是补丁摞补丁。改成"覆盖"之后，那个 bug 自己就消失了。
 *   round 降级成备注，只用来让 eye_check 说出"这处已经重看过一次，仍然不一致"。
 *
 * ★ 身份由调用方（index.js 通过 ctx.agents）判定后传入，**不靠复核员自报**。
 *
 * @returns 新的 store（不改原来的）
 */
export function recordVerdict(store, { ledgerHash: lh, judgeId, picks = {}, uncertain = [], round = 1, note = null, at = Date.now() }) {
  if (!lh || !judgeId) return store
  const next = { ...store, [lh]: { ...(store[lh] ?? {}) } }
  next[lh][judgeId] = { picks, uncertain, round, note, at }
  return next
}

/** 这套题上，有几个**不同身份**的复核员交过结论 */
export function judgeSummary(store, lh) {
  const entries = Object.entries(store[lh] ?? {})
  return {
    registered: entries.length,
    judges: entries.map(([id, v]) => ({ id: id.slice(0, 8), round: v.round })),
    entries: entries.map(([id, v]) => ({ id, ...v })),
  }
}

// ── 三方比对 ────────────────────────────────────────────────────────────────

/**
 * 按处比对：页面（主脑）+ 每一位复核员。
 *
 * @param areas 这一页的全部区域（从中取 filled）
 * @param ledger 对账清单
 * @param entries 复核员登记
 */
export function compareThree(areas = [], ledger = [], entries = []) {
  const byI = new Map(areas.map((a) => [a.i, a]))
  const dissent = []
  const agree = []

  for (const item of ledger) {
    const area = byI.get(item.i)
    const pageLabels = Array.isArray(area?.filled) ? area.filled : (area?.filled ? [area.filled] : [])
    const judges = entries.map((e) => ({
      id: e.id.slice(0, 8),
      labels: e.picks?.[String(item.n)] ?? null,
      uncertain: (e.uncertain ?? []).includes(item.n),
    }))

    const who = [{ id: '你', labels: pageLabels, uncertain: false }, ...judges]
    const bad = who.filter((w) => w.uncertain)
    const answered = who.filter((w) => !w.uncertain && Array.isArray(w.labels))
    const allSame = answered.length === who.length
      && answered.every((w) => samePick(w.labels, pageLabels))

    const row = {
      n: item.n,
      i: item.i,
      page: pageLabels.map(normLabel),
      judges: judges.map((j) => ({ id: j.id, labels: j.labels?.map(normLabel) ?? null, uncertain: j.uncertain })),
      agree: allSame,
    }
    if (allSame && !bad.length) agree.push(row)
    else dissent.push(row)
  }
  return { agree, dissent }
}

// ── 走查七条 ────────────────────────────────────────────────────────────────

export const VERDICTS = [
  'PASS',
  'EMPTY_PICK',        // 挑的地方空着
  'OUT_OF_RANGE',      // 选了页面上没有的项 / 单选选了多个
  'EMPTY_WRITE',       // 写的地方是空的
  'NEED_TWO_REVIEWERS',// 复核员不够两份
  'REVIEWERS_DISSENT', // 三份不一致
  'HAS_UNCERTAIN',     // 有拿不准的没解决
  'NO_SUBMIT_TARGET',  // 交的按钮不在页面上
]

/**
 * 走查七条。**只读事实，不做判断。**
 *
 * 所有失败都会列在 problems 里（一句一句说人话），
 * verdict 取**优先级最高**的那一条，方便模型知道先改哪。
 */
export function checkGate({
  areas = [],
  ledger = [],
  entries = [],
  ignore = [],
  submitButton = null,
  submitFound = true,
} = {}) {
  const problems = []
  const skip = new Set(ignore)
  let n = 0

  // ① 挑的地方：空着 / 选了页面上没有的项 / 单选选了多个
  for (const a of areas) {
    if (a.kind !== 'pick') continue
    n += 1
    const ignored = skip.has(n)
    const labels = Array.isArray(a.filled) ? a.filled : (a.filled ? [a.filled] : [])
    const known = Array.isArray(a.options) ? a.options.map((o) => normLabel(o.label)) : []
    if (!labels.length) {
      if (!ignored) problems.push({ code: 'EMPTY_PICK', n, text: `第 ${n} 处（挑的）还是空的` })
      continue
    }
    const unknown = labels.map(normLabel).filter((l) => l && !known.includes(l))
    if (unknown.length) {
      problems.push({
        code: 'OUT_OF_RANGE', n,
        text: `第 ${n} 处选的 ${unknown.join('/')} 页面上没有 —— 页面上只有 ${known.join('/') || '（读不出标签）'}`,
      })
    }
    if (known.length && labels.length > known.length) {
      problems.push({ code: 'OUT_OF_RANGE', n, text: `第 ${n} 处选了 ${labels.length} 个，可它一共只有 ${known.length} 个选项` })
    }
  }

  // ② 写的地方：是不是空的
  let w = 0
  for (const a of areas) {
    if (a.kind !== 'write') continue
    w += 1
    const val = typeof a.filled === 'string' ? a.filled.trim() : ''
    if (!val) problems.push({ code: 'EMPTY_WRITE', text: `第 ${w} 处（写字的）还是空的` })
  }

  // ③ 复核员够不够两份
  const summary = { registered: entries.length, judges: entries.map((e) => ({ id: e.id.slice(0, 8), round: e.round })) }
  if (entries.length < 2) {
    problems.push({
      code: 'NEED_TWO_REVIEWERS',
      text: `只登记了 ${entries.length} 份复核结论，至少要两份（两个不同的复核员）`,
    })
  }

  // ④ 三份一不一致
  const cmp = compareThree(areas, ledger, entries)
  for (const row of cmp.dissent) {
    const j = row.judges.map((x) => (x.uncertain ? `${x.id}:拿不准` : `${x.id}:${(x.labels ?? []).join('') || '没给'}`)).join('，')
    problems.push({
      code: 'REVIEWERS_DISSENT',
      n: row.n,
      text: `第 ${row.n} 处不一致 —— 你:${row.page.join('') || '空'}，${j}`,
    })
  }

  // ⑤ 有没有拿不准的
  const uncertains = []
  for (const e of entries) for (const u of (e.uncertain ?? [])) uncertains.push({ id: e.id.slice(0, 8), n: u })
  if (uncertains.length) {
    problems.push({
      code: 'HAS_UNCERTAIN',
      text: `还有人拿不准：${uncertains.map((u) => `${u.id} 第 ${u.n} 处`).join('，')} —— 补张特写让它再看一次；实在定不下来就记 pending 交给用户，别猜`,
    })
  }

  // ⑥ 交的按钮在不在
  if (submitButton && !submitFound) {
    problems.push({ code: 'NO_SUBMIT_TARGET', text: '你指定的那个"交"的按钮，在当前页面上找不到（或看不见）' })
  }

  const order = ['NO_SUBMIT_TARGET', 'EMPTY_PICK', 'OUT_OF_RANGE', 'EMPTY_WRITE', 'NEED_TWO_REVIEWERS', 'REVIEWERS_DISSENT', 'HAS_UNCERTAIN']
  let verdict = 'PASS'
  for (const code of order) {
    if (problems.some((p) => p.code === code)) { verdict = code; break }
  }

  return { verdict, pass: verdict === 'PASS', problems, compare: cmp, judges: summary }
}

// ── 票据 ────────────────────────────────────────────────────────────────────

const TOKEN_TTL_MS = 15 * 60_000

/**
 * 发票据。
 *
 * ★ 不一致时**永远不发票据** —— 这里没有 afterReview 布尔后门。
 *   分歧题只能靠"复核员收到特写后重新登记、且新结论一致"重新进入本函数。
 *
 * token 里编进了「页面指纹 + 清单指纹」，所以：
 *   · 页面内容变了 → 指纹变 → 票据自动作废
 *   · 换了一套题   → 清单变 → 票据自动作废（常驻复核员也不会串题）
 */
export function makeToken({ fingerprint, ledgerHash: lh, gate, now = Date.now() }) {
  if (!gate?.pass) return null
  return `tk_${hash32(`${fingerprint}|${lh}`)}_${now.toString(36)}`
}

/** 验票：对得上、且没过期 */
export function verifyToken(token, { fingerprint, ledgerHash: lh, now = Date.now() }) {
  if (typeof token !== 'string' || !token.startsWith('tk_')) {
    return { ok: false, code: 'NEED_REVIEW', text: '没有票据。先跑一次 eye_check 拿票据，再交。' }
  }
  const parts = token.split('_')
  const want = hash32(`${fingerprint}|${lh}`)
  if (parts[1] !== want) {
    return {
      ok: false, code: 'STALE_TOKEN',
      text: '票据对不上现在的页面 —— 说明拿到票据之后你又动过页面（点了、写了、翻页了），或者换了另一套题。重新跑 eye_check。',
    }
  }
  const at = parseInt(parts[2], 36)
  if (!Number.isFinite(at) || now - at > TOKEN_TTL_MS) {
    return { ok: false, code: 'STALE_TOKEN', text: '票据过期了（超过 15 分钟）。重新跑 eye_check。' }
  }
  return { ok: true }
}

export default {
  buildLedger, pickAreas, pageFingerprint, ledgerHash,
  recordVerdict, judgeSummary, compareThree, checkGate,
  makeToken, verifyToken, hash32, normLabel, samePick, reviewContext, newButtons, VERDICTS,
}
