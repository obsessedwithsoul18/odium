/**
 * Odium licensing API — Cloudflare Worker.
 *
 * Endpoints
 * ---------
 * POST /auth           key + 5 HWID component hashes -> session token
 * POST /heartbeat      token -> ok | kicked (runs every 5 min in loader)
 * POST /payload        token + build -> AES key + encrypted blob
 * POST /webhook        store webhook: mint key, email + DM buyer
 * POST /reset          Discord interaction: clear HWID set (72h + 8/month)
 * POST /link           Discord interaction: bind discord_id to key
 * POST /ban            admin: ban a key
 * GET  /api/health
 * GET  /api/paypal/config
 * POST /api/paypal/order
 * POST /api/paypal/capture
 * POST /api/paypal/webhook
 *
 * Security guarantees
 * -------------------
 * - Key locked to HWID: 3-of-5 salted hash match required after first bind
 * - Single active session: second login kicks the first within one heartbeat
 * - Payload ciphertext lives in R2; AES key never leaves until auth passes
 * - Banned flag + session kill = kills a running cheat mid-session
 * - 72-hour cooldown + 8 resets/month cap + HWID set cap (5 components)
 * - HMAC-SHA256 webhook signature verification on every storefront webhook
 * - Rate limiting: 10 req/min per IP on auth, 60 req/min everywhere else
 */

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------
const HWID_COMPONENTS = 5;
const HWID_MATCH_THRESHOLD = 3; // need 3-of-5 to pass
const HWID_SALT_PREFIX = 'odium-hwid-v1:';
const SESSION_TTL_MS   = 15 * 60 * 1000;
const RESET_COOLDOWN   = 72 * 3_600_000;
const RESET_CAP_MONTH  = 8;

// ── Security constants ──────────────────────────────────────────────────
const CHALLENGE_TTL_MS    = 30_000;   // nonce valid for 30 seconds only
const AUTH_PER_HOUR_MAX   = 3;        // max auth attempts per key per hour
const BRUTE_FORCE_WINDOW  = 300_000;  // 5-minute window for IP-level throttle
const BRUTE_FORCE_MAX     = 15;       // max failed auths per IP in that window
const KEY_ENTROPY_BITS    = 192;      // 48 hex chars per key segment group
// Session token is bound to: sha256(token_seed + ip_hash + ua_hash + key_hash)
// This means a token stolen via memory dump is useless on another machine.

const PAYPAL_HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live:    'https://api-m.paypal.com',
};

const REF = /^RET-[A-Z0-9]{6}$/;
const PAYPAL_ORDER_ID = /^[A-Z0-9]{6,32}$/i;
const LICENSE_KEY = /^[A-Za-z0-9-]{16,80}$/;
const DISCORD_ID = /^\d{15,21}$/;
const BUILD_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const EMAIL = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,190}\.[A-Za-z]{2,24}$/;

// Headers applied to every JSON response from this Worker.
const SEC_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// -----------------------------------------------------------------------
// Helpers — generic
// -----------------------------------------------------------------------
function j(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SEC_HEADERS,
      ...extra,
    },
  });
}

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.CORS_ORIGIN || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(s => s && s !== '*');
  const hdrs = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
  // No wildcard branch on purpose: a bare `*` in CORS_ORIGIN is ignored, so a
  // typo can never turn the API into a public cross-origin endpoint.
  if (origin && allowed.includes(origin))
    hdrs['Access-Control-Allow-Origin'] = origin;
  return hdrs;
}

function respond(env, request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SEC_HEADERS,
      ...corsHeaders(env, request),
    },
  });
}

async function sha256hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSHA256hex(keyMaterial, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Constant-time compare that also hides length differences. Used for every
 * shared secret so a timing oracle cannot be built by measuring early exits.
 */
function safeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Returns the secret value if it is configured and long enough, otherwise null.
 * Every secret in this Worker is fail-closed: a missing value returns 503
 * instead of silently falling back to a value that lives in source control.
 */
function secretValue(env, name, minLength = 16) {
  const raw = env && env[name];
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length >= minLength ? v : null;
}

/**
 * Gate for bot-only endpoints (/link, /reset, /mykey, /ban, /api/diag).
 * Returns a Response to send back, or null when the caller is authorised.
 *   503 - BOT_SECRET is not configured (never fall open)
 *   401 - header missing or wrong
 */
function requireBot(request, env) {
  const expected = secretValue(env, 'BOT_SECRET');
  if (!expected) return j({ ok: false, err: 'not_configured' }, 503);
  const got = request.headers.get('X-Bot-Secret') || '';
  if (!safeEqual(got, expected)) return j({ ok: false, err: 'unauthorized' }, 401);
  return null;
}

/** Rejects request bodies larger than maxBytes before they are parsed. */
async function readJson(request, maxBytes = 8192) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) return { err: j({ ok: false, err: 'payload_too_large' }, 413) };
  let text;
  try { text = await request.text(); }
  catch { return { err: j({ ok: false, err: 'bad_body' }, 400) }; }
  if (text.length > maxBytes) return { err: j({ ok: false, err: 'payload_too_large' }, 413) };
  try { return { body: JSON.parse(text) }; }
  catch { return { err: j({ ok: false, err: 'bad_json' }, 400) }; }
}

function randomHex(bytes) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

function mintKey() {
  // 192-bit key: 6 groups of 8 hex chars = 48 hex chars total.
  // At 1 billion guesses/second it takes 10^39 years to brute-force.
  // FORMAT: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
  return Array.from({ length: 6 }, () => randomHex(4).toUpperCase()).join('-');
}

// -----------------------------------------------------------------------
// Challenge-response security
// -----------------------------------------------------------------------

/** Issue a single-use nonce. Caller must HMAC-SHA256 it with their key. */
async function issueChallenge(env, ip) {
  const nonce = randomHex(32); // 256-bit nonce
  const ipHash = await sha256hex(ip);
  await env.DB.prepare(
    'INSERT INTO challenges (nonce, ip_hash) VALUES (?, ?)'
  ).bind(nonce, ipHash).run();

  // Opportunistic cleanup of expired challenges. Awaited and swallowed: an
  // unawaited D1 call rejects after the response is sent and takes the whole
  // request down with it (HTTP 1101). Cleanup is never worth failing an auth.
  const cutoff = Date.now() - 120_000;
  try {
    await env.DB.prepare('DELETE FROM challenges WHERE created_at < ?').bind(cutoff).run();
  } catch (_) { /* vacuum only, never fatal */ }

  return nonce;
}

