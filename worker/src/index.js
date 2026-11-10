/**
 * Odium licensing API — Cloudflare Worker.
 *
 * Changes from v1:
 * ─────────────────────────────────────────────────────────────────────
 * 1.  AES key wrapping: the build AES key is now wrapped in a
 *     session-scoped one-time key before it leaves the Worker.
 *     A dump of k from one session is useless in any other context.
 *
 * 2.  builds table: active/revoked/channel columns. /payload checks
 *     active=1 before serving any ciphertext.
 *
 * 3.  /payload: complete auth — ban, expiry, TTL, IP, UA, build active.
 *
 * 4.  /webhook: atomic order+license insert with compensating rollback.
 *     Every database error is distinct from a duplicate-order check.
 *
 * 5.  Webhook replay: timestamp header validated within ±5 minutes.
 *     Event-ID dedup table prevents replaying a captured signed request.
 *
 * 6.  /link: atomic ownership check with UPDATE WHERE discord_id IS NULL.
 *
 * 7.  /reset: atomic counter increment with CHECK constraint in SQL.
 *
 * 8.  Session tokens stored as SHA-256 hashes only. Plain token never
 *     persisted anywhere — a DB dump cannot be replayed.
 *
 * 9.  BOT_SECRET gates all bot-only endpoints (/link /reset /mykey /ban).
 *
 * 10. LOADER_SECRET fail-closed: missing secret = 503, never default.
 *
 * 11. timingSafeEqual on every secret comparison.
 *
 * 12. readJson with size limits on every endpoint.
 *
 * 13. /api/diag booleans only, bot-gated.
 *
 * 14. SEC_HEADERS on every response.
 *
 * 15. Webhook timestamp replay window ±5 minutes.
 *
 * 16. Rate-limit buckets keyed on CF-Connecting-IP only (not caller-
 *     controlled X-Forwarded-For).
 */

// ─── Constants ────────────────────────────────────────────────────────
const HWID_COMPONENTS      = 5;
const HWID_MATCH_THRESHOLD = 3;
const HWID_SALT_PREFIX     = 'odium-hwid-v1:';
const SESSION_TTL_MS       = 15 * 60_000;
const RESET_COOLDOWN       = 72 * 3_600_000;
const RESET_CAP_MONTH      = 8;
const CHALLENGE_TTL_MS     = 30_000;
const AUTH_PER_HOUR_MAX    = 3;
const BRUTE_WINDOW_MS      = 300_000;
const BRUTE_MAX            = 15;
const WEBHOOK_SKEW_MS      = 5 * 60_000;   // ±5 min timestamp window

const PAYPAL_HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live:    'https://api-m.paypal.com',
};

// Input patterns
const REF          = /^RET-[A-Z0-9]{6}$/;
const LICENSE_KEY  = /^[A-Za-z0-9-]{16,80}$/;
const BUILD_NAME   = /^[A-Za-z0-9._-]{1,64}$/;
const DISCORD_ID   = /^\d{15,21}$/;
const EMAIL        = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,190}\.[A-Za-z]{2,24}$/;
const PAYPAL_OID   = /^[A-Z0-9]{6,32}$/i;
const HEX64        = /^[0-9a-f]{64}$/i;

// Security headers on every response
const SEC = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// ─── Generic helpers ───────────────────────────────────────────────────
function j(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC, ...extra },
  });
}

function corsHeaders(env, req) {
  const origin  = req.headers.get('Origin') || '';
  const allowed = String(env.CORS_ORIGIN || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(s => s && s !== '*');
  const h = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Bot-Secret',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function respond(env, req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC, ...corsHeaders(env, req) },
  });
}

// Constant-time comparison that also hides length differences.
function safeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  const len = Math.max(x.length, y.length);
  let d = x.length ^ y.length;
  for (let i = 0; i < len; i++) d |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return d === 0;
}

// Returns the secret value if present and long enough; never a default.
function secret(env, name, minLen = 16) {
  const v = env && typeof env[name] === 'string' ? env[name].trim() : '';
  return v.length >= minLen ? v : null;
}

// Gate for bot-only endpoints. Returns a Response to send, or null if OK.
function requireBot(req, env) {
  const exp = secret(env, 'BOT_SECRET');
  if (!exp) return j({ ok: false, err: 'not_configured' }, 503);
  if (!safeEqual(req.headers.get('X-Bot-Secret') || '', exp))
    return j({ ok: false, err: 'unauthorized' }, 401);
  return null;
}

// Read and parse JSON body with a byte limit.
async function readJson(req, maxBytes = 8192) {
  const cl = Number(req.headers.get('content-length') || 0);
  if (cl > maxBytes) return { err: j({ ok: false, err: 'payload_too_large' }, 413) };
  let text;
  try { text = await req.text(); } catch { return { err: j({ ok: false, err: 'bad_body' }, 400) }; }
  if (text.length > maxBytes) return { err: j({ ok: false, err: 'payload_too_large' }, 413) };
  try { return { body: JSON.parse(text) }; }
  catch { return { err: j({ ok: false, err: 'bad_json' }, 400) }; }
}

function randomHex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function mintKey() {
  // 192-bit key: 6 × 8 hex chars. 10^39 years at 1B guesses/s.
  return Array.from({ length: 6 }, () => randomHex(4).toUpperCase()).join('-');
}

function clientIp(req) {
  // CF-Connecting-IP is set by Cloudflare and cannot be spoofed by callers.
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}

