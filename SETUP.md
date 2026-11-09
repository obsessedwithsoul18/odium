# Setup — Retrac storefront

Everything you need to go from "source you bought" to "store that sells one thing, paid four ways, with your name on it."

Current state: **one product** (Retrac External, $3.00 lifetime), **four payment rails** (crypto, PayPal, Cash App, Stripe), no tiers, no premium add-on, no Robux, no gift cards, no reseller page.

---

## 1. File map

| File | What it does |
|---|---|
| `index.html` | Storefront: hero, features, FAQ, single pricing card, founder card |
| `checkout.html` | Payment page — method tabs, order reference, copy buttons |
| `tos.html` | Terms of Service |
| `policy.html` | Privacy Policy |
| `login.html` | Discord OAuth redirect into the dashboard |
| `js/config.js` | **Every brand detail, price and payout destination** |
| `js/checkout.js` | Renders the payment rails from config, generates order refs |
| `js/home.js` | Nav state, FAQ tabs, FAQ accordion, preview tilt (rewritten, readable) |
| `js/home.legacy.js` | The old obfuscated bundle, quarantined and unreferenced |
| `js/discord-status.js` | Live Discord presence for the founder card |
| `checkout.css` / `legal.css` | Styles for the new pages, extends `home.css` |
| `server/` | Optional Node backend: PayPal orders, capture, receipt email |
| `SETUP.md` | This document |

Nothing is built. Open `index.html` through any static host or a local server (`python -m http.server 8123`) and it runs. The `server/` folder is only needed for PayPal Smart Buttons — `cd server && npm install && npm start` serves the same site on port 3000 with the API attached.

---

## 2. The one file that matters

`js/config.js` holds the whole storefront. Edit it, reload, done.

```js
window.RETRAC_CONFIG = {
  brand: {
    siteName, productName, productTagline,
    domain, origin, discordInvite,
    supportDiscord, supportEmail, founderDisplay
  },
  product: {
    id, price, currency, priceLabel,
    orderPrefix, deliveryWindow, includes: [...]
  },
  payments: { crypto: {...}, paypal: {...}, cashapp: {...}, stripe: {...} }
};
```

Change `product.price` and the hero, the card and all four checkout buttons follow it. `includes` is the checklist on the pricing card and the order summary. `priceLabel` is the only string you must update by hand if you change the price (it is used on the hero button).

Each rail has `enabled`. Set it to `false` and the tab disappears from the checkout page.

---

## 3. Crypto — set it up from zero

Two ways to take crypto: **hosted invoice** (recommended) or **your own addresses** (manual). Both are supported by `payments.crypto.mode`.

### Option A — hosted invoice (auto-detected, no manual matching)

Use NOWPayments as the example; Coinbase Commerce works the same way.

1. Sign up at `nowpayments.io`, complete KYC with the entity you want payouts under.
2. **Dashboard → Settings → Payments**: add the coins you want to accept (BTC, ETH, LTC, USDT-TRC20, USDT-ERC20, SOL, XMR). Remove the rest — an invoice page with 60 coins looks like a scam.
3. **Dashboard → Store → API keys**: copy the API key. Copy the **IPN secret** too, it is on the same page.
4. Create one **static invoice link** for the product:
   - Dashboard → Invoices → New invoice → amount `3.00`, currency `USD`, description `Retrac External — lifetime license`.
   - Copy the link, paste it into `js/config.js`:

```js
crypto: {
  mode: "invoice",
  invoiceUrl: "https://nowpayments.io/payment/?iid=YOUR_INVOICE_ID",
  ...
}
```

5. Buyers open the invoice, pick a coin, pay, and the invoice attaches the amount and reference for you. You confirm in the dashboard and hand over the key.

**Do not** hardcode a static *address* per coin if you can avoid it — a buyer who sends the wrong chain loses the money and blames you.

### Option B — your own addresses (manual confirmation)

