/**
 * hand.mjs —— 「手」：只做一个明确动作，然后如实报告页面发生了什么变化
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条宪法（写这个文件时也适用）
 *
 *   ① 工具只认识屏幕，不认识任何网站
 *      —— 本文件里没有"这是第几题 / 什么类型 / 哪门课 / 第几节 / 哪个平台"这类概念，
 *         连这几个中文词本身都不出现（只认识"屏幕上那个编号"）。
 *         页面上有什么，就点什么；属于哪个"区"，是**眼睛给的编号**说了算。
 *   ② 格式错在动手之前拦住，且零副作用
 *      —— pickOptions 先把每一项**校验**一遍（在页面上真的存在、真的属于这个区），
 *         全部通过才开始动手；校验不过的进 rejected，一个像素都不碰。
 *   ③ 大脑永远有退路：截图 → 列能点的 → 点一个看变化
 *      —— 所以每个函数的返回都带"实际点了什么、页面变成了什么"，
 *         而不是"我应该点上了"。returnByValue 里的每个字段都是**回读**来的事实。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这个文件**不 import 任何东西**
 *
 *   手是全站最后一段能碰到用户页面的代码。上游（眼睛、浏览器桥）在并行重构，
 *   换名字、换导出、整个删掉都发生过 —— act.mjs 就是因为 import ./observe.mjs，
 *   而 observe.mjs 被删掉，直接装不上了。手只依赖 page 句柄本身（browser.mjs
 *   给的那个 work 对象：eval / evalInFrame / frames / clickAt / goto / send），
 *   别的什么都不依赖。这样别人的文件怎么改，手都不会跟着挂。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 值钱的实测经验（别丢，都是真机上踩出来的）
 *
 *   ★ 主窗口用真鼠标、子窗口用 element.click()
 *     Input.dispatchMouseEvent 收的是**页面坐标**（主文档视口坐标），
 *     而 getBoundingClientRect 在子窗口里给的是**该窗口自己的局部坐标** ——
 *     两者差着整个 iframe 的偏移。子窗口里的元素用真鼠标点，会点到旁边去
 *     （"点了没反应"十次有八次是这个）。所以：
 *       主窗口 → 真鼠标（走浏览器输入管线，能激活需要用户手势的行为）
 *       子窗口 → 在它自己的窗口里 element.click()
 *     （browser.mjs 现在有了 frameRects()，坐标能换算了；这一版仍然沿用上面这条
 *       更保守的规则，因为"点得对"比"点得像真人"重要。）
 *
 *   ★ 行内 onclick 必须在**主世界**跑
 *     站点自己的处理器（onclick="addMultipleChoice(this)"）引用的是页面全局函数。
 *     隔离世界里没有这些名字 → new Function 必然 ReferenceError。
 *     所以补 onclick 这一步单独用 { isolated: false } 跑（见 runOnclick）。
 *
 *   ★ 选中判定绝不能用 className.includes('check')
 *     老代码用 /cur|check|selected|active/ 匹配类名，而选项的基础类名就叫
 *     before-after-checkbox —— 含 "check"，于是每个选项都被当成"已选中"，
 *     一个都点不动。现在按**成词**匹配（token 相等），并且优先信 aria-checked /
 *     input.checked / option.selected。
 *
 *   ★ 不写死任何属性名
 *     眼睛把编号挂在元素身上（data-dsh-h / data-dsh-r / data-dsh-o … 叫什么都能认）。
 *     我们扫描时顺手把元素身上的 data-dsh-* 值全记下来，事后按**值**找回来 ——
 *     这样眼睛那边怎么命名都行，不用两边对表。
 */

// ── 0. 小工具 ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const isMainFrameWord = (s) => /^(主页面|主窗口|主文档|main|top|_top)$/i.test(String(s || '').trim())

/** 一句话截断（返回给模型看的文字都要短，别塞几百字进去） */
function clip(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 去空白，用来比较"写进去的"和"读回来的" */
const squash = (s) => String(s ?? '').replace(/\s+/g, '').trim()

/**
 * 标签归一化 —— 和 gate.mjs 的 normLabel **同规则**。
 * 两边必须一致：这边把 "B." 认成 "B"，那边复核员写 "b"，才对得上账。
 * （故意复制一份而不是 import —— 见文件头的"不 import 任何东西"。）
 */
function normLabel(s) {
  if (s === null || s === undefined) return ''
  let t = String(s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/^[.、．)）:：,\-]+/, '')
    .replace(/[.、．)）:：,\-]+$/, '')
    .trim()
  if (/^[a-z]$/.test(t)) t = t.toUpperCase()
  return t
}

/** 抛错统一带 code，index.js 好分类（ARG = 调用格式错，动手之前拦住） */
function fail(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}
const argErr = (msg, extra) => fail('ARG', msg, { category: 'ARG', ...(extra || {}) })

/** 页面上取当前地址（拿不到就是 null，绝不抛） */
async function href(page) {
  return page.eval('location.href').catch(() => null)
}
async function title(page) {
  return page.eval('document.title').catch(() => null)
}
async function safeFrames(page) {
  const fs = await page.frames().catch(() => [])
  return Array.isArray(fs) ? fs : []
}

// ── 1. 页面结构扫描（只读，不改状态）─────────────────────────────────────────
//
// 一次扫描拿到这一页所有"区域"：可挑区 / 可写区 / 按钮 / 媒体，按屏幕上从上到下。
// 这是**手**需要的全部上下文：
//   · 眼睛给的编号（area / option）→ 靠元素身上的 data-dsh-* 值对回来
//   · 每个选项现在是"选中/没选中" → 动手前后各读一次
//   · 每个选项的 label（A/B/对/1…）→ 回读时如实报出去
//
// 为什么把手也要扫一遍（而不是只认眼睛给的编号）：
//   眼睛报的是"我看到了什么"，手要的是"我现在能不能碰它"。两者之间用户可能
//   切过页面、滚动过、列表刷新过 —— 编号会失效。手必须能自己确认元素还在。

/** 「现在选中了吗」—— 三段式：原生属性 > aria > 成词类名 */
const IS_SEL_SNIPPET = String.raw`
  const isSel = (e) => {
    if (!e) return false;
    if (e.tagName === 'INPUT') return !!e.checked;
    if (e.tagName === 'OPTION') return !!e.selected;
    if (e.getAttribute('aria-checked') === 'true') return true;
    if (e.getAttribute('aria-selected') === 'true') return true;
    if (e.getAttribute('data-checked') === 'true') return true;
    const toks = String(e.className || '').replace(/[_-]+/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of ['cur', 'active', 'checked', 'selected', 'on']) if (toks.indexOf(t) >= 0) return true;
    const inner = e.querySelector ? e.querySelector('input[type=radio],input[type=checkbox]') : null;
    if (inner && inner.checked) return true;
    return false;
  };
`

const SCAN_TMPL = String.raw`(() => {
  const FIDX = __FIDX__;
  const CAP = 140;        // 一页一帧最多收 140 个区域，防某些页面几万个节点把返回撑爆
  const MAXOPT = 40;      // 一个可挑区最多报 40 个选项（正常题目远小于这个数）

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left),
             x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) };
  };
  const shown = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    let s; try { s = getComputedStyle(el) } catch (err) { return false }
    if (!s || s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const txt = (el, n) => String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, n || 120);
  const SHORT = /^([A-Za-z]|对|错|是|否|正确|错误|√|×|✓|✗)$/;
  const toNum = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  __IS_SEL__

  // 眼睛给的编号：元素身上挂着的 data-dsh-* 值（我们自己的 data-dsh-hand 除外）。
  // 顺手把祖先（最多 5 层）和直接子元素的也收进来 —— 编号可能标在 label / 容器 /
  // 内层 span 上。眼睛标的"区"那个容器，有时候比选项高好几层，所以留宽一点。
  const eidsOf = (el) => {
    const out = [];
    const grab = (e) => {
      if (!e || !e.attributes) return;
      for (const at of e.attributes) {
        if (at.name.length > 9 && at.name.slice(0, 9) === 'data-dsh-' && at.name !== 'data-dsh-hand') out.push(String(at.value));
      }
    };
    let cur = el, n = 0;
    while (cur && n < 6) {
      grab(cur);
      if (n === 0 && cur.children) for (const c of cur.children) grab(c);
      // ⚠️ 只在**祖先**上遇到我们自己的记号才停（那是上一个区域的边界）。
      //    第 0 层不能停：我们自己刚给选项元素打了记号（mark(o.clickEl, …)），
      //    一上来就 break 的话，眼睛挂在**父元素**上的编号（label / 容器上）就永远收不到。
      //    实测就是这么错的：眼睛把编号标在 label 上，我们停在 input 这一层，
      //    于是"通过选项编号反推区编号"整条路都断了，认区退化成 only/labels。
      if (n > 0 && cur.hasAttribute && cur.hasAttribute('data-dsh-hand')) break;
      cur = cur.parentElement; n++;
    }
    return [...new Set(out)];
  };

  // 只给**容器**打一次记号：同一个容器可能同时是 radio 组和 checkbox 组的家，
  // 打两次记号会互相覆盖，后面回读就找不到它了。选项是各打各的，不受影响。
  const markedOnce = new Map();
  const markOnce = (el, m) => {
    if (markedOnce.has(el)) return markedOnce.get(el);
    markedOnce.set(el, m);
    try { el.setAttribute('data-dsh-hand', m) } catch (err) {}
    return m;
  };
  const mark = (el, m) => { try { el.setAttribute('data-dsh-hand', m) } catch (err) {} return m };

  // 选项标签怎么取（顺序照契约）：
  //   ① 后代里带短值的 data 属性（<span data="A">，老题库的常见写法）
  //   ② 一个 1–2 字的短文本子元素
  //   ③ 它自己整段就是短标签（"A" / "对"）
  //   ④ 开头是 "A." / "A、" / "A）"
  //   ⑤ 都不行 → 用 1-based 序号
  // ③ 是补的：契约只说"短文本子元素"，但整段就是 "A" 的选项没有子元素，
  //    落到 ⑤ 会变成 "1" —— 而复核员在图上看见的是 "A"，两边就对不上账了。
  const labelOf = (el, text, idx) => {
    const ds = el.querySelectorAll('[data],[data-value],[data-letter],[data-option]');
    for (const s of ds) {
      const v = String(s.getAttribute('data') || s.getAttribute('data-value') || s.getAttribute('data-letter') || s.getAttribute('data-option') || '').trim();
      if (SHORT.test(v)) return v;
    }
    for (const k of el.querySelectorAll('span,i,b,em,strong,label,div,a')) {
      const t = txt(k, 4);
      if (t.length <= 2 && SHORT.test(t)) return t;
    }
    if (text.length <= 2 && SHORT.test(text)) return text;
    const m = text.match(/^([A-Za-z])[\s.、．)）:：]/);
    if (m) return m[1].toUpperCase();
    return String(idx + 1);
  };

  // 先清掉**自己上一轮**留下的记号（只清 f 开头的），否则上一轮的元素可能已经被
  // 换成另一批，旧记号会把后面的 querySelector 引到一个早就不该碰的节点上。
  // 眼睛标的 data-dsh-h / data-dsh-r 之类一个都不碰。
  for (const e of document.querySelectorAll('[data-dsh-hand]')) {
    if (/^f\d+a/.test(String(e.getAttribute('data-dsh-hand') || ''))) e.removeAttribute('data-dsh-hand');
  }

  const areas = [];
  const used = new Set();
  let seq = 0;
  const M = (k) => 'f' + FIDX + 'a' + k;
  const push = (a) => { if (areas.length < CAP && a) areas.push(a) };
  const commonAncestor = (els) => {
    let a = els[0];
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a || document.body;
  };
  const byPos = (list) => list.slice().sort((a, b) => (a.__r.top - b.__r.top) || (a.__r.left - b.__r.left));

  // ── ① 原生 radio / checkbox ───────────────────────────────────────────────
  // radio 按 name 分组（一道题一个 name）；没 name 的、以及 checkbox，按
  // "最近的、装了 >=2 个勾选框的祖先"分组 —— 也就是题目容器。
  const boxSeq = new Map();
  const boxId = (el) => { if (!boxSeq.has(el)) boxSeq.set(el, boxSeq.size + 1); return boxSeq.get(el) };
  const native = new Map();
  for (const inp of document.querySelectorAll('input[type=radio],input[type=checkbox]')) {
    // ⚠️ 灰的（disabled）也要收进来！它是屏幕上真实存在的一个选项 ——
    //    眼睛会报它、复核员在图上会数它。这里跳过它，选项编号就会**整体错位**
    //    （一个灰选项插在中间，后面每个 o 号都往前挪一位 → 点错答案）。
    //    正确的做法是：照样编号，等真去挑它的时候再拒绝（"这个是灰的，点不动"）。
    let key, cont = null;
    if (inp.type === 'radio' && inp.name) key = 'n:' + inp.name;
    else {
      let p = inp.parentElement, best = null;
      while (p && p !== document.body && p !== document.documentElement) {
        if (p.querySelectorAll('input[type=radio],input[type=checkbox]').length >= 2) { best = p; break }
        p = p.parentElement;
      }
      cont = best || inp.parentElement || document.body;
      key = 'p:' + boxId(cont);
    }
    if (!native.has(key)) native.set(key, { type: inp.type, inputs: [], cont });
    native.get(key).inputs.push(inp);
  }
  for (const g of native.values()) {
    const items = [];
    for (const inp of g.inputs) {
      // 隐藏的 input 是常态（真样式做在 label 上）→ 点 label 才是用户干的事
      let clickEl = inp;
      if (!shown(inp)) {
        const lb = inp.id ? document.querySelector('label[for="' + String(inp.id).replace(/"/g, '') + '"]') : null;
        const wrap = inp.closest('label');
        clickEl = (lb && shown(lb)) ? lb : ((wrap && shown(wrap)) ? wrap : (inp.parentElement || inp));
      }
      // 文字的来源要单独找：勾选框自己身上是没有字的，字在它的 label 上。
      // 而 **label 就是复核员在图上看见的东西** —— 报错了，三方对账就永远对不上。
      const wrap = inp.closest('label');
      const forLb = inp.id ? document.querySelector('label[for="' + String(inp.id).replace(/"/g, '') + '"]') : null;
      const word = txt(clickEl, 120) || (wrap ? txt(wrap, 120) : '') || (forLb ? txt(forLb, 120) : '') || String(inp.value || '');
      items.push({ stateEl: inp, clickEl, word, type: inp.type, visible: shown(clickEl), __r: rectOf(clickEl) });
    }
    if (!items.some((o) => o.visible)) continue;      // 整组都看不见 = 碰不到，不收
    const ordered = byPos(items);
    const cont = g.cont || commonAncestor(ordered.map((o) => o.clickEl));
    const k = ++seq;
    const am = markOnce(cont, M(k));
    const opts = ordered.slice(0, MAXOPT).map((o, i) => {
      used.add(o.stateEl); used.add(o.clickEl);
      let cm = M(k) + 'o' + (i + 1), sm = M(k) + 'i' + (i + 1);
      if (o.clickEl === o.stateEl) { cm = M(k) + 'x' + (i + 1); sm = cm }   // 同一个元素不能打两个记号
      mark(o.clickEl, cm); mark(o.stateEl, sm);
      const text = o.word || txt(o.clickEl, 120);
      return { m: cm, sm, source: 'input', type: o.type, selected: isSel(o.stateEl),
               label: labelOf(o.clickEl, text, i), text, value: String(o.stateEl.value || ''),
               visible: o.visible, disabled: !!o.stateEl.disabled, ...o.__r, eids: eidsOf(o.clickEl).concat(eidsOf(o.stateEl)) };
    });
    push({ m: am, kind: 'pick', sub: 'input', single: g.type === 'radio', label: txt(cont, 60),
           eids: [...new Set([...eidsOf(cont), ...opts.flatMap((o) => o.eids)])], options: opts, ...rectOf(cont) });
  }

  // ── ② <select> ───────────────────────────────────────────────────────────
  for (const sel of document.querySelectorAll('select')) {
    if (!shown(sel) || sel.disabled) continue;
    const k = ++seq;
    const am = markOnce(sel, M(k));
    used.add(sel);
    const all = [...sel.options].slice(0, MAXOPT + 20);
    const opts = all.map((op, i) => {
      const text = txt(op, 120);
      return { m: am, sm: mark(op, M(k) + 'o' + (i + 1)), source: 'option', selected: !!op.selected,
               label: labelOf(op, text, i), text, value: String(op.value),
               visible: true, disabled: !!op.disabled, eids: eidsOf(op) };
    });
    push({ m: am, kind: 'pick', sub: 'select', single: !sel.multiple, multiple: !!sel.multiple,
           label: txt(sel, 60), eids: eidsOf(sel), options: opts, ...rectOf(sel) });
  }

  // ── ③ role=radio / checkbox / aria-checked（自绘选项）────────────────────
  const roleSel = '[role=radio],[role=checkbox],[aria-checked],[aria-selected]';
  const roleEls = [];
  for (const el of document.querySelectorAll(roleSel)) {
    if (el.tagName === 'INPUT' || el.tagName === 'OPTION' || el.tagName === 'SELECT') continue;
    if (el.closest('select') || used.has(el) || !shown(el)) continue;
    if (el.querySelector('input[type=radio],input[type=checkbox]')) continue;   // 归①管
    roleEls.push(el);
  }
  const roleGroups = new Map();
  for (const el of roleEls) {
    let p = el.parentElement, best = null;
    while (p && p !== document.body && p !== document.documentElement) {
      const n = [...p.querySelectorAll(roleSel)].filter((x) => shown(x)).length;
      if (n >= 2) { best = p; break }
      p = p.parentElement;
    }
    best = best || el.parentElement || document.body;
    if (!roleGroups.has(best)) roleGroups.set(best, []);
    roleGroups.get(best).push(el);
  }
  for (const [cont, list] of roleGroups) {
    const live = list.filter((e) => shown(e));
    if (live.length < 2) continue;
    if (live.some((e) => used.has(e))) continue;
    if (live.some((e) => [...used].some((u) => u.contains(e)))) continue;   // 已经归①了
    const k = ++seq;
    const am = markOnce(cont, M(k));
    const ordered = byPos(live.map((o) => ({ el: o, __r: rectOf(o) })));
    const opts = ordered.slice(0, MAXOPT).map((o, i) => {
      used.add(o.el);
      const cm = mark(o.el, M(k) + 'o' + (i + 1));
      const text = txt(o.el, 120);
      const single = String(o.el.getAttribute('role') || '') === 'radio' || String(cont.getAttribute('role') || '') === 'radiogroup';
      return { m: cm, sm: cm, source: 'click', type: single ? 'radio' : 'checkbox', selected: isSel(o.el),
               label: labelOf(o.el, text, i), text, value: '', visible: true, disabled: false, ...o.__r, eids: eidsOf(o.el) };
    });
    const single = opts.every((o) => o.type === 'radio');
    push({ m: am, kind: 'pick', sub: 'role', single, label: txt(cont, 60),
           eids: [...new Set([...eidsOf(cont), ...opts.flatMap((o) => o.eids)])], options: opts, ...rectOf(cont) });
  }

  // ── ④ 一串并列的兄弟节点，各自带一个短标签（A/B/C/D 那种 li 列表）──────
  // 这是最宽的一条规则：宁可多报，不可漏报 —— 漏了主脑就看不见活。
  const sibCands = [];
  for (const el of document.querySelectorAll('li,dd,tr,p,div,span,a,label,td,button')) {
    if (used.has(el) || el.closest('select') || el.getAttribute('role')) continue;
    if (el.querySelector('input,textarea,select,video,audio')) continue;
    if (!(el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.hasAttribute('data') || el.querySelector('[data]'))) continue;
    if (!shown(el)) continue;
    const t = txt(el, 200);
    if (!t || t.length > 200) continue;
    if (!(SHORT.test(txt(el, 4).slice(0, 2)) || /^([A-Za-z]|对|错|是|否)[\s.、．)）:：]/.test(t))) continue;
    sibCands.push(el);
  }
  const sibGroups = new Map();
  for (const el of sibCands) {
    const p = el.parentElement;
    if (!p) continue;
    if (!sibGroups.has(p)) sibGroups.set(p, []);
    sibGroups.get(p).push(el);
  }
  for (const [cont, list] of sibGroups) {
    if (list.length < 2) continue;
    if (list.some((e) => used.has(e))) continue;
    const k = ++seq;
    const am = markOnce(cont, M(k));
    const ordered = byPos(list.map((o) => ({ el: o, __r: rectOf(o) })));
    const opts = ordered.slice(0, MAXOPT).map((o, i) => {
      used.add(o.el);
      const cm = mark(o.el, M(k) + 'o' + (i + 1));
      const text = txt(o.el, 120);
      return { m: cm, sm: cm, source: 'click', type: 'checkbox', selected: isSel(o.el),
               label: labelOf(o.el, text, i), text, value: '', visible: true, disabled: false, ...o.__r, eids: eidsOf(o.el) };
    });
    push({ m: am, kind: 'pick', sub: 'siblings', single: false, label: txt(cont, 60),
           eids: [...new Set([...eidsOf(cont), ...opts.flatMap((o) => o.eids)])], options: opts, ...rectOf(cont) });
  }

  // ── ⑤ 可写区 ─────────────────────────────────────────────────────────────
  const WRITABLE = { '': 1, text: 1, search: 1, number: 1, password: 1, email: 1, tel: 1, url: 1 };
  for (const el of document.querySelectorAll('textarea,input,[contenteditable=true]')) {
    const tag = el.tagName;
    if (tag === 'INPUT' && !WRITABLE[String(el.type || 'text').toLowerCase()]) continue;
    if (tag === 'INPUT' || tag === 'TEXTAREA') { if (el.disabled || el.readOnly) continue }
    else { if (!el.isContentEditable || el === document.body || el === document.documentElement) continue }
    if (el.closest('select') || !shown(el)) continue;
    const k = ++seq;
    const wm = mark(el, M(k) + 'w');
    used.add(el);
    const ml = el.getAttribute && el.getAttribute('maxlength');
    const hint = txt(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '') || '', 60)
      || (el.labels && el.labels[0] ? txt(el.labels[0], 60) : '');
    push({ m: wm, kind: 'write', sub: tag === 'TEXTAREA' ? 'textarea' : (el.isContentEditable && tag !== 'INPUT' ? 'contenteditable' : 'input'),
           label: hint, hint, tag, value: tag === 'INPUT' || tag === 'TEXTAREA' ? String(el.value || '') : txt(el, 200),
           maxlength: ml != null && ml !== '' ? toNum(ml, null) : null, readonly: !!el.readOnly, disabled: !!el.disabled,
           eids: eidsOf(el), ...rectOf(el) });
  }

  // ── ⑥ 按钮 / 媒体：手不点它们（那是"按坐标/按编号点一下"的活），
  //      但**区域编号**要把它们算进去 —— 编号是全页从上到下数的，
  //      少算一种，后面每个编号都会往前错一位。
  for (const el of document.querySelectorAll('button,input[type=submit],input[type=button],input[type=reset],[role=button],summary,a[href],a[onclick]')) {
    if (used.has(el) || !shown(el) || el.closest('[data-dsh-hand]')) continue;
    used.add(el);
    const text = txt(el, 60) || String(el.value || '') || el.tagName.toLowerCase();
    push({ m: null, kind: 'button', sub: el.tagName.toLowerCase(), label: text, text, eids: eidsOf(el), ...rectOf(el) });
  }
  for (const el of document.querySelectorAll('video,audio')) {
    if (!shown(el) && !(el.readyState > 0)) continue;
    if (!used.has(el)) used.add(el);
    push({ m: null, kind: 'media', sub: el.tagName.toLowerCase(), label: el.tagName.toLowerCase(), text: '',
           eids: eidsOf(el), ...rectOf(el) });
  }

  // 区域记号（m）只用来"事后找回这个容器"，选项各有各的记号，回读靠选项的记号 ——
  // 所以同一个容器被两组收进去时（radio 和 checkbox 共用一个壳）不会互相干扰。
  return { url: location.href, title: document.title, vw: innerWidth, vh: innerHeight, areas };
})()`

