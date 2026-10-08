// ═══════════════════════════════════════════════════════════════════════════
// 假 CDP 测试台 —— 在没有真浏览器的情况下**真的跑一遍**选页逻辑
//
//   node test/run.mjs
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么要有它：这个项目已经出过好几次"语法过了、能装载、但真机一跑就错"的事。
// 「没报错」不等于「对」。所以关键分支必须有能自动跑的验证。
//
// 做法：伪造一个 browser 对象，它的 sock.send 按命令名返回预设结果，
// 然后直接调真实的 ensureWorkTab / 真实的 output.render，断言结果。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PLUGIN = path.resolve(HERE, '..')

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('  ✅ ' + name); pass++ }
  catch (e) { console.log('  ❌ ' + name + '\n       ' + String(e.message).split('\n').slice(0, 6).join('\n       ')); fail++ }
}
const ta = async (name, fn) => {
  try { await fn(); console.log('  ✅ ' + name); pass++ }
  catch (e) { console.log('  ❌ ' + name + '\n       ' + String(e.message).split('\n').slice(0, 6).join('\n       ')); fail++ }
}

// ── 伪造浏览器 ──────────────────────────────────────────────────────────────
// pages: [{ targetId, url, visible }]
function fakeBrowser(pages) {
  const calls = []
  const sessions = new Map()          // sessionId -> targetId
  let nextSid = 0
  const visibleOf = (targetId) => !!pages.find((p) => p.targetId === targetId)?.visible

  const sock = {
    calls,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId })
      switch (method) {
        case 'Target.getTargets':
          return { targetInfos: pages.map((p) => ({ targetId: p.targetId, type: 'page', url: p.url, title: '' })) }
        case 'Target.attachToTarget': {
          const sid = 'sid-' + (++nextSid)
          sessions.set(sid, params.targetId)
          return { sessionId: sid }
        }
        case 'Target.detachFromTarget':
          sessions.delete(params.sessionId)
          return {}
        case 'Target.createTarget': {
          const id = 'created-' + (pages.length + 1)
          pages.push({ targetId: id, url: params.url ?? 'about:blank', visible: false })
          return { targetId: id }
        }
        case 'Target.closeTarget':
          return {}
        case 'Runtime.enable':
          return {}
        case 'Page.enable':
          return {}
        case 'Runtime.evaluate': {
          // probeForeground 用它问「你是不是在前台」
          const targetId = sessions.get(sessionId)
          return { result: { value: {
            vis: visibleOf(targetId) ? 'visible' : 'hidden',
            focus: visibleOf(targetId),
            url: pages.find((p) => p.targetId === targetId)?.url ?? '',
          } } }
        }
        case 'Page.getFrameTree':
          return { frameTree: { frame: { id: 'F0', url: pages.find((p) => p.targetId === sessions.get(sessionId))?.url ?? '' } } }
        default:
          return {}
      }
    },
    on() { return () => {} },
    close() {},
  }
  return { sock, calls, pages }
}

console.log('\n═══ 一、选页逻辑（用户直接指出的问题 ③）═══\n')

const { ensureWorkTab } = await import('file:///' + path.join(PLUGIN, 'lib', 'browser.mjs').replace(/\\/g, '/'))

