import { env } from "./env.js";

const HOSTS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export class PayPalError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "PayPalError";
    this.detail = detail || "";
  }
}

const base = () => HOSTS[env.mode];

let cached = { token: "", expiresAt: 0 };

async function getToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const auth = Buffer.from(`${env.paypal.clientId}:${env.paypal.secret}`).toString("base64");
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const text = await res.text();
  if (!res.ok) throw new PayPalError(`auth ${res.status}`, text);

  const json = JSON.parse(text);
  // Refresh a minute early so a long call never starts with a stale token.
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(0, Number(json.expires_in) - 60) * 1000,
  };
  return cached.token;
}

async function call(path, { method = "GET", body, requestId } = {}) {
  const token = await getToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (requestId) headers["PayPal-Request-Id"] = requestId;

  const res = await fetch(`${base()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Creates a CAPTURE order for one unit at the configured price.
 * `reference` is our RET-XXXXXX ticket and round-trips through custom_id.
 */
export async function createOrder({ reference, description }) {
  const { ok, status, json, text } = await call("/v2/checkout/orders", {
    method: "POST",
    requestId: `order-${reference}-${Date.now()}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: reference,
          custom_id: reference,
          description: String(description || "Retrac External").slice(0, 127),
          amount: { currency_code: env.currency, value: env.price },
        },
      ],
      application_context: {
        brand_name: env.brand,
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
      },
    },
  });

  if (!ok) throw new PayPalError(`create ${status}`, text);
  return json;
}

export async function captureOrder(orderId) {
  const { ok, status, json, text } = await call(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    { method: "POST", requestId: `capture-${orderId}` },
  );

  if (!ok) throw new PayPalError(`capture ${status}`, text);
  return json;
}

export async function getOrder(orderId) {
  const { ok, status, json, text } = await call(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
  );
  if (!ok) throw new PayPalError(`get ${status}`, text);
  return json;
}

/**
 * Pulls the money-bearing bits out of a captured order.
 * Returns null when the order did not actually complete.
 */
export function readCapture(order) {
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
    payerName: [order?.payer?.name?.given_name, order?.payer?.name?.surname]
      .filter(Boolean)
      .join(" "),
    createTime: capture.create_time || "",
    mode: env.mode,
  };
}

/** True only when the capture is COMPLETED at the right price and currency. */
export function isPaid(capture) {
  if (!capture || capture.status !== "COMPLETED") return false;
  if (capture.currency !== env.currency) return false;
  // Compare as numbers: PayPal returns "3.00", config may say "3.0".
  return Number(capture.amount) === Number(env.price);
}

export async function verifyWebhook(headers, event) {
  if (!env.paypal.webhookId) {
    return { verified: false, reason: "PAYPAL_WEBHOOK_ID not configured" };
  }

  const { ok, status, json, text } = await call(
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      body: {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: env.paypal.webhookId,
        webhook_event: event,
      },
    },
  );

  if (!ok) throw new PayPalError(`webhook verify ${status}`, text);
  return { verified: json.verification_status === "SUCCESS", reason: json.verification_status };
}