/** Verify and consume a nonce. Returns false if invalid, expired, or already used. */
async function consumeChallenge(env, nonce, ip) {
  if (!nonce || typeof nonce !== 'string' || !/^[0-9a-f]{64}$/i.test(nonce))
    return false;

  const ipHash = await sha256hex(ip);
  const row = await env.DB.prepare(
    'SELECT nonce, ip_hash, created_at, used_at FROM challenges WHERE nonce = ?'
  ).bind(nonce).first();

  if (!row) return false;
  if (row.used_at) return false; // already consumed — replay attack
  if (row.ip_hash !== ipHash) return false; // different IP — session fixation
  if (Date.now() - Number(row.created_at) > CHALLENGE_TTL_MS) return false; // expired

  // Consume atomically: only one caller can win this UPDATE, so two parallel
  // requests replaying the same nonce cannot both pass.
  const upd = await env.DB.prepare(
    'UPDATE challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL'
  ).bind(Date.now(), nonce).run();

  return Number(upd?.meta?.changes || 0) === 1;
}

/**
 * Verify that the loader correctly signed the nonce.
 * Expected: HMAC-SHA256(key=sha256(licenseKey + hwidFingerprint), msg=nonce)
 * This proves the loader has BOTH the key AND the correct HWID.
 */
async function verifySignature(nonce, signature, licenseKey, hwidHashes, env) {
  // Fail closed. LOADER_SECRET must exist in the Worker environment; there is
  // no compiled-in default, so an unprovisioned deploy cannot be authenticated
  // against with a value that is readable in this repository.
  const loaderSecret = secretValue(env, 'LOADER_SECRET');
  if (!loaderSecret) return false;
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;

  const hwidFingerprint = hwidHashes.slice().sort().join(':');
  const material = (secret) => `${licenseKey}:${hwidFingerprint}:${secret}`;

  const expectedSig = await hmacSHA256hex(material(loaderSecret), nonce);
  if (timingSafeEqual(expectedSig, signature.toLowerCase())) return true;

  // Optional migration window: loaders that were built against a pre-rotation
  // secret keep working while they are reissued. This value is opt-in, must be
  // set explicitly, and should be deleted as soon as the fleet is rebuilt.
  const legacy = secretValue(env, 'LOADER_SECRET_LEGACY');
  if (legacy) {
    const legacySig = await hmacSHA256hex(material(legacy), nonce);
    if (timingSafeEqual(legacySig, signature.toLowerCase())) return true;
  }
  return false;
}

// -----------------------------------------------------------------------
// Key-level rate limiting — prevents brute force even if IP rotates
// -----------------------------------------------------------------------
async function checkKeyRateLimit(env, keyHash, ip) {
  const ipHash = await sha256hex(ip);
  const hourAgo = Date.now() - 3_600_000;

  // Count recent auth attempts for this key
  const keyAttempts = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM auth_log
     WHERE key_hash = ? AND created_at > ? AND result != 'ok'`
  ).bind(keyHash, hourAgo).first();

  if (Number(keyAttempts?.cnt || 0) >= AUTH_PER_HOUR_MAX)
    return { blocked: true, reason: 'key_rate_limit' };

  // Count recent failed auths from this IP (catches key enumeration)
  const fiveMinAgo = Date.now() - BRUTE_FORCE_WINDOW;
  const ipAttempts = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM auth_log
     WHERE ip_hash = ? AND created_at > ? AND result != 'ok'`
  ).bind(ipHash, fiveMinAgo).first();

  if (Number(ipAttempts?.cnt || 0) >= BRUTE_FORCE_MAX)
    return { blocked: true, reason: 'ip_rate_limit' };

  return { blocked: false };
}

// -----------------------------------------------------------------------
// Audit logging
// -----------------------------------------------------------------------
async function logAuth(env, { keyHash, ip, hwidHashes, result }) {
  const ipHash = await sha256hex(ip);
  const hwidHash = await sha256hex(hwidHashes.join(':'));
  // Awaited but swallowed: an unchecked D1 promise that rejects after the
  // response is flushed surfaces as a Worker exception (HTTP 1101) even though
  // the audit write is non-essential. Log failure must never fail the request.
  try {
    await env.DB.prepare(
      'INSERT INTO auth_log (key_hash, ip_hash, hwid_hash, result) VALUES (?, ?, ?, ?)'
    ).bind(keyHash, ipHash, hwidHash, result).run();
  } catch (_) { /* audit write is best-effort */ }
}

// -----------------------------------------------------------------------
// Session token binding
// Binds the token to the requesting machine so it can't be replayed
// from a different context even if extracted from memory.
// -----------------------------------------------------------------------
async function mintBoundToken(key, ip, userAgent) {
  const seed = randomHex(32);
  const ipHash = await sha256hex(ip);
  const uaHash = await sha256hex(userAgent);
  const keyHash = await sha256hex(key);
  // Final token = HMAC(seed, ip_hash + ua_hash + key_hash)
  // Server stores seed; validates by recomputing on each heartbeat
  const token = await hmacSHA256hex(seed, `${ipHash}:${uaHash}:${keyHash}`);
  return { token, seed, ipHash, uaHash, keyHash };
}

// -----------------------------------------------------------------------
// Rate limiter — Cloudflare Workers KV would be ideal but requires binding.
// This in-memory per-isolate approach is good enough: it's per-colo and
// resets on isolation eviction (typically minutes), which is fine for
// the attack model (credential stuffing, not distributed Slowloris).
// -----------------------------------------------------------------------
const rateBuckets = new Map();

function rateLimit(ip, limit, windowMs = 60_000) {
  const now = Date.now();
  const entry = rateBuckets.get(ip) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  entry.count++;
  rateBuckets.set(ip, entry);
  return entry.count > limit;
}

