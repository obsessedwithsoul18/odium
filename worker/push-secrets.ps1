# Pushes every value in worker/.dev.vars to Cloudflare as encrypted secrets.
#
#   .\push-secrets.ps1          # first run creates .dev.vars and tells you to fill it
#   .\push-secrets.ps1 -Edit    # opens .dev.vars in notepad
#   .\push-secrets.ps1          # again, after filling -> uploads + verifies
#
# .dev.vars is gitignored. This script never prints a secret value.

param([switch]$Edit)

$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot

$vars = Join-Path $PSScriptRoot ".dev.vars"
$example = Join-Path $PSScriptRoot ".dev.vars.example"

if (-not (Test-Path $vars)) {
  Copy-Item $example $vars
  Write-Host ""
  Write-Host "Created $vars" -ForegroundColor Green
  Write-Host "Fill in these three, then run this script again:"
  Write-Host "  PAYPAL_SANDBOX_CLIENT_ID   (developer.paypal.com -> Apps & Credentials -> Sandbox app)"
  Write-Host "  PAYPAL_SANDBOX_SECRET      (same app, Show)"
  Write-Host "  RESEND_API_KEY             (resend.com -> API Keys)"
  if ($Edit) { Start-Process notepad $vars }
  else { Write-Host ""; Write-Host "Open it with:  .\push-secrets.ps1 -Edit" -ForegroundColor DarkGray }
  exit 0
}

if ($Edit) { Start-Process notepad $vars; exit 0 }

$raw = Get-Content $vars

# Only keys that actually carry a value get uploaded. An empty line must never
# become an empty secret — that is what makes the endpoint answer 503 later.
$pairs = @()
$present = @{}
foreach ($line in $raw) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $i = $line.IndexOf('=')
  $k = $line.Substring(0, $i).Trim()
  $v = $line.Substring($i + 1).Trim()
  if ($k -and $v) {
    $pairs += "$k=$v"
    $present[$k] = $true
  }
}

$needed = @("PAYPAL_SANDBOX_CLIENT_ID", "PAYPAL_SANDBOX_SECRET")
$missing = @($needed | Where-Object { -not $present.ContainsKey($_) })

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "Still empty in worker\.dev.vars: $($missing -join ', ')" -ForegroundColor Yellow
  Write-Host "Fill them in with:  .\push-secrets.ps1 -Edit" -ForegroundColor DarkGray
  Write-Host "Nothing was uploaded." -ForegroundColor DarkGray
  exit 1
}

$tmp = Join-Path $env:TEMP "retrac-secrets-$PID.json"
$json = @{}
foreach ($p in $pairs) {
  $i = $p.IndexOf('=')
  $json[$p.Substring(0, $i)] = $p.Substring($i + 1)
}
$json | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding UTF8

Write-Host "Uploading $($pairs.Count) secret(s) from .dev.vars ..." -ForegroundColor Cyan
npx.cmd wrangler secret bulk $tmp
$code = $LASTEXITCODE
Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue

if ($code -ne 0) {
  Write-Host "Upload failed. Run: npx wrangler whoami" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Secrets on the worker now:" -ForegroundColor Cyan
npx.cmd wrangler secret list

# Work out the API host from config.js and confirm the endpoint answers.
$configPath = Join-Path (Split-Path $PSScriptRoot -Parent) "js\config.js"
$apiBase = "https://retrac-api.natevisionn.workers.dev"
if (Test-Path $configPath) {
  $m = [regex]::Match((Get-Content $configPath -Raw), 'apiBase:\s*"([^"]*)"')
  if ($m.Success -and $m.Groups[1].Value) { $apiBase = $m.Groups[1].Value.TrimEnd("/") }
}

Write-Host ""
Write-Host "Checking $apiBase/api/paypal/config ..." -ForegroundColor Cyan
try {
  $res = Invoke-WebRequest -UseBasicParsing "$apiBase/api/paypal/config" -TimeoutSec 20
  Write-Host "  OK  $($res.Content)" -ForegroundColor Green
  Write-Host ""
  Write-Host "PayPal is live. Reload checkout.html?method=paypal - the gold button should appear." -ForegroundColor Green
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Write-Host "  FAILED  status $code" -ForegroundColor Red
  Write-Host "  503 = client id still missing on the worker"
  Write-Host "  401 = wrong id/secret, or a live id in the sandbox slot"
  exit 1
}
