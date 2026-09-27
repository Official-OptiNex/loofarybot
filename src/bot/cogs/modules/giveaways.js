const crypto = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Giveaway = require('../../../database/models/Giveaway');
const UserLevel = require('../../../database/models/UserLevel');
const GuildConfig = require('../../../database/models/GuildConfig');
const { boosterSettings } = require('./boosterPerks');
const { parseDuration } = require('../../utils/duration');

// Keys track live setTimeout handles so a redeploy doesn't create duplicate timers,
// and so /loof delete or /loof end can cancel a pending timer cleanly.
const activeTimers = new Map(); // messageId -> Timeout

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

function hasRequirements(req) {
  return !!(req && (req.roleId || req.minDaysInServer || req.minLevel));
}

function describeRequirements(req) {
  if (!hasRequirements(req)) return '';
  const parts = [];
  if (req.roleId) parts.push(`• Have the <@&${req.roleId}> role`);
  if (req.minDaysInServer) parts.push(`• Be in the server for **${req.minDaysInServer}+ day(s)**`);
  if (req.minLevel) parts.push(`• Be **Level ${req.minLevel}+**`);
  return `\n\n**Requirements:**\n${parts.join('\n')}`;
}

// "Bonus entries: @Booster +2 · @Supporter +1" — extra chances to win for members with those roles.
function describeBonus(g) {
  const list = (g.bonusEntries || []).filter((b) => b.roleId && b.extra > 0).map((b) => `<@&${b.roleId}> +${b.extra}`);
  if (g.boosterEntries > 0) list.push(`💎 Server boosters +${g.boosterEntries}`);
  return list.length ? `\n\n**Bonus entries:** ${list.join(' · ')}` : '';
}

// The server's booster perk, saved on each giveaway when it's posted. Giveaways from before the perk
// existed use the server's current setting.
async function boosterExtraFor(guildId, g) {
  if (g.type === 'drop') return 0;
  if (typeof g.boosterEntries === 'number') return g.boosterEntries;
  const config = await GuildConfig.findOne({ guildId }, { boosterPerks: 1 }).lean().catch(() => null);
  const perks = boosterSettings(config || {});
  return perks.enabled ? perks.giveawayEntries : 0;
}

// Each entrant's number of tickets: 1, plus the best bonus they have (a bonus role, or boosting).
function weightFor(member, g, boosterExtra = 0) {
  if (!member) return 1;
  const bonuses = (g.bonusEntries || []).filter((b) => member.roles?.cache?.has(b.roleId)).map((b) => b.extra);
  if (boosterExtra > 0 && member.premiumSince) bonuses.push(boosterExtra);
  return 1 + Math.max(0, ...bonuses);
}

async function entryWeights(guild, g, userIds) {
  const weights = new Map(userIds.map((id) => [id, 1]));
  if (!guild) return weights;
  const boosterExtra = await boosterExtraFor(guild.id, g);
  if (!(g.bonusEntries || []).length && !boosterExtra) return weights;
  for (let i = 0; i < userIds.length; i += 100) {
    const members = await guild.members.fetch({ user: userIds.slice(i, i + 100) }).catch(() => null);
    members?.forEach((m) => weights.set(m.id, weightFor(m, g, boosterExtra)));
  }
  return weights;
}