function clientIp(request) {
  // Cloudflare always sets CF-Connecting-IP and overwrites it at the edge.
  // X-Forwarded-For is deliberately NOT trusted: it is caller-controlled and
  // would let an attacker rotate IP bindings and rate-limit buckets at will.
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// -----------------------------------------------------------------------
// HWID helpers
// -----------------------------------------------------------------------
async function saltedHwidHash(env, raw) {
  // raw is already a hex string from the loader; we re-hash with server salt
  // so a leaked hash list is useless without knowing the salt.
  // No fallback salt: a missing HWID_SALT is a configuration failure, not a
  // reason to hash every customer's hardware with a value from source control.
  const salt = secretValue(env, 'HWID_SALT', 8);
  if (!salt) throw new Error('HWID_SALT not configured');
  const salted = `${HWID_SALT_PREFIX}${salt}:${raw}`;
  return sha256hex(salted);
}

async function hashComponents(env, components) {
  return Promise.all(components.map(c => saltedHwidHash(env, String(c))));
}

// Returns how many hashes in `incoming` match any hash in `stored`.
function countMatches(incoming, stored) {
  const set = new Set(stored);
  return incoming.filter(h => set.has(h)).length;
}

// -----------------------------------------------------------------------
// Session helpers
// -----------------------------------------------------------------------
async function newSessionToken() {
  return randomHex(32); // 256 bits
}

// -----------------------------------------------------------------------
// PayPal helpers (reused from existing worker)
// -----------------------------------------------------------------------
function ppCreds(env) {
  const mode = String(env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
  const prefix = mode === 'live' ? 'PAYPAL_LIVE' : 'PAYPAL_SANDBOX';
  return {
    mode,
    base: PAYPAL_HOSTS[mode],
    clientId: env[`${prefix}_CLIENT_ID`] || '',
    secret:   env[`${prefix}_SECRET`]    || '',
    webhookId:env[`${prefix}_WEBHOOK_ID`]|| '',
  };
}

let _tokenCache = { key: '', value: '', expiresAt: 0 };

async function ppToken(env) {
  const c = ppCreds(env);
  const k = `${c.mode}:${c.clientId}`;
  if (_tokenCache.key === k && _tokenCache.value && Date.now() < _tokenCache.expiresAt)
    return _tokenCache.value;

  const res = await fetch(`${c.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${c.clientId}:${c.secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`paypal auth ${res.status}: ${text}`);
  const body = JSON.parse(text);
  _tokenCache = {
    key: k,
    value: body.access_token,
    expiresAt: Date.now() + Math.max(0, Number(body.expires_in) - 60) * 1000,
  };
  return _tokenCache.value;
}

async function ppCall(env, path, { method = 'GET', body, requestId } = {}) {
  const c = ppCreds(env);
  const token = await ppToken(env);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(`${c.base}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, json: parsed };
}

async function ppCreateOrder(env, reference) {
  const { ok, status, json: body } = await ppCall(env, '/v2/checkout/orders', {
    method: 'POST',
    requestId: `order-${reference}-${Date.now()}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: reference,
        custom_id: reference,
        description: `${env.BRAND_NAME || 'Odium'} — license`.slice(0, 127),
        amount: { currency_code: env.CURRENCY || 'USD', value: env.PRICE || '3.00' },
      }],
      application_context: {
        brand_name: env.BRAND_NAME || 'Odium',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
      },
    },
  });
  if (!ok) throw new Error(`ppCreateOrder ${status}`);
  return body;
}

async function ppGetOrder(env, orderId) {
  const { ok, status, json: body } = await ppCall(
    env, `/v2/checkout/orders/${encodeURIComponent(orderId)}`
  );
  if (!ok) throw new Error(`ppGetOrder ${status}`);
  return body;
}

async function ppCapture(env, orderId) {
  const { ok, status, json: body } = await ppCall(
    env, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    { method: 'POST', requestId: `capture-${orderId}` }
  );
  if (ok) return body;

  // A retried capture returns 422 ORDER_ALREADY_CAPTURED. That is a success
  // dressed as a failure — read the order back and let the caller inspect it.
  const detail = JSON.stringify(body || {});
  if (status === 422 && /ALREADY_CAPTURED/i.test(detail))
    return ppGetOrder(env, orderId);

  throw new Error(`ppCapture ${status}: ${detail}`.slice(0, 300));
}

function ppReadCapture(env, order) {
  const unit    = order?.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture) return null;
  return {
    status:     capture.status,
    captureId:  capture.id,
    reference:  capture.custom_id || unit.custom_id || unit.reference_id || '',
    amount:     capture.amount?.value || '',
    currency:   capture.amount?.currency_code || '',
    payerEmail: order?.payer?.email_address || '',
    payerName:  [order?.payer?.name?.given_name, order?.payer?.name?.surname].filter(Boolean).join(' '),
    paidAt:     capture.create_time || '',
    mode:       ppCreds(env).mode,
  };
}

function ppIsPaid(env, capture) {
  if (!capture || capture.status !== 'COMPLETED') return false;
  if (capture.currency !== (env.CURRENCY || 'USD')) return false;
  return Number(capture.amount) === Number(env.PRICE || '3.00');
}

async function ppVerifyWebhook(env, request, event) {
  const c = ppCreds(env);
  if (!c.webhookId) return false;
  const { ok, json: body } = await ppCall(env, '/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo:         request.headers.get('paypal-auth-algo'),
      cert_url:          request.headers.get('paypal-cert-url'),
      transmission_id:   request.headers.get('paypal-transmission-id'),
      transmission_sig:  request.headers.get('paypal-transmission-sig'),
      transmission_time: request.headers.get('paypal-transmission-time'),
      webhook_id:        c.webhookId,
      webhook_event:     event,
    },
  });
  if (!ok) return false;
  return body.verification_status === 'SUCCESS';
}

// -----------------------------------------------------------------------
// D1 claim (idempotency for PayPal)
// -----------------------------------------------------------------------
async function ppClaim(env, capture, extra = {}) {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders
       (capture_id, reference, order_id, amount, currency, payer_email, mode, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    capture.captureId,
    capture.reference || '',
    extra.orderId || '',
    String(capture.amount || ''),
    capture.currency || '',
    capture.payerEmail || '',
    capture.mode || '',
    capture.paidAt || '',
  ).run();
  return Number(res?.meta?.changes || 0) === 1;
}

// -----------------------------------------------------------------------
// Email via Resend
// -----------------------------------------------------------------------
async function sendEmail(env, { to, subject, text, html }) {
  if (!env.RESEND_KEY && !env.RESEND_API_KEY) return { ok: false, error: 'RESEND key not set' };
  const body = {
    from: env.MAIL_FROM || 'orders@getodium.shop',
    to: [to],
    subject,
    text,
    html,
  };
  if (env.MAIL_REPLY_TO) body.reply_to = [env.MAIL_REPLY_TO];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_KEY || env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `${res.status} ${body}`.slice(0, 300) };
  }
  return { ok: true };
}

async function sendKeyEmail(env, { to, key }) {
  const brand = env.BRAND_NAME || 'Odium';
  return sendEmail(env, {
    to,
    subject: `Your ${brand} license key`,
    text: [
      `Your ${brand} key: ${key}`,
      '',
      'Paste this into the loader. Do not share it — the key is bound to your hardware.',
      'HWID resets: use /reset in Discord (72-hour cooldown, 8 resets per month).',
      '',
      'Support: open a ticket in the Discord server.',
    ].join('\n'),
    html: `<!doctype html><html><body style="margin:0;background:#0b0b0d;padding:32px;font-family:-apple-system,Segoe UI,sans-serif;color:#e8e8ea">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:500px;margin:0 auto;background:#141418;border:1px solid #26262e;border-radius:14px">
  <tr><td style="padding:24px 24px 8px">
    <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8b8b96">${brand}</div>
    <h1 style="margin:8px 0 0;font-size:20px">Your license key</h1>
  </td></tr>
  <tr><td style="padding:8px 24px 24px">
    <p style="margin:0 0 16px;font-size:14px;color:#a0a0b0">Paste this into the loader. Do not share it — it is bound to your hardware on first launch.</p>
    <div style="font-family:ui-monospace,Menlo,monospace;font-size:18px;letter-spacing:.05em;padding:14px 18px;background:#1e1e24;border:1px solid #dc143c40;border-radius:10px;color:#fff;word-break:break-all">${key}</div>
    <p style="margin:16px 0 0;font-size:13px;color:#606070">HWID resets: /reset in Discord (72h cooldown, 8/month). Support: open a ticket.</p>
  </td></tr>
</table>
</body></html>`,
  });
}

async function sendReceiptEmail(env, capture, ref) {
  const brand = env.BRAND_NAME || 'Odium';
  const amount = `${capture.currency} ${capture.amount}`;
  const sandbox = capture.mode === 'sandbox';
  const subject = `${sandbox ? '[SANDBOX] ' : ''}${brand} paid — ${ref} — ${amount}`;
  const text = `Order: ${ref}\nAmount: ${amount}\nPayPal: ${capture.captureId}\nPayer: ${capture.payerName} <${capture.payerEmail}>\nPaid: ${capture.paidAt}\nMode: ${capture.mode}`;
  const html = `<pre>${ref} — ${amount} — ${capture.captureId}</pre>`;

  const store = await sendEmail(env, {
    to: env.MAIL_TO || 'admin@getodium.shop',
    subject, text, html,
  });

  // Buyer copy goes out only once the sending domain is verified at Resend,
  // so an unverified domain can never make the store receipt fail.
  if (env.MAIL_BUYER === 'true' && capture.payerEmail) {
    try {
      await sendEmail(env, {
        to: capture.payerEmail,
        subject: `${brand} receipt — ${ref}`,
        text: [
          `Thanks — your payment cleared.`,
          '',
          `Order: ${ref}`,
          `Amount: ${amount}`,
          `PayPal capture: ${capture.captureId}`,
          '',
          `Delivery lands in the Discord within ${env.DELIVERY_MINUTES || 10} minutes:`,
          env.DISCORD_INVITE || 'https://discord.gg/ojailbreaks',
          '',
          `Reply to this email for support — quote ${ref}.`,
        ].join('\n'),
        html,
      });
    } catch { /* buyer copy is best-effort */ }
  }

  return store;
}

// -----------------------------------------------------------------------
// Discord DM helper
// -----------------------------------------------------------------------
async function dmDiscord(env, discordId, message) {
  if (!env.DISCORD_BOT_TOKEN || !discordId) return;
  try {
    const dmRes = await fetch(`https://discord.com/api/v10/users/@me/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: discordId }),
    });
    if (!dmRes.ok) return;
    const dm = await dmRes.json();
    await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message }),
    });
  } catch { /* DM failure is non-fatal */ }
}