```js
crypto: {
  mode: "address",
  addresses: {
    BTC: "bc1q...",
    ETH: "0x...",
    LTC: "ltc1q...",
    USDT_TRC20: "T...",
    SOL: "...",
    XMR: "4..."
  },
  confirmations: "1 confirmation (BTC/ETH 3 confs) before key release"
}
```

The checkout page hides any address still containing `REPLACE`. Rules that keep this sane:

- One address per chain, never reused across products.
- BTC: confirm at 1, release at 3. ETH/USDT-ERC20: 12 blocks is the honest number, 3 is the practical one. USDT-TRC20: 1 block, ~1 minute.
- XMR is irreversible and private — require the TXID in the ticket, not a screenshot.
- Amount must match exactly; a `44.87` arrival is a partial payment, not a rounding error.

### Automating key delivery (optional)

The manual flow is: buyer pays → opens a ticket with `RET-XXXXXX` → you check the explorer → you issue the key. That is fine at low volume. To automate, listen for the processor's callback and issue the key yourself:

```js
// webhook.js — node 20+, no dependencies beyond built-ins
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

function verify(rawBody, signature) {
  const digest = createHmac("sha512", SECRET).update(JSON.stringify(JSON.parse(rawBody))).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature || "", "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((req, res) => {
  if (req.method !== "POST") return res.writeHead(405).end();

  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    if (!verify(body, req.headers["x-nowpayments-sig"])) {
      return res.writeHead(401).end("bad signature");
    }
    const event = JSON.parse(body);
    if (event.payment_status === "finished" || event.payment_status === "confirmed") {
      const reference = event.order_id;            // your RET-XXXXXX
      await issueKey(reference, event.price_amount); // your key table
    }
    res.writeHead(200).end("ok");
  });
}).listen(8081);
```

Point the processor's IPN URL at `https://your-host/webhook`, put the secret in the environment, and make `issueKey` idempotent — processors retry callbacks.

---

## 4. PayPal

There are two ways to take PayPal here. Both live in `js/config.js` under `payments.paypal.mode`.

| mode | what it does | needs a server | sandbox |
|---|---|---|---|
| `sdk` | Smart Buttons, order created and captured server side, receipt emailed | yes (`server/`) | yes |
| `link` | `paypal.me` link with the amount baked in, matched by note | no | **no** — paypal.me is live only |
| `email` | prints the address with a copy button | no | no |

`sdk` is the default because it is the only one that confirms a payment on its own and mails you the receipt.

### 4.1 Developer account and the two apps

1. Sign in at `developer.paypal.com` with the **Business** account that receives the money (personal accounts get limited for digital goods).
2. **Apps & Credentials → Sandbox → Create App**, name it `retrac-sandbox`. Copy the **Client ID** and **Secret**.
3. Switch the toggle at the top to **Live → Create App**, name it `retrac-live`. Copy that Client ID and Secret too.
4. You now hold four values. Sandbox ones are for testing and cost nothing; live ones move real money.

### 4.2 Sandbox buyer accounts

1. **Testing Tools → Sandbox Accounts**. Two are created for you: one `PERSONAL` (the buyer) and one `BUSINESS` (you).
2. Click the personal one → **View/Edit account** to see the email and password. That login is what you use on the PayPal popup during testing.
3. Click **Reset balance** if it hits zero — sandbox money is free.

### 4.3 Environment

```bash
cd server
cp .env.example .env
npm install
npm start          # http://localhost:3000
```

Fill `.env`:

```ini
PAYPAL_MODE=sandbox
PRICE=3.00
CURRENCY=USD
PORT=3000
SITE_URL=http://localhost:3000

PAYPAL_SANDBOX_CLIENT_ID=AXxxxxxxxxxxxxxxxxxxxxxxxxx
PAYPAL_SANDBOX_SECRET=ELxxxxxxxxxxxxxxxxxxxxxxxxxx
PAYPAL_SANDBOX_WEBHOOK_ID=

PAYPAL_LIVE_CLIENT_ID=
PAYPAL_LIVE_SECRET=
PAYPAL_LIVE_WEBHOOK_ID=
```

