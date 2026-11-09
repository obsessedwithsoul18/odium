import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { env, problems } from "./env.js";
import { createOrder, captureOrder, readCapture, isPaid, verifyWebhook, PayPalError } from "./paypal.js";
import { sendPaymentEmail, verifyMail } from "./mailer.js";
import { claim } from "./orders.js";

const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(here, "..", env.root);
const app = express();

const REF = /^RET-[A-Z0-9]{6}$/;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

if (env.corsOrigin) {
  app.use("/api", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", env.corsOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

// Crude in-memory throttle: order creation is the only route that costs money.
const buckets = new Map();
function throttle(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const entry = buckets.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + 60_000;
  }
  entry.count += 1;
  buckets.set(ip, entry);
  if (entry.count > 20) {
    return res.status(429).json({ error: "too many attempts, wait a minute" });
  }
  next();
}

const fail = (res, code, error, detail) =>
  res.status(code).json(env.mode === "sandbox" && detail ? { error, detail } : { error });

app.get("/api/paypal/config", (req, res) => {
  if (!env.paypal.clientId) {
    return fail(res, 503, "paypal not configured", `missing PAYPAL_${env.mode.toUpperCase()}_CLIENT_ID`);
  }
  res.json({
    mode: env.mode,
    clientId: env.paypal.clientId,
    currency: env.currency,
    amount: env.price,
    brand: env.brand,
  });
});

app.post("/api/paypal/order", throttle, async (req, res) => {
  const reference = String(req.body?.reference || "").toUpperCase();
  if (!REF.test(reference)) {
    return fail(res, 400, "bad order reference");
  }

  try {
    const order = await createOrder({
      reference,
      description: `${env.brand} — Retrac External`,
    });
    res.json({ id: order.id, status: order.status, reference });
  } catch (err) {
    console.error("[order]", err.message, err.detail || "");
    fail(res, 502, "paypal could not create the order", err.detail);
  }
});

app.post("/api/paypal/capture", throttle, async (req, res) => {
  const orderId = String(req.body?.orderId || "");
  const reference = String(req.body?.reference || "").toUpperCase();
  if (!orderId) return fail(res, 400, "missing orderId");

  try {
    const order = await captureOrder(orderId);
    const capture = readCapture(order);

    if (!isPaid(capture)) {
      return fail(res, 402, "payment not completed", capture?.status || order.status);
    }

    const ref = REF.test(capture.reference) ? capture.reference : reference;

    // Claim first: a retry or a racing webhook must not double-mail.
    const fresh = await claim({ ...capture, reference: ref, orderId });
    let emailed = false;
    let emailError = "";

    if (fresh) {
      try {
        await sendPaymentEmail(capture, ref);
        emailed = true;
      } catch (err) {
        emailError = err.message;
        console.error("[mail]", err.message);
      }
    }

    res.json({
      status: "paid",
      reference: ref,
      captureId: capture.captureId,
      amount: capture.amount,
      currency: capture.currency,
      mode: capture.mode,
      emailed,
      emailError,
    });
  } catch (err) {
    const detail = err instanceof PayPalError ? err.detail : err.message;
    console.error("[capture]", err.message, detail || "");
    fail(res, 502, "paypal could not capture the order", detail);
  }
});

app.post("/api/paypal/webhook", async (req, res) => {
  const event = req.body;
  if (!event?.event_type) return res.sendStatus(400);

  try {
    const check = await verifyWebhook(req.headers, event);
    if (!check.verified) {
      return fail(res, 401, "webhook signature rejected", check.reason);
    }
  } catch (err) {
    console.error("[webhook]", err.message);
    return fail(res, 502, "webhook verification failed");
  }

  // Ack immediately; PayPal retries on any non-2xx and we do not want that.
  res.sendStatus(200);

  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") return;

  const resource = event.resource || {};
  const capture = {
    status: resource.status,
    captureId: resource.id,
    reference: resource.custom_id || "",
    amount: resource.amount?.value || "",
    currency: resource.amount?.currency_code || "",
    payerEmail: resource.payer?.email_address || "",
    payerName: [resource.payer?.name?.given_name, resource.payer?.name?.surname]
      .filter(Boolean)
      .join(" "),
    createTime: resource.create_time || event.create_time || "",
    mode: env.mode,
  };

  if (!isPaid(capture)) {
    console.warn("[webhook] capture not payable", capture.captureId, capture.status);
    return;
  }

  const ref = REF.test(capture.reference) ? capture.reference : `RET-${String(capture.captureId).slice(-6).toUpperCase()}`;

  try {
    if (await claim({ ...capture, reference: ref })) {
      await sendPaymentEmail(capture, ref);
      console.log("[webhook] notified", ref);
    }
  } catch (err) {
    console.error("[webhook] notify failed", err.message);
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mode: env.mode, price: env.price, currency: env.currency });
});

app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

app.use(
  express.static(staticRoot, {
    extensions: ["html"],
    setHeaders(res, path) {
      if (/\.(css|js)$/.test(path)) res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

app.use((req, res) => res.status(404).sendFile(resolve(staticRoot, "index.html")));

app.use((err, req, res, next) => {
  console.error("[app]", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "server error" });
});

const missing = problems();
if (missing.length) {
  console.warn(`[boot] PAYPAL_MODE=${env.mode} — not ready, missing: ${missing.join(", ")}`);
} else {
  verifyMail()
    .then(() => console.log("[mail] smtp credentials verified"))
    .catch((err) => console.warn(`[mail] verify failed: ${err.message}`));
}

app.listen(env.port, () => {
  console.log(`[boot] ${env.brand} checkout on http://localhost:${env.port}`);
  console.log(`[boot] paypal mode: ${env.mode} — price ${env.currency} ${env.price}`);
  console.log(`[boot] serving static from ${staticRoot}`);
});
