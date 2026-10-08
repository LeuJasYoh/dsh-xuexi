// state.mjs —— 进度持久化（断点续播的基础）
// DSH 可能被关掉、浏览器可能崩。每完成一个任务点就落盘，下次从断点继续。
//
// ═══════════════════════════════════════════════════════════════════════════
//  ★ 文件放哪：过程文件进工作区，机器状态留在家目录
// ═══════════════════════════════════════════════════════════════════════════
//
// 用户的意见（对）：DSH 对话**一定有一个工作区**，刷课产生的过程文件
// （截图、进度、日志）本来就该留在工作区里，而不是乱丢到用户家目录。
//
// 所以分成两类：
//
//   ① 过程文件 —— 这次对话干活的痕迹
//        工作区/.chaoxing/progress.json     进度 + 待办
//        工作区/.chaoxing/shots/*.png       截图
//      → 跟对话在一起，用户看得到、好清理、能进版本库
//
//   ② 机器状态 —— 跟"这台机器"有关，跟"这次对话"无关
//        ~/.dsh/chaoxing/browser-profile/   浏览器配置（含学习通登录态，几百 MB）
//      → 跨会话共用（不用每次重新扫码），而且几百 MB 塞进工作区会污染它
//
// 拿不到工作区路径时（比如工具不是由 Agent 调用的），全部退回机器目录。

import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 机器级根目录：放浏览器配置这种跨会话共用的东西 */
export const STATE_DIR = join(homedir(), '.dsh', 'chaoxing')

/** 过程文件目录名（放在工作区里） */
export const WORK_SUBDIR = '.chaoxing'

/** 由会话 cwd 推出过程文件目录；拿不到就退回机器目录 */
export function resolveOutputDir(cwd) {
  if (!cwd || typeof cwd !== 'string') return STATE_DIR
  try { return join(cwd, WORK_SUBDIR) } catch { return STATE_DIR }
}

let _outDir = STATE_DIR
let _outIsWorkspace = false

/** 每次工具调用前，由 index.js 按当前会话的 cwd 设定 */
export function setOutputDir(dir, { isWorkspace = false } = {}) {
  if (!dir) return
  if (dir === _outDir) return
  _outDir = dir
  _outIsWorkspace = isWorkspace
  _migrated = false
}

export function getOutputDir() { return _outDir }
export function outputIsWorkspace() { return _outIsWorkspace }
export function shotsDir() { return join(_outDir, 'shots') }
function stateFile() { return join(_outDir, 'progress.json') }

let _migrated = false
/** 第一次用工作区目录时，把家目录里已有的进度搬过来（保住断点续播） */
function migrateOnce() {
  if (_migrated || _outDir === STATE_DIR) { _migrated = true; return }
  _migrated = true
  try {
    const src = join(STATE_DIR, 'progress.json')
    const dst = stateFile()
    if (!existsSync(dst) && existsSync(src)) copyFileSync(src, dst)
  } catch { /* 搬不动就算了，从头记 */ }
}

const EMPTY = {
  version: 1,
  updatedAt: null,
  browser: { port: 9222, profileDir: null },
  current: null,          // { courseId, courseName, chapterId, cardId, tabTitle, lastClipTime }
  completed: {},          // { "courseId:cardid": { at, title, type, seconds } }
  pendingHuman: [],       // ★ 攒下来的「需要用户处理」，做完一轮再统一汇报
  gates: { lastQuotaCheck: null, quotaRaw: null, fuseUntil: null, fuseReason: null },
  history: [],            // 最近若干次会话摘要
}

export function loadState() {
  migrateOnce()
  const file = stateFile()
  try {
    if (!existsSync(file)) return { ...EMPTY, file }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { ...EMPTY, ...raw, file }
  } catch (e) {
    return { ...EMPTY, file, loadError: String(e).slice(0, 200) }
  }
}