`server/` serves the whole site, so `npm start` replaces `python -m http.server`. The site and the API are on one origin and `apiBase: ""` in `js/config.js` just works.

Boot output tells you what is missing:

```
[boot] PAYPAL_MODE=sandbox — not ready, missing: PAYPAL_SANDBOX_CLIENT_ID, SMTP_USER, SMTP_PASS
```

The PayPal rail shows the same thing in the browser instead of a dead button.

### 4.4 Payment email

Sender and recipient are both `natevisionn@gmail.com` for now.

1. Google Account → **Security → 2-Step Verification** must be **on**.
2. `myaccount.google.com/apppasswords` → create one named `Retrac`. Google shows 16 characters once.
3. Paste into `SMTP_PASS` — not the account password, Gmail rejects that outright.
4. `MAIL_FROM` stays `natevisionn@gmail.com` (Gmail overrides a mismatched From). `MAIL_TO` is where receipts land.

When the domain mailbox exists:

```ini
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=465
SMTP_USER=payments@yourdomain.com
SMTP_PASS=the-mailbox-password
MAIL_FROM=payments@yourdomain.com
MAIL_TO=payments@yourdomain.com
```

Nothing in the code changes. The mail template already prints order ref, amount, capture ID, payer and mode.

### 4.5 Test the sandbox flow

1. `npm start`, open `http://localhost:3000/checkout.html?method=paypal`.
2. The pane shows an amber **Sandbox mode** banner and the gold PayPal button.
3. Click it → sign in with the sandbox `PERSONAL` account → **Pay Now**.
4. The page swaps to a green **Paid $3.00 — order confirmed** card with the capture ID.
5. `natevisionn@gmail.com` receives `[SANDBOX] Retrac paid — RET-XXXXXX — $3.00`.

Sandbox money is fake, so do not ship keys off a sandbox run.

### 4.6 Go live

1. Fill `PAYPAL_LIVE_CLIENT_ID` and `PAYPAL_LIVE_SECRET`.
2. Flip one line: `PAYPAL_MODE=live`.
3. Restart. `GET /api/health` should read `{"ok":true,"mode":"live","price":"3.00"}`.
4. Panes stop showing the sandbox banner. The same button now charges real cards.
5. Do one $3.00 purchase yourself and refund it from the PayPal dashboard to prove the path end to end.

### 4.7 Webhook (recommended once live)

The capture route emails you, but a closed tab or a dropped response can lose that. The webhook is the backstop and it is idempotent — a sale is emailed once no matter which route reports it.

1. Deploy the server on HTTPS first (`SITE_URL=https://odium.shop`).
2. **Apps & Credentials → your live app → Webhooks → Add**.
3. URL: `https://odium.shop/api/paypal/webhook`.
4. Event: **Payment capture completed** (`PAYMENT.CAPTURE.COMPLETED`).
5. Copy the Webhook ID into `PAYPAL_LIVE_WEBHOOK_ID` and restart.
6. Sandbox has its own webhook list; same steps, paste into `PAYPAL_SANDBOX_WEBHOOK_ID`.

Unsigned or mis-signed deliveries are rejected with 401 and never mail anything.

### 4.8 API routes

| route | purpose |
|---|---|
| `GET /api/paypal/config` | client ID, mode, amount — the only thing the browser is allowed to know |
| `POST /api/paypal/order` | creates a CAPTURE order for `PRICE` |
| `POST /api/paypal/capture` | captures, verifies amount and currency, mails the receipt |
| `POST /api/paypal/webhook` | signature-verified backstop |
| `GET /api/health` | mode, price, currency |

The amount always comes from the server. A tampered `3.00` in the browser cannot become `0.01` — capture fails `isPaid()` and returns 402.