/** 把一个 frame 扫一遍（只读；记号是写在 DOM 上的，不改页面状态） */
async function scanFrame(page, frameId, fidx) {
  const expr = SCAN_TMPL.replace('__FIDX__', String(fidx)).replace('__IS_SEL__', () => IS_SEL_SNIPPET)
  return page.evalInFrame(frameId, expr).catch(() => null)
}

/**
 * 每个子窗口的视口原点，换算到**主窗口视口坐标**（差值就是 iframe 的偏移）。
 *
 * ⚠️ 两套坐标别搞混（这坑很隐蔽）：
 *   · page.frameRects() 给的是**页面坐标**（含滚动量，主文档左上角为原点），
 *     它第 0 条是主窗口自己，x/y 恰好等于滚动量。
 *   · getBoundingClientRect / Input.dispatchMouseEvent 用的是**视口坐标**。
 *   所以这里统一减掉主窗口那一条 —— 得到"相对主窗口视口"的偏移，
 *   正好能跟 rect 相加/相减，也正好是鼠标事件要的坐标系。
 */
async function frameOffsets(page, frames) {
  const out = new Map()
  if (typeof page.frameRects === 'function') {
    try {
      const rects = await page.frameRects()
      if (Array.isArray(rects) && rects.length) {
        const mx = num(rects[0] && rects[0].x, 0)
        const my = num(rects[0] && rects[0].y, 0)
        for (const r of rects) {
          const id = typeof r.frame === 'string' ? r.frame : (r.frame && r.frame.id) || r.frameId || null
          if (!id) continue
          out.set(id, { x: num(r.x, 0) - mx, y: num(r.y, 0) - my })
        }
        return out
      }
    } catch { /* 量不到就走下面的退路 */ }
  }
  // 退路：在主窗口里量 iframe 的位置，用 src 跟 frame.url 对上号。
  // （嵌套子窗口会差一层父偏移 —— 所以这只能是退路，量不准的部分按 0 算。）
  try {
    const list = await page.eval(`(() => [...document.querySelectorAll('iframe,frame')].map((e) => {
      const r = e.getBoundingClientRect();
      return { src: e.src || e.getAttribute('src') || '', x: Math.round(r.left), y: Math.round(r.top) };
    }))()`)
    for (const f of frames) {
      const hit = (list || []).find((it) => it.src && (it.src === f.url || String(f.url).startsWith(it.src) || it.src.startsWith(String(f.url))))
      if (hit) out.set(f.id, { x: hit.x, y: hit.y })
    }
  } catch { /* 量不到就全按 0 处理 */ }
  return out
}

/**
 * 全页扫描：每个 frame 扫一遍，然后**按屏幕上从上到下**排好，编成 r1…rn。
 *
 * 编号规则是契约定的（"顺序 = 屏幕上从上到下"），所以只要眼睛也按这条数，
 * 两边的 rN 就是同一个东西 —— 这是"编号对不上时"最后一条退路。
 */
async function scanAll(page) {
  const frames = await safeFrames(page)
  const offs = await frameOffsets(page, frames)
  const mainId = frames[0] ? frames[0].id : null
  const out = []
  for (let k = 0; k < frames.length; k++) {
    const r = await scanFrame(page, frames[k].id, k)
    if (!r || !Array.isArray(r.areas)) continue
    const off = offs.get(frames[k].id) || { x: 0, y: 0 }
    for (const a of r.areas) {
      out.push({ ...a, frameId: frames[k].id, frameUrl: frames[k].url, isMain: frames[k].id === mainId,
                 vw: num(r.vw, 0), vh: num(r.vh, 0),
                 absTop: num(a.top, 0) + off.y, absX: num(a.x, 0) + off.x, off })
    }
  }
  out.sort((p, q) => (p.absTop - q.absTop) || (p.absX - q.absX) || String(p.frameId).localeCompare(String(q.frameId)))
  out.forEach((a, i) => { a.i = 'r' + (i + 1) })
  return { areas: out, frames, mainId, offsets: offs }
}

// ── 2. 编号 → 元素（按**值**找，不写死属性名）───────────────────────────────

const idsOf = (eids = []) => {
  const set = new Set()
  for (const v of eids) {
    const s = String(v)
    set.add(s)
    const i = s.lastIndexOf(':')
    if (i >= 0) { set.add(s.slice(i + 1)); set.add(s.slice(0, i)) }
  }
  return set
}

/**
 * 这个"区"在页面上的所有编号。
 *
 * 除了元素身上挂着的 data-dsh-* 值，还要**从选项的编号里反推区编号**：
 * 眼睛把选项编成 `<区编号>o<序号>`（实测就是 `r7k2p1:5o0` 这种），
 * 所以把尾巴 `o<数字>` 切掉，剩下的就是区自己的编号。
 * 有了这一条，"认区"几乎不可能失败 —— 只要选项标了号，区就认得出来。
 */
const areaIds = (a) => {
  const set = idsOf(a.eids)
  for (const o of (a.options || [])) {
    for (const v of (o.eids || [])) {
      const m = String(v).match(/^(.*?)o\d+$/)
      if (m && m[1]) set.add(m[1])
    }
  }
  return set
}
const optIds = (o) => idsOf(o.eids)
const hasId = (set, id) => id != null && id !== '' && set.has(String(id))

/**
 * 这一组选项用的"区编号前缀"（眼睛那套 `<区编号>o<序号>` 里的区编号）。
 * 用来把模型可能写的短编号（"o0"）还原成眼睛真正标的那个字符串。
 */
function ownIdOf(A) {
  const opts = A.options || []
  if (!opts.length) return null
  const first = (opts[0].eids || []).map(String)
  for (const v of first) {
    if (/o\d+$/.test(v)) continue                     // 选项自己的编号不算
    if (opts.every((o) => (o.eids || []).some((x) => String(x) === v || String(x).startsWith(v)))) return v
  }
  for (const o of opts) {
    for (const v of (o.eids || [])) {
      const m = String(v).match(/^(.*?)o\d+$/)
      if (m && m[1]) return m[1]
    }
  }
  return null
}

const labelsOfArea = (area) => (Array.isArray(area && area.options) ? area.options.map((o) => o.label) : [])
const optLabels = (opts) => (opts || []).map((o) => `${o.label}(${clip(o.text || o.value || '', 12)})`).join(' / ') || '（读不出标签）'

/** 两组标签是不是同一套（不看顺序） */
function sameLabels(a = [], b = []) {
  const A = [...new Set(a.map(normLabel).filter(Boolean))].sort()
  const B = [...new Set(b.map(normLabel).filter(Boolean))].sort()
  return A.length > 0 && A.length === B.length && A.every((x, i) => x === B[i])
}

/** 按文字找一个选项：先精确标签，再精确文字，再唯一包含 */
function matchByText(opts, want, exact) {
  const w = normLabel(want)
  if (!w) return {}
  const onLabel = opts.filter((o) => normLabel(o.label) === w)
  if (onLabel.length === 1) return { option: onLabel[0] }
  if (onLabel.length > 1) return { reason: `「${want}」在这些选项里重了：${optLabels(onLabel)}` }
  if (exact) return {}
  const onText = opts.filter((o) => normLabel(o.text) === w)
  if (onText.length === 1) return { option: onText[0] }
  const loose = opts.filter((o) => normLabel(o.text).includes(w) || normLabel(o.label).includes(w))
  if (loose.length === 1) return { option: loose[0] }
  if (loose.length > 1) return { reason: `「${want}」对上了好几个：${optLabels(loose)}` }
  return {}
}

/**
 * 找"要动手的那个可挑区"。
 *
 * 顺序是有讲究的：**先认编号，再认形状/文字，最后才认位置**。
 *   mark   —— 眼睛标的编号还在（最可靠）
 *   labels —— 调用方把 eye_see 的 area 整个传进来了，选项标签能对上
 *   label  —— 调用方只说了"哪一处"的文字（area.label / 直接给一段文字）
 *   only   —— 这一页只有一个可挑区，那不可能是别的
 *   order  —— 按 rN 数第 N 个区域（契约保证了顺序；但页面一变就会错位，
 *             所以它带着核对条件，而且要在返回里如实标出来）
 */
function resolvePickArea(scan, area) {
  const picks = scan.areas.filter((a) => a.kind === 'pick')
  if (!picks.length) return { error: '这一页没有任何可挑区（没有勾选框、没有下拉框、也没有像 A/B/C/D 的一串选项）' }
  const id = typeof area === 'string' ? area : (area && area.i != null ? String(area.i) : null)
  const want = labelsOfArea(area)
  // 调用方可能只给了一段"看得见的文字"（areas[].label），当编号用
  const words = []
  if (typeof area === 'string' && !/^[\w:.-]+$/.test(area)) words.push(area)
  if (area && typeof area === 'object') {
    if (typeof area.label === 'string' && area.label.trim()) words.push(area.label)
    if (typeof area.text === 'string' && area.text.trim()) words.push(area.text)
  }

  if (id) {
    const direct = picks.find((a) => hasId(areaIds(a), id))
      || picks.find((a) => (a.options || []).some((o) => hasId(optIds(o), id)))
    if (direct) return { area: direct, via: 'mark' }
  }
  if (want.length) {
    const hit = picks.filter((a) => sameLabels((a.options || []).map((o) => o.label), want))
    if (hit.length === 1) return { area: hit[0], via: 'labels' }
    if (hit.length > 1) {
      return { error: `有 ${hit.length} 个可挑区的选项标签一模一样（${want.join('/')}），分不清是哪一个 —— 重新 eye_see 一次，用它的编号指` }
    }
  }
  for (const w of words) {
    const n = squash(w)
    if (!n) continue
    const hit = picks.filter((a) => {
      const bl = squash(a.label)
      const opts = (a.options || []).map((o) => squash(o.text) + '|' + squash(o.label))
      return (bl && (bl.includes(n) || n.includes(bl))) || opts.some((s) => s.includes(n))
    })
    if (hit.length === 1) return { area: hit[0], via: 'label' }
    if (hit.length > 1) return { error: `「${w}」对上了 ${hit.length} 个可挑区，分不清是哪一个 —— 用编号指` }
  }
  if (picks.length === 1) return { area: picks[0], via: 'only' }
  if (id && /^r\d+$/.test(id)) {
    const n = parseInt(id.slice(1), 10)
    const a = scan.areas[n - 1]
    if (a && a.kind === 'pick' && (!want.length || (a.options || []).length === want.length)) {
      return { area: a, via: 'order', note: `编号 ${id} 在页面上找不到记号，按"从上到下第 ${n} 个区域"认的 —— 动手前请 eye_see 核对一眼` }
    }
  }
  return { error: `编号 ${id || '(没给)'} 对不上这一页的任何可挑区。页面上有 ${picks.length} 个可挑区：${picks.map((a, k) => `${k + 1}.${a.i}「${clip(a.label, 20)}」${(a.options || []).length}个选项`).join('；')}` }
}