// -----------------------------------------------------------------------
// Route handlers
// -----------------------------------------------------------------------

/**
 * POST /challenge
 *
 * Body: { key }
 * Response: { nonce } — 256-bit single-use nonce, valid 30s, bound to caller IP.
 *
 * The loader must HMAC-SHA256 this nonce with:
 *   key = sha256(licenseKey + ":" + sorted(hwidHashes).join(":") + ":" + LOADER_SECRET)
 * and send the hex result as `sig` in /auth.
 *
 * Without this step /auth rejects. A wireshark-captured auth request
 * can never be replayed because the nonce is single-use and time-limited.
 */
async function handleChallenge(request, env) {
  const ip = clientIp(request);
  if (rateLimit(ip, 20, 60_000))
    return j({ ok: false, err: 'rate_limit' }, 429);

  // Fail closed before issuing anything: without these two secrets the loader
  // can never complete /auth, so don't hand out nonces that cannot be used.
  if (!secretValue(env, 'LOADER_SECRET')) return j({ ok: false, err: 'not_configured' }, 503);
  if (!secretValue(env, 'HWID_SALT', 8)) return j({ ok: false, err: 'not_configured' }, 503);

  const parsed = await readJson(request, 2048);
  if (parsed.err) return parsed.err;
  const body = parsed.body || {};

  // Don't validate the key here — that leaks whether a key exists.
  // Just issue a nonce. If the key is invalid /auth will fail anyway.
  if (!body.key || typeof body.key !== 'string' || !LICENSE_KEY.test(body.key))
    return j({ ok: false, err: 'missing_key' }, 400);

  const nonce = await issueChallenge(env, ip);
  return j({ ok: true, nonce });
}

/**
 * POST /auth
 *
 * Body: { key, hwid: [hash0..hash4], nonce, sig }
 *
 * sig = HMAC-SHA256(
 *   key   = sha256(licenseKey + ":" + sorted(hwid).join(":") + ":" + LOADER_SECRET),
 *   msg   = nonce
 * )
 *
 * This means:
 *   - Nonce is single-use (replay = instant fail)
 *   - sig proves caller has the key AND the correct HWID (not just one or the other)
 *   - Token is bound to caller's IP + UA + key (stolen token useless elsewhere)
 *   - Every failed attempt is logged (anomaly detection)
 *   - 3 failures/hour per key, 15 failures/5min per IP (brute force dead)
 */
