# PayPal — sandbox first, then real money

Two phases, one switch. Phase 1 moves fake money and proves the whole chain. Phase 2 flips `PAYPAL_MODE=live` and takes real cards.

Read this once, then work top to bottom. Every field you have to fill in is in section 2.

---

## 1. What is actually happening

```
buyer clicks the gold button
   -> our server asks PayPal to create an order for $3.00
   -> PayPal returns an order id, browser shows the PayPal popup
   -> buyer logs in (sandbox account or real account) and approves
   -> our server captures the order
   -> server checks status + amount + currency
   -> server writes the sale to data/orders.json and emails the receipt
   -> page shows "Paid $3.00 — order confirmed"
```

The browser never sees your secret and never sends an amount. `server/.env` owns the price. If PayPal reports anything other than `COMPLETED` at exactly `USD 3.00`, the capture returns 402 and no email goes out.

Sandbox and live are the same code pointed at two different PayPal APIs:

| mode | API | money | where creds come from |
|---|---|---|---|
| `sandbox` | `api-m.sandbox.paypal.com` | fake | Apps & Credentials → **Sandbox** |
| `live` | `api-m.paypal.com` | real | Apps & Credentials → **Live** |

---

## 2. Every value you need to fill in

### 2.1 `server/.env`

Open `server/.env` (already created, empty secrets) and fill these. Nothing else needs touching.

| Variable | What goes in it | Where you get it |
|---|---|---|
| `PAYPAL_MODE` | `sandbox` now, `live` later | you type it |
| `PRICE` | `3.00` | already set |
| `CURRENCY` | `USD` | already set |
| `PAYPAL_SANDBOX_CLIENT_ID` | ~80 char `AX...` string | developer.paypal.com → Apps & Credentials → **Sandbox** → your app |
| `PAYPAL_SANDBOX_SECRET` | ~80 char `EL...` string | same app page, click **Show** under Secret |
| `PAYPAL_SANDBOX_WEBHOOK_ID` | ~20 char id, optional | sandbox app → **Webhooks** (only for the backstop) |
| `PAYPAL_LIVE_CLIENT_ID` | ~80 char `Ae...` string | same page, toggle to **Live** → your live app |
| `PAYPAL_LIVE_SECRET` | ~80 char `EL...` string | same |
| `PAYPAL_LIVE_WEBHOOK_ID` | ~20 char id | live app → **Webhooks** |
| `SMTP_USER` | `natevisionn@gmail.com` | already set |
| `SMTP_PASS` | 16 characters, no spaces | `myaccount.google.com/apppasswords` |
| `MAIL_FROM` | `natevisionn@gmail.com` | already set — must match `SMTP_USER` |
| `MAIL_TO` | `natevisionn@gmail.com` | change to `payments@yourdomain.com` later |
| `SITE_URL` | `http://localhost:3000` now, `https://odium.shop` live | you type it |

### 2.2 Things that are not in `.env`

| Item | Needed for | Note |
|---|---|---|
| PayPal account (personal is fine) | sandbox | free, 5 minutes |
| PayPal **Business** account, verified | live | upgrade inside paypal.com → "Upgrade to Business"; needs legal name, address, phone, and a bank or card to withdraw to |
| A public HTTPS host | live | Render / Railway / Fly / VPS. `localhost` cannot receive real click-to-pay traffic and cannot receive webhooks |
| `https://odium.shop` pointed at that host | live | so the webhook URL is real |
| Domain mailbox | later | only `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` / `MAIL_TO` change |

### 2.3 Sandbox test buyer (fake card included)

Created for you automatically by PayPal, but note the values because you will type them into the popup:

| Field | Value |
|---|---|
| Email | `sb-xxxxxxxx@personal.example.com` — see Testing Tools → Sandbox Accounts |
| Password | shown in **View/Edit account** (use **Reset password** if blank) |
| Balance | fake dollars, **Reset balance** in the same menu |
| Card number | `4111 1111 1111 1111` |
| Expiry | any future date, e.g. `12/2030` |
| CVV | any 3 digits, e.g. `123` |
| Name / billing | anything |

Sandbox does not validate cards. The balance path is the one that always works; the card path is for testing the guest-checkout look.

---

