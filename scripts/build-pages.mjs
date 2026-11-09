import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
const assets = [
  "index.html",
  "checkout.html",
  "login.html",
  "policy.html",
  "tos.html",
  "home.css",
  "checkout.css",
  "legal.css",
  "discord-status.css",
  "logo.png",
  "dashboard.png",
  "plug.png",
  "_headers",
  "js/config.js",
  "js/checkout.js",
  "js/home.js",
  "js/discord-status.js",
  "js/legal.js",
];

await rm(output, { recursive: true, force: true });

for (const asset of assets) {
  const destination = resolve(output, asset);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, asset), destination);
}

console.log(`Built ${assets.length} static assets in dist/`);