### 4.9 No-server fallback

Stop the server and switch back:

```js
paypal: {
  mode: "link",
  link: "https://paypal.me/yourhandle/3.00",
  email: "payments@yourdomain.com",
  note: "Send as Goods & Services and put your order reference in the note."
}
```

`paypal.me` and `email` have no sandbox. They are live-only and matched by hand from the note field. Goods & Services is the correct category — it is the only one that gives buyer protection, and refusing it is the fastest route to disputes. Fees run about 3.49% + $0.49 cross-border.


---

## 5. Cash App

1. Pick a `$cashtag` that is not obviously tied to your personal name.
2. Build the link with the amount:

```js
cashapp: {
  cashtag: "$yourcashtag",
  link: "https://cash.app/$yourcashtag/3.00",
  note: "Put your order reference in the payment note."
}
```

3. Cash App is US-only and personal-account based. Large volumes on a personal account get flagged; if this becomes real revenue, move it behind a business bank account and consider a processor instead.
4. There is no API and no webhook. Confirmation is you opening the app. Treat the order reference in the note as the only evidence.

---

## 6. Stripe (replaces the reseller page)

1. Create the account at `stripe.com`, complete business verification.
2. **Products → Add product**: name `Retrac External`, one-time price `3.00 USD`.
3. **Payment Links → New**: pick that price, quantity fixed at 1, collect email, enable Apple Pay / Google Pay / Link under payment methods.
4. Optional but worth it: Settings → Checkout → add your domain, and Settings → Branding → upload `logo.png` so the checkout page matches the site.
5. Copy the link:

```js
stripe: {
  paymentLink: "https://buy.stripe.com/xxxxxxxx",
  checkoutEndpoint: ""
}
```

6. Stripe takes 2.9% + $0.30 on domestic cards, 3.9% + $0.30 on international, plus 1.5% for currency conversion. Payouts land on a rolling 2-day schedule for new accounts.

Stripe reviews new accounts before the link goes live, and it does not like digital goods that violate a platform's terms. If the link is disabled, the account is the problem, not the code — the checkout page will show a "Stripe link not set" notice until a working link is pasted in.

---

## 7. How an order actually flows

**PayPal (`mode: "sdk"`, server running)**

1. Buyer lands on `index.html`, clicks **Buy now — $3.00**.
2. `checkout.html` generates a reference like `RET-7F3K9Q` and stores it in `sessionStorage` so a reload keeps it.
3. Buyer opens the PayPal tab and clicks the gold button.
4. `POST /api/paypal/order` creates a CAPTURE order for the server-side `PRICE`, carrying the reference as `custom_id`.
5. Buyer approves. `POST /api/paypal/capture` captures, checks status + amount + currency, writes the sale to `server/data/orders.json` once, and mails the receipt.
6. The page swaps to the green confirmation card. You deliver the key from the email.

**Crypto / Cash App / Stripe (`link` and `invoice` modes)**

1–2 same. Then: buyer pays with the reference in the note, opens a Discord ticket with the reference and a screenshot, you match it and issue the key.

Everything the buyer needs is on the checkout page. PayPal is the only rail that confirms itself; the other three are matched by hand, and that is intentional at this volume.

---

## 8. Replacing every detail that is not yours

The storefront domain is now `getodium.shop`. Confirm account-specific values below before publishing.

### 8.1 Config

| Field | Current | Replace with |
|---|---|---|
| `brand.siteName` | Odium | your store name |
| `brand.productName` | Retrac External | your product name (or keep it) |
| `brand.domain` / `origin` | getodium.shop | `getodium.shop` / `https://getodium.shop` |
| `brand.discordInvite` | discord.gg/odium | your server invite |
| `brand.supportDiscord` | dx5c | your handle |
| `brand.supportEmail` | support@getodium.shop | create/forward this mailbox or change it to an address you read |
| `brand.founderDisplay` | dx5c | your display name |
| `payments.*` | `REPLACE_*` placeholders | the values from sections 3–6 |

