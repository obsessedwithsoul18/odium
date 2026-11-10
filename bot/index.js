/**
 * Odium Discord bot.
 *
 * Slash commands:
 *   /link <key>   — bind a license key to your Discord account
 *   /reset        — clear your HWID set (72h cooldown, 8/month)
 *   /mylkey       — show your key (ephemeral DM-style)
 *   /status       — show your license status
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in your values
 *   2. npm install
 *   3. node register-commands.js   (once, to register slash commands)
 *   4. node index.js               (keep running)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load .env file automatically
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envPath = resolve(__dirname, '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch { /* .env not found, use system env */ }

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const TOKEN    = (process.env.DISCORD_TOKEN || '').trim();
const CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '').trim();
const API_BASE  = (process.env.API_BASE || '').replace(/\/+$/, '');
const API_SECRET = (process.env.API_SECRET || '').trim(); // internal shared secret for bot->worker calls

if (!TOKEN || !API_BASE) {
  console.error('Missing DISCORD_TOKEN or API_BASE');
  process.exit(1);
}

// The Worker now authenticates every internal call. Refuse to start without a
// usable secret instead of sending empty credentials that silently fail (or,
// worse, succeed against an unhardened deployment).
if (API_SECRET.length < 16) {
  console.error('Missing or weak API_SECRET (needs >= 16 chars). Generate one with:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('Then set it here AND as the BOT_SECRET secret on the Worker.');
  process.exit(1);
}
if (!/^https:\/\//i.test(API_BASE) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API_BASE)) {
  console.error('API_BASE must be https:// (http is only allowed for localhost)');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 8000;

// -----------------------------------------------------------------------
// Worker API calls
// -----------------------------------------------------------------------
async function workerPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': API_SECRET,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  try { return await res.json(); }
  catch { return { ok: false, err: `HTTP ${res.status}` }; }
}

async function workerGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Bot-Secret': API_SECRET },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  try { return await res.json(); }
  catch { return { ok: false, err: `HTTP ${res.status}` }; }
}

// -----------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  // Never act on behalf of another bot, and never inside DMs where the reply
  // could be surfaced by a third-party client.
  if (user.bot || !interaction.inGuild()) {
    return interaction.reply({ content: 'Use this in the server.', ephemeral: true }).catch(() => {});
  }

  // All replies are ephemeral — only the user sees them
  await interaction.deferReply({ ephemeral: true });

  try {
    if (commandName === 'link') {
      const key = interaction.options.getString('key', true).trim().toUpperCase();

      const result = await workerPost('/link', {
        discord_id: user.id,
        key,
      });

      if (!result.ok) {
        const messages = {
          invalid_key:     '❌ That key doesn\'t exist. Double-check you copied it correctly.',
          already_linked:  '❌ That key is already linked to a different Discord account.',
          banned:          '🚫 This key has been banned.',
          missing_fields:  '❌ Something went wrong. Try again.',
        };
        return interaction.editReply(messages[result.err] || `❌ Error: ${result.err}`);
      }

      return interaction.editReply(
        '✅ **Key linked.** You can now use `/reset` to clear your HWID when you change machines.'
      );
    }

    if (commandName === 'reset') {
      const result = await workerPost('/reset', { discord_id: user.id });

      if (!result.ok) {
        if (result.err === 'no_key_linked')
          return interaction.editReply('❌ No key is linked to your account. Use `/link <key>` first.');
        if (result.err === 'cooldown')
          return interaction.editReply(`⏳ Cooldown active — **${result.hours_left}h** remaining.`);
        if (result.err === 'monthly_cap')
          return interaction.editReply('❌ You\'ve hit the monthly reset cap (8 resets/month). Wait until next month.');
        if (result.err === 'banned')
          return interaction.editReply('🚫 Your key has been banned.');
        return interaction.editReply(`❌ Error: ${result.err}`);
      }

      return interaction.editReply(
        '✅ **HWID cleared.** Relaunch the loader on your new machine to rebind.'
      );
    }

    if (commandName === 'mylkey') {
      const result = await workerPost('/mykey', { discord_id: user.id });

      if (!result.ok) {
        if (result.err === 'no_key_linked')
          return interaction.editReply('❌ No key linked. Use `/link <key>` to link yours, or open a support ticket if you never received a key.');
        return interaction.editReply(`❌ Error: ${result.err}`);
      }

      return interaction.editReply(
        `🔑 Your key: \`${result.key}\`\n\n` +
        `Status: ${result.banned ? '🚫 Banned' : '✅ Active'}\n` +
        `HWID resets remaining this month: **${8 - (result.resets_month || 0)}/8**`
      );
    }

    if (commandName === 'status') {
      const result = await workerPost('/mykey', { discord_id: user.id });

      if (!result.ok) {
        if (result.err === 'no_key_linked')
          return interaction.editReply('❌ No key linked to your account.');
        return interaction.editReply(`❌ Error: ${result.err}`);
      }

      const lines = [
        `**Key:** \`${result.key}\``,
        `**Status:** ${result.banned ? '🚫 Banned' : '✅ Active'}`,
        `**HWID bound:** ${result.hwid_bound ? 'Yes' : 'No (first launch will bind)'}`,
        `**Active session:** ${result.active_session ? 'Yes' : 'No'}`,
        `**Resets this month:** ${result.resets_month || 0}/8`,
      ];

      return interaction.editReply(lines.join('\n'));
    }

  } catch (err) {
    console.error('[interaction]', commandName, err.message);
    return interaction.editReply('❌ Something went wrong. Try again in a moment.');
  }
});

client.login(TOKEN);
