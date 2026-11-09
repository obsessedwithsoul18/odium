/**
 * Run once to register slash commands:
 *   DISCORD_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_GUILD_ID=... node register-commands.js
 *
 * Remove DISCORD_GUILD_ID to register globally (takes up to 1 hour to propagate).
 * Guild registration is instant and better for testing.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID; // optional

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID');
  process.exit(1);
}

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
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  const result = await rest.put(route, { body: commands });
  console.log(`Registered ${result.length} commands${GUILD_ID ? ` to guild ${GUILD_ID}` : ' globally'}.`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
