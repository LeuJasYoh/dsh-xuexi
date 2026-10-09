/**
 * args.mjs —— 参数校验层：**纯函数，绝不碰浏览器**
 *
 * 这一层的存在只为一个目的：
 *
 *   格式错，必须在「动手之前」被拦住，而且页面一下都不能被碰过。
 *
 * 为什么这件事这么要紧（实测教训）：以前格式错和「东西不存在」混在一起报，
 * 模型一看见错误就以为是世界不对，于是去乱猜、去重试、去换工具 —— 越走越歪。
 * 它其实只需要改一下自己写错的那个参数。
 *
 * 所以每个工具的第一步都是：
 *
 *     const chk = checkArgs('hand_click', args)
 *     if (!chk.ok) return chk          // ← 到这里为止，浏览器一次都没被碰过
 *     … 才开始干活 …
 *
 * 分类（见 ERR / USAGE）：
 *   ARG   —— 你调用格式写错了：缺必填、类型不对、定位三写法没给或混着给、枚举越界
 *   USAGE —— 格式对，但组合不对（比如 call 没指定是哪一处）
 *
 * 两类都不产生任何副作用。
 */

// ── 基础工具 ────────────────────────────────────────────────────────────────

export function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 格式错：改你自己的调用就行，页面没动过 */
export function ERR(error, expected, example) {
  return { ok: false, category: 'ARG', error, expected, example }
}

/** 用法错：格式对，组合不对，页面同样没动过 */
export function USAGE(error, expected, example) {
  return { ok: false, category: 'USAGE', error, expected, example }
}

/** 参数里出现了不认识的键 —— 这通常意味着模型在用脑子里的概念，而不是屏幕上的东西 */
function unknownKey(obj, allowed, label = '参数') {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      return ERR(
        `${label}里有工具不认识的键：「${k}」`,
        `只允许这些键：${[...allowed].join(' / ')}`,
        '工具的编号（i）、屏幕上的可见文字（text）、当前屏幕坐标（x,y）—— 屏幕上没有的东西，工具不认识。'
        + '「题号」「题型」「课程名」「章节号」这类是你脑子里的概念，不要往参数里写。',
      )
    }
  }
  return null
}

// ── 定位：指屏幕上的一个东西 ────────────────────────────────────────────────
//
// 三种写法，三选一，不能都不给、不能混着给：
//
//   { "i": "h4xt52c:3" }                 工具给的编号（最稳）
//   { "text": "提交", "frame": "…" }      屏幕上的可见文字
//   { "x": 812, "y": 455 }               当前屏幕坐标（兜底，永远可用）

const LOC_KEYS = new Set(['i', 'text', 'exact', 'frame', 'x', 'y'])
const LOC_HELP = '{"i":"h4xt52c:3"} 或 {"text":"提交"} 或 {"x":812,"y":455}'

export function normLocator(v, label = '定位') {
  if (!isObj(v)) {
    return ERR(
      `${label}必须写成一个对象`,
      `${label}三种写法任选一种：${LOC_HELP}`,
      '例如：{"i":"h4xt52c:3"} —— 编号来自 eye_see / eye_list，最稳。',
    )
  }
  const bad = unknownKey(v, LOC_KEYS, label)
  if (bad) return bad

  const hasI = v.i !== undefined
  const hasT = v.text !== undefined
  const hasXY = v.x !== undefined || v.y !== undefined
  const n = (hasI ? 1 : 0) + (hasT ? 1 : 0) + (hasXY ? 1 : 0)

  if (n === 0) {
    return ERR(
      `${label}没给 —— 你得说清是指屏幕上的哪个东西`,
      `${label}三种写法任选一种：${LOC_HELP}`,
      '{"i":"h4xt52c:3"}（编号最稳）',
    )
  }
  if (n > 1) {
    return ERR(
      `${label}同时给了 ${n} 种写法，工具不知道以哪个为准`,
      '三种写法只能给一种：编号 i / 文字 text / 坐标 x,y',
      '{"i":"h4xt52c:3"}',
    )
  }

  if (hasI) {
    if (typeof v.i !== 'string' || !v.i.trim()) {
      return ERR(`${label}的 i 必须是非空字符串`, 'i 取 eye_see / eye_list 返回的编号', '{"i":"h4xt52c:3"}')
    }
    return { ok: true, loc: { i: v.i.trim() } }
  }

  if (hasT) {
    if (typeof v.text !== 'string' || !v.text.trim()) {
      return ERR(`${label}的 text 必须是非空字符串`, 'text 是屏幕上看得见的文字', '{"text":"提交"}')
    }
    const loc = { text: v.text }
    if (v.exact !== undefined) {
      if (typeof v.exact !== 'boolean') return ERR(`${label}的 exact 只能是 true / false`, 'exact 控制"完全相等"还是"包含"', '{"text":"提交","exact":true}')
      loc.exact = v.exact
    }
    if (v.frame !== undefined) {
      if (typeof v.frame !== 'string' || !v.frame.trim()) {
        return ERR(`${label}的 frame 必须是非空字符串`, 'frame 取 eye_list 返回里的窗口名（如"知识卡片"）', '{"text":"提交","frame":"知识卡片"}')
      }
      loc.frame = v.frame.trim()
    }
    return { ok: true, loc }
  }

  if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) {
    return ERR(
      `${label}的 x / y 必须是数字`,
      '坐标是当前屏幕上的像素位置（截图上的坐标）',
      '{"x":812,"y":455}',
    )
  }
  return { ok: true, loc: { x: Math.round(v.x), y: Math.round(v.y) } }
}

