#!/usr/bin/env node
/*
 * Preflight for the PayPal rail.
 *
 * Exists because the two failure modes that waste the most time are silent:
 * a live client id pointed at the sandbox API (401 invalid_client) and a Gmail
 * password used where an App Password is required (535 auth error).
 *
 *   npm run check
 *
 * Exit code 1 means a payment will fail — the message names which half.
 */

import { env, problems } from "../src/env.js";
import { selfTest, apiBase } from "../src/paypal.js";
import { verifyMail } from "../src/mailer.js";

const pad = (label) => label.padEnd(22);
const mask = (value) =>
  !value ? "(empty)" : value.length <= 12 ? value[0] + "…" : `${value.slice(0, 8)}…${value.slice(-4)}`;

console.log("");
console.log("  PayPal preflight");
console.log("  " + "─".repeat(52));
console.log(`  ${pad("mode")}${env.mode.toUpperCase()}`);
console.log(`  ${pad("api")}${apiBase()}`);
console.log(`  ${pad("price")}${env.currency} ${env.price}`);
console.log(`  ${pad("client id")}${mask(env.paypal.clientId)}`);
console.log(`  ${pad("webhook id")}${mask(env.paypal.webhookId)}`);
console.log(`  ${pad("mail from")}${env.mail.from}`);
console.log(`  ${pad("mail to")}${env.mail.to}`);
console.log(`  ${pad("site url")}${env.siteUrl}`);
console.log("");

let failed = false;

const missing = problems();
if (missing.length) {
  console.log(`  ✗ missing: ${missing.join(", ")}`);
  failed = true;
} else {
  console.log("  ✓ every required variable is set");
}

if (env.paypal.clientId && env.paypal.secret) {
  try {
    const t = await selfTest();
    console.log(`  ✓ paypal auth ok (token valid ${t.expiresIn}s, app ${t.appId || "n/a"})`);
    console.log(`    -> these credentials belong to a ${env.mode.toUpperCase()} app`);
  } catch (err) {
    failed = true;
    console.log(`  ✗ paypal auth failed: ${err.message}`);
    console.log("    " + (err.detail || "").slice(0, 300).replace(/\s+/g, " "));
    if (String(err.detail).includes("invalid_client")) {
      console.log(`    -> wrong id/secret, or a LIVE id with PAYPAL_MODE=sandbox (or the reverse)`);
    }
  }
} else {
  console.log("  - paypal auth skipped (no credentials)");
  failed = true;
}

if (env.mail.user && env.mail.pass) {
  try {
    await verifyMail();
    console.log(`  ✓ smtp auth ok (${env.mail.host}:${env.mail.port})`);
  } catch (err) {
    failed = true;
    console.log(`  ✗ smtp failed: ${err.message}`);
    if (/535|Username and Password|Invalid login/i.test(err.message)) {
      console.log("    -> Gmail needs a 16 character App Password, not the account password");
    }
  }
} else {
  console.log("  - smtp skipped (no credentials)");
  failed = true;
}

if (!env.paypal.webhookId) {
  console.log(`  ~ no webhook id — capture still mails you, the webhook is only the backstop`);
}

console.log("");
console.log("  webhook url: " + `${env.siteUrl.replace(/\/+$/, "")}/api/paypal/webhook`);
console.log(`  local test : ${env.siteUrl.replace(/\/+$/, "")}/checkout.html?method=paypal`);
console.log("");
console.log(failed ? "  RESULT: not ready — fix the ✗ lines above" : "  RESULT: ready to take a payment");
console.log("");

process.exit(failed ? 1 : 0);