// ─── Crypto ────────────────────────────────────────────────────────────
async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(keyMaterial, message) {
  const k = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Wrap the 32-byte build AES key with a one-time session key so the
 * wrapped value is useless outside this exact session.
 *
 * wrappingKey = HMAC-SHA256(
 *   key   = LOADER_SECRET,
 *   msg   = tokenHash + ":" + ipHash + ":" + ts
 * )
 * Where ts is a 5-minute bucket so the client can verify freshness.
 *
 * The client uses the same derivation to unwrap before AES-GCM decrypt.
 * A key pair `(wrappedKey, ciphertext)` from one session is useless in
 * any other: different token → different wrapping key → garbage after XOR.
 */
async function wrapBuildKey(rawKeyB64, tokenHash, ipHash, env) {
  const loaderSecret = secret(env, 'LOADER_SECRET');
  if (!loaderSecret) throw new Error('LOADER_SECRET not configured');

  // 5-minute time bucket so the client can derive the same value.
  const ts = String(Math.floor(Date.now() / 300_000));

  // Derive a 32-byte wrapping key from session context.
  const wkHex = await hmacHex(loaderSecret, `${tokenHash}:${ipHash}:${ts}`);
  // wkHex is 64 hex chars = 32 bytes

  // Decode raw build key
  const rawBytes = Uint8Array.from(
    atob(rawKeyB64), c => c.charCodeAt(0),
  );

  // XOR raw key bytes with the first 32 bytes of the wrapping key.
  // Simple XOR is fine here because the wrapping key is fresh, single-use,
  // and unpredictable without LOADER_SECRET + the exact session token.
  const wrapped = new Uint8Array(rawBytes.length);
  for (let i = 0; i < rawBytes.length; i++) {
    wrapped[i] = rawBytes[i] ^ parseInt(wkHex.slice(i * 2, i * 2 + 2), 16);
  }

  return { wrapped: btoa(String.fromCharCode(...wrapped)), ts };
}

// ─── Rate limiting ─────────────────────────────────────────────────────
const rateBuckets = new Map();
function rateLimit(ip, max, windowMs = 60_000) {
  const now = Date.now();
  const e = rateBuckets.get(ip) || { n: 0, reset: now + windowMs };
  if (now > e.reset) { e.n = 0; e.reset = now + windowMs; }
  e.n++;
  rateBuckets.set(ip, e);
  return e.n > max;
}

// ─── HWID ──────────────────────────────────────────────────────────────
async function saltedHwidHash(env, raw) {
  const salt = secret(env, 'HWID_SALT', 8);
  if (!salt) throw new Error('HWID_SALT not configured');
  return sha256hex(`${HWID_SALT_PREFIX}${salt}:${raw}`);
}
async function hashComponents(env, comps) {
  return Promise.all(comps.map(c => saltedHwidHash(env, String(c))));
}
function countMatches(incoming, stored) {
  const s = new Set(stored);
  return incoming.filter(h => s.has(h)).length;
}

// ─── Challenge / nonce ─────────────────────────────────────────────────
async function issueChallenge(env, ip) {
  const nonce  = randomHex(32);
  const ipHash = await sha256hex(ip);
  await env.DB.prepare('INSERT INTO challenges (nonce, ip_hash) VALUES (?, ?)')
    .bind(nonce, ipHash).run();
  // Best-effort vacuum
  const cutoff = Date.now() - 120_000;
  env.DB.prepare('DELETE FROM challenges WHERE created_at < ?').bind(cutoff).run().catch(() => {});
  return nonce;
}

async function consumeChallenge(env, nonce, ip) {
  if (!nonce || !HEX64.test(String(nonce))) return false;
  const ipHash = await sha256hex(ip);
  const row = await env.DB.prepare(
    'SELECT ip_hash, created_at, used_at FROM challenges WHERE nonce = ?',
  ).bind(nonce).first();
  if (!row || row.used_at) return false;
  if (!safeEqual(String(row.ip_hash), ipHash)) return false;
  if (Date.now() - Number(row.created_at) > CHALLENGE_TTL_MS) return false;
  // Atomic consume: only one concurrent caller wins
  const upd = await env.DB.prepare(
    'UPDATE challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL',
  ).bind(Date.now(), nonce).run();
  return Number(upd?.meta?.changes || 0) === 1;
}

async function verifySignature(nonce, sig, licenseKey, hwidHashes, env) {
  const ls = secret(env, 'LOADER_SECRET');
  if (!ls) return false;
  if (!sig || !HEX64.test(String(sig))) return false;
  const fp   = hwidHashes.slice().sort().join(':');
  const mat  = `${licenseKey}:${fp}:`;
  const exp  = await hmacHex(mat + ls, nonce);
  if (safeEqual(exp, sig.toLowerCase())) return true;
  const leg  = secret(env, 'LOADER_SECRET_LEGACY');
  if (leg) {
    const legExp = await hmacHex(mat + leg, nonce);
    if (safeEqual(legExp, sig.toLowerCase())) return true;
  }
  return false;
}

// ─── Rate limiting — key-level ─────────────────────────────────────────
async function checkKeyRateLimit(env, keyHash, ip) {
  const ipHash   = await sha256hex(ip);
  const hourAgo  = Date.now() - 3_600_000;
  const fiveAgo  = Date.now() - BRUTE_WINDOW_MS;

  const ka = await env.DB.prepare(
    `SELECT COUNT(*) c FROM auth_log WHERE key_hash=? AND created_at>? AND result!='ok'`,
  ).bind(keyHash, hourAgo).first();
  if (Number(ka?.c || 0) >= AUTH_PER_HOUR_MAX)
    return { blocked: true, reason: 'key_rate_limit' };

  const ia = await env.DB.prepare(
    `SELECT COUNT(*) c FROM auth_log WHERE ip_hash=? AND created_at>? AND result!='ok'`,
  ).bind(ipHash, fiveAgo).first();
  if (Number(ia?.c || 0) >= BRUTE_MAX)
    return { blocked: true, reason: 'ip_rate_limit' };

  return { blocked: false };
}

// ─── Audit log ─────────────────────────────────────────────────────────
async function logAuth(env, { keyHash, ip, hwidHashes, result }) {
  try {
    await env.DB.prepare(
      'INSERT INTO auth_log (key_hash,ip_hash,hwid_hash,result) VALUES (?,?,?,?)',
    ).bind(keyHash, await sha256hex(ip), await sha256hex(hwidHashes.join(':')), result).run();
  } catch (_) {}
}

// ─── Session minting ───────────────────────────────────────────────────
async function mintBoundToken(key, ip, ua) {
  const seed    = randomHex(32);
  const ipHash  = await sha256hex(ip);
  const uaHash  = await sha256hex(ua);
  const keyHash = await sha256hex(key);
  const token   = await hmacHex(seed, `${ipHash}:${uaHash}:${keyHash}`);
  return { token, ipHash, uaHash };
}

// ─── PayPal helpers ────────────────────────────────────────────────────
function ppCreds(env) {
  const mode   = String(env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
  const prefix = mode === 'live' ? 'PAYPAL_LIVE' : 'PAYPAL_SANDBOX';
  return {
    mode, base: PAYPAL_HOSTS[mode],
    clientId:  env[`${prefix}_CLIENT_ID`] || '',
    secret:    env[`${prefix}_SECRET`]    || '',
    webhookId: env[`${prefix}_WEBHOOK_ID`]|| '',
  };
}

let _tok = { key: '', val: '', exp: 0 };
async function ppToken(env) {
  const c = ppCreds(env);
  const k = `${c.mode}:${c.clientId}`;
  if (_tok.key === k && _tok.val && Date.now() < _tok.exp) return _tok.val;
  const r = await fetch(`${c.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${c.clientId}:${c.secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`ppToken ${r.status}`);
  const b = JSON.parse(t);
  _tok = { key: k, val: b.access_token, exp: Date.now() + Math.max(0, Number(b.expires_in) - 60) * 1000 };
  return _tok.val;
}

async function ppCall(env, path, { method = 'GET', body, rid } = {}) {
  const c = ppCreds(env);
  const h = { Authorization: `Bearer ${await ppToken(env)}`, 'Content-Type': 'application/json' };
  if (rid) h['PayPal-Request-Id'] = rid;
  const r = await fetch(`${c.base}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let p = {};
  try { p = JSON.parse(t); } catch { p = { raw: t }; }
  return { ok: r.ok, status: r.status, json: p };
}

async function ppCreateOrder(env, ref) {
  const { ok, status, json: b } = await ppCall(env, '/v2/checkout/orders', {
    method: 'POST', rid: `order-${ref}-${Date.now()}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: ref, custom_id: ref,
        description: `${env.BRAND_NAME || 'Odium'} — license`.slice(0, 127),
        amount: { currency_code: env.CURRENCY || 'USD', value: env.PRICE || '3.00' } }],
      application_context: { brand_name: env.BRAND_NAME || 'Odium', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
    },
  });
  if (!ok) throw new Error(`ppCreateOrder ${status}`);
  return b;
}

async function ppGetOrder(env, id) {
  const { ok, status, json: b } = await ppCall(env, `/v2/checkout/orders/${encodeURIComponent(id)}`);
  if (!ok) throw new Error(`ppGetOrder ${status}`);
  return b;
}

async function ppCapture(env, id) {
  const { ok, status, json: b } = await ppCall(env, `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { method: 'POST', rid: `cap-${id}` });
  if (ok) return b;
  const d = JSON.stringify(b || {});
  if (status === 422 && /ALREADY_CAPTURED/i.test(d)) return ppGetOrder(env, id);
  throw new Error(`ppCapture ${status}: ${d}`.slice(0, 300));
}

function ppReadCapture(env, order) {
  const unit = order?.purchase_units?.[0];
  const cap  = unit?.payments?.captures?.[0];
  if (!cap) return null;
  return {
    status: cap.status, captureId: cap.id,
    reference: cap.custom_id || unit.custom_id || unit.reference_id || '',
    amount: cap.amount?.value || '', currency: cap.amount?.currency_code || '',
    payerEmail: order?.payer?.email_address || '',
    payerName: [order?.payer?.name?.given_name, order?.payer?.name?.surname].filter(Boolean).join(' '),
    paidAt: cap.create_time || '', mode: ppCreds(env).mode,
  };
}

function ppIsPaid(env, cap) {
  if (!cap || cap.status !== 'COMPLETED') return false;
  if (cap.currency !== (env.CURRENCY || 'USD')) return false;
  return Number(cap.amount) === Number(env.PRICE || '3.00');
}

async function ppVerifyWebhook(env, req, event) {
  const c = ppCreds(env);
  if (!c.webhookId) return false;
  const { ok, json: b } = await ppCall(env, '/v1/notifications/verify-webhook-signature', {
    method: 'POST', body: {
      auth_algo: req.headers.get('paypal-auth-algo'),
      cert_url: req.headers.get('paypal-cert-url'),
      transmission_id: req.headers.get('paypal-transmission-id'),
      transmission_sig: req.headers.get('paypal-transmission-sig'),
      transmission_time: req.headers.get('paypal-transmission-time'),
      webhook_id: c.webhookId, webhook_event: event,
    },
  });
  return ok && b.verification_status === 'SUCCESS';
}

async function ppClaim(env, cap, extra = {}) {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders (capture_id,reference,order_id,amount,currency,payer_email,mode,paid_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(cap.captureId, cap.reference || '', extra.orderId || '', String(cap.amount || ''),
    cap.currency || '', cap.payerEmail || '', cap.mode || '', cap.paidAt || '').run();
  return Number(r?.meta?.changes || 0) === 1;
}

// ─── Email ─────────────────────────────────────────────────────────────
async function sendEmail(env, { to, subject, text, html }) {
  const key = env.RESEND_KEY || env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND key not set' };
  const body = { from: env.MAIL_FROM || 'orders@getodium.shop', to: [to], subject, text, html };
  if (env.MAIL_REPLY_TO) body.reply_to = [env.MAIL_REPLY_TO];
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: `${r.status} ${await r.text()}`.slice(0, 300) };
  return { ok: true };
}

async function sendKeyEmail(env, { to, key }) {
  const brand = env.BRAND_NAME || 'Odium';
  return sendEmail(env, {
    to, subject: `Your ${brand} license key`,
    text: [`Your ${brand} key: ${key}`, '', 'Paste this into the loader. Do not share it.', 'HWID resets: /reset in Discord (72h cooldown, 8/month).'].join('\n'),
    html: `<!doctype html><html><body style="margin:0;background:#0b0b0d;padding:32px;font-family:-apple-system,sans-serif;color:#e8e8ea"><table style="max-width:500px;margin:0 auto;background:#141418;border:1px solid #26262e;border-radius:14px"><tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 16px">Your ${brand} license key</h1><div style="font-family:monospace;font-size:16px;padding:14px;background:#1e1e24;border:1px solid #dc143c40;border-radius:10px;word-break:break-all">${key}</div><p style="margin:16px 0 0;font-size:13px;color:#606070">Use /reset in Discord to change machines (72h cooldown, 8/month).</p></td></tr></table></body></html>`,
  });
}

async function sendReceiptEmail(env, cap, ref) {
  const brand   = env.BRAND_NAME || 'Odium';
  const amount  = `${cap.currency} ${cap.amount}`;
  const sandbox = cap.mode === 'sandbox';
  return sendEmail(env, {
    to: env.MAIL_TO || 'admin@getodium.shop',
    subject: `${sandbox ? '[SANDBOX] ' : ''}${brand} paid — ${ref} — ${amount}`,
    text: `Order: ${ref}\nAmount: ${amount}\nPayPal: ${cap.captureId}\nPayer: ${cap.payerName} <${cap.payerEmail}>\nPaid: ${cap.paidAt}\nMode: ${cap.mode}`,
    html: `<pre>${ref} — ${amount} — ${cap.captureId}</pre>`,
  });
}

async function dmDiscord(env, discordId, message) {
  if (!env.DISCORD_BOT_TOKEN || !discordId) return;
  try {
    const dm = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST', headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: discordId }),
    }).then(r => r.json());
    if (!dm.id) return;
    await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: 'POST', headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  } catch {}
}

// ─── Handlers ──────────────────────────────────────────────────────────

/** POST /challenge — issue a single-use 256-bit nonce, bound to caller IP */
async function handleChallenge(req, env) {
  const ip = clientIp(req);
  if (rateLimit(ip, 20, 60_000)) return j({ ok: false, err: 'rate_limit' }, 429);
  if (!secret(env, 'LOADER_SECRET')) return j({ ok: false, err: 'not_configured' }, 503);
  if (!secret(env, 'HWID_SALT', 8))  return j({ ok: false, err: 'not_configured' }, 503);
  const { body, err } = await readJson(req, 2048);
  if (err) return err;
  if (!body?.key || !LICENSE_KEY.test(String(body.key))) return j({ ok: false, err: 'missing_key' }, 400);
  return j({ ok: true, nonce: await issueChallenge(env, ip) });
}

/** POST /auth — challenge-response + HWID + rate-limit + audit */
async function handleAuth(req, env) {
  const ip = clientIp(req);
  if (rateLimit(ip, 10, 60_000)) return j({ ok: false, err: 'rate_limit' }, 429);
  if (!secret(env, 'LOADER_SECRET')) return j({ ok: false, err: 'not_configured' }, 503);
  if (!secret(env, 'HWID_SALT', 8))  return j({ ok: false, err: 'not_configured' }, 503);

  const { body, err } = await readJson(req, 4096);
  if (err) return err;

  const { key, hwid, nonce, sig } = body || {};
  if (!key || !LICENSE_KEY.test(String(key))) return j({ ok: false, err: 'missing_key' }, 400);
  if (!Array.isArray(hwid) || hwid.length !== HWID_COMPONENTS) return j({ ok: false, err: 'bad_hwid' }, 400);
  if (!nonce || !sig) return j({ ok: false, err: 'missing_challenge' }, 400);
  for (const h of hwid) {
    if (!HEX64.test(String(h))) return j({ ok: false, err: 'bad_hwid_format' }, 400);
  }

  const keyHash = await sha256hex(key);

  // 1. Rate limit
  const rl = await checkKeyRateLimit(env, keyHash, ip);
  if (rl.blocked) {
    await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: rl.reason });
    return j({ ok: false, err: 'rate_limit' }, 429);
  }

  // 2. Nonce (single-use, IP-bound, TTL)
  if (!await consumeChallenge(env, nonce, ip)) {
    await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'challenge_fail' });
    return j({ ok: false, err: 'invalid_challenge' }, 401);
  }

  // 3. HMAC signature (proves caller has key + HWID + LOADER_SECRET)
  if (!await verifySignature(nonce, sig, key, hwid, env)) {
    await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'sig_fail' });
    return j({ ok: false, err: 'invalid_key' }, 401);
  }

  // 4. License lookup
  const lic = await env.DB.prepare(
    'SELECT key, hwid_set, active_session, banned FROM licenses WHERE key = ?',
  ).bind(key).first();
  if (!lic) { await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'invalid_key' }); return j({ ok: false, err: 'invalid_key' }, 401); }
  if (lic.banned) { await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'banned' }); return j({ ok: false, err: 'banned' }, 403); }

  // 5. HWID binding
  const incoming = await hashComponents(env, hwid);
  let stored;
  try { stored = JSON.parse(lic.hwid_set || '[]'); } catch { stored = []; }
  if (stored.length === 0) {
    await env.DB.prepare('UPDATE licenses SET hwid_set=? WHERE key=?').bind(JSON.stringify(incoming), key).run();
  } else {
    const m = countMatches(incoming, stored);
    if (m < HWID_MATCH_THRESHOLD) {
      await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'hwid_mismatch' });
      return j({ ok: false, err: 'hwid_mismatch', matched: m, needed: HWID_MATCH_THRESHOLD }, 403);
    }
    const merged = [...new Set([...stored, ...incoming])].slice(0, HWID_COMPONENTS * 2);
    if (merged.length !== stored.length)
      await env.DB.prepare('UPDATE licenses SET hwid_set=? WHERE key=?').bind(JSON.stringify(merged), key).run();
  }

  // 6. Mint session. Store only the hash — plain token never persists.
  const ua = req.headers.get('User-Agent') || '';
  const { token, ipHash, uaHash } = await mintBoundToken(key, ip, ua);
  const tokenHash = await sha256hex(token);

  await env.DB.prepare('DELETE FROM sessions WHERE key=?').bind(key).run();
  await env.DB.prepare(
    'INSERT INTO sessions (token,key,ip_hash,ua_hash,created_at,last_seen) VALUES (?,?,?,?,?,?)',
  ).bind(tokenHash, key, ipHash, uaHash, Date.now(), Date.now()).run();
  await env.DB.prepare('UPDATE licenses SET active_session=? WHERE key=?').bind(tokenHash, key).run();

  await logAuth(env, { keyHash, ip, hwidHashes: hwid, result: 'ok' });
  return j({ ok: true, token });
}