## 3. Phase 1 — sandbox (fake card, fake money)

### 3.1 Get the sandbox credentials

1. Go to `developer.paypal.com` and log in with the PayPal account that will eventually receive payments.
2. Top right: **Apps & Credentials**.
3. Make sure the toggle at the top says **Sandbox** (not Live).
4. **Create App** → name `retrac-sandbox` → App Type **Merchant** → **Create App**.
5. The new app page shows **Client ID** and **Secret**. Click **Show** next to the secret.
6. Copy both into `server/.env` as `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_SECRET`.

### 3.2 Get the sandbox buyer

1. Sidebar → **Testing Tools** → **Sandbox Accounts**.
2. There are two: one `BUSINESS` (you), one `PERSONAL` (the buyer). If not, **Create account** → type **Personal** → country your own → **Create**.
3. Click the `PERSONAL` one → **View/Edit account**. The email looks like `sb-abc123@personal.example.com`.
4. **Reset password** if no password is shown, and note it down.
5. **Reset balance** so the buyer has fake money to spend.

### 3.3 Gmail App Password

1. Google Account → **Security** → **2-Step Verification** must be **on** (App Passwords are hidden without it).
2. Go to `myaccount.google.com/apppasswords` → name it `Retrac` → **Create**.
3. Google shows 16 characters once. Paste them into `SMTP_PASS` with no spaces.

### 3.4 Run it

```powershell
cd server
npm install          # first time only
npm.cmd run check
```

`check` prints a preflight table. Before you fill anything in it looks like this:

```
  mode                  SANDBOX
  api                   https://api-m.sandbox.paypal.com
  price                 USD 3.00

  ✗ missing: PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_SECRET, SMTP_PASS
  RESULT: not ready — fix the ✗ lines above
```

After you fill in real sandbox values it looks like this:

```
  ✓ every required variable is set
  ✓ paypal auth ok (token valid 32400s, app APP-80W284485P519543T)
    -> these credentials belong to a SANDBOX app
  ✓ smtp auth ok (smtp.gmail.com:465)

  webhook url: http://localhost:3000/api/paypal/webhook
  local test : http://localhost:3000/checkout.html?method=paypal
  RESULT: ready to take a payment
```

A `✗ paypal auth failed: auth 401` means the id/secret pair is wrong or belongs to the other environment. A `✗ smtp failed: 535` means you used the account password instead of the App Password.

Then:

```powershell
npm.cmd start
```

`[boot]` should print:

```
[boot] Odium checkout on http://localhost:3000
[boot] paypal mode: sandbox — price USD 3.00
[boot] serving static from C:\...\getodium.shop
```

If it prints `not ready, missing: ...`, that list is exactly what `check` just told you.

### 3.5 Make the test purchase

1. Open `http://localhost:3000/checkout.html?method=paypal`.
2. You should see an amber banner: **Sandbox mode — no real money moves.**
3. Click the gold **PayPal** button. A popup opens with a small "Sandbox" tag in the header.
4. Log in with the `sb-...@personal.example.com` email and password.
5. **Pay Now**. (If the popup offers a card instead, use `4111 1111 1111 1111`, `12/2030`, `123`.)
6. The page swaps to a green card: **Paid $3.00 — order confirmed**, with the capture id under it.

### 3.6 Confirm the back end saw it

Two places, both should be true:

```
server/data/orders.json          # the sale, keyed by capture id
natevisionn@gmail.com inbox      # "[SANDBOX] Retrac paid — RET-XXXXXX — $3.00"
```

The email carries: order reference, amount, PayPal capture id, payer name, payer email, timestamp, and mode. That is everything you need to deliver the key by hand.

### 3.7 Sandbox troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| `PayPal is offline right now (paypal not configured)` | `.env` has no client id | paste sandbox id + secret, restart |
| `PayPal is offline right now (config 404)` | page served by a plain static server (port 8123) | use `npm.cmd start` on port 3000 |
| Button renders, click does nothing | sandbox account has no balance | **Reset balance** in Sandbox Accounts |
| `auth 401 / invalid_client` | live id pasted into sandbox slot (or reverse) | check the toggle on the developer page |
| `payment not completed` (402) | you cancelled, or the amount did not match | re-run; amount is fixed at `PRICE` |
| Green card but no email | `SMTP_PASS` missing/wrong | `npm.cmd run check`, expect `✓ smtp auth ok` |
| `535 Username and Password not accepted` | account password used | create an App Password |
| Green card, `emailed: false` in network tab | SMTP rejected at send time | server console has `[mail] ...`, same fix as above |

