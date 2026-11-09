/*
 * Builds dist/ from the source tree.
 *
 * No asset list to maintain: anything with a web extension is copied, anything
 * that belongs to the backend or the repo plumbing is skipped. Add a page,
 * a stylesheet, an icon or a whole folder of images and it ships on the next run.
 *
 *   node scripts/build-pages.mjs
 */

import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");

// Never published: backend code, the repo itself, tooling, separate micro-sites.
const SKIP_DIRS = new Set([
  "dist",
  "node_modules",
  "server",
  "worker",
  "scripts",
  "goodnight.llc",
  ".git",
  ".github",
  ".wrangler",
]);

// Extensions that are safe to serve.
const ALLOWED_EXT = new Set([
  ".html", ".htm", ".css", ".js", ".mjs",
  ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".otf",
  ".json", ".txt", ".xml", ".webmanifest", ".pdf", ".mp4", ".webm",
]);

// Extensionless files a static host understands.
const ALLOWED_NAME = new Set(["_headers", "_redirects", "CNAME", "robots.txt", "favicon.ico"]);

function wanted(name) {
  if (ALLOWED_NAME.has(name)) return true;
  if (name.endsWith(".legacy.js")) return false;
  if (name.startsWith(".")) return false;
  return ALLOWED_EXT.has(extname(name).toLowerCase());
}

const copied = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(resolve(dir, entry.name));
      continue;
    }
    if (!entry.isFile() || !wanted(entry.name)) continue;

    const from = resolve(dir, entry.name);
    const to = resolve(output, relative(root, from));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    copied.push(relative(root, from).split("\\").join("/"));
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await walk(root);

copied.sort();
console.log(`Built ${copied.length} files in dist/`);
for (const file of copied) console.log(`  ${file}`);