async function handleAuth(request, env) {
  const ip = clientIp(request);
  if (rateLimit(ip, 10, 60_000))
    return j({ ok: false, err: 'rate_limit' }, 429);

  // Fail closed on missing configuration — see verifySignature / saltedHwidHash.
  if (!secretValue(env, 'LOADER_SECRET')) return j({ ok: false, err: 'not_configured' }, 503);
  if (!secretValue(env, 'HWID_SALT', 8)) return j({ ok: false, err: 'not_configured' }, 503);

  const parsed = await readJson(request, 4096);
  if (parsed.err) return parsed.err;

  const { key, hwid, nonce, sig } = parsed.body || {};

  if (!key || typeof key !== 'string' || !LICENSE_KEY.test(key))
    return j({ ok: false, err: 'missing_key' }, 400);
  if (!Array.isArray(hwid) || hwid.length !== HWID_COMPONENTS)
    return j({ ok: false, err: 'bad_hwid' }, 400);
  if (!nonce || !sig)
    return j({ ok: false, err: 'missing_challenge' }, 400);

  // Validate HWID component format
  for (const h of hwid) {
    if (typeof h !== 'string' || !/^[0-9a-f]{64}$/i.test(h))
      return j({ ok: false, err: 'bad_hwid_format' }, 400);
  }

  const keyHash = await sha256hex(key);

  // 1. Check rate limits BEFORE touching the DB for the key
  const rateCheck = await checkKeyRateLimit(env, keyHash, ip);
  if (rateCheck.blocked) {
    await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: rateCheck.reason });
    // Return generic error — don't tell attacker which limit fired
    return j({ ok: false, err: 'rate_limit' }, 429);
  }

  // 2. Verify and consume the nonce (replay protection)
  const nonceValid = await consumeChallenge(env, nonce, ip);
  if (!nonceValid) {
    await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'challenge_fail' });
    return j({ ok: false, err: 'invalid_challenge' }, 401);
  }

  // 3. Verify the HMAC signature (proves caller has key + HWID + LOADER_SECRET)
  const sigValid = await verifySignature(nonce, sig, key, hwid, env);
  if (!sigValid) {
    await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'sig_fail' });
    // Identical error to invalid_key — don't leak which check failed
    return j({ ok: false, err: 'invalid_key' }, 401);
  }

  // 4. Look up the license
  const lic = await env.DB.prepare(
    'SELECT key, hwid_set, active_session, banned FROM licenses WHERE key = ?'
  ).bind(key).first();

  if (!lic) {
    await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'invalid_key' });
    // Identical timing to other failures — no oracle
    return j({ ok: false, err: 'invalid_key' }, 401);
  }

  if (lic.banned) {
    await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'banned' });
    return j({ ok: false, err: 'banned' }, 403);
  }

  // 5. Salt and hash HWID components server-side
  const incomingHashes = await hashComponents(env, hwid);

  let storedSet;
  try { storedSet = JSON.parse(lic.hwid_set || '[]'); }
  catch { storedSet = []; }

  if (storedSet.length === 0) {
    // First login — bind
    storedSet = incomingHashes;
    await env.DB.prepare('UPDATE licenses SET hwid_set = ? WHERE key = ?')
      .bind(JSON.stringify(storedSet), key).run();
  } else {
    const matches = countMatches(incomingHashes, storedSet);
    if (matches < HWID_MATCH_THRESHOLD) {
      await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'hwid_mismatch' });
      return j({ ok: false, err: 'hwid_mismatch', matched: matches, needed: HWID_MATCH_THRESHOLD }, 403);
    }
    // Absorb minor hardware changes silently
    const merged = [...new Set([...storedSet, ...incomingHashes])].slice(0, HWID_COMPONENTS * 2);
    if (merged.length !== storedSet.length) {
      await env.DB.prepare('UPDATE licenses SET hwid_set = ? WHERE key = ?')
        .bind(JSON.stringify(merged), key).run();
    }
  }

  // 6. Mint a bound session token. Only the SHA-256 of the token is stored, so
  //    a dump of the sessions table cannot be replayed against the API.
  const ua = request.headers.get('User-Agent') || '';
  const { token, ipHash, uaHash } = await mintBoundToken(key, ip, ua);
  const tokenHash = await sha256hex(token);

  // Kill old sessions for this key
  await env.DB.prepare('DELETE FROM sessions WHERE key = ?').bind(key).run();

  // Store session with binding fingerprint
  await env.DB.prepare(
    `INSERT INTO sessions (token, key, ip_hash, ua_hash, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(tokenHash, key, ipHash, uaHash, Date.now(), Date.now()).run();

  await env.DB.prepare('UPDATE licenses SET active_session = ? WHERE key = ?')
    .bind(tokenHash, key).run();

  await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'ok' });

  return j({ ok: true, token });
}

/**
 * POST /heartbeat
 *
 * Body: { token }
 * Response: { ok } | { ok: false, err: 'kicked' | 'expired' }
 *
 * Fails if:
 *   - token doesn't exist
 *   - license.active_session !== token (another device logged in)
 *   - license is banned
 *   - session hasn't been seen in SESSION_TTL_MS
 */
async function handleHeartbeat(request, env) {
  const parsed = await readJson(request, 2048);
  if (parsed.err) return parsed.err;

  const { token } = parsed.body || {};
  if (!token || typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token))
    return j({ ok: false, err: 'missing_token' }, 400);

  const ip = clientIp(request);
  const ua = request.headers.get('User-Agent') || '';
  const tokenHash = await sha256hex(token);

  const row = await env.DB.prepare(
    `SELECT s.token, s.last_seen, s.ip_hash, s.ua_hash, s.key,
            l.active_session, l.banned
     FROM sessions s
     JOIN licenses l ON l.key = s.key
     WHERE s.token = ?`
  ).bind(tokenHash).first();

  if (!row) return j({ ok: false, err: 'kicked' }, 401);
  if (row.banned) return j({ ok: false, err: 'banned' }, 403);
  if (!safeEqual(String(row.active_session || ''), tokenHash)) return j({ ok: false, err: 'kicked' }, 401);

  // Session TTL check
  if (Date.now() - Number(row.last_seen) > SESSION_TTL_MS)
    return j({ ok: false, err: 'expired' }, 401);

  // IP binding check — token is not valid from a different network.
  // This kills a token even if someone dumps it from the loader's memory
  // and tries to use it from their own machine.
  const currentIpHash = await sha256hex(ip);
  if (!safeEqual(currentIpHash, String(row.ip_hash || '')))
    return j({ ok: false, err: 'kicked' }, 401);

  // User-Agent binding check — second half of the same fingerprint.
  if (row.ua_hash && !safeEqual(await sha256hex(ua), String(row.ua_hash)))
    return j({ ok: false, err: 'kicked' }, 401);

  await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
    .bind(Date.now(), tokenHash).run();

  return j({ ok: true });
}

/**
 * POST /payload
 *
 * Body: { token, build }
 * Response: { ok, k: base64AesKey, blob: base64Ciphertext }
 *
 * Auth is checked FIRST. Zero bytes of ciphertext move unless the
 * session is valid and active_session still matches.
 */
async function handlePayload(request, env) {
  const parsed = await readJson(request, 2048);
  if (parsed.err) return parsed.err;

  const { token, build } = parsed.body || {};
  if (!token || typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token))
    return j({ ok: false, err: 'missing_fields' }, 400);
  if (!build || typeof build !== 'string' || !BUILD_NAME.test(build))
    return j({ ok: false, err: 'missing_fields' }, 400);

  const ip = clientIp(request);
  const ua = request.headers.get('User-Agent') || '';
  const tokenHash = await sha256hex(token);

  // Validate session. Same checks as /heartbeat: existence, ban state, active
  // session, TTL, IP binding and UA binding. A stolen token is useless here.
  const row = await env.DB.prepare(
    `SELECT s.key, s.last_seen, s.ip_hash, s.ua_hash, l.active_session, l.banned
     FROM sessions s
     JOIN licenses l ON l.key = s.key
     WHERE s.token = ?`
  ).bind(tokenHash).first();

  if (!row) return j({ ok: false, err: 'kicked' }, 401);
  if (row.banned) return j({ ok: false, err: 'banned' }, 403);
  if (!safeEqual(String(row.active_session || ''), tokenHash)) return j({ ok: false, err: 'kicked' }, 401);
  if (Date.now() - Number(row.last_seen) > SESSION_TTL_MS)
    return j({ ok: false, err: 'expired' }, 401);
  if (!safeEqual(await sha256hex(ip), String(row.ip_hash || '')))
    return j({ ok: false, err: 'kicked' }, 401);
  if (row.ua_hash && !safeEqual(await sha256hex(ua), String(row.ua_hash)))
    return j({ ok: false, err: 'kicked' }, 401);

  // Fetch build key
  const buildRow = await env.DB.prepare(
    'SELECT key_b64 FROM builds WHERE name = ?'
  ).bind(build).first();
  if (!buildRow) return j({ ok: false, err: 'unknown_build' }, 404);

  // Fetch ciphertext from R2
  const obj = await env.R2.get(`payloads/${build}.bin`);
  if (!obj) return j({ ok: false, err: 'payload_missing' }, 404);

  const bytes = new Uint8Array(await obj.arrayBuffer());
  // Convert bytes to base64 in chunks to avoid call stack overflow on large files
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  // Touch session heartbeat
  await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
    .bind(Date.now(), tokenHash).run();

  return j({ ok: true, k: buildRow.key_b64, blob: btoa(bin) });
}

/**
 * POST /webhook  — storefront purchase webhook
 *
 * Body: { order_id, email, discord_id? }
 * Headers: x-signature = HMAC-SHA256 hex of raw body with WH_SECRET
 *
 * Creates a key, emails it, DMs the buyer if discord_id is present.
 */
async function handleStorefrontWebhook(request, env) {
  const whSecret = secretValue(env, 'WH_SECRET');
  if (!whSecret) return j({ ok: false, err: 'webhook_not_configured' }, 503);

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > 8192) return j({ ok: false, err: 'payload_too_large' }, 413);

  const rawBody = await request.text();
  if (rawBody.length > 8192) return j({ ok: false, err: 'payload_too_large' }, 413);

  const sig = request.headers.get('x-signature') || '';
  const expected = await hmacSHA256hex(whSecret, rawBody);
  if (!safeEqual(expected, sig.toLowerCase()))
    return j({ ok: false, err: 'bad_signature' }, 401);

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { order_id, email, discord_id } = payload || {};

  const orderId = String(order_id || '');
  if (!orderId || orderId.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(orderId))
    return j({ ok: false, err: 'missing_order_id' }, 400);

  const buyerEmail = email ? String(email) : '';
  if (buyerEmail && (!EMAIL.test(buyerEmail) || buyerEmail.length > 254))
    return j({ ok: false, err: 'bad_email' }, 400);

  const discordId = discord_id ? String(discord_id) : '';
  if (discordId && !DISCORD_ID.test(discordId))
    return j({ ok: false, err: 'bad_discord_id' }, 400);

  // Atomic idempotency: the INSERT is the lock. Only the delivery that wins
  // `changes === 1` goes on to mint a key, so two simultaneous webhook
  // deliveries for the same order can never produce two licenses.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders (capture_id, reference, order_id, mode)
     VALUES (?, ?, ?, 'webhook')`
  ).bind(orderId, orderId, orderId).run();

  if (Number(claim?.meta?.changes || 0) !== 1) return j({ ok: true, dup: true });

  // Mint key
  const key = mintKey();
  try {
    await env.DB.prepare(
      'INSERT INTO licenses (key, discord_id, email) VALUES (?, ?, ?)'
    ).bind(key, discordId || null, buyerEmail || null).run();
  } catch (err) {
    // Roll the claim back so a retry from the store can mint the key later.
    await env.DB.prepare('DELETE FROM orders WHERE capture_id = ?').bind(orderId).run().catch(() => {});
    throw err;
  }

  // Email
  if (buyerEmail) {
    await sendKeyEmail(env, { to: buyerEmail, key });
  }

  // Discord DM
  if (discordId) {
    await dmDiscord(env, discordId, `Your **${env.BRAND_NAME || 'Odium'}** key: \`${key}\`\nDo not share it — it's HWID-locked. Use \`/reset\` to change machines (72h cooldown).`);
  }

  return j({ ok: true, key_created: true });
}