export function saveState(state) {
  const dir = _outDir
  mkdirSync(dir, { recursive: true })
  state.updatedAt = new Date().toISOString()
  if (state.history.length > 20) state.history = state.history.slice(-20)
  writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  return state
}

export function key(courseId, cardId) {
  return `${courseId}:${cardId}`
}

export function markCompleted(state, course, cardId, extra = {}) {
  state.completed[key(course.courseId, cardId)] = {
    at: new Date().toISOString(),
    course: course.name,
    ...extra,
  }
  return saveState(state)
}

export function isCompleted(state, courseId, cardId) {
  return Boolean(state.completed[key(courseId, cardId)])
}

export function setCurrent(state, current) {
  state.current = { ...current, at: new Date().toISOString() }
  return saveState(state)
}

export function clearCurrent(state) {
  state.current = null
  return saveState(state)
}

// ── 「需要用户处理」的累积清单 ───────────────────────────────────────────────
//
// 设计要点（用户纠正过的）：
//
//   ❌ 错的做法：一遇到听力题/看视频题就停下来找用户
//      —— 一门课有几十个任务点，那样会打断用户几十次。
//
//   ✅ 对的做法：**记下来，继续干别的**，等这一轮刷完（或按用户要求做完）
//      再把这个清单**一次性**汇报给用户。
//
//   真正需要**当场打断**的只有三件：人机验证、未登录、熔断/额度。
//   那些不走这里 —— 它们会让工具直接返回 BLOCKED_* 错误。
//
export function markHuman(state, course, cardId, item = {}) {
  const k = `${course?.courseId ?? '?'}:${cardId ?? '?'}:${item.pageKey ?? item.key ?? '?'}`
  const rec = {
    k,
    at: new Date().toISOString(),
    action: item.action ?? 'human',     // 'human' = 需要你处理；'skip' = 主动跳过（也要让你知道）
    course: course?.name ?? null,
    chapterId: course?.chapterId ?? null,
    cardId: cardId ?? null,
    tab: item.tabTitle ?? null,
    kind: item.kind ?? null,
    title: item.title ?? null,
    why: item.why ?? null,
  }
  state.pendingHuman = (state.pendingHuman ?? []).filter((x) => x.k !== k)
  state.pendingHuman.push(rec)
  return saveState(state)
}

/** 用户已经处理完了 → 从清单里划掉 */
export function resolveHuman(state, courseId, cardId, pageKey) {
  const k = `${courseId ?? '?'}:${cardId ?? '?'}:${pageKey ?? '?'}`
  state.pendingHuman = (state.pendingHuman ?? []).filter((x) => x.k !== k)
  return saveState(state)
}

/** 这一轮的收尾汇报用：把攒下来的清单整理成人能读的样子 */
export function pendingReport(state) {
  const list = state.pendingHuman ?? []
  if (!list.length) return { count: 0, items: [], text: '没有需要你处理的条目。' }
  const need = list.filter((x) => x.action !== 'skip')
  const skipped = list.filter((x) => x.action === 'skip')
  const lines = []
  if (need.length) {
    lines.push(`需要你处理（${need.length} 条）：`)
    for (const x of need) {
      lines.push(`  · [${x.course ?? '?'} / ${x.tab ?? '?'}] ${x.kind ?? '?'}${x.title ? `「${x.title}」` : ''}`)
      if (x.why) lines.push(`    ${x.why}`)
    }
  }
  if (skipped.length) {
    lines.push(`主动跳过（${skipped.length} 条）：`)
    for (const x of skipped) {
      lines.push(`  · [${x.course ?? '?'} / ${x.tab ?? '?'}] ${x.kind ?? '?'} —— ${x.why ?? '未说明'}`)
    }
  }
  return {
    count: list.length,
    needCount: need.length,
    skippedCount: skipped.length,
    byCourse: list.reduce((m, x) => { const c = x.course ?? '(未知)'; m[c] = (m[c] ?? 0) + 1; return m }, {}),
    items: list,
    text: lines.join('\n'),
  }
}

