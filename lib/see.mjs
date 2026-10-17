// see.mjs —— 所有「看」的操作：只报告**屏幕上的事实**，绝不判断"这是什么"。
//
// 三条铁律决定了本文件的写法：
// ① 只认 HTML 通用约定（input/select/textarea/role/aria-label），不抓任何一类页面的专用
//    选择器 —— 旧版那么做，页面一改版就平静地报告"什么都没有"，沉默的错误最危险。
// ② 不解析、不纠正、不猜测文字：DOM 中文可能被自定义字体搅过，读到什么原样报什么，
//    让大模型对着截图去认。
// ③ 输出里永不出现题号 / 题型 / 课程名 / 章节号 / 写死的网址 —— 那是业务概念。
//
// 编号规矩（点击准不准全靠它）：每次调用生成随机 token 作前缀，形如 `<token>:<k>`，
// 同时写进元素属性 `data-dsh-h`，hand.mjs 拿这个字符串在所有窗口里搜。所以编号只在
// 本次调用内有效（翻页/重调即失效，故意的），且与 frame 的顺序、数量无关。
// ⚠️ 编号里绝不带"位置"信息：旧版用排序后的框架序号，动态 iframe 会让同一个编号
//    一会儿指这个一会儿指那个，Agent 连点 4 次点不中。
// ⚠️ 两趟标记法：先写临时标记 `data-dsh-p`、全部窗口读完后统一换成 `data-dsh-h`，
//    保证"算第几处"和"编号写在哪"用的是同一批元素同一个顺序（旧版按坐标回填，已废）。

import { evalInFrameMatching } from './browser.mjs'
import { hash32 } from './gate.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// 窗口命名 —— 给大模型一个**说得出口**的名字
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 旧版把所有认不出的窗口统统叫「主页面」，结果 `byFrame:{主页面:38}` 看着像都在主页面，
//    实际是好几个子窗口混用一个名字 —— 拿主窗口坐标去点子窗口元素，自然点不动。
//    现在只有真正的顶层窗口叫「主页面」，其它一律 `子窗口:<域名>/<路径片段>`；
//    **不按网站起业务名字**（"视频模块"这种）—— 那是业务概念，站点一改路径就全错。
function frameLabel(url, { isMain = false } = {}) {
  if (!url || /^about:/.test(url)) return isMain ? '主页面' : '空窗口'
  if (isMain) return '主页面'
  try {
    const u = new URL(url)
    const seg = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).slice(-2).join('/')
    return `子窗口:${u.hostname}${seg ? '/' + seg.slice(0, 30) : ''}`
  } catch {
    return `子窗口:${String(url).slice(0, 40)}`
  }
}

/** 同名窗口去重：第二个往后缀 #2 #3，否则大模型分不清该点哪个 */
function uniqueLabels(labels) {
  const seen = new Map()
  return labels.map((l) => {
    const n = (seen.get(l) ?? 0) + 1
    seen.set(l, n)
    return n === 1 ? l : `${l}#${n}`
  })
}

/** 把这一页的所有窗口排一排 → [{ id, url, label, isMain, index, parentId }] */
async function labeledFrames(page) {
  const frames = (await page.frames().catch(() => [])) ?? []
  const mainId = frames[0]?.id ?? null
  const named = uniqueLabels(frames.map((f) => frameLabel(f.url, { isMain: f.id === mainId })))
  return frames.map((f, k) => ({
    id: f.id,
    url: f.url,
    label: named[k],
    isMain: f.id === mainId,
    index: k,
    // parentId：谁套着谁。只用在一处 —— 配对完成标记时判断
    // "这个标记和这处内容算不算一家人"（见 pickMark），与编号规则无关。
    parentId: f.parentId ?? null,
  }))
}

/** 空的 / 不可读的窗口直接跳过 —— 一页能挂十几个 about:blank，纯属浪费配额和时间 */
const isRealFrame = (f) => !!f.url && !/^about:/.test(f.url)

/**
 * 清掉某个窗口里上一轮留下的编号标记。
 *
 * ⚠️ 为什么每次"看"都要清：编号是**一次性的**。上一轮打上的标记如果留着，
 *    这一轮不再报它，可它还在 DOM 里 —— 于是已经失效的编号照样能点到东西，
 *    大模型会拿一个"过期的编号"点中一个**它没看过的**元素。
 *    这比"找不到"危险得多，所以宁可多花一次 eval。
 */
async function clearMarkers(page, fr) {
  return page.evalInFrame(fr.id, `(() => {
    let n = 0;
    for (const el of document.querySelectorAll('[data-dsh-h], [data-dsh-p]')) {
      el.removeAttribute('data-dsh-h');
      el.removeAttribute('data-dsh-p');
      n++;
    }
    return n;
  })()`).catch(() => 0)
}

const newToken = () => 'r' + Math.random().toString(36).slice(2, 8)

