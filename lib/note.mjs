/**
 * note.mjs —— 笔记本 + 本地记账 + 过程文件
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★ 文件放哪：过程文件进工作区，机器状态留在家目录
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户的意见（对）：DSH 对话**一定有一个工作区**，干活产生的过程文件
 * （截图、笔记、记账）本来就该留在工作区里，而不是乱丢到家目录。
 *
 * 所以分两类：
 *
 *   ① 过程文件 —— 这次对话干活的痕迹
 *        工作区/.xuexi/notes.json     笔记本
 *        工作区/.xuexi/progress.json  本地记账 + 待办
 *        工作区/.xuexi/shots/*.png    截图
 *      → 跟对话在一起，用户看得到、好清理、能进版本库
 *
 *   ② 机器状态 —— 跟"这台机器"有关，跟"这次对话"无关
 *        ~/.dsh/xuexi/browser-profile/   浏览器配置（含登录态，几百 MB）
 *      → 跨会话共用（不用每次重新扫码），几百 MB 塞进工作区会污染它
 *
 * 拿不到工作区路径时（比如工具不是由 Agent 调用的），全部退回机器目录。
 *
 * ⚠️ 记账单位是**中性**的：只有"完成了几项 / 哪一项"，没有"任务点""课程"这种业务词。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 机器级根目录：放浏览器配置这种跨会话共用的东西 */
export const STATE_DIR = join(homedir(), '.dsh', 'xuexi')

/** 过程文件目录名（放在工作区里） */
export const WORK_SUBDIR = '.xuexi'

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
/** 第一次用工作区目录时，把家目录里已有的记账搬过来 */
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
  version: 2,
  updatedAt: null,
  browser: { port: 9222, profileDir: null },
  current: null,        // { url, title, at } —— 现在在哪一页
  done: [],             // [{ at, url, what }] —— 做完的项（单位中性）
  pending: [],          // ★ 攒下来的「需要用户处理」，做完一轮再统一汇报
}

export function loadState() {
  migrateOnce()
  const file = stateFile()
  try {
    if (!existsSync(file)) return { ...EMPTY, done: [], pending: [], file }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    // ★ 数组必须换成自己的：直接展开会把模块级 EMPTY 里的数组引用共享出去，
    //   一处 push 就污染后面所有 loadState（旧版/残缺文件缺键时才会踩到）。
    return {
      ...EMPTY, ...raw,
      done: Array.isArray(raw.done) ? raw.done : [],
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      file,
    }
  } catch (e) {
    return { ...EMPTY, done: [], pending: [], file, loadError: String(e).slice(0, 200) }
  }
}

export function saveState(state) {
  mkdirSync(_outDir, { recursive: true })
  state.updatedAt = new Date().toISOString()
  if (state.done.length > 500) state.done = state.done.slice(-500)
  writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  return state
}

/** 记一项做完的 */
export function markDone(where, what) {
  const state = loadState()
  state.done.push({ at: new Date().toISOString(), url: where ?? null, what: what ?? null })
  return saveState(state)
}

export function setCurrent(current) {
  const state = loadState()
  state.current = { ...current, at: new Date().toISOString() }
  return saveState(state)
}

// ── 「需要用户处理」的累积清单 ───────────────────────────────────────────────
//
// 设计要点（用户纠正过的）：
//
//   ❌ 错的做法：一遇到听力题/看视频题就停下来找用户
//      —— 一门课几十项，那样会打断用户几十次。
//
//   ✅ 对的做法：**记下来，继续干别的**，等这一轮干完再**一次性**汇报。
//
//   真正需要**当场打断**的只有四种：图形验证码 / 未登录 / 熔断额度 / 人脸抓拍。

/** 这一轮的收尾汇报用：把攒下来的清单整理成人能读的样子 */
export function pendingReport(state) {
  const list = (state ?? loadState()).pending ?? []
  if (!list.length) return { count: 0, items: [], text: '没有需要你处理的条目。' }
  const need = list.filter((x) => x.action !== 'skip')
  const skipped = list.filter((x) => x.action === 'skip')
  const lines = []
  if (need.length) {
    lines.push(`需要你处理（${need.length} 条）：`)
    for (const x of need) lines.push(`  · ${x.where ?? '?'}${x.what ? ` —— ${x.what}` : ''}`)
  }
  if (skipped.length) {
    lines.push(`主动跳过（${skipped.length} 条）：`)
    for (const x of skipped) lines.push(`  · ${x.where ?? '?'} —— ${x.what ?? '未说明'}`)
  }
  return {
    count: list.length,
    needCount: need.length,
    skippedCount: skipped.length,
    items: list,
    text: lines.join('\n'),
  }
}