### 8.2 Hardcoded outside config

| File | Line / selector | What it is |
|---|---|---|
| `js/discord-status.js` | `const userId = "1142998777364484107"` | Discord account whose presence shows on the founder card |
| `login.html` | `client_id=1436665568118706247` | OAuth app client ID |
| `login.html` | `redirect_uri=https%3A%2F%2Fgoodnight.llc%2Fcallback` | must point at **your** callback URL |
| `index.html` | founder card `<img id="discordAvatar">`, `<p class="ceo-founder-name">dx5c</p>` | avatar fallback and name |
| `index.html` | `href="https://discord.gg/odium"` | hero Discord button |
| `tos.html`, `policy.html` | section 13 "Contact" | Discord invite and email |
| `goodnight.llc/index.html` | redirect target | points at `../index.html` — delete the folder if you are not using it |

### 8.3 Images

- `logo.png` — nav and footer logo, 1.1 MB. Replace with a 40–80 KB transparent PNG at the same aspect ratio.
- `plug.png` — avatar placeholder behind the Discord presence widget.
- `dashboard.png` — the product screenshot inside the bento grid.
- `body.png` — was the reseller avatar; now unused, keep or delete.

### 8.4 Meta and hosting

- `index.html` head: `og:site_name`, `og:url`, `og:image`, `og:title`, `og:description`.
- `checkout.html`, `tos.html`, `policy.html`: same block, per page.
- DNS: point the domain at Cloudflare Pages, issue TLS, force HTTPS.
- If the dashboard lives elsewhere, update `login.html`'s `redirect_uri` to match the OAuth app exactly — one character off and Discord rejects the login.

### 8.5 Confirm the old domain is gone

The active site files should no longer link to the old apex domain. This check intentionally excludes the legacy `goodnight.llc` microsite and dependencies:

```powershell
Get-ChildItem -File -Path *.html,*.js,*.css |
  Select-String -Pattern "https://odium.shop|support@odium.shop" |
  ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
```

---

## 9. Pre-launch checklist

- [ ] `js/config.js` has no string starting with `REPLACE`
- [ ] All four rails load in `checkout.html` and `?method=` switching works
- [ ] `server/.env` filled: `PAYPAL_*`, `SMTP_*`, `PRICE`, `SITE_URL`
- [ ] One sandbox purchase completes and the `[SANDBOX]` receipt lands in `natevisionn@gmail.com`
- [ ] `PAYPAL_MODE=live` flipped, one real $3.00 purchase refunded, live webhook registered
- [ ] `MAIL_FROM` / `MAIL_TO` moved to the domain mailbox when it exists
- [ ] A test crypto invoice, a $1 PayPal and a Stripe test-mode purchase each resolve
- [ ] Order reference survives a page reload, and is different in a new tab
- [ ] `tos.html` and `policy.html` contact sections are yours
- [ ] `login.html` completes the OAuth round trip on the production domain
- [ ] `support@getodium.shop` exists and reaches an inbox you read
- [ ] Cloudflare Pages custom domains and HTTPS are active
- [ ] Every image replaced; old-domain links and account placeholders are resolved
- [ ] `js/home.legacy.js` is not referenced anywhere (`grep -r "home.legacy" .` returns nothing)

---

## 10. What changed in this pass

- Pricing reduced to a single product card; premium tier, Robux/gift-card and "via resellers" options removed.
- Payment rails on the site: crypto, PayPal, Cash App, Stripe. Reseller page deleted.
- Hero, features, FAQ, footer and meta rewritten from Roblox script copy to an external aimbot/ESP product.
- `js/home.js` replaced with a readable implementation; the obfuscated bundle is preserved as `js/home.legacy.js` and no longer loaded.
- `js/config.js`, `checkout.html`, `checkout.css` added; checkout is config-driven.
- `tos.html` and `policy.html` rebuilt to cover the new payment rails and the single-product model.
- The storefront domain is `getodium.shop`; Cloudflare Pages assets are built into `dist/`.
- `goodnight.llc/index.html` reduced to a redirect; the previous page is kept as `goodnight.llc/index.legacy.html`.
- `<meta charset="utf-8">` added to pages that were missing it — the raw em dashes and bullets were rendering as mojibake on any server that did not send a charset header.