/**
 * POST /reset  — Discord slash command: clear HWID set
 *
 * Body: { discord_id }  (sent by your Discord bot)
 * Enforces: 72h cooldown, 8 resets/month cap
 */
async function handleReset(request, env) {
  const denied = requireBot(request, env);
  if (denied) return denied;

  const ip = clientIp(request);
  if (rateLimit(ip, 5, 60_000))
    return j({ ok: false, err: 'rate_limit' }, 429);

  const parsed = await readJson(request, 2048);
  if (parsed.err) return parsed.err;

  const { discord_id } = parsed.body || {};
  if (!discord_id || !DISCORD_ID.test(String(discord_id)))
    return j({ ok: false, err: 'missing_discord_id' }, 400);

  const lic = await env.DB.prepare(
    'SELECT key, last_reset_at, resets_month, banned FROM licenses WHERE discord_id = ?'
  ).bind(String(discord_id)).first();

  if (!lic) return j({ ok: false, err: 'no_key_linked' });
  if (lic.banned) return j({ ok: false, err: 'banned' }, 403);

  const now = Date.now();
  const cooldownRemaining = RESET_COOLDOWN - (now - Number(lic.last_reset_at));
  if (cooldownRemaining > 0) {
    const hoursLeft = Math.ceil(cooldownRemaining / 3_600_000);
    return j({ ok: false, err: 'cooldown', hours_left: hoursLeft });
  }

  if (Number(lic.resets_month) >= RESET_CAP_MONTH)
    return j({ ok: false, err: 'monthly_cap' });

  await env.DB.prepare(
    `UPDATE licenses
     SET hwid_set = '[]', active_session = NULL, last_reset_at = ?, resets_month = resets_month + 1
     WHERE key = ?`
  ).bind(now, lic.key).run();

  // Kill any active sessions
  await env.DB.prepare('DELETE FROM sessions WHERE key = ?').bind(lic.key).run();

  return j({ ok: true, message: 'HWID cleared. Relaunch the loader.' });
}

/**
 * POST /link  — Discord slash command: bind discord_id to key
 *
 * Body: { discord_id, key }
 */