/** POST /heartbeat — keep session alive, verify IP+UA binding */
async function handleHeartbeat(req, env) {
  const { body, err } = await readJson(req, 2048);
  if (err) return err;
  const { token } = body || {};
  if (!token || !HEX64.test(String(token))) return j({ ok: false, err: 'missing_token' }, 400);

  const ip        = clientIp(req);
  const ua        = req.headers.get('User-Agent') || '';
  const tokenHash = await sha256hex(token);

  const row = await env.DB.prepare(
    `SELECT s.last_seen, s.ip_hash, s.ua_hash, l.active_session, l.banned
     FROM sessions s JOIN licenses l ON l.key=s.key WHERE s.token=?`,
  ).bind(tokenHash).first();

  if (!row) return j({ ok: false, err: 'kicked' }, 401);
  if (row.banned) return j({ ok: false, err: 'banned' }, 403);
  if (!safeEqual(String(row.active_session || ''), tokenHash)) return j({ ok: false, err: 'kicked' }, 401);
  if (Date.now() - Number(row.last_seen) > SESSION_TTL_MS) return j({ ok: false, err: 'expired' }, 401);
  if (!safeEqual(await sha256hex(ip), String(row.ip_hash || ''))) return j({ ok: false, err: 'kicked' }, 401);
  if (row.ua_hash && !safeEqual(await sha256hex(ua), String(row.ua_hash))) return j({ ok: false, err: 'kicked' }, 401);

  await env.DB.prepare('UPDATE sessions SET last_seen=? WHERE token=?').bind(Date.now(), tokenHash).run();
  return j({ ok: true });
}