export function summary(state) {
  const s = state ?? loadState()
  const pending = pendingReport(s)
  return {
    file: s.file,
    updatedAt: s.updatedAt,
    doneTotal: (s.done ?? []).length,
    current: s.current,
    pendingCount: pending.count,
    pendingText: pending.text,
    pending: (s.pending ?? []).map((x) => ({ where: x.where, what: x.what, action: x.action, tag: x.tag })),
    skipped: (s.pending ?? []).filter((x) => x.action === 'skip').map((x) => ({ where: x.where, what: x.what })),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★ Agent 的笔记本（hand_note）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么必须有（用户提出的）：大模型干活时会**自己发现规律**。
// 以前这些只能待在对话上下文里，会话一结束就没了，下次开机从零开始。
//
// 所以给它一个**自己的**笔记本：
//   lesson   —— 学到的东西（站点规律、工作心得）
//   pending  —— 需要用户处理的
//   skip     —— 主动跳过的
//   general  —— 其它
//
// 开机时 eye_open 会把摘要带回来 —— 这就是「学习」。
//
// ⚠️ 铁律：**笔记里永远不许写答案。**
//    复核员是子智能体，它在 DSH 里理论上能 read 到这个文件。
//    笔记只写规律和待办，不写"第 3 处选 B"。
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

export function addNote(tag, text, replaces = null) {
  const t = NOTE_TAGS.includes(tag) ? tag : 'general'
  const list = loadNotes()

  // ★ 作废机制：新经验推翻旧经验时，用 replaces（旧笔记里的一段原文，包含匹配）
  //   把旧的那条标记为 outdated —— 下次开机不再带回，免得两条矛盾的经验打架。
  //   实测事故：库里同时躺着「js-play 无效」和「js-play 有效」两条，互相打架。
  let outdated = 0
  if (replaces) {
    const key = String(replaces)
    for (const n of list) {
      if (n.outdated) continue
      if (String(n.text ?? '').includes(key)) {
        n.outdated = true
        n.outdatedAt = new Date().toISOString()
        n.outdatedBy = String(text ?? '').trim().slice(0, 120)
        outdated += 1
      }
    }
  }

  list.push({ at: new Date().toISOString(), tag: t, text: String(text ?? '').trim().slice(0, 1500), outdated: false })
  if (list.length > 300) list.splice(0, list.length - 300)
  saveNotes(list)

  // pending / skip 同时进"待汇报"清单，这样收尾时 eye_check/hand_note 能一次说清
  if (t === 'pending' || t === 'skip') {
    const state = loadState()
    // ★ 去重要按"存进去时的截断形态"比（what 截到 300 字，拿原文比永远比不上）
    const what = String(text ?? '').trim().slice(0, 300)
    state.pending = (state.pending ?? []).filter((x) => x.what !== what)
    state.pending.push({
      at: new Date().toISOString(),
      where: null, what,
      action: t === 'skip' ? 'skip' : 'human', tag: t,
    })
    saveState(state)
  }
  const active = list.filter((x) => !x.outdated).length
  return { total: active, tag: t, outdated, outdatedTotal: list.length - active }
}

export function clearNotes(tag) {
  const list = loadNotes()
  const kept = tag && tag !== 'all' ? list.filter((x) => x.tag !== tag) : []
  saveNotes(kept)
  if (tag === 'all' || tag === 'pending' || tag === 'skip') {
    const state = loadState()
    state.pending = (state.pending ?? []).filter((x) => (tag === 'all' ? false : x.tag !== tag))
    saveState(state)
  }
  return { removed: list.length - kept.length, total: kept.length }
}

/** 摘要：eye_open / hand_note 用它把「以前学到的」带回来
 *
 * ★ 已作废（outdated）的不带回 —— 它们是被新经验推翻的旧结论，
 *   带回去只会跟新经验打架。想看全部（含已作废）用 hand_note({ read: true })。
 */
export function noteDigest(recentN = 10) {
  const all = loadNotes()
  const list = all.filter((x) => !x.outdated)
  const byTag = {}
  for (const x of list) byTag[x.tag] = (byTag[x.tag] ?? 0) + 1
  const outdatedTotal = all.length - list.length
  return {
    total: list.length,
    byTag,
    recent: list.slice(-recentN).map((x) => ({ at: x.at, tag: x.tag, text: x.text })),
    hint: list.length
      ? `这些是以前记下的（另有 ${outdatedTotal} 条已作废的旧经验，不带回了）。`
        + '用 hand_note({ read: true }) 看全部；用 hand_note({ add, tag }) 写新的。'
        + '⚠️ 笔记是经验不是事实：页面可能变了，先看一眼再信它。'
        + '发现自己以前的笔记错了？写新笔记时带上 replaces:"旧笔记里的一段原文"，把它作废掉。'
      : '还没有笔记。干活中发现规律、或遇到要交给用户的事，用 hand_note({ add, tag }) 记下来。',
  }
}

export default {
  STATE_DIR, WORK_SUBDIR, resolveOutputDir, setOutputDir, getOutputDir, shotsDir,
  loadState, saveState, markDone, setCurrent, summary, pendingReport,
  NOTE_TAGS, loadNotes, addNote, clearNotes, noteDigest,
}
