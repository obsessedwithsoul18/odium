#!/usr/bin/env node
/**
 * Odium build-time encryptor.
 *
 *   node tools/encrypt.mjs <input-file> <output-file>
 *
 * Outputs a container: iv(12) || tag(16) || ciphertext
 * Prints the base64 AES-GCM key — paste it into the builds table:
 *
 *   wrangler d1 execute licdb --remote --command \
 *     "INSERT INTO builds VALUES ('v1.0.0','<key_b64>',strftime('%s','now')*1000)"
 */

import { readFile, writeFile } from 'node:fs/promises';

const [,,src, out] = process.argv;
if (!src || !out) {
  console.error('usage: node tools/encrypt.mjs <input> <output>');
  process.exit(1);
}

const plain = await readFile(src);

const key = crypto.getRandomValues(new Uint8Array(32));
const iv  = crypto.getRandomValues(new Uint8Array(12));

const ck = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
const sealed = new Uint8Array(
  await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, plain)
);

// subtle.encrypt appends the 16-byte auth tag at the end
const tag = sealed.slice(sealed.length - 16);
const ct  = sealed.slice(0, sealed.length - 16);

// container: iv(12) || tag(16) || ciphertext
const blob = Buffer.concat([
  Buffer.from(iv),
  Buffer.from(tag),
  Buffer.from(ct)
]);

await writeFile(out, blob);

console.log('build key (base64):', Buffer.from(key).toString('base64'));
console.log('container:         ', out, blob.length, 'bytes');
console.log('');
console.log('Register the build:');
console.log(`  wrangler d1 execute licdb --remote --command \\`);
console.log(`    "INSERT INTO builds VALUES ('v1.0.0','${Buffer.from(key).toString('base64')}',strftime('%s','now')*1000)"`);
console.log('');
console.log('Upload the container:');
console.log(`  wrangler r2 object put payloads/v1.0.0.bin --file=${out}`);
