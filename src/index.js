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
  saveRoute, listRoutes, normalizeRoute,
} from './db.js';
import { runBeta } from './beta-engine.js';
import { buildRouteDefinition } from './route-builder.js';
import { runTuner } from './tuner.js';

migrate();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const VERDICT_META = {
  SENDABLE:  { color: 0x4ade80, emoji: '✅', label: 'SENDABLE' },
  LIKELY:    { color: 0x84cc16, emoji: '🟢', label: 'LIKELY GOOD' },
  MARGINAL:  { color: 0xfbbf24, emoji: '⚠️', label: 'MARGINAL' },
  NOT_YET:   { color: 0xef4444, emoji: '❌', label: 'NOT YET' },
};

function buildEmbed(routeName, targetDate, beta, queryId, tally) {
  // ── Light safety net ──
  // We trust a SENDABLE backed by good data. Only step in when the model itself
  // says it had NO real route data (pure proxy / no data found) AND was very
  // unconfident — that's the one case a green check would be actively misleading.
  // We never up-rank, and a normal confident SENDABLE on recent reports stands.
  const veryLowConfidence = (beta.confidence ?? 1) < 0.35;
  const noRealData = /no on-route|no current data|incomplete response|could not find/i.test(
    `${beta.route_match || ''} ${beta.data_age || ''} ${beta.summary || ''}`
  );
  if (beta.verdict === 'SENDABLE' && noRealData && veryLowConfidence) {
    beta.verdict = 'MARGINAL';
    beta.summary = `⚠️ Couldn't find recent on-route data to confirm a confident send. ${beta.summary || ''}`;
  }

  const meta = VERDICT_META[beta.verdict] || VERDICT_META.MARGINAL;

  // TLDR is the headline. Fall back to first sentence of summary if model omitted it.
  const tldr = beta.tldr
    || (beta.summary ? beta.summary.split(/(?<=[.!?])\s/)[0] : '')
    || 'See details below.';

  // Route-match flags, compressed to one short line if present.
  let flag = '';
  if (beta._stored_route) flag = `📌 ${beta._stored_route}`;
  else if (beta.route_match && /proxy/i.test(beta.route_match)) flag = '⚠️ standard-route proxy data — inferred for actual route';
  else if (beta._is_variant) flag = '⚠️ non-standard route';

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${routeName} — ${meta.label}`)
    .setDescription(`**TL;DR — ${tldr}**${flag ? `\n*${flag}*` : ''}`.slice(0, 400))
    .addFields(
      // Compact two-column layout; details for those who want them.
      { name: '❄️ Snow / pack', value: (beta.snotel || '—').slice(0, 200), inline: true },
      { name: `🌤️ Weather${targetDate ? ` (${targetDate})` : ''}`, value: (beta.weather || '—').slice(0, 200), inline: true },
      ...(beta.historical_analog && beta.historical_analog.trim()
        ? [{ name: '📊 vs past years', value: beta.historical_analog.slice(0, 250) }]
        : []),
      { name: '📋 Recent reports', value: (beta.trip_reports || '—').slice(0, 250) },
      { name: '⚠️ Watch for', value: (beta.hazards || 'Assess avalanche, snow, exposure & weather yourself.').slice(0, 250) },
      { name: '📅 Day pick', value: (beta.day_recommendation || '—').slice(0, 200) },
    )
    .setFooter({
      text: `${Math.round((beta.confidence ?? 0.5) * 100)}% confidence · ${beta.data_age || 'recency unknown'} · not a safety call — check CAIC · 👍${tally.up} 👎${tally.down}`,
    })
    .setTimestamp();

  // Optional: full detail only when the user wants it — keep the main card lean.
  if (beta.summary && beta.summary.length > tldr.length + 20) {
    embed.addFields({ name: '📖 More', value: beta.summary.slice(0, 600) });
  }
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

    // ---- /defineroute : register a custom route from Strava/AllTrails/description ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'defineroute') {
      const name = interaction.options.getString('name', true);
      const stravaUrl = interaction.options.getString('strava') || null;
      const alltrailsUrl = interaction.options.getString('alltrails') || null;
      const description = interaction.options.getString('description') || null;
      await interaction.deferReply();

      const def = await buildRouteDefinition({ name, stravaUrl, alltrailsUrl, description });
      saveRoute({
        canonical_name: def.canonical_name || name,
        aliases: JSON.stringify(def.aliases || []),
        peak: def.peak || null,
        route_type: def.route_type || null,
        distance_km: def.distance_km ?? null,
        gain_m: def.gain_m ?? null,
        key_terrain: def.key_terrain || null,
        aspects: def.aspects || null,
        distinct_from_standard: def.distinct_from_standard || null,
        source: def.source || 'user',
        created_by: interaction.user.id,
        created_at: Date.now(),
      });

      const embed = new EmbedBuilder()
        .setColor(0x60a5fa)
        .setTitle(`📌 Route saved: ${def.canonical_name || name}`)
        .setDescription(def.distinct_from_standard || 'Stored. Future /sendable calls will match this route.')
        .addFields(
          { name: 'Type', value: def.route_type || '—', inline: true },
          { name: 'Distance', value: def.distance_km ? `${def.distance_km} km` : '—', inline: true },
          { name: 'Gain', value: def.gain_m ? `${def.gain_m} m` : '—', inline: true },
          { name: 'Key terrain', value: def.key_terrain || '—' },
          { name: 'Aliases', value: (def.aliases || []).join(', ') || '—' },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ---- /routes : list stored routes ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'routes') {
      const rows = listRoutes(500); // pull more, then summarize/cap for display
      if (rows.length === 0) {
        await interaction.reply({ content: 'No routes stored yet. Use `/defineroute` to add one, or seed from COTREX/Strava.', ephemeral: true });
        return;
      }

      // With COTREX loaded there can be hundreds of trails — far past Discord's
      // 2000-char message limit. Show enriched/user routes in full, then a count
      // of the bulk trail entries, and keep the whole thing under the cap.
      const enriched = rows.filter(r => r.source && r.source !== 'cotrex');
      const cotrex = rows.filter(r => r.source === 'cotrex');

      let body = '';
      if (enriched.length) {
        body += '**Defined / imported routes:**\n';
        body += enriched.map(r =>
          `• **${r.canonical_name}** — ${r.route_type || 'route'}${r.distance_km ? `, ${r.distance_km}km` : ''}${r.peak ? ` (${r.peak})` : ''}`
        ).join('\n');
      }
      if (cotrex.length) {
        // Just list a sample of trail names + the total count, to stay under 2000 chars.
        const sample = cotrex.slice(0, 15).map(r => r.canonical_name).join(', ');
        body += `\n\n**COTREX trails:** ${cotrex.length} loaded (e.g. ${sample}…)\nUse \`/sendable route:"<name>"\` to query any of them.`;
      }

      // Hard safety cap so we never hit the 2000-char error again.
      if (body.length > 1900) body = body.slice(0, 1900) + '\n…(truncated)';

      await interaction.reply({ content: body, ephemeral: true });
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
            text: `Confidence ${Math.round((q.confidence ?? 0.5) * 100)}% · 👍 ${tally.up} 👎 ${tally.down} · vote + report conditions to tune me`,
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
          .setLabel('What was it really?')
          .setPlaceholder('sendable / marginal / not yet')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const dateInput = new TextInputBuilder()
          .setCustomId('actual_date')
          .setLabel('When did you go?')
          .setPlaceholder('e.g. 2026-06-21')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const noteInput = new TextInputBuilder()
          .setCustomId('note')
          .setLabel('What did you find out there?')
          .setPlaceholder('Snow, creek crossings, hazards, where you turned around...')
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
        : rawVerdict.includes('LIKELY') ? 'LIKELY'
        : rawVerdict.includes('NOT') ? 'NOT_YET'
        : 'MARGINAL';

      saveCorrection({
        query_id: queryId,
        route_name: normalizeRoute(q?.route_name || 'unknown'),
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
