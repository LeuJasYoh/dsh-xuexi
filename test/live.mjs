/**
 * test/live.mjs —— L2 fixture 测试台（真浏览器 + 真 CDP）
 *
 * 为什么单独立一个文件（不并进 test/run.mjs）：
 *   run.mjs 是**零副作用**的静态断言集（参数/闸门/表面/痕迹/装载），
 *   任何机器上都能跑。这一套要开真 chromium、绑真端口、留临时目录，
 *   属于"集成验证"：本机有浏览器才跑，没有就明说跳过（exit 0）。
 *
 * 覆盖（全部走**产品自己的代码路径**：index.js 的 16 个工具经 mock ctx
 * 真注册、真执行；几何/登录态走 lib 的真实现）：
 *   L1  eye_open    绑定 fixture 页（不导航、幂等）
 *   L2  eye_see     编号/顺序/选项/filled/签名 + ★ 报出的编号和 DOM 上挂的
 *                   必须是同一个（data-dsh-h 对拍）—— 这类错内部自洽、最难查
 *   L3  hand_click  按选项编号点 → DOM 真的选中（radio 互斥）
 *   L4  hand_pick   set 模式 → DOM 选中态符合
 *   L5  hand_write  写入 → DOM value 变化，eye_see 的 filled 跟着变
 *   L6  eye_shot    三问省图：没变不重烧 / force 照办 / 按编号裁剪（PNG 尺寸
 *                   对拍）/ embed:false 只落盘 / 坏编号明确报错
 *   L7  frameRects  跨域 iframe 的页面坐标矩形 + hitFrame 命中/落空
 *   L8  loginState  主窗口无登录 → false；跨域 iframe 里有密码框 → true 且
 *                   说清是哪个窗口（P0-2 回归：只扫主窗口会漏判）
 *   L9  socket 健康层（P0-1）：关掉浏览器 → isAlive false、onDead 广播、
 *                   之后的 send 立即 SOCKET_DEAD，不再无限挂起
 *   L10 findBrowserExe / launchBrowser 跨平台发现（E-9）
 *
 * 跑法：node test/live.mjs   （npm run test:live）
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const FIXTURE = join(ROOT, 'test', 'fixture')

const B = await import('../lib/browser.mjs')
const SEE = await import('../lib/see.mjs')
const NT = await import('../lib/note.mjs')

// ── 断言小框架（和 run.mjs 一个风格） ────────────────────────────────────────
let pass = 0
const fails = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fails.push(`${name}\n      ${String(e?.message ?? e).split('\n')[0]}`)
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`)
  }
}
const ta = (cond, extra = '') => { if (!cond) throw new Error(extra || '断言不成立') }
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ?? ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`) }

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

/** 静态服务器：serves test/fixture，并把 __FRAME_ORIGIN__ 换成另一个源 */
function startStaticServer(port, frameOrigin) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    const file = join(FIXTURE, urlPath === '/' ? 'main.html' : urlPath)
    // 防穿越：规范化后必须还在 fixture 目录里
    if (!file.startsWith(FIXTURE) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    let body = readFileSync(file)
    if (extname(file) === '.html') {
      body = Buffer.from(body.toString('utf8').replaceAll('__FRAME_ORIGIN__', frameOrigin), 'utf8')
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/** PNG 头部读宽高（IHDR：偏移 16/20，大端 uint32）—— 用来验证裁剪真的截到了那一处 */
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) })

// ══ 没有浏览器就整体跳过（exit 0，明说原因） ═══════════════════════════════
const found = B.findBrowserExe()
if (!found) {
  console.log('— L2 fixture 测试台：本机没找到 Chrome/Edge/Chromium，跳过。')
  console.log('  （安装任意一个，或用 DSH_BROWSER_PATH 指定可执行文件路径）')
  process.exit(0)
}

console.log(`\nL2 fixture 测试台（${found.exe}，经 ${found.via} 发现）\n${'─'.repeat(60)}`)