Sandbox money is fake. Never deliver a key off a sandbox run.

---

## 4. Phase 2 — real payments

### 4.1 Business account

1. Log in at `paypal.com` with the account that will hold the money.
2. **Settings → Account → Upgrade to Business** (free). Enter legal name, address, phone, business name, category.
3. **Verify** the account: confirm email, confirm phone, link a bank account or debit card for withdrawals. Without a linked bank you can accept money but cannot withdraw.
4. Set the **business name** that buyers see. This appears on their statement.

### 4.2 Live credentials

1. `developer.paypal.com` → **Apps & Credentials**.
2. Flip the toggle to **Live**.
3. **Create App** → `retrac-live` → Merchant → **Create**.
4. Copy **Client ID** and **Secret** into `PAYPAL_LIVE_CLIENT_ID` / `PAYPAL_LIVE_SECRET`.

Test them without touching real money:

```powershell
cd server
$env:PAYPAL_MODE='live'
npm.cmd run check
```

`✓ paypal auth ok ... -> these credentials belong to a LIVE app` means the pair is correct. Remove that env var afterwards (or just trust the restart in 4.6). No charge happens here — the token endpoint has no side effects.

### 4.3 Host it on HTTPS

The API must be reachable by the public internet. Any of these:

**Cloudflare Pages + Worker** (site stays where it is)
1. The site keeps living on Pages. The API is a separate Worker in `worker/`.
2. Follow `worker/README.md` — it lists every secret and where to paste it.
3. Paste the Worker URL into `js/config.js` → `payments.paypal.apiBase`.
4. Add the Pages domain to `CORS_ORIGIN` in `wrangler.toml`.
5. Email changes from Gmail SMTP to Resend there; Workers cannot open an SMTP socket.