// ── 小类型 ──────────────────────────────────────────────────────────────────

function num(v, name, min, max, { optional = false } = {}) {
  if (v === undefined) return optional ? { ok: true, value: undefined } : ERR(`${name}是必填`, `${name} 是 ${min}–${max} 之间的数字`, '')
  if (typeof v !== 'number' || !Number.isFinite(v)) return ERR(`${name}必须是数字`, `${name} 是 ${min}–${max} 之间的数字`, '')
  if (v < min || v > max) return ERR(`${name}超范围了（给的是 ${v}）`, `${name} 只能是 ${min}–${max}`, '')
  return { ok: true, value: v }
}

function bool(v, name, { optional = false } = {}) {
  if (v === undefined) return optional ? { ok: true, value: undefined } : ERR(`${name}是必填`, `${name} 只能是 true / false`, '')
  if (typeof v !== 'boolean') return ERR(`${name}只能是 true / false`, `${name} 只能是 true / false`, '')
  return { ok: true, value: v }
}

function str(v, name, { optional = false } = {}) {
  if (v === undefined) return optional ? { ok: true, value: undefined } : ERR(`${name}是必填`, `${name} 是字符串`, '')
  if (typeof v !== 'string') return ERR(`${name}必须是字符串`, `${name} 是字符串`, '')
  return { ok: true, value: v }
}

function enumOf(v, name, allowed, { optional = false } = {}) {
  if (v === undefined) return optional ? { ok: true, value: undefined } : ERR(`${name}是必填`, `${name} 只能是 ${allowed.join(' / ')}`, '')
  if (!allowed.includes(v)) return ERR(`${name}只能是 ${allowed.join(' / ')}（给的是 ${JSON.stringify(v)}）`, `${name} 只能是 ${allowed.join(' / ')}`, '')
  return { ok: true, value: v }
}

/** 把一串子校验合成一个结果；有一个错就整个返回那个错 */
function all(parts) {
  for (const p of parts) if (!p.ok) return p
  return { ok: true }
}

// ── 各工具的校验表 ──────────────────────────────────────────────────────────
//
// 每个校验器做两件事：
//   ① 该拦的拦住（返回 ERR / USAGE）
//   ② 把参数**归一化**成工具内部好用的形状（chk.args）