// ── 端口与目录 ──────────────────────────────────────────────────────────────
const [portMain, portFrame, cdpPort, cdpPort2] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
const originMain = `http://127.0.0.1:${portMain}`
const originFrame = `http://127.0.0.1:${portFrame}`
const mainUrl = `${originMain}/main.html`
const frameUrl = `${originFrame}/frame.html`
const framesUrl = `${originMain}/frames.html`

const srvMain = await startStaticServer(portMain, originFrame)
const srvFrame = await startStaticServer(portFrame, originFrame)
const tmpWork = mkdtempSync(join(tmpdir(), 'dsh-live-work-'))
const profile = mkdtempSync(join(tmpdir(), 'dsh-live-profile-'))

// ── 起 chromium（headless；root 下必须 --no-sandbox）────────────────────────
const proc = spawn(found.exe, [
  '--headless=new',
  '--no-sandbox',                 // 容器/root 环境必需；产品路径由用户环境决定
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--window-size=800,600',
  `--remote-debugging-port=${cdpPort}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  'about:blank',
], { detached: true, stdio: 'ignore' })
proc.unref?.()

let browser = null
const cdpDeadline = Date.now() + 20_000
while (Date.now() < cdpDeadline) {
  try { browser = await B.connectBrowser(cdpPort); break } catch { await sleep(300) }
}
if (!browser) {
  console.log('— chromium 起了但调试端口 20s 没就绪，跳过（环境问题，不是代码问题）。')
  try { proc.kill('SIGKILL') } catch { /* 无所谓 */ }
  srvMain.close(); srvFrame.close()
  rmSync(tmpWork, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
  process.exit(0)
}

// 把浏览器自带的 about:blank 标签页导航到 fixture 主页（工具随后会绑定它）
{
  const nav = await B.attachToPage(browser)
  await nav.goto(mainUrl)
  await nav.close()
}

// ── 给产品代码种上"工作区状态"：端口 + profile 指向我们起的这个浏览器 ────────
const outDir = NT.resolveOutputDir(tmpWork)          // == index.js applyOutputDir 会算出的目录
NT.setOutputDir(outDir)
NT.saveState({ version: 2, browser: { port: cdpPort, profileDir: profile, workTargetId: null }, current: null, done: [], pending: [] })

// ── 照 DSH 的规矩真装载一次插件（mock ctx，见 run.mjs F 组同款） ────────────
const registered = []
const savedImages = []
const services = {
  tools: { register: (d) => registered.push(d) },
  attachments: {
    saveImage: async (img) => {
      savedImages.push(img)
      return { attachmentId: `att-${savedImages.length}`, mediaType: img.mediaType, bytes: img.data.length }
    },
  },
  systemPrompt: { section: () => () => {} },
  sessions: { get: () => ({ header: { cwd: tmpWork } }) },   // applyOutputDir 靠它定位工作区
}
const ctx = new Proxy(services, {
  get(t, k) {
    if (k === 'get') return (n) => (n in t ? t[n] : undefined)
    if (k === 'effect') return (fn) => { fn(); return () => {} }
    if (k === 'logger') return { warn() {} }
    if (!(k in t)) throw new Error(`cannot get property "${String(k)}" without inject`)
    return t[k]
  },
})
const mod = await import('../index.js')
const plugin = mod.default ?? mod
await plugin.apply(ctx, {})

const call = async (name, args = {}) => {
  const def = registered.find((d) => d.name === name)
  if (!def) throw new Error(`工具没注册: ${name}`)
  return def.execute(args, { agent: { id: 'live-test-agent' } })
}

// 自己留一条 CDP 连接：几何/登录态/socket 死亡的断言直接打底层，
// 不经过 session（session 归 index.js 管，harness 不碰它的内部状态）。
const geo = await B.connectBrowser(cdpPort)
let geoTargetId = null
/** 把「session 绑着的那个标签页」导航到 url，再附上它返回页面句柄。
 *  已在目标页就**不导航** —— 导航会重载页面，把 eye_see 挂的编号标记全冲掉。 */
const geoGoto = async (url) => {
  const p = geoTargetId
    ? await B.attachToPage(geo, { targetId: geoTargetId })
    : await B.attachToPage(geo, { match: 'main.html' })
  geoTargetId = p.targetId
  const cur = await p.eval('location.href').catch(() => null)
  if (cur !== url) await p.goto(url)
  return p
}

// ═══════════════════════════════════════════════════════════════════════════
// L1 eye_open：绑上 fixture 页，不导航它
// ═══════════════════════════════════════════════════════════════════════════
await t('L1 eye_open 绑到 fixture 主页（没导航、幂等）', async () => {
  const r = await call('eye_open')
  eq(r.ok, true, 'eye_open 应成功')
  ta(String(r.url).endsWith('/main.html'), `url 应是 main.html，实际 ${r.url}`)
  eq(r.loggedIn, true, 'fixture 主页没有登录要素，应判"已登录"')
  ta(Array.isArray(r.tabs) && r.tabs.some((x) => String(x.url).endsWith('/main.html')), 'tabs 里应有这一页')
  const r2 = await call('eye_open')
  eq(r2.url, r.url, '第二次 eye_open 应绑同一页（幂等）')
})

// ═══════════════════════════════════════════════════════════════════════════
// L2 eye_see：编号 / 顺序 / 选项 / filled / 签名 + DOM 对拍
// ═══════════════════════════════════════════════════════════════════════════
let areas = null
await t('L2 eye_see：五处、顺序从上到下、类型与 filled 符合 fixture', async () => {
  const r = await call('eye_see')
  eq(r.ok, true)
  areas = r.areas ?? []
  eq(areas.length, 5, `应报 5 处，实际 ${areas.length}: ${areas.map((a) => a.kind).join(',')}`)
  eq(areas.map((a) => a.kind).join(','), 'pick,pick,pick,write,button', '屏幕顺序应是 单选→下拉→多选→写→按钮')
  // 编号与顺序是两件事：g 按认领次序（先所有 radio/checkbox，再 select…），
  // 数组按屏幕位置。所以第 2 处（下拉）的编号后缀不该是 1。
  ta(areas[0].options.length === 3, '第一处 3 个选项')
  eq(areas[0].filled.join(), 'B', '第一处现在选 B')
  eq(areas[0].options.map((o) => o.selected).join(), 'false,true,false')
  eq(areas[1].options.length, 3, '下拉 3 个选项')
  eq(areas[1].filled.length, 1, '下拉选中 1 项')
  ta(areas[1].options.some((o) => o.selected && /X/.test(o.text)), '选中的应是 X 项')
  eq(areas[2].filled.length, 0, '多选一处都没选')
  eq(areas[3].kind, 'write')
  eq(areas[3].filled, '', '文本域是空的')
  ta(!!areas[4].label.includes('提交'), '按钮是「提交」')
  ta(typeof r.counts === 'object' && r.counts.pick === 3 && r.counts.write === 1 && r.counts.button === 1, 'counts 对')
})

await t('L2b ★ 报出的编号和 DOM 上挂的是同一个（data-dsh-h 对拍）', async () => {
  // 这类错最难查：编号内部自洽，只有和 DOM 对照才看出来（点"提交"点到别的东西）。
  // 真实契约（按元素的"一处"语义）：
  //   · radio/checkbox 组：每个**选项**各带一个记号（组自己没有）
  //   · 原生 <select>：所有 option 共一个元素 → **区编号**挂在 <select> 上
  //     （逐个挂会被互相覆盖，模型按 o0/o1 点会静默点到最后一个选项）
  //   · write / button / media：区编号直接挂在元素上
  const gp = await geoGoto(mainUrl)
  const dom = await gp.eval(`(() => {
    const vals = [];
    for (const el of document.querySelectorAll('[data-dsh-h]')) vals.push(el.getAttribute('data-dsh-h'));
    return vals;
  })()`)
  const domSet = new Set(dom)
  for (const a of areas) {
    if (a.kind === 'pick') {
      const byOpts = (a.options || []).every((o) => domSet.has(o.i))
      const byArea = domSet.has(a.i)
      ta(byOpts || byArea, `pick 处 ${a.i}：要么每个选项有记号，要么区编号挂在元素上（实际 DOM: ${dom.join(' ')}）`)
    } else {
      ta(domSet.has(a.i), `${a.kind} ${a.i} 的编号应挂在元素上（实际 DOM: ${dom.join(' ')}）`)
    }
  }
  // 反向：DOM 上不该有"报了出去但树上没有"的多余编号
  const want = new Set()
  for (const a of areas) {
    want.add(a.i)
    for (const o of a.options || []) want.add(o.i)
  }
  for (const v of dom) ta(want.has(v), `DOM 上的 ${v} 应是报出去的编号`)
})

await t('L2c 编号与屏幕顺序分离（下拉在屏幕第 2、认领第 3）', async () => {
  // 认领次序：radio 组先（q1=0、q3=1），select 第二（q2=2），write=3，button=4。
  // 屏幕顺序：q1, q2(select), q3, q4, btn。所以 areas[1]（屏幕第 2）的编号后缀是 2。
  const suffix = (i) => String(i).split(':').pop()
  eq(suffix(areas[0].i), '0', 'q1 认领第 1')
  eq(suffix(areas[1].i), '2', '下拉认领第 3（屏幕第 2）—— 编号不跟着顺序走')
  eq(suffix(areas[2].i), '1', '多选认领第 2（屏幕第 3）')
})

// ═══════════════════════════════════════════════════════════════════════════
// L3 hand_click：按选项编号点，DOM 真的选中
// ═══════════════════════════════════════════════════════════════════════════
await t('L3 hand_click 按选项编号点中 radio（互斥生效）', async () => {
  const q1 = areas[0]
  const optA = q1.options[0]                       // 'A 选项甲'，当前未选
  eq(optA.selected, false)
  const r = await call('hand_click', { i: optA.i })
  eq(r.ok, true, `hand_click 应成功: ${JSON.stringify(r).slice(0, 200)}`)
  const gp = await geoGoto(mainUrl)
  const st = await gp.eval(`(() => ({
    a: document.querySelector('input[name=q1][value=A]').checked,
    b: document.querySelector('input[name=q1][value=B]').checked,
    c: document.querySelector('input[name=q1][value=C]').checked,
  }))()`)
  eq(st.a, true, '点了 A → A 选中')
  eq(st.b, false, 'radio 互斥 → B 取消')
  eq(st.c, false)
})

// ═══════════════════════════════════════════════════════════════════════════
// L4 hand_pick：set 模式整组重设
// ═══════════════════════════════════════════════════════════════════════════
await t('L4 hand_pick set：整组只留指定项', async () => {
  const q1 = areas[0]
  const r = await call('hand_pick', { area: { i: q1.i }, choose: [{ i: q1.options[2].i }], mode: 'set' })
  eq(r.ok, true, `hand_pick 应成功: ${JSON.stringify(r).slice(0, 300)}`)
  ta(r.picked?.[0]?.now === true, '回报应确认选中了')
  const gp = await geoGoto(mainUrl)
  const st = await gp.eval(`(() => ({
    a: document.querySelector('input[name=q1][value=A]').checked,
    c: document.querySelector('input[name=q1][value=C]').checked,
  }))()`)
  eq(st.a, false, 'set 模式 → A 取消')
  eq(st.c, true, 'C 选中')
})

await t('L4b hand_pick 下拉：模型照抄的完整选项编号也要解析得对', async () => {
  // 背景：原生 <select> 的所有 option 共一个元素 —— 记号只能挂区编号（见 see.mjs
  // addOpts 的 sameEl 分支）。这条锁住"照抄 eye_see 的选项编号 → 选到正确项"。
  const fresh = await call('eye_see')
  // 区分下拉与单选：工具回报的 area 不带 groupTag，选项 label 又被压成单字母
  // （'Y'/'A' 分不清），只有 text 保留全文 —— 用 fixture 里独有的「Y 项」认。
  // （q1 单选也是 3 个选项，拿 options.length 猜会认错组。）
  const sel = (fresh.areas ?? []).find((a) => a.kind === 'pick'
    && (a.options || []).some((o) => /^Y\s*项$/.test(String(o.text || ''))))
  ta(!!sel, '应看得到下拉那一处')
  ta(sel.options.length === 3, `下拉应有 3 项，实际 ${sel.options?.length}`)
  const optY = sel.options[1]                    // 'Y 项'（X 当前选中）
  ta(!optY.selected, 'Y 项初始不应选中')
  const r = await call('hand_pick', { area: { i: sel.i }, choose: [{ i: optY.i }], mode: 'set' })
  eq(r.ok, true, `hand_pick 应成功: ${JSON.stringify(r).slice(0, 300)}`)
  eq(r.rejected?.length ?? 0, 0, `不该有被拒的选项: ${JSON.stringify(r.rejected)}`)
  ta(r.picked?.[0]?.now === true, '回报应确认选中了')
  const gp = await geoGoto(mainUrl)
  const v = await gp.eval(`document.querySelector('select[name=q2]').value`)
  eq(v, 'y', `DOM 里选中的应是 y，实际 ${v}`)
})

// ═══════════════════════════════════════════════════════════════════════════
// L5 hand_write：写入并回读
// ═══════════════════════════════════════════════════════════════════════════
const WRITE_TEXT = '实践是检验真理的唯一标准'
await t('L5 hand_write 写入文本域，eye_see 的 filled 跟着变', async () => {
  const q4 = areas[3]
  const r = await call('hand_write', { area: { i: q4.i }, text: WRITE_TEXT })
  eq(r.ok, true, `hand_write 应成功: ${JSON.stringify(r).slice(0, 200)}`)
  const gp = await geoGoto(mainUrl)
  const v = await gp.eval(`document.querySelector('textarea[name=q4]').value`)
  eq(v, WRITE_TEXT)
  const r2 = await call('eye_see')
  const q4b = (r2.areas ?? []).find((a) => a.kind === 'write')
  eq(q4b.filled, WRITE_TEXT, 'eye_see 应读到新写入的文字')
})

// ═══════════════════════════════════════════════════════════════════════════
// L6 eye_shot：三问省图
// ═══════════════════════════════════════════════════════════════════════════
await t('L6a eye_shot：页面没变 → 不重烧（skipped/unchanged）', async () => {
  const r = await call('eye_shot')
  eq(r.skipped, true, '刚 eye_see 过、页面没动 → 应跳过')
  eq(r.unchanged, true)
  eq(r.file, null)
})

await t('L6b eye_shot({force:true})：确实要就照办，图真的落盘且嵌回', async () => {
  const r = await call('eye_shot', { force: true })
  eq(r.ok, true)
  eq(r.skipped, undefined, 'force 不该被跳过')
  ta(r.bytes > 1000, `图不该是空的（${r.bytes} B）`)
  eq(r.imageAttached, true)
  ta(existsSync(r.file), `文件应在: ${r.file}`)
  ta(savedImages.length >= 1, 'attachments.saveImage 应被调用过')
})

await t('L6c eye_shot({i})：按编号裁剪，PNG 尺寸对拍（ Pick 区 = 整组并集）', async () => {
  // ★ 必须用**最新一次** eye_see 的编号：readAreas 每次重新打标记（换 token），
  //   旧编号在 DOM 上已经不存在了。L5 结尾又 eye_see 过一次，所以这里重取。
  const fresh = await call('eye_see')
  const q1 = (fresh.areas ?? []).find((a) => a.kind === 'pick')
  ta(!!q1, '应看得到可挑区')
  // 基准 = 工具自己那套几何（findGroupRectByLocator 的并集 + 12px PAD）。
  // 不拿"我在测试里另量的 label 矩形"当基准 —— 视口滚动条宽度会因窗口
  // 高度微漂，另量的数会和工具当时量的差几个像素，那是测试自己的噪声。
  const gp = await geoGoto(mainUrl)
  const g = await SEE.findGroupRectByLocator(gp, q1.i)
  ta(g?.found === true, '几何函数应量得到这一组')
  ta(g.w > 100 && g.w < 780, `一组选项的并集宽度应合理（${g.w}；块级 label 会占满内容宽，上界=视口宽）`)
  ta(g.count === 3, `应并上 3 个选项，实际 ${g.count}`)

  const r = await call('eye_shot', { i: q1.i })
  eq(r.ok, true, `按编号裁剪应成功: ${JSON.stringify(r).slice(0, 300)}`)
  ta(!r.clipFallback, 'fixture 上不该退回整屏')
  const { w, h } = pngSize(readFileSync(r.file))
  ta(Math.abs(w - (Math.round(g.w) + 12)) <= 2, `裁剪宽应≈并集+12（${Math.round(g.w) + 12}），实际 ${w}`)
  ta(Math.abs(h - (Math.round(g.h) + 12)) <= 2, `裁剪高应≈并集+12（${Math.round(g.h) + 12}），实际 ${h}`)
  // 并集裁剪必须远小于整屏（800×600）—— 不然"省图"就是空话
  const full = await call('eye_shot', { force: true })
  const fs = pngSize(readFileSync(full.file))
  ta(w * h < (fs.w * fs.h) / 4, `裁剪图应远小于整屏（${w}×${h} vs ${fs.w}×${fs.h}）`)
})

await t('L6d eye_shot({embed:false})：只落盘不嵌图', async () => {
  const before = savedImages.length
  const r = await call('eye_shot', { embed: false, force: true })
  eq(r.ok, true)
  eq(r.skipped, undefined, 'force 不该被跳过')
  eq(r.imageAttached, false, 'embed:false 不该嵌图')
  ta(existsSync(r.file), '文件仍应落盘（复核员要 read_image 读它）')
  eq(savedImages.length, before, '不该调用 saveImage')
})

await t('L6e eye_shot({i: 坏编号})：明确报错，不静默整屏', async () => {
  const r = await call('eye_shot', { i: 'no-such-id:99' })
  eq(r.ok, false)
  eq(r.category, 'ARG')
  ta(/ELEMENT_NOT_FOUND|找不到/.test(r.error ?? ''), `应说编号找不到: ${r.error}`)
})

// ═══════════════════════════════════════════════════════════════════════════
// L7 frameRects / hitFrame：跨域 iframe 的页面坐标
// ═══════════════════════════════════════════════════════════════════════════
await t('L7 frameRects 量出跨域 iframe 的页面坐标矩形，hitFrame 命中/落空', async () => {
  const gp = await geoGoto(framesUrl)
  // ★ 必须先滚动：iframe 在 top:600，而视口高 600 —— 不滚的话它整块在视口外，
  //   hitFrame 按设计返回 null（"看不见的地方不算命中"，见 browser.mjs 的注释）。
  //   滚到 300 后视口覆盖页面 300..900，iframe（600..900）露出来了。
  await gp.eval('window.scrollTo(0, 300)')
  await sleep(120)
  const rects = await gp.frameRects()
  ta(Array.isArray(rects) && rects.length >= 2, `应有主窗口 + iframe 两条，实际 ${rects?.length}`)
  const main = rects[0]
  const kid = rects.find((r) => r !== main)
  // fixture 写死：top:600 left:50 400x300（页面坐标，滚动不改变它）
  ta(Math.abs(kid.x - 50) <= 3, `iframe x 应≈50，实际 ${kid.x}`)
  ta(Math.abs(kid.y - 600) <= 3, `iframe y 应≈600，实际 ${kid.y}`)
  ta(Math.abs(kid.width - 400) <= 3, `iframe 宽应≈400，实际 ${kid.width}`)
  ta(Math.abs(kid.height - 300) <= 3, `iframe 高应≈300，实际 ${kid.height}`)
  ta(Math.abs(main.y - 300) <= 3, `主窗口页面坐标 y 应≈滚动量 300，实际 ${main.y}`)
  // hitFrame：点露出来的 iframe → iframe；点别处 → null（主窗口）
  eq(await gp.hitFrame(120, 650), kid.frame, 'iframe 内的点应命中 iframe')
  eq(await gp.hitFrame(700, 700), null, 'iframe 外的点应落回主窗口')
})

// ═══════════════════════════════════════════════════════════════════════════
// L8 loginState：主窗口没有 → false；跨域 iframe 里有 → true 且说清位置
// ═══════════════════════════════════════════════════════════════════════════
await t('L8a loginState：fixture 主页没有登录要素 → false', async () => {
  const gp = await geoGoto(mainUrl)
  const r = await SEE.loginState(gp)
  eq(r.onLoginPage, false)
  eq(r.needsUser, false)
})

await t('L8b ★ loginState：跨域 iframe 里的密码框也必须算（P0-2 回归）', async () => {
  const gp = await geoGoto(framesUrl)
  const r = await SEE.loginState(gp)
  eq(r.onLoginPage, true, '登录框在 iframe 里，只扫主窗口会漏判')
  eq(r.detail.hasPasswordBox, true)
  ta(String(r.detail.where).includes(`:${portFrame}/frame.html`),
    `detail.where 应指出是哪个窗口，实际 ${r.detail.where}`)
})

await t('L8c loginState：frame.html 直接当顶层页 → true（主窗口命中）', async () => {
  const gp = await geoGoto(frameUrl)
  const r = await SEE.loginState(gp)
  eq(r.onLoginPage, true)
  eq(r.detail.hasPasswordBox, true)
})

// ═══════════════════════════════════════════════════════════════════════════
// L9 socket 健康层（P0-1）：浏览器死了，调用必须快速失败，不许挂起
// ═══════════════════════════════════════════════════════════════════════════
// L2b eye_paper：整卷 1..N + 落盘编号 + 分段（2026-10-17）
// 做题的子 Agent 不会滚动，必须一次拿到完整题面 —— 这条守住"整卷"这件事。
await t('L2b eye_paper：题目按 1..N 编好、每题都有落盘编号、至少一段', async () => {
  await geoGoto(mainUrl)          // 前面的用例把页面导航去了别的 fixture，先回来
  const r = await call('eye_paper', { shot: false })
  eq(r.ok, true, `ok 应为 true：${JSON.stringify(r).slice(0, 300)}`)
  eq(r.total, 4, `fixture 有 4 道题（3 挑 + 1 写），实际 ${r.total}`)
  eq(r.items.map((x) => x.kind).join(','), 'pick,pick,pick,write')
  eq(r.items.map((x) => x.n).join(','), '1,2,3,4', '题号必须连续且从上到下')
  ta(r.items.every((x) => typeof x.i === 'string' && x.i.length > 0), '每题都要有落盘编号 i')
  ta(r.items[0].options.length === 3 && typeof r.items[0].options[0].i === 'string', '选项也要带落盘编号')
  ta(Array.isArray(r.segments) && r.segments.length >= 1, '至少一段图')
  ta(r.segments[0].covers.includes(1), '第一段必须盖住第 1 题')
  ta(r.clip && r.clip.width > 0 && r.clip.height > 0, '题目区矩形要量出来')
  // 登记键 = ledger 的 n（write 用 w），必须和 eye_check 同一口径 ——
  // 3.5 实测踩过：按题号登记，eye_check 读到 registered:0，票据发不出来。
  eq(r.items.map((x) => x.key).join(','), '1,2,3,1', 'key 应是 ledger 的 n / write 的 w')
  ta(!('areas' in r), '不要把整页 areas 回传给模型')
})

await t('L9a 关掉浏览器 → isAlive false、onDead 广播到', async () => {
  eq(geo.sock.isAlive(), true, '之前应是活的')
  let deadInfo = null
  const off = geo.sock.onDead((d) => { deadInfo = d })
  await geo.sock.send('Browser.close')
  const t0 = Date.now()
  while (Date.now() - t0 < 5000 && geo.sock.isAlive()) await sleep(100)
  eq(geo.sock.isAlive(), false, '浏览器关了，socket 应标记死亡')
  ta(!!deadInfo, 'onDead 应收到广播')
  ta(/close|error|失败/.test(String(deadInfo?.why)), `死因应说清楚: ${deadInfo?.why}`)
  off()
})

await t('L9b 死后的 send 立即 SOCKET_DEAD（旧版：永远挂起）', async () => {
  const t0 = Date.now()
  let err = null
  try { await geo.sock.send('Target.getTargets') } catch (e) { err = e }
  const ms = Date.now() - t0
  ta(!!err, '应抛错')
  eq(err?.code, 'SOCKET_DEAD', `错误码应是 SOCKET_DEAD，实际 ${err?.code}: ${err?.message}`)
  ta(ms < 2000, `应立即失败，实际 ${ms}ms（挂起的表现是永不返回）`)
})

// ═══════════════════════════════════════════════════════════════════════════
// L10 findBrowserExe / launchBrowser（E-9 跨平台）
// ═══════════════════════════════════════════════════════════════════════════
await t('L10a findBrowserExe：环境变量显式指定优先', async () => {
  const prev = process.env.DSH_BROWSER_PATH
  try {
    process.env.DSH_BROWSER_PATH = found.exe
    const r = B.findBrowserExe()
    eq(r?.via, 'DSH_BROWSER_PATH')
    eq(r?.exe, found.exe)
    process.env.DSH_BROWSER_PATH = join(tmpWork, 'definitely-not-here')
    eq(B.findBrowserExe(), null, '设了却不存在 → null（调用方报错，不悄悄换）')
  } finally {
    if (prev === undefined) delete process.env.DSH_BROWSER_PATH
    else process.env.DSH_BROWSER_PATH = prev
  }
})

await t('L10b launchBrowser：在 Linux/macOS 上真能起（旧版只认 Windows 路径）', async () => {
  const br = await B.launchBrowser({
    port: cdpPort2,
    profileDir: join(tmpWork, 'profile2'),
    extraArgs: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  ta(!!br?.sock, '应连上')
  ta(br.sock.isAlive(), 'socket 应活着')
  const pages = await B.listPages(br)
  ta(Array.isArray(pages), '应列得出标签页')
  await br.sock.send('Browser.close')       // 收尸：关掉这个临时浏览器
})

await t('L10c launchBrowser：DSH_BROWSER_PATH 指错 → 明确报错', async () => {
  // ★ 必须用一个**全新的端口**，不能复用 L10b 的 cdpPort2：
  //   launchBrowser 开头先 connectBrowser(port)，端口上只要还有浏览器在听就提前 return、
  //   永远走不到下面的环境变量校验。L10b 刚 Browser.close 掉同端口的浏览器，进程还没退干净，
  //   复用端口会让这条用例假失败（产品行为本身是对的，已单独探针验证过）。
  const port = await freePort()
  const prev = process.env.DSH_BROWSER_PATH
  try {
    process.env.DSH_BROWSER_PATH = join(tmpWork, 'nope-chrome')
    let err = null
    try {
      await B.launchBrowser({ port, profileDir: join(tmpWork, 'profile3') })
    } catch (e) { err = e }
    ta(!!err, '应抛错')
    ta(/DSH_BROWSER_PATH/.test(String(err?.message)), `报错应点到环境变量: ${err?.message}`)
  } finally {
    if (prev === undefined) delete process.env.DSH_BROWSER_PATH
    else process.env.DSH_BROWSER_PATH = prev
  }
})

// ══ 收尸 ═══════════════════════════════════════════════════════════════════
// 清理失败不该把测试结果吃掉 —— 包一层，rm 不掉最多留个临时目录
const cleanup = () => {
  try { geo.sock.close() } catch { /* 已经死了 */ }
  try { proc.kill('SIGKILL') } catch { /* 已经退了 */ }
  try { srvMain.close() } catch { /* 无所谓 */ }
  try { srvFrame.close() } catch { /* 无所谓 */ }
  // chromium 退出瞬间可能还在写 profile → 重试几次再删
  for (const d of [tmpWork, profile]) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 留着算了 */ }
  }
}
cleanup()

console.log(`\n${'─'.repeat(60)}`)
if (fails.length) {
  console.log(`✗ L2 ${fails.length} 条没过（通过 ${pass} 条）\n`)
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
} else {
  console.log(`✓ L2 全部通过：${pass} 条断言`)
}