// ═══════════════════════════════════════════════════════════════════════════
// 浏览器端公共代码 —— 会被**内联进每个窗口自己**执行
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么写成字符串：跨域 iframe 只能靠 `Page.createIsolatedWorld` 注入，
// 拿到的是隔离世界，**共享不到我们的 JS 环境**，所以小工具只能在页面里再写一遍。
//
// ⚠️ 这里用 String.raw，所以反斜杠不会被我们这层吃掉。
//    以前用普通模板字符串时，`\s` 会被编译期吃成 `s`，
//    于是出现一片"选择器看着没问题、就是匹配不上"的怪事 —— 根因就是这个。
const BROWSER_HELPERS = String.raw`
  const __txt = (e) => {
    if (!e) return '';
    const t = (e.innerText || e.value || e.getAttribute('title') || e.getAttribute('aria-label')
      || e.textContent || '');
    return String(t).replace(/\s+/g, ' ').trim();
  };
  const __shown = (e) => {
    if (!e || e.nodeType !== 1) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    let n = e;
    while (n && n.nodeType === 1) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      n = n.parentElement;
    }
    return true;
  };
  const __rect = (e) => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             top: Math.round(r.top), left: Math.round(r.left),
             w: Math.round(r.width), h: Math.round(r.height) };
  };
  // 屏幕上的文字原样报出（**不纠正乱码** —— 大模型要看的就是真实样子）
  const __short = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 80);
  // 选项标签：屏幕上写着的那一两个字符。
  //
  // 契约的三级降级要的是 **"A"**，不是 "A第一个说法"。所以取前缀，
  // 但**遇到普通汉字就立刻停** —— 否则 "A第一个说法" 会变成 "A第"，
  // 拿这种标签去做对账，"A 对" 和 "A 错" 还会被去重逻辑当成同一个选项吞掉。
  // （实测就是这么错的：第一版把紧随其后的任意汉字都收进标签，"第" 被吃了进来。）
  const __shortLabel = (s) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, '');
    if (!t) return '';
    const c2 = t[1] || '';
    // 第二个字符是字母/数字，或者本身就是"对错是否"这类**单词式选项** → 两个都要
    // 例："A错" → "A错"（字母一律保留），"对" → "对"，"甲" → "甲"
    if (/[A-Za-z0-9]/.test(c2) || /[\u5bf9\u9519\u662f\u5426\u6b63\u8bef]/.test(c2)) return t.slice(0, 2);
    // 第二个字符是标点（"A." "A、" "A）"）→ 只要字母本身
    if (/[.、．,，)）:：\]】]/.test(c2)) return t[0];
    // 不然就是"A第一个说法"这种：一个字母后面跟着正文，只要字母
    return t[0];
  };
  // 选中态：只看**确实表示选中**的信号。
  //
  // ⚠️ 必须用 **ASCII** 的 \b，不能用 (^|[^a-z])。
  //    中文既不是 \w 也不是 [a-z]，所以 [^a-z] 会把中文当成边界 ——
  //    实测 "记得我" 里的 "记得" 因此被匹配中，一个普通复选框被报成"已选"。
  //    用 \b 之后只有真正的类名边界才算数。
  const __selClass = (cls) => /\b(cur|active|checked|selected|on)\b/i.test(String(cls || ''));
  // ⚠️ 完成态只按页面坐标跟 marks 配对（见 pickMark），**不看元素自己/祖先身上的完成信号**：
  //    跨窗口时后者永远看不到标记，旧版因此把 done 全报 false 骗过模型。
  //    （原 __doneMark / __doneMarkOpts / __doneMarkWide 一族是那个错误做法的残留，
  //      2026-10-17 删除 —— grep 确认零调用点，且 BROWSER_HELPERS 是字面量、不拼它们的源码。）
  // 一个选项"该用哪块元素来说自己叫什么"。
  //
  // ⚠️ 为什么不能简单用 parentElement：复选框/单选框经常是 body 的直接子元素，
  //    于是 parentElement === body，而 body 的 innerText 是**整页文字** ——
  //    一个"记住我"的复选框会被读成整页内容。实测就是这么错的。
  //    有 <label> 就用 label（它天然只含这一个选项的文字），否则退回就近的小容器。
  const __optBox = (el) => {
    const lab = el.closest && el.closest('label');
    if (lab) return lab;
    const near = el.closest && el.closest('li, dd, td, p');
    if (near) return near;
    const p = el.parentElement;
    if (!p || p.tagName === 'BODY' || p.tagName === 'HTML') return el;
    return p;
  };
  const __inOpt = (el, opts) => opts.some((o) => o === el || o.contains(el) || el.contains(o));
  // 一处的"容器"：从选项元素往上找，但**不许越过 body**。
  //
  // ⚠️ 实测踩的坑：复选框/单选框常常是 body 的直接子元素（没有 form、没有外层 div）。
  //    这时直接取 parentElement 会拿到 **body** —— 于是"这一处"变成了整个页面：
  //    组标题变成整页文字，完成态也会被页面上随便一个 ✓ 污染。
  //    拿不准宁可退回选项元素自己，也不要退到 body。
  const __containerOf = (el) => {
    const p = el && el.parentElement;
    if (!p) return el;
    if (p.tagName === 'BODY' || p.tagName === 'HTML') return el;
    return p;
  };
  // 组的标题：从近到远找一个"自己有文字、又不属于任何选项"的祖先
  // ⚠️ 同样**不许越过 body**：越过之后拿到的就是整页文字，那比没有标题更糟。
  const __groupLabel = (container, opts) => {
    let n = container, up = 0;
    while (n && n.nodeType === 1 && up < 4 && n.tagName !== 'BODY' && n.tagName !== 'HTML') {
      const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ');
      const lab = __short(own || n.getAttribute('aria-label') || '', 40);
      if (lab && !__inOpt(n, opts)) return lab;
      n = n.parentElement; up++;
    }
    return '';
  };

  // ── 完成标记：只信 aria-label，**绝不看 class** ─────────────────────────────
  //
  // 实测（真机）：同一页面上「已完成」和「未完成」两个标记的 class 一模一样，差别只在
  // aria-label 上。按 class 判断必然双向出错（做完的报没做、没做的报做完）。
  //
  // ⚠️ 判定顺序要紧：先判「未」再判「完成」——「未完成」里也含「完成」，顺序反了会把
  //    "没做完"说成"做完了"，而这个字段是给模型判断"记上了没有"用的，说反代价最大。
  // 用词通用（中 + 英），不认任何站点结构。
  const __markState = (a) => {
    if (!a) return null;
    const t = String(a);
    if (/未完成|没完成|未通过|未读|未看|not\s*(done|complete|finished)|incomplete|unfinished|undone|todo|pending|in\s*progress/i.test(t)) return false;
    if (/已完成|完成|已通过|已读|已看|done|complete|finished/i.test(t)) return true;
    return null;      // 提到了"完成"但判不出是哪种 → 不猜
  };
  // 元素所属的「一块」：往上第一个**够大的**祖先（高 ≥ 120 且宽 ≥ 80）。
  //
  // 为什么要有它：完成标记本身只有二十来像素高（实测是一条横贯整栏的窄条，
  // 888×22），"它下面那一整块内容"才是这一条。配对时必须拿**这一块的范围**去框，
  // 否则页面下方随随便便一处能点的东西，都会认到最近那个标记头上
  // （实测：右侧目录里几十项、底部的翻页按钮，本来都会被当成"某一条没完成"）。
  const __blockOf = (el) => {
    let n = el && el.parentElement, up = 0;
    while (n && n.nodeType === 1 && n.tagName !== 'BODY' && n.tagName !== 'HTML' && up < 8) {
      const r = n.getBoundingClientRect();
      if (r.height >= 120 && r.width >= 80) {
        return { left: Math.round(r.left), top: Math.round(r.top),
                 width: Math.round(r.width), height: Math.round(r.height) };
      }
      n = n.parentElement; up++;
    }
    return null;      // 找不到"够大的一块" → 如实报 null（上层退回"只看正上方最近的那个"）
  };
  // 把**这一个窗口里**所有「完成 / 未完成」标记读出来（每个窗口各调一次）。
  //
  // ⚠️ 实测教训（这一版为什么必须存在）：内容（视频）在各自的内容窗口里，
  //    完成标记却在**另一个窗口**里。跨窗口时元素的祖先链互相看不到 ——
  //    从内容往上走永远也走不到那个标记，于是旧实现把 done 全报成 false。
  //    大模型因此以为"它们都没做完"，只能靠肉眼看截图。
  //    现在：标记单独读出来，配对交给坐标（见 Node 侧的 pickMark）。
  const __marksIn = () => {
    const out = [];
    for (const e of document.querySelectorAll('[aria-label]')) {
      const aria = e.getAttribute('aria-label') || '';
      const st = __markState(aria);
      if (st === null) continue;         // 跟"完成"无关的先跳过（先判文字再量位置，省时间）
      if (!__shown(e)) continue;         // 屏幕上看不见的不算
      const r = e.getBoundingClientRect();
      out.push({
        aria: __short(aria, 60),
        text: __short(e.textContent || '', 40),
        done: st === true,               // 这个标记自己说完成没有
        left: Math.round(r.left),
        top: Math.round(r.top),          // 顶边：实测标记就贴在内容区正上方，顶边配对最准
        width: Math.round(r.width),
        height: Math.round(r.height),
        block: __blockOf(e),             // "它管着哪一块"（量不到就是 null）
      });
    }
    // 同一个标记外面还套了一层也带 aria-label 时，会是同坐标同文字的重复 → 去重
    const dedup = [];
    for (const m of out) {
      if (!dedup.some((d) => d.aria === m.aria && Math.abs(d.top - m.top) < 4)) dedup.push(m);
    }
    return dedup;
  };
  // 这一页有哪些「大块」（内容区）：从每个种子往上找它所属的那一块。
  //
  // 种子有两类，**两类都要**：
  //   ① 每一处可操作的元素 —— 报得出"这块里有几处可操作"
  //   ② 每一个装着内容的子窗口 —— 正文区常常是"一块套一个子窗口"，
  //      只从元素往上找的话，就看不到"这一页排着 N 块"这个整体形状
  //      （实测：内容都在子窗口里，光看元素完全建立不起"有 6 条"的印象）
  //
  // 只报"哪儿是一大块、里面有几处可操作"，**不解释这是什么**（不写"这是测验"）。
  const __blocksIn = (seeds) => {
    const out = [], seen = new Set();
    for (const el of seeds) {
      if (!el || el.nodeType !== 1 || !__shown(el)) continue;
      const b = __blockOf(el);
      if (!b) continue;
      const key = b.left + ',' + b.top + ',' + b.width + ',' + b.height;
      if (seen.has(key)) continue;       // 同一个位置只报一次（套了几层壳也只算一块）
      seen.add(key);
      out.push(b);
      if (out.length >= 60) break;
    }
    return out;
  };
`

// ═══════════════════════════════════════════════════════════════════════════
// readAreas —— 这一页有几个"要处理的地方"
// ═══════════════════════════════════════════════════════════════════════════
//
// 不带任何业务分类，只把屏幕拆成"可操作的地方"，每处给一个 kind（四种，多一种都不许加）：
//   pick（一组同类可选项）/ write（能输入文字）/ button（能点）/ media（播放器）
//
// ★ 识别规则故意放宽：宁可多报不可漏报 —— 漏报的代价是模型看不见那处活、整页卡死，
//   多报只是它多看一眼。这个不对称决定一切取舍。
//
// 除平铺的 areas 还报两样"光看元素看不出来"的：
//   marks　完成/未完成标记（含子窗口）。必须单独报：内容在各自窗口里、标记在别的窗口，
//         　祖先链跨不过窗口，从内容往上找永远找不到 —— 旧实现因此把 done 全报 false。
//   layout　哪儿是一大块、里面有几十处可操作。只报形状，不解释那是什么。
//
// ⚠️ done 三态是本文件最要紧的事实纪律：true/false = 看到标记且它这么说；
//   null = **我没看到标记**（不是"没完成"）。把"读不到"报成"没完成"骗到过模型。
//
// 跨窗口坐标：子窗口里 getBoundingClientRect 给的是那个窗口自己的局部坐标，而
// hand_click({x,y}) 和截图用的是主窗口视口坐标，必须加上窗口偏移（见 frameOffsets；
// hand.mjs 用同一套算法）。量不到就报 null —— 宁可退回用编号点，也绝不猜一个偏移。
async function frameOffsets(page) {
  const out = new Map()
  if (typeof page?.frameRects !== 'function') return out
  try {
    const rects = await page.frameRects()
    if (!Array.isArray(rects) || !rects.length) return out
    const n = (v) => (Number.isFinite(v) ? Number(v) : 0)
    const mx = n(rects[0] && rects[0].x)
    const my = n(rects[0] && rects[0].y)
    for (const r of rects) {
      const id = typeof r.frame === 'string' ? r.frame : (r.frame && r.frame.id) || r.frameId || null
      if (!id) continue
      // w/h 也带上：块比窗口还高的时候要拿窗口框裁一刀（见 layout 那段），
      // 裁出来的必须是"屏幕上真正看得见的那部分"。
      // toViewport 只用 x/y，多加这两个不影响任何坐标换算。
      out.set(id, {
        x: n(r.x) - mx, y: n(r.y) - my,
        w: Math.max(0, n(r.width)), h: Math.max(0, n(r.height)),
      })
    }
  } catch { /* 量不到就走"不给坐标"的路 */ }
  return out
}

/**
 * 把某个窗口里的局部坐标换算成主窗口视口坐标。
 * 量不到偏移 → `{ x: null, y: null }`（如实说"这处没有可用坐标"，而不是给一个错的）。
 */
function toViewport(off, x, y) {
  if (!off || !Number.isFinite(x) || !Number.isFinite(y)) return { x: null, y: null }
  return { x: Math.round(x + off.x), y: Math.round(y + off.y) }
}

// ═══════════════════════════════════════════════════════════════════════════
// 完成标记 ↔ 内容的配对（"done 全报 false"那个 bug 的正解）
// ═══════════════════════════════════════════════════════════════════════════
//
// 实测现场：4 个内容窗口各装一个视频，完成标记全在**另一个窗口**里，是四条窄条，
// 分别压在自己那条内容块的正上方；「已完成」和「未完成」的 class 一模一样 → 只有
// aria-label 可信。旧实现从内容元素往上走祖先链 → 跨窗口必然看不到 → 全报 false，
// 模型原话"done fields ... were all false"，只能肉眼看截图。
// 所以改成**只按坐标配对**：done true/false = 上方最近的标记这么说；null = 我没看到标记。
// ⚠️ null 和 false 必须分开 —— 把"读不到"报成"没完成"正是这次骗到模型的原因。