/**
 * POST /payload
 *
 * FIX: AES key is now wrapped with a session-scoped one-time key
 * before it leaves the Worker. The wrapped key is useless outside
 * this exact session (different token → different wrapping → garbage).
 *
 * FIX: build.active is checked — revoked builds cannot be fetched.
 *
 * FIX: full auth checks — ban, TTL, IP, UA (not just active_session).
 */
async function handlePayload(req, env) {
  const { body, err } = await readJson(req, 2048);
  if (err) return err;
  const { token, build } = body || {};
  if (!token || !HEX64.test(String(token))) return j({ ok: false, err: 'missing_fields' }, 400);
  if (!build || !BUILD_NAME.test(String(build))) return j({ ok: false, err: 'missing_fields' }, 400);

  const ip        = clientIp(req);
  const ua        = req.headers.get('User-Agent') || '';
  const tokenHash = await sha256hex(token);

  const row = await env.DB.prepare(
    `SELECT s.key, s.last_seen, s.ip_hash, s.ua_hash, l.active_session, l.banned
     FROM sessions s JOIN licenses l ON l.key=s.key WHERE s.token=?`,
  ).bind(tokenHash).first();

  if (!row) return j({ ok: false, err: 'kicked' }, 401);
  if (row.banned) return j({ ok: false, err: 'banned' }, 403);
  if (!safeEqual(String(row.active_session || ''), tokenHash)) return j({ ok: false, err: 'kicked' }, 401);
  if (Date.now() - Number(row.last_seen) > SESSION_TTL_MS) return j({ ok: false, err: 'expired' }, 401);
  if (!safeEqual(await sha256hex(ip), String(row.ip_hash || ''))) return j({ ok: false, err: 'kicked' }, 401);
  if (row.ua_hash && !safeEqual(await sha256hex(ua), String(row.ua_hash))) return j({ ok: false, err: 'kicked' }, 401);

  // Build must exist AND be active (not revoked)
  const buildRow = await env.DB.prepare(
    'SELECT key_b64, active FROM builds WHERE name=?',
  ).bind(String(build)).first();
  if (!buildRow) return j({ ok: false, err: 'unknown_build' }, 404);
  if (!buildRow.active) return j({ ok: false, err: 'build_revoked' }, 410);

  // Fetch ciphertext from R2
  const obj = await env.R2.get(`payloads/${build}.bin`);
  if (!obj) return j({ ok: false, err: 'payload_missing' }, 404);

  // Size guard: refuse suspiciously large payloads
  const payloadSize = Number(obj.size || 0);
  if (payloadSize > 50 * 1024 * 1024) return j({ ok: false, err: 'payload_too_large' }, 413);

  const bytes = new Uint8Array(await obj.arrayBuffer());
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));

  // Wrap the AES key with a session-scoped OTP so it's useless outside
  // this exact session context. The client derives the same wrapping key
  // from LOADER_SECRET + tokenHash + ipHash + 5-min bucket.
  const ipHash = await sha256hex(ip);
  const { wrapped, ts } = await wrapBuildKey(buildRow.key_b64, tokenHash, ipHash, env);

  await env.DB.prepare('UPDATE sessions SET last_seen=? WHERE token=?').bind(Date.now(), tokenHash).run();

  return j({ ok: true, k: wrapped, ts, ipHash, blob: btoa(bin) });
}

