// src/register-commands.js
// Run once (and whenever commands change): `npm run register`
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('sendable')
    .setDescription('Check if a Colorado route/peak/pass is sendable')
    .addStringOption(opt =>
      opt.setName('route')
        .setDescription('e.g. "Quandary Peak", "Monarch Crest", "Yale 360"')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('date')
        .setDescription('When are you going? e.g. "this Saturday", "2026-06-28"')
        .setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('defineroute')
    .setDescription('Teach the bot a specific route (loop/traverse/linkup) so it matches it precisely')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('e.g. "Yale 360"')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('strava')
        .setDescription('Strava activity or route URL')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('alltrails')
        .setDescription('AllTrails route URL')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('description')
        .setDescription('Describe what makes this route distinct from the standard one')
        .setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('routes')
    .setDescription('List the custom routes the bot has learned')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const route = process.env.GUILD_ID
  ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID) // instant, per-guild
  : Routes.applicationCommands(process.env.CLIENT_ID);                            // global, ~1hr propagation

await rest.put(route, { body: commands });
console.log(`Registered /sendable ${process.env.GUILD_ID ? 'to guild ' + process.env.GUILD_ID : 'globally'}`);
