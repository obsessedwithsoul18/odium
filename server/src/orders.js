import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const STORE = resolve(here, "../data/orders.json");

let loading = null;
let records = null;
let writing = Promise.resolve();

async function load() {
  if (records) return records;
  if (loading) return loading;

  loading = (async () => {
    try {
      const raw = await readFile(STORE, "utf8");
      const parsed = JSON.parse(raw);
      records = parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if (err.code !== "ENOENT") {
        // A corrupt store must not silently drop paid orders, but it also must
        // not block a live capture. Move it aside and start clean.
        const backup = `${STORE}.corrupt-${Date.now()}`;
        await rename(STORE, backup).catch(() => {});
        console.warn(`[orders] store unreadable, moved to ${backup}`);
      }
      records = {};
    }
    return records;
  })();

  return loading;
}

async function flush() {
  const snapshot = JSON.stringify(records, null, 2);
  writing = writing.then(async () => {
    await mkdir(dirname(STORE), { recursive: true });
    const tmp = `${STORE}.tmp`;
    await writeFile(tmp, snapshot, "utf8");
    await rename(tmp, STORE);
  });
  return writing;
}

/**
 * Returns true when this capture has not been stored before.
 * Callers use the boolean to decide whether to send the email, which keeps
 * the capture route and the webhook route from both mailing the same sale.
 */
export async function claim(record) {
  const db = await load();
  const key = record.captureId || record.orderId;
  if (!key) throw new Error("claim() needs a captureId or orderId");
  if (db[key]) return false;

  db[key] = { ...record, claimedAt: new Date().toISOString() };
  await flush();
  return true;
}

export async function alreadyClaimed(key) {
  const db = await load();
  return Boolean(db[key]);
}

export async function list() {
  const db = await load();
  return Object.values(db);
}
