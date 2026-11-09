import "dotenv/config";

const pick = (...values) =>
  values.find((v) => typeof v === "string" && v.trim() !== "") || "";

const mode = pick(process.env.PAYPAL_MODE, "sandbox").toLowerCase();
if (mode !== "sandbox" && mode !== "live") {
  throw new Error(`PAYPAL_MODE must be "sandbox" or "live", got "${mode}"`);
}

const credentials = {
  sandbox: {
    clientId: pick(process.env.PAYPAL_SANDBOX_CLIENT_ID),
    secret: pick(process.env.PAYPAL_SANDBOX_SECRET),
    webhookId: pick(process.env.PAYPAL_SANDBOX_WEBHOOK_ID),
  },
  live: {
    clientId: pick(process.env.PAYPAL_LIVE_CLIENT_ID),
    secret: pick(process.env.PAYPAL_LIVE_SECRET),
    webhookId: pick(process.env.PAYPAL_LIVE_WEBHOOK_ID),
  },
};

export const env = {
  mode,
  port: Number(pick(process.env.PORT, "3000")),
  // Price is authoritative here. The browser never gets to send an amount.
  price: pick(process.env.PRICE, "3.00"),
  currency: pick(process.env.CURRENCY, "USD"),
  brand: pick(process.env.BRAND_NAME, "Odium"),
  siteUrl: pick(process.env.SITE_URL, "http://localhost:3000"),
  corsOrigin: pick(process.env.CORS_ORIGIN),
  root: pick(process.env.STATIC_ROOT, ".."),
  paypal: { mode, ...credentials[mode] },
  mail: {
    host: pick(process.env.SMTP_HOST, "smtp.gmail.com"),
    port: Number(pick(process.env.SMTP_PORT, "465")),
    secure: pick(process.env.SMTP_SECURE, "true") === "true",
    user: pick(process.env.SMTP_USER),
    pass: pick(process.env.SMTP_PASS),
    from: pick(process.env.MAIL_FROM, "natevisionn@gmail.com"),
    to: pick(process.env.MAIL_TO, "natevisionn@gmail.com"),
  },
};

/** Missing configuration that would make a payment fail. Reported at boot. */
export function problems() {
  const upper = env.mode.toUpperCase();
  const missing = [];
  if (!env.paypal.clientId) missing.push(`PAYPAL_${upper}_CLIENT_ID`);
  if (!env.paypal.secret) missing.push(`PAYPAL_${upper}_SECRET`);
  if (!env.mail.user) missing.push("SMTP_USER");
  if (!env.mail.pass) missing.push("SMTP_PASS");
  if (!env.mail.to) missing.push("MAIL_TO");
  return missing;
}
