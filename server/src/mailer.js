import nodemailer from "nodemailer";
import { env } from "./env.js";

let transport = null;

function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: { user: env.mail.user, pass: env.mail.pass },
    // Gmail rejects a From that does not match the authenticated account.
    ...(env.mail.host.endsWith("gmail.com") ? {} : {}),
  });
  return transport;
}

const money = (value, currency) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value));
  } catch {
    return `${value} ${currency}`;
  }
};

function body(capture, ref) {
  const amount = money(capture.amount, capture.currency);
  const sandbox = capture.mode === "sandbox";

  const lines = [
    `${sandbox ? "[SANDBOX] " : ""}Payment received`,
    "",
    `Order:      ${ref}`,
    `Amount:     ${amount}`,
    `PayPal:     ${capture.captureId}`,
    `Payer:      ${capture.payerName || "unknown"} <${capture.payerEmail || "no email"}>`,
    `Paid at:    ${capture.createTime || new Date().toISOString()}`,
    `Mode:       ${capture.mode}`,
    "",
    sandbox
      ? "This is a sandbox payment. No money moved. Nothing to deliver."
      : "Deliver the license key and the download link to the buyer's Discord or email.",
  ];

  return lines.join("\n");
}

function html(capture, ref) {
  const amount = money(capture.amount, capture.currency);
  const sandbox = capture.mode === "sandbox";

  return `<!doctype html><html><body style="margin:0;background:#0b0b0d;padding:32px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e8e8ea">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#141418;border:1px solid #26262e;border-radius:14px">
    <tr><td style="padding:24px 24px 8px">
      <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8b8b96">${env.brand}</div>
      <h1 style="margin:8px 0 0;font-size:20px;line-height:1.3">${sandbox ? "Sandbox payment" : "Payment received"} — ${amount}</h1>
    </td></tr>
    <tr><td style="padding:8px 24px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.7">
        <tr><td style="color:#8b8b96;width:110px">Order</td><td><strong>${ref}</strong></td></tr>
        <tr><td style="color:#8b8b96">PayPal ID</td><td style="word-break:break-all">${capture.captureId}</td></tr>
        <tr><td style="color:#8b8b96">Payer</td><td>${capture.payerName || "unknown"}<br><span style="color:#8b8b96">${capture.payerEmail || "no email"}</span></td></tr>
        <tr><td style="color:#8b8b96">Paid at</td><td>${capture.createTime || new Date().toISOString()}</td></tr>
        <tr><td style="color:#8b8b96">Mode</td><td>${capture.mode}</td></tr>
      </table>
      <p style="margin:20px 0 0;padding:12px 14px;background:${sandbox ? "#2a2410" : "#102a18"};border-radius:10px;font-size:13px;color:${sandbox ? "#e5cf7a" : "#8fe0ac"}">
        ${sandbox ? "Sandbox payment. No money moved, nothing to deliver." : "Deliver the license key and download link now."}
      </p>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Sends the payment notification. Throws on SMTP failure so the caller can
 * surface it instead of pretending the mail went out.
 */
export async function sendPaymentEmail(capture, ref) {
  const subject = `${capture.mode === "sandbox" ? "[SANDBOX] " : ""}Retrac paid — ${ref} — ${money(capture.amount, capture.currency)}`;

  const info = await getTransport().sendMail({
    from: `"${env.brand} checkout" <${env.mail.from}>`,
    to: env.mail.to,
    replyTo: capture.payerEmail || env.mail.from,
    subject,
    text: body(capture, ref),
    html: html(capture, ref),
  });

  return { messageId: info.messageId, accepted: info.accepted };
}

/** Boot-time probe: verifies SMTP credentials without sending anything. */
export async function verifyMail() {
  return getTransport().verify();
}