---

## 11. Cloudflare Pages and Namecheap

The static storefront is prepared for Cloudflare Pages. Pages does not run the Express service in `server/`; the PayPal Smart Button flow calls `/api/paypal/*` and will remain offline until that API is deployed separately or migrated to Pages Functions. For a separately hosted API, set `payments.paypal.apiBase` to its origin and set the API's `CORS_ORIGIN=https://getodium.shop`. The other payment rails also still need real provider URLs and payout details before checkout is live.

### Build and connect GitHub

1. Push this project to a GitHub repository. The repository root should be this project folder; `.gitignore` excludes `dist/`, dependencies and environment secrets.
2. In Cloudflare, open **Workers & Pages → Create application → Pages → Connect to Git** and select that repository.
3. Use these build settings:
   - Production branch: `main` (or your production branch).
   - Build command: `node scripts/build-pages.mjs`
   - Build output directory: `dist`
   - Root directory: `/` (repository root).
   - No install command or build environment variables are needed.
4. The build script copies only public storefront files to `dist/`; it does not publish `server/`, setup documentation, or `.env` files. `_headers` applies browser security headers and the PayPal/Lanyard allowlist.

### Connect the purchased domain

1. Add `getodium.shop` as a site in Cloudflare and follow the setup wizard. Cloudflare assigns two authoritative nameservers; use the pair shown in your account, not a copied example.
2. In Namecheap, open **Domain List → Manage → Nameservers → Custom DNS**, enter Cloudflare's two assigned nameservers, and save.
3. Before changing nameservers, copy any DNS records you need into Cloudflare, especially MX/TXT records for email. Wait for Cloudflare to report the zone as active.
4. In the Pages project, open **Custom domains → Set up a domain** and add `getodium.shop`. Add `www.getodium.shop` as a second custom domain if you want the www address available.
5. In **SSL/TLS**, choose **Full (strict)**, then enable **Always Use HTTPS**. Confirm both hostnames work over HTTPS before announcing the site.
6. To redirect `www` to the apex domain, create a Cloudflare Redirect Rule matching hostname `www.getodium.shop` and forwarding to `https://getodium.shop` while preserving the original path and query string. Pages `_redirects` does not support hostname-based redirects.

The DNS cutover, Cloudflare account setup, GitHub connection and production deployment require access to your accounts. No account credentials or secrets belong in this repository. Cloudflare's edge DDoS mitigation and HTTPS are provider features; security headers harden the browser-facing static site but do not replace securing the payment API or reviewing the storefront's claims and payment configuration.

The Dashboard link currently redirects through the Discord OAuth callback at `goodnight.llc`. Keep that callback if the dashboard still lives there; changing it requires updating the Discord application's registered redirect URI and deploying a callback on the new host.

---

## 12. Two things you should know

1. **The obfuscated bundle contained hardcoded links** to `goodnight.mysellauth.com/products/goodnight-roblox-product` and `discord.gg/gn`. They are inert now because nothing calls the old purchase handler, and the file is not loaded at all. If you ever want the old behaviour back, read `js/home.legacy.js` before trusting it — it also phones home to those URLs.

2. **The legal pages were rebuilt from scratch**, not edited. The originals were 9.8 KB and 14.6 KB of boilerplate that referenced scripts and resellers; the replacements cover the four rails, the single-product model, HWID, chargebacks and the data you actually hold. Read them before you publish — they are written to be accurate for this storefront, not generic.
