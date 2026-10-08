// patch-profile.mjs —— 修改 DSH profile 的 package.json（把插件加进依赖与 bundles）
//
// 为什么用 Node 而不是让 install.ps1 直接用 ConvertTo-Json：
//   PowerShell 5.1 和 7 的 ConvertTo-Json 输出格式不同（5.1 会加一堆多余空格），
//   而 JSON.stringify(.., null, 2) 是确定性的、干净的、跨版本一致的。
//
// 用法:
//   node scripts/patch-profile.mjs <pluginDir> [--dry-run] [--rollback <backupPath>]

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const pluginDirArg = args.find((a) => !a.startsWith('--'))
if (!pluginDirArg) { console.error('用法: node patch-profile.mjs <pluginDir> [--dry-run]'); process.exit(2) }

const PLUGIN_NAME = 'dsh-xuexi'
const pluginDir = resolve(pluginDirArg).replace(/\\/g, '/')
const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
const pkgPath = join(profileDir, 'package.json')

// rollback 模式
const rbIdx = args.indexOf('--rollback')
if (rbIdx !== -1) {
  const backup = args[rbIdx + 1]
  if (!backup) { console.error('--rollback 需要一个备份路径'); process.exit(2) }
  writeFileSync(pkgPath, readFileSync(backup, 'utf8'))
  console.log(`[ok] 已从备份恢复: ${backup} -> ${pkgPath}`)
  process.exit(0)
}

const before = readFileSync(pkgPath, 'utf8')
let pkg
try { pkg = JSON.parse(before) } catch (e) {
  console.error(`[FAIL] profile package.json 不是合法 JSON: ${e.message}`)
  process.exit(1)
}

// ── 校验插件本体 ────────────────────────────────────────────────────────────
const required = ['index.js', 'cordis.patch.yml', 'package.json', 'prompts/xuexi-mode.md']
const missing = required.filter((f) => {
  try { readFileSync(join(pluginDir, f)); return false } catch { return true }
})
if (missing.length) {
  console.error(`[FAIL] 插件目录缺少文件: ${missing.join(', ')}`)
  process.exit(1)
}
const pluginPkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
if (pluginPkg.name !== PLUGIN_NAME) {
  console.error(`[FAIL] 插件 package.json 的 name 是 "${pluginPkg.name}"，期望 "${PLUGIN_NAME}"`)
  process.exit(1)
}

// ── 改依赖 ──────────────────────────────────────────────────────────────────
const fileSpec = `file:${pluginDir}`
pkg.dependencies = pkg.dependencies ?? {}
const depAction = pkg.dependencies[PLUGIN_NAME] ? '已更新' : '已新增'
pkg.dependencies[PLUGIN_NAME] = fileSpec

// ── 改 bundles ──────────────────────────────────────────────────────────────
if (!pkg.dsh?.profile?.bundles) {
  console.error('[FAIL] profile package.json 里没有 dsh.profile.bundles，结构不符，拒绝修改')
  process.exit(1)
}
const bundles = pkg.dsh.profile.bundles
const bundleAction = bundles.includes(PLUGIN_NAME) ? '已存在' : '已新增'
if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)

const after = JSON.stringify(pkg, null, 2) + '\n'

console.log('[ok] 依赖      ' + depAction + ': ' + PLUGIN_NAME + ' -> ' + fileSpec)
console.log('[ok] bundle    ' + bundleAction + ': ' + PLUGIN_NAME)
console.log('[i ] bundles   ' + bundles.length + ' 项: ' + bundles.join(', '))

if (dryRun) {
  console.log('\n----- 生成结果（干跑，未写入）-----')
  console.log(after)
  console.log('---------------------------------')
  console.log('[dry] 未写入任何文件')
} else {
  if (after === before) {
    console.log('[i ] package.json 内容无变化，跳过写入')
  } else {
    writeFileSync(pkgPath, after)
    console.log('[ok] 已写入: ' + pkgPath)
  }
}