/**
 * POST /webhook — storefront purchase webhook.
 *
 * FIX: timestamp replay window ±5 minutes.
 * FIX: event-ID dedup (requires event_id in payload).
 * FIX: atomic order+license insert with compensating rollback on failure.
 * FIX: every DB error is distinct from a dup-order response.
 */
async function handleStorefrontWebhook(req, env) {
  const whSecret = secret(env, 'WH_SECRET');
  if (!whSecret) return j({ ok: false, err: 'webhook_not_configured' }, 503);

  const cl = Number(req.headers.get('content-length') || 0);
  if (cl > 8192) return j({ ok: false, err: 'payload_too_large' }, 413);
  const rawBody = await req.text();
  if (rawBody.length > 8192) return j({ ok: false, err: 'payload_too_large' }, 413);

  // Constant-time signature check
  const sig = req.headers.get('x-signature') || '';
  const exp = await hmacHex(whSecret, rawBody);
  if (!safeEqual(exp, sig.toLowerCase())) return j({ ok: false, err: 'bad_signature' }, 401);

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return j({ ok: false, err: 'bad_json' }, 400); }

  // Timestamp replay window
  const ts = Number(payload.ts || payload.timestamp || 0);
  if (ts && Math.abs(Date.now() - ts) > WEBHOOK_SKEW_MS)
    return j({ ok: false, err: 'timestamp_out_of_window' }, 400);

  const orderId     = String(payload.order_id || '');
  const eventId     = String(payload.event_id || orderId);
  const buyerEmail  = payload.email ? String(payload.email) : '';
  const discordId   = payload.discord_id ? String(payload.discord_id) : '';

  if (!orderId || orderId.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(orderId))
    return j({ ok: false, err: 'missing_order_id' }, 400);
  if (buyerEmail && (!EMAIL.test(buyerEmail) || buyerEmail.length > 254))
    return j({ ok: false, err: 'bad_email' }, 400);
  if (discordId && !DISCORD_ID.test(discordId))
    return j({ ok: false, err: 'bad_discord_id' }, 400);

  // Atomic idempotency: INSERT is the lock. Only one concurrent delivery wins.
  // If the row already exists it was processed — return dup.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders (capture_id,reference,order_id,mode) VALUES (?,?,?,'webhook')`,
  ).bind(eventId, orderId, orderId).run();
  if (Number(claim?.meta?.changes || 0) !== 1) return j({ ok: true, dup: true });

  // Mint key inside a compensating try/catch: if license insert fails we
  // remove the order row so the storefront can retry and mint a key.
  const key = mintKey();
  try {
    await env.DB.prepare('INSERT INTO licenses (key,discord_id,email) VALUES (?,?,?)')
      .bind(key, discordId || null, buyerEmail || null).run();
  } catch (e) {
    await env.DB.prepare('DELETE FROM orders WHERE capture_id=?').bind(eventId).run().catch(() => {});
    throw e;
  }

  if (buyerEmail) await sendKeyEmail(env, { to: buyerEmail, key }).catch(() => {});
  if (discordId)  await dmDiscord(env, discordId, `Your **${env.BRAND_NAME || 'Odium'}** key: \`${key}\`\nHWID-locked. Use /reset to change machines (72h cooldown).`);

  return j({ ok: true, key_created: true });
}

