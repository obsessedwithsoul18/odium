# Puts the two PayPal credentials on the Worker and turns the rail on.
#
#   .\paypal-keys.ps1                 # sandbox  (fake money, fake cards)
#   .\paypal-keys.ps1 -Live           # live     (real money)
#
# Paste both values when asked. They go into .dev.vars (gitignored), then to
# Cloudflare as encrypted secrets. Nothing is written into the repo.

param([switch]$Live)

$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot

$mode = if ($Live) { "live" } else { "sandbox" }
$idKey = if ($Live) { "PAYPAL_LIVE_CLIENT_ID" } else { "PAYPAL_SANDBOX_CLIENT_ID" }
$secKey = if ($Live) { "PAYPAL_LIVE_SECRET" } else { "PAYPAL_SANDBOX_SECRET" }

Write-Host ""
Write-Host "PayPal $mode" -ForegroundColor Cyan
Write-Host "  developer.paypal.com -> Apps & Credentials -> toggle $mode -> the app -> Client ID + Secret"
Write-Host ""

$clientId = (Read-Host "Client ID").Trim()
$secret = (Read-Host "Secret").Trim()

if ($clientId.Length -lt 20 -or $secret.Length -lt 20) {
  Write-Host "That does not look like a PayPal key pair. Nothing changed." -ForegroundColor Red
  exit 1
}
if ($clientId -match '\s' -or $secret -match '\s') {
  Write-Host "Whitespace inside the values - re-copy them. Nothing changed." -ForegroundColor Red
  exit 1
}

# --- .dev.vars: local copy, gitignored ----------------------------------------
$vars = Join-Path $PSScriptRoot ".dev.vars"
if (-not (Test-Path $vars)) { Copy-Item (Join-Path $PSScriptRoot ".dev.vars.example") $vars }

$text = [System.IO.File]::ReadAllText($vars)
foreach ($pair in @(@($idKey, $clientId), @($secKey, $secret))) {
  $pattern = "(?m)^\s*$([regex]::Escape($pair[0]))\s*=.*$"
  if ($text -match $pattern) {
    $text = [regex]::Replace($text, $pattern, "$($pair[0])=$($pair[1])")
  } else {
    $text = $text.TrimEnd() + "`n$($pair[0])=$($pair[1])`n"
  }
}
[System.IO.File]::WriteAllText($vars, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Saved to .dev.vars" -ForegroundColor DarkGray

# --- Cloudflare secrets -------------------------------------------------------
$tmp = Join-Path $env:TEMP "retrac-paypal-$PID.json"
@{ $idKey = $clientId; $secKey = $secret } | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding UTF8
Write-Host "Uploading secrets ..." -ForegroundColor Cyan
npx.cmd wrangler secret bulk $tmp
$code = $LASTEXITCODE
Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { Write-Host "Upload failed. Run: npx wrangler whoami" -ForegroundColor Red; exit 1 }

# --- mode in wrangler.toml ----------------------------------------------------
$toml = Join-Path $PSScriptRoot "wrangler.toml"
$raw = [System.IO.File]::ReadAllText($toml)
$new = [regex]::Replace($raw, '(?m)^PAYPAL_MODE\s*=\s*"[^"]*"', "PAYPAL_MODE = `"$mode`"")
if ($new -ne $raw) {
  [System.IO.File]::WriteAllText($toml, $new, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "PAYPAL_MODE set to $mode" -ForegroundColor DarkGray
}

# --- deploy -------------------------------------------------------------------
Write-Host "Deploying ..." -ForegroundColor Cyan
npm.cmd run deploy
if ($LASTEXITCODE -ne 0) { Write-Host "Deploy failed." -ForegroundColor Red; exit 1 }

# --- verify -------------------------------------------------------------------
$configPath = Join-Path (Split-Path $PSScriptRoot -Parent) "js\config.js"
$apiBase = "https://retrac-api.natevisionn.workers.dev"
if (Test-Path $configPath) {
  $m = [regex]::Match((Get-Content $configPath -Raw), 'apiBase:\s*"([^"]*)"')
  if ($m.Success -and $m.Groups[1].Value) { $apiBase = $m.Groups[1].Value.TrimEnd("/") }
}

Write-Host ""
Write-Host "Checking $apiBase/api/paypal/config ..." -ForegroundColor Cyan
$ok = $false
for ($i = 1; $i -le 6; $i++) {
  try {
    $res = Invoke-WebRequest -UseBasicParsing "$apiBase/api/paypal/config" -TimeoutSec 20
    Write-Host "  OK  $($res.Content)" -ForegroundColor Green
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 3
  }
}

if (-not $ok) {
  Write-Host "  still failing after 6 tries" -ForegroundColor Red
  Write-Host "  check: npx wrangler secret list   (expect $idKey and $secKey)" -ForegroundColor DarkGray
  exit 1
}

$site = Join-Path (Split-Path $PSScriptRoot -Parent) "checkout.html"
Write-Host ""
Write-Host "PayPal is live in $mode mode." -ForegroundColor Green
Write-Host "Test it: https://getodium.shop/checkout.html?method=paypal" -ForegroundColor Green
if (-not $Live) {
  Write-Host "  sandbox buyer: natevisionn-personal@example.com  /  password: (your sandbox test account)" -ForegroundColor DarkGray
  Write-Host "  sandbox card : 4111 1111 1111 1111  exp 12/2030  cvv 123" -ForegroundColor DarkGray
}