/** 找可写区：编号 → 内容对得上 → 标签提示对得上 → 只有一个 → 按 rN 数 */
function resolveWriteArea(scan, area) {
  const writes = scan.areas.filter((a) => a.kind === 'write')
  const id = typeof area === 'string' ? area : (area && area.i != null ? String(area.i) : null)
  if (!writes.length) {
    return { error: '这一页没有任何可写的地方（没有输入框、没有文本域、没有可编辑区）' }
  }
  if (id) {
    const direct = writes.find((a) => hasId(areaIds(a), id))
    if (direct) return { area: direct, via: 'mark' }
  }
  if (area && typeof area === 'object') {
    if (typeof area.filled === 'string' && area.filled.trim()) {
      const hit = writes.filter((a) => squash(a.value) === squash(area.filled))
      if (hit.length === 1) return { area: hit[0], via: 'value' }
    }
    if (typeof area.label === 'string' && area.label.trim()) {
      const w = squash(area.label)
      const hit = writes.filter((a) => squash(a.hint).includes(w) || w.includes(squash(a.hint)))
      if (hit.length === 1) return { area: hit[0], via: 'label' }
    }
  }
  // 只给了一段文字（"哪一处"）→ 按提示文字/占位符认
  if (typeof area === 'string' && !/^[\w:.-]+$/.test(area)) {
    const n = squash(area)
    const hit = writes.filter((a) => {
      const h = squash(a.hint)
      const v = squash(a.value)
      return (h && (h.includes(n) || n.includes(h))) || (v && v.includes(n))
    })
    if (hit.length === 1) return { area: hit[0], via: 'label' }
  }
  if (writes.length === 1) return { area: writes[0], via: 'only' }
  if (id && /^r\d+$/.test(id)) {
    const n = parseInt(id.slice(1), 10)
    const a = scan.areas[n - 1]
    if (a && a.kind === 'write') return { area: a, via: 'order', note: `编号 ${id} 找不到记号，按"从上到下第 ${n} 个区域"认的` }
  }
  return { error: `编号 ${id || '(没给)'} 对不上这一页的任何可写区。页面上有 ${writes.length} 个：${writes.map((a, k) => `${k + 1}.${a.i}「${clip(a.hint || a.value, 20)}」`).join('；')}` }
}

// ── 3. 动手的三条原语（点 / 清 / 赋值）──────────────────────────────────────

/** 只读一个选项现在选没选中：1 选中 / 0 没选中 / -1 元素没了 */
const READ_ONE_EXPR = (m, sm) => String.raw`(() => {
  __IS_SEL__
  const e = document.querySelector('[data-dsh-hand="${m}"]');
  const st = document.querySelector('[data-dsh-hand="${sm || m}"]') || e;
  return st ? (isSel(st) ? 1 : 0) : -1;
})()`

/** 一次读取一串选项的选中状态（回读用；顺序 = 我们传进去的顺序） */
const READ_MANY_EXPR = (list) => String.raw`(() => {
  __IS_SEL__
  const list = __LIST__;
  const out = [];
  for (const it of list) {
    const t = document.querySelector('[data-dsh-hand="' + (it.sm || it.m) + '"]');
    out.push(t ? (isSel(t) ? 1 : 0) : -1);
  }
  return out;
})()`

/** 把页面代码里的占位符换掉。用函数形式替换，免得替换内容里的 $ 被当成捕获组 */
const fill = (expr, map) => {
  let out = expr
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v)
  return out
}

/**
 * 点一下，并且**看它有没有真的生效**：
 *   element.click() 不生效（站点的处理器没跑）→ 退回执行它自己的行内 onclick。
 * 返回 { how, now }。
 */
async function toggleOption(page, frameId, opt, want) {
  const m = opt.m
  const sm = opt.sm || opt.m
  const expr = String.raw`(() => {
    __IS_SEL__
    const e = document.querySelector('[data-dsh-hand="${m}"]');
    if (!e) return { ok: false, why: 'gone' };
    const st = document.querySelector('[data-dsh-hand="${sm}"]') || e;
    const target = ${want ? 'true' : 'false'};
    if (isSel(st) === target) return { ok: true, how: 'already', now: isSel(st) };
    try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch (err) {}
    let how = 'none';
    try { e.click(); how = 'click' } catch (err) { how = 'click-threw:' + String(err && err.message || err).slice(0, 40) }
    return { ok: true, how, now: isSel(st) };
  })()`

  const r = await page.evalInFrame(frameId, fill(expr, { __IS_SEL__: IS_SEL_SNIPPET })).catch((e) => ({ ok: false, why: String(e && e.message || e).slice(0, 120) }))
  if (!r || !r.ok) return { how: 'gone', now: null, why: r && r.why }
  if (r.now === want) return { how: r.how, now: r.now }

  const oc = await runOnclick(page, frameId, m)
  if (!oc.ok) return { how: r.how, now: r.now, onclickError: oc.why || null }
  await sleep(150)
  const n2 = await readOne(page, frameId, m, sm)
  return { how: oc.how || 'onclick', now: n2 }
}

/**
 * 执行元素自己的行内 onclick。
 *
 * ⚠️ 必须用**主世界**（isolated: false）：onclick 里引用的都是页面自己的全局函数
 *    （addMultipleChoice / toOld …），隔离世界里没有这些名字，new Function 必然
 *    ReferenceError —— 老代码就是在隔离世界里跑的，这条退路实际上是死的。
 * ⚠️ 有的站点 CSP 禁 eval（new Function 会抛）→ 如实报错，让主脑改用真鼠标/坐标点。
 */
async function runOnclick(page, frameId, marker) {
  const expr = String.raw`(() => {
    const e = document.querySelector('[data-dsh-hand="${marker}"]');
    if (!e) return { ok: false, why: 'gone' };
    const host = e.hasAttribute('onclick') ? e : e.closest('[onclick]');
    const oc = host ? host.getAttribute('onclick') : null;
    if (!oc) return { ok: false, why: 'no-onclick' };
    try {
      (new Function('el', 'event', oc.replace(/\bthis\b/g, 'el')))(e, null);
      return { ok: true, how: 'onclick', onclick: String(oc).slice(0, 100) };
    } catch (err) {
      return { ok: false, why: 'onclick 跑失败: ' + String(err && err.message || err).slice(0, 100) };
    }
  })()`
  return page.evalInFrame(frameId, expr, { isolated: false })
    .catch((e) => ({ ok: false, why: String(e && e.message || e).slice(0, 120) }))
}

/** 在子窗口里 element.click()（坐标空间不同，真鼠标点不得 —— 见文件头） */
async function clickInFrame(page, frameId, marker) {
  const expr = String.raw`(() => {
    const e = document.querySelector('[data-dsh-hand="${marker}"]');
    if (!e) return { ok: false, why: 'gone' };
    try { e.scrollIntoView({ block: 'center', inline: 'center' }) } catch (err) {}
    try { e.click(); return { ok: true, how: 'element.click' } }
    catch (err) { return { ok: false, why: 'click 抛了: ' + String(err && err.message || err).slice(0, 80) } }
  })()`
  const r = await page.evalInFrame(frameId, expr).catch((e) => ({ ok: false, why: String(e && e.message || e).slice(0, 120) }))
  if (r && r.ok) return r
  const oc = await runOnclick(page, frameId, marker)
  return oc.ok ? { ok: true, how: 'onclick' } : { ok: false, why: `${r && r.why}; ${oc.why}` }
}