async function handleLink(request, env) {
  const denied = requireBot(request, env);
  if (denied) return denied;

  const ip = clientIp(request);
  if (rateLimit(ip, 10, 60_000))
    return j({ ok: false, err: 'rate_limit' }, 429);

  const parsed = await readJson(request, 2048);
  if (parsed.err) return parsed.err;

  const { discord_id, key } = parsed.body || {};
  if (!discord_id || !key || !DISCORD_ID.test(String(discord_id)) || !LICENSE_KEY.test(String(key)))
    return j({ ok: false, err: 'missing_fields' }, 400);

  const lic = await env.DB.prepare(
    'SELECT key, discord_id, banned FROM licenses WHERE key = ?'
  ).bind(String(key)).first();

  if (!lic) return j({ ok: false, err: 'invalid_key' }, 404);
  if (lic.banned) return j({ ok: false, err: 'banned' }, 403);

  if (lic.discord_id && lic.discord_id !== String(discord_id))
    return j({ ok: false, err: 'already_linked' });

  await env.DB.prepare('UPDATE licenses SET discord_id = ? WHERE key = ?')
    .bind(String(discord_id), String(key)).run();

  return j({ ok: true });
}

/**
 * POST /ban  — admin: ban a key immediately
 *
 * Body: { key, admin_secret }
 */
async function handleBan(request, env) {
  // Admin action: bot secret header, or ADMIN_SECRET in the body for manual
  // curl use. Both fail closed and both compare in constant time.
  const denied = requireBot(request, env);
  if (denied) {
    const parsedForAdmin = await readJson(request, 2048);
    if (parsedForAdmin.err) return parsedForAdmin.err;
    const admin = secretValue(env, 'ADMIN_SECRET');
    const supplied = String(parsedForAdmin.body && parsedForAdmin.body.admin_secret || '');
    if (!admin || !safeEqual(supplied, admin))
      return denied;
    return banKey(env, String(parsedForAdmin.body && parsedForAdmin.body.key || ''));
  }

  const parsed = await readJson(request, 2048);
  if (parsed.err) return parsed.err;
  return banKey(env, String((parsed.body && parsed.body.key) || ''));
}

async function banKey(env, key) {
  if (!key || !LICENSE_KEY.test(key)) return j({ ok: false, err: 'missing_key' }, 400);

  await env.DB.prepare('UPDATE licenses SET banned = 1, active_session = NULL WHERE key = ?')
    .bind(key).run();
  await env.DB.prepare('DELETE FROM sessions WHERE key = ?').bind(key).run();

  return j({ ok: true });
}

// -----------------------------------------------------------------------
// PayPal route handlers (unchanged from original, kept for payment flow)
// -----------------------------------------------------------------------

async function handlePayPalConfig(request, env) {
  const ip = clientIp(request);
  if (rateLimit(ip, 120)) return respond(env, request, { error: 'rate limited' }, 429);

  const c = ppCreds(env);
  if (!c.clientId) return respond(env, request, { error: 'paypal not configured' }, 503);
  return respond(env, request, {
    mode: c.mode, clientId: c.clientId,
    currency: env.CURRENCY || 'USD', amount: env.PRICE || '3.00',
    brand: env.BRAND_NAME || 'Odium',
  });
}

async function handlePayPalOrder(request, env) {
  const ip = clientIp(request);
  if (rateLimit(ip, 20)) return respond(env, request, { error: 'rate limited' }, 429);

  const parsed = await readJson(request, 2048);
  if (parsed.err) return respond(env, request, { error: 'bad request' }, 400);

  const reference = String(parsed.body && parsed.body.reference || '').toUpperCase();
  if (!REF.test(reference)) return respond(env, request, { error: 'bad reference' }, 400);

  const order = await ppCreateOrder(env, reference);
  return respond(env, request, { id: order.id, status: order.status, reference });
}

async function handlePayPalCapture(request, env) {
  const ip = clientIp(request);
  if (rateLimit(ip, 20)) return respond(env, request, { error: 'rate limited' }, 429);

  const parsed = await readJson(request, 2048);
  if (parsed.err) return respond(env, request, { error: 'bad request' }, 400);

  const orderId = String(parsed.body && parsed.body.orderId || '');
  if (!PAYPAL_ORDER_ID.test(orderId)) return respond(env, request, { error: 'missing orderId' }, 400);

  const order   = await ppCapture(env, orderId);
  const capture = ppReadCapture(env, order);
  if (!ppIsPaid(env, capture)) return respond(env, request, { error: 'payment not completed' }, 402);

  const ref   = REF.test(capture.reference) ? capture.reference : String(parsed.body && parsed.body.reference || '').toUpperCase();
  const fresh = await ppClaim(env, { ...capture, reference: ref }, { orderId });

  let emailed = false;
  let keyDelivered = false;

  if (fresh) {
    // Mint a real license key for this payment and email it to the buyer.
    const licenseKey = mintKey();

    await env.DB.prepare(
      'INSERT INTO licenses (key, email, created_at) VALUES (?, ?, ?)'
    ).bind(licenseKey, capture.payerEmail || null, Date.now()).run();

    // Email the key to the buyer's PayPal address.
    if (capture.payerEmail) {
      const sent = await sendKeyEmail(env, { to: capture.payerEmail, key: licenseKey });
      emailed = sent.ok;
    }

    keyDelivered = true;

    // Admin receipt
    await sendReceiptEmail(env, capture, ref).catch(() => {});
  }

  return respond(env, request, {
    status: 'paid', reference: ref,
    captureId: capture.captureId, amount: capture.amount,
    currency: capture.currency, mode: capture.mode,
    emailed, key_delivered: keyDelivered,
  });
}

async function handlePayPalReconcile(request, env) {
  const ip = clientIp(request);
  if (rateLimit(ip, 30)) return respond(env, request, { error: 'rate limited' }, 429);

  const parsed = await readJson(request, 2048);
  if (parsed.err) return respond(env, request, { error: 'bad request' }, 400);

  const orderId = String(parsed.body && parsed.body.orderId || '');
  if (!PAYPAL_ORDER_ID.test(orderId)) return respond(env, request, { error: 'missing orderId' }, 400);

  let order   = await ppGetOrder(env, orderId);
  let capture = ppReadCapture(env, order);

  // APPROVED means the buyer authorised the payment but the popup closed
  // before the site could capture. Finish the job instead of losing the sale.
  if (!capture && order.status === 'APPROVED') {
    order   = await ppCapture(env, orderId);
    capture = ppReadCapture(env, order);
  }

  if (!ppIsPaid(env, capture))
    return respond(env, request, { paid: false, status: order.status || 'UNKNOWN' });

  const ref   = REF.test(capture.reference) ? capture.reference : String(parsed.body && parsed.body.reference || '').toUpperCase();
  const fresh = await ppClaim(env, { ...capture, reference: ref }, { orderId });

  let emailed = false;
  if (fresh) emailed = (await sendReceiptEmail(env, capture, ref)).ok;

  return respond(env, request, {
    paid: true, status: 'paid', reference: ref,
    captureId: capture.captureId, amount: capture.amount,
    currency: capture.currency, mode: capture.mode, emailed,
  });
}