const V = {

  // ── 眼 ───────────────────────────────────────────────────────────────────

  eye_open(a = {}) {
    const bad = unknownKey(a, new Set(['tab']), 'eye_open 的参数')
    if (bad) return bad
    const t = str(a.tab, 'tab', { optional: true })
    if (!t.ok) return t
    return { ok: true, args: { tab: t.value } }
  },

  eye_see(a = {}) {
    const bad = unknownKey(a, new Set(['full']), 'eye_see 的参数')
    if (bad) return bad
    const f = bool(a.full, 'full', { optional: true })
    if (!f.ok) return f
    return { ok: true, args: { full: f.value === true } }
  },

  eye_list(a = {}) {
    const bad = unknownKey(a, new Set(['limit', 'frame']), 'eye_list 的参数')
    if (bad) return bad
    const l = num(a.limit, 'limit', 1, 300, { optional: true })
    if (!l.ok) return l
    const f = str(a.frame, 'frame', { optional: true })
    if (!f.ok) return f
    return { ok: true, args: { limit: l.value ?? 70, frame: f.value } }
  },

  eye_shot(a = {}) {
    const bad = unknownKey(a, new Set(['full', 'clip', 'label', 'useShotId']), 'eye_shot 的参数')
    if (bad) return bad
    const f = bool(a.full, 'full', { optional: true })
    if (!f.ok) return f
    const lb = str(a.label, 'label', { optional: true })
    if (!lb.ok) return lb
    const us = str(a.useShotId, 'useShotId', { optional: true })
    if (!us.ok) return us

    if (a.clip !== undefined) {
      if (f.value === true) {
        return ERR('full 和 clip 不能同时给', '整页截图（full:true）和只截一块（clip）是两回事，二选一', '{"clip":{"x":0,"y":0,"width":800,"height":600}}')
      }
      if (!isObj(a.clip)) return ERR('clip 必须是一个对象', 'clip: {x, y, width, height}，都是数字', '{"clip":{"x":0,"y":0,"width":800,"height":600}}')
      const clipBad = unknownKey(a.clip, new Set(['x', 'y', 'width', 'height']), 'clip')
      if (clipBad) return clipBad
      for (const k of ['x', 'y', 'width', 'height']) {
        if (!Number.isFinite(a.clip[k])) {
          return ERR(`clip.${k} 必须是数字`, 'clip: {x, y, width, height}，都是数字', '{"clip":{"x":0,"y":0,"width":800,"height":600}}')
        }
      }
      if (a.clip.x < 0 || a.clip.y < 0) return ERR('clip.x / clip.y 不能是负数', 'x、y 是这一块左上角在当前屏幕上的位置', '{"clip":{"x":0,"y":0,"width":800,"height":600}}')
      if (a.clip.width <= 0 || a.clip.height <= 0) return ERR('clip.width / clip.height 必须大于 0', '给出一块真实的矩形', '{"clip":{"x":0,"y":0,"width":800,"height":600}}')
    }
    return {
      ok: true,
      args: { full: f.value === true, clip: a.clip ? { ...a.clip } : null, label: lb.value ?? 'shot', useShotId: us.value },
    }
  },

  eye_check(a = {}) {
    const bad = unknownKey(a, new Set(['ignore', 'submitButton']), 'eye_check 的参数')
    if (bad) return bad
    let ignore = []
    if (a.ignore !== undefined) {
      if (!Array.isArray(a.ignore)) return ERR('ignore 必须是一个数组', 'ignore 里放"不用复核的那几处"的编号 n', '{"ignore":[2]}')
      for (const v of a.ignore) {
        if (!Number.isInteger(v) || v < 1) return ERR('ignore 里只能是正整数编号 n', '编号来自 eye_see 的对账清单', '{"ignore":[2]}')
      }
      ignore = [...new Set(a.ignore)]
    }
    let submitButton
    if (a.submitButton !== undefined) {
      const loc = normLocator(a.submitButton, 'submitButton')
      if (!loc.ok) return loc
      submitButton = loc.loc
    }
    return { ok: true, args: { ignore, submitButton } }
  },

  // ── 手 ───────────────────────────────────────────────────────────────────

  hand_click(a = {}) {
    const bad = unknownKey(a, new Set(['i', 'text', 'exact', 'frame', 'x', 'y', 'settleMs']), 'hand_click 的参数')
    if (bad) return bad
    // ★ settleMs 是 hand_click 自己的参数，不是定位键 —— 必须剥掉再交给 normLocator。
    //   （2.0.1 修复：早先把整个 a 传进去，settleMs 被 normLocator 的 unknownKey
    //    当成"不认识的键"拒掉 —— 参数声明了却永远用不了，三种定位写法全被误杀。）
    const loc = normLocator({ i: a.i, text: a.text, exact: a.exact, frame: a.frame, x: a.x, y: a.y }, '定位')
    if (!loc.ok) return loc
    const s = num(a.settleMs, 'settleMs', 0, 10000, { optional: true })
    if (!s.ok) return s
    return { ok: true, args: { loc: loc.loc, settleMs: s.value ?? 1500 } }
  },

  hand_pick(a = {}) {
    const bad = unknownKey(a, new Set(['area', 'choose', 'mode']), 'hand_pick 的参数')
    if (bad) return bad
    const area = normLocator(a.area, 'area')
    if (!area.ok) return area
    const mode = enumOf(a.mode, 'mode', ['set', 'add', 'clear'], { optional: true })
    if (!mode.ok) return mode
    const m = mode.value ?? 'set'

    const choose = []
    if (a.choose !== undefined) {
      if (!Array.isArray(a.choose)) {
        return ERR('choose 必须是一个数组', 'choose 里放要挑的那几个选项，每个都是一个定位', '{"area":{"i":"r3"},"choose":[{"i":"o1"}],"mode":"set"}')
      }
      for (const [k, c] of a.choose.entries()) {
        const loc = normLocator(c, `choose[${k}]`)
        if (!loc.ok) return loc
        choose.push(loc.loc)
      }
    }
    if ((m === 'set' || m === 'add') && choose.length === 0) {
      return USAGE(
        `mode:"${m}" 但你一个选项都没给（choose 是空的）`,
        '要挑东西就得说挑哪几个；想全取消用 mode:"clear"',
        '{"area":{"i":"r3"},"choose":[{"i":"o1"}],"mode":"set"}',
      )
    }
    if (m === 'clear' && choose.length) {
      return USAGE('mode:"clear" 是"全取消"，这时不该给 choose', '全取消就把 choose 省掉', '{"area":{"i":"r3"},"mode":"clear"}')
    }
    return { ok: true, args: { area: area.loc, choose, mode: m } }
  },

  hand_write(a = {}) {
    const bad = unknownKey(a, new Set(['area', 'text', 'mode']), 'hand_write 的参数')
    if (bad) return bad
    const area = normLocator(a.area, 'area')
    if (!area.ok) return area
    const t = str(a.text, 'text')
    if (!t.ok) return t
    const mode = enumOf(a.mode, 'mode', ['replace', 'append'], { optional: true })
    if (!mode.ok) return mode
    return { ok: true, args: { area: area.loc, text: t.value, mode: mode.value ?? 'replace' } }
  },

  hand_scroll(a = {}) {
    const bad = unknownKey(a, new Set(['to', 'px', 'times', 'area', 'frame']), 'hand_scroll 的参数')
    if (bad) return bad
    const to = enumOf(a.to, 'to', ['down', 'up', 'bottom', 'top'], { optional: true })
    if (!to.ok) return to
    const px = num(a.px, 'px', 1, 20000, { optional: true })
    if (!px.ok) return px
    const times = num(a.times, 'times', 1, 50, { optional: true })
    if (!times.ok) return times
    const fr = str(a.frame, 'frame', { optional: true })
    if (!fr.ok) return fr
    let area
    if (a.area !== undefined) {
      const loc = normLocator(a.area, 'area')
      if (!loc.ok) return loc
      area = loc.loc
    }
    return {
      ok: true,
      args: { to: to.value ?? 'down', px: px.value ?? 800, times: times.value ?? 1, area, frame: fr.value ?? null },
    }
  },

  hand_goto(a = {}) {
    const bad = unknownKey(a, new Set(['url', 'back', 'reload']), 'hand_goto 的参数')
    if (bad) return bad
    const given = [a.url !== undefined, a.back === true, a.reload === true].filter(Boolean).length
    if (given === 0) {
      return ERR(
        'hand_goto 没说要去哪',
        '三种之一：url（跳网址）/ back:true（后退）/ reload:true（刷新）',
        '{"url":"https://example.com/"}',
      )
    }
    if (given > 1) {
      return ERR('hand_goto 一次只能做一件事', 'url / back / reload 三选一', '{"url":"https://example.com/"}')
    }
    if (a.back !== undefined) {
      const b = bool(a.back, 'back')
      if (!b.ok) return b
    }
    if (a.reload !== undefined) {
      const r = bool(a.reload, 'reload')
      if (!r.ok) return r
    }
    if (a.url !== undefined) {
      const u = str(a.url, 'url')
      if (!u.ok) return u
      if (!/^https?:\/\//i.test(u.value)) {
        return ERR(`url 必须以 http:// 或 https:// 开头（给的是 ${JSON.stringify(u.value).slice(0, 60)}）`, '完整的网址', '{"url":"https://example.com/"}')
      }
      return { ok: true, args: { url: u.value } }
    }
    return { ok: true, args: a.back === true ? { back: true } : { reload: true } }
  },

  hand_tab(a = {}) {
    const bad = unknownKey(a, new Set(['i', 'id']), 'hand_tab 的参数')
    if (bad) return bad
    if (a.i === undefined && a.id === undefined) {
      return ERR('hand_tab 没说换到哪一个', '给 i（序号，从 0 开始）或 id（eye_open 返回的标签页 id）', '{"i":1}')
    }
    if (a.i !== undefined && a.id !== undefined) {
      return ERR('hand_tab 一次只能给一个', 'i 或 id 二选一', '{"i":1}')
    }
    if (a.i !== undefined) {
      const i = num(a.i, 'i', 0, 200)
      if (!i.ok) return i
      if (!Number.isInteger(a.i)) return ERR('i 必须是整数', 'i 是标签页序号，从 0 开始', '{"i":1}')
      return { ok: true, args: { i: a.i } }
    }
    const id = str(a.id, 'id')
    if (!id.ok) return id
    return { ok: true, args: { id: id.value } }
  },

  // ── 必要 ─────────────────────────────────────────────────────────────────

  hand_play(a = {}) {
    const bad = unknownKey(a, new Set(['maxSeconds', 'stallSeconds', 'rate']), 'hand_play 的参数')
    if (bad) return bad
    // ★ 秒级，不再是"分钟"（用户要求：颗粒度细一点）。
    //   而且**不给就由工具按视频长度自己算** —— 时长是工具读得到的事实，不该让模型猜。
    const ms = num(a.maxSeconds, 'maxSeconds', 1, 86400, { optional: true })
    if (!ms.ok) return ms
    const st = num(a.stallSeconds, 'stallSeconds', 5, 600, { optional: true })
    if (!st.ok) return st
    // rate 给了 = "用户要求按这个速度播"（这时被改才纠）；
    // 不给 = 默认 1x，且**别人改了不纠**（见提示词「关于倍速」）。
    const rt = num(a.rate, 'rate', 0.25, 8, { optional: true })
    if (!rt.ok) return rt
    return {
      ok: true,
      args: { maxSeconds: ms.value ?? null, stallSeconds: st.value ?? 25, rate: rt.value ?? null },
    }
  },

  hand_submit(a = {}) {
    const bad = unknownKey(a, new Set(['confirm', 'reviewed', 'button']), 'hand_submit 的参数')
    if (bad) return bad
    const c = bool(a.confirm, 'confirm')
    if (!c.ok) return c
    if (a.confirm !== true) {
      return USAGE(
        'confirm 必须是 true —— 这是"我确认交"的明确表态',
        '交是全站唯一做错回不了头的动作，必须明说一次',
        '{"confirm":true,"reviewed":"tk_8f2a","button":{"i":"b1"}}',
      )
    }
    const rv = str(a.reviewed, 'reviewed')
    if (!rv.ok) return rv
    if (!rv.value.trim()) {
      return ERR('reviewed（票据）是空的', '票据来自 eye_check 的 token', '{"confirm":true,"reviewed":"tk_8f2a","button":{"i":"b1"}}')
    }
    const btn = normLocator(a.button, 'button')
    if (!btn.ok) return btn
    return { ok: true, args: { confirm: true, reviewed: rv.value.trim(), button: btn.loc } }
  },

  hand_note(a = {}) {
    const bad = unknownKey(a, new Set(['add', 'tag', 'read', 'clear']), 'hand_note 的参数')
    if (bad) return bad
    const uses = [a.add !== undefined, a.read === true, a.clear !== undefined].filter(Boolean).length
    if (uses === 0) {
      return ERR(
        'hand_note 没说干什么',
        '三种之一：add（写一条）/ read:true（读全部）/ clear（清某一类）',
        '{"add":"这一页的选项也被搅过，只能看图","tag":"lesson"}',
      )
    }
    if (uses > 1) {
      return ERR('hand_note 一次只能做一件事', 'add / read / clear 三选一', '{"add":"…","tag":"lesson"}')
    }
    const tag = enumOf(a.tag, 'tag', ['lesson', 'pending', 'skip', 'general'], { optional: true })
    if (!tag.ok) return tag
    if (a.read !== undefined) {
      const rd = bool(a.read, 'read')
      if (!rd.ok) return rd
    }
    if (a.clear !== undefined) {
      const cl = enumOf(a.clear, 'clear', ['lesson', 'pending', 'skip', 'general', 'all'])
      if (!cl.ok) return cl
      return { ok: true, args: { clear: cl.value } }
    }
    if (a.read === true) return { ok: true, args: { read: true } }
    const ad = str(a.add, 'add')
    if (!ad.ok) return ad
    if (!ad.value.trim()) return ERR('add 是空的', '写一句话', '{"add":"…","tag":"lesson"}')
    return { ok: true, args: { add: ad.value.trim(), tag: tag.value ?? 'general' } }
  },

  hand_verdict(a = {}) {
    const bad = unknownKey(a, new Set(['picks', 'uncertain', 'round', 'note']), 'hand_verdict 的参数')
    if (bad) return bad

    if (!isObj(a.picks)) {
      return ERR(
        'picks 必须是一个对象',
        'picks 的键 = 对账清单里的编号 n；值 = 图上看得见的标签数组',
        '{"picks":{"1":["B"],"2":["对"]},"uncertain":[3]}',
      )
    }
    const picks = {}
    for (const [k, v] of Object.entries(a.picks)) {
      if (!/^[1-9]\d*$/.test(k)) {
        return ERR(
          `picks 的键 "${k}" 不是"第几处"的正整数编号`,
          '键只能是对账清单里的 n（1、2、3…）—— 不是题号，是屏幕上从上到下的第几处',
          '{"picks":{"1":["B"]}}',
        )
      }
      if (!Array.isArray(v)) {
        return ERR(`picks["${k}"] 必须是数组`, '值是图上看得见的标签，可以多个（多选）', '{"picks":{"1":["B","C"]}}')
      }
      for (const item of v) {
        if (typeof item !== 'string' || !item.trim()) {
          return ERR(`picks["${k}"] 里只能放字符串标签`, '标签是图上写着的 A / B / 对 / 错', '{"picks":{"1":["B"]}}')
        }
      }
      picks[k] = v.map((s) => s.trim())
    }

    let uncertain = []
    if (a.uncertain !== undefined) {
      if (!Array.isArray(a.uncertain)) return ERR('uncertain 必须是一个数组', 'uncertain 里放拿不准的那几处编号 n', '{"picks":{},"uncertain":[3]}')
      for (const v of a.uncertain) {
        if (!Number.isInteger(v) || v < 1) return ERR('uncertain 里只能是正整数编号 n', '编号来自对账清单', '{"picks":{},"uncertain":[3]}')
      }
      uncertain = [...new Set(a.uncertain)]
    }

    const rd = num(a.round, 'round', 1, 99, { optional: true })
    if (!rd.ok) return rd
    const nt = str(a.note, 'note', { optional: true })
    if (!nt.ok) return nt

    if (!Object.keys(picks).length && !uncertain.length) {
      return USAGE(
        'picks 和 uncertain 都是空的 —— 你什么都没登记',
        '每一处都要给：定下来的写进 picks，拿不准的写进 uncertain（但不要猜）',
        '{"picks":{"1":["B"]},"uncertain":[3]}',
      )
    }
    return { ok: true, args: { picks, uncertain, round: rd.value ?? 1, note: nt.value ?? null } }
  },
}

/** 所有需要前置校验的工具名 */
export const VALIDATED = Object.keys(V)

/**
 * 工具的统一入口校验。
 * @returns {{ok:true,args:object}} | {{ok:false,category:string,error:string,expected:string,example:string}}
 */
export function checkArgs(name, args) {
  const fn = V[name]
  if (!fn) return { ok: true, args: args ?? {} }        // 没有校验器的工具（内部工具）直接放行
  if (args !== undefined && !isObj(args)) {
    return ERR(
      `${name} 的参数必须是一个对象`,
      '所有工具的参数都是 JSON 对象，例如 {}',
      '{}',
    )
  }
  return fn(args ?? {})
}

export default { checkArgs, normLocator, ERR, USAGE, isObj, VALIDATED }
