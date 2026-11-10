# Security model — getodium.shop

Last full pass: 10 November 2026. Scope: the Cloudflare Pages site (`/`), the
`retrac-api` Worker (`worker/`), the Discord bot (`bot/`), and the duplicate
Worker source (`licensing-worker/`).

Everything below is enforced in code, not in a checklist. Where a control
depends on a secret, a missing secret fails **closed** — the endpoint returns
`503 not_configured` rather than falling back to a public value.

---

## 1. Reported findings

| # | Finding | Status | Where it is fixed |
|---|---|---|---|
| 1 | `/mykey`, `/reset`, `/link` had no authentication | Fixed | `requireBot()` — constant-time compare of `X-Bot-Secret` against `BOT_SECRET`; `503` if unset, `401` on mismatch. Applied to `/link`, `/reset`, `/mykey`, `/ban`, `/api/diag` |
| 2 | Hardcoded loader secret fallback | Fixed | `verifySignature()` has no compiled-in default. Missing `LOADER_SECRET` → `503` from `/challenge` and `/auth`. Migration window is an explicit `LOADER_SECRET_LEGACY` secret, deletable |
| 3 | `/payload` skipped session binding | Fixed | `/payload` now enforces existence, ban flag, active-session match, session TTL, IP hash match and User-Agent hash match — identical to `/heartbeat` |
| 4 | Bot authentication effectively absent | Fixed | Bot refuses to start without a 16+ character `API_SECRET`; a 64-char secret is provisioned on both sides |
| 5 | Default HWID salt | Fixed | `saltedHwidHash()` throws without `HWID_SALT`; `/challenge` and `/auth` return `503` first. Production already had the secret set, so no customer hash changed |
| 6 | Webhook duplicate-license race | Fixed | `INSERT OR IGNORE` into `orders` is the lock. Only the delivery whose `meta.changes === 1` mints a key; every other delivery returns `{ok:true,dup:true}`. Key insert failure rolls the claim back so a retry can still fulfil |
| 7 | Discord OAuth had no `state` | Fixed in this site | `login.html` + `js/login.js` generate a 256-bit `state` per attempt (stored in `sessionStorage`) and send it with `prompt=consent` |

---

## 2. Additional hardening in this pass

### Worker — authentication and sessions

- Every shared secret compared with `safeEqual()`: constant time and
  length-blind, so no timing oracle reveals a prefix.
- Session tokens are **hashed at rest**. `sessions.token` and
  `licenses.active_session` hold `sha256(token)`; the raw token exists only in
  the loader's memory. A database dump cannot be replayed against the API.
- Challenge nonces are consumed with a conditional
  `UPDATE ... WHERE used_at IS NULL` and the `meta.changes === 1` check, so two
  parallel `/auth` requests cannot both spend the same nonce.
- `/challenge` refuses to issue a nonce when `LOADER_SECRET` or `HWID_SALT` is
  missing — no point handing out material that can never validate.
- `clientIp()` trusts only `CF-Connecting-IP`. `X-Forwarded-For` is ignored, so
  an attacker cannot rotate rate-limit buckets or IP bindings by setting a
  header.
- Two unawaited D1 promises (`logAuth` insert, challenge cleanup) were the cause
  of intermittent HTTP 1101 responses. Both are now awaited and swallowed; a
  non-essential write can no longer take a request down.

### Worker — input handling

- `readJson()` enforces a body ceiling before parsing (2–4 KB per endpoint, 16 KB
  globally in the router) and returns `413` instead of buffering an attacker's
  payload.
- Allow-list regexes on every identifier: `LICENSE_KEY`, `DISCORD_ID`,
  `BUILD_NAME`, `EMAIL`, `PAYPAL_ORDER_ID`, `RET-XXXXXX` references,
  `site-preference` JSON capped at 4 KB.
- `build` is validated against `^[A-Za-z0-9._-]{1,64}$` **before** it reaches the
  `payloads/${build}.bin` R2 key, so no traversal is possible even if a row were
  ever added by hand.
- All D1 access is parameterised; no string interpolation reaches SQL.

### Worker — disclosure

- `/api/diag` is bot-gated and returns booleans and lengths only — no client-ID
  prefix, no mail addresses, no secret names.
- Uncaught errors return `{error:"internal error"}`. Stack traces, PayPal
  response bodies and Resend errors stay in `console.error`.
