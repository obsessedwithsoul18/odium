# Odium — Worker Setup Guide

## Prerequisites
- Cloudflare account with Workers + D1 + R2 access
- `wrangler` CLI installed: `npm i -g wrangler && wrangler login`
- Node.js 20+
- Your cheat binary compiled and ready

---

## Step 0 — Create resources

```bash
# Create D1 database
wrangler d1 create licdb
# → copy the database_id it prints into wrangler.toml

# Create R2 bucket
wrangler r2 bucket create payloads

# Apply schema
wrangler d1 execute licdb --file=schema.sql --remote
```

---

## Step 1 — Set secrets

```bash
# HWID salt: generate 32 random bytes as base64
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
wrangler secret put HWID_SALT

# Storefront webhook signing secret (use the same value in your store)
wrangler secret put WH_SECRET

# Resend API key (https://resend.com)
wrangler secret put RESEND_KEY

# PayPal credentials
wrangler secret put PAYPAL_SANDBOX_CLIENT_ID
wrangler secret put PAYPAL_SANDBOX_SECRET
wrangler secret put PAYPAL_LIVE_CLIENT_ID
wrangler secret put PAYPAL_LIVE_SECRET

# Discord bot token (optional but recommended for DM delivery)
wrangler secret put DISCORD_BOT_TOKEN

# Admin secret for /ban endpoint
wrangler secret put ADMIN_SECRET
```

---

## Step 2 — Encrypt and upload your cheat

```bash
# Encrypt the binary
node tools/encrypt.mjs dist/Odium.exe dist/Odium.bin

# The command prints the base64 AES key — paste it below:
wrangler d1 execute licdb --remote --command \
  "INSERT INTO builds VALUES ('v1.0.0','<PASTE_KEY_HERE>',strftime('%s','now')*1000)"

# Upload the encrypted container
wrangler r2 object put payloads/v1.0.0.bin --file=dist/Odium.bin
```

When you ship a new build:
1. Re-run the encrypt script with a new output name (`v1.0.1.bin`)
2. Insert a new row in builds with the new key
3. Upload the new `.bin` to R2
4. Update `BUILD` in `wrangler.toml` or pass the build name from the loader

---

## Step 3 — Deploy the Worker

```bash
cd worker
npm install
wrangler deploy
```

---

## Step 4 — Configure the storefront webhook

In your payment processor (NowPayments, Stripe, etc.):
- Set the webhook URL to: `https://odium-api.<your-subdomain>.workers.dev/webhook`
- Set the signing secret to the same value you used for `WH_SECRET`
- Payload must include: `{ "order_id": "<unique>", "email": "<buyer>", "discord_id": "<optional>" }`

---

## Step 5 — Wire up your Discord bot

The worker exposes two endpoints your bot calls:

| Action | Method | Endpoint | Body |
|--------|--------|----------|------|
| Link key to Discord | POST | /link | `{ discord_id, key }` |
| Reset HWID | POST | /reset | `{ discord_id }` |

Both return `{ ok, err?, message? }`. Your bot should relay the message to the user ephemerally.

---

## Endpoint reference

| Endpoint | Auth | Purpose |
|----------|------|---------|
| POST /auth | key + HWID | Authenticate, get session token |
| POST /heartbeat | session token | Keep session alive (every 5 min) |
| POST /payload | session token | Get encrypted binary |
| POST /webhook | HMAC-SHA256 | Storefront purchase hook |
| POST /reset | discord_id | Clear HWID (72h cooldown, 8/month) |
| POST /link | discord_id + key | Bind Discord account to key |
| POST /ban | key + admin_secret | Permanently ban a key |
| GET /api/paypal/config | — | PayPal client config |
| POST /api/paypal/order | — | Create PayPal order |
| POST /api/paypal/capture | — | Capture PayPal payment |
| POST /api/paypal/webhook | PayPal sig | PayPal IPN backstop |

---

## Security notes

- **HWID**: 3-of-5 salted hash match required. The salt never leaves the Worker — a leaked hash list is useless without it.
- **Session kick**: overwriting `active_session` on every `/auth` boots any prior session within one 5-minute heartbeat interval.
- **Payload gate**: zero bytes of ciphertext leave the Worker until the session is validated AND `active_session` still matches.
- **Rate limiting**: `/auth` is capped at 10 req/min per IP. All other endpoints 60 req/min.
- **Admin ban**: takes effect immediately and kills the active session. The loader will exit at its next heartbeat.
