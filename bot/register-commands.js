/**
 * Run once to register slash commands.
 * Fill in .env first, then: node register-commands.js
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const lines = readFileSync(resolve(__dirname, '.env'), 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch { }

const TOKEN      = process.env.DISCORD_TOKEN;
const CLIENT_ID  = process.env.DISCORD_CLIENT_ID;
const GUILD_ID   = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const { REST, Routes, SlashCommandBuilder } = await import('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your license key to your Discord account.')
    .addStringOption(opt =>
      opt.setName('key')
        .setDescription('Your license key (e.g. ABCD1234-EFGH5678-IJKL9012-MNOP3456)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear your HWID binding (72h cooldown, 8/month).'),
  new SlashCommandBuilder()
    .setName('mylkey')
    .setDescription('Show your license key and status (only visible to you).'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show your license status — HWID binding, resets, session.'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

const route = GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);

const result = await rest.put(route, { body: commands });
console.log(`Registered ${result.length} commands${GUILD_ID ? ` to guild ${GUILD_ID}` : ' globally'}.`);