/** 单个选项的选中状态（-1 = 元素没了） */
async function readOne(page, frameId, m, sm) {
  const v = await page.evalInFrame(frameId, fill(READ_ONE_EXPR(m, sm), { __IS_SEL__: IS_SEL_SNIPPET })).catch(() => -1)
  return v === 1 ? true : (v === 0 ? false : null)
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外：点一下
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 按定位点一下。loc = { i } | { text, exact, frame } | { x, y }
 *
 * → { mode:'mouse'|'invoke', clicked:{tag,text,x,y}, urlBefore, urlAfter, navigated, framesNow }
 *
 * mode 的含义（就两种，别多想）：
 *   mouse   —— 走了浏览器输入管线（真鼠标）
 *   invoke  —— 没走输入管线，是调元素自己的点击（element.click / 它的 onclick）
 *
 * ⚠️ 和 act.mjs 的一个**故意不同**：子窗口里的 <a href> 把子窗口自己导航走了、
 *    主页面没动时，老代码会"顺手"把主页面也导航过去。现在不这么干了 ——
 *    「工具不会自作主张跳页」是这一版的硬规矩（用户翻好哪一页就从哪一页开始）。
 *    这里只把这件事**如实报出来**（note + frameNavigated），跳不跳由主脑决定。
 */
export async function clickLocator(page, loc, { settleMs = 1500 } = {}) {
  if (!loc || typeof loc !== 'object') throw argErr('loc 必须是 { i } / { text, exact } / { x, y } 三种写法之一')
  const hasI = loc.i !== undefined && loc.i !== null && loc.i !== ''
  const hasText = loc.text !== undefined && loc.text !== null && loc.text !== ''
  const hasXY = loc.x !== undefined && loc.y !== undefined && loc.x !== null && loc.y !== null
  const kinds = [hasI, hasText, hasXY].filter(Boolean).length
  if (kinds === 0) throw argErr('loc 里既没有编号、也没有文字、也没有坐标 —— 三个里必须给一个')
  if (kinds > 1) throw argErr('loc 里给了不止一种指法（编号/文字/坐标只能三选一），分不清你要点哪个')

  const urlBefore = await href(page)
  let mode = null
  let via = null
  let note = null
  let clicked = null
  let frameLabel = '主页面'
  let frameId = null
  let frameUrlBefore = null
  let frameNavigated = false

  if (hasXY) {
    // ── 按坐标点：坐标就是主窗口视口坐标，永远用真鼠标 ──────────────────
    const x = Number(loc.x)
    const y = Number(loc.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw argErr(`坐标必须是数字，收到 x=${loc.x} y=${loc.y}`)
    let hit = null
    try {
      hit = await page.eval(`(() => {
        const e = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
        if (!e) return null;
        const t = (x) => String(x.innerText || x.value || x.getAttribute('title') || x.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        return { tag: e.tagName, text: t(e) };
      })()`)
    } catch { /* 点不到也照点 —— 报坐标是事实 */ }
    if (typeof page.hitFrame === 'function') {
      try {
        // hitFrame 收的是**页面坐标**（含滚动），模型给的是视口坐标 → 先把滚动量加回去
        const fr = typeof page.frameRects === 'function' ? await page.frameRects() : null
        const sy = fr && fr[0] ? num(fr[0].y, 0) : 0
        const fid = await page.hitFrame(x, y + sy)
        if (fid) { frameId = fid; frameLabel = '子窗口' }
      } catch { /* 量不到就当主窗口 */ }
    }
    await page.clickAt(x, y)
    mode = 'mouse'
    via = 'point'
    clicked = { tag: hit ? hit.tag : null, text: hit ? hit.text : '', x: Math.round(x), y: Math.round(y) }
    if (!hit) note = '这个坐标上 elementFromPoint 读不到元素（可能在视口外），但仍然点了'
  } else {
    // ── 按编号 / 按文字：先找到那个元素，再决定用哪只手 ──────────────────
    const frames = await safeFrames(page)
    const hit = hasI ? await findById(page, frames, loc.i) : await findByText(page, frames, loc)
    if (!hit) {
      throw fail('NOT_FOUND',
        hasI ? `编号 ${loc.i} 在页面上找不到 —— 编号过期了（页面变了、翻页了，或者上一次 eye_list 的编号已经作废）。重新 eye_list 看一次。`
             : `页面上没有含「${loc.text}」的可点元素 —— eye_list 看看这一页到底有什么。`,
        { category: 'WORLD' })
    }
    frameId = hit.frameId
    frameLabel = hit.isMain ? '主页面' : `子窗口(${clip(hit.frameUrl, 40)})`
    frameUrlBefore = hit.frameUrl
    const info = hit.info
    const isMain = !!hit.isMain
    // 主窗口里、而且是**视口内**看得见的元素 → 真鼠标；其它情况 → 调元素自己的点击
    if (isMain && info.visible && info.inViewport) {
      try {
        await page.clickAt(info.x, info.y)
        mode = 'mouse'
        via = 'mouse'
      } catch (e) {
        note = `真实鼠标点击失败(${clip(e && e.message, 60)})，退回 element.click()`
        const r = await clickInFrame(page, hit.frameId, hit.marker)
        if (!r.ok) throw fail('CLICK_FAILED', `点不动：${r.why}`, { category: 'WORLD' })
        mode = 'invoke'; via = 'element.click'
      }
    } else {
      if (isMain && !info.visible) note = '元素尺寸是 0（看不见）→ 真实鼠标点不到，改用 element.click()'
      else if (isMain && !info.inViewport) note = '滚了之后它仍然不在视口里（容器滚不动？）→ 改用 element.click()'
      const r = await clickInFrame(page, hit.frameId, hit.marker)
      if (!r.ok) throw fail('CLICK_FAILED', `点不动：${r.why}`, { category: 'WORLD' })
      mode = 'invoke'
      via = r.how
    }
    clicked = { tag: info.tag, text: info.text, x: info.x, y: info.y }

    await sleep(settleMs)
    // 子窗口自己跳走了？如实说，但**不替主脑做决定**
    const now = (await safeFrames(page)).find((f) => f.id === frameId)
    if (now && frameUrlBefore && now.url !== frameUrlBefore) {
      frameNavigated = true
      if (info.href && /^https?:/i.test(info.href)) {
        note = `${note ? note + '；' : ''}子窗口自己跳走了（${clip(now.url, 50)}），主页面没动。要跟过去就自己 hand_goto(${clip(info.href, 70)})`
      } else {
        note = `${note ? note + '；' : ''}子窗口自己跳走了（${clip(now.url, 50)}），主页面没动`
      }
    }
  }

  await sleep(hasXY ? settleMs : 0)
  const urlAfter = await href(page)
  const framesNow = (await safeFrames(page)).map((f) => clip(f.url, 80))
  const navigated = urlBefore !== urlAfter
  return {
    mode, via, clicked,
    frame: frameLabel,
    urlBefore, urlAfter, navigated, framesNow,
    ...(frameNavigated ? { frameNavigated: true } : {}),
    ...(note ? { note } : {}),
    changed: hasXY
      ? `在 (${clicked.x}, ${clicked.y}) 点了一下${clicked.tag ? `，那里是 <${String(clicked.tag).toLowerCase()}>` : ''}${navigated ? '；页面地址变了' : '；地址没变'}`
      : `点了一下 <${String(clicked.tag).toLowerCase()}>「${clip(clicked.text, 30)}」${navigated ? '；页面地址变了' : '；地址没变'}`,
  }
}

/** 按编号找元素：按 data-dsh-* 的**值**匹配，找到就给它打个我们自己的记号 */
async function findById(page, frames, i) {
  const want = String(i)
  for (const f of frames) {
    const info = await page.evalInFrame(f.id, FIND_EXPR(want, true)).catch(() => null)
    if (info) return { frameId: f.id, frameUrl: f.url, isMain: f.id === frames[0].id, marker: 'hit', info }
  }
  return null
}

/** 按可见文字找元素（多个命中时报错，不猜；同一棵子树里的包一层不算"多个"） */
async function findByText(page, frames, loc) {
  const want = String(loc.text)
  const exact = !!loc.exact
  let list = frames
  if (loc.frame) {
    if (isMainFrameWord(loc.frame)) list = frames.slice(0, 1)
    else {
      const f = String(loc.frame)
      const hit = frames.filter((x) => String(x.url).includes(f))
      if (hit.length) list = hit
    }
  }
  const found = []
  for (const f of list) {
    const r = await page.evalInFrame(f.id, TEXT_EXPR(want, exact)).catch(() => null)
    if (!r) continue
    if (r.ambiguous) {
      // 同一个窗口里就有好几个长得一样的 → 不猜，让主脑用编号点
      throw fail('TEXT_AMBIGUOUS',
        `「${want}」在一个窗口里对上了 ${r.ambiguous} 个元素（${(r.texts || []).join(' / ')}）—— 用 eye_list 看编号，然后按编号点。`,
        { category: 'USAGE', hits: r.texts })
    }
    found.push({ frameId: f.id, frameUrl: f.url, isMain: f.id === frames[0].id, info: r })
  }
  if (!found.length) return null
  if (found.length > 1) {
    throw fail('TEXT_AMBIGUOUS',
      `「${want}」在 ${found.length} 个窗口里都有，分不清点哪个 —— 用 eye_list 看编号，然后按编号点。`,
      { category: 'USAGE', hits: found.map((h) => clip(h.frameUrl, 50)) })
  }
  return { ...found[0], marker: 'hit' }
}

/** 按编号找元素（并把"命中的那个"打上 data-dsh-hand="hit"） */
const FIND_EXPR = (want, full) => String.raw`(() => {
  const want = ${JSON.stringify(want)};
  const hit = (e) => {
    for (const at of e.attributes) {
      if (at.name.length <= 9 || at.name.slice(0, 9) !== 'data-dsh-' || at.name === 'data-dsh-hand') continue;
      const v = String(at.value);
      if (v === want) return true;
      const i = v.lastIndexOf(':');
      if (i >= 0 && (v.slice(i + 1) === want || v.slice(0, i) === want)) return true;
    }
    return false;
  };
  const info = (e) => {
    // ★ 先把它滚进视口再量坐标。真鼠标用的是**视口坐标** ——
    //   元素在页面下方（rect.y=1200 而视口只有 900 高）时直接点等于点空白处，
    //   表现就是"点了没反应"。act.mjs 的 page.click() 内部也做了这一步。
    try { e.scrollIntoView({ block: 'center', inline: 'center' }) } catch (err) {}
    const r = e.getBoundingClientRect();
    const t = String(e.innerText || e.value || e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    e.setAttribute('data-dsh-hand', 'hit');
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    return { tag: e.tagName, text: t,
             href: (e.getAttribute('href') || '').slice(0, 300) || null,
             target: e.getAttribute('target') || null,
             onclick: (e.getAttribute('onclick') || '').slice(0, 120) || null,
             visible: r.width > 2 && r.height > 2,
             // 滚动之后**还在视口里**才敢用真鼠标（有些容器滚不动，或者页面开了平滑滚动）
             inViewport: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight,
             x: cx, y: cy };
  };
  // 先扫"眼睛会报的那些"（便宜）；一个都没命中再整棵树扫一遍（不常见）
  const sel = 'a,button,input,textarea,select,label,summary,li,img,video,audio,iframe,[onclick],[role],[tabindex],[contenteditable=true]';
  for (const e of document.querySelectorAll(sel)) if (hit(e)) return info(e);
  if (${full ? 'true' : 'false'}) for (const e of document.querySelectorAll('*')) if (hit(e)) return info(e);
  return null;
})()`

/** 按可见文字找元素（先过滤掉"被别的命中包在里面"的，避免 button>span 报成两个） */
const TEXT_EXPR = (want, exact) => String.raw`(() => {
  const want = ${JSON.stringify(want)};
  const txt = (e) => String(e.innerText || e.value || e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim();
  const all = [...document.querySelectorAll('a,button,input,label,summary,[onclick],[role=button],[class*=btn]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 3 && r.height > 3 });
  const m = all.filter((e) => ${exact ? 'txt(e) === want' : 'txt(e).includes(want)'});
  if (!m.length) return null;
  const outer = m.filter((e) => !m.some((o) => o !== e && o.contains(e)));
  if (outer.length > 1) return { ambiguous: outer.length, texts: outer.slice(0, 5).map((e) => txt(e).slice(0, 40)) };
  const e = outer[0];
  try { e.scrollIntoView({ block: 'center', inline: 'center' }) } catch (err) {}   // 先在视口里再量坐标
  e.setAttribute('data-dsh-hand', 'hit');
  const r = e.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  return { tag: e.tagName, text: txt(e).slice(0, 80), href: (e.getAttribute('href') || '').slice(0, 300) || null,
           target: e.getAttribute('target') || null, onclick: (e.getAttribute('onclick') || '').slice(0, 120) || null,
           visible: r.width > 2 && r.height > 2,
           inViewport: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight,
           x: cx, y: cy };
})()`

// ═══════════════════════════════════════════════════════════════════════════
// 对外：在可挑区里挑
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 在一个可挑区里挑选项。
 *
 * → { picked:[{i,label,text,now}], areaState:{selected,total}, rejected:[{given,reason}] }
 *
 * mode: set（覆盖：先把这一区里已选的都取消，再挑）/ add（追加）/ clear（全取消）
 *
 * ★ 单选组里再点一个，页面自己会取消上一个 —— 不用我们操心。
 * ★ 给了一个页面上没有的选项 → 进 rejected，reason 里列清**实际有哪几个**，绝不瞎点。
 * ★ <select> 用赋值（设选中 + 派发 change），其它用点击 —— 模型不变，只是手的动作不同。
 * ★ 找不到区 → throw（index.js 会包成 WORLD）。
 *
 * choose 每一项可以写成：
 *   字符串 "o2"            —— 眼睛给的选项编号
 *   { i:"o2" }             —— 同上
 *   { text:"B", exact:true } —— 按屏幕上的可见标签/文字找
 *   { x, y }               —— 按坐标找（截图里看到的位置）
 * 先全部校验，再动手 —— 有一条不合格就整批不做（零副作用）。
 */
export async function pickOptions(page, { area, choose, mode = 'set' } = {}) {
  if (area === undefined || area === null || area === '') throw argErr('必须给 area（eye_see 报的可挑区编号，比如 "r3"）')
  const wanted = mode === 'set' || mode === 'add' || mode === 'clear'
  if (!wanted) throw argErr(`mode 只能是 set / add / clear，收到 "${mode}"`)
  const list = choose === undefined || choose === null ? [] : (Array.isArray(choose) ? choose : [choose])
  if (mode !== 'clear' && !list.length) throw argErr(`mode="${mode}" 却一个选项都没给（要全取消就用 mode:"clear"）`)

  const scan = await scanAll(page)
  const r = resolvePickArea(scan, area)
  if (r.error) throw fail('NO_AREA', r.error, { category: 'WORLD' })
  const A = r.area
  const opts = A.options || []
  if (!opts.length) throw fail('NO_OPTIONS', `可挑区 ${A.i} 里读不出任何选项 —— 截图看一眼它到底是什么`, { category: 'WORLD' })

  const rejected = []
  const notes = []
  if (r.note) notes.push(r.note)
  if (mode === 'clear' && list.length) notes.push('mode 是 clear，给的选项一律忽略（clear 就是全取消）')

  // ── 第一步：**先校验**（一个像素都不碰）────────────────────────────────
  const plan = []                      // [{ opt, given }]
  const seen = new Set()
  if (mode !== 'clear') {
    for (const given of list) {
      const res = await resolveChoice(page, A, given, scan)
      if (res.reject) { rejected.push(res.reject); continue }
      const opt = res.option
      if (seen.has(opt)) { rejected.push({ given, reason: `同一项给了两次（都是 ${opt.label}）—— 忽略重复的那次` }); continue }
      if (opt.disabled) { rejected.push({ given, reason: `「${opt.label}」是灰的（disabled），点不动` }); continue }
      seen.add(opt)
      plan.push({ opt, given })
    }
  }
  if (rejected.length) {
    // 有一条不合格 → 整批不动（宪法②：格式错在动手之前拦住，且零副作用）
    return {
      picked: [], areaState: areaStateOf(A, opts), rejected, notes,
      area: A.i, via: r.via, changed: null,
    }
  }

  const before = opts.filter((o) => o.selected).map((o) => o.label)

  // ── 第二步：动手（先取消，再挑；严格串行，一次一个）───────────────────
  const hows = []
  const lastNow = new Map()          // 动手那一刻读到的状态（回读失败时的退路）
  if (A.sub === 'select') {
    hows.push(await applySelect(page, A, plan, mode))
  } else {
    if (mode === 'set' || mode === 'clear') {
      for (const o of opts.filter((x) => x.selected)) {
        const rr = await applyOption(page, A, o, false)
        lastNow.set(o, rr.now === true)
        // 取消"成功"= 现在确实没选中。now 只有明确读到 true 才算没取消掉。
        if (rr.now === true) notes.push(`「${o.label}」没取消掉（${rr.how}）—— 页面自己没反应`)
        else if (rr.now === null) notes.push(`「${o.label}」取消之后读不到状态了（${rr.how}）`)
      }
    }
    for (const { opt } of plan) {
      const rr = await applyOption(page, A, opt, true)
      hows.push(rr.how)
      lastNow.set(opt, rr.now === true)
      if (rr.now !== true) notes.push(`「${opt.label}」点了但页面没选中（${rr.how}${rr.onclickError ? '；' + rr.onclickError : ''}）—— 截图看看是不是被遮住了`)
    }
  }

  // ── 第三步：回读（报事实，不报"我以为"）──────────────────────────────
  await sleep(200)
  const fresh = await readAreaState(page, A)
  const verified = fresh.ok
  if (!verified) notes.push('最后一次回读没成功（这些元素读不到了）—— 下面报的是动手那一刻读到的状态')

  const picked = plan.map(({ opt }) => {
    const idx = opts.indexOf(opt)
    const now = verified ? fresh.sel[idx] === true : lastNow.get(opt) === true
    return { i: optId(A, idx), label: opt.label, text: opt.text, now }
  })
  const afterLabels = verified ? fresh.labels : (A.sub === 'select' ? [] : opts.filter((o) => lastNow.get(o)).map((o) => o.label))

  return {
    picked,
    areaState: verified
      ? { selected: fresh.selected, total: fresh.total }
      : { selected: afterLabels.length, total: opts.length },
    rejected,
    area: A.i,
    via: r.via,
    verified,
    how: hows,
    notes,
    changed: `可挑区 ${A.i}（${opts.length} 个选项）：之前选中 ${before.join('/') || '无'}，现在选中 ${afterLabels.join('/') || '无'}`,
  }
}

/** 选项的对外编号：就是眼睛那套 o1..on（同一区里从 1 数） */
const optId = (A, idx) => 'o' + (idx + 1)

/** 回读一个区现在的选中情况（ok=false 表示这次回读根本没成功，别拿它当事实） */
async function readAreaState(page, A) {
  const opts = A.options || []
  const marks = opts.map((o) => ({ m: o.m, sm: o.sm }))
  const raw = await page.evalInFrame(A.frameId, fill(READ_MANY_EXPR(marks), { __LIST__: JSON.stringify(marks), __IS_SEL__: IS_SEL_SNIPPET })).catch(() => null)
  if (!Array.isArray(raw)) {
    return { ok: false, total: opts.length, selected: 0, sel: opts.map(() => false), labels: [], lost: opts.length }
  }
  const sel = raw.map((v) => v === 1)
  return {
    ok: true,
    total: opts.length,
    selected: sel.filter(Boolean).length,
    sel,
    labels: opts.filter((_, i) => sel[i]).map((o) => o.label),
    lost: raw.filter((v) => v === -1).length,
  }
}

function areaStateOf(A, opts) {
  return { selected: (opts || []).filter((o) => o.selected).length, total: (opts || []).length }
}

/** 把 choose 里的一项变成这个区里的一个选项（校验就在这一步做完） */
async function resolveChoice(page, A, given, scan) {
  const opts = A.options || []
  const asIndex = (n) => (n >= 1 && n <= opts.length ? { option: opts[n - 1] } : {})
  const notFound = (what) => ({
    reject: { given, reason: `${what} —— 这个可挑区一共 ${opts.length} 个选项：${optLabels(opts)}` },
  })

  // ① 坐标：问页面"这个点上是谁"
  if (given && typeof given === 'object' && given.x !== undefined && given.y !== undefined && given.i === undefined && given.text === undefined) {
    const hit = await optionAtPoint(page, A, given.x, given.y, scan)
    if (hit) return { option: hit }
    return notFound(`坐标 (${given.x}, ${given.y}) 上没有这个可挑区的任何一个选项`)
  }

  const id = typeof given === 'string' ? given : (given && given.i != null ? String(given.i) : null)
  if (id != null && id !== '') {
    // ① 一字不差就是眼睛标的那个字符串（最稳，模型抄编号时走这条）
    const byMark = opts.find((o) => hasId(optIds(o), id))
    if (byMark) return { option: byMark }

    // ② 短编号（"o2" / "2"）：先按**眼睛那一套编号**还原成完整字符串再找。
    //    ⚠️ 实测：眼睛的选项编号是 0 起的（`<区>o0`、`<区>o1`…）。
    //       不先按它还原，模型抄个 "o0" 过来会被当成"第 0 个选项"直接拒绝；
    //       而 "o1" 会被当成"第 1 个"—— 其实眼睛的 o1 是第 2 个，正好差一位。
    const m = id.match(/^o?(\d+)$/)
    if (m) {
      const n = parseInt(m[1], 10)
      const own = ownIdOf(A)
      if (own) {
        const full = own + 'o' + n
        const byEye = opts.find((o) => (o.eids || []).some((v) => String(v) === full))
        if (byEye) return { option: byEye }
      }
      // ③ 页面上没有眼睛的编号时，才按"第几个"理解（契约里 o1 = 第一个，1 起）
      const byIdx = asIndex(n)
      if (byIdx.option) return byIdx
      return { reject: { given, reason: `这个可挑区没有编号 ${id} 对应的选项（一共 ${opts.length} 个）：${optLabels(opts)}` } }
    }

    // ④ 编号对不上时，退一步当标签/文字用（模型偶尔会直接写 "B"）
    const byText = matchByText(opts, id, true)
    if (byText.option) return { option: byText.option }
    return notFound(`编号 ${id} 在这个可挑区里找不到`)
  }

  if (given && typeof given === 'object' && given.text != null) {
    const byText = matchByText(opts, String(given.text), !!given.exact)
    if (byText.option) return { option: byText.option }
    if (byText.reason) return { reject: { given, reason: byText.reason } }
    return notFound(`页面上没有「${given.text}」这个选项`)
  }

  return { reject: { given, reason: '这一项既没有编号、也没有文字、也不是坐标 —— 不知道怎么指' } }
}

/** 坐标落在哪个选项上（要先把主窗口视口坐标换算成那个子窗口的局部坐标） */
async function optionAtPoint(page, A, x, y, scan) {
  const off = (scan.offsets && scan.offsets.get(A.frameId)) || { x: 0, y: 0 }
  const lx = Math.round(Number(x) - off.x)
  const ly = Math.round(Number(y) - off.y)
  const marks = []
  for (const o of A.options || []) { if (o.m) marks.push(o.m); if (o.sm && o.sm !== o.m) marks.push(o.sm) }
  const hit = await page.evalInFrame(A.frameId, `(() => {
    const e = document.elementFromPoint(${lx}, ${ly});
    if (!e) return null;
    for (const m of ${JSON.stringify(marks)}) {
      const t = document.querySelector('[data-dsh-hand="' + m + '"]');
      if (t && (t === e || t.contains(e) || (t.parentElement && t.parentElement === e))) return m;
    }
    return null;
  })()`).catch(() => null)
  if (!hit) return null
  return (A.options || []).find((o) => o.m === hit || o.sm === hit) || null
}

/**
 * 对**一个**选项动手（true = 选上 / false = 取消）。
 *
 * 三种手：
 *   真鼠标（主窗口里、且**当前视口内**看得见的元素）—— 走浏览器输入管线，最像真人
 *   element.click()（子窗口 / 看不见的 / 在视口外的元素）
 *   直接清 DOM（单选组"取消"专用：单选框点不掉，点了没反应）
 *
 * ⚠️ "在视口内"这一条是实测踩出来的：Input.dispatchMouseEvent 收的是**视口坐标**，
 *    元素在滚动区外时它的 rect.y 会是 1200 这种视口外的值 —— 真鼠标点下去
 *    等于点在空白处（表现是"点了没反应"）。所以视口外一律改走 element.click()。
 */
async function applyOption(page, A, opt, want) {
  // ★ 先读一次现在的状态，别信扫描那一刻的旧值。
  //   实测：mode="set" 里"先取消、再挑同一个"的场合，旧值说"它已经选着"，
  //   于是挑这一步被当成 already 直接跳过 —— 结果全取消完就没人再选它了。
  const cur = await readOne(page, A.frameId, opt.m, opt.sm)
  if (cur === want) return { how: 'already', now: cur }

  // 单选组要取消：单选框点自己是没反应的，只能在 DOM 上清掉。
  // 这里**不派发 change** —— 页面自己的账本由紧接着的那一下"点新的"去更新，
  // 伪造一个"用户取消了单选"的事件只会把站点的状态搅乱。
  if (!want && opt.source === 'input' && opt.type === 'radio') {
    const sm = opt.sm || opt.m
    await page.evalInFrame(A.frameId, `(() => {
      const e = document.querySelector('[data-dsh-hand="${sm}"]');
      if (e) e.checked = false;
      return true;
    })()`).catch(() => null)
    const now = await readOne(page, A.frameId, opt.m, opt.sm)
    return { how: 'clear-dom', now }
  }

  const inView = num(opt.x, -1) >= 0 && num(opt.y, -1) >= 0 && num(opt.y, 1e9) <= num(A.vh, 0) && num(opt.x, 1e9) <= num(A.vw, 0)
  if (A.isMain && opt.visible && num(opt.w, 0) > 2 && num(opt.h, 0) > 2 && inView && opt.source !== 'option') {
    try {
      await page.clickAt(opt.x, opt.y)
      await sleep(120)
      const now = await readOne(page, A.frameId, opt.m, opt.sm)
      if (now === want) return { how: 'mouse', now }
      const oc = await runOnclick(page, A.frameId, opt.m)
      if (oc.ok) {
        await sleep(150)
        return { how: 'mouse+onclick', now: await readOne(page, A.frameId, opt.m, opt.sm) }
      }
      return { how: 'mouse', now, onclickError: oc.why || null }
    } catch (e) {
      // 真鼠标点空了（元素刚被挪走/被遮住）→ 退回 element.click()
      const r = await toggleOption(page, A.frameId, opt, want)
      return { ...r, how: `mouse-failed→${r.how}`, mouseError: clip(e && e.message, 60) }
    }
  }

  const r = await toggleOption(page, A.frameId, opt, want)
  if (!inView && A.isMain && opt.visible) return { ...r, outOfView: true }
  return r
}

/**
 * <select> 用**赋值**，别的用点击。
 *
 * 为什么：下拉框的选项是浏览器自己画的系统菜单，点不到（elementFromPoint 里
 * 根本没有那个 option）—— 只能设选中 + 派发 change，让站点自己的监听跑起来。
 * 单选 select 设新值会自动取消旧值（页面自己的行为），所以不用我们先清。
 */
async function applySelect(page, A, plan, mode) {
  const clearAll = mode === 'set' && !!A.multiple
  const ops = plan.map(({ opt }) => ({ sm: opt.sm || opt.m, on: true }))
  const r = await page.evalInFrame(A.frameId, `(() => {
    const sel = document.querySelector('[data-dsh-hand="${A.m}"]');
    if (!sel) return { ok: false, why: 'gone' };
    const byMark = (m) => document.querySelector('[data-dsh-hand="' + m + '"]');
    if (${mode === 'clear' ? 'true' : 'false'} || ${clearAll ? 'true' : 'false'}) {
      for (const o of sel.options) o.selected = false;
      if (!sel.multiple) sel.selectedIndex = -1;
    }
    for (const w of ${JSON.stringify(ops)}) {
      const o = byMark(w.sm);
      if (!o) continue;
      o.selected = !!w.on;
      if (!sel.multiple && w.on) sel.selectedIndex = o.index;
    }
    // 站点的监听靠这两个事件走（很多框架只认 change）
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: String(sel.value), selectedIndex: sel.selectedIndex };
  })()`).catch((e) => ({ ok: false, why: String(e && e.message || e).slice(0, 120) }))
  return r && r.ok ? 'value+change' : 'value-failed'
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外：往可写区里写字
// ═══════════════════════════════════════════════════════════════════════════

/**
 * → { wrote, valueNow, rejected }
 *
 * ★ valueNow 是**回读**：写完再读一次页面，报实际在那里的内容，不是"我应该写上了"。
 * ★ 超字数 / 写的地方不对 → rejected（零副作用）。
 * ★ mode: replace（默认，覆盖）/ append（接着后面写）。
 */
export async function writeInto(page, { area, text, mode = 'replace' } = {}) {
  if (area === undefined || area === null || area === '') throw argErr('必须给 area（eye_see 报的可写区编号，比如 "r7"）')
  if (text === undefined || text === null) throw argErr('必须给 text（要写进去的内容）')
  const m = mode === 'replace' || mode === 'append' ? mode : null
  if (!m) throw argErr(`mode 只能是 replace / append，收到 "${mode}"`)

  const scan = await scanAll(page)
  const r = resolveWriteArea(scan, area)
  if (r.error) {
    return { wrote: false, valueNow: null, rejected: [{ given: area, reason: r.error }], changed: null }
  }
  const F = r.area
  const notes = []
  if (r.note) notes.push(r.note)
  const rejected = []
  const incoming = String(text)

  if (F.disabled) rejected.push({ given: area, reason: `这个格子是灰的（disabled），写不进去` })
  if (F.readonly) rejected.push({ given: area, reason: `这个格子是只读的（readonly），写不进去` })

  const finalText = m === 'append' ? String(F.value || '') + incoming : incoming
  // ⚠️ 程序化赋值**不触发** maxlength（浏览器只拦用户输入），所以必须自己先算：
  //    不先拦，就会出现"页面显示已经写满、其实多出来的字被站点后端截掉/拒绝"的怪事。
  if (F.maxlength != null && finalText.length > F.maxlength) {
    rejected.push({ given: area, reason: `这个格子最多 ${F.maxlength} 个字，你要写 ${finalText.length} 个 —— 缩短一点再写` })
  }
  if (rejected.length) {
    return { wrote: false, valueNow: F.value ?? null, rejected, area: F.i, via: r.via, notes, changed: null }
  }

  const isCE = F.sub === 'contenteditable'
  const expr = String.raw`(() => {
    const e = document.querySelector('[data-dsh-hand="${F.m}"]');
    if (!e) return { ok: false, why: 'gone' };
    const val = ${JSON.stringify(finalText)};
    try { e.focus() } catch (err) {}
    if (${isCE ? 'true' : 'false'}) {
      e.textContent = val;
    } else {
      // ⚠️ 用**原型上**的 value setter，不用 e.value = …
      //    某些框架会在实例上装自己的拦截器，直接赋值它认为"值没变"，
      //    于是事件派发了、它自己的状态却没更新（表现是"写了但一提交就空"）。
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(e, val); else e.value = val;
    }
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    return { ok: true, now: String(${isCE ? 'e.textContent' : 'e.value'} || '') };
  })()`
  const w = await page.evalInFrame(F.frameId, expr).catch((e) => ({ ok: false, why: String(e && e.message || e).slice(0, 120) }))
  if (!w || !w.ok) {
    return { wrote: false, valueNow: null, rejected: [{ given: area, reason: `写不进去：${(w && w.why) || '元素不见了'}` }], area: F.i, via: r.via, notes }
  }

  await sleep(150)
  const back = await page.evalInFrame(F.frameId, `(() => {
    const e = document.querySelector('[data-dsh-hand="${F.m}"]');
    if (!e) return null;
    return String(${isCE ? 'e.textContent' : 'e.value'} || '');
  })()`).catch(() => null)
  if (back === null) notes.push('写完回读时元素不见了（页面被刷新或者被替换了？）')

  const valueNow = back === null ? String(w.now || '').slice(0, 2000) : String(back).slice(0, 2000)
  const wrote = back !== null && squash(valueNow) === squash(finalText)
  if (!wrote && back !== null) {
    notes.push(`写进去的和要写的不一样：要写 ${clip(finalText, 60)}，页面里是 ${clip(valueNow, 60)}`)
  }
  return {
    wrote,
    valueNow,
    rejected,
    area: F.i,
    via: r.via,
    notes,
    changed: `可写区 ${F.i}：现在里面是「${clip(valueNow, 40) || '（空）'}」`,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外：滚
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 窗口名 → 和 `see.mjs` 的 frameLabel **一模一样**。
 * 为什么必须一致：模型是从 eye_see / eye_list 的返回里抄 `frame` 值给我们的，
 * 两边各起一套名字的话，模型抄过来的名字我们永远认不出（而它看不出哪里错）。
 * 规则：真正的顶层窗口叫「主页面」，其它一律「子窗口:<域名>/<路径片段>」——
 * **不按网站起业务名字**（站点一改路径就全错）。
 */
function frameLabel(url, isMain = false) {
  if (!url || /^about:/.test(url)) return isMain ? '主页面' : '空窗口'
  if (isMain) return '主页面'
  try {
    const u = new URL(url)
    const seg = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).slice(-2).join('/')
    return `子窗口:${u.hostname}${seg ? '/' + seg.slice(0, 30) : ''}`
  } catch { return `子窗口:${String(url).slice(0, 40)}` }
}
const uniqLabels = (labels) => {
  const seen = new Map()
  return labels.map((l) => { const n = (seen.get(l) ?? 0) + 1; seen.set(l, n); return n === 1 ? l : `${l}#${n}` })
}
/** 窗口名可能重复（两个路径片段一样的子窗口）→ 加 #2 #3，和 see.mjs 同一套去重法 */
async function labeledFramesHand(page) {
  const frames = await safeFrames(page)
  const mainId = frames[0] ? frames[0].id : null
  const named = uniqLabels(frames.map((f) => frameLabel(f.url, f.id === mainId)))
  return frames.map((f, k) => ({ id: f.id, url: f.url, label: named[k], isMain: f.id === mainId, index: k }))
}
/** 模型给的窗口名 → 窗口。认 ① 名字 ② frame id ③ "主页面/主窗口/main" */
function frameByName(frames, name) {
  const want = String(name || '').trim()
  if (!want) return null
  const hit = frames.find((f) => f.label === want) || frames.find((f) => f.id === want)
  if (hit) return hit
  if (isMainFrameWord(want)) return frames.find((f) => f.isMain) || null
  const prefix = frames.filter((f) => f.label.startsWith(want))
  return prefix.length === 1 ? prefix[0] : null
}

/**
 * 页面里"能不能滚 / 滚了多高"的公共片段。
 * `overflow:hidden` 的容器**也能**用 scrollTop 推动（只是没有滚动条），
 * 所以判"能滚"用的是 overflowY ∈ {auto,scroll}，不是"有没有滚动条"。
 */
const SCROLL_METRICS = String.raw`
  const num0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const OVF = (e) => { let s; try { s = getComputedStyle(e) } catch (err) { return '' } return String((s && s.overflowY) || '') };
  const canScroll = (e) => (e.scrollHeight - e.clientHeight > 1) && /(auto|scroll)/.test(OVF(e));
  // ⚠️ "窗口自己"的高度 = documentElement，**不是** window。
  //    在子窗口里 window 是不滚的（这个窗口本身没有滚动条，是外面那一页在滚），
  //    读 window.scrollY 永远是 0 —— 于是子窗口里的窗口滚动会被报成"滚不动"。
  const winInfo = () => {
    const de = document.documentElement || document.body;
    const sh = Math.max(de ? de.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
    const ch = innerHeight || (de ? de.clientHeight : 0);
    return { el: de, sh: Math.round(sh), ch: Math.round(ch), max: Math.max(0, Math.round(sh - ch)) };
  };
  const metrics = (e, win) => {
    if (win || !e) {
      const w = winInfo();
      const y = Math.max(w.el ? num0(w.el.scrollTop) : 0, num0(window.scrollY || 0));
      return { y: Math.round(y), max: w.max, sh: w.sh, ch: w.ch, atTop: y <= 1, atBottom: y + w.ch >= w.sh - 8, win: true };
    }
    const max = Math.max(0, e.scrollHeight - e.clientHeight);
    const y = e.scrollTop;
    return { y: Math.round(y), max: Math.round(max), sh: Math.round(e.scrollHeight), ch: Math.round(e.clientHeight),
             atTop: y <= 1, atBottom: y + e.clientHeight >= e.scrollHeight - 8, win: false };
  };
  // 往上找第一个"真的能滚"的祖先；到文档根为止（body/html 由 window 兜）
  const nearestScroller = (el) => {
    let cur = el, n = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && n < 30) {
      if (canScroll(cur)) return cur;
      cur = cur.parentElement; n++;
    }
    return null;
  };
  const describe = (e, win) => {
    if (win || !e) {
      const w = winInfo();
      // 报的是**主文档**（documentElement）的几何 —— 模型看到"sh=ch"就知道窗口真的没得滚
      return { container: 'window', cls: 'window', tag: 'WINDOW', sh: w.sh, ch: w.ch };
    }
    const c = String(e.className || '').trim();
    // 报的是**这个元素**的几何：sh=ch 时模型一眼就懂"它不滚"，不用再猜
    return { container: (c || e.tagName).slice(0, 40), cls: (c || e.tagName).slice(0, 40), tag: String(e.tagName), sh: Math.round(e.scrollHeight), ch: Math.round(e.clientHeight) };
  };
`

/**
 * 给"要滚的那个东西"打记号（每步滚之前重新打一次，元素被换掉了也能重新认）。
 * 传进来的 `kind`（在页面里叫 `what`，避免和模板里的名字撞）：
 *   'mark'   —— 用编号/文字定位到的那个元素（已经挂了 data-dsh-hand）
 *   'center' —— 视口中间那个元素
 *   'box'    —— 全页最大的可滚容器
 */
const SCROLL_RESOLVE_EXPR = (kind, mark, x, y) => `(() => {
  const what = ${JSON.stringify(kind)};
  ${SCROLL_METRICS}
  const note = { want: what, found: false, why: null };
  let res = null;
  if (what === 'mark') {
    const el = document.querySelector('[data-dsh-hand="${mark}"]');
    if (!el) { note.why = 'gone'; return note }
    note.found = true;
    note.tag = String(el.tagName);
    const sc = nearestScroller(el);
    res = { kind: sc ? 'box' : 'win', sc };
    if (sc) { try { sc.setAttribute('data-dsh-hand', 'scrollbox') } catch (err) {} }
  } else if (what === 'center') {
    const el = document.elementFromPoint(${x}, ${y});
    if (el) { note.found = true; note.tag = String(el.tagName); note.cls = String(el.className || '').slice(0, 40) }
    const sc = el ? nearestScroller(el) : null;
    if (!sc) return note;
    try { sc.setAttribute('data-dsh-hand', 'scrollbox') } catch (err) {}
    res = { kind: 'box', sc };
  } else if (what === 'win') {
    // 滚这个窗口的**文档**：把 documentElement 本身当容器打上记号、滚它。
    // （打记号是为了后面每一步都滚同一个东西 —— 不标的话
    //   document.querySelector('[data-dsh-hand="scrollbox"]') 会去找别的容器。）
    const de = document.documentElement;
    if (!de) { note.why = 'no-document'; return note }
    note.found = true;
    try { de.setAttribute('data-dsh-hand', 'scrollbox') } catch (err) {}
    res = { kind: 'box', sc: de };
  } else {
    let best = null, bestMax = 0;
    for (const e of document.querySelectorAll('*')) {
      if (e === document.documentElement || e === document.body) continue;
      const m = e.scrollHeight - e.clientHeight;
      if (m <= 1) continue;                              // 便宜的先判，别对整棵树调 getComputedStyle
      if (!canScroll(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      if (m > bestMax) { bestMax = m; best = e }
    }
    if (!best) return note;
    note.found = true;
    try { best.setAttribute('data-dsh-hand', 'scrollbox') } catch (err) {}
    res = { kind: 'box', sc: best };
  }
  const m = metrics(res.sc, res.kind === 'win');
  Object.assign(note, m, describe(res.sc, res.kind === 'win'));
  return note;
})()`

/**
 * 滚一步。**只滚记号那个容器** —— 记号在、且它真的能滚时绝不去重探，
 * 免得位置变了就换了滚的对象（那会让"滚了半天没动"变成随机行为）。
 */
const SCROLL_STEP_EXPR = (dir, step) => `(() => {
  ${SCROLL_METRICS}
  const marked = document.querySelector('[data-dsh-hand="scrollbox"]');
  let el = null, win = false;
  if (marked && canScroll(marked)) el = marked;
  else if (!marked) win = true;                      // 记号没了 → 退回滚窗口
  else if (marked && !canScroll(marked)) el = marked; // 记号在但不能滚：就滚它，好让返回里如实报"sh=ch"
  const before = metrics(el, win);
  const px = ${step};
  const dir = ${JSON.stringify(dir)};
  if (dir === 'bottom') { if (el) el.scrollTop = before.max; else window.scrollTo(0, before.max) }
  else if (dir === 'top') { if (el) el.scrollTop = 0; else window.scrollTo(0, 0) }
  else if (dir === 'up') { if (el) el.scrollTop = Math.max(0, before.y - px); else window.scrollBy(0, -px) }
  else { if (el) el.scrollTop = Math.min(before.max, before.y + px); else window.scrollBy(0, px) }
  const after = metrics(el, win);
  return Object.assign({ before: before.y, moved: Math.abs(after.y - before.y) > 0.5 }, after, describe(el, win));
})()`

/**
 * 滚。→ { scrolled, moved, viewportY, maxY, frame, container, atTop, atBottom, notes }
 *
 * ★ 实测教训（这一版就是为它重做的）：
 *   真页面上"能滚的容器"主页面里**只有一个**，还是右侧的目录框（sh=1633 ch=700）；
 *   正文其实在另一个窗口**自己的文档**里。老实现只会在每个窗口里挑"最大的可滚元素"，
 *   于是模型不管怎么滚都滚在目录上，白费了 7 个步骤，最后自己写下
 *   「看来 hand_scroll 不适合滚内容区」。所以现在**能指定滚哪里**：
 *     · `area`  —— 一个定位。滚**它最近的可滚动祖先**；找不到就滚它所在窗口的文档。
 *     · `frame` —— 窗口名。滚**那个窗口的文档**。
 *     · 都不给 —— 自动挑：① 当前视口中间那个元素最近的能滚祖先
 *                          ② 全页（每个窗口）里唯一/最大的可滚容器
 *                          ③ window
 *   而且**挑了谁必须说出来**（返回里的 frame / container / how）。
 *
 * ★ 第二条同样重要：**滚不动必须明说**。
 *   老实现只回一句"没滚动 —— 要么到顶/到底，要么这个容器压根不滚"，
 *   模型分不出是哪种，只能一遍遍重试。现在按事实分开说：
 *   「这个容器不滚（sh=1633 = ch=700）」/「整个窗口就这么高，没得滚」/「已经到底了」。
 */
export async function scrollPage(page, { to = 'down', px = 800, times = 1, area = null, frame = null } = {}) {
  const dir = ['down', 'up', 'top', 'bottom'].includes(String(to)) ? String(to) : null
  if (!dir) throw argErr(`to 只能是 down / up / top / bottom，收到 "${to}"`)
  const step = Math.max(1, num(px, 800))
  const n = Math.min(50, Math.max(1, Math.round(num(times, 1))))

  const frames = await labeledFramesHand(page)
  const main = frames.find((f) => f.isMain) || frames[0] || null
  const base = {
    scrolled: false, moved: 0, viewportY: 0, maxY: 0,
    frame: main ? main.label : null, container: null,
    atTop: null, atBottom: null,
  }
  if (!frames.length) return { ...base, frame: null, notes: ['这个页面上一个窗口都读不到，滚不了'] }

  const offs = await frameOffsets(page, frames)
  const offOf = (id) => offs.get(id) || { x: 0, y: 0 }

  let target = null      // 要滚的窗口
  const notes = []
  const howParts = []    // 为什么滚它（要如实报给模型）
  let want = 'box'
  let mark = null
  let xy = null

  if (frame) {
    const fr = frameByName(frames, frame)
    if (!fr) {
      return {
        ...base,
        frames: frames.map((f) => f.label),
        notes: [`找不到叫「${clip(frame, 40)}」的窗口。现在这些窗口是：${frames.map((f) => f.label).join(' / ')}`],
      }
    }
    target = fr
    // ★ frame 给的是"滚那个窗口的**文档**"（规格原话）。所以先把那个文档自己当成
    //   要滚的容器、当场打上记号 —— 不然后面每一步又会去挑"窗口里最大的元素"，
    //   那等于悄悄换了滚的对象（模型会看到"我明明让它滚窗口，它却在滚目录"）。
    //   窗口本来就滚不动时不去打记号：那样走 'win' 分支，函数能如实报出
    //   "整个窗口就这么高（sh=ch）"，而不是拿一个不滚的容器糊弄过去。
    const wm = await page.evalInFrame(fr.id, `(() => {
      const de = document.documentElement || document.body;
      const sh = Math.max(de ? de.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
      return { max: Math.max(0, sh - innerHeight), sh: Math.round(sh), ch: Math.round(innerHeight) };
    })()`).catch(() => null)
    want = wm && num(wm.max, 0) > 1 ? 'box' : 'win'
    howParts.push(`你指定滚窗口「${fr.label}」的文档`)
  } else if (area && typeof area === 'object') {
    // 定位一个元素：i（编号挂上去了）/ text / x,y —— 和别的工具同一套定位法
    let vf = null
    const hasI = area.i !== undefined && area.i !== null && area.i !== ''
    const hasText = area.text !== undefined && area.text !== null && area.text !== ''
    const hasXY = area.x !== undefined && area.y !== undefined && area.x !== null && area.y !== null
    if (hasXY) {
      // 坐标是**主窗口视口坐标**：找到"这个点落在哪个窗口里"，
      // 并把点换算成那个窗口自己的局部坐标（子窗口的 elementFromPoint 只认局部坐标）。
      let bestOff = null
      for (const f of frames) {
        const o = offOf(f.id)
        const d = Math.abs(o.x) + Math.abs(o.y)
        if (d > 20000) continue
        if (!bestOff || d < bestOff.d) bestOff = { f, o, d }
      }
      if (bestOff) {
        vf = bestOff.f
        xy = { x: Math.round(num(area.x, 0) - bestOff.o.x), y: Math.round(num(area.y, 0) - bestOff.o.y) }
        want = 'center'
        howParts.push(`按坐标 ${Math.round(num(area.x, 0))},${Math.round(num(area.y, 0))} 找到窗口「${vf.label}」里的那个元素`)
      }
    } else {
      // 编号 / 文字：复用**和 hand_click 完全同一套**定位（findById / findByText）。
      // 为什么复用而不另写一份：定位规则一旦有两份，就会出现"点击找得到、滚动找不到"
      // 这种没法解释的差异；而且它们已经处理了"多个命中不猜"和"编号过期"两件事。
      // ⚠️ 它们命中后会把元素打上 data-dsh-hand="hit" —— 我们的探针就认这个记号，
      //    这样"滚的到底是哪一块"不靠猜，就是刚才定到的那个元素。
      const hit = hasI ? await findById(page, frames, area.i) : await findByText(page, frames, area)
      if (hit) {
        vf = frames.find((f) => f.id === hit.frameId) || null
        if (vf) {
          mark = 'hit'
          want = 'mark'
          howParts.push(`你指的${hasI ? '编号' : '那处文字'}在窗口「${vf.label}」里，我滚它最近的可滚动祖先`)
        }
      }
    }
    if (!vf) {
      return {
        ...base,
        frames: frames.map((f) => f.label),
        notes: [`按你给的 area 找不到那个元素${hasI === false && hasText ? `（文字「${clip(String(area.text), 40)}」没匹配上）` : ''} —— 先用 eye_see 看一眼拿到新编号再滚`],
      }
    }
    target = vf
  } else {
    // ── 都没给：自动挑（规格给的顺序）─────────────────────────────────────
    //   ① 当前视口中间那个元素最近的「真的能滚」的祖先
    //   ② 全页最大的可滚容器（所有窗口里比一比）
    //   ③ window
    // ⚠️ 为什么从**主窗口**开始找中间那个元素：主窗口的视口是唯一"跨窗口的公共视口"，
    //    在主窗口里 elementFromPoint 命中的一定是当前真的显示着的东西；
    //    子窗口自己的 elementFromPoint 看不到别的窗口盖在它上面的部分。
    const cx = Math.max(0, Math.round(num(await page.eval('innerWidth').catch(() => 0), 0) / 2))
    const cy = Math.max(0, Math.round(num(await page.eval('innerHeight').catch(() => 0), 0) / 2))
    if (main && cx > 0 && cy > 0) {
      const r = await page.evalInFrame(main.id, SCROLL_RESOLVE_EXPR('center', '', cx, cy)).catch(() => null)
      if (r && r.found && num(r.max, 0) > 1 && r.win !== true) {
        target = main
        want = 'center'
        howParts.push(`你没指定滚哪里，我挑了当前视口中间（${cx},${cy}）那个元素最近的能滚祖先`)
      }
    }

    // ② 每个窗口里"能滚得最多"的那个容器 / 窗口文档；③ 谁都没得滚时挑最高的窗口兜底
    if (!target) {
      const cands = []
      for (const f of frames) {
        const r = await page.evalInFrame(f.id, SCROLL_RESOLVE_EXPR('box', '', 0, 0)).catch(() => null)
        if (r && r.found && num(r.max, 0) > 1) cands.push({ f, max: num(r.max, 0) })
      }
      if (cands.length) {
        cands.sort((a, b) => b.max - a.max)
        target = cands[0].f
        want = 'box'
        howParts.push(cands.length === 1
          ? '你没指定滚哪里，这一页**只有一个**能滚的容器，我挑了它'
          : `你没指定滚哪里，能滚的容器有 ${cands.length} 个，我挑了能滚得最多的那个（${cands[0].max}px）`)
      } else {
        let bestWin = null
        for (const f of frames) {
          const m = await page.evalInFrame(f.id, `(() => {
            const de = document.documentElement || document.body;
            const sh = Math.max(de ? de.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
            return { sh: Math.round(sh), ch: Math.round(innerHeight) };
          })()`).catch(() => null)
          if (m && (!bestWin || num(m.sh, 0) > bestWin.sh)) bestWin = { f, sh: num(m.sh, 0), ch: num(m.ch, 0) }
        }
        target = bestWin ? bestWin.f : main
        want = 'win'
        howParts.push(bestWin && bestWin.sh > bestWin.ch
          ? '你没指定滚哪里，这一页没有能滚的容器，只能滚窗口'
          : '你没指定滚哪里，而且这一页**哪里都滚不动**（没有可滚容器，窗口也没超出一屏），我滚窗口试了试')
      }
    }
  }

  // ── 动手前：把"要滚谁"定下来（打记号），并读出初始几何 ────────────────────
  //
  // ⚠️ 'mark' 一定要带坐标：直接在**子窗口自己的上下文**里 querySelector 那个记号，
  //    坐标系就天然对得上（我们内部从不用主窗口坐标去算子窗口元素的位置）。
  const pre = await page.evalInFrame(
    target.id,
    want === 'mark' ? SCROLL_RESOLVE_EXPR('mark', mark, 0, 0) : SCROLL_RESOLVE_EXPR(want, '', xy ? xy.x : 0, xy ? xy.y : 0),
  ).catch((e) => ({ found: false, why: clip(e && e.message, 100) }))

  if (!pre || pre.found === false) {
    const why = (pre && pre.why) === 'gone'
      ? '我要滚的那个元素不见了（页面可能刚刷新过）'
      : `没能定下要滚谁${pre && pre.why ? '：' + pre.why : ''}`
    return { ...base, frames: frames.map((f) => f.label), notes: [`${why} —— 先用 eye_see 看一眼再滚`] }
  }
  // 定不下来"哪个容器"时**不是**错误：那就滚它所在窗口的文档（这正是规格里 area 的退路）。
  // pre.win = 这次滚的其实是**窗口文档**（不是某个容器）—— 后面报"滚不动"时要分开说。
  const isWin = pre.win === true
  const how = howParts.join('；') + (isWin ? '（滚它所在窗口的文档）' : `（滚容器 ${clip(pre.container, 30)}）`)

  // ── 一步一步滚 ─────────────────────────────────────────────────────────
  const steps = []
  for (let k = 0; k < n; k++) {
    const r = await page.evalInFrame(target.id, SCROLL_STEP_EXPR(dir, step))
      .catch((e) => ({ error: clip(e && e.message, 100) }))
    steps.push(r)
    if (r && r.error) break
    await sleep(400)
  }
  const last = steps[steps.length - 1] || {}
  const first = steps[0] || {}
  const y0 = (first.before != null) ? num(first.before, 0) : num(pre.y, 0)
  const moved = num(last.y, 0) - y0
  const scrolled = steps.some((s) => s && s.moved)

  // ── 滚不动就**明说**（这是这一版的重点，不许沉默）────────────────────────
  if (!scrolled) {
    const sh = num(last.sh, num(pre.sh, 0))
    const ch = num(last.ch, num(pre.ch, 0))
    const atTop = last.atTop != null ? last.atTop : (isWin ? num(last.y, 0) <= 1 : false)
    const atBottom = last.atBottom != null ? last.atBottom : false
    if (sh - ch <= 1) {
      notes.push(isWin
        ? `整个窗口就这么高，没得滚（内容 ${sh}px = 窗口 ${ch}px）`
        : `这个容器不滚（sh=${sh} = ch=${ch}）—— 里面没有超出一屏的内容`)
    } else if (atTop && dir === 'up') {
      notes.push('已经到顶了，再往上没有了')
    } else if (atBottom && (dir === 'down' || dir === 'bottom')) {
      notes.push(`已经到底了（${num(last.y, 0)} / ${num(last.max, 0)}），下面没有了`)
    } else if (!isWin && dir === 'bottom') {
      notes.push(`容器没动（还停在 ${num(last.y, 0)} / ${num(last.max, 0)}）—— 它可能不接受程序化的 scrollTop`)
    } else {
      notes.push(`滚了${n}次，位置一点没变（还停在 ${num(last.y, 0)} / ${num(last.max, 0)}）—— 这个${isWin ? '窗口' : '容器'}现在滚不动`)
    }
  }

  return {
    scrolled,
    moved: Math.round(moved * 10) / 10,
    viewportY: num(last.y, 0),
    maxY: num(last.max, 0),
    frame: target.label,
    // 滚的是窗口文档时就如实写 'window'（模型据此知道"这次滚的不是某个容器"）
    container: isWin ? 'window' : (pre.container ?? null),
    atTop: last.atTop != null ? last.atTop : null,
    atBottom: last.atBottom != null ? last.atBottom : null,
    how,
    steps: steps.map((s) => (s && !s.error ? { y: s.y, moved: s.moved } : (s && s.error ? { error: s.error } : null))),
    ...(steps.some((s) => s && s.error) ? { stepError: clip((steps.find((s) => s && s.error) || {}).error, 100) } : {}),
    notes,
    changed: scrolled
      ? `在「${target.label}」的 ${clip(pre.container, 30) || 'window'} 里滚到 ${num(last.y, 0)} / ${num(last.max, 0)}`
      : `位置没变（${notes[notes.length - 1] || '滚不动'}）`,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外：跳地址 / 后退 / 刷新
// ═══════════════════════════════════════════════════════════════════════════

/** 等页面加载完（读不到 readyState 就当作它在换页面，继续等） */
async function waitLoaded(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(400)
    const rs = await page.eval('document.readyState').catch(() => null)
    if (rs === 'complete') return true
  }
  return false
}

/** → { url, title, navigated }：工具**不会**自作主张跳页，跳是主脑明说的 */
export async function gotoUrl(page, url) {
  const u = String(url ?? '').trim()
  if (!u) throw argErr('url 不能是空的')
  if (/^(javascript|data|vbscript):/i.test(u)) {
    throw argErr(`不许导航到 ${clip(u, 30)} 开头的地址 —— 那种地址是往页面里灌代码，不是"去一个网页"`)
  }
  const before = await href(page)
  await page.goto(u, { timeoutMs: 30_000 })
  await sleep(300)
  const after = await href(page)
  const t = await title(page)
  return {
    url: after, title: t, navigated: before !== after,
    ...(before === after ? { note: '地址和跳转前一模一样（可能是同一页，或者这个地址被重定向回来了）' } : {}),
    changed: `${before !== after ? '从' : '停在'} ${clip(after, 70)}`,
  }
}

export async function goBack(page) {
  const before = await href(page)
  let note = null
  await page.eval('(() => { history.back(); return true })()').catch((e) => { note = `history.back() 没成功：${clip(e && e.message, 60)}` })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await sleep(300)
    const now = await href(page)
    if (now && now !== before) break
  }
  await sleep(400)
  const after = await href(page)
  const navigated = before !== after
  if (!navigated && !note) note = '地址没变 —— 可能这一页没有上一页可回（或者回退到了同一个地址）'
  return { url: after, title: await title(page), navigated, ...(note ? { note } : {}), changed: navigated ? `回到了 ${clip(after, 70)}` : '没动' }
}

export async function reloadPage(page) {
  const before = await href(page)
  let how = 'Page.reload'
  try {
    if (typeof page.send === 'function') await page.send('Page.reload', { ignoreCache: false })
    else { how = 'location.reload'; await page.eval('(() => { location.reload(); return true })()') }
  } catch (e) {
    how = 'location.reload'
    await page.eval('(() => { location.reload(); return true })()').catch(() => {})
  }
  const done = await waitLoaded(page, 30_000)
  await sleep(300)
  const after = await href(page)
  return {
    url: after, title: await title(page), navigated: before !== after,
    how, loaded: done,
    ...(done ? {} : { note: '刷新后 30 秒内没读到 readyState=complete，页面可能还在加载' }),
    changed: done ? '刷新完成' : '刷新了，但还在加载',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外：让媒体真播到底
// ═══════════════════════════════════════════════════════════════════════════

/**
 * → { kind, playedSeconds, durationSeconds, finished, reason, markBefore, markAfter, markChanged,
 *     rateNow, rateEvents, rateEnforced, notes }
 *   reason ∈ FINISHED | PAUSED | STALLED | SEEKED | RATE_CHANGED | MEDIA_ERROR | NO_MEDIA | TIMEOUT | USER_INTERACTION
 *
 * ═══ 铁律（一行都不许丢）═══
 *
 *   永不拖进度条 —— 我们从不写 currentTime。所以进度**往回跳**一定是别人干的 → SEEKED。
 *                   （往前跳我们也不追，只记一笔重新立基线。）
 *   永不伪造心跳 —— 不调站点的任何上报接口、不自己发 POST、不造假计时器。
 *                   只做页面自己也会做的事：按播放、（被要求时）把速度钉住。
 *   严格串行     —— 一次只守一个媒体，一步接一步；同一页面同时只许有一个守护在跑。
 *
 * ═══ ★ 倍速：铁律约束的是**我们**不去作弊，不是"阻止别人"（用户明确交代）═══
 *
 *   rate 参数没给（默认 null）→ 开播前设成 1x（我们自己的底线）；
 *                              之后**谁把它改了都不纠、不打断**，只记进 rateEvents 如实报告。
 *   rate 参数给了（用户要求 x 倍）→ 按它播，被改成别的就纠回；同一个视频纠满 2 次还变 → 停手，
 *                              记 rateEnforced:false。
 *   **绝不因为倍速中断播放** —— 唯一的例外是被改成 > 8x 这种离谱值（那时 RATE_CHANGED 停下问一句）。
 *
 * ═══ ★ 为什么重做（实测教训，别再走回头路）═══
 *
 *   老实现把"守多久"当**固定倒计时**（maxMinutes 从开播起算），明明读得到 duration 却不用它。
 *   实测后果：视频 738 秒、模型设 12 分钟 → 播到 738 秒才结束，**超出它自己设的上限**；
 *   视频 1062 秒、模型设 14 分钟 → 80% 处就超时，白等 14 分钟还得再叫一次。
 *   现在改成：**时长是工具读得到的事实，上限由它算**（duration × 1.15 + 90）；
 *   正常播就一直守到底，一出事立刻返回（每 250ms 看一眼状态）。
 *
 *   ★ 第二条：**只报事实，不下结论**。
 *   播之前、播之后各读一次这个媒体的任务点标记，如实报 markBefore / markAfter / markChanged
 *   （前后**都读到**才给 markChanged，读不到就 null）。**读不到就报 null，绝不猜**
 *   （把"读不到"报成"没完成"，正是上次骗到模型的原因）。
 *
 *   ★ 教训（写在这里，别再犯）：**一次现象不等于规律**。
 *   上一版把**一次会话里**看到的"3 个视频 ended:true 而标记未变"当成了普遍规律，
 *   在返回里断言"播完了 ≠ 记上了"，用户指出那是误诊 —— **正常播完就该算任务点完成**。
 *   而且那次连"标记和视频的配对"都只是按间距推的，没有实测确认。
 *   所以：**工具报事实（读到什么就说什么），规律交给大模型和用户判断。**
 */
let PLAYING = false

/** 状态每 250ms 看一次：播完了/被暂停/卡住了都要**当场**发现，不能等 6 秒一跳 */
const PLAY_TICK_MS = 250

/** 读这个媒体的任务点标记：→ { aria, status, y, frameLabel } 或 null（读不到就是 null） */
async function readMediaMark(page, media) {
  if (!media) return null
  const frames = await labeledFramesHand(page)
  const offs = await frameOffsets(page, frames)
  const main = frames.find((f) => f.isMain) || frames[0]
  const mOff = offs.get(media.frameId) || { x: 0, y: 0 }
  const found = []
  for (const f of frames) {
    const off = offs.get(f.id) || { x: 0, y: 0 }
    const r = await page.evalInFrame(f.id, MARK_EXPR).catch(() => null)
    if (!r || !Array.isArray(r.marks) || !r.marks.length) continue
    // ⚠️ 别自己再加"子窗口里套的那层 iframe"的偏移：frameRects() 给的已经是**页面坐标**，
    //    嵌套的偏移它算进去了。实测多补一次会让标记整体下移一整层（664 → 684），
    //    那正好是"配上一条相邻条目"的错法 —— 所以这里只用窗口偏移，一次都不多补。
    for (const m of r.marks) {
      // ⚠️ status **必须带回来**（页面里判好的那个）。
      //    丢过它一次，后果是每个标记都按"未完成"渲染、markChanged 永远是 false ——
      //    "报事实"变成"报假事实"，比不报还坏。
      found.push({ aria: String(m.aria || '').slice(0, 60), status: m.status === 'done' ? 'done' : (m.status === 'undone' ? 'undone' : null),
                   text: String(m.text || '').slice(0, 40), y: num(m.y, 0) + off.y, frame: f.label })
    }
  }
  if (!found.length) return null
  // 媒体自己所在的窗口；主窗口就是那个顶层窗口
  const isMain = main && media.frameId === main.id
  // "这个媒体的标记" = 它上方最近的那个。判据：标记在媒体区顶部之上、且不高于它 1600px
  // （页面很长时，上一个条目的标记也在上面 —— 加个距离上限免得配到别人的）
  const above = found
    .map((m) => ({ ...m, d: num(mOff.y, 0) - m.y }))
    .filter((m) => m.d >= -400 && m.d <= 1600)
    .sort((a, b) => a.d - b.d)
  if (above.length) return above[0]
  // 兜底：媒体窗口自己里面的标记（同窗口判定，不算"跨窗口猜"）；实在没有才返回 null
  const same = found.filter((m) => isMain || m.frame === media.frameLabel)
  return same.length ? same[0] : null
}

/** 页面里找"完成/未完成"这类标记：**只信 aria-label**（实测已完成/未完成的 class 一模一样）， */
/** 位置用页面坐标：窗口偏移（Node 侧加）+ 元素局部坐标。 */
const MARK_EXPR = String.raw`(() => {
  const num0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  // 只认"完成 / 未完成"这一族说法，而且**用词是通用的**（中文 + 英文），不认任何站点结构。
  // ⚠️ 顺序要紧：先判"未"，再判"完成" —— 否则「未完成」会被当成「完成」，
  //    于是「未完成」被报成「已完成」，正好把事实说反。
  // 实测：已完成和未完成的 class **一模一样**（都是 ans-job-icon …），
  // 按 class 判断必然双向出错 —— 所以这里**不许读 class**，只有 aria-label 可信。
  const cls = (a) => {
    if (!a) return null;
    const t = String(a);
    if (/未完成|没完成|未通过|未读|未看|not\s*(done|complete|finished)|incomplete|unfinished|undone|todo|pending|in\s*progress/i.test(t)) return 'undone';
    if (/已完成|完成|已通过|已读|已看|done|complete|finished/i.test(t)) return 'done';
    return null;
  };
  const marks = [];
  for (const e of document.querySelectorAll('[aria-label]')) {
    const aria = e.getAttribute('aria-label') || '';
    const st = cls(aria);
    if (!st) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;          // 看不见的不算
    let s; try { s = getComputedStyle(e) } catch (err) { s = null }
    if (s && (s.display === 'none' || s.visibility === 'hidden')) continue;
    marks.push({ aria, status: st, x: Math.round(r.left + r.width / 2), y: Math.round(r.top),
                 text: String(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) });
  }
  // 同一个元素上的外层容器也带 aria-label 时会重复计数 —— 按坐标去重
  const dedup = [];
  for (const m of marks) if (!dedup.some((d) => Math.abs(d.y - m.y) < 4 && d.aria === m.aria)) dedup.push(m);
  return { marks: dedup, vw: innerWidth, vh: innerHeight };
})()`

/**
 * 标记的状态：优先用页面侧判好的 status；万一没有，就从 aria 文字兜底再判一次。
 * ⚠️ 顺序和页面里那段**必须一样**：先判"未"，再判"完成" —— 反了就会把「未完成」读成「已完成」。
 * 判不出来就返回 null（**不许默认成"未完成"**：那是把"不知道"报成了事实）。
 */
const MARK_UNDONE = /未完成|没完成|未通过|未读|未看|not\s*(done|complete|finished)|incomplete|unfinished|undone|todo|pending|in\s*progress/i
const MARK_DONE = /已完成|完成|已通过|已读|已看|done|complete|finished/i
function markStatus(m) {
  if (!m) return null
  if (m.status === 'done' || m.status === 'undone') return m.status
  const t = String(m.aria || '')
  if (!t) return null
  if (MARK_UNDONE.test(t)) return 'undone'
  if (MARK_DONE.test(t)) return 'done'
  return null
}

/** 标记 → 短说法（"这个标记现在是什么"，只有事实，不带解释；判不出来就 null） */
const markTerm = (m) => {
  const s = markStatus(m)
  return s ? `任务点${s === 'done' ? '已完成' : '未完成'}` : null
}

/** 标记 → 给模型看的那句话（null = 读不到，**不许猜**） */
const markLabel = (m) => (m ? `${markTerm(m) || '标记'}（${clip(m.aria, 30)}）` : null)

/**
 * 倍速的四种走法（见函数头注释）。
 * → { notes(追加), rateEnforced }
 *   · 没给 rate（null）：谁改都不纠；把改动记进 rateEvents。
 *   · 给了 rate：被改就纠回；纠满 2 次还变 → rateEnforced:false（**但不打断播放**）。
 *   · > 8x：离谱值 → 交给主循环报 RATE_CHANGED 停下问一句。
 */
function ratePolicyNotes(rate, rateChanges) {
  const notes = []
  if (!rateChanges.length) return { notes, rateEnforced: rate != null ? true : null }
  const list = rateChanges.map((e) => `${e.from ?? '?'}x→${e.to}x`).join('、')
  if (rate == null) {
    // 默认情况：**我们没要求钉死** —— 只如实报告，绝不打断
    notes.push(`播放速度被改过（${list}）。这不是我们改的，我们**没有**强行纠回 —— `
      + '如果是你手动改的，那不用管；如果你希望钉死在某个速度，告诉我，我带 rate 再来一次。')
    return { notes, rateEnforced: null }
  }
  const gaveUp = rateChanges.some((e) => e.corrections >= 2)
  if (gaveUp) {
    notes.push(`我已经把速度纠回 ${rate}x 两次了，它又被改成别的（${list}）—— 有人在动这个播放器，`
      + '我不再纠了（rateEnforced:false），播放继续，你自己决定要不要停下来看看。')
    return { notes, rateEnforced: false }
  }
  notes.push(`播放速度被改成别的（${list}），已纠回 ${rate}x（你要求的）`)
  return { notes, rateEnforced: true }
}

export async function playMedia(page, { maxSeconds = null, stallSeconds = 25, rate = null } = {}) {
  // ── 参数归一化（**不给 maxSeconds 就用视频自己的长度算**，不让调用方猜时间）────
  const autoCeiling = (dur) => Math.round(num(dur, 0) * 1.15 + 90)
  let maxS = (maxSeconds === null || maxSeconds === undefined || maxSeconds === '') ? null : num(maxSeconds, NaN)
  if (maxS !== null && (!Number.isFinite(maxS) || maxS <= 0)) {
    throw argErr(`maxSeconds 只能是正数（秒），收到 ${JSON.stringify(maxSeconds)} —— 不给的话我自己按视频长度算`)
  }
  const stallS = Math.max(5, num(stallSeconds, 25))
  const wantRate = (rate === null || rate === undefined || rate === '') ? null : num(rate, NaN)
  if (wantRate !== null && (!Number.isFinite(wantRate) || wantRate <= 0)) {
    throw argErr(`rate 只能是正数，收到 ${JSON.stringify(rate)}`)
  }

  if (PLAYING) throw fail('BUSY', '上一个播放守护还在跑 —— 等它结束再叫（同一时刻只许有一个，铁律：严格串行）', { category: 'TOOL' })
  PLAYING = true
  const started = Date.now()
  const notes = []
  const rateChanges = []            // [{ at, from, to, corrections }]
  let rateNow = null
  let rateEnforced = wantRate != null ? true : null
  let timedOut = false

  // —— 收尾：播之后读一次标记，**只报事实**（变没变照读，不下结论）——
  //
  //   markChanged 的判法：**前后都读到、而且两次的状态都判得出来**才给，否则一律 null。
  //     true  两次都读到了，状态不一样 → 标记变了
  //     false 两次都读到了，状态一样   → 标记没变（"没变"是事实，不是"失败"）
  //     null  没有都读到，或者状态判不出来 → 如实说"不知道"，**绝不猜**
  //           （把"读不到"报成"没完成"，正是上一轮骗到模型的错法）
  const finish = async (reason, fields, media) => {
    const after = media ? await readMediaMark(page, media).catch(() => null) : null
    const before = fields.markBefore ?? null
    const bs = markStatus(before)
    const as = markStatus(after)
    const markChanged = (bs && as) ? (bs !== as) : null
    // ★ 基调：正常播完就该算完成 —— 标记有就读出来，别一惊一乍。
    //   只有"播完了、标记却还是未完成"才补一句，而且是**确认一下**的语气，不是断言没记上；
    //   被中断时本来就没播完（fields.finished=false），这句不掺和，免得把两件事说混。
    if (fields.finished && markChanged === false && as === 'undone') {
      notes.push(`标记还是「${markTerm(after)}」。正常播完就该算完成 —— 刷新看一眼；`
        + '还不算，再想办法（换个方式播 / 记下来交给用户）。')
    } else if (markChanged === true) {
      notes.push(`任务点标记变了：播之前是「${markTerm(before) || markLabel(before)}」，现在是「${markTerm(after) || markLabel(after)}」`)
    } else if (!after) {
      notes.push((fields.finished ? '播完了，但' : '没能播到底，而且')
        + '读不到这个媒体的任务点标记（没有、被隐藏、或者结构不认识）—— 读不到就是 null，不猜。')
    }
    const rp = ratePolicyNotes(wantRate, rateChanges)
    for (const n of rp.notes) notes.push(n)
    if (rateEnforced !== false && rp.rateEnforced === false) rateEnforced = false
    return {
      kind: fields.kind, playedSeconds: round1(fields.playedSeconds), durationSeconds: fields.durationSeconds ?? null,
      finished: !!fields.finished, reason,
      markBefore: markLabel(before), markAfter: markLabel(after), markChanged,
      rateNow: rateNow ?? null,
      rateEvents: rateChanges.map((e) => ({ at: e.at, from: e.from, to: e.to })),
      rateEnforced,
      ...(fields.progressRatio != null ? { progressRatio: fields.progressRatio } : {}),
      ...(fields.blocked ? { blocked: fields.blocked } : {}),
      notes,
      changed: fields.finished
        ? `播完了（${round1(fields.playedSeconds)} 秒 / 共 ${fields.durationSeconds ? round1(fields.durationSeconds) : '?'} 秒）`
          + (after ? `，任务点标记现在是「${markTerm(after)}」` : '')
        : (fields.changed ?? null),
      frame: fields.frame,
      ...(fields.media ? { media: fields.media } : {}),
    }
  }

  try {
    const frames0 = await rememberMainId(page)
    const mainId = frames0[0] ? frames0[0].id : null
    const fname = (fid) => (fid && mainId && fid !== mainId ? '子窗口' : '主页面')
    const media = await findMedia(page)
    if (!media) {
      return { kind: null, playedSeconds: 0, durationSeconds: null, finished: false, reason: 'NO_MEDIA',
               markBefore: null, markAfter: null, markChanged: null,
               rateNow: null, rateEvents: [], rateEnforced,
               notes: ['这一页没有任何 <video>/<audio>，或者它还没加载出地址'], changed: null }
    }
    const pre = media.state

    // 播之前读一次"这个媒体的任务点标记"（读不到就 null）
    const before = await readMediaMark(page, media).catch(() => null)
    const baseFields = { kind: pre.kind, durationSeconds: pre.duration ?? null, frame: fname(media.frameId), markBefore: before }
    // ⚠️ rateNow 只报**我们实际观察/设置到的值**，不拿"开播前读到的那一个"冒充：
    //    开播前那次读到的可能是页面残留的旧速度，拿它当"现在是多少"就是报了个假事实。
    rateNow = null
    notes.push(before
      ? `播之前，这个媒体的任务点标记是「${markLabel(before)}」`
      : '播之前读不到这个媒体的任务点标记（读不到就是 null，我不猜）')

    // 一开始就已经播完 → 不要再碰它（免得 play() 把它从头再放一遍），如实报事实
    if (pre.ended || (pre.duration && pre.currentTime >= pre.duration - 0.5 && !pre.paused)) {
      notes.push(pre.ended ? '一开始读到的就是"已经播完"（ended=true）' : '一开始读到的就已经在末尾了')
      // 这个是"我们读到的当前速度"，不是我们设的 —— 如实报出去
      rateNow = pre.playbackRate != null ? pre.playbackRate : null
      return await finish('FINISHED', { ...baseFields, playedSeconds: pre.currentTime, finished: true,
        progressRatio: pre.duration ? Number((pre.currentTime / pre.duration).toFixed(3)) : null,
        media: { src: clip(pre.src, 80) } }, media)
    }

    // ── 开播：按不按用户要求钉速度，都在**起播这一刻**先设一次 ──────────────
    const began = await startPlayback(page, media, wantRate == null ? 1 : wantRate)
    if (!began.ok) {
      const blockers = await checkBlockers(page, media)
      if (blockers.n) {
        notes.push(`播放按不动，而且屏幕上有个东西挡着（盖住约 ${blockers.first.cover}%）：${clip(blockers.first.text, 60) || blockers.first.cls}`)
        return await finish('USER_INTERACTION', { ...baseFields, playedSeconds: pre.currentTime, finished: false,
          blocked: blockers.first, changed: null }, media)
      }
      notes.push(`媒体元素在，但按了播放也播不起来：${began.why || began.how || '未知'}${began.playError ? '；' + began.playError : ''} —— 截图看看是不是要先点一下页面别的什么地方`)
      return await finish('NO_MEDIA', { ...baseFields, playedSeconds: pre.currentTime, finished: false, changed: null }, media)
    }
    notes.push(`开始播放（${began.how}）${wantRate == null ? '，起播速度设成 1x（我们的底线）' : `，起播速度设成你要求的 ${wantRate}x`}`)
    await sleep(600)

    // 上限：不给 maxSeconds 就**按读到的时长自动算**；确实读不到时长才退到"绝对保险丝"
    let limit = maxS
    const dur0 = pre.duration ?? null
    if (limit == null && dur0) {
      limit = autoCeiling(dur0)
      notes.push(`你没给 maxSeconds —— 按视频长度自己算：（${round1(dur0)} 秒 × 1.15 + 90）≈ ${limit} 秒`)
    }
    let limitKind = limit == null ? 'stall' : 'auto'
    if (limit == null) limit = 3600      // 连时长都读不到时的绝对保险丝（1 小时）

    let duration = dur0
    let lastTime = -1
    let lastAdvanceAt = Date.now()
    let sawProgress = false
    let startedPlayingAt = 0
    let firstProgressDeadline = 0
    let pausedSince = 0
    let resumeJumps = 0
    let rateCorrections = 0

    for (;;) {
      // ① 上限（每一跳都重算：时长可能是开播之后才读出来的，读出来就换成"按它算"）
      const elapsed = Date.now() - started
      if (maxS == null && duration && limitKind === 'stall') { limit = autoCeiling(duration); limitKind = 'auto' }
      if (elapsed > limit * 1000) {
        timedOut = true
        notes.push(maxS == null
          ? `守到 ${Math.round(elapsed / 1000)} 秒还没播完（上限是按视频长度算的 ${limit} 秒）—— 可以再叫一次接着守`
          : `守到 ${Math.round(elapsed / 1000)} 秒还没播完（你给的 maxSeconds=${maxS}）—— 可以再叫一次接着守`)
        const st = await readMediaState(page, media)
        const dur = (st && st.duration) || duration
        return await finish('TIMEOUT', { ...baseFields, kind: (st && st.kind) || pre.kind,
          playedSeconds: st ? st.currentTime : lastTime, durationSeconds: dur ?? null, finished: false,
          progressRatio: st && dur ? Number((st.currentTime / dur).toFixed(3)) : null, changed: null }, media)
      }

      const st = await readMediaState(page, media)
      if (!st) {
        notes.push('播放中，这个媒体元素从页面上消失了（页面被刷新/换页了？）')
        return await finish('NO_MEDIA', { ...baseFields, playedSeconds: lastTime > 0 ? lastTime : 0, finished: false, changed: null }, media)
      }
      if (!duration && st.duration) duration = st.duration
      const dur = st.duration || duration
      const rate = st.playbackRate != null ? st.playbackRate : null
      if (rate != null) rateNow = rate

      // ② 报错 / 起不来（读得到事实才报，绝不把"慢"当"错"）
      if (st.error) {
        notes.push(`播放器自己报了错：${clip(st.error, 80)}`)
        return await finish('MEDIA_ERROR', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, changed: null }, media)
      }

      // ③ 被暂停：**持续 > 3 秒**才返回（我们自己按了播放，短暂 paused 是正常的握手过程）
      if (!st.ended && st.paused && !st.seeking) {
        if (!pausedSince) {
          pausedSince = Date.now()
          notes.push(`发现被暂停了（currentTime 停在 ${round1(st.currentTime)}s）—— 先看着，超过 3 秒算真被暂停`)
        } else if (Date.now() - pausedSince > 3000) {
          const blockers = await checkBlockers(page, media)
          if (blockers.n) {
            notes.push(`被暂停，而且屏幕上有个东西挡着（盖住约 ${blockers.first.cover}%）：${clip(blockers.first.text, 60) || blockers.first.cls} —— 我没碰它，要不要关掉你自己定`)
            return await finish('USER_INTERACTION', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, blocked: blockers.first, changed: null }, media)
          }
          notes.push(`被暂停超过 3 秒（停在 ${round1(st.currentTime)}s，页面自己没恢复）—— 有人在动这个播放器，或者它需要人点一下`)
          return await finish('PAUSED', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, changed: null }, media)
        }
      } else {
        pausedSince = 0
      }

      // ④ 起不来：有地址、却没进展。给足宽限（≥90 秒或 3×stall）再判 —— 实测点了播放要几十秒才读得出时长
      if (!sawProgress) {
        if (!startedPlayingAt) startedPlayingAt = Date.now()
        if (!firstProgressDeadline) firstProgressDeadline = Math.max(90_000, stallS * 3000)
        if (Date.now() - startedPlayingAt > firstProgressDeadline) {
          notes.push(`按了播放 ${Math.round((Date.now() - startedPlayingAt) / 1000)} 秒，播放位置一直没往前走`
            + `（readyState=${st.readyState}，时长${dur ? '=' + round1(dur) + 's' : '读不出来'}）—— 它起不来，截图看看`)
          return await finish('MEDIA_ERROR', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, changed: null }, media)
        }
      }

      // ⑤ 播完了（正常路径：一直守到底才走到这里）
      if (st.ended || (dur && !st.paused && st.currentTime >= dur - 0.5)) {
        notes.push(st.ended ? '媒体自己报了 ended=true' : `读到 currentTime 到末尾了（${round1(st.currentTime)}s / ${round1(dur)}s）`)
        return await finish('FINISHED', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime,
          durationSeconds: dur ?? null, finished: true,
          progressRatio: dur ? Number((st.currentTime / dur).toFixed(3)) : null,
          rateNow: rate, media: { src: clip(st.src, 80) } }, media)
      }

      // ⑥ 还在加载 → 只等，什么判定都不做
      //    实测：点了播放后要几十秒才读得出 duration（readyState 0→4）。这期间 currentTime 恒为 0、
      //    paused 已经是 false —— 早先的实现会误报"长时间没有前进"，把一次正常加载判成故障。
      const loading = !(st.readyState >= 3) || !dur
      if (loading) {
        lastAdvanceAt = Date.now()
        lastTime = st.currentTime > 0 ? st.currentTime : lastTime
        await sleep(PLAY_TICK_MS)
        continue
      }
      sawProgress = true

      // ⑦ 倍速 —— **绝不因为倍速中断播放**（唯一例外是 > 8x 的离谱值）
      //
      //   wantRate == null（默认）：起播设过 1x 之后，**谁改都不纠**，只记进 rateEvents 如实报告。
      //   wantRate != null（用户要求）：被改成别的就纠回；同一视频纠满 2 次还变 → 不再纠，
      //                                 记 rateEnforced:false，**播放照继续**。
      const lastRate = rateChanges.length ? rateChanges[rateChanges.length - 1].to : null
      if (rate != null && lastRate == null && Math.abs(rate - (wantRate == null ? 1 : wantRate)) > 0.001) {
        // 第一次发现"不是我们设的那个值"
        if (rate > 8) {
          notes.push(`播放速度被改成了 ${rate}x —— 这么离谱的值不像是正常操作，我先停下问一句`)
          return await finish('RATE_CHANGED', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, rateNow: rate, changed: null }, media)
        }
        rateChanges.push({ at: Date.now(), from: wantRate == null ? 1 : wantRate, to: rate, corrections: 0 })
        if (wantRate != null) {
          await setPlaybackRate(page, media, wantRate)
          rateCorrections = 1
          rateChanges[0].corrections = 1
          lastAdvanceAt = Date.now()      // 纠速会短暂扰动，别把这一刻当成"卡住"
          notes.push(`速度被改成 ${rate}x（不是你要求的 ${wantRate}x），已纠回（第 1 次）`)
        }
        // wantRate == null：**不纠、不打断**。如实报在 rateEvents 里，继续守到底。
      } else if (rate != null && lastRate != null && Math.abs(rate - lastRate) > 0.001) {
        // 又被改了一次
        if (rate > 8) {
          notes.push(`播放速度被改成了 ${rate}x —— 这么离谱的值不像是正常操作，我先停下问一句`)
          return await finish('RATE_CHANGED', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, rateNow: rate, changed: null }, media)
        }
        rateChanges.push({ at: Date.now(), from: lastRate, to: rate, corrections: 0 })
        if (wantRate != null && rateCorrections < 2) {
          await setPlaybackRate(page, media, wantRate)
          rateCorrections += 1
          rateChanges[rateChanges.length - 1].corrections = rateCorrections
          lastAdvanceAt = Date.now()
          notes.push(`速度又被改成 ${rate}x，已纠回 ${wantRate}x（第 ${rateCorrections} 次）`)
        } else if (wantRate != null) {
          notes.push(`速度第三次被改成 ${rate}x —— 我不再纠了（rateEnforced:false），播放继续`)
        }
      }

      // ⑧ 往回跳 = 别人拖了进度条（我们从不写 currentTime）→ 停
      //    ⚠️ 规格原文把 SEEKED 写成"往回跳超过 2 秒"；我按**往回**实现。
      //       往前跳不打断（那是别人在帮它快进，不影响"播到底"）。
      if (lastTime >= 0 && st.currentTime < lastTime - 2) {
        notes.push(`进度被**往回**拖了（${round1(lastTime)}s → ${round1(st.currentTime)}s）—— 我从不碰进度条，是别人动的`)
        return await finish('SEEKED', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, rateNow: rate, changed: null }, media)
      }
      // 往前跳：记一笔、重新立基线，不打断（含播放器自己的断点续播）
      if (lastTime >= 0 && st.currentTime - lastTime > 3) {
        if (Date.now() - started < 90_000 && resumeJumps < 3) {
          resumeJumps += 1
          notes.push(`播放器自己做了断点续播：${round1(lastTime)}s → ${round1(st.currentTime)}s（正常行为，重新立基线）`)
        } else {
          notes.push(`进度往前跳了一截（${round1(lastTime)}s → ${round1(st.currentTime)}s）—— 不是我干的；不打断，继续守`)
        }
      }

      // 位置往前走了 → 重新开始计时（这是"没卡住"的唯一证据）
      const advanced = !(lastTime >= 0) || st.currentTime > lastTime + 0.2
      if (advanced) { lastTime = st.currentTime; lastAdvanceAt = Date.now() }

      // ⑨ 卡住：**位置真的不动**才算 —— 加载中/正在跳转（seeking）都不算
      if (!advanced && !st.paused && !st.seeking && st.readyState >= 3
          && Date.now() - lastAdvanceAt > stallS * 1000) {
        const blockers = await checkBlockers(page, media)
        if (blockers.n) {
          notes.push(`位置 ${Math.round(stallS)} 秒没动，而且屏幕上有个东西挡着（盖住约 ${blockers.first.cover}%）：${clip(blockers.first.text, 60) || blockers.first.cls}`)
          return await finish('USER_INTERACTION', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, blocked: blockers.first, rateNow: rate, changed: null }, media)
        }
        notes.push(`位置 ${Math.round(stallS)} 秒没往前走了（currentTime 停在 ${round1(st.currentTime)}s，播放器显示"在播"）—— 像是缓冲卡死，截图看一眼`)
        return await finish('STALLED', { ...baseFields, kind: st.kind, playedSeconds: st.currentTime, durationSeconds: dur ?? null, finished: false, rateNow: rate, changed: null }, media)
      }

      await sleep(PLAY_TICK_MS)
    }
  } finally {
    PLAYING = false
  }
}

