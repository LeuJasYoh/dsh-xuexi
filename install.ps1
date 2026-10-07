# install.ps1 -- install dsh-chaoxing into the DSH desktop profile
#
# NOTE: This file is intentionally ASCII-only.
# Windows PowerShell 5.1 reads .ps1 using the system ANSI code page, so any
# non-ASCII text here would be mangled and can break parsing.
#
# This script only orchestrates: back up -> call Node to patch -> pnpm install.
# All JSON editing is done by scripts/patch-profile.mjs (Node), so the result is
# identical no matter which PowerShell version you use.
#
# Usage:
#   cd <this plugin directory>
#   pwsh -File .\install.ps1          # preferred (PowerShell 7)
#   powershell -File .\install.ps1    # also works (Windows PowerShell 5.1)
#
#   .\install.ps1 -DryRun             # preview only
#   .\install.ps1 -Rollback <backup>  # restore a backup
#   .\install.ps1 -ProfileName default  # a profile other than "desktop"

[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$Rollback,
    [string]$ProfileName = 'desktop'
)

$ErrorActionPreference = 'Stop'

$PluginDir  = $PSScriptRoot
$ProfileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName"
$PkgPath    = Join-Path $ProfileDir 'package.json'
$NodeExe    = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$PnpmMjs    = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$PatchMjs   = Join-Path $PluginDir 'scripts\patch-profile.mjs'

Write-Host "PowerShell          : $($PSVersionTable.PSVersion)"
Write-Host "Plugin dir          : $PluginDir"
Write-Host "Profile dir         : $ProfileDir"
if ($DryRun) { Write-Host "Mode                : DRY RUN" -ForegroundColor Yellow }
Write-Host ""

# ---- preflight -------------------------------------------------------------
if (-not (Test-Path $PkgPath))  { throw "profile package.json not found: $PkgPath" }
if (-not (Test-Path $NodeExe))  { throw "node not found: $NodeExe" }
if (-not (Test-Path $PnpmMjs))  { throw "pnpm not found: $PnpmMjs" }
if (-not (Test-Path $PatchMjs)) { throw "patch script not found: $PatchMjs" }
Write-Host "[ok] preflight passed" -ForegroundColor Green

# ---- rollback path ---------------------------------------------------------
if ($Rollback) {
    if (-not (Test-Path $Rollback)) { throw "backup not found: $Rollback" }
    & $NodeExe $PatchMjs $PluginDir --rollback $Rollback
    if ($LASTEXITCODE -ne 0) { throw "rollback failed" }
    Write-Host ""
    Write-Host "[..] running pnpm install ..."
    Push-Location $ProfileDir
    try { & $NodeExe $PnpmMjs install } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
    Write-Host "[ok] rollback completed. Restart DeepSeek Harness." -ForegroundColor Green
    exit 0
}

# ---- 1) backup -------------------------------------------------------------
if (-not $DryRun) {
    $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$PkgPath.bak-$stamp"
    Copy-Item $PkgPath $backup -Force
    Write-Host "[ok] backup created: $backup"
}

# ---- 2) patch package.json (via Node) --------------------------------------
$patchArgs = @($PatchMjs, $PluginDir)
if ($DryRun) { $patchArgs += '--dry-run' }
& $NodeExe @patchArgs
if ($LASTEXITCODE -ne 0) { throw "patch-profile.mjs failed" }

if ($DryRun) {
    Write-Host ""
    Write-Host "[dry] done. Re-run without -DryRun to apply." -ForegroundColor Green
    exit 0
}

# ---- 3) force a fresh link -------------------------------------------------
#
# pnpm materialises a `file:` dependency as a real COPY, not a symlink.
# Without deleting it first, edits to the plugin source (e.g. cordis.patch.yml)
# would not reach node_modules on a re-install.
#
# !! CRITICAL GOTCHA (measured, cost real debugging time) !!
#
# Deleting the copy and then running `pnpm install` DOES NOT WORK.
# pnpm prints "Already up to date" and never re-creates the directory --
# you end up with the plugin NOT installed and a green success message.
# `pnpm install --force` does NOT help either.
#
# `pnpm add <name>@file:<abs path>` is the only reliable way to re-link:
# it re-resolves the dependency and definitely re-materialises the copy.
# It leaves the existing version spec in package.json untouched.
#
$staleDir = Join-Path $ProfileDir 'node_modules\dsh-chaoxing'
if (Test-Path $staleDir) {
    Write-Host "[..] removing stale installed copy: $staleDir"
    Remove-Item $staleDir -Recurse -Force
    Write-Host "[ok] stale copy removed"
} else {
    Write-Host "[i ] no existing copy to refresh"
}

# ---- 4) link via `pnpm add` ------------------------------------------------
$linkSpec = "dsh-chaoxing@file:$($PluginDir -replace '\\','/')"
Write-Host ""
Write-Host "[..] running: pnpm add $linkSpec"
Push-Location $ProfileDir
try {
    & $NodeExe $PnpmMjs add $linkSpec
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Host ""
    Write-Host "[FAIL] pnpm add exited with code $code" -ForegroundColor Red
    Write-Host "Rollback:"
    Write-Host "  .\install.ps1 -Rollback `"$backup`""
    throw "pnpm add failed"
}

# ---- 5) verify it is really there ------------------------------------------
# Do not trust the exit code: the failure mode above produced exit code 0.
if (-not (Test-Path $staleDir)) {
    Write-Host ""
    Write-Host "[FAIL] node_modules\dsh-chaoxing is still missing after install." -ForegroundColor Red
    Write-Host "       Try manually: cd `"$ProfileDir`"; pnpm add `"$linkSpec`""
    throw "installed copy missing"
}
$fileCount = (Get-ChildItem $staleDir -Recurse -File | Measure-Object).Count
Write-Host "[ok] verified: $fileCount files linked into node_modules"

Write-Host ""
Write-Host "[ok] install completed" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart DeepSeek Harness."
Write-Host "  2. Open Settings -> 'Agent preset' section (NOT a top dropdown)."
Write-Host "     The new mode appears under the CUSTOM group."
Write-Host "  3. If the new-task selector is missing, turn on General -> coding tools."
Write-Host "  4. Pick the Xuexitong mode, then say: take over the browser first"
Write-Host ""
Write-Host "Rollback:"
Write-Host "  .\install.ps1 -Rollback `"$backup`""