// Fair random pick of `count` different people, each weighted by their tickets.
function weightedPick(ids, weights, count) {
  const pool = [...ids];
  const picked = [];
  while (picked.length < count && pool.length) {
    const total = pool.reduce((n, id) => n + (weights.get(id) || 1), 0);
    let roll = crypto.randomInt(total);
    const idx = pool.findIndex((id) => (roll -= weights.get(id) || 1) < 0);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function buildGiveawayEmbed(g) {
  if (g.type === 'drop') {
    return new EmbedBuilder()
      .setTitle(`⚡ Drop: ${g.prize}`)
      .setDescription(
        `${g.customDesc}${describeRequirements(g.requirements)}\n\n**Prizes:** ${g.winnerCount} · **First ${g.winnerCount} to click win!**\n` +
          `**Expires:** ${formatTime(g.endTimestamp)}\n**Hosted By:** <@${g.hostId}>`
      )
      .setColor(g.colorHex)
      .setFooter({ text: `Claimed: ${g.entries.length}/${g.winnerCount}` });
  }
  return new EmbedBuilder()
    .setTitle(`🎁 Giveaway: ${g.prize}`)
    .setDescription(
      `${g.customDesc}${describeRequirements(g.requirements)}${describeBonus(g)}\n\n**Ends:** ${formatTime(g.endTimestamp)}\n**Winners:** ${g.winnerCount}\n**Hosted By:** <@${g.hostId}>`
    )
    .setColor(g.colorHex)
    .setFooter({ text: `Entries: ${g.entries.length}` })
    .setTimestamp(g.endTimestamp);
}

/**
 * Returns a human-readable reason the member can't enter, or null if they meet every requirement.
 * Pass `levelsByUser` (userId -> level) to avoid a DB lookup per member when checking in bulk.
 */
async function checkRequirements(member, g, levelsByUser = null) {
  const req = g.requirements;
  if (!hasRequirements(req)) return null;
  if (!member) return 'You must be a member of this server.';

  if (req.roleId && !member.roles.cache.has(req.roleId)) {
    return `You need the <@&${req.roleId}> role to enter.`;
  }
  if (req.minDaysInServer) {
    const days = member.joinedTimestamp ? (Date.now() - member.joinedTimestamp) / 86400000 : 0;
    if (days < req.minDaysInServer) {
      return `You need to have been in the server for **${req.minDaysInServer} day(s)** (you're at ${Math.floor(days)}).`;
    }
  }
  if (req.minLevel) {
    let level;
    if (levelsByUser) level = levelsByUser.get(member.id) ?? 0;
    else level = (await UserLevel.findOne({ guildId: member.guild.id, userId: member.id }).lean())?.level ?? 0;
    if (level < req.minLevel) return `You need to be **Level ${req.minLevel}** (you're Level ${level}).`;
  }
  return null;
}

function buildEntryRow(emoji, disabled = false, type = 'timed') {
  const isDrop = type === 'drop';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(disabled ? 'g_ended' : isDrop ? 'g_drop' : 'g_enter')
      .setLabel(disabled ? 'Ended' : isDrop ? 'Claim!' : 'Enter')
      .setEmoji(disabled ? '🔒' : emoji)
      .setStyle(disabled ? ButtonStyle.Secondary : isDrop ? ButtonStyle.Success : ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

/**
 * Discord requires an interaction's FIRST response within 3 seconds. Any command that does a
 * Discord API call (channel.send) followed by a database write can blow past that on a free-tier
 * host, so callers defer immediately and every subsequent reply must go through this helper —
 * it picks editReply vs reply based on whether the interaction was already deferred/replied,
 * and (critically) is always awaited by its caller so a failure is still caught locally instead
 * of leaking out to the generic top-level error handler.
 */
async function replyOrEdit(interaction, options) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(options);
  }
  return interaction.reply(options);
}

/**
 * Posts a giveaway (or drop) in `channel` and stores it. Shared by /loof and the dashboard.
 * `ping` is the raw text to put above the embed (a role mention, @everyone or @here) or null.
 * Throws if the bot can't post there.
 */
async function postGiveaway(
  client,
  { channel, hostId, durationMs, winnerCount, prize, ping = null, colorHex, emoji, customDesc, type = 'timed', requirements = {}, bonusEntries = [] }
) {
  const perks = type === 'drop' ? null : boosterSettings((await GuildConfig.findOne({ guildId: channel.guild.id }, { boosterPerks: 1 }).lean().catch(() => null)) || {});
  const draft = {
    prize,
    winnerCount,
    endTimestamp: Date.now() + durationMs,
    colorHex,
    emoji,
    customDesc,
    hostId,
    entries: [],
    type,
    requirements: {
      roleId: requirements.roleId || null,
      minDaysInServer: requirements.minDaysInServer || null,
      minLevel: requirements.minLevel || null
    },
    // Drops are first-come — bonus entries only apply to timed giveaways.
    bonusEntries: type === 'drop' ? [] : cleanBonus(bonusEntries),
    boosterEntries: perks?.enabled ? perks.giveawayEntries : 0
  };

  const msg = await channel.send({
    content: ping || undefined,
    embeds: [buildGiveawayEmbed(draft)],
    components: [buildEntryRow(emoji, false, type)]
  });
  const giveaway = await Giveaway.create({ messageId: msg.id, channelId: channel.id, guildId: channel.guild.id, ...draft });
  scheduleGiveawayEnd(client, msg.id, durationMs);
  return { message: msg, giveaway };
}

function cleanBonus(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((b) => ({ roleId: b?.roleId ? String(b.roleId) : null, extra: Math.min(Math.max(Number.parseInt(b?.extra, 10) || 0, 0), 10) }))
    .filter((b) => b.roleId && b.extra > 0 && !seen.has(b.roleId) && seen.add(b.roleId))
    .slice(0, 5);
}

async function launchGiveaway(client, { interaction, pingRole, ping, ...options }) {
  try {
    const { message } = await postGiveaway(client, {
      ...options,
      hostId: interaction.user.id,
      ping: ping ?? (pingRole ? `${pingRole}` : null)
    });
    return await replyOrEdit(interaction, {
      content: `✅ ${options.type === 'drop' ? 'Drop' : 'Giveaway'} started in ${options.channel}! [Jump to Message](${message.url})`
    });
  } catch (err) {
    console.error('Error posting giveaway message:', err);
    return await replyOrEdit(interaction, {
      content: '❌ Failed to send giveaway message. Ensure the bot has permissions in the target channel.'
    });
  }
}

async function fetchGiveawayMessage(client, g) {
  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  const message = channel ? await channel.messages.fetch(g.messageId).catch(() => null) : null;
  return { channel, message };
}

// Re-renders a running giveaway after its settings changed, and moves its timer if the end moved.
async function refreshGiveaway(client, g) {
  const { message } = await fetchGiveawayMessage(client, g);
  if (message) {
    await message.edit({ embeds: [buildGiveawayEmbed(g)], components: [buildEntryRow(g.emoji, false, g.type)] }).catch(() => null);
  }
  if (!g.ended) scheduleGiveawayEnd(client, g.messageId, g.endTimestamp - Date.now());
  return !!message;
}

/** Picks a new winner from an ended timed giveaway (eligible entrants only). Returns the user ID or an error. */
async function rerollGiveaway(client, g) {
  if (!g.ended) return { error: 'That giveaway has not ended yet.' };
  if (g.type === 'drop') return { error: "Drops can't be rerolled — their winners are whoever claimed first." };
  const { channel } = await fetchGiveawayMessage(client, g);
  let pool = [...g.entries];
  if (hasRequirements(g.requirements) && channel?.guild) pool = await filterEligible(channel.guild, g, pool);
  // Prefer someone who hasn't won yet; only fall back to past winners if nobody else is left.
  const fresh = pool.filter((id) => !(g.winners || []).includes(id));
  if (fresh.length) pool = fresh;
  if (pool.length === 0) return { error: 'No eligible entries to reroll from.' };

  const [winner] = weightedPick(pool, await entryWeights(channel?.guild, g, pool), 1);
  await Giveaway.updateOne({ _id: g._id }, { $push: { winners: winner } });
  if (channel) channel.send(`🎉 New winner for **${g.prize}**: <@${winner}>!`).catch(() => null);
  return { winner };
}

/** Deletes a giveaway's message and record, cancelling its timer. */
async function deleteGiveaway(client, g) {
  clearScheduledEnd(g.messageId);
  const { message } = await fetchGiveawayMessage(client, g);
  if (message) await message.delete().catch(() => null);
  await Giveaway.deleteOne({ _id: g._id });
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
  // Atomic claim so a timer, the periodic sweep and the last drop click can't all finish it at once.
  const claimed = await Giveaway.findOneAndUpdate({ _id: g._id, ended: false }, { $set: { ended: true } }, { new: true });
  if (!claimed) return;
  g = claimed;
  clearScheduledEnd(g.messageId);

  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(g.messageId).catch(() => null);

  let winners = [];
  if (g.type === 'drop') {
    // Drop winners are simply whoever claimed in time.
    winners = [...g.entries];
  } else if (g.entries.length > 0) {
    let pool = [...g.entries];
    // Requirements may have been added after people entered — only draw from eligible entrants.
    if (hasRequirements(g.requirements) && channel.guild) {
      pool = await filterEligible(channel.guild, g, pool);
    }
    // Weighted by bonus entries (1 ticket each otherwise), fair random, no one picked twice.
    winners = weightedPick(pool, await entryWeights(channel.guild, g, pool), g.winnerCount);
  }
  await Giveaway.updateOne({ _id: g._id }, { $set: { winners } });
  const winnerMentions = winners.length > 0 ? winners.map((id) => `<@${id}>`).join(', ') : 'No valid entries.';

  if (msg) {
    const endedEmbed = new EmbedBuilder()
      .setTitle(`${g.type === 'drop' ? '⚡ Drop' : '🎁 Giveaway'} Ended: ${g.prize}`)
      .setDescription(`**Winners:** ${winnerMentions}\n**Hosted By:** <@${g.hostId}>`)
      .setColor('#2B2D31')
      .setTimestamp();

    await msg.edit({ embeds: [endedEmbed], components: [buildEntryRow(g.emoji, true)] }).catch(() => null);
  }

  if (winners.length > 0) {
    channel.send(`🎉 Congratulations ${winnerMentions}! You won **${g.prize}**!`).catch(() => null);
  } else if (g.type === 'drop') {
    channel.send(`⚡ The drop for **${g.prize}** expired with no claims.`).catch(() => null);
  } else {
    channel.send(`Giveaway for **${g.prize}** ended, but there were no valid entries.`).catch(() => null);
  }
}

async function filterEligible(guild, g, userIds) {
  const levelsByUser = new Map();
  if (g.requirements.minLevel) {
    const records = await UserLevel.find({ guildId: guild.id, userId: { $in: userIds } }, { userId: 1, level: 1 }).lean();
    records.forEach((r) => levelsByUser.set(r.userId, r.level));
  }
  const eligible = [];
  for (const userId of userIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && !(await checkRequirements(member, g, levelsByUser))) eligible.push(userId);
  }
  return eligible;
}

async function handleButtonInteraction(interaction) {
  if (interaction.customId === 'g_drop') return handleDropClaim(interaction);
  if (interaction.customId !== 'g_enter') return;

  const g = await Giveaway.findOne({ messageId: interaction.message.id });
  if (!g || g.ended) {
    return interaction.reply({ content: '❌ This giveaway has ended.', ephemeral: true });
  }

  const userId = interaction.user.id;
  if (g.entries.includes(userId)) {
    const updated = await Giveaway.findOneAndUpdate({ _id: g._id }, { $pull: { entries: userId } }, { new: true });
    await updateEmbedEntries(interaction.message, updated);
    return interaction.reply({ content: '👋 You left the giveaway. Click Enter again to rejoin.', ephemeral: true });
  }

  const reason = await checkRequirements(interaction.member, g);
  if (reason) return interaction.reply({ content: `🔒 ${reason}`, ephemeral: true });

  const updated = await Giveaway.findOneAndUpdate({ _id: g._id, ended: false }, { $addToSet: { entries: userId } }, { new: true });
  if (!updated) return interaction.reply({ content: '❌ This giveaway has ended.', ephemeral: true });
  await updateEmbedEntries(interaction.message, updated);
  const boosterExtra = await boosterExtraFor(interaction.guildId, updated);
  const tickets = weightFor(interaction.member, updated, boosterExtra);
  const why = boosterExtra && interaction.member?.premiumSince && tickets === 1 + boosterExtra ? '💎 booster bonus' : 'role bonus';
  return interaction.reply({
    content: tickets > 1 ? `🎉 You entered the giveaway with **${tickets} entries** (${why})! Click again to leave.` : '🎉 You entered the giveaway! Click again to leave.',
    ephemeral: true
  });
}

async function handleDropClaim(interaction) {
  const g = await Giveaway.findOne({ messageId: interaction.message.id });
  if (!g || g.ended) return interaction.reply({ content: '⌛ Too late — this drop is over.', ephemeral: true });

  const userId = interaction.user.id;
  if (g.entries.includes(userId)) return interaction.reply({ content: "✅ You've already claimed this drop.", ephemeral: true });

  const reason = await checkRequirements(interaction.member, g);
  if (reason) return interaction.reply({ content: `🔒 ${reason}`, ephemeral: true });

  // Single atomic update: only succeeds while there's still a free slot and the user hasn't claimed,
  // so simultaneous clicks can never hand out more prizes than winnerCount.
  const updated = await Giveaway.findOneAndUpdate(
    { _id: g._id, ended: false, entries: { $ne: userId }, $expr: { $lt: [{ $size: '$entries' }, '$winnerCount'] } },
    { $push: { entries: userId } },
    { new: true }
  );
  if (!updated) return interaction.reply({ content: '⌛ Too slow — every prize was already claimed!', ephemeral: true });

  const position = updated.entries.indexOf(userId) + 1;
  await interaction.reply({ content: `⚡ You claimed prize #${position} of **${updated.prize}**!`, ephemeral: true });

  if (updated.entries.length >= updated.winnerCount) {
    await finishGiveaway(interaction.client, updated);
  } else {
    await interaction.message.edit({ embeds: [buildGiveawayEmbed(updated)] }).catch(() => null);
  }
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
  hasRequirements,
  describeRequirements,
  describeBonus,
  cleanBonus,
  entryWeights,
  boosterExtraFor,
  weightFor,
  weightedPick,
  checkRequirements,
  replyOrEdit,
  postGiveaway,
  launchGiveaway,
  refreshGiveaway,
  rerollGiveaway,
  deleteGiveaway,
  scheduleGiveawayEnd,
  finishGiveaway,
  finishGiveawayById,
  handleButtonInteraction,
  updateEmbedEntries,
  rescheduleActiveGiveaways
};
