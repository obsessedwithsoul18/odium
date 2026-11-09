# Cloudflare Worker — where every value goes

Short answer, because this is the actual question:

> **Nothing goes in the repo. Nothing goes in GitHub. Cloudflare Pages has no runtime.**
>
> - **Production:** Cloudflare dashboard → **Workers & Pages** → `retrac-api` → **Settings** → **Variables and Secrets** → **Add**. Anything ending in `SECRET`, `CLIENT_ID` or `API_KEY` gets type **Secret** (encrypted, unreadable after saving). Plain values (`PAYPAL_MODE`, `PRICE`, `CURRENCY`, `MAIL_TO`, `SITE_URL`, `CORS_ORIGIN`) can be plaintext **Variables**.
> - **Optional:** `wrangler secret put PAYPAL_SANDBOX_SECRET` from the CLI — same store, no dashboard clicking.
> - **Local dev:** a file called `.dev.vars` inside `worker/`, which `wrangler dev` reads. It is gitignored.
>
> Pages environment variables (Settings → Environment variables on the *Pages* project) are **build-time only**. They are not visible to the browser and they are not visible to this Worker. Putting a PayPal secret there does nothing except leak it into a build log.

---

## Why a Worker at all

Cloudflare Pages serves files. It cannot run `server/` — no Node, no filesystem, no SMTP, no long-lived process. So the payment backend has to be one of:

| Option | What lives where | Effort |
|---|---|---|
| **A. Pages + Worker (this folder)** | site on Pages, API on `retrac-api.workers.dev` | ~15 min, everything stays on Cloudflare |
| B. Pages + Render/Railway/Fly | site on Pages, `server/` on the other host | ~10 min, two vendors, SMTP email |
| C. One origin on a VPS | everything on one box behind nginx | most control, you maintain it |

This folder is option A. Three runtime substitutions, nothing else changes:

| Express version | Worker version |
|---|---|
| `data/orders.json` | **D1** (`INSERT OR IGNORE` = atomic de-dupe) |
| nodemailer + Gmail SMTP | **Resend** HTTP API |
| express routing | `fetch` handler |

---

## 1. Install and log in

```powershell
cd worker
npm install
npx wrangler login
```

A browser opens. Authorise the Cloudflare account that holds `odium.shop`.

## 2. Create the order table

```powershell
npx wrangler d1 create retrac-orders
```

It prints:

```
[[d1_databases]]
binding = "DB"
database_name = "retrac-orders"
database_id = "a1b2c3d4-5678-90ab-cdef-1234567890ab"
```

Paste that `database_id` into `wrangler.toml` over `REPLACE_WITH_D1_DATABASE_ID`, then create the table:

```powershell
npm run db:init
```

If `d1 create` says **"A database with that name already exists"**, you ran it twice — nothing is broken. Get the id with:

```powershell
npm run db:info
# or: npx wrangler d1 list
```

and paste that uuid into `wrangler.toml`. Until a real uuid is in there, `db:init` fails with `Invalid uuid` because the placeholder is being sent to the API.

## 3. Put the secrets in Cloudflare

Run these one at a time. Each prompts for the value and stores it encrypted.

```powershell
npx wrangler secret put PAYPAL_SANDBOX_CLIENT_ID
npx wrangler secret put PAYPAL_SANDBOX_SECRET
npx wrangler secret put PAYPAL_SANDBOX_WEBHOOK_ID
npx wrangler secret put PAYPAL_LIVE_CLIENT_ID
npx wrangler secret put PAYPAL_LIVE_SECRET
npx wrangler secret put PAYPAL_LIVE_WEBHOOK_ID
npx wrangler secret put RESEND_API_KEY
```

Or do the same in the dashboard: **Workers & Pages → retrac-api → Settings → Variables and Secrets → Add → type Secret**.

| Name | Type | Where the value comes from |
|---|---|---|
| `PAYPAL_SANDBOX_CLIENT_ID` | Secret | developer.paypal.com → Apps & Credentials → **Sandbox** app |
| `PAYPAL_SANDBOX_SECRET` | Secret | same page, **Show** |
| `PAYPAL_SANDBOX_WEBHOOK_ID` | Secret | sandbox app → Webhooks (optional backstop) |
| `PAYPAL_LIVE_CLIENT_ID` | Secret | same page, toggle **Live** |
| `PAYPAL_LIVE_SECRET` | Secret | same |
| `PAYPAL_LIVE_WEBHOOK_ID` | Secret | live app → Webhooks |
| `RESEND_API_KEY` | Secret | resend.com → API Keys → Create (`re_...`) |