export function setFuse(state, { untilMs, reason }) {
  state.gates.fuseUntil = new Date(Date.now() + untilMs).toISOString()
  state.gates.fuseReason = reason
  return saveState(state)
}

export function fuseActive(state) {
  if (!state.gates.fuseUntil) return null
  const until = Date.parse(state.gates.fuseUntil)
  if (!Number.isFinite(until) || until <= Date.now()) return null
  return { untilMs: until - Date.now(), reason: state.gates.fuseReason }
}

export function summary(state) {
  const done = Object.keys(state.completed).length
  const byCourse = {}
  for (const v of Object.values(state.completed)) {
    byCourse[v.course ?? '(未知)'] = (byCourse[v.course ?? '(未知)'] ?? 0) + 1
  }
  const fuse = fuseActive(state)
  const pending = pendingReport(state)
  return {
    file: state.file,
    updatedAt: state.updatedAt,
    completedTotal: done,
    byCourse,
    current: state.current,
    gates: { ...state.gates, fuseActive: fuse ? `${Math.ceil(fuse.untilMs / 60000)} 分钟后解除` : null },
    // ★ 攒下来的「需要用户处理」—— 做完一轮后拿它一次性汇报
    pendingHumanCount: pending.count,
    pendingHumanByCourse: pending.byCourse,
    pendingHumanText: pending.text,
    pendingHuman: pending.items.map((x) => ({ course: x.course, tab: x.tab, kind: x.kind, title: x.title, why: x.why })),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★ Agent 的笔记本（cx_note）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么必须有（用户提出的）：大模型干活时会**自己发现规律** ——
//   例：「马原的独立作业页连选项都会乱码」「这一节的视频其实早就做完了」。
// 以前这些只能待在对话上下文里，会话一结束就没了，下次开机从零开始。
//
// 所以给它一个**自己的**笔记本：
//   lesson   —— 学到的东西（站点规律、工作心得）
//   pending  —— 需要用户处理的（听力题、看不懂的）
//   skip     —— 主动跳过的（要让用户知道）
//   general  —— 其它
//
// 开机时 cx_open 会把摘要带回来 —— 这就是「学习」。
// 笔记存在工作区 `.chaoxing/notes.json`。
export const NOTE_TAGS = ['lesson', 'pending', 'skip', 'general']

function noteFile() { return join(_outDir, 'notes.json') }

export function loadNotes() {
  try {
    const raw = JSON.parse(readFileSync(noteFile(), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}

function saveNotes(list) {
  mkdirSync(_outDir, { recursive: true })
  writeFileSync(noteFile(), JSON.stringify(list, null, 2))
}

export function addNote(tag, text) {
  const t = NOTE_TAGS.includes(tag) ? tag : 'general'
  const list = loadNotes()
  list.push({ at: new Date().toISOString(), tag: t, text: String(text ?? '').trim().slice(0, 1500) })
  if (list.length > 300) list.splice(0, list.length - 300)
  saveNotes(list)
  return { total: list.length, tag: t }
}

export function clearNotes(tag) {
  const list = loadNotes()
  const kept = tag ? list.filter((x) => x.tag !== tag) : []
  saveNotes(kept)
  return { removed: list.length - kept.length, total: kept.length }
}

/** 摘要：cx_open / cx_note 用它把「以前学到的」带回来 */
export function noteDigest(recentN = 10) {
  const list = loadNotes()
  const byTag = {}
  for (const x of list) byTag[x.tag] = (byTag[x.tag] ?? 0) + 1
  return {
    total: list.length,
    byTag,
    recent: list.slice(-recentN).map((x) => ({ at: x.at, tag: x.tag, text: x.text })),
    hint: list.length
      ? '这些是以前记下的。用 cx_note({ read: true }) 看全部；用 cx_note({ add, tag }) 写新的。'
      : '还没有笔记。干活中发现站点规律、或遇到要交给用户的事，用 cx_note({ add, tag }) 记下来。',
  }
}