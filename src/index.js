// src/index.js
// Discord bot entrypoint. Provides:
//   /sendable route:<name> [date:<when>]  -> runs the beta engine, posts an embed
//   👍 / 👎 buttons -> feedback into the self-healing loop
//   "Report actual conditions" button -> opens a modal for a structured correction
//   periodic tuner run

import 'dotenv/config';
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, Events,
} from 'discord.js';
import { randomUUID } from 'crypto';
import {
  migrate, saveQuery, recordVote, getQuery, getVoteTally, saveCorrection,
} from './db.js';
import { runBeta } from './beta-engine.js';
import { runTuner } from './tuner.js';

migrate();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const VERDICT_META = {
  SENDABLE:  { color: 0x4ade80, emoji: '✅', label: 'SENDABLE' },
  MARGINAL:  { color: 0xfbbf24, emoji: '⚠️', label: 'MARGINAL' },
  NOT_YET:   { color: 0xef4444, emoji: '❌', label: 'NOT YET' },
};

function buildEmbed(routeName, targetDate, beta, queryId, tally) {
  const meta = VERDICT_META[beta.verdict] || VERDICT_META.MARGINAL;
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${routeName} — ${meta.label}`)
    .setDescription(beta.summary || '')
    .addFields(
      { name: '❄️ Snowpack', value: beta.snotel || '—' },
      { name: '📋 Trip reports', value: beta.trip_reports || '—' },
      { name: '🥾 AllTrails', value: beta.alltrails || '—' },
      { name: `🌤️ Weather${targetDate ? ` (${targetDate})` : ''}`, value: beta.weather || '—' },
      { name: '📅 Day pick', value: beta.day_recommendation || '—' },
    )
    .setFooter({
      text: `Confidence ${(Math.round((beta.confidence ?? 0.5) * 100))}% · 👍 ${tally.up} 👎 ${tally.down} · react to train me`,
    })
    .setTimestamp();

  if (beta.sources?.length) {
    embed.addFields({
      name: '🔗 Sources',
      value: beta.sources.slice(0, 5).map((u, i) => `[${i + 1}](${u})`).join(' · '),
    });
  }
  return embed;
}

function buildButtons(queryId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`up:${queryId}`).setEmoji('👍').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`down:${queryId}`).setEmoji('👎').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`correct:${queryId}`).setLabel('Report actual conditions').setStyle(ButtonStyle.Secondary),
  );
}

client.once(Events.ClientReady, c => {
  console.log(`Sendable bot online as ${c.user.tag}`);
  // Run the self-healing tuner every 6 hours.
  setInterval(() => {
    try { console.log('Tuner:', runTuner()); }
    catch (e) { console.error('Tuner error', e); }
  }, 6 * 3600 * 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---- Slash command ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'sendable') {
      const routeName = interaction.options.getString('route', true);
      const targetDate = interaction.options.getString('date') || null;
      await interaction.deferReply(); // beta takes a few seconds

      const beta = await runBeta({ routeName, targetDate });
      const queryId = randomUUID();

      saveQuery({
        id: queryId,
        route_name: routeName,
        target_date: targetDate,
        discord_user_id: interaction.user.id,
        discord_channel_id: interaction.channelId,
        verdict: beta.verdict,
        confidence: beta.confidence ?? null,
        summary: beta.summary ?? '',
        raw_sources: JSON.stringify({
          snotel: beta.snotel, '14ers': beta.trip_reports,
          alltrails: beta.alltrails, weather: beta.weather,
        }),
        created_at: Date.now(),
      });

      const tally = { up: 0, down: 0 };
      await interaction.editReply({
        embeds: [buildEmbed(routeName, targetDate, beta, queryId, tally)],
        components: [buildButtons(queryId)],
      });
      return;
    }

    // ---- Thumbs buttons ----
    if (interaction.isButton()) {
      const [action, queryId] = interaction.customId.split(':');

      if (action === 'up' || action === 'down') {
        recordVote(queryId, interaction.user.id, action === 'up' ? 1 : -1);
        const tally = getVoteTally(queryId);
        const q = getQuery(queryId);
        // Re-render footer with updated tally
        const embed = EmbedBuilder.from(interaction.message.embeds[0])
          .setFooter({
            text: `Confidence ${Math.round((q.confidence ?? 0.5) * 100)}% · 👍 ${tally.up} 👎 ${tally.down} · react to train me`,
          });
        await interaction.update({ embeds: [embed] });

        // Immediate light tuner pass so learning feels responsive
        try { runTuner(); } catch (e) { console.error(e); }
        return;
      }

      if (action === 'correct') {
        const modal = new ModalBuilder()
          .setCustomId(`correctmodal:${queryId}`)
          .setTitle('Report actual conditions');

        const verdictInput = new TextInputBuilder()
          .setCustomId('actual_verdict')
          .setLabel('What was it really? (sendable/marginal/not yet)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const dateInput = new TextInputBuilder()
          .setCustomId('actual_date')
          .setLabel('When did you go? (e.g. 2026-06-21)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const noteInput = new TextInputBuilder()
          .setCustomId('note')
          .setLabel('What did you find out there?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(verdictInput),
          new ActionRowBuilder().addComponents(dateInput),
          new ActionRowBuilder().addComponents(noteInput),
        );
        await interaction.showModal(modal);
        return;
      }
    }

    // ---- Correction modal submit ----
    if (interaction.isModalSubmit() && interaction.customId.startsWith('correctmodal:')) {
      const queryId = interaction.customId.split(':')[1];
      const q = getQuery(queryId);
      const rawVerdict = interaction.fields.getTextInputValue('actual_verdict').trim().toUpperCase();
      const normalized = rawVerdict.includes('SEND') ? 'SENDABLE'
        : rawVerdict.includes('NOT') ? 'NOT_YET'
        : 'MARGINAL';

      saveCorrection({
        query_id: queryId,
        route_name: q?.route_name || 'unknown',
        discord_user_id: interaction.user.id,
        corrected_verdict: normalized,
        note: interaction.fields.getTextInputValue('note') || '',
        ground_truth_date: interaction.fields.getTextInputValue('actual_date') || null,
        created_at: Date.now(),
      });

      // Run tuner immediately so the correction takes effect for the next query.
      try { runTuner(); } catch (e) { console.error(e); }

      await interaction.reply({
        content: `🙏 Thanks — logged your report (${normalized}) for **${q?.route_name}**. I've updated my model. Future calls on this route will reflect what you found.`,
        ephemeral: true,
      });
      return;
    }
  } catch (err) {
    console.error('Interaction error', err);
    const msg = 'Something broke while checking conditions. Try again in a moment.';
    if (interaction.deferred || interaction.replied) {
      interaction.editReply({ content: msg }).catch(() => {});
    } else {
      interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