const round1 = (v) => Math.round(num(v, 0) * 10) / 10

/**
 * 记住主窗口是谁。报告里要说清"这是主页面还是子窗口"，
 * 就得跟主窗口比 —— Page.getFrameTree 是从根开始走的，第一条就是主窗口。
 */
async function rememberMainId(page) {
  return safeFrames(page)
}

/** 跨窗口找媒体：谁有 <video>/<audio> 就是谁（不认 URL 里的字样，那是网站地图） */
async function findMedia(page) {
  const frames = await safeFrames(page)
  const found = []
  for (const f of frames) {
    const st = await page.evalInFrame(f.id, MEDIA_EXPR).catch(() => null)
    if (st) found.push({ frameId: f.id, frameUrl: f.url, state: st, rank: (st.usable ? 100 : 0) + (st.paused ? 0 : 50) + Math.min(49, st.area / 1000) })
  }
  if (!found.length) return null
  found.sort((a, b) => b.rank - a.rank)
  const best = found[0]
  if (!best.state.usable) return null
  // 给"要守的那个媒体"打个记号：后面每一跳都读同一个元素（页面里有两个播放器时不会串）
  await page.evalInFrame(best.frameId, `(() => {
    const v = document.querySelector('video,audio');
    if (v) v.setAttribute('data-dsh-hand', 'media');
    return true;
  })()`).catch(() => null)
  return best
}

