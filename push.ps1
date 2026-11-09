# One-shot sync: rebuilds dist/, stages everything, commits, pushes.
#
#   .\push.ps1
#   .\push.ps1 -Message "add stripe link"
#
# .env, .dev.vars, node_modules and server/data are gitignored and never get staged.

param([string]$Message = "")

$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path ".git")) {
  Write-Host "No git repo here. Run: git init -b main ; git remote add origin <url>" -ForegroundColor Red
  exit 1
}

# dist/ is what Cloudflare Pages may serve. Regenerate it so the deployed
# bundle never lags behind the source files.
if (Test-Path "scripts/build-pages.mjs") {
  node scripts/build-pages.mjs | Out-Null
  Write-Host "dist/ rebuilt" -ForegroundColor DarkGray
}

git add -A

$status = @(git status --porcelain)
if ($status.Count -eq 0) {
  Write-Host "Nothing to push - working tree is clean." -ForegroundColor Yellow
  exit 0
}

$count = $status.Count
if (-not $Message) {
  $Message = "update $count file(s) - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
}

git commit -q -m $Message
if ($LASTEXITCODE -ne 0) {
  Write-Host "Commit failed." -ForegroundColor Red
  exit 1
}

git push 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "Retrying with upstream set..." -ForegroundColor DarkGray
  git push -u origin main 2>&1 | Out-Host
}

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "Pushed $count file(s)." -ForegroundColor Green
  git log --oneline -1
} else {
  Write-Host "Push failed - check the remote name and your credentials." -ForegroundColor Red
  exit 1
}