// 场景：浏览器里有三个页 —— 一个空白、一个学习通课程页（后台）、一个学习通任务页（前台）
const mkScene = () => fakeBrowser([
  { targetId: 'T-blank', url: 'about:blank', visible: false },
  { targetId: 'T-home', url: 'https://i.chaoxing.com/base', visible: false },
  { targetId: 'T-task', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1210980891', visible: true },
])

await ta('preferForeground：绑到用户正在看的那个学习通页（不是空白页、不是课程页）', async () => {
  const b = mkScene()
  const page = await ensureWorkTab(b, { preferForeground: true })
  assert.equal(page.targetId, 'T-task', '应该绑到前台的任务页')
  assert.equal(page.__followedUser, true, '应该标记 __followedUser')
})

await ta('preferForeground：**没有**调用 goto / 没有新开标签页', async () => {
  const b = mkScene()
  await ensureWorkTab(b, { preferForeground: true })
  const created = b.calls.filter((c) => c.method === 'Target.createTarget')
  assert.equal(created.length, 0, '不该新建标签页')
  const navigated = b.calls.filter((c) => c.method === 'Page.navigate')
  assert.equal(navigated.length, 0, '不该导航')
})

await ta('探前台时会 attach 再 detach，不留残余 session', async () => {
  const b = mkScene()
  await ensureWorkTab(b, { preferForeground: true })
  const att = b.calls.filter((c) => c.method === 'Target.attachToTarget').length
  const det = b.calls.filter((c) => c.method === 'Target.detachFromTarget').length
  // 每探一个页面就 attach+detach 一次，最后再 attach 一次作为真正的绑定
  assert.equal(att - 1, det, `attach=${att} detach=${det} 应该正好差 1（最后那个才是绑定）`)
})

await ta('不带 preferForeground：沿用记录的 targetId（干活中途不重绑）', async () => {
  const b = mkScene()
  const page = await ensureWorkTab(b, { targetId: 'T-home' })
  assert.equal(page.targetId, 'T-home', '应该沿用记录的页，不被前台页抢走')
  assert.notEqual(page.__followedUser, true)
})

await ta('前台页不存在时：退回"最像在用的那个"（studentstudy 优先）', async () => {
  const b = fakeBrowser([
    { targetId: 'T-home', url: 'https://i.chaoxing.com/base', visible: false },
    { targetId: 'T-task', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?x=1', visible: false },
  ])
  const page = await ensureWorkTab(b, { preferForeground: true })
  assert.equal(page.targetId, 'T-task', 'studentstudy 得分更高')
})

console.log('\n═══ 二、空白标签页（用户指出的问题 ②）═══\n')

await ta('只有浏览器自带的空白页时：**接管它**，不再新开一个', async () => {
  const b = fakeBrowser([{ targetId: 'T-blank', url: 'about:blank', visible: true }])
  const page = await ensureWorkTab(b, { preferForeground: true })
  assert.equal(page.targetId, 'T-blank', '应该接管那个空白页')
  const created = b.calls.filter((c) => c.method === 'Target.createTarget')
  assert.equal(created.length, 0, '不该再开第二个空白页')
})

await ta('一个页面都没有时：才新建', async () => {
  const b = fakeBrowser([])
  const page = await ensureWorkTab(b, { preferForeground: true })
  const created = b.calls.filter((c) => c.method === 'CreateTarget' || c.method === 'Target.createTarget')
  assert.equal(created.length, 1, '应该新建一个')
  assert.equal(page.__ownsWorkTab, true)
})

console.log('\n═══ 三、截图必须真的把图交给模型（最严重的问题 ④）═══\n')

const tools = []
const saved = []
const ctx = {
  effect: (fn) => { const d = fn(); return () => (typeof d === 'function' ? d() : undefined) },
  logger: { warn: () => {} },
  get: (n) => {
    if (n === 'systemPrompt') return { section: () => () => {} }
    if (n === 'sessions') return { get: () => ({ header: { cwd: 'D:\\tmp' } }) }
    if (n === 'agents') return { list: () => [{ id: 'MAIN' }], isOwnedBy: () => false }
    if (n === 'attachments') return {
      async saveImage({ data, mediaType, name }) {
        saved.push({ bytes: data.length, mediaType, name })
        return { attachmentId: 'att-' + saved.length, mediaType, bytes: data.length, width: 800, height: 600, name }
      },
    }
    return undefined
  },
  tools: { register: (x) => { tools.push(x); return () => {} } },
}
const mod = await import('file:///' + path.join(PLUGIN, 'index.js').replace(/\\/g, '/'))
mod.apply(ctx, {})

const shotTool = tools.find((x) => x.name === 'cx_shot')

t('cx_shot 注册了 output.render（没有它图就送不出去）', () => {
  assert.ok(shotTool, 'cx_shot 应该已注册')
  assert.equal(typeof shotTool.output?.render, 'function', 'output.render 必须是函数')
})

t('objOut.render：有 __images 时产出真正的 image 块', () => {
  const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1234, width: 800, height: 600 }
  const blocks = shotTool.output.render({}, { ok: true, file: 'x.png', __images: [ref] })
  assert.equal(blocks.length, 2, '应该是一个 text + 一个 image')
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image', '第二个块必须是 image')
  assert.deepEqual(blocks[1].attachment, ref, 'image 块要带上 attachment ref')
})

t('objOut.render：__images 不该出现在给模型看的文字里', () => {
  const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  const blocks = shotTool.output.render({}, { ok: true, __images: [ref] })
  assert.ok(!/__images/.test(blocks[0].text), '文字里不该有 __images 这种内部字段：' + blocks[0].text)
  assert.deepEqual(Object.keys(JSON.parse(blocks[0].text)), ['ok'], '文字里只该剩业务字段')
})

t('objOut.render：没有 __images 时退化成纯文字（不影响其它工具）', () => {
  const blocks = shotTool.output.render({}, { ok: true, foo: 1 })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
})

console.log('\n═══ 四、工具表面（防止再次出现"提示词写了但工具不存在"）═══\n')

const names = tools.map((x) => x.name)
t('cx_shot 的描述里不再承诺"DSH 会自动显示图片"这种没验证的话', () => {
  const d = shotTool.description
  assert.ok(!/DSH 会自动显示图片/.test(d), '旧描述是错的（当时根本没有图）：' + d.slice(0, 80))
})

t('cx_do 只有 play / read / answer 三个动作', () => {
  const cxd = tools.find((x) => x.name === 'cx_do')
  assert.deepEqual(cxd.parameters.properties.action.enum, ['play', 'read', 'answer'])
})

t('每个 cx_* 工具都有 output.render', () => {
  for (const x of tools) assert.equal(typeof x.output?.render, 'function', x.name + ' 缺 output.render')
})

console.log('\n═══ 五、预设自检（防止引用不存在的插件）═══\n')

const yml = fs.readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8')

t('cordis.patch.yml 里每个 @deepseek-ai/* 插件都真实存在', () => {
  const refs = [...yml.matchAll(/name:\s*'(@deepseek-ai\/[^']+)'/g)].map((m) => m[1])
  assert.ok(refs.length > 0, '解析不到任何插件引用，YAML 结构可能变了')
  // 在本机找 DSH 的 app.asar（找不到就跳过这条，不让 CI/别的机器红）
  const asar = 'C:\\Users\\23500\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
  if (!fs.existsSync(asar)) { console.log('       （本机没有 app.asar，跳过存在性检查）'); return }
  const idx = fs.readFileSync(asar, 'latin1')
  for (const ref of refs) {
    const short = ref.replace('@deepseek-ai/', '')
    assert.ok(
      idx.includes(`node_modules/@deepseek-ai/${short}/package.json`),
      `${ref} 在 asar 里找不到 —— 预设会加载失败`,
    )
  }
})

t('预设的 plugins 里带了 tool-fs（否则模型没有 read_image，判题员派不出去）', () => {
  assert.ok(/dsh-tool-fs/.test(yml), '缺 tool-fs：模型将没有 read/write/read_image')
})

t('cx_open 只在"不在学习通上"时才导航（否则会冲掉用户翻好的页）', () => {
  const src = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')
  const body = src.slice(src.indexOf("name: 'cx_open'"), src.indexOf("name: 'cx_note'"))
  assert.ok(/if \(!onChaoxing\)/.test(body), 'cx_open 里应该有 `if (!onChaoxing)` 守卫')
  assert.ok(!/execute\(\)\s*\{\s*const work[^]*?await work\.goto\(OBS\.HOME_URL/.test(body),
    'cx_open 不该无条件 goto 首页')
})

t('cx_open 会报告自检信息（attachmentsAvailable / boundTab / tabs）', () => {
  const src = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')
  const body = src.slice(src.indexOf("name: 'cx_open'"), src.indexOf("name: 'cx_note'"))
  for (const k of ['attachmentsAvailable', 'boundTab', 'followedUserTab']) {
    assert.ok(body.includes(k), 'cx_open 的返回里应该有 ' + k)
  }
})

console.log('\n═══ 六、判题覆盖检查（防「漏答」）═══\n')

const CHK = await import('file:///' + path.join(PLUGIN, 'lib', 'check.mjs').replace(/\\/g, '/'))

t('★ 真机失败案例：5 题库只给 4 个答案 → 拦下，并指出漏的是第 5 题', () => {
  const bad = { 1: ['B'], 2: ['A'], 3: ['A', 'B', 'C'], 4: ['B'] }
  const cov = CHK.checkAnswerCoverage(5, bad)
  assert.equal(cov.ok, false, '不该放行')
  assert.deepEqual(cov.missing, [5], '应该指出漏的是第 5 题')
  assert.ok(/没有提交/.test(CHK.describeAnswerGap(cov)), '提示要说清「没有提交」')
})

t('答全了就放行', () => {
  const cov = CHK.checkAnswerCoverage(5, { 1: ['A'], 2: ['B'], 3: ['C'], 4: ['A'], 5: ['B'] })
  assert.equal(cov.ok, true)
  assert.equal(CHK.describeAnswerGap(cov), null)
})

t('给了题号但选项是空数组 → 也算漏答', () => {
  const cov = CHK.checkAnswerCoverage(3, { 1: ['A'], 2: ['B'], 3: [] })
  assert.equal(cov.ok, false)
  assert.deepEqual(cov.empty, [3])
})

t('题号超出题量（数错了）→ 拦下', () => {
  const cov = CHK.checkAnswerCoverage(5, { 1: ['A'], 2: ['B'], 3: ['C'], 4: ['A'], 5: ['B'], 6: ['D'] })
  assert.equal(cov.ok, false)
  assert.deepEqual(cov.extra, [6])
})

t('题量读不到（0）时不误拦 —— 那是我们读不出来，不是模型漏答', () => {
  const cov = CHK.checkAnswerCoverage(0, { 1: ['A'] })
  assert.equal(cov.ok, true, 'total=0 时不该拦，否则会卡死')
})

t('cx_do answer 真的接上了覆盖检查', () => {
  const src = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')
  assert.ok(/CHK\.checkAnswerCoverage\(/.test(src), 'index.js 里没调用 checkAnswerCoverage')
  assert.ok(/ANSWERS_INCOMPLETE/.test(src), '没返回 ANSWERS_INCOMPLETE')
})

t('cx_do answer 提交后会报告分数差距（没满分时）', () => {
  const src = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')
  assert.ok(/scoreGap/.test(src), '没给没满分的提示')
})

console.log('\n═══ 七、答案形状检查（防「题号/题型错位」）═══\n')

const QS = [
  { kind: '单选题', options: [{ letter: 'A' }, { letter: 'B' }, { letter: 'C' }, { letter: 'D' }] },
  { kind: '单选题', options: [{ letter: 'A' }, { letter: 'B' }, { letter: 'C' }, { letter: 'D' }] },
  { kind: '判断题', isTruth: true, options: [{ letter: 'A' }, { letter: 'B' }] },
  { kind: '判断题', isTruth: true, options: [{ letter: 'A' }, { letter: 'B' }] },
  { kind: '判断题', isTruth: true, options: [{ letter: 'A' }, { letter: 'B' }] },
]

t('★ 真机失败案例：第 3 题是判断题（只有 A/B），模型给了 A、B、C → 拦下并说清', () => {
  const r = CHK.checkAnswerShape(QS, { 1: ['C'], 2: ['B'], 3: ['A', 'B', 'C'], 4: ['A'], 5: ['B'] })
  assert.equal(r.ok, false)
  assert.equal(r.problems.length, 1)
  assert.equal(r.problems[0].q, 3)
  assert.equal(r.problems[0].type, 'NO_SUCH_OPTION')
  assert.deepEqual(r.problems[0].available, ['A', 'B'], '要如实报出这题只有 A、B')
  const msg = CHK.describeShapeProblems(r)
  assert.ok(/只有 A、B/.test(msg), '提示要写清这题只有几个选项')
  assert.ok(/判断题/.test(msg), '提示要写清题型')
})

t('单选题给两个字母 → 拦下', () => {
  const r = CHK.checkAnswerShape([{ kind: '单选题', options: [{ letter: 'A' }, { letter: 'B' }] }], { 1: ['A', 'B'] })
  assert.equal(r.ok, false)
  assert.equal(r.problems[0].type, 'TOO_MANY_FOR_SINGLE')
})

t('判断题给两个字母 → 拦下', () => {
  const r = CHK.checkAnswerShape([{ kind: '判断题', isTruth: true, options: [{ letter: 'A' }, { letter: 'B' }] }], { 1: ['A', 'B'] })
  assert.equal(r.ok, false)
  assert.equal(r.problems[0].type, 'TOO_MANY_FOR_SINGLE')
})

t('多选题只给一个字母 → **只提醒不拦**（只有一个正确项是合法的）', () => {
  const r = CHK.checkAnswerShape([{ kind: '多选题', options: [{ letter: 'A' }, { letter: 'B' }] }], { 1: ['A'] })
  assert.equal(r.ok, true, '不该拦 —— 多选题可能只有一个正确项')
  assert.equal(r.notes.length, 1)
  assert.equal(r.notes[0].type, 'ONLY_ONE_FOR_MULTI')
})

t('全套形状正确 → 放行', () => {
  assert.equal(CHK.checkAnswerShape(QS, { 1: ['C'], 2: ['B'], 3: ['A'], 4: ['A'], 5: ['B'] }).ok, true)
})

t('读不到选项（optionCount=0）时不误拦', () => {
  const r = CHK.checkAnswerShape([{ kind: '单选题', options: [] }], { 1: ['A'] })
  assert.equal(r.ok, true, '选项读不到就不该拦，否则会卡死')
})

t('cx_do answer 真的接上了形状检查（且在点击之前）', () => {
  const src = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')
  assert.ok(/CHK\.checkAnswerShape\(/.test(src), '没调用 checkAnswerShape')
  assert.ok(/ANSWERS_SHAPE_MISMATCH/.test(src), '没返回 ANSWERS_SHAPE_MISMATCH')
  const iShape = src.indexOf('CHK.checkAnswerShape(')
  const iClick = src.indexOf('ACT.answerQuiz(')
  assert.ok(iShape > 0 && iClick > 0 && iShape < iClick, '形状检查必须在点击之前')
})

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`)
process.exit(fail ? 1 : 0)