/** 一个窗口里的媒体状态（优先读我们打了记号的那个） */
const MEDIA_EXPR = String.raw`(() => {
  const els = [...document.querySelectorAll('video,audio')];
  if (!els.length) return null;
  const usable = (e) => !!(e.currentSrc || e.src || e.readyState > 0 || (Number.isFinite(e.duration) && e.duration > 0) || e.querySelector('source'));
  const r0 = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) } };
  const marked = document.querySelector('[data-dsh-hand="media"]');
  let v = (marked && els.indexOf(marked) >= 0) ? marked : null;
  if (!v) {
    const pool = els.filter(usable);
    const list = pool.length ? pool : els;
    list.sort((a, b) => {
      const sa = (a.paused ? 0 : 1e9) + (a.currentTime > 0 ? 1e6 : 0) + (() => { const r = a.getBoundingClientRect(); return r.width * r.height })();
      const sb = (b.paused ? 0 : 1e9) + (b.currentTime > 0 ? 1e6 : 0) + (() => { const r = b.getBoundingClientRect(); return r.width * r.height })();
      return sb - sa;
    });
    v = list[0];
  }
  if (!v) return null;
  const rr = r0(v);
  return {
    kind: v.tagName === 'VIDEO' ? 'video' : 'audio',
    src: String(v.currentSrc || v.src || (v.querySelector('source') ? v.querySelector('source').src : '') || '').slice(0, 300),
    usable: usable(v),
    currentTime: Number(v.currentTime) || 0,
    duration: Number.isFinite(v.duration) ? Number(v.duration) : null,
    paused: !!v.paused,
    ended: !!v.ended,
    readyState: Number(v.readyState) || 0,
    // ★ 规格要求的"每 250ms 看一次"里那两个字段：
    //   seeking —— 正在跳转/缓冲（这期间 currentTime 不动，不能算"卡住"）
    //   error   —— 播放器自己的报错（MediaError.code/message），有它就如实报 MEDIA_ERROR
    seeking: !!v.seeking,
    error: v.error ? ('code=' + v.error.code + (v.error.message ? ' ' + String(v.error.message).slice(0, 60) : '')) : null,
    playbackRate: Number.isFinite(v.playbackRate) ? Number(v.playbackRate) : null,
    muted: !!v.muted,
    area: rr.w * rr.h,
    rect: rr,
    count: els.length,
  };
})()`