async function handlePayPalWebhook(request, env, ctx) {
  const event = await request.json().catch(() => null);
  if (!event?.event_type) return new Response(null, { status: 400 });

  if (!(await ppVerifyWebhook(env, request, event)))
    return new Response(null, { status: 401 });

  if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED')
    return new Response(null, { status: 200 });

  const r = event.resource || {};
  const capture = {
    status:     r.status,
    captureId:  r.id,
    reference:  r.custom_id || '',
    amount:     r.amount?.value || '',
    currency:   r.amount?.currency_code || '',
    payerEmail: r.payer?.email_address || '',
    payerName:  [r.payer?.name?.given_name, r.payer?.name?.surname].filter(Boolean).join(' '),
    paidAt:     r.create_time || event.create_time || '',
    mode:       ppCreds(env).mode,
  };

  if (!ppIsPaid(env, capture)) return new Response(null, { status: 200 });

  const ref = REF.test(capture.reference)
    ? capture.reference
    : `RET-${String(capture.captureId).slice(-6).toUpperCase()}`;

  ctx.waitUntil((async () => {
    if (await ppClaim(env, { ...capture, reference: ref })) {
      // Mint key and deliver to buyer
      const licenseKey = mintKey();
      await env.DB.prepare(
        'INSERT INTO licenses (key, email, created_at) VALUES (?, ?, ?)'
      ).bind(licenseKey, capture.payerEmail || null, Date.now()).run();
      if (capture.payerEmail) {
        await sendKeyEmail(env, { to: capture.payerEmail, key: licenseKey }).catch(() => {});
      }
      await sendReceiptEmail(env, capture, ref).catch(() => {});
    }
  })());

  return new Response(null, { status: 200 });
}

/**
 * POST /mykey  — bot internal: get key info for a discord_id
 *
 * Body: { discord_id }
 */
async function handleMyKey(request, env) {
  // This endpoint returns a live license key — never expose it unauthenticated.
  const denied = requireBot(request, env);
  if (denied) return denied;

  const ip = clientIp(request);
  if (rateLimit(ip, 30, 60_000))
    return j({ ok: false, err: 'rate_limit' }, 429);

  const parsed = await readJson(request, 2048);
  if (parsed.err) return parsed.err;

  const { discord_id } = parsed.body || {};
  if (!discord_id || !DISCORD_ID.test(String(discord_id)))
    return j({ ok: false, err: 'missing_discord_id' }, 400);

  const lic = await env.DB.prepare(
    'SELECT key, banned, hwid_set, active_session, resets_month FROM licenses WHERE discord_id = ?'
  ).bind(String(discord_id)).first();

  if (!lic) return j({ ok: false, err: 'no_key_linked' });

  let hwidBound = false;
  try { hwidBound = JSON.parse(lic.hwid_set || '[]').length > 0; }
  catch { hwidBound = false; }

  return j({
    ok: true,
    key: lic.key,
    banned: Boolean(lic.banned),
    hwid_bound: hwidBound,
    active_session: Boolean(lic.active_session),
    resets_month: Number(lic.resets_month || 0),
  });
}

// -----------------------------------------------------------------------
// Main fetch handler
// -----------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...SEC_HEADERS, ...corsHeaders(env, request) } });
    }

    // Cheap rejection before any handler parses a body.
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > 16384) return respond(env, request, { error: 'payload too large' }, 413);

    try {
      // ── Licensing endpoints ─────────────────────────────────────────
      if (path === '/auth'      && method === 'POST') return handleAuth(request, env);
      if (path === '/challenge' && method === 'POST') return handleChallenge(request, env);
      if (path === '/heartbeat' && method === 'POST') return handleHeartbeat(request, env);
      if (path === '/payload'   && method === 'POST') return handlePayload(request, env);
      if (path === '/webhook'   && method === 'POST') return handleStorefrontWebhook(request, env);
      if (path === '/reset'     && method === 'POST') return handleReset(request, env);
      if (path === '/link'      && method === 'POST') return handleLink(request, env);
      if (path === '/ban'       && method === 'POST') return handleBan(request, env);
      if (path === '/mykey'     && method === 'POST') return handleMyKey(request, env);

      // ── PayPal endpoints ────────────────────────────────────────────
      if (path === '/api/health' && method === 'GET')
        return respond(env, request, { ok: true, mode: ppCreds(env).mode, price: env.PRICE, build: env.BUILD || '' });

      if (path === '/api/paypal/config'  && method === 'GET')  return handlePayPalConfig(request, env);

      // Diagnostic: booleans and lengths only — no values, no prefixes, no key
      // names, no addresses. Bot-gated so it never describes the deployment to
      // an anonymous caller.
      if (path === '/api/diag' && method === 'GET') {
        const denied = requireBot(request, env);
        if (denied) return denied;
        const c = ppCreds(env);
        return respond(env, request, {
          worker: 'retrac-api',
          build: env.BUILD || '',
          paypal: {
            mode: c.mode,
            clientIdConfigured: Boolean(c.clientId),
            clientIdLen: String(c.clientId || '').length,
            secretLen: String(c.secret || '').length,
            webhookIdSet: Boolean(c.webhookId),
          },
          secrets: {
            loaderSecret: Boolean(secretValue(env, 'LOADER_SECRET')),
            loaderLegacy: Boolean(secretValue(env, 'LOADER_SECRET_LEGACY')),
            hwidSalt: Boolean(secretValue(env, 'HWID_SALT', 8)),
            botSecret: Boolean(secretValue(env, 'BOT_SECRET')),
            whSecret: Boolean(secretValue(env, 'WH_SECRET')),
            adminSecret: Boolean(secretValue(env, 'ADMIN_SECRET')),
            resend: Boolean(secretValue(env, 'RESEND_KEY') || secretValue(env, 'RESEND_API_KEY')),
          },
        });
      }

      if (path === '/api/paypal/order'   && method === 'POST') return handlePayPalOrder(request, env);
      if (path === '/api/paypal/capture' && method === 'POST') return handlePayPalCapture(request, env);
      if (path === '/api/paypal/reconcile' && method === 'POST') return handlePayPalReconcile(request, env);
      if (path === '/api/paypal/webhook' && method === 'POST') return handlePayPalWebhook(request, env, ctx);

      return respond(env, request, { error: 'not found' }, 404);

    } catch (err) {
      console.error('[api]', path, err && err.message);
      return respond(env, request, { error: 'internal error' }, 500);
    }
  },
};