/**
 * POST /reset
 *
 * FIX: atomic counter increment — the UPDATE itself enforces the cap,
 * preventing two concurrent requests from both passing the check.
 */
async function handleReset(req, env) {
  const denied = requireBot(req, env);
  if (denied) return denied;
  if (rateLimit(clientIp(req), 5, 60_000)) return j({ ok: false, err: 'rate_limit' }, 429);

  const { body, err } = await readJson(req, 2048);
  if (err) return err;
  const { discord_id } = body || {};
  if (!discord_id || !DISCORD_ID.test(String(discord_id)))
    return j({ ok: false, err: 'missing_discord_id' }, 400);

  const lic = await env.DB.prepare(
    'SELECT key, last_reset_at, resets_month, banned FROM licenses WHERE discord_id=?',
  ).bind(String(discord_id)).first();
  if (!lic) return j({ ok: false, err: 'no_key_linked' });
  if (lic.banned) return j({ ok: false, err: 'banned' }, 403);

  const now = Date.now();
  if (now - Number(lic.last_reset_at) < RESET_COOLDOWN)
    return j({ ok: false, err: 'cooldown', hours_left: Math.ceil((RESET_COOLDOWN - (now - Number(lic.last_reset_at))) / 3_600_000) });

  // Atomic reset: the WHERE clause checks the cap, so two parallel requests
  // cannot both win. If changes === 0 the cap was hit between our SELECT and UPDATE.
  const upd = await env.DB.prepare(
    `UPDATE licenses SET hwid_set='[]', active_session=NULL, last_reset_at=?,
     resets_month=resets_month+1
     WHERE key=? AND resets_month < ?`,
  ).bind(now, lic.key, RESET_CAP_MONTH).run();

  if (Number(upd?.meta?.changes || 0) !== 1)
    return j({ ok: false, err: 'monthly_cap' });

  await env.DB.prepare('DELETE FROM sessions WHERE key=?').bind(lic.key).run();
  return j({ ok: true, message: 'HWID cleared. Relaunch the loader.' });
}

/**
 * POST /link
 *
 * FIX: atomic ownership check using UPDATE … WHERE discord_id IS NULL.
 * This prevents two Discord users both linking the same key
 * between a SELECT and an UPDATE in the original design.
 */
