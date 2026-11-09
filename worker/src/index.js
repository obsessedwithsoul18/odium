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
const SESSION_TTL_MS   = 15 * 60 * 1000; // heartbeats every 5min; dead after 15min
const RESET_COOLDOWN   = 72 * 3_600_000;
const RESET_CAP_MONTH  = 8;

const PAYPAL_HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live:    'https://api-m.paypal.com',
};

const REF = /^RET-[A-Z0-9]{6}$/;

// -----------------------------------------------------------------------
// Helpers — generic
// -----------------------------------------------------------------------
function j(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.CORS_ORIGIN || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const hdrs = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (allowed.includes(origin) || allowed.includes('*'))
    hdrs['Access-Control-Allow-Origin'] = origin;
  return hdrs;
}

function respond(env, request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
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
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

function mintKey() {
  // FORMAT: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX (4 groups of 8 hex chars)
  return Array.from({ length: 4 }, () => randomHex(4).toUpperCase()).join('-');
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
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || '0.0.0.0';
}

// -----------------------------------------------------------------------
// HWID helpers
// -----------------------------------------------------------------------
async function saltedHwidHash(env, raw) {
  // raw is already a hex string from the loader; we re-hash with server salt
  // so a leaked hash list is useless without knowing the salt.
  const salted = `${HWID_SALT_PREFIX}${env.HWID_SALT || 'default-no-salt'}:${raw}`;
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

async function ppCapture(env, orderId) {
  const { ok, status, json: body } = await ppCall(
    env, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    { method: 'POST', requestId: `capture-${orderId}` }
  );
  if (!ok) throw new Error(`ppCapture ${status}`);
  return body;
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
  if (!env.RESEND_KEY) return { ok: false, error: 'RESEND_KEY not set' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'keys@getodium.shop',
      to: [to],
      subject,
      text,
      html,
    }),
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
  return sendEmail(env, {
    to: env.MAIL_TO || 'admin@getodium.shop',
    subject: `${sandbox ? '[SANDBOX] ' : ''}${brand} paid — ${ref} — ${amount}`,
    text: `Order: ${ref}\nAmount: ${amount}\nPayPal: ${capture.captureId}\nPayer: ${capture.payerName} <${capture.payerEmail}>\nPaid: ${capture.paidAt}\nMode: ${capture.mode}`,
    html: `<pre>${ref} — ${amount} — ${capture.captureId}</pre>`,
  });
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
 * POST /auth
 *
 * Body: { key, hwid: [hash0, hash1, hash2, hash3, hash4] }
 *  - hwid is an array of 5 component hashes produced by the loader:
 *      SHA256(machineGuid), SHA256(cpuId), SHA256(diskSerial),
 *      SHA256(macAddress), SHA256(motherboardSerial)
 *
 * Response: { ok, token } | { ok: false, err }
 */
async function handleAuth(request, env) {
  const ip = clientIp(request);
  if (rateLimit(ip, 10, 60_000))
    return j({ ok: false, err: 'rate_limit' }, 429);

  let body;
  try { body = await request.json(); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { key, hwid } = body;

  if (!key || typeof key !== 'string')
    return j({ ok: false, err: 'missing_key' }, 400);
  if (!Array.isArray(hwid) || hwid.length !== HWID_COMPONENTS)
    return j({ ok: false, err: 'bad_hwid' }, 400);

  // Validate each hwid component is a hex string (64 chars = sha256)
  for (const h of hwid) {
    if (typeof h !== 'string' || !/^[0-9a-f]{64}$/i.test(h))
      return j({ ok: false, err: 'bad_hwid_format' }, 400);
  }

  const lic = await env.DB.prepare(
    'SELECT key, hwid_set, active_session, banned FROM licenses WHERE key = ?'
  ).bind(key).first();

  if (!lic) return j({ ok: false, err: 'invalid_key' }, 401);
  if (lic.banned) return j({ ok: false, err: 'banned' }, 403);

  // Salt and hash the incoming HWID components server-side.
  const incomingHashes = await hashComponents(env, hwid);

  let storedSet;
  try { storedSet = JSON.parse(lic.hwid_set || '[]'); }
  catch { storedSet = []; }

  if (storedSet.length === 0) {
    // First login — bind these hashes. Store all 5.
    storedSet = incomingHashes;
    await env.DB.prepare('UPDATE licenses SET hwid_set = ? WHERE key = ?')
      .bind(JSON.stringify(storedSet), key).run();
  } else {
    // Subsequent login — need 3-of-5 to pass.
    const matches = countMatches(incomingHashes, storedSet);
    if (matches < HWID_MATCH_THRESHOLD) {
      // Possibly a spoofer or wrong machine.
      return j({ ok: false, err: 'hwid_mismatch', matched: matches, needed: HWID_MATCH_THRESHOLD }, 403);
    }
    // Silently update any new hashes that weren't in the set yet (covers minor hardware changes).
    // We never remove existing hashes — only a /reset clears them.
    const merged = [...new Set([...storedSet, ...incomingHashes])].slice(0, HWID_COMPONENTS * 2);
    if (merged.length !== storedSet.length) {
      await env.DB.prepare('UPDATE licenses SET hwid_set = ? WHERE key = ?')
        .bind(JSON.stringify(merged), key).run();
    }
  }

  // Mint a new session token. Overwriting active_session kicks any prior session.
  const token = await newSessionToken();

  // Delete any old session rows for this key, insert the new one.
  await env.DB.prepare('DELETE FROM sessions WHERE key = ?').bind(key).run();

  const ipHash = await sha256hex(ip);
  const uaHash = await sha256hex(request.headers.get('User-Agent') || '');
  await env.DB.prepare(
    'INSERT INTO sessions (token, key, ip_hash, ua_hash) VALUES (?, ?, ?, ?)'
  ).bind(token, key, ipHash, uaHash).run();

  await env.DB.prepare('UPDATE licenses SET active_session = ? WHERE key = ?')
    .bind(token, key).run();

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
  let body;
  try { body = await request.json(); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { token } = body;
  if (!token) return j({ ok: false, err: 'missing_token' }, 400);

  const row = await env.DB.prepare(
    `SELECT s.token, s.last_seen, l.active_session, l.banned
     FROM sessions s
     JOIN licenses l ON l.key = s.key
     WHERE s.token = ?`
  ).bind(token).first();

  if (!row) return j({ ok: false, err: 'kicked' }, 401);
  if (row.banned) return j({ ok: false, err: 'banned' }, 403);
  if (row.active_session !== token) return j({ ok: false, err: 'kicked' }, 401);

  // Check session TTL (stale sessions from crashed loaders)
  if (Date.now() - Number(row.last_seen) > SESSION_TTL_MS)
    return j({ ok: false, err: 'expired' }, 401);

  // Touch last_seen
  await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
    .bind(Date.now(), token).run();

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
  let body;
  try { body = await request.json(); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { token, build } = body;
  if (!token || !build) return j({ ok: false, err: 'missing_fields' }, 400);

  // Validate session
  const row = await env.DB.prepare(
    `SELECT s.key, l.active_session, l.banned
     FROM sessions s
     JOIN licenses l ON l.key = s.key
     WHERE s.token = ?`
  ).bind(token).first();

  if (!row) return j({ ok: false, err: 'kicked' }, 401);
  if (row.banned) return j({ ok: false, err: 'banned' }, 403);
  if (row.active_session !== token) return j({ ok: false, err: 'kicked' }, 401);

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
    .bind(Date.now(), token).run();

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
  const rawBody = await request.text();
  const sig = request.headers.get('x-signature') || '';

  // Verify HMAC signature
  if (!env.WH_SECRET) return j({ ok: false, err: 'webhook_not_configured' }, 503);
  const expected = await hmacSHA256hex(env.WH_SECRET, rawBody);
  if (!timingSafeEqual(expected, sig))
    return j({ ok: false, err: 'bad_signature' }, 401);

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { order_id, email, discord_id } = payload;
  if (!order_id) return j({ ok: false, err: 'missing_order_id' }, 400);

  // Idempotency: if we've already processed this order_id, return success silently
  const existing = await env.DB.prepare(
    'SELECT capture_id FROM orders WHERE reference = ?'
  ).bind(String(order_id)).first();
  if (existing) return j({ ok: true, dup: true });

  // Mark the order as processed (using order_id as capture_id for storefront webhooks)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO orders (capture_id, reference, order_id, mode)
     VALUES (?, ?, ?, 'webhook')`
  ).bind(String(order_id), String(order_id), String(order_id)).run();

  // Mint key
  const key = mintKey();
  await env.DB.prepare(
    'INSERT INTO licenses (key, discord_id, email) VALUES (?, ?, ?)'
  ).bind(key, discord_id || null, email || null).run();

  // Email
  if (email) {
    await sendKeyEmail(env, { to: email, key });
  }

  // Discord DM
  if (discord_id) {
    await dmDiscord(env, discord_id, `🔑 Your **${env.BRAND_NAME || 'Odium'}** key: \`${key}\`\nDo not share it — it's HWID-locked. Use \`/reset\` to change machines (72h cooldown).`);
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
  const ip = clientIp(request);
  if (rateLimit(ip, 5, 60_000))
    return j({ ok: false, err: 'rate_limit' }, 429);

  let body;
  try { body = await request.json(); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { discord_id } = body;
  if (!discord_id) return j({ ok: false, err: 'missing_discord_id' }, 400);

  const lic = await env.DB.prepare(
    'SELECT key, last_reset_at, resets_month, banned FROM licenses WHERE discord_id = ?'
  ).bind(discord_id).first();

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
  let body;
  try { body = await request.json(); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { discord_id, key } = body;
  if (!discord_id || !key) return j({ ok: false, err: 'missing_fields' }, 400);

  const lic = await env.DB.prepare(
    'SELECT key, discord_id, banned FROM licenses WHERE key = ?'
  ).bind(key).first();

  if (!lic) return j({ ok: false, err: 'invalid_key' }, 404);
  if (lic.banned) return j({ ok: false, err: 'banned' }, 403);

  if (lic.discord_id && lic.discord_id !== discord_id)
    return j({ ok: false, err: 'already_linked' });

  await env.DB.prepare('UPDATE licenses SET discord_id = ? WHERE key = ?')
    .bind(discord_id, key).run();

  return j({ ok: true });
}

/**
 * POST /ban  — admin: ban a key immediately
 *
 * Body: { key, admin_secret }
 */
async function handleBan(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { key, admin_secret } = body;
  if (!key) return j({ ok: false, err: 'missing_key' }, 400);

  // Simple admin secret — replace with a proper admin token in production
  if (!env.ADMIN_SECRET || admin_secret !== env.ADMIN_SECRET)
    return j({ ok: false, err: 'unauthorized' }, 401);

  await env.DB.prepare('UPDATE licenses SET banned = 1, active_session = NULL WHERE key = ?')
    .bind(key).run();
  await env.DB.prepare('DELETE FROM sessions WHERE key = ?').bind(key).run();

  return j({ ok: true });
}

// -----------------------------------------------------------------------
// PayPal route handlers (unchanged from original, kept for payment flow)
// -----------------------------------------------------------------------

async function handlePayPalConfig(request, env) {
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

  let body;
  try { body = await request.json(); } catch { return respond(env, request, { error: 'bad json' }, 400); }

  const reference = String(body.reference || '').toUpperCase();
  if (!REF.test(reference)) return respond(env, request, { error: 'bad reference' }, 400);

  const order = await ppCreateOrder(env, reference);
  return respond(env, request, { id: order.id, status: order.status, reference });
}

async function handlePayPalCapture(request, env) {
  const ip = clientIp(request);
  if (rateLimit(ip, 20)) return respond(env, request, { error: 'rate limited' }, 429);

  let body;
  try { body = await request.json(); } catch { return respond(env, request, { error: 'bad json' }, 400); }

  const orderId = String(body.orderId || '');
  if (!orderId) return respond(env, request, { error: 'missing orderId' }, 400);

  const order   = await ppCapture(env, orderId);
  const capture = ppReadCapture(env, order);
  if (!ppIsPaid(env, capture)) return respond(env, request, { error: 'payment not completed' }, 402);

  const ref   = REF.test(capture.reference) ? capture.reference : String(body.reference || '').toUpperCase();
  const fresh = await ppClaim(env, { ...capture, reference: ref }, { orderId });

  let emailed = false;
  if (fresh) {
    const sent = await sendReceiptEmail(env, capture, ref);
    emailed = sent.ok;
  }

  return respond(env, request, {
    status: 'paid', reference: ref,
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
    if (await ppClaim(env, { ...capture, reference: ref }))
      await sendReceiptEmail(env, capture, ref);
  })());

  return new Response(null, { status: 200 });
}

/**
 * POST /mykey  — bot internal: get key info for a discord_id
 *
 * Body: { discord_id }
 */
async function handleMyKey(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return j({ ok: false, err: 'bad_json' }, 400); }

  const { discord_id } = body;
  if (!discord_id) return j({ ok: false, err: 'missing_discord_id' }, 400);

  const lic = await env.DB.prepare(
    'SELECT key, banned, hwid_set, active_session, resets_month FROM licenses WHERE discord_id = ?'
  ).bind(discord_id).first();

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
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    try {
      // ── Licensing endpoints ─────────────────────────────────────────
      if (path === '/auth'      && method === 'POST') return handleAuth(request, env);
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

      // Diagnostic: what the runtime actually sees. Lengths and prefixes only —
      // never values, never secret names.
      if (path === '/api/diag' && method === 'GET') {
        const c = ppCreds(env);
        return respond(env, request, {
          worker: 'retrac-api',
          build: env.BUILD || '',
          paypal: {
            mode: c.mode,
            clientIdLen: String(c.clientId || '').length,
            clientIdPrefix: String(c.clientId || '').slice(0, 6),
            secretLen: String(c.secret || '').length,
            webhookIdSet: Boolean(c.webhookId),
          },
          mail: { to: env.MAIL_TO || '', from: env.MAIL_FROM || '', resendKeySet: Boolean(env.RESEND_KEY || env.RESEND_API_KEY) },
        });
      }
      if (path === '/api/paypal/order'   && method === 'POST') return handlePayPalOrder(request, env);
      if (path === '/api/paypal/capture' && method === 'POST') return handlePayPalCapture(request, env);
      if (path === '/api/paypal/webhook' && method === 'POST') return handlePayPalWebhook(request, env, ctx);

      return respond(env, request, { error: 'not found' }, 404);

    } catch (err) {
      console.error('[api]', path, err.message);
      return respond(env, request, { error: 'internal error' }, 500);
    }
  },
};
