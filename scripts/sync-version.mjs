#!/usr/bin/env node
/**
 * sync-version.mjs —— 版本号的单一数据源
 *
 * 真源只有一个：`package.json` 的 `version`。其余三处全部由本脚本从真源同步：
 *   · `package.json` 里的 `dsh.version`（DSH 读它）
 *   · `README.md` 顶部的「当前版本」
 *   · `CHANGELOG.md` 的最新段标题
 *
 * 为什么要有这个脚本：这四处以前靠肉眼维护，CHANGELOG 里记着两次"只改了 package.json、
 * 忘了测试里的版本钉"的翻车。现在 `test/run.mjs` 的 E4 会盯住"其余三处必须等于真源"，
 * 本脚本负责把真源的变化写下去 —— 改版本只需要动一个地方。
 *
 * 用法：
 *   node scripts/sync-version.mjs 2.3.0    # 设成新版本（同步四处 + 插入 CHANGELOG 段）
 *   node scripts/sync-version.mjs          # 不带参数 = 拿 package.json 的 version 去同步其余三处
 *   node scripts/sync-version.mjs --check  # 只校验，一个字节都不写；不一致时退出码 1
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const target = args.find((a) => !a.startsWith('--'))

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(read('package.json'))
const truth = pkg.version
const next = target ?? truth

if (!SEMVER.test(next)) {
  console.error(`[FAIL] "${next}" 不是合法的语义化版本号（形如 2.3.0 / 2.3.0-rc.1）`)
  process.exit(2)
}

/** 本地时区的今天，别用 toISOString（那是 UTC，会把傍晚的提交记成明天） */
const d = new Date()
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ── 读取四处的当前值 ────────────────────────────────────────────────────────
const readme = read('README.md')
const changelog = read('CHANGELOG.md')

const cur = {
  'package.json version': truth,
  'package.json dsh.version': pkg.dsh?.version ?? null,
  'README.md 顶部': /^\*\*当前版本 (.+?)\*\*/m.exec(readme)?.[1] ?? null,
  'CHANGELOG.md 最新段': /^## \[(.+?)\] — /m.exec(changelog)?.[1] ?? null,
}

const drift = Object.entries(cur).filter(([, v]) => v !== next)

if (checkOnly) {
  if (drift.length) {
    console.error(`[FAIL] 版本号不是单一数据源，以下 ${drift.length} 处与 package.json 的 ${truth} 不一致：`)
    for (const [k, v] of drift) console.error(`  · ${k}: ${v}`)
    console.error('\n跑 `node scripts/sync-version.mjs' + (target ? ` ${target}` : '') + '` 修。')
    process.exit(1)
  }
  console.log(`[ok] 四处版本号一致：${truth}`)
  process.exit(0)
}

if (!drift.length) {
  console.log(`[i ] 四处已经都是 ${next}，无需改动`)
  process.exit(0)
}

// ── 写 package.json（version 与 dsh.version 都归一到 next）─────────────────
pkg.version = next
if (pkg.dsh) pkg.dsh.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// ── 写 README 顶部 ─────────────────────────────────────────────────────────
if (cur['README.md 顶部'] !== next) {
  if (!/^\*\*当前版本 .+?\*\*/m.test(readme)) {
    console.error('[FAIL] README.md 顶部找不到「**当前版本 x.y.z**」这一行，请手动补')
    process.exit(1)
  }
  writeFileSync(join(ROOT, 'README.md'), readme.replace(/^\*\*当前版本 .+?\*\*/m, `**当前版本 ${next}**`))
}

// ── 写 CHANGELOG：最新段不是 next 就在它前面插一段骨架 ─────────────────────
if (cur['CHANGELOG.md 最新段'] !== next) {
  const skeleton = `## [${next}] — ${today}\n\n**（待补：这一版改了什么、为什么）**\n\n---\n\n`
  writeFileSync(join(ROOT, 'CHANGELOG.md'), changelog.replace(/^## \[/m, skeleton + '## ['))
}

for (const [k, v] of Object.entries(cur)) {
  console.log(`[ok] ${k}: ${v ?? '（缺）'} → ${next}`)
}
console.log(`\n[i ] CHANGELOG.md 已插入 [${next}] 段骨架（内容待手写）；写完再跑 --check 复核。`)