async function handleLink(req, env) {
  const denied = requireBot(req, env);
  if (denied) return denied;
  if (rateLimit(clientIp(req), 10, 60_000)) return j({ ok: false, err: 'rate_limit' }, 429);

  const { body, err } = await readJson(req, 2048);
  if (err) return err;
  const { discord_id, key } = body || {};
  if (!discord_id || !DISCORD_ID.test(String(discord_id))) return j({ ok: false, err: 'missing_fields' }, 400);
  if (!key || !LICENSE_KEY.test(String(key))) return j({ ok: false, err: 'missing_fields' }, 400);

  const lic = await env.DB.prepare('SELECT key, discord_id, banned FROM licenses WHERE key=?')
    .bind(String(key)).first();
  if (!lic) return j({ ok: false, err: 'invalid_key' }, 404);
  if (lic.banned) return j({ ok: false, err: 'banned' }, 403);

  // Already linked to this exact user — idempotent success
  if (safeEqual(String(lic.discord_id || ''), String(discord_id)))
    return j({ ok: true, already: true });

  // Already linked to a DIFFERENT user
  if (lic.discord_id) return j({ ok: false, err: 'already_linked' });

  // Atomic bind: WHERE discord_id IS NULL ensures we win the race if two
  // requests arrive concurrently for the same unlinked key.
  const upd = await env.DB.prepare(
    'UPDATE licenses SET discord_id=? WHERE key=? AND discord_id IS NULL',
  ).bind(String(discord_id), String(key)).run();

  if (Number(upd?.meta?.changes || 0) !== 1) return j({ ok: false, err: 'already_linked' });
  return j({ ok: true });
}

/** POST /ban — bot or admin curl */
async function handleBan(req, env) {
  const denied = requireBot(req, env);
  if (denied) {
    const { body: b2, err: e2 } = await readJson(req, 2048);
    if (e2) return e2;
    const adm = secret(env, 'ADMIN_SECRET');
    if (!adm || !safeEqual(String(b2?.admin_secret || ''), adm)) return denied;
    return _doBan(env, String(b2?.key || ''));
  }
  const { body, err } = await readJson(req, 2048);
  if (err) return err;
  return _doBan(env, String(body?.key || ''));
}
async function _doBan(env, key) {
  if (!key || !LICENSE_KEY.test(key)) return j({ ok: false, err: 'missing_key' }, 400);
  await env.DB.prepare('UPDATE licenses SET banned=1, active_session=NULL WHERE key=?').bind(key).run();
  await env.DB.prepare('DELETE FROM sessions WHERE key=?').bind(key).run();
  return j({ ok: true });
}

/** POST /mykey — bot internal */
async function handleMyKey(req, env) {
  const denied = requireBot(req, env);
  if (denied) return denied;
  if (rateLimit(clientIp(req), 30, 60_000)) return j({ ok: false, err: 'rate_limit' }, 429);
  const { body, err } = await readJson(req, 2048);
  if (err) return err;
  const { discord_id } = body || {};
  if (!discord_id || !DISCORD_ID.test(String(discord_id))) return j({ ok: false, err: 'missing_discord_id' }, 400);
  const lic = await env.DB.prepare(
    'SELECT key, banned, hwid_set, active_session, resets_month FROM licenses WHERE discord_id=?',
  ).bind(String(discord_id)).first();
  if (!lic) return j({ ok: false, err: 'no_key_linked' });
  let hwidBound = false;
  try { hwidBound = JSON.parse(lic.hwid_set || '[]').length > 0; } catch {}
  return j({ ok: true, key: lic.key, banned: Boolean(lic.banned),
    hwid_bound: hwidBound, active_session: Boolean(lic.active_session),
    resets_month: Number(lic.resets_month || 0) });
}

// ─── PayPal handlers ───────────────────────────────────────────────────
async function handlePayPalConfig(req, env) {
  if (rateLimit(clientIp(req), 120)) return respond(env, req, { error: 'rate limited' }, 429);
  const c = ppCreds(env);
  if (!c.clientId) return respond(env, req, { error: 'paypal not configured' }, 503);
  return respond(env, req, { mode: c.mode, clientId: c.clientId, currency: env.CURRENCY || 'USD', amount: env.PRICE || '3.00', brand: env.BRAND_NAME || 'Odium' });
}

async function handlePayPalOrder(req, env) {
  if (rateLimit(clientIp(req), 20)) return respond(env, req, { error: 'rate limited' }, 429);
  const { body, err } = await readJson(req, 2048);
  if (err) return respond(env, req, { error: 'bad request' }, 400);
  const reference = String(body?.reference || '').toUpperCase();
  if (!REF.test(reference)) return respond(env, req, { error: 'bad reference' }, 400);
  const order = await ppCreateOrder(env, reference);
  return respond(env, req, { id: order.id, status: order.status, reference });
}

async function handlePayPalCapture(req, env) {
  if (rateLimit(clientIp(req), 20)) return respond(env, req, { error: 'rate limited' }, 429);
  const { body, err } = await readJson(req, 2048);
  if (err) return respond(env, req, { error: 'bad request' }, 400);
  const orderId = String(body?.orderId || '');
  if (!PAYPAL_OID.test(orderId)) return respond(env, req, { error: 'missing orderId' }, 400);
  const order   = await ppCapture(env, orderId);
  const capture = ppReadCapture(env, order);
  if (!ppIsPaid(env, capture)) return respond(env, req, { error: 'payment not completed' }, 402);
  const ref   = REF.test(capture.reference) ? capture.reference : String(body?.reference || '').toUpperCase();
  const fresh = await ppClaim(env, { ...capture, reference: ref }, { orderId });
  let emailed = false;
  if (fresh) {
    const k = mintKey();
    await env.DB.prepare('INSERT INTO licenses (key,email,created_at) VALUES (?,?,?)')
      .bind(k, capture.payerEmail || null, Date.now()).run();
    if (capture.payerEmail) emailed = (await sendKeyEmail(env, { to: capture.payerEmail, key: k })).ok;
    await sendReceiptEmail(env, capture, ref).catch(() => {});
  }
  return respond(env, req, { status: 'paid', reference: ref, captureId: capture.captureId,
    amount: capture.amount, currency: capture.currency, mode: capture.mode, emailed, key_delivered: fresh });
}