**Render** (least setup if you are not on Cloudflare)
1. Push the repo to GitHub.
2. render.com → **New → Web Service** → pick the repo.
3. Root Directory: `server`. Build: `npm install`. Start: `npm start`.
4. Add every `.env` variable under **Environment** (do not commit `.env`).
5. Add a **Disk** mounted at `/opt/render/project/src/server/data` (or set the app's working dir to `server/data`) if you want `orders.json` to survive deploys.
6. Render gives you `https://name.onrender.com`. Free instances sleep; use a paid instance for a store.

**VPS** (cheapest long-term)
```bash
apt install -y nginx nodejs npm
# copy the project to /var/www/odium, then:
cd /var/www/odium/server && npm install
npm install -g pm2 && pm2 start src/app.js --name retrac && pm2 save
```
nginx proxy `odium.shop` → `127.0.0.1:3000`, then `certbot --nginx -d odium.shop`. Point DNS at the box.

**Test the webhook from your own machine** (no deploy needed):
```bash
cloudflared tunnel --url http://localhost:3000
```
It prints a `https://random.trycloudflare.com` URL — use that as the webhook URL while testing, and as `SITE_URL` if you want `check` to print a public link.

### 4.4 Domain and `SITE_URL`

```ini
SITE_URL=https://odium.shop
```

`SITE_URL` is used for the webhook URL the app prints and for links in the boot log. The site itself just needs to be served by the same app, which it is — `server/` serves the whole folder, so `index.html`, `checkout.html`, `js/` and `css/` come along.

### 4.5 Webhook (do this before you flip live)

Without it you still get an email on a normal capture. With it you get an email even when the buyer's browser dies mid-approval.

1. Live app → **Webhooks** → **Add Webhook**.
2. **Webhook URL**: `https://odium.shop/api/paypal/webhook`.
3. **Event types**: tick **Payment capture completed** (`PAYMENT.CAPTURE.COMPLETED`).
4. Save → copy the **Webhook ID**.
5. Paste into `PAYPAL_LIVE_WEBHOOK_ID`.

Sandbox has its own webhook list. Register `https://<tunnel>/api/paypal/webhook` there and paste into `PAYPAL_SANDBOX_WEBHOOK_ID` if you want to rehearse the backstop.

Unsigned, stale or mis-signed deliveries are rejected with 401 and never mail anything or touch `orders.json`. Rebroadcast test deliveries from the dashboard to check.

### 4.6 Flip it

```ini
PAYPAL_MODE=live
```

Restart. Verify:

```powershell
Invoke-WebRequest -UseBasicParsing https://odium.shop/api/health
# {"ok":true,"mode":"live","price":"3.00","currency":"USD"}
```

The amber sandbox banner disappears from the checkout pane. The same gold button now charges real cards.

### 4.7 First real purchase

1. Buy it yourself: `https://odium.shop/checkout.html?method=paypal` → real PayPal/credit card → pay $3.00.
2. Page shows the green confirmation card.
3. `natevisionn@gmail.com` receives `Retrac paid — RET-XXXXXX — $3.00` (no `[SANDBOX]` prefix).
4. `paypal.com` → **Activity** shows the payment as completed.
5. Refund it: click the transaction → **Refund** → full amount. You eat the fee on the original charge; that is the cost of the test.
6. Check `server/data/orders.json` has exactly one entry for that capture id.

That is the whole loop proven with real money.

---

## 5. Money maths at $3.00

PayPal's US standard commercial rate is roughly **2.99% + $0.49** per transaction:

```
$3.00  - (2.99% = $0.09) - $0.49  =  $2.42 net
```

For sub-$10 items PayPal offers **Micropayments** pricing, about **4.99% + $0.09**:

```
$3.00  - (4.99% = $0.15) - $0.09  =  $2.76 net
```

That is a third of a dollar more per sale. Turn it on under **Settings → Payments → Payment preferences → Micropayments** (approval required, and it applies to *all* transactions on the account, so do not enable it if you also invoice large amounts).

Other things that eat into it:
- International cards add ~1.5%, currency conversion ~3–4%.
- New accounts commonly see funds **held for up to 21 days** on first sales. It clears automatically as you build history.
- `$3.00` is above PayPal's $0.01 minimum, so no floor issues.

Operational note: PayPal's acceptable-use policy covers "items that violate another company's terms", and game-cheat sales is a category they enforce on. Practical handling — generic statement descriptor, withdrawals every few days rather than letting a balance sit, and a second rail (crypto/cash app) already on the page so a limitation never stops the store. That is what the four rails are for.

---

## 6. Final checklist

Sandbox:
- [ ] Sandbox app created, client id + secret in `.env`
- [ ] Sandbox `PERSONAL` account password reset, balance topped up
- [ ] Gmail App Password in `SMTP_PASS`
- [ ] `npm.cmd run check` → `RESULT: ready to take a payment`
- [ ] `npm.cmd start` → `[boot] paypal mode: sandbox`
- [ ] Fake $3.00 payment completes, green card appears
- [ ] `[SANDBOX]` email arrives
- [ ] `server/data/orders.json` has one entry

Live:
- [ ] Business account verified, bank linked
- [ ] Live app created, client id + secret in `.env`
- [ ] `PAYPAL_MODE=live` and `SITE_URL=https://odium.shop`
- [ ] Server deployed on HTTPS, all env vars set in the host dashboard
- [ ] `/api/health` returns `"mode":"live"`
- [ ] Live webhook registered for `PAYMENT.CAPTURE.COMPLETED`, id in `.env`
- [ ] One real $3.00 purchase, email received, refunded
- [ ] Micropayments pricing considered for the $3 price point
- [ ] `MAIL_TO` swapped to the domain mailbox when it exists

---

## 7. Where each thing lives

| I want to change... | File |
|---|---|
| price, currency, mode | `server/.env` |
| email sender/recipient, SMTP host | `server/.env` |
| email wording/template | `server/src/mailer.js` |
| what is written to `orders.json` | `server/src/orders.js` |
| routes, throttle, static serving | `server/src/app.js` |
| PayPal API calls | `server/src/paypal.js` |
| which mode the frontend expects | `js/config.js` → `payments.paypal.mode` |
| the checkout pane layout | `js/checkout.js`, `checkout.css` |
