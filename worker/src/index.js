/*
 * Retrac API — Cloudflare Worker.
 *
 * Runs the same four routes as the Express service, on Cloudflare's edge:
 *   GET  /api/health
 *   GET  /api/paypal/config
 *   POST /api/paypal/order
 *   POST /api/paypal/capture
 *   POST /api/paypal/webhook
 *
 * Differences from server/, all forced by the runtime:
 *   - no filesystem -> order de-duplication lives in D1
 *   - no SMTP       -> receipts go through Resend's HTTP API
 *   - no express    -> a fetch handler with a tiny router
 *
 * The price never comes from the request body. It comes from PRICE in [vars].
 */

const HOSTS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

const REF = /^RET-[A-Z0-9]{6}$/;

/* ---------- helpers ---------- */

function creds(env) {
  const mode = String(env.PAYPAL_MODE || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
  const prefix = mode === "live" ? "PAYPAL_LIVE" : "PAYPAL_SANDBOX";
  return {
    mode,
    base: HOSTS[mode],
    clientId: env[`${prefix}_CLIENT_ID`] || "",
    secret: env[`${prefix}_SECRET`] || "",
    webhookId: env[`${prefix}_WEBHOOK_ID`] || "",
  };
}

function allowedOrigins(env) {
  return String(env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Exact match, "*", or a wildcard host like "https://*.pages.dev".
 * A browser origin that is not on the list gets no Access-Control-Allow-Origin,
 * which surfaces in the console as "Failed to fetch".
 */
function originAllowed(env, origin) {
  if (!origin) return false;
  for (const entry of allowedOrigins(env)) {
    if (entry === "*" || entry === origin) return true;

    const wildcard = entry.match(/^(https?):\/\/\*\.(.+)$/);
    if (wildcard) {
      const [scheme, host] = origin.split("://");
      if (scheme === wildcard[1] && host && host.endsWith(`.${wildcard[2]}`)) return true;
    }
  }
  return false;
}

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (!origin) return headers;
  if (originAllowed(env, origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(env, request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env, request),
    },
  });
}

const fail = (env, request, status, error, detail) =>
  json(env, request, detail && creds(env).mode === "sandbox" ? { error, detail } : { error }, status);

/* ---------- paypal ---------- */

// Per-isolate cache. Not shared between colos, which is fine: a cache miss just
// costs one extra token request.
let tokenCache = { key: "", value: "", expiresAt: 0 };

async function token(env) {
  const c = creds(env);
  const key = `${c.mode}:${c.clientId}`;
  if (tokenCache.key === key && tokenCache.value && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const auth = btoa(`${c.clientId}:${c.secret}`);
  const res = await fetch(`${c.base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const text = await res.text();
  if (!res.ok) throw new PayPalError(`auth ${res.status}`, text);

  const body = JSON.parse(text);
  tokenCache = {
    key,
    value: body.access_token,
    expiresAt: Date.now() + Math.max(0, Number(body.expires_in) - 60) * 1000,
  };
  return tokenCache.value;
}

class PayPalError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail || "";
  }
}

async function call(env, path, { method = "GET", body, requestId } = {}) {
  const c = creds(env);
  const bearer = await token(env);
  const headers = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
  if (requestId) headers["PayPal-Request-Id"] = requestId;

  const res = await fetch(`${c.base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, json: parsed, text };
}

async function createOrder(env, reference) {
  // Bucket the request id per 5 minutes: a double click resolves to the same
  // PayPal order, but a retry after the window opens a fresh one.
  const bucket = Math.floor(Date.now() / 300000);
  const { ok, status, json: body, text } = await call(env, "/v2/checkout/orders", {
    method: "POST",
    requestId: `order-${reference}-${bucket}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: reference,
          custom_id: reference,
          description: `${env.BRAND_NAME || "Retrac"} — Retrac External`.slice(0, 127),
          amount: { currency_code: env.CURRENCY || "USD", value: env.PRICE || "3.00" },
        },
      ],
      application_context: {
        brand_name: env.BRAND_NAME || "Retrac",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
      },
    },
  });
  if (!ok) throw new PayPalError(`create ${status}`, text);
  return body;
}

async function captureOrder(env, orderId) {
  const { ok, status, json: body, text } = await call(
    env,
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    { method: "POST", requestId: `capture-${orderId}` },
  );
  if (!ok) throw new PayPalError(`capture ${status}`, text);
  return body;
}

function readCapture(env, order) {
  const unit = order?.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture) return null;
  return {
    status: capture.status,
    captureId: capture.id,
    reference: capture.custom_id || unit.custom_id || unit.reference_id || "",
    amount: capture.amount?.value || "",
    currency: capture.amount?.currency_code || "",
    payerEmail: order?.payer?.email_address || "",
    payerName: [order?.payer?.name?.given_name, order?.payer?.name?.surname].filter(Boolean).join(" "),
    paidAt: capture.create_time || "",
    mode: creds(env).mode,
  };
}

function isPaid(env, capture) {
  if (!capture || capture.status !== "COMPLETED") return false;
  if (capture.currency !== (env.CURRENCY || "USD")) return false;
  return Number(capture.amount) === Number(env.PRICE || "3.00");
}

async function verifyWebhook(env, request, event) {
  const c = creds(env);
  if (!c.webhookId) return false;

  const { ok, json: body } = await call(env, "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: request.headers.get("paypal-auth-algo"),
      cert_url: request.headers.get("paypal-cert-url"),
      transmission_id: request.headers.get("paypal-transmission-id"),
      transmission_sig: request.headers.get("paypal-transmission-sig"),
      transmission_time: request.headers.get("paypal-transmission-time"),
      webhook_id: c.webhookId,
      webhook_event: event,
    },
  });
  if (!ok) throw new PayPalError("webhook verify failed", JSON.stringify(body));
  return body.verification_status === "SUCCESS";
}

/* ---------- orders (D1) ---------- */

/**
 * True only for the first caller that presents this capture id.
 * INSERT OR IGNORE + changes === 1 is the atomic test.
 */
async function claim(env, capture, extra = {}) {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders
       (capture_id, reference, order_id, amount, currency, payer_name, payer_email, mode, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      capture.captureId,
      capture.reference || "",
      extra.orderId || "",
      String(capture.amount || ""),
      capture.currency || "",
      capture.payerName || "",
      capture.payerEmail || "",
      capture.mode || "",
      capture.paidAt || "",
    )
    .run();

  return Number(res?.meta?.changes || 0) === 1;
}

/* ---------- email (Resend) ---------- */

const money = (value, currency) => {
  const n = Number(value);
  const formatted = Number.isFinite(n) ? n.toFixed(2) : String(value);
  return currency === "USD" ? `$${formatted}` : `${formatted} ${currency}`;
};

function receipt(env, capture, ref) {
  const amount = money(capture.amount, capture.currency);
  const sandbox = capture.mode === "sandbox";
  const brand = env.BRAND_NAME || "Retrac";

  const text = [
    `${sandbox ? "[SANDBOX] " : ""}Payment received`,
    "",
    `Order:    ${ref}`,
    `Amount:   ${amount}`,
    `PayPal:   ${capture.captureId}`,
    `Payer:    ${capture.payerName || "unknown"} <${capture.payerEmail || "no email"}>`,
    `Paid at:  ${capture.paidAt || new Date().toISOString()}`,
    `Mode:     ${capture.mode}`,
    "",
    sandbox
      ? "Sandbox payment. No money moved. Nothing to deliver."
      : "Deliver the license key and the download link now.",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#0b0b0d;padding:32px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e8e8ea">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#141418;border:1px solid #26262e;border-radius:14px">
    <tr><td style="padding:24px 24px 8px">
      <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8b8b96">${brand}</div>
      <h1 style="margin:8px 0 0;font-size:20px;line-height:1.3">${sandbox ? "Sandbox payment" : "Payment received"} — ${amount}</h1>
    </td></tr>
    <tr><td style="padding:8px 24px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.7">
        <tr><td style="color:#8b8b96;width:100px">Order</td><td><strong>${ref}</strong></td></tr>
        <tr><td style="color:#8b8b96">PayPal ID</td><td style="word-break:break-all">${capture.captureId}</td></tr>
        <tr><td style="color:#8b8b96">Payer</td><td>${capture.payerName || "unknown"}<br><span style="color:#8b8b96">${capture.payerEmail || "no email"}</span></td></tr>
        <tr><td style="color:#8b8b96">Paid at</td><td>${capture.paidAt || new Date().toISOString()}</td></tr>
        <tr><td style="color:#8b8b96">Mode</td><td>${capture.mode}</td></tr>
      </table>
      <p style="margin:20px 0 0;padding:12px 14px;background:${sandbox ? "#2a2410" : "#102a18"};border-radius:10px;font-size:13px;color:${sandbox ? "#e5cf7a" : "#8fe0ac"}">
        ${sandbox ? "Sandbox payment. No money moved, nothing to deliver." : "Deliver the license key and download link now."}
      </p>
    </td></tr>
  </table>
</body></html>`;

  return {
    subject: `${sandbox ? "[SANDBOX] " : ""}${brand} paid — ${ref} — ${amount}`,
    text,
    html,
  };
}

/**
 * MAIL_TO accepts a comma separated list, so a receipt can land in more than one
 * inbox. MAIL_BUYER="true" also copies the payer — that only works once a domain
 * is verified in Resend, because resend.dev cannot deliver to third parties.
 */
function mailRecipients(env, capture) {
  const list = String(env.MAIL_TO || "natevisionn@gmail.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const wantBuyer = String(env.MAIL_BUYER || "").toLowerCase() === "true";
  if (wantBuyer && capture.payerEmail) list.push(capture.payerEmail);

  return [...new Set(list)];
}

async function sendReceipt(env, capture, ref) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY missing" };

  const mail = receipt(env, capture, ref);
  const to = mailRecipients(env, capture);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || "onboarding@resend.dev",
      to,
      reply_to: capture.payerEmail || undefined,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }),
  });

  const body = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${body}`.slice(0, 300) };
  return { ok: true, id: (() => { try { return JSON.parse(body).id; } catch { return ""; } })() };
}

/* ---------- routes ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = creds(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json(env, request, {
          ok: true,
          mode: c.mode,
          price: env.PRICE || "3.00",
          currency: env.CURRENCY || "USD",
        });
      }

      if (url.pathname === "/api/paypal/config" && request.method === "GET") {
        if (!c.clientId) {
          return fail(env, request, 503, "paypal not configured", `missing client id for ${c.mode}`);
        }
        return json(env, request, {
          mode: c.mode,
          clientId: c.clientId,
          currency: env.CURRENCY || "USD",
          amount: env.PRICE || "3.00",
          brand: env.BRAND_NAME || "Retrac",
        });
      }

      if (url.pathname === "/api/paypal/order" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const reference = String(body.reference || "").toUpperCase();
        if (!REF.test(reference)) return fail(env, request, 400, "bad order reference");

        const order = await createOrder(env, reference);
        return json(env, request, { id: order.id, status: order.status, reference });
      }

      if (url.pathname === "/api/paypal/capture" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const orderId = String(body.orderId || "");
        if (!orderId) return fail(env, request, 400, "missing orderId");

        const order = await captureOrder(env, orderId);
        const capture = readCapture(env, order);
        if (!isPaid(env, capture)) {
          return fail(env, request, 402, "payment not completed", capture?.status || order.status);
        }

        const ref = REF.test(capture.reference) ? capture.reference : String(body.reference || "").toUpperCase();
        const fresh = await claim(env, { ...capture, reference: ref }, { orderId });

        let emailed = false;
        let emailError = "";
        if (fresh) {
          const sent = await sendReceipt(env, capture, ref);
          emailed = sent.ok;
          emailError = sent.ok ? "" : sent.error;
        }

        return json(env, request, {
          status: "paid",
          reference: ref,
          captureId: capture.captureId,
          amount: capture.amount,
          currency: capture.currency,
          mode: capture.mode,
          emailed,
          emailError,
        });
      }

      if (url.pathname === "/api/paypal/webhook" && request.method === "POST") {
        const event = await request.json().catch(() => null);
        if (!event?.event_type) return json(env, request, { error: "bad event" }, 400);

        if (!(await verifyWebhook(env, request, event))) {
          return fail(env, request, 401, "webhook signature rejected");
        }

        // Acknowledge first; PayPal retries anything that is not a 2xx.
        if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
          return json(env, request, { received: true });
        }

        const r = event.resource || {};
        const capture = {
          status: r.status,
          captureId: r.id,
          reference: r.custom_id || "",
          amount: r.amount?.value || "",
          currency: r.amount?.currency_code || "",
          payerEmail: r.payer?.email_address || "",
          payerName: [r.payer?.name?.given_name, r.payer?.name?.surname].filter(Boolean).join(" "),
          paidAt: r.create_time || event.create_time || "",
          mode: c.mode,
        };

        if (!isPaid(env, capture)) return json(env, request, { received: true, ignored: true });

        const ref = REF.test(capture.reference)
          ? capture.reference
          : `RET-${String(capture.captureId).slice(-6).toUpperCase()}`;

        ctx.waitUntil(
          (async () => {
            if (await claim(env, { ...capture, reference: ref })) {
              await sendReceipt(env, capture, ref);
            }
          })(),
        );

        return json(env, request, { received: true });
      }

      return json(env, request, { error: "not found" }, 404);
    } catch (err) {
      const detail = err instanceof PayPalError ? err.detail : err.message;
      console.error("[api]", url.pathname, err.message, String(detail || "").slice(0, 400));
      return fail(env, request, 502, "paypal request failed", detail);
    }
  },
};