/** 点在不在这块矩形里（左/上/宽/高，两套坐标里形状一样，只是整体平移过） */
function containsPoint(x, y, b) {
  if (!b || !Number.isFinite(x) || !Number.isFinite(y)) return false
  return x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height
}

/** 外框 o 是否把内框 i 整个套住（两边必须已经在同一套坐标里） */
function rectContains(o, i) {
  return o.left <= i.left && o.top <= i.top
    && o.left + o.width >= i.left + i.width
    && o.top + o.height >= i.top + i.height
}

/**
 * 一处内容的完成态 ← 它**上方最近的那个**标记。
 *
 * 同窗口：直接按窗口内位置取"正上方最近的"（mark.y <= area.y 且最近）。
 * 跨窗口：光看坐标不够（别的窗口里恰好挨着的东西会被误认成一家人），加两条判据：
 *   ① 亲戚关系 —— 内容必须在标记所在窗口的下级窗口里（或同窗口）；
 *   ② 归属范围 —— 标记若有"自己管的那一块"，内容中心点必须落在那块里，
 *      否则下面另一个没标记的模块也会被算成"已完成"；标记没有块范围时退回
 *      "正上方最近 + 1600px 上限"（页面很长时上一个条目的标记也在上面）。
 * 都量不到 → null（读不到就是读不到，不猜）。
 */
function pickMark(markRows, area, isAncestorFrame) {
  let best = null
  let bestKey = -Infinity
  for (const m of markRows) {
    const sameFrame = m.frameId === area.frameId
    if (!sameFrame && !isAncestorFrame(m.frameId, area.frameId)) continue
    let key
    if (sameFrame) {
      if (!(m.top <= area.top)) continue
      key = m.top
    } else {
      // 跨窗口：只有两边的页面坐标都量到了才敢配
      if (m.gTop === null || area.gTop === null) continue
      if (!(m.gTop <= area.gTop)) continue
      if (m.gBlock) {
        if (!containsPoint(area.gx, area.gy, m.gBlock)) continue
      } else if (area.gTop - m.gTop > 1600) continue
      key = m.gTop
    }
    if (key > bestKey) { bestKey = key; best = m }     // 取最靠下的 = 上方最近的那个
  }
  return best ? best.done === true : null
}

