# checkout server

Small Express service that does three things and nothing else:

- serves the static storefront (one origin, no CORS, no separate host for the API)
- creates and captures PayPal Orders v2 payments, sandbox or live
- emails a receipt for every completed capture

One environment file decides everything. `PAYPAL_MODE=sandbox` for testing, `PAYPAL_MODE=live` for real money.

## run

```bash
cd server
cp .env.example .env      # fill it in
npm install
npm start                 # http://localhost:3000
```

`npm run dev` restarts on file change.

If `.env` is incomplete the boot line names what is missing:

```
[boot] PAYPAL_MODE=sandbox — not ready, missing: PAYPAL_SANDBOX_CLIENT_ID, SMTP_USER, SMTP_PASS
```

The PayPal rail shows the same failure in the browser, so a half-configured deploy never looks like a working button.

## routes

| route | method | purpose |
|---|---|---|
| `/api/paypal/config` | GET | client ID, mode, amount — all the browser is allowed to know |
| `/api/paypal/order` | POST | creates a CAPTURE order for the server-side price |
| `/api/paypal/capture` | POST | captures, verifies, stores, mails |
| `/api/paypal/webhook` | POST | signature-verified backstop for missed captures |
| `/api/health` | GET | `{ ok, mode, price, currency }` |

The amount is never read from the request body. `isPaid()` compares the capture against `PRICE` and `CURRENCY` from the environment; anything else returns 402 and no mail.

## state

`data/orders.json` is keyed by PayPal capture ID. A capture and a racing webhook both call `claim()`; only the first one sends the email. Delete the file and you lose the de-duplication history, not the payments — PayPal keeps those.

## deploy

Any Node 20 host works. Render, Railway, Fly, or a VPS behind nginx.

1. Root directory: `server`.
2. Build: `npm install`. Start: `npm start`.
3. Set the same variables in the host's dashboard, not in a committed file. `PORT` is provided by most hosts.
4. `SITE_URL=https://yourdomain.com` so the webhook URL in the docs matches reality.
5. Mount a persistent volume at `server/data` if you want the de-dupe file to survive deploys. Without it the file resets on every deploy and a late webhook could re-send a receipt — annoying, not dangerous.
6. Point the domain at the app. Static files are served from the parent folder, so `index.html`, `checkout.html` and `js/` come along automatically.

## go live

```ini
PAYPAL_MODE=live
PAYPAL_LIVE_CLIENT_ID=...
PAYPAL_LIVE_SECRET=...
PAYPAL_LIVE_WEBHOOK_ID=...
```

Restart. `GET /api/health` should say `"mode":"live"`. The amber sandbox banner disappears. Run one real $3.00 purchase and refund it from the dashboard.

## email

Gmail SMTP needs an App Password, not the account password:

1. 2-Step Verification on.
2. `https://myaccount.google.com/apppasswords` → create one.
3. Paste the 16 characters into `SMTP_PASS`.

`MAIL_FROM` must be the authenticated Gmail account or Gmail rewrites it. When the domain mailbox exists, point `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` at it and change `MAIL_FROM` and `MAIL_TO`. Nothing else moves.

Google sometimes rate-limits or blocks SMTP from cloud IPs. If `[mail] verify failed` shows up on the host, move to a transactional sender (Resend, Postmark, Mailgun) — only `mailer.js` changes.

## files

```
src/env.js      environment parsing, mode switch, readiness check
src/paypal.js   token cache, order/capture, capture parsing, webhook verify
src/mailer.js   nodemailer transport, receipt template
src/orders.js   JSON store, atomic writes, idempotent claim
src/app.js      routes, static serving, throttle, boot
```