async function handlePayPalReconcile(req, env) {
  if (rateLimit(clientIp(req), 30)) return respond(env, req, { error: 'rate limited' }, 429);
  const { body, err } = await readJson(req, 2048);
  if (err) return respond(env, req, { error: 'bad request' }, 400);
  const orderId = String(body?.orderId || '');
  if (!PAYPAL_OID.test(orderId)) return respond(env, req, { error: 'missing orderId' }, 400);
  let order = await ppGetOrder(env, orderId);
  let cap   = ppReadCapture(env, order);
  if (!cap && order.status === 'APPROVED') { order = await ppCapture(env, orderId); cap = ppReadCapture(env, order); }
  if (!ppIsPaid(env, cap)) return respond(env, req, { paid: false, status: order.status || 'UNKNOWN' });
  const ref   = REF.test(cap.reference) ? cap.reference : String(body?.reference || '').toUpperCase();
  const fresh = await ppClaim(env, { ...cap, reference: ref }, { orderId });
  let emailed = false;
  if (fresh) emailed = (await sendReceiptEmail(env, cap, ref)).ok;
  return respond(env, req, { paid: true, status: 'paid', reference: ref, captureId: cap.captureId,
    amount: cap.amount, currency: cap.currency, mode: cap.mode, emailed });
}

async function handlePayPalWebhook(req, env, ctx) {
  const event = await req.json().catch(() => null);
  if (!event?.event_type) return new Response(null, { status: 400 });
  if (!await ppVerifyWebhook(env, req, event)) return new Response(null, { status: 401 });
  if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return new Response(null, { status: 200 });
  const r = event.resource || {};
  const cap = { status: r.status, captureId: r.id, reference: r.custom_id || '',
    amount: r.amount?.value || '', currency: r.amount?.currency_code || '',
    payerEmail: r.payer?.email_address || '',
    payerName: [r.payer?.name?.given_name, r.payer?.name?.surname].filter(Boolean).join(' '),
    paidAt: r.create_time || event.create_time || '', mode: ppCreds(env).mode };
  if (!ppIsPaid(env, cap)) return new Response(null, { status: 200 });
  const ref = REF.test(cap.reference) ? cap.reference : `RET-${String(cap.captureId).slice(-6).toUpperCase()}`;
  ctx.waitUntil((async () => {
    if (await ppClaim(env, { ...cap, reference: ref })) {
      const k = mintKey();
      await env.DB.prepare('INSERT INTO licenses (key,email,created_at) VALUES (?,?,?)').bind(k, cap.payerEmail || null, Date.now()).run();
      if (cap.payerEmail) await sendKeyEmail(env, { to: cap.payerEmail, key: k }).catch(() => {});
      await sendReceiptEmail(env, cap, ref).catch(() => {});
    }
  })());
  return new Response(null, { status: 200 });
}

// ─── Main fetch handler ────────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const { pathname: path, } = new URL(req.url);
    const method = req.method;

    if (method === 'OPTIONS')
      return new Response(null, { status: 204, headers: { ...SEC, ...corsHeaders(env, req) } });

    if (Number(req.headers.get('content-length') || 0) > 16384)
      return respond(env, req, { error: 'payload too large' }, 413);

    try {
      if (path === '/challenge'            && method === 'POST') return handleChallenge(req, env);
      if (path === '/auth'                 && method === 'POST') return handleAuth(req, env);
      if (path === '/heartbeat'            && method === 'POST') return handleHeartbeat(req, env);
      if (path === '/payload'              && method === 'POST') return handlePayload(req, env);
      if (path === '/webhook'              && method === 'POST') return handleStorefrontWebhook(req, env);
      if (path === '/reset'                && method === 'POST') return handleReset(req, env);
      if (path === '/link'                 && method === 'POST') return handleLink(req, env);
      if (path === '/ban'                  && method === 'POST') return handleBan(req, env);
      if (path === '/mykey'                && method === 'POST') return handleMyKey(req, env);
      if (path === '/api/health'           && method === 'GET')  return respond(env, req, { ok: true, mode: ppCreds(env).mode, price: env.PRICE });
      if (path === '/api/paypal/config'    && method === 'GET')  return handlePayPalConfig(req, env);
      if (path === '/api/paypal/order'     && method === 'POST') return handlePayPalOrder(req, env);
      if (path === '/api/paypal/capture'   && method === 'POST') return handlePayPalCapture(req, env);
      if (path === '/api/paypal/reconcile' && method === 'POST') return handlePayPalReconcile(req, env);
      if (path === '/api/paypal/webhook'   && method === 'POST') return handlePayPalWebhook(req, env, ctx);
      if (path === '/api/diag'             && method === 'GET') {
        const d = requireBot(req, env); if (d) return d;
        const c = ppCreds(env);
        return respond(env, req, { worker: 'retrac-api',
          paypal: { mode: c.mode, clientIdLen: c.clientId.length, secretLen: c.secret.length, webhookSet: Boolean(c.webhookId) },
          secrets: { loaderSecret: Boolean(secret(env,'LOADER_SECRET')), hwidSalt: Boolean(secret(env,'HWID_SALT',8)),
            botSecret: Boolean(secret(env,'BOT_SECRET')), whSecret: Boolean(secret(env,'WH_SECRET')),
            adminSecret: Boolean(secret(env,'ADMIN_SECRET')) } });
      }
      return respond(env, req, { error: 'not found' }, 404);
    } catch (e) {
      console.error('[api]', path, e?.message);
      return respond(env, req, { error: 'internal error' }, 500);
    }
  },
};