- `Cache-Control: no-store` on every JSON response.
- Security headers on every Worker response: `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`,
  HSTS `max-age=63072000; includeSubDomains`.

### Worker — CORS

- The `*` branch is gone from `corsHeaders()`. A literal `*` in `CORS_ORIGIN` is
  filtered out, so a typo can never turn the API into a public endpoint.
- The `https://*.pages.dev` wildcard was removed from `CORS_ORIGIN`; any
  attacker-controlled `*.pages.dev` site could previously call the API from a
  browser.
- `Access-Control-Allow-Origin` is echoed only for the exact allow-listed
  origins (`getodium.shop`, `www.getodium.shop`, localhost).

### Worker — payments

- `/api/paypal/order` and `/api/paypal/capture` validate the reference and order
  ID shapes before calling PayPal, and are rate-limited per IP.
- Capture amounts and currency are checked against `PRICE`/`CURRENCY`; the
  `orders` table is claimed atomically (`INSERT OR IGNORE` + `changes === 1`) so
  a replayed capture cannot mint a second key.
- PayPal webhook signatures are verified with the configured webhook ID, and a
  missing `PAYPAL_*_WEBHOOK_ID` disables that path rather than trusting the body.

### Site — Cloudflare Pages

- `_headers` applies HSTS (2 years, `includeSubDomains`), `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  a `Permissions-Policy` that closes camera/mic/geolocation/USB/serial, COOP,
  CORP, and a CSP with `base-uri 'none'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `worker-src 'none'`, and an explicit
  `form-action`/`connect-src` allow list (`*.paypal.com` retained for sandbox).
- No inline `<script>` anywhere: CSP forbids it, so an injected script tag is
  inert even if a page ever echoes user input. `login.html` was rewritten to
  load `js/login.js` for exactly this reason.
- `dist/` is rebuilt from an allow list of extensions; `.env`, `.dev.vars`,
  `worker/`, `bot/`, `server/`, `tools/` and `.legacy.js` files are never
  published.

### Bot

- Refuses to start without a 16+ character `API_SECRET` and a `https://`
  `API_BASE` (localhost http allowed for development only).
- Every request carries an 8-second `AbortSignal.timeout`, so a hung Worker
  cannot stall the gateway connection.
- Ignores interactions from other bots and refuses to answer in DMs where the
  reply could be relayed by a third-party client.
- All replies are ephemeral.

### Repository

- `.env` and `.dev.vars` are gitignored at every level; `git ls-files` shows no
  secret-bearing file tracked.
- A malformed Discord-token-shaped **secret name** existed on the Worker. It was
  deleted, so the value no longer appears anywhere in the deployment config.
- `licensing-worker/src/index.js` was synced byte-for-byte with
  `worker/src/index.js`, so the stale copy cannot be deployed with the old
  holes. Its `wrangler.toml` still carries a placeholder D1 ID — that Worker is
  not deployed.

---

## 3. Deliberate non-goals

- **No CAPTCHA or bot-detection on checkout.** PayPal's own risk engine handles
  card testing; adding a challenge would cost conversions for a $3 product.
- **No WAF rules in this repo.** Cloudflare's managed rules live in the
  dashboard. Rate limits in the Worker are per-isolate, best-effort, and are the
  backstop for application-level abuse, not DDoS.
- **`POST /webhook` stays disabled (503)** until `WH_SECRET` is set. The live
  fulfilment path is `POST /api/paypal/capture`, which does not depend on it.

---

## 4. Outstanding operator actions

1. Rebuild the loader against the new `LOADER_SECRET`, then
   `npx wrangler secret delete LOADER_SECRET_LEGACY`. Until that happens the old
   public value is still honoured — by explicit configuration, not by a code
   default.
2. Add the missing `rsend` CNAME (`rsend` → `send.forge.rmta.net`) in Cloudflare
   DNS so Resend leaves `partially_verified`. Sending already works.
3. Rotate `DISCORD_BOT_TOKEN` if it was ever pasted anywhere outside
   `bot/.env`.
4. The OAuth callback lives on `goodnight.llc`, a separate deployment. It must
   compare the returned `?state=` with the value this site stores under
   `odium_oauth_state`; otherwise the parameter is decoration. Moving the
   callback to `getodium.shop` would let both halves live in this repo.