## 4. Plain values

Already in `wrangler.toml` under `[vars]`, edit them there or in the dashboard as type **Variable**:

```toml
PAYPAL_MODE = "sandbox"        # flip to "live"
PRICE = "3.00"
CURRENCY = "USD"
BRAND_NAME = "Odium"
SITE_URL = "https://odium.shop"
MAIL_FROM = "onboarding@resend.dev"
MAIL_TO = "natevisionn@gmail.com"
CORS_ORIGIN = "https://odium.shop,https://www.odium.shop"
```

`CORS_ORIGIN` must list every origin that loads `checkout.html`. If you test on `https://your-project.pages.dev`, add it too.

## 5. Deploy

```powershell
npm run deploy
```

Prints something like:

```
https://retrac-api.your-subdomain.workers.dev
```

Check it:

```powershell
Invoke-WebRequest -UseBasicParsing https://retrac-api.your-subdomain.workers.dev/api/health
# {"ok":true,"mode":"sandbox","price":"3.00","currency":"USD"}
```

## 6. Point the site at the Worker

In `js/config.js`:

```js
paypal: {
  mode: "sdk",
  apiBase: "https://retrac-api.your-subdomain.workers.dev",
  ...
}
```

Commit, let Pages rebuild. The checkout pane goes from `no API on this domain` to the gold PayPal button.

## 7. Email through Resend

Gmail SMTP cannot be reached from a Worker, so receipts use Resend.

1. `resend.com` → sign up → **API Keys → Create** → copy `re_...` into `RESEND_API_KEY`.
2. Leave `MAIL_FROM = "onboarding@resend.dev"`. That address can send **only to the email on the Resend account** — which is exactly `natevisionn@gmail.com`, so testing works today with no domain.
3. Later, when `odium.shop` mail exists: Resend → **Domains → Add Domain** → add the DNS records it shows → change `MAIL_FROM` to `payments@odium.shop` and `MAIL_TO` to the same. Free tier is 3,000 emails/month, 100/day.

## 8. Local testing

```powershell
Copy-Item .dev.vars.example .dev.vars
# fill in the sandbox values
npx wrangler d1 execute retrac-orders --local --file schema.sql
npx wrangler dev
```

`wrangler dev` serves the Worker on `http://localhost:8787`. To exercise it from the Pages site locally you would need `apiBase` pointing at `http://localhost:8787` and `CORS_ORIGIN` including `http://127.0.0.1:8123`.

`.dev.vars` never leaves your machine.

## 9. Webhook

`https://retrac-api.your-subdomain.workers.dev/api/paypal/webhook`

Register it in the PayPal app for the matching environment, event **Payment capture completed**. Paste the id into `PAYPAL_SANDBOX_WEBHOOK_ID` / `PAYPAL_LIVE_WEBHOOK_ID` and redeploy. Unsigned deliveries get 401 and never mail anything.

## 10. Going live

```powershell
npx wrangler secret put PAYPAL_LIVE_CLIENT_ID
npx wrangler secret put PAYPAL_LIVE_SECRET
```

Then change `PAYPAL_MODE = "live"` in `wrangler.toml` (or the dashboard variable) and `npm run deploy`. `/api/health` should return `"mode":"live"`.

---

## Differences worth knowing- **Rate limiting** is not in the Worker code. Use **Security → WAF → Rate limiting rules**: path `/api/paypal/order`, 20 requests per minute per IP. The Express version has it in-process; the edge version belongs in the edge.
- **Token cache** is per isolate. A cold isolate costs one extra token call. Harmless.
- **D1 de-dupe** is atomic — two callers racing on the same capture id, only one gets `changes === 1`, so only one email goes out.
- **`ctx.waitUntil`** lets the webhook answer 200 immediately while the receipt is still sending. PayPal never sees a slow response.
- Everything the browser can see (`/api/paypal/config`) is the client id, mode, and the price. The secret never leaves Cloudflare.

## Files

```
wrangler.toml        vars, D1 binding, observability
src/index.js         routes, PayPal calls, D1 claim, Resend mail
schema.sql           orders table
.dev.vars.example    local secrets template (copy to .dev.vars)
```
