/**
 * test/run.mjs —— 断言集
 *
 * 分五组：
 *   A 参数校验（args.mjs）  —— 格式错必须拦住，且**零副作用**
 *   B 复核闸门（gate.mjs）  —— 七条 + 票据 + 登记覆盖
 *   C 工具表面             —— 15 个工具、前缀、并发标志
 *   D 痕迹检查             —— 代码/提示词里不许有平台字样
 *   E 预设自检             —— cordis.patch.yml / package.json / 提示词对得上
 *
 * 跑法：npm test
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0
const fails = []

function t(name, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass++
  } catch (e) {
    fails.push(`${name}\n      ${String(e?.message ?? e).split('\n')[0]}`)
  }
}
function ta(name, cond, extra = '') {
  try {
    if (!cond) throw new Error(extra || '断言不成立')
    pass++
  } catch (e) {
    fails.push(`${name}\n      ${String(e?.message ?? e).split('\n')[0]}`)
  }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ?? ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`) }

const A = await import('../lib/args.mjs')
const G = await import('../lib/gate.mjs')

// ═══════════════════════════════════════════════════════════════════════════
// A 参数校验
// ═══════════════════════════════════════════════════════════════════════════

t('A1 定位都不给 → ARG', () => {
  const r = A.checkArgs('hand_click', {})
  eq(r.ok, false); eq(r.category, 'ARG')
})
t('A2 定位混着给 → ARG', () => {
  const r = A.checkArgs('hand_click', { i: 'r1', x: 1, y: 2 })
  eq(r.ok, false); eq(r.category, 'ARG')
})
t('A3 业务概念（题号）→ ARG，且话说明白', () => {
  const r = A.checkArgs('hand_click', { 题号: 1 })
  eq(r.ok, false); eq(r.category, 'ARG')
  ta('A3b 提示里点出这个键', r.error.includes('题号'), r.error)
})
t('A4 坐标不是数字 → ARG', () => {
  eq(A.checkArgs('hand_click', { x: 'a', y: 2 }).ok, false)
  eq(A.checkArgs('hand_click', { x: NaN, y: 2 }).ok, false)
})
t('A5 text 定位通过', () => {
  const r = A.checkArgs('hand_click', { text: '提交' })
  eq(r.ok, true); eq(r.args.loc.text, '提交')
})
t('A6 settleMs 超范围 → ARG', () => eq(A.checkArgs('hand_click', { i: 'r1', settleMs: 99999 }).ok, false))
t('A7 eye_shot: full 和 clip 不能同时给', () => {
  const r = A.checkArgs('eye_shot', { full: true, clip: { x: 0, y: 0, width: 10, height: 10 } })
  eq(r.ok, false); eq(r.category, 'ARG')
})
t('A8 eye_shot: clip 宽高必须 > 0', () => eq(A.checkArgs('eye_shot', { clip: { x: 0, y: 0, width: 0, height: 10 } }).ok, false))
t('A9 eye_shot 正常', () => eq(A.checkArgs('eye_shot', {}).args.full, false))

t('A10 hand_pick: set 但没给选项 → USAGE（页面没动）', () => {
  const r = A.checkArgs('hand_pick', { area: { i: 'r1' }, mode: 'set' })
  eq(r.ok, false); eq(r.category, 'USAGE')
})
t('A11 hand_pick: clear 却给了选项 → USAGE', () => eq(A.checkArgs('hand_pick', { area: { i: 'r1' }, choose: [{ i: 'o1' }], mode: 'clear' }).ok, false))
t('A12 hand_pick: choose 不是数组 → ARG', () => eq(A.checkArgs('hand_pick', { area: { i: 'r1' }, choose: 'o1' }).ok, false))
t('A13 hand_pick 正常', () => {
  const r = A.checkArgs('hand_pick', { area: { i: 'r1' }, choose: [{ i: 'o1' }, { text: 'B' }], mode: 'set' })
  eq(r.ok, true); eq(r.args.choose.length, 2)
})

t('A14 hand_write: 缺 text → ARG', () => eq(A.checkArgs('hand_write', { area: { i: 'r1' } }).ok, false))
t('A15 hand_write 正常', () => eq(A.checkArgs('hand_write', { area: { i: 'r1' }, text: 'x' }).args.mode, 'replace'))

t('A16 hand_goto: 什么都没给 → ARG', () => eq(A.checkArgs('hand_goto', {}).ok, false))
t('A17 hand_goto: 给两件 → ARG', () => eq(A.checkArgs('hand_goto', { url: 'https://a.com', back: true }).ok, false))
t('A18 hand_goto: url 协议不对 → ARG', () => eq(A.checkArgs('hand_goto', { url: 'a.com' }).ok, false))
t('A19 hand_goto back 正常', () => eq(A.checkArgs('hand_goto', { back: true }).args.back, true))

t('A20 hand_tab: i/id 同时给 → ARG', () => eq(A.checkArgs('hand_tab', { i: 0, id: 'x' }).ok, false))
t('A21 hand_tab: 都不给 → ARG', () => eq(A.checkArgs('hand_tab', {}).ok, false))
t('A22 hand_tab: i 不是整数 → ARG', () => eq(A.checkArgs('hand_tab', { i: 1.5 }).ok, false))

t('A23 hand_play: 默认 12 分钟', () => eq(A.checkArgs('hand_play', {}).args.maxMinutes, 12))
t('A24 hand_play: 0 分钟 → ARG', () => eq(A.checkArgs('hand_play', { maxMinutes: 0 }).ok, false))

t('A25 hand_submit: confirm 不是 true → USAGE', () => {
  const r = A.checkArgs('hand_submit', { confirm: false, reviewed: 'tk', button: { i: 'b1' } })
  eq(r.ok, false); eq(r.category, 'USAGE')
})
t('A26 hand_submit: 缺票据 → ARG', () => eq(A.checkArgs('hand_submit', { confirm: true, button: { i: 'b1' } }).ok, false))
t('A27 hand_submit: 缺按钮 → ARG', () => eq(A.checkArgs('hand_submit', { confirm: true, reviewed: 'tk' }).ok, false))
t('A28 hand_submit 正常', () => eq(A.checkArgs('hand_submit', { confirm: true, reviewed: 'tk_1', button: { i: 'b1' } }).ok, true))

t('A29 hand_note: 什么都没说 → ARG', () => eq(A.checkArgs('hand_note', {}).ok, false))
t('A30 hand_note: 同时 add+read → ARG', () => eq(A.checkArgs('hand_note', { add: 'x', read: true }).ok, false))
t('A31 hand_note add 正常（tag 默认 general）', () => {
  const r = A.checkArgs('hand_note', { add: 'x' })
  eq(r.ok, true); eq(r.args.tag, 'general')
})

t('A32 hand_verdict: 键写成"第3题" → ARG，并点明是"第几处"', () => {
  const r = A.checkArgs('hand_verdict', { picks: { 第3题: ['A'] } })
  eq(r.ok, false); eq(r.category, 'ARG')
  ta('A32b 提示说是第几处', /第几处/.test(r.error + (r.expected ?? '')), r.error)
})
t('A33 hand_verdict: 值是字符串不是数组 → ARG', () => eq(A.checkArgs('hand_verdict', { picks: { 1: 'A' } }).ok, false))
t('A34 hand_verdict: 空登记 → USAGE', () => eq(A.checkArgs('hand_verdict', { picks: {} }).ok, false))
t('A35 hand_verdict 正常', () => eq(A.checkArgs('hand_verdict', { picks: { 1: ['B'] } }).ok, true))

t('A36 不认识的工具 → 不拦（内部用）', () => eq(A.checkArgs('nope', {}).ok, true))

// ── ★ 零副作用：结构保证 ───────────────────────────────────────────────────
t('A37 args.mjs 是纯的（不 import 任何东西）', () => {
  const src = read('lib/args.mjs')
  ta('A37b 没有 import 语句', !/^\s*import\s/m.test(src))
})
t('A38 index.js 里 checkArgs 一定排在做事之前', () => {
  const src = read('index.js')
  const iCheck = src.indexOf('const chk = checkArgs(')
  const iRun = src.indexOf('await def.run(chk.args, exec)')
  ta('A38b 两处都在', iCheck > 0 && iRun > 0)
  ta('A38c 校验在前、干活在后', iCheck < iRun, `checkArgs@${iCheck} run@${iRun}`)
  ta('A38d 校验失败直接 return（不往下走）', /if \(!chk\.ok\) return chk/.test(src))
})

// ═══════════════════════════════════════════════════════════════════════════
// B 复核闸门
// ═══════════════════════════════════════════════════════════════════════════

const areaPick = (i, n = 4, filled = []) => ({
  i, kind: 'pick', label: '…', frame: '主页面', done: false,
  options: Array.from({ length: n }, (_, k) => ({ i: `${i}o${k}`, label: 'ABCD'[k], text: '', selected: filled.includes('ABCD'[k]) })),
  filled,
})
const areaWrite = (i, filled = '') => ({ i, kind: 'write', label: '…', frame: '主页面', done: false, filled })

const AREAS = [
  areaPick('r1', 4, ['B']),
  areaWrite('r2', '实践是检验真理的唯一标准'),
  areaPick('r3', 2, ['A']),
]

t('B1 对账清单只收「挑」的，且编号按全部挑的题数（跳过写的）', () => {
  const l = G.buildLedger(AREAS)
  eq(l.length, 2)
  eq(l[0].n, 1); eq(l[0].i, 'r1')
  eq(l[1].n, 2); eq(l[1].i, 'r3')
})
t('B2 清单里不给任何文字（只给结构）', () => {
  const l = G.buildLedger(AREAS)
  ta('B2b 没有 label 字段', !('label' in l[0]))
  ta('B2c 没有选项文字', !('options' in l[0]))
  eq(l[0].optionsCount, 4)
})
t('B3 ignore 不改变编号（否则主脑和复核员对不上）', () => {
  const l = G.buildLedger(AREAS, [1])
  eq(l.length, 1)
  eq(l[0].n, 2)      // 仍然是 2，不是 1
  eq(l[0].i, 'r3')
})

t('B4 页面内容变了 → 指纹变', () => {
  const a = G.pageFingerprint({ targetId: 'T', url: 'u', areas: AREAS })
  const b = G.pageFingerprint({ targetId: 'T', url: 'u', areas: [areaPick('r1', 4, ['C']), AREAS[1], AREAS[2]] })
  ta('B4b 不一样', a !== b)
})
t('B5 没变就不变（滚动/截图不该作废票据）', () => {
  const a = G.pageFingerprint({ targetId: 'T', url: 'u', areas: AREAS })
  const b = G.pageFingerprint({ targetId: 'T', url: 'u', areas: JSON.parse(JSON.stringify(AREAS)) })
  eq(a, b)
})
t('B6 换一套题 → 清单指纹变（常驻复核员不串题）', () => {
  const a = G.ledgerHash(G.buildLedger(AREAS))
  const b = G.ledgerHash(G.buildLedger([areaPick('r9', 4, ['B']), AREAS[1], areaPick('r8', 2, ['A'])]))
  ta('B6b 不一样', a !== b)
})

t('B7 标签归一化', () => {
  eq(G.normLabel('Ｂ'), 'B')
  eq(G.normLabel('b'), 'B')
  eq(G.normLabel('B.'), 'B')
  eq(G.normLabel(' 对 '), '对')
})
t('B8 集合比对不看顺序', () => ta('B8b', G.samePick(['B', 'C'], ['C', 'B'])))

t('B9 同一个复核员重登记 → 覆盖，不算两个人', () => {
  let store = {}
  store = G.recordVerdict(store, { ledgerHash: 'L', judgeId: 'g1', picks: { 1: ['A'], 2: ['A'] } })
  store = G.recordVerdict(store, { ledgerHash: 'L', judgeId: 'g1', picks: { 1: ['B'], 2: ['A'] }, round: 2 })
  eq(G.judgeSummary(store, 'L').registered, 1)
  eq(G.judgeSummary(store, 'L').entries[0].picks['1'][0], 'B')
})
t('B10 两个不同身份 → 两份', () => {
  let store = {}
  store = G.recordVerdict(store, { ledgerHash: 'L', judgeId: 'g1', picks: {} })
  store = G.recordVerdict(store, { ledgerHash: 'L', judgeId: 'g2', picks: {} })
  eq(G.judgeSummary(store, 'L').registered, 2)
})

function gateWith({ areas = AREAS, ignore = [], entries = [], submitButton = null, submitFound = true } = {}) {
  const ledger = G.buildLedger(areas, ignore)
  const lh = G.ledgerHash(ledger)
  return { ledger, lh, gate: G.checkGate({ areas, ledger, entries, ignore, submitButton, submitFound }) }
}
const twoJudges = (p1, p2, u = []) => ([
  { id: 'grader-1-xxxx', picks: p1, uncertain: u },
  { id: 'grader-2-yyyy', picks: p2, uncertain: u },
])

t('B11 全对 → PASS', () => {
  const { gate } = gateWith({ entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }) })
  eq(gate.verdict, 'PASS')
  ta('B11b pass=true', gate.pass === true)
})
t('B12 挑的题空着 → EMPTY_PICK', () => {
  const { gate } = gateWith({ areas: [areaPick('r1', 4, []), areaPick('r3', 2, ['A'])], entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }) })
  eq(gate.verdict, 'EMPTY_PICK')
})
t('B13 选了页面上没有的项 → OUT_OF_RANGE', () => {
  const { gate } = gateWith({ areas: [areaPick('r1', 2, ['C']), areaPick('r3', 2, ['A'])], entries: twoJudges({ 1: ['C'], 2: ['A'] }, { 1: ['C'], 2: ['A'] }) })
  eq(gate.verdict, 'OUT_OF_RANGE')
})
t('B14 写的地方空着 → EMPTY_WRITE', () => {
  const { gate } = gateWith({ areas: [areaPick('r1', 4, ['B']), areaWrite('r2', '   '), areaPick('r3', 2, ['A'])], entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }) })
  eq(gate.verdict, 'EMPTY_WRITE')
})
t('B15 复核员不够两份 → NEED_TWO_REVIEWERS', () => {
  const { gate } = gateWith({ entries: [{ id: 'grader-1-xxxx', picks: { 1: ['B'], 2: ['A'] }, uncertain: [] }] })
  eq(gate.verdict, 'NEED_TWO_REVIEWERS')
})
t('B16 三份不一致 → REVIEWERS_DISSENT', () => {
  const { gate } = gateWith({ entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['C'], 2: ['A'] }) })
  eq(gate.verdict, 'REVIEWERS_DISSENT')
  ta('B16b 说清是哪一处', gate.problems.some((p) => p.n === 1), JSON.stringify(gate.problems))
})
t('B17 有人拿不准 → 拦住且说明', () => {
  const { gate } = gateWith({ entries: twoJudges({ 2: ['A'] }, { 1: ['B'], 2: ['A'] }, [1]) })
  ta('B17b 拦住了', !gate.pass, gate.verdict)
  ta('B17c 提到拿不准', gate.problems.some((p) => /拿不准/.test(p.text)), JSON.stringify(gate.problems))
})
t('B18 交的按钮找不到 → NO_SUBMIT_TARGET', () => {
  const { gate } = gateWith({
    entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }),
    submitButton: { i: 'b1' }, submitFound: false,
  })
  eq(gate.verdict, 'NO_SUBMIT_TARGET')
})

t('B19 不过 → 没有票据', () => {
  const { gate, lh } = gateWith({ entries: [] })
  eq(G.makeToken({ fingerprint: 'F', ledgerHash: lh, gate }), null)
})
t('B20 过了 → 有票据', () => {
  const { gate, lh } = gateWith({ entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }) })
  ta('B20b', typeof G.makeToken({ fingerprint: 'F', ledgerHash: lh, gate }) === 'string')
})

t('B21 票据：对得上就放行', () => {
  const { gate, lh } = gateWith({ entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }) })
  const tk = G.makeToken({ fingerprint: 'F', ledgerHash: lh, gate })
  eq(G.verifyToken(tk, { fingerprint: 'F', ledgerHash: lh }).ok, true)
})
t('B22 票据：页面变了 → STALE_TOKEN', () => {
  const { gate, lh } = gateWith({ entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }) })
  const tk = G.makeToken({ fingerprint: 'F', ledgerHash: lh, gate })
  const v = G.verifyToken(tk, { fingerprint: 'F2', ledgerHash: lh })
  eq(v.ok, false); eq(v.code, 'STALE_TOKEN')
})
t('B23 票据：换了一套题 → STALE_TOKEN', () => {
  const { gate, lh } = gateWith({ entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }) })
  const tk = G.makeToken({ fingerprint: 'F', ledgerHash: lh, gate })
  eq(G.verifyToken(tk, { fingerprint: 'F', ledgerHash: 'OTHER' }).code, 'STALE_TOKEN')
})
t('B24 票据：过期 → STALE_TOKEN', () => {
  const { gate, lh } = gateWith({ entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['B'], 2: ['A'] }) })
  const tk = G.makeToken({ fingerprint: 'F', ledgerHash: lh, gate, now: 1000 })
  eq(G.verifyToken(tk, { fingerprint: 'F', ledgerHash: lh, now: 1000 + 16 * 60_000 }).code, 'STALE_TOKEN')
})
t('B25 票据：压根没给 → NEED_REVIEW', () => {
  eq(G.verifyToken(undefined, { fingerprint: 'F', ledgerHash: 'L' }).code, 'NEED_REVIEW')
})
t('B26 ★ 没有 afterReview 后门 —— 不一致时给什么都不发票据', () => {
  const { gate, lh } = gateWith({ entries: twoJudges({ 1: ['B'], 2: ['A'] }, { 1: ['C'], 2: ['A'] }) })
  eq(G.makeToken({ fingerprint: 'F', ledgerHash: lh, gate, afterReview: true }), null)
})
t('B27 复核员重登记（round 2）且这次一致 → 重新可交', () => {
  let store = {}
  store = G.recordVerdict(store, { ledgerHash: 'L', judgeId: 'g1', picks: { 1: ['B'], 2: ['A'] } })
  store = G.recordVerdict(store, { ledgerHash: 'L', judgeId: 'g2', picks: { 1: ['C'], 2: ['A'] } })
  const entries1 = Object.entries(store['L']).map(([id, v]) => ({ id, ...v }))
  const g1 = G.checkGate({ areas: AREAS, ledger: G.buildLedger(AREAS), entries: entries1 })
  eq(g1.verdict, 'REVIEWERS_DISSENT')

  store = G.recordVerdict(store, { ledgerHash: 'L', judgeId: 'g2', picks: { 1: ['B'], 2: ['A'] }, round: 2 })
  const entries2 = Object.entries(store['L']).map(([id, v]) => ({ id, ...v }))
  const g2 = G.checkGate({ areas: AREAS, ledger: G.buildLedger(AREAS), entries: entries2 })
  eq(g2.verdict, 'PASS')
  eq(G.judgeSummary(store, 'L').registered, 2)
})

// ═══════════════════════════════════════════════════════════════════════════
// C 工具表面
// ═══════════════════════════════════════════════════════════════════════════

const IDX = read('index.js')
const TOOLS = [...IDX.matchAll(/name:\s*'(eye_[a-z]+|hand_[a-z]+)'/g)].map((m) => m[1])

t('C1 一共 15 个工具', () => eq(TOOLS.length, 15, `实际 ${TOOLS.length}：${TOOLS.join(',')}`))
t('C2 眼 5 个', () => {
  const eyes = TOOLS.filter((x) => x.startsWith('eye_'))
  eq(eyes.length, 5, eyes.join(','))
  for (const n of ['eye_open', 'eye_see', 'eye_list', 'eye_shot', 'eye_check']) ta(`C2b ${n}`, eyes.includes(n))
})
t('C3 手 10 个', () => {
  const hands = TOOLS.filter((x) => x.startsWith('hand_'))
  eq(hands.length, 10, hands.join(','))
  for (const n of ['hand_click', 'hand_pick', 'hand_write', 'hand_scroll', 'hand_goto', 'hand_tab',
    'hand_play', 'hand_submit', 'hand_note', 'hand_verdict']) ta(`C3b ${n}`, hands.includes(n))
})
t('C4 不许再有旧前缀', () => ta('C4b', !/\bcx_[a-z]/.test(IDX)))
t('C5 并发标志：只读的是 true，会动手的是 false', () => {
  // 判断标准：**会不会动页面**。只读（眼 + 笔记 + 登记）可以并发；动手的必须串行。
  const READONLY = new Set(['eye_open', 'eye_see', 'eye_list', 'eye_shot', 'eye_check', 'hand_note', 'hand_verdict'])
  const blocks = IDX.split(/reg\(\{/).slice(1)
  for (const b of blocks) {
    const nm = /name:\s*'([a-z_]+)'/.exec(b)?.[1]
    if (!nm) continue
    const safe = /isConcurrencySafe:\s*\(\)\s*=>\s*true/.test(b.slice(0, 900))
    if (READONLY.has(nm)) ta(`C5b ${nm} 只读，应为 true`, safe)
    else ta(`C5c ${nm} 会动页面，应为 false`, !safe)
  }
})
t('C6 会动手的手都上了串行锁', () => {
  const blocks = IDX.split(/reg\(\{/).slice(1)
  for (const b of blocks) {
    const nm = /name:\s*'([a-z_]+)'/.exec(b)?.[1]
    if (!nm || nm.startsWith('eye_') || nm === 'hand_note' || nm === 'hand_verdict') continue
    ta(`C6b ${nm} 应有 serial: true`, /serial:\s*true/.test(b.slice(0, 900)))
  }
})
t('C7 铁律写进代码：hand_play 参数里没有倍速/跳转/心跳', () => {
  const i = IDX.indexOf("name: 'hand_play'")
  const blk = IDX.slice(i, i + 1200)
  for (const bad of ['rate', 'seek', 'heartbeat', 'speed', 'playbackRate']) {
    ta(`C7b 参数里不该有 ${bad}`, !new RegExp(`${bad}\\s*:`).test(blk))
  }
})
t('C8 hand_submit 不收答案（参数里没有 picks/answers）', () => {
  const i = IDX.indexOf("name: 'hand_submit'")
  const blk = IDX.slice(i, i + 900)
  ta('C8b', !/\b(answers|picks)\s*:/.test(blk))
})

// ═══════════════════════════════════════════════════════════════════════════
// D 痕迹检查
// ═══════════════════════════════════════════════════════════════════════════

const PLATFORM = /chaoxing|学习通|超星|xuexitong|mooc\d|studentstudy|visit\/interaction|ananas/i

t('D1 index.js 里没有平台字样', () => ta('D1b', !PLATFORM.test(IDX), PLATFORM.exec(IDX)?.[0]))
t('D2 lib/*.mjs 里没有平台字样', () => {
  for (const f of readdirSync(join(ROOT, 'lib'))) {
    if (!f.endsWith('.mjs')) continue
    const src = readFileSync(join(ROOT, 'lib', f), 'utf8')
    ta(`D2b lib/${f}`, !PLATFORM.test(src), PLATFORM.exec(src)?.[0])
  }
})
t('D3 提示词里没有平台字样、也没有平台事实', () => {
  const p = read('prompts/xuexi-mode.md')
  ta('D3b', !PLATFORM.test(p), PLATFORM.exec(p)?.[0])
  ta('D3c 不写 aria-label 这类站点细节', !/aria-label/i.test(p))
  ta('D3d 不写 videojs 这类站点细节', !/videojs/i.test(p))
})
t('D4 代码里不许写死某个网站的地址', () => {
  // 本机地址、示例域名不算；其它真实域名一律不许出现 ——
  // 写死任何一个网站的地址，就等于把"这个世界长什么样"钉死在代码里。
  const ALLOW = /^(https?:\/\/)(127\.0\.0\.1|localhost|example\.com|www\.example\.com)\b/i
  for (const f of readdirSync(join(ROOT, 'lib'))) {
    if (!f.endsWith('.mjs')) continue
    const src = readFileSync(join(ROOT, 'lib', f), 'utf8')
    const hits = [...src.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]).filter((u) => !ALLOW.test(u))
    ta(`D4b lib/${f} 里没有写死的网站地址：${hits.join(',')}`, hits.length === 0)
  }
})
t('D5 旧文件已删', () => {
  for (const f of ['lib/observe.mjs', 'lib/inventory.mjs', 'lib/act.mjs', 'lib/state.mjs', 'lib/check.mjs', 'prompts/chaoxing-mode.md']) {
    ta(`D5b ${f} 应已删除`, !existsSync(join(ROOT, f)))
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// E 预设自检
// ═══════════════════════════════════════════════════════════════════════════

const YML = read('cordis.patch.yml')
const PKG = JSON.parse(read('package.json'))
const PROMPT = read('prompts/xuexi-mode.md')

t('E1 预设 id / 名字', () => {
  ta('E1b id: xuexi', /id:\s*xuexi\b/.test(YML))
  ta('E1c 名字：网课模式', /name:\s*网课模式/.test(YML))
  ta('E1d 插件名 dsh-xuexi', /name:\s*dsh-xuexi\b/.test(YML))
})
t('E2 persona.prefix 必填且不带 complete', () => {
  ta('E2b 有 prefix', /prefix:\s*\S/.test(YML))
  ta('E2c 没有 complete', !/^\s*complete:\s*true/m.test(YML))
})
t('E3 文件工具在白名单里（否则复核员读不了图）', () => ta('E3b', /@deepseek-ai\/dsh-tool-fs/.test(YML)))
t('E4 package.json 对得上', () => {
  eq(PKG.name, 'dsh-xuexi')
  eq(PKG.version, '2.0.0')
  eq(PKG.dsh.id, 'dsh-xuexi')
  eq(PKG.dsh.repo, 'LeuJasYoh/dsh-xuexi')
})
t('E5 插件导出 name/apply', () => {
  ta('E5b', /export\s+function\s+apply/.test(IDX))
  ta('E5c', /export\s+const\s+name/.test(IDX))
})
t('E6 提示词提到全部 15 个工具（模型得知道怎么调）', () => {
  for (const n of TOOLS) ta(`E6b ${n}`, PROMPT.includes(n))
})
t('E7 提示词里有"复核员专用"分流', () => ta('E7b', /复核员专用/.test(PROMPT)))
t('E8 提示词里有四类错误说明', () => {
  for (const c of ['ARG', 'USAGE', 'WORLD', 'TOOL']) ta(`E8b ${c}`, PROMPT.includes(c))
})
t('E9 提示词里有三件万能事', () => ta('E9b', /三件万能事/.test(PROMPT)))
t('E10 提示词里写明笔记不许写答案', () => ta('E10b', /永远不许写答案/.test(PROMPT)))
t('E11 wait_agent 只等一次写进去了', () => ta('E11b', /只等一次/.test(PROMPT)))
t('E12 铁律六条还在', () => {
  for (const k of ['原速', '拖进度条', '伪造心跳', '串行', '破解', '不代填']) ta(`E12b ${k}`, PROMPT.includes(k))
})

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${'─'.repeat(60)}`)
if (fails.length) {
  console.log(`✗ ${fails.length} 条没过（通过 ${pass} 条）\n`)
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
} else {
  console.log(`✓ 全部通过：${pass} 条断言`)
}