export async function readAreas(page, { full = false } = {}) {
  const token = newToken()
  const frames = await labeledFrames(page)
  const real = frames.filter(isRealFrame)

  // 窗口的父子关系 → 只给配对用（见 pickMark 里"跨窗口"那两条判据）。
  // 判据里必须能回答"这个标记是不是套着这处内容的那一层窗口里的"。
  const parentOf = new Map(frames.map((f) => [f.id, f.parentId ?? null]))
  const isAncestorFrame = (anc, of) => {
    let n = of
    for (let hops = 0; n && hops < 24; hops++) {
      if (n === anc) return true
      n = parentOf.get(n) ?? null
    }
    return false
  }

  const top = await page.eval(`(() => ({ url: location.href, title: document.title }))()`)
    .catch(() => ({ url: null, title: null }))

  // 每个窗口的额度。不给上限的话，一个装满链接的导航窗口能把整页吃光，
  // 真正的内容一条都列不出来（实测：目录侧栏挂着一百多个小节）。
  const perFrame = full ? 120 : 40
  const maxAreas = full ? 200 : 80

  const collected = []
  // realOf = 真正收下了东西的窗口，带上"这个窗口收了几条"。
  // 组装编号时只认这个列表，保证 base 与采集时用的 base 完全一致。
  const realOf = []
  // seenFrames = 每个读到的窗口，连同它的**完成标记**和**大块**。
  //
  // ⚠️ 为什么不能挂在 realOf 上：有的窗口只有标记、没有可操作元素
  //    （光看内容区就能发现这种情况）。挂在 realOf 上会把它的标记漏掉，
  //    于是 marksTotal 少一个 —— 而模型正是靠这个数"这一页有几条"。
  const seenFrames = []

  for (const fr of real) {
    // 先把这一页**所有窗口**里上一次留下的标记清掉。
    //
    // ⚠️ 不清会出这个错：上一次调用给某个元素打了编号，这次它不再被算作"一处"
    //    （被额度截断、或者规则变了），可标记还挂在 DOM 上 ——
    //    于是"这个编号已经失效"永远查不出来，点击会点到上一轮的旧元素上。
    //    编号失效必须**真的失效**。
    await clearMarkers(page, fr)
  }

  for (const fr of real) {
    if (collected.length >= maxAreas) break
    const base = collected.length     // 本窗口第一条记录在全局的序号（编号的唯一来源）

    const got = await page.evalInFrame(fr.id, `(() => {
      ${BROWSER_HELPERS}
      // ⚠️ token 必须**传进页面**，标记必须在这里就写成最终编号。
      //    早先只在 Node 侧拼 token 前缀，而页面里写的是裸露的 "0:1" ——
      //    于是 readAreas 报出来的编号和 DOM 上挂着的编号**根本不是一回事**，
      //    按编号点击必然找不到。这种"报的和标的不是同一个"最难查，
      //    所以规矩定死：页面里写什么，就报什么。
      //    （注意：这段注释本身在模板字符串里面，所以这里**不能**出现反引号。）
      const token = ${JSON.stringify(token)};
      const base = ${base};
      const out = [];
      const claimed = new Set();   // 一个元素只许被一种规则认领，免得重复报
      let seq = 0;
      // 一处（含它的选项）的编号 = "<token>:<窗口内全局序号>"，选项再加 "o<序号>"
      const idOf = (g) => token + ':' + (base + g);

      // ── 把一组选项变成一条 pick 记录 ──────────────────────────────────
      // container 允许不传：不传就从选项元素自己往上找（同样不许到 body）。
      const addOpts = (container, opts, opener) => {
        const usable = opts.filter((o) => o && o.el && __shown(o.el));
        if (!usable.length) return;          // 屏幕上根本看不见 → 不算一处
        const box = container || __containerOf(usable[0].el);
        const g = seq++;
        // 一处的矩形 = **所有选项的并集**（一整道题的范围）。
        // 早先只取第一个选项的坐标、而且没有宽高 —— eye_paper 因此量不出题目区，
        // 按编号裁剪也会只框住第一个选项。
        const boxes = usable.map((o) => __rect(o.el));
        const bx = Math.min(...boxes.map((b) => b.left));
        const by = Math.min(...boxes.map((b) => b.top));
        const br = Math.max(...boxes.map((b) => b.left + b.w));
        const bb = Math.max(...boxes.map((b) => b.top + b.h));
        const pos = { x: Math.round((bx + br) / 2), y: Math.round((by + bb) / 2),
                      top: by, left: bx, w: br - bx, h: bb - by };
        const anchor = opener || box || usable[0].el;
        // ⚠️ 原生 <select> 的每个 option 都指向**同一个** <select> 元素：
        //    逐个写 data-dsh-p 的话，后写的编号会把先写的覆盖掉，元素上只剩
        //    最后一个选项的编号 —— 模型按 o0 / o1 来点，会**静默点到最后一个
        //    选项上**（不报错，只是点错）。这种错最难查。
        //    所以：所有选项共用同一个元素时，把**区编号**挂在这个元素上
        //    （点它 = 点开这个下拉框，语义正合适）；选项编号不对应任何元素，
        //    按编号点会明确找不到 —— 明确找不到好过默默点错。
        const sameEl = usable.every((o) => o.el === usable[0].el);
        usable.forEach((o, k) => {
          o.el.setAttribute('data-dsh-p', sameEl ? idOf(g) : idOf(g) + 'o' + k);
          claimed.add(o.el);
        });
        if (anchor) claimed.add(anchor);
        out.push({
          kind: 'pick', g, groupTag: (anchor.tagName || ''),
          label: __groupLabel(anchor, usable.map((o) => o.el)),
          opts: usable.map((o) => ({
            text: __short(o.text, 60),
            short: __shortLabel(o.text),
            raw: __short(o.raw, 24),
            selected: o.checked === true || o.aria === 'true' || __selClass(o.cls),
          })),
          // ⚠️ 这里原来把「元素自己/祖先身上的完成信号」当成 done（__doneMarkOpts）：
          //    跨窗口时它**永远**是 false（标记在别的窗口里，祖先链走不过去），
          //    大模型因此以为"全都没做完"。现在 done 由 Node 侧按页面坐标配对算
          //    （见 pickMark），找不到标记就报 null，绝不拿"读不到"充当"没完成"。
          x: pos.x, y: pos.y, top: pos.top, left: pos.left, w: pos.w, h: pos.h,
        });
      };

      // ── ① 单选 / 复选 ──────────────────────────────────────────────────
      // name 相同的算一组（HTML 自己的约定，任何网站都得遵守）。
      // 没有 name 的（前端框架动态渲染很常见）退回"最近的公共父容器里"。
      const groups = new Map();
      for (const el of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
        if (claimed.has(el)) continue;
        const nm = el.getAttribute('name');
        let key;
        if (nm) key = 'n:' + nm;
        else {
          let n = el, up = 0, k = 'self';
          while (n && n.parentElement && up < 4) {
            const sibs = [...n.parentElement.children]
              .filter((s) => s.querySelector && s.querySelector('input[type=radio], input[type=checkbox]'));
            if (sibs.length >= 2) { k = 'p' + __short(__txt(n.parentElement), 20); break }
            n = n.parentElement; up++;
          }
          key = 'c:' + k;
        }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }
      for (const list of groups.values()) {
        const opts = list.map((el) => {
          const box = __optBox(el);
          return {
            el: box,
            text: __txt(box) || el.value || '',
            raw: el.value,
            checked: el.checked === true,
            aria: el.getAttribute('aria-checked'),
            cls: String(box.className || '') + ' ' + String(el.className || ''),
          };
        });
        addOpts(__containerOf(opts[0].el), opts, null);
      }

      // ── ② 下拉框：自己一处，每个 option 一个选项 ───────────────────────
      for (const sel of document.querySelectorAll('select')) {
        if (claimed.has(sel) || !__shown(sel)) continue;
        const opts = [...sel.options]
          .filter((o) => String(o.text || o.label || '').trim())
          .map((o) => ({
            el: sel, text: o.text || o.label, raw: o.value,
            checked: o.selected === true, aria: null, cls: '',
          }));
        if (!opts.length) continue;
        addOpts(sel.closest('label') || sel.parentElement, opts, sel);
      }

      // ── ③ role=radiogroup 之类的容器 ──────────────────────────────────
      for (const box of document.querySelectorAll('[role=radiogroup], [role=listbox], [role=group]')) {
        if (claimed.has(box) || !__shown(box)) continue;
        const kids = [...box.querySelectorAll('[role=radio], [role=checkbox], [role=option], [role=menuitemradio]')]
          .filter((e) => !claimed.has(e));
        if (!kids.length) continue;
        addOpts(box, kids.map((el) => ({
          el, text: __txt(el), raw: el.getAttribute('data-value') || el.getAttribute('value'),
          checked: el.getAttribute('aria-checked') === 'true' || __selClass(el.className),
          aria: el.getAttribute('aria-checked'), cls: el.className || '',
        })), null);
      }

      // ── ④ 兜底：一串并列的兄弟节点，各自带一个短标签 ──────────────────
      //
      // ★ 这条是"宽"的关键。实测不少页面（尤其被前端框架重写的答题区）
      //   根本不用 input/role，就是几个 <li>/<div> 排一排，开头是 A/B/C/对/错。
      //   只认标准控件的话，这些地方会**整页消失**。
      //
      //   判据故意写得松：兄弟 ≥2、每个可见、每个开头 1–2 个字符、
      //   开头字符互不相同（=一串平行的选择）。
      //   宁可把导航项也报成 pick —— 大模型看一眼就知道那不是要挑的东西，
      //   而漏掉真正要挑的那处，它就彻底没救了。
      for (const p of document.querySelectorAll('ul, ol, dl, tbody, [role=list], [role=tablist]')) {
        if (claimed.has(p) || !__shown(p)) continue;
        const kids = [...p.children].filter((c) => c.nodeType === 1 && __shown(c) && !claimed.has(c));
        if (kids.length < 2 || kids.length > 12) continue;
        const texts = kids.map((c) => __txt(c));
        const firsts = texts.map(__shortLabel);
        if (firsts.some((f) => !f)) continue;
        if (new Set(firsts).size !== firsts.length) continue;
        addOpts(p, kids.map((c, k) => ({
          el: c, text: texts[k], raw: firsts[k],
          checked: __selClass(c.className), aria: c.getAttribute('aria-checked'), cls: c.className || '',
        })), null);
      }

      // ── ⑤ 写字的 ──────────────────────────────────────────────────────
      const WRITE_SEL = 'textarea, input[type=text], input[type=search], input[type=number],'
        + ' input[type=password], input[type=tel], input[type=email], input[type=url],'
        + ' input:not([type]), [contenteditable=true], [contenteditable=""]';
      for (const el of document.querySelectorAll(WRITE_SEL)) {
        if (claimed.has(el) || !__shown(el)) continue;
        // 隐形的输入框（很多组件拿它存值）不是"写字的地方"
        if (el.tagName === 'INPUT' && /hidden|checkbox|radio|submit|button|file|image|range|color/i.test(el.type || '')) continue;
        const g = seq++;
        el.setAttribute('data-dsh-p', idOf(g));
        claimed.add(el);
        const pos = __rect(el);
        const lbl = el.getAttribute('aria-label') || el.getAttribute('placeholder')
          || (el.closest('label') ? el.closest('label').textContent : '') || '';
        const val = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? String(el.value || '') : __txt(el);
        out.push({
          kind: 'write', g, tag: el.tagName, label: __short(lbl, 60),
          value: __short(val, 200), valueLen: val.length,
          // done 不在这里算 —— 只按页面坐标跟完成标记配对（同上面 pick 的说明）
          x: pos.x, y: pos.y, top: pos.top, left: pos.left,
        });
      }

      // ── ⑥ 能点的 ──────────────────────────────────────────────────────
      const BTN_SEL = 'button, input[type=submit], input[type=button], input[type=reset],'
        + ' [role=button], [role=link], [onclick]';
      const pushBtn = (el, tag) => {
        const g = seq++;
        el.setAttribute('data-dsh-p', idOf(g));
        claimed.add(el);
        const pos = __rect(el);
        const t = __txt(el);
        out.push({
          kind: 'button', g, tag,
          // aria-label / title 兜底：纯图标按钮（确认框的「提交」常见）没文字，不给名字模型只能盲点
          label: __short(t || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '', 60),
          href: el.getAttribute('href') || null,
          onclick: __short(el.getAttribute('onclick') || '', 90) || null,
          x: pos.x, y: pos.y, top: pos.top, left: pos.left,
        });
      };
      for (const el of document.querySelectorAll(BTN_SEL)) {
        if (claimed.has(el) || !__shown(el)) continue;
        pushBtn(el, el.tagName);
      }
      // 带 onclick 的 <a>：提交链接常常是这种（<a href="javascript:…">）。
      // 只取有文字的 —— 否则一页几十个图标链接会把额度吃光。
      for (const el of document.querySelectorAll('a[onclick], a[href^="javascript:"]')) {
        if (claimed.has(el) || !__shown(el)) continue;
        if (!__txt(el)) continue;
        pushBtn(el, 'A');
      }

      // ── ⑦ 播放器 ──────────────────────────────────────────────────────
      for (const el of document.querySelectorAll('video, audio')) {
        if (claimed.has(el)) continue;
        const g = seq++;
        el.setAttribute('data-dsh-p', idOf(g));
        claimed.add(el);
        const pos = __rect(el);
        out.push({
          kind: 'media', g, tag: el.tagName,
          label: __short(__txt(el) || el.getAttribute('aria-label') || '', 60),
          media: el.tagName === 'AUDIO' ? 'audio' : 'video',
          paused: el.paused === true, ended: el.ended === true,
          at: Number.isFinite(el.currentTime) ? +el.currentTime.toFixed(1) : null,
          duration: Number.isFinite(el.duration) && el.duration > 0 ? +el.duration.toFixed(1) : null,
          x: pos.x, y: pos.y, top: pos.top, left: pos.left,
        });
      }

      // ── ⑧ 完成标记 + 内容区（**只读**，不占编号、不认领元素）────────────
      //
      // ⚠️ 必须在所有编号都认领完之后再采集，且不许动 seq / claimed：编号规则是契约定的，
      //    在这里多认领一个元素，整段编号往后错位、点击点到别的东西上。
      //
      // 完成标记单独读：内容在各自子窗口里、标记在另一个窗口里，祖先链跨不过窗口，
      // 从内容那边永远看不到标记（旧实现就是这么全报 false 的）。
      // 内容区（大块）要读：只给平铺元素，模型建立不起"有正文区、里面有 N 条"的印象。
      const seeds = [...claimed];
      for (const f of document.querySelectorAll('iframe, frame')) {
        const fr2 = f.getBoundingClientRect();
        if (__shown(f) && fr2.height >= 120) seeds.push(f);   // 装着内容的子窗口也算一块
      }
      const blocks = __blocksIn(seeds);
      const marks = __marksIn();

      // 本窗口内先按屏幕从上到下排，再截额度 ——
      // 这样"截掉的一定是最下面那些"，最上面几处永远在
      out.sort((a, b) => (a.top - b.top) || (a.left - b.left));
      return { areas: out.slice(0, ${perFrame}), blocks, marks };
    })()`).catch(() => null)

    if (!got) continue
    // 标记 / 大块跟"这个窗口有没有可操作元素"无关 —— 先收下，
    // 免得只有标记没有元素的窗口被下面的 continue 一起丢掉。
    seenFrames.push({
      fr,
      marks: Array.isArray(got.marks) ? got.marks : [],
      blocks: Array.isArray(got.blocks) ? got.blocks : [],
    })
    const recs = Array.isArray(got.areas) ? got.areas : []
    if (!recs.length) continue
    // 记下这一窗**实际收下**了几条 —— 组装编号时只认这个数
    // （超额度 / 超 perFrame 被截掉的那些元素，页面里**没有**写标记，
    //   所以绝不能给它们编号，否则整段编号都会往后错位）。
    const kept = Math.min(recs.length, maxAreas - collected.length)
    for (let k = 0; k < kept; k++) {
      collected.push(recs[k])
    }
    realOf.push({ ...fr, count: kept, ptr: collected.length - kept, base })
  }

  // ── 编号回填：临时标记 → 正式标记 ─────────────────────────────────────
  //
  // 采集时写进 `data-dsh-p` 的**就是最终编号**（形如 `r7k2p1:5`，选项是 `r7k2p1:5o0`），
  // 这里原样搬到 `data-dsh-h` 并清掉临时标记。
  // 两趟用的是**同一批元素、同一套编号**，所以不可能串号；
  // 而且页面里挂的和下面 areas[].i 报的是同一个字符串 —— 点击才对得上。
  for (const fr of real) {
    await page.evalInFrame(fr.id, `(() => {
      const pend = [...document.querySelectorAll('[data-dsh-p]')];
      for (const el of pend) {
        el.setAttribute('data-dsh-h', el.getAttribute('data-dsh-p'));
        el.removeAttribute('data-dsh-p');
      }
      return pend.length;
    })()`).catch(() => 0)
  }

  // ── 组装成契约里的 area 形状 ─────────────────────────────────────────
  //
  // ⚠️ 顺序 = 屏幕上从上到下：先按窗口分组（跨窗口没有可信的全局坐标，不猜偏移），
  //    窗口内从上到下。这一点如实写进 note。
  // ⚠️⚠️ "数组顺序"和"编号 i"是两件必须分开的事：
  //      · 顺序 = 模型说"第 2 处"时看到的次序 → 按屏幕位置（top→left）排
  //      · i    = 页面里写死的字符串（token:base+g）→ 只能由 g 算出来
  //    早先让顺序跟着 g 走（g 是认领顺序，控件类型一批批来），于是"第 3 处"在屏幕上
  //    排到第 1 处前面；反过来也不能用"它是这窗第几条"推 i。实测报出来的 `:2` 其实是
  //    textarea（g=3）、`:3` 是 select（g=1），点"提交"点到别的东西上。
  //    （这条错最难查：编号内部自洽，只有和 DOM 对照才看得出来。）
  const areas = []
  // ★ 跨窗口坐标换算：子窗口报的 x/y 必须加上该窗口的偏移，才是"主窗口视口坐标"。
  //   量不到就报 null —— 那几处退回用编号点，绝不猜。
  const offs = await frameOffsets(page)

  // ── 完成标记：换算到**和 areas 的 x/y 同一套**坐标（主窗口视口坐标）──────
  //
  // 内部记两种坐标：局部（窗口内，同窗口配对时用）+ 页面（跨窗口配对时用）。
  // 外面只报页面坐标 —— 量不到偏移就报 null，**不猜**。
  const markRows = []
  for (const { fr, marks: ms } of seenFrames) {
    const off = offs.get(fr.id)
    for (const m of ms) {
      const v = toViewport(off, m.left, m.top)
      markRows.push({
        frameId: fr.id,
        label: fr.label,
        aria: m.aria,
        text: m.text || '',
        done: m.done === true,                 // 这个标记自己说完成没有
        top: m.top,                            // 局部顶边（同窗口配对用）
        gTop: v.y,                             // 页面顶边（跨窗口配对 + 对外报的 y）
        gBlock: (off && m.block)
          ? { left: m.block.left + off.x, top: m.block.top + off.y,
              width: m.block.width, height: m.block.height }
          : null,
      })
    }
  }
  // 按页面 y 排一下，纯粹为了报出去的时候是从上到下（配对不依赖顺序）。
  // 量不到页面坐标的排在最后 —— 不跟量到的混着比（那是两套坐标，比出来的顺序没意义）。
  markRows.sort((a, b) => {
    const k = (m) => (m.gTop === null ? Number.POSITIVE_INFINITY : m.gTop)
    return k(a) - k(b)
  })

  // 每一处内容的位置：给配对（顶边）和大块计数（中心点）各留一份
  const areaPts = []      // { frameId, lx, ly, gx, gy }
  for (const fr of realOf) {
    const recs = collected.slice(fr.ptr, fr.ptr + fr.count)
      .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    const off = offs.get(fr.id)
    for (const r of recs) {
      // i 必须**和页面上挂着的字符串一字不差**：页面里写的是 token:base+g，
      // 所以这里也用同一对 (base, g) 算，绝不另起一套序号。
      const i = `${token}:${fr.base + r.g}`
      const options = Array.isArray(r.opts)
        ? r.opts.map((o, k) => ({
            i: `${i}o${k}`,                          // 选项编号也是标记，hand_pick 靠它点
            label: o.short || String(k + 1),          // 三级降级：短标签 → 序号
            text: o.text || '',
            selected: o.selected === true,
          }))
        : []
      // filled 的三种形态：挑 → 选中的标签数组；写 → 当前文字；其余 → 空数组
      const filled = r.kind === 'pick'
        ? options.filter((o) => o.selected).map((o) => o.label)
        : (r.kind === 'write' ? String(r.value || '') : [])
      const v = toViewport(off, r.x, r.y)
      // ★ done：按页面坐标跟"上方最近的那个完成标记"配对 ——
      //   配对不上就是 null（= 我没看到标记），**绝不**退成 false（= 它说没完成）。
      //   这两种情况混在一起，正是上一版骗到模型的地方。
      const done = pickMark(markRows, {
        frameId: fr.id,
        top: r.top,                    // 窗口内顶边（同窗口配对用；量不到偏移时只剩这条路）
        gTop: off ? Math.round(r.top + off.y) : null,
        gx: v.x, gy: v.y,              // 页面中心点（跨窗口落块判断）
      }, isAncestorFrame)
      areas.push({
        i,
        kind: r.kind,
        label: r.label || (r.kind === 'media' ? '播放器' : ''),
        options,
        filled,
        done,
        frame: fr.label,
        frameUrl: String(fr.url || '').slice(0, 120),
        w: Number.isFinite(r.w) ? r.w : null,
        h: Number.isFinite(r.h) ? r.h : null,
        ...v,
      })
      areaPts.push({ frameId: fr.id, lx: r.x, ly: r.y, gx: v.x, gy: v.y })
    }
  }

  // ── layout：这一页"哪儿是一大块、里面有几处可操作" ─────────────────────
  //
  // 为什么要有（实测教训）：只报一堆平铺元素，模型建立不起"这一页有个正文区、里面有 6 条"
  // 的整体印象，只能一条一条摸。
  // ⚠️ 只报**形状**（大块位置、高矮、里面有几处可操作），不许解释这是什么 —— 那是大模型的活。
  // 判据：某一处的**中心点**（= areas[].x/y 报出去的那个点）落在这块矩形里就算"这块里面的一处"。
  // x 和 y 都要看 —— 只看 y 的话右边目录里那几十项会被全算进正文区（实测：它们和正文块
  // 处在同一段纵向范围里）。
  const blocks = []
  for (const { fr, blocks: bs } of seenFrames) {
    const off = offs.get(fr.id)
    // ⚠️ 只在**同一个窗口内**按位置排：跨窗口的 y 根本不可比（一个是局部、一个是页面坐标），
    //    混着排会让"同一块的几层壳"的判断跨窗口乱套。
    const mine = []
    for (const b of bs) {
      // 先**不取整**：取整会让"是不是被窗口边缘裁过"误判
      // （实测：100.8 取整成 101，右边就"多出"0.2px，一个完整的块被当成裁过的，
      //   于是它没能跟同一块的另一份去重，列表里就多出一条）。取整放到裁完之后。
      let rect = off
        ? { left: b.left + off.x, top: b.top + off.y, width: b.width, height: b.height }
        : { left: b.left, top: b.top, width: b.width, height: b.height }
      const local = !off                       // 偏移量读不到 → 只能在窗口内比
      // ★ 裁到**这个窗口自己的框**里。
      //   为什么必须裁（实测）：窗口里的内容可以比窗口本身高得多（滚动内容），
      //   于是"这一块"的矩形会横跨几千像素、把**别的窗口**里的东西全罩住 ——
      //   实测就报出过一块 h=6293 的假"内容区"，里面算进了 21 处（真身只有 3 处）。
      //   屏幕上真正看得见的，只有窗口框里的那截。
      let clipped = false
      if (off && Number.isFinite(off.w) && Number.isFinite(off.h)) {
        const l = Math.max(rect.left, off.x)
        const t = Math.max(rect.top, off.y)
        const r2 = Math.min(rect.left + rect.width, off.x + off.w)
        const b2 = Math.min(rect.top + rect.height, off.y + off.h)
        if (r2 <= l || b2 <= t) continue       // 整块都在窗口外 → 屏幕上根本看不见
        // 0.5px 容忍：亚像素的差不算"被裁过"
        clipped = (l > rect.left + 0.5 || t > rect.top + 0.5
          || r2 < rect.left + rect.width - 0.5 || b2 < rect.top + rect.height - 0.5)
        rect = { left: l, top: t, width: r2 - l, height: b2 - t }
      }
      rect = { left: Math.round(rect.left), top: Math.round(rect.top),
               width: Math.round(rect.width), height: Math.round(rect.height) }
      const inside = []
      areaPts.forEach((p, idx) => {
        if (local) {
          if (p.frameId === fr.id && containsPoint(p.lx, p.ly, rect)) inside.push(idx)
        } else if (p.gx !== null && containsPoint(p.gx, p.gy, rect)) inside.push(idx)
      })
      if (!inside.length) continue             // 里面没有可操作的东西 → 不算"内容区"
      mine.push({
        frame: fr.label, frameId: fr.id, rect, local, clipped,
        areaCount: inside.length,
        ids: inside,                           // 这块装的是哪几处
        key: inside.join(','),
        top: rect.top,
      })
    }
    // 位置靠前的、块更大的先来 —— 去重时留下的就是"外面那层"（= 完整的那一条）
    mine.sort((a, b) => (a.top - b.top) || (b.rect.height - a.rect.height))
    for (const b of mine) blocks.push(b)
  }
  // 同一块常被套着报出来（元素的最近大祖先、子窗口的宿主块、子窗口自己的块…）。
  // 去重分两种，判据都要求"一个整个套住另一个"：
  //   · 同窗口：里面的装的东西是外面的子集 → 只留外面那层的。
  //     （实测：右侧目录那种一长条列表会被套着报出十来层。代价：万一某个"列表外壳"
  //       自己也被算成一块，结构会粗一层，但数出来的东西不会错也不会多。）
  //   · 跨窗口：只有装的是同一批东西、且两块都没被窗口边缘裁过才去重。
  //     （绝不用"子集"—— 正文区套着 6 个条目，用子集会把 6 条全删掉，而"有 6 条"
  //       正是模型要看的。要求"没被裁过"是因为被裁过的块只是屏幕上的一段区域；
  //       实测它就顶掉过真正的条目块，导致"这一页有 6 条"少了一条。）
  const keptBlocks = []
  for (const b of blocks) {
    const dup = keptBlocks.some((o) => {
      if (o.local !== b.local) return false
      if (o.local ? o.frameId !== b.frameId : false) return false
      if (!rectContains(o.rect, b.rect)) return false
      if (o.frameId === b.frameId) return b.ids.every((k) => o.ids.includes(k))
      return !o.clipped && !b.clipped && o.key === b.key
    })
    if (!dup) keptBlocks.push(b)
  }
  const containers = keptBlocks.slice(0, 40).map((b) => ({
    frame: b.frame,
    y: b.local ? null : b.rect.top,            // 页面坐标；量不到偏移就 null（不猜）
    height: b.rect.height,
    areaCount: b.areaCount,
  }))

  // 对外的 marks：只报事实（页面坐标 + 它自己说完成没有）。
  // y 是标记的**顶边**，跟 areas[].y 用同一套换算（主窗口视口坐标）；
  // 量不到偏移就是 null —— 宁可说"没坐标"，也不给一个会点错/配错的数。
  const marks = markRows.map((m) => ({
    aria: m.aria,
    text: m.text,
    y: m.gTop,
    done: m.done,
    frame: m.label,
  }))

  // ★ sig：这一页的"内容签名"（url + 每处的 kind/label/已填内容 + 标记数）。
  //   用途：上层（eye_shot 等）拿它判断"页面跟上次看的时候是不是同一内容"——
  //   没变就不必重新烧一张图。**故意不含坐标**：滚动不改变"这一页有什么"，
  //   滚动后 sig 相同是正常的（要截的图照样能截，只是不必以"内容变了"为理由重截）。
  const sig = hash32(
    [top.url, areas.length, marks.length,
      ...areas.map((a) => [a.kind, a.label, Array.isArray(a.filled) ? a.filled.join('/') : String(a.filled ?? '')].join('|'))]
      .join('||'),
  )

  return {
    url: top.url,
    title: top.title,
    sig,
    areas,
    marks,
    layout: {
      containers,
      marksTotal: marks.length,
      marksDone: marks.filter((m) => m.done === true).length,
      marksUndone: marks.filter((m) => m.done === false).length,
    },
    frames: real.map((f) => ({ id: f.id, url: f.url, label: f.label })),
    truncated: collected.length >= maxAreas,
    note: 'areas 是这一页**所有可操作的地方**，数组顺序就是屏幕上从上到下（先按窗口分组，窗口内从上到下）。'
      + 'kind: pick=挑（options 是选项，filled 是当前选中的标签）/ write=写（filled 是当前文字）/'
      + ' button=能点的 / media=播放器。'
      + '★ done 只有三种值：true=我看到标记了、它说已完成；false=我看到标记了、它说未完成；'
      + '**null=我没看到标记**（这不是"没完成"）。标记在别的窗口里时，看元素自己的祖先链是看不到的，'
      + '所以 done 一律按页面坐标跟"它上方最近的标记"配对得出。'
      + '★ marks 是页面上读到的完成标记（y 是页面坐标的顶边，和 areas 的 x/y 同一套；'
      + 'done 是它自己说的状态）；layout.containers 是"哪儿是一大块、里面有几处可操作"，'
      + '只报形状、不解释那是什么。'
      + '⚠️ i 的**数字大小不代表位置**（它是稳定编号，不是序号）—— 要按位置就用数组顺序。'
      + '⚠️ label 和 options[].text 是 DOM 里读到的**原文**，可能被字体搅过（看着像乱码）——'
      + ' 那种情况下以截图为准。'
      + '⚠️ 编号只在**最近一次"看"**里有效：再调一次这个工具、或者用另一只眼（列所有可点元素）'
      + ' 看了一次，旧编号就作废了，会如实报"找不到"。翻页同理。',
  }
}