/** 读当前正在守的那个媒体（先读它原来那个窗口） */
async function readMediaState(page, media) {
  const frames = await safeFrames(page)
  const order = [media.frameId, ...frames.map((f) => f.id).filter((id) => id !== media.frameId)]
  for (const id of order) {
    const st = await page.evalInFrame(id, MEDIA_EXPR).catch(() => null)
    if (st) return st
  }
  return null
}

/**
 * 让媒体播起来 —— **一个明确动作**：先按播放器自己的大播放按钮（更像真人），
 * 按钮找不到才退回调 play()（那也是播放器自己的路径）。
 *
 * `wantRate`：**起播这一刻**要把速度设成多少。
 *   · 没给 rate 参数（默认）→ 1（我们自己的底线）
 *   · 用户明确要求倍速 → 用户那个值（之后被改才纠回去）
 * ⚠️ 这里**只设一次**，之后要不要纠由主循环按 rate 的四种走法决定。
 */
async function startPlayback(page, media, wantRate = 1) {
  const fid = media.frameId
  const isMain = fid === (await safeFrames(page))[0]?.id
  const R = num(wantRate, 1)

  // ① 播放器自己的大播放按钮（videojs 等一票播放器的通用类名/无障碍名）
  const btn = await page.evalInFrame(fid, String.raw`(() => {
    const v = document.querySelector('[data-dsh-hand="media"]') || document.querySelector('video,audio');
    if (v && !v.paused) return null;
    const cand = [...document.querySelectorAll('.vjs-big-play-button,[class*=big-play],[class*=bigPlay],[class*=play-btn],[class*=playBtn],[class*=audio-play],[aria-label*=play i],[title*=play i],[data-action=play]')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 });
    if (!cand.length) return null;
    const e = cand[0];
    const r = e.getBoundingClientRect();
    e.setAttribute('data-dsh-hand', 'playbtn');
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`).catch(() => null)

  if (btn) {
    // 主窗口 → 真鼠标点它；子窗口 → 只能在它自己的窗口里点（坐标系不同）
    if (isMain) await page.clickAt(btn.x, btn.y).catch(() => null)
    else await clickInFrame(page, fid, 'playbtn').catch(() => null)
    await sleep(800)
    const st = await readMediaState(page, media)
    if (st && !st.paused) { await setPlaybackRate(page, media, R); return { ok: true, how: '点播放按钮' } }
  }

  // ② 退回：调播放器自己的 play()（CDP 的 userGesture 算用户手势，不会被自动播放策略拦）
  const r = await page.evalInFrame(fid, `(() => {
    const v = document.querySelector('[data-dsh-hand="media"]') || document.querySelector('video,audio');
    if (!v) return { ok: false, why: 'no-media' };
    let err = null;
    try { const p = v.play(); if (p && p.catch) p.catch((e) => { err = String(e && e.message || e).slice(0, 100) }); }
    catch (e) { err = String(e && e.message || e).slice(0, 100) }
    v.playbackRate = ${R};
    return { ok: true, playError: err };
  })()`).catch((e) => ({ ok: false, why: String(e && e.message || e).slice(0, 120) }))
  await sleep(1200)
  const st = await readMediaState(page, media)
  if (st && !st.paused) return { ok: true, how: 'js-play' }
  return { ok: false, how: 'js-play', why: 'play() 之后仍然是暂停状态', playError: r && r.playError }
}

