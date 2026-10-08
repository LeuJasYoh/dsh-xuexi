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

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`)
process.exit(fail ? 1 : 0)