/**
 * 整卷版式：把这一页的题目按屏幕顺序编成 1..N，并算出题目区的裁剪矩形。
 *
 * 为什么要它：`eye_see` 只说"有几处"，题目得一屏一屏截图才看得全
 * （真机实测 5 题滚 6 次、截 4 张）。而做题的是子 Agent，它**不会滚动** ——
 * 不给一张整卷图，它根本答不全。题干仍然只给图：DOM 文字可能被字体搅过。
 *
 * 返回的 `n` 是整卷题号（喂给 α 的答案格式用它），`i` 是落盘时 hand_pick 要的编号。
 */
export async function readPaper(page, { full = false, maxHeight = 2400, padding = 10 } = {}) {
  // full 必须与 eye_check 用的一致（都是 false）：清单序号 n 是拿 areas 顺序数的，
  // 两边的截断额度不一样（40/80 vs 120/200）就会算出两套 n —— 复核员登记的键
  // 和闸门读的键对不上，票据永远发不出来。
  const r = await readAreas(page, { full })
  const picked = (r.areas ?? []).filter((a) => a.kind === 'pick' || a.kind === 'write')

  // 元素坐标是**视口坐标**（readAreas 里已经换过），CDP 的 clip 要**页面坐标**。
  // frameRects 的第 0 条是主窗口自己，它的 x/y 恰好等于当前滚动量。
  const rects = await (page.frameRects ? page.frameRects().catch(() => []) : Promise.resolve([]))
  const main = Array.isArray(rects) ? rects[0] : null
  const scroll = { x: Number(main?.x) || 0, y: Number(main?.y) || 0 }

  const items = picked.map((a, k) => {
    const w = Number(a.w) || 0
    const h = Number(a.h) || 0
    const left = (Number(a.x) || 0) - w / 2 + scroll.x
    const top = (Number(a.y) || 0) - h / 2 + scroll.y
    return {
      n: k + 1,
      kind: a.kind,
      i: a.i,
      options: (a.options ?? []).map((o) => ({ i: o.i, label: o.label, text: o.text })),
      filled: a.filled ?? [],
      frame: a.frame ?? null,
      rect: w > 0 && h > 0 ? { x: Math.round(left), y: Math.round(top), width: Math.round(w), height: Math.round(h) } : null,
    }
  })

  const sized = items.filter((x) => x.rect)
  if (!sized.length) {
    return {
      total: items.length, items, clip: null, segments: [],
      note: '量不到题目区的页面坐标（窗口几何没读到）—— 只能逐处 eye_shot({ i }) 让子 Agent 看。',
    }
  }

  const clip = {
    x: Math.max(0, Math.round(Math.min(...sized.map((x) => x.rect.x)) - padding)),
    y: Math.max(0, Math.round(Math.min(...sized.map((x) => x.rect.y)) - padding)),
    width: 0,
    height: 0,
  }
  clip.width = Math.round(Math.max(...sized.map((x) => x.rect.x + x.rect.width)) + padding) - clip.x
  clip.height = Math.round(Math.max(...sized.map((x) => x.rect.y + x.rect.height)) + padding) - clip.y

  // 太高就切段：一张两米长的图模型只会说"preview is cropped"，截了等于没截。
  const segments = []
  if (clip.height <= maxHeight) {
    segments.push({ n: 1, clip: { ...clip }, covers: items.map((x) => x.n) })
  } else {
    let k = 1
    for (let y = clip.y; y < clip.y + clip.height; y += maxHeight) {
      const h = Math.min(maxHeight, clip.y + clip.height - y)
      segments.push({
        n: k++,
        clip: { x: clip.x, y, width: clip.width, height: h },
        covers: items.filter((x) => x.rect && x.rect.y + x.rect.height > y && x.rect.y < y + h).map((x) => x.n),
      })
    }
  }

  return {
    total: items.length,
    items,
    clip,
    segments,
    // 给上层算「登记键」用（ledger 的 n / write 的 w）；eye_paper 返回前会删掉，
    // 免得把整页几十处可操作元素塞进模型上下文。
    areas: r.areas ?? [],
    note: '题干**不在文字里** —— DOM 可能被字体搅过，看 segments 的图。'
      + 'n 是整卷题号（人看的）；key 是**登记用的键**（等于 eye_check 清单里的 n / w）；'
      + 'i 是落盘时 hand_pick / hand_write 要的编号。'
      + '数组顺序就是屏幕上从上到下。',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// readInteractive —— 所有能点能填的东西，一个编号一个
// ═══════════════════════════════════════════════════════════════════════════
//
// 与 readAreas 的分工：readAreas 回答"有几处**要处理**的地方"；本函数回答"**一切**
// 能点能填的东西在哪"，是兜底的那只眼 —— 遇到 readAreas 认不出的界面（奇怪的前端组件、
// 图标按钮、画布）就退回这一层，点一个看变化。即宪法 ③「大脑永远有退路」。
export async function readInteractive(page, { limit = 70, frame: onlyFrame = null } = {}) {
  const token = 'h' + Math.random().toString(36).slice(2, 8)
  const frames = await labeledFrames(page)

  // 内容窗口优先：导航壳（目录、侧栏）常常独占几百个可点元素，
  // 不排前面的话额度会被它吃光，真正要点的东西一条都列不出来。
  // 判据只用"是不是主窗口 / 链接指不指向一个页面"这种中性事实。
  const score = (f) => (f.isMain ? 10 : /\.(html?|php|aspx)($|[?#])/i.test(f.url) ? 50 : 30)
  const ordered = frames.filter(isRealFrame).sort((a, b) => score(b) - score(a))

  // 每个窗口一份额度，防止单个窗口把限额吃光
  const perFrame = Math.max(10, Math.min(30, Math.ceil(limit / Math.max(1, Math.min(ordered.length, 3)))))
  const elements = []

  // 所有窗口统一清一遍旧标记（理由见 clearMarkers）：
  // 只清"自己走到的窗口"是不够的 —— 没走到的窗口里那些旧编号照样能点到东西。
  for (const fr of ordered) await clearMarkers(page, fr)

  // ★ 窗口偏移**整次调用只测一次**（与 readAreas 同一规矩）。
  //   实测教训（改进）：早先写在下面的元素循环里，每个元素都重新 measureFrameRects 一遍
  //   —— 一页 5 个子窗口时每次测量约 24 次 CDP 往返，70 个元素就是约 1700 次串行往返，
  //   eye_list 从亚秒劣化到数秒。偏移在一次"看"里不会变，没有每元素重测的理由。
  const offs = await frameOffsets(page)

  // ★ 指定了窗口名却**一个都没对上**是"沉默的错误"，必须说出来（本文件开头的坑 1 就是讲它）。
  //   实测（2026-10-15）：模型从 frameUrl 抄来的名字比 label 多一段路径 → 匹配全落空 →
  //   返回 count:0，模型读成"这一页没有可点的东西"，白白绕了好几步才发现是名字写错了。
  //   同项目的 hand.mjs（scrollPage 里 frameByName 找不到时）已经这么报了，这里对齐。
  let frameMatched = false
  for (const fr of ordered) {
    if (onlyFrame) {
      if (fr.label !== onlyFrame && !String(fr.url).includes(String(onlyFrame))) continue
      frameMatched = true
    }
    if (elements.length >= limit) break

    const take = Math.min(perFrame, limit - elements.length)
    const base = elements.length
    // 采集 + 编号**一趟做完**：页面里的选择规则和排序只有一份，
    // 不会出现"报出来几个、标上的又是另外几个"。
    //
    // ⚠️ 每一对 [元素, 数据] 是**绑在一起**排序的。早先写成两个平行数组，
    //    排序时只动了一个 —— 于是编号和元素错位，点"提交"点到了别的按钮上。
    const found = await page.evalInFrame(fr.id, `(() => {
      ${BROWSER_HELPERS}
      const base = ${base};
      const sel = 'a, button, input, textarea, select, [onclick], [role=button], [role=link], [class*="btn"], [class*="Btn"]';
      const pairs = [];
      for (const e of document.querySelectorAll(sel)) {
        if (!__shown(e)) continue;
        const t = __txt(e);
        const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
        if (!t && !isField && !e.getAttribute('onclick') && !e.getAttribute('href')) continue;
        const r = __rect(e);
        pairs.push([e, {
          tag: e.tagName, text: __short(t, 80),
          href: (e.getAttribute('href') || '').slice(0, 100) || null,
          onclick: (e.getAttribute('onclick') || '').slice(0, 90) || null,
          type: e.getAttribute('type') || null,
          value: isField ? __short(e.value || '', 40) : null,
          x: r.x, y: r.y,
        }, r.top]);
      }
      pairs.sort((a, b) => a[2] - b[2]);
      const take = pairs.slice(0, ${take});
      take.forEach((p, k) => p[0].setAttribute('data-dsh-h', ${JSON.stringify(token + ':')} + (base + k)));
      return take.map((p) => p[1]);
    })()`).catch(() => null)

    if (!found || !found.length) continue
    for (let k = 0; k < found.length; k++) {
      elements.push({
        i: `${token}:${base + k}`,
        frame: fr.label,
        frameUrl: String(fr.url).slice(0, 100),
        ...found[k],
        // ★ 同 readAreas：子窗口的局部坐标换算成主窗口视口坐标，量不到就 null
        ...toViewport(offs.get(fr.id), found[k].x, found[k].y),
      })
    }
  }

  const byFrame = {}
  for (const e of elements) byFrame[e.frame] = (byFrame[e.frame] ?? 0) + 1

  // 名字没匹配上 ≠ 这一页没东西可点 —— 把实际存在的窗口名报出来，模型能自己改名重试
  const missNotes = onlyFrame && !frameMatched
    ? [`没有窗口叫「${String(onlyFrame).slice(0, 60)}」（也不在它的地址里），所以这一趟一个都没看。`
        + `现在这些窗口是：${ordered.map((f) => f.label).join(' / ') || '（一个都没有）'}。`
        + `名字要从 eye_see / eye_list 返回的 frame 里**原样复制**；拿不准就把 frame 参数去掉看全部。`]
    : []

  return {
    count: elements.length,
    truncated: elements.length >= limit,
    byFrame,
    elements,
    ...(missNotes.length ? { frameMissed: true, notes: missNotes } : {}),
    note: '这是**这一页所有可点的东西**（含子窗口里的）。i 是编号，用点击工具点它。'
      + '看不见文字的图标按钮请结合截图判断。'
      + '⚠️ 编号只在**最近一次"看"**里有效：再调一次这个工具、或者用另一只眼（列要处理的地方）'
      + ' 看了一次，旧编号就作废了，会如实报"找不到"。翻页同理。',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 页面三件事：在哪 / 登录没有 / 有没有拦路的
// ═══════════════════════════════════════════════════════════════════════════

/** 在哪 —— 只报地址、标题、有哪些窗口。不做任何"这是什么页面"的判断 */
export async function pageSummary(page) {
  const [url, title, frames] = await Promise.all([
    page.eval('location.href').catch(() => null),
    page.eval('document.title').catch(() => null),
    labeledFrames(page),
  ])
  return {
    url,
    title,
    frames: frames.filter(isRealFrame).map((f) => ({ id: f.id, url: f.url, label: f.label })),
  }
}

/**
 * 登录没有 —— 通用判据：**不认域名、不认路径**。
 *
 * 为什么（实测教训）：旧实现认"域名等于某站点"或"页面文字里有某几个词"，结果学习页在
 * 另一个子域名 + 另一个路径上，两个条件都不满足 → 被判"没登录" → 整条流程在门口返回。
 * 用户看到的是"题目都刷出来了你也不做"。现在只认屏幕上的东西：有没有密码输入框、
 * 有没有登录表单 —— 任何网站的登录界面都得有这两样。
 *
 * ⚠️ 防误报：很多页面右上角/页脚都写着"登录"（其实是"退出登录"或"手机版登录"），
 *   所以光有文字不算，必须有密码框 / 登录表单，或"文字线索 + 至少一个账号输入框"。
 */
export async function loginState(page) {
  // ★ 必须扫**所有**窗口（修 P0-2）：登录框 / 扫码组件常被放进跨域 iframe，只扫主文档
  //   会漏判"这一步需要人"，主脑随后在未登录的页面上白跑半天。任一窗口命中即"需要人"，
  //   并在 detail 里说清是哪个窗口。判据不变（密码框 / 登录表单 / 文字线索 + 账号框）。
  const EXPR = `(() => {
    const shown = (e) => {
      if (!e) return false;
      const s = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0
        && b.width > 2 && b.height > 2;
    };
    const body = document.body ? document.body.innerText : '';
    const txt = body.replace(/\\s+/g, ' ').slice(0, 4000);
    const pwd = [...document.querySelectorAll('input[type=password]')].filter(shown).length;
    let loginForm = false;
    for (const f of document.querySelectorAll('form')) {
      if (!shown(f)) continue;
      const hasPwd = [...f.querySelectorAll('input[type=password]')].some(shown);
      const hasUser = [...f.querySelectorAll('input[type=text], input[type=tel], input[type=email], input[name]')].some(shown);
      if (hasPwd || (hasUser && /登\\s*录|登\\s*陆|sign\\s*in|log\\s*in/i.test(f.innerText || ''))) { loginForm = true; break }
    }
    const userBox = [...document.querySelectorAll('input[type=text], input[type=tel], input[type=email], input[name*=user], input[name*=account], input[name*=phone]')].filter(shown).length;
    const kw = /登\\s*录|登\\s*陆|密\\s*码|账\\s*号|验\\s*证\\s*码|扫\\s*码|sign\\s*in|log\\s*in/i.test(txt);
    return {
      onLoginPage: pwd > 0 || loginForm || (kw && userBox > 0),
      hasPasswordBox: pwd > 0, hasLoginForm: loginForm,
      hasUserBox: userBox > 0, byText: kw,
      title: document.title,
    };
  })()`

  const frames = (await page.frames().catch(() => [])) ?? []
  const real = frames.filter((f) => f.url && !/^about:/.test(f.url))
  const targets = real.length ? real : [null]

  let hit = null    // 第一个说"这是登录页"的窗口
  let any = null    // 一份"没命中"的详情（兜底）
  for (const f of targets) {
    const r = f
      ? await page.evalInFrame(f.id, EXPR).catch(() => null)
      : await page.eval(EXPR).catch(() => null)
    if (!r || r.error) continue
    const row = { ...r, frameUrl: String(f?.url ?? '').slice(0, 120) }
    if (r.onLoginPage === true) { hit = row; break }
    if (!any) any = row
  }
  const r = hit ?? any ?? { error: 'no-readable-frame' }

  const onLoginPage = r.onLoginPage === true
  return {
    onLoginPage,
    // needsUser = "这一步必须人来做"：登录页要人扫码/输密码，工具不代劳
    needsUser: onLoginPage,
    hint: onLoginPage
      ? '屏幕上出现了密码框或登录表单 —— 这一步要人来（扫码 / 输账号密码 / 过验证码）。登录完了再继续。'
      : '屏幕上没有密码框、也没有登录表单 —— 按屏幕事实看，不需要登录。',
    detail: {
      hasPasswordBox: r.hasPasswordBox === true,
      hasLoginForm: r.hasLoginForm === true,
      hasUserBox: r.hasUserBox === true,
      byText: r.byText === true,
      title: r.title ?? null,
      error: r.error ?? null,
      where: r.frameUrl ?? null,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 播放器状态
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 读播放器状态 → `{ playing, kind, at, duration, … }`；没有播放器返回 null。
 *
 * ⚠️ 视频和音频走**同一套**逻辑，不按 URL 猜哪个窗口是播放器：实测音频练习用的是标准
 *    <audio>（根本没有播放器库），只认视频模块的写法会把整个音频练习当成"什么都没有"跳过。
 * ⚠️ currentTime / duration 是**播放器自己报的数**，是"现在播到哪了"的事实，
 *    **不是**"学完了"的证据 —— 那种判断属于大模型和页面自己的记账。
 * ⚠️ 全部读取在 DOM 层面完成，**不碰页面全局变量**：碰了就得等主世界上下文
 *    （每窗最多 1.5 秒），一页挂十几个窗口时能把一次调用拖成几十秒。
 */
export async function readMediaState(page) {
  const frames = (await page.frames().catch(() => [])) ?? []
  for (const f of frames) {
    if (!f.url || /^about:/.test(f.url)) continue
    const v = await page.evalInFrame(f.id, `(() => {
      const el = document.querySelector('video') || document.querySelector('audio');
      if (!el) return null;
      const d = Number.isFinite(el.duration) && el.duration > 0 ? +el.duration.toFixed(1) : null;
      return {
        kind: el.tagName === 'AUDIO' ? 'audio' : 'video',
        playing: el.paused === false && el.ended === false,
        at: Number.isFinite(el.currentTime) ? +el.currentTime.toFixed(1) : null,
        duration: d,
        paused: el.paused === true,
        ended: el.ended === true,
        readyState: el.readyState ?? null,
        // 速率是**事实**：后台播放时页面自己可能改过它，工具只报告，不修改
        playbackRate: Number.isFinite(el.playbackRate) ? el.playbackRate : null,
        muted: el.muted === true,
        hasSrc: !!(el.currentSrc || el.src),
      };
    })()`).catch(() => null)
    if (v) return v
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// 在页面上找"可见 / 可点"的元素
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 按定位器找元素。{ i } 编号 / { text, exact, frame } 可见文字 / { x, y } 坐标（原样透传）。
 *
 * 找不到 → `{ found:false, reason }`，**不抛异常** —— "找不到"是必须如实报告的正常结果，
 * 抛异常会让上层以为工具坏了。
 *
 * ⚠️ 编号查找**必须在所有窗口里搜**：编号与 frame 顺序无关，这是点击能点准的唯一保证。
 */
export async function findElementByLocator(page, loc = {}) {
  if (!loc || typeof loc !== 'object') {
    return { found: false, reason: 'BAD_LOCATOR', hint: '定位器要写成对象：{"i":…} 或 {"text":…} 或 {"x":…,"y":…}' }
  }

  // ── 坐标：没有"找"的过程，直接说有 ────────────────────────────────────
  if (Number.isFinite(loc.x) && Number.isFinite(loc.y)) {
    return {
      found: true, by: 'point', i: null, frame: null, text: null,
      visible: true, x: Math.round(loc.x), y: Math.round(loc.y),
    }
  }

  const frames = await labeledFrames(page)

  // ── 编号 ───────────────────────────────────────────────────────────────
  if (loc.i !== undefined && loc.i !== null && loc.i !== '') {
    const key = String(loc.i)
    for (const fr of frames) {
      if (!isRealFrame(fr)) continue
      const hit = await page.evalInFrame(fr.id, `(() => {
        ${BROWSER_HELPERS}
        // 用属性遍历而不是拼选择器：编号里可能带 : 和引号，
        // 拼进 CSS 选择器就得处理转义，早晚会在某个编号上炸掉。
        const want = ${JSON.stringify(key)};
        let e = null;
        for (const el of document.querySelectorAll('[data-dsh-h]')) {
          if (el.getAttribute('data-dsh-h') === want) { e = el; break }
        }
        if (!e) return null;
        const r = __rect(e);
        return {
          tag: e.tagName, text: __short(__txt(e) || e.value || '', 80),
          visible: __shown(e), x: r.x, y: r.y,
          disabled: e.disabled === true || e.getAttribute('aria-disabled') === 'true',
          href: e.getAttribute('href') || null,
        };
      })()`).catch(() => null)
      if (hit) return { found: true, by: 'i', i: key, frame: fr.label, frameUrl: fr.url, frameId: fr.id, ...hit }
    }
    return {
      found: false,
      reason: 'ELEMENT_NOT_FOUND',
      i: key,
      hint: '这个编号已经失效了（页面变了、翻过页，或者编号是上一次看的时候给的）。'
        + '重新看一次，拿新的编号。',
    }
  }

  // ── 文字 ───────────────────────────────────────────────────────────────
  if (loc.text !== undefined && loc.text !== null && String(loc.text).trim()) {
    const want = String(loc.text).trim()
    const exact = loc.exact === true
    const only = loc.frame ? String(loc.frame) : null
    for (const fr of frames) {
      if (!isRealFrame(fr)) continue
      if (only && fr.label !== only && !String(fr.url).includes(only)) continue
      const hit = await page.evalInFrame(fr.id, `(() => {
        ${BROWSER_HELPERS}
        const want = ${JSON.stringify(want)};
        const exact = ${exact ? 'true' : 'false'};
        const sel = 'a, button, input, textarea, select, [onclick], [role=button], [role=link], label, li, span, div, td, p';
        const cands = [];
        for (const e of document.querySelectorAll(sel)) {
          // 只看"自己就是那个东西"的叶子：文本包含关系会让父容器也匹配上，
          // 点在父容器上会偏到旁边去 —— 实测"点错地方"多半是这个原因。
          if (e.querySelector(sel)) continue;
          if (!__shown(e)) continue;
          const t = __txt(e);
          if (!t) continue;
          // 长度上限：防止把"一大块里恰好有这两个字"的容器当成目标
          if ((exact ? t === want : t.includes(want)) && t.length <= want.length * 3 + 12) {
            cands.push({ e, t, len: t.length, hot: e.matches('a,button,input,label,li,[onclick],[role=button],[role=link]') ? 1 : 0 });
          }
        }
        if (!cands.length) return null;
        // 可点击的优先，再按"最短的 = 最贴近的"
        cands.sort((a, b) => (b.hot - a.hot) || (a.len - b.len));
        const best = cands[0];
        const r = __rect(best.e);
        return {
          tag: best.e.tagName, text: __short(best.t, 80), visible: true,
          x: r.x, y: r.y, matches: cands.length,
          href: best.e.getAttribute('href') || null,
        };
      })()`).catch(() => null)
      if (hit) return { found: true, by: 'text', i: null, frame: fr.label, frameUrl: fr.url, ...hit }
    }
    return {
      found: false,
      reason: 'TEXT_NOT_FOUND',
      hint: `屏幕上没有看得见的文字「${want}」`
        + (only ? `（只在窗口「${only}」里找过）` : '（每个窗口都找过了）')
        + '。可能是文字被字体搅过、或者它在滚动区域外、或者那是个图标按钮 —— 截张图看看。',
    }
  }

  return { found: false, reason: 'BAD_LOCATOR', hint: '定位器里没有 i / text / x,y 任何一个。' }
}

/**
 * 按「区编号」量**整组**的矩形（pick 专用）。
 *
 * 为什么需要：pick 的区自己身上没有 data-dsh-h，记号全挂在各选项上（编号是
 * `<区编号>o<k>`）。而模型要"给这道题截个特写"时手里最自然的编号正是**区编号**
 * （一处 = 一道题，且选项文字小、整页图里糊成一片）—— 只认精确编号会直接
 * ELEMENT_NOT_FOUND。做法：找该窗口里所有 `<区编号>o<数字>` 的元素，取占地并集。
 *
 * ⚠️ 前缀匹配安全：区编号形如 `token:base+g` 全局唯一，选项编号固定以 `o<数字>` 结尾，
 *    `r1:2` 不会误配 `r1:20o0`。
 */
export async function findGroupRectByLocator(page, groupId) {
  const key = String(groupId ?? '')
  if (!key) return { found: false, reason: 'BAD_LOCATOR', hint: '区编号是空的' }

  const frames = await labeledFrames(page)
  for (const fr of frames) {
    if (!isRealFrame(fr)) continue
    const hit = await page.evalInFrame(fr.id, `(() => {
      const pre = ${JSON.stringify(key)} + 'o';
      const els = [];
      for (const el of document.querySelectorAll('[data-dsh-h]')) {
        const v = el.getAttribute('data-dsh-h') || '';
        // 选项编号 = <区编号>o<数字>：剥掉 "<区编号>o" 之后剩下的必须是纯数字
        if (v.startsWith(pre) && /^\\d+$/.test(v.slice(pre.length))) els.push(el);
      }
      if (!els.length) return null;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;   // 折叠/隐藏的选项不算
        x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
        x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom); n++;
      }
      if (!n) return null;
      return {
        x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2),
        top: Math.round(y1), left: Math.round(x1),
        w: Math.round(x2 - x1), h: Math.round(y2 - y1), count: n,
      };
    })()`).catch(() => null)
    if (hit) {
      return {
        found: true, by: 'group', i: key,
        frame: fr.label, frameUrl: fr.url, frameId: fr.id,
        visible: true, options: hit.count,
        ...hit,
      }
    }
  }
  return {
    found: false, reason: 'ELEMENT_NOT_FOUND', i: key,
    hint: '这个编号在本页找不到（既没有身带此编号的元素，也没有以它为区编号的选项组）。'
      + '可能是页面变了、翻过页，或编号是上一次看的时候给的 —— 重新 eye_see 拿新编号。',
  }
}