/** 把速度设成 R（起播 / 纠回都用它）。只写 playbackRate —— 不碰进度、不碰别的。 */
async function setPlaybackRate(page, media, R) {
  return page.evalInFrame(media.frameId, `(() => {
    const v = document.querySelector('[data-dsh-hand="media"]') || document.querySelector('video,audio');
    if (v) v.playbackRate = ${num(R, 1)};
    return true;
  })()`).catch(() => null)
}

/**
 * 屏幕上有没有东西挡着（且压在最上层）。
 * 只在"媒体确实没在动"的时候才当成拦路 —— 播放时旁边飘个提示条不算事。
 * 判据三条一起看：够大、在最上层、里面没有播放器自己。
 */
async function checkBlockers(page, media) {
  const frames = await safeFrames(page)
  const ids = [frames[0] && frames[0].id, media && media.frameId].filter(Boolean)
  for (const id of [...new Set(ids)]) {
    const r = await page.evalInFrame(id, `(() => {
      const vw = innerWidth, vh = innerHeight;
      const cand = [...document.querySelectorAll('dialog[open],[role=dialog],[aria-modal=true],[class*=modal],[class*=Modal],[class*=mask],[class*=Mask],[class*=dialog],[class*=Dialog],[class*=popup],[class*=Popup],[class*=overlay],[class*=Overlay],[class*=layer]')];
      for (const e of cand) {
        if (e.querySelector('video,audio') || e.tagName === 'VIDEO' || e.tagName === 'AUDIO') continue;
        let s; try { s = getComputedStyle(e) } catch (err) { continue }
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) continue;
        if (r.width * r.height < vw * vh * 0.18) continue;
        const cx = Math.min(Math.max(Math.round(r.left + r.width / 2), 0), vw - 1);
        const cy = Math.min(Math.max(Math.round(r.top + r.height / 2), 0), vh - 1);
        const top = document.elementFromPoint(cx, cy);
        if (!top || !(e === top || e.contains(top) || top.contains(e))) continue;
        return { n: 1, first: { tag: e.tagName, cls: String(e.className || '').slice(0, 60),
          text: String(e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          cover: Math.round(100 * r.width * r.height / (vw * vh)) } };
      }
      return { n: 0, first: null };
    })()`).catch(() => null)
    if (r && r.n) return r
  }
  return { n: 0, first: null }
}

export default {
  clickLocator, pickOptions, writeInto, scrollPage, gotoUrl, goBack, reloadPage, playMedia,
}

// 内部记号名说明（给下一个改这个文件的人）：
//   data-dsh-hand 是**本文件专用**的记号，绝不参与任何对外的编号。
//   值是 f<帧号>a<区号>[o|i|x<项号>] / f<帧号>a<区号>w / hit / media / playbtn / scrollbox。
//   扫描时会先清掉自己上一轮留下的记号（只清 f 开头的），不影响眼睛标的 data-dsh-h 之类。
