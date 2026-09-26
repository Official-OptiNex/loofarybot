const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Giveaway = require('../../../database/models/Giveaway');

// Keys track live setTimeout handles so a redeploy doesn't create duplicate timers,
// and so /loof delete or /loof end can cancel a pending timer cleanly.
const activeTimers = new Map(); // messageId -> Timeout

function parseDuration(str) {
  if (!str) return null;
  const match = str.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (num <= 0) return null;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return num * mult;
}

function formatTime(ms) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

function resolveColor(input) {
  if (!input) return '#5865F2';
  const colorMap = {
    green: '#57F287',
    red: '#ED4245',
    blue: '#3498DB',
    yellow: '#FEE75C',
    purple: '#9B59B6',
    black: '#000000',
    white: '#FFFFFF',
    blurple: '#5865F2',
    gold: '#F1C40F'
  };
  const lower = input.trim().toLowerCase();
  if (colorMap[lower]) return colorMap[lower];
  if (/^#?[0-9A-F]{6}$/i.test(input.trim())) {
    return input.trim().startsWith('#') ? input.trim() : `#${input.trim()}`;
  }
  return '#5865F2';
}

function buildGiveawayEmbed(g) {
  return new EmbedBuilder()
    .setTitle(`🎁 Giveaway: ${g.prize}`)
    .setDescription(
      `${g.customDesc}\n\n**Ends:** ${formatTime(g.endTimestamp)}\n**Winners:** ${g.winnerCount}\n**Hosted By:** <@${g.hostId}>`
    )
    .setColor(g.colorHex)
    .setFooter({ text: `Entries: ${g.entries.length}` })
    .setTimestamp(g.endTimestamp);
}

function buildEntryRow(emoji, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(disabled ? 'g_ended' : 'g_enter')
      .setLabel(disabled ? 'Ended' : 'Enter')
      .setEmoji(disabled ? '🔒' : emoji)
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

async function launchGiveaway(client, { interaction, channel, durationMs, winnerCount, prize, pingRole, colorHex, emoji, customDesc }) {
  const endTimestamp = Date.now() + durationMs;

  const draft = {
    prize,
    winnerCount,
    endTimestamp,
    colorHex,
    emoji,
    customDesc,
    hostId: interaction.user.id,
    entries: []
  };

  const embed = buildGiveawayEmbed(draft);
  const row = buildEntryRow(emoji);
  const pingContent = pingRole ? `${pingRole}` : undefined;

  try {
    const msg = await channel.send({ content: pingContent, embeds: [embed], components: [row] });

    await Giveaway.create({
      messageId: msg.id,
      channelId: channel.id,
      guildId: interaction.guildId,
      ...draft
    });

    scheduleGiveawayEnd(client, msg.id, durationMs);

    return interaction.reply({
      content: `✅ Giveaway started in ${channel}! [Jump to Message](${msg.url})`,
      ephemeral: true
    });
  } catch (err) {
    console.error('Error posting giveaway message:', err);
    return interaction.reply({
      content: '❌ Failed to send giveaway message. Ensure the bot has permissions in the target channel.',
      ephemeral: true
    });
  }
}

function scheduleGiveawayEnd(client, messageId, delayMs) {
  clearScheduledEnd(messageId);
  // setTimeout with a very large delay overflows to fire immediately in Node — cap it,
  // and let the periodic checkGiveaways() sweep catch anything longer than that.
  const safeDelay = Math.min(Math.max(delayMs, 0), 2 ** 31 - 1);
  const timer = setTimeout(() => finishGiveawayById(client, messageId).catch(console.error), safeDelay);
  activeTimers.set(messageId, timer);
}

function clearScheduledEnd(messageId) {
  const existing = activeTimers.get(messageId);
  if (existing) {
    clearTimeout(existing);
    activeTimers.delete(messageId);
  }
}

async function finishGiveawayById(client, messageId) {
  const g = await Giveaway.findOne({ messageId });
  if (!g || g.ended) return;
  await finishGiveaway(client, g);
}

async function finishGiveaway(client, g) {
  g.ended = true;
  await g.save();
  clearScheduledEnd(g.messageId);

  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(g.messageId).catch(() => null);

  let winners = [];
  if (g.entries.length > 0) {
    const shuffled = [...g.entries].sort(() => 0.5 - Math.random());
    winners = shuffled.slice(0, Math.min(g.winnerCount, shuffled.length));
  }
  const winnerMentions = winners.length > 0 ? winners.map((id) => `<@${id}>`).join(', ') : 'No valid entries.';

  if (msg) {
    const endedEmbed = new EmbedBuilder()
      .setTitle(`🎁 Giveaway Ended: ${g.prize}`)
      .setDescription(`**Winners:** ${winnerMentions}\n**Hosted By:** <@${g.hostId}>`)
      .setColor('#2B2D31')
      .setTimestamp();

    await msg.edit({ embeds: [endedEmbed], components: [buildEntryRow(g.emoji, true)] }).catch(() => null);
  }

  if (winners.length > 0) {
    channel.send(`🎉 Congratulations ${winnerMentions}! You won **${g.prize}**!`).catch(() => null);
  } else {
    channel.send(`Giveaway for **${g.prize}** ended, but there were no valid entries.`).catch(() => null);
  }
}

async function handleButtonInteraction(interaction) {
  if (interaction.customId !== 'g_enter') return;

  const g = await Giveaway.findOne({ messageId: interaction.message.id });
  if (!g || g.ended) {
    return interaction.reply({ content: '❌ This giveaway has ended.', ephemeral: true });
  }

  const userId = interaction.user.id;
  const idx = g.entries.indexOf(userId);
  if (idx !== -1) {
    g.entries.splice(idx, 1);
    await g.save();
    await updateEmbedEntries(interaction.message, g);
    return interaction.reply({ content: 'You left the giveaway.', ephemeral: true });
  }
  g.entries.push(userId);
  await g.save();
  await updateEmbedEntries(interaction.message, g);
  return interaction.reply({ content: '🎉 You entered the giveaway!', ephemeral: true });
}

async function updateEmbedEntries(message, giveaway) {
  try {
    const oldEmbed = message.embeds[0];
    const newEmbed = EmbedBuilder.from(oldEmbed).setFooter({ text: `Entries: ${giveaway.entries.length}` });
    await message.edit({ embeds: [newEmbed] });
  } catch (err) {
    console.error('Failed to update entry count:', err);
  }
}

/**
 * Runs once at startup: pulls every non-ended giveaway from the DB and either
 * finishes it immediately (if its time already passed while the bot was offline)
 * or schedules its completion timer. Also runs as a periodic safety-net sweep.
 */
async function rescheduleActiveGiveaways(client) {
  const active = await Giveaway.find({ ended: false });
  const now = Date.now();
  for (const g of active) {
    if (now >= g.endTimestamp) {
      await finishGiveaway(client, g).catch(console.error);
    } else if (!activeTimers.has(g.messageId)) {
      scheduleGiveawayEnd(client, g.messageId, g.endTimestamp - now);
    }
  }
}

module.exports = {
  parseDuration,
  formatTime,
  resolveColor,
  buildGiveawayEmbed,
  buildEntryRow,
  launchGiveaway,
  finishGiveaway,
  finishGiveawayById,
  handleButtonInteraction,
  updateEmbedEntries,
  rescheduleActiveGiveaways
};
