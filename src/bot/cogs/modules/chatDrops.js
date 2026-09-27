// Chat drops: every so often LoofaryBot drops "🎁 XP Drop! First to click wins" in an active channel.
// The first 1–3 members to click Claim each win a random amount of XP; the drop then closes and a short
// congrats is posted. Fully automatic once a channel is picked (/xpdrop or dashboard Leveling → Chat drops).
const crypto = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const ChatDrop = require('../../../database/models/ChatDrop');
const { getOrCreateConfig, adjustXp } = require('./leveling');

const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;
const TICK_MS = 30 * 1000;
const COLOR = '#F1C40F';
// How many people can win one drop: usually 1, sometimes 2, rarely 3.
const WINNER_ODDS = [
  [1, 70],
  [2, 22],
  [3, 8]
];

const fmt = (n) => Number(n).toLocaleString('en-US');
const randInt = (min, max) => min + crypto.randomInt(max - min + 1);

function dropSettings(config) {
  const d = (config && config.chatDrops) || {};
  const minXp = Math.max(1, d.minXp ?? 50);
  const minMinutes = Math.max(1, d.minMinutes ?? 30);
  return {
    enabled: !!d.enabled,
    channelIds: Array.isArray(d.channelIds) ? d.channelIds : [],
    minXp,
    maxXp: Math.max(minXp, d.maxXp ?? 250),
    minMinutes,
    maxMinutes: Math.max(minMinutes, d.maxMinutes ?? 90),
    minActivity: Math.max(0, d.minActivity ?? 3),
    claimSeconds: Math.min(Math.max(15, d.claimSeconds ?? 120), 3600),
    nextDropAt: d.nextDropAt ? new Date(d.nextDropAt) : null,
    lastDropAt: d.lastDropAt ? new Date(d.lastDropAt) : null
  };
}

function rollWinners() {
  let roll = crypto.randomInt(100);
  for (const [n, weight] of WINNER_ODDS) {
    if (roll < weight) return n;
    roll -= weight;
  }
  return 1;
}

// A random amount in range, rounded to a tidy multiple of 5.
function rollAmount(s) {
  const raw = randInt(s.minXp, s.maxXp);
  return Math.min(s.maxXp, Math.max(s.minXp, Math.round(raw / 5) * 5));
}

const nextDelayMs = (s) => randInt(s.minMinutes * 60, s.maxMinutes * 60) * 1000;

// ---------------------------------------------------------------- Chat activity (in memory)

const activity = new Map(); // channelId -> timestamps of recent human messages

function noteActivity(message) {
  if (!message.guild || message.author?.bot || message.system) return;
  const now = Date.now();
  const list = (activity.get(message.channelId) || []).filter((t) => now - t < ACTIVITY_WINDOW_MS);
  list.push(now);
  activity.set(message.channelId, list.slice(-50));
}

const recentMessages = (channelId, now = Date.now()) => (activity.get(channelId) || []).filter((t) => now - t < ACTIVITY_WINDOW_MS).length;

// Configured channels LoofaryBot can post in that have been active recently.
function eligibleChannels(guild, s) {
  const me = guild.members.me;
  return s.channelIds
    .map((id) => guild.channels.cache.get(id))
    .filter((c) => c && c.isTextBased() && !c.isThread())
    .filter((c) => c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
    .filter((c) => recentMessages(c.id) >= s.minActivity);
}

// ---------------------------------------------------------------- Messages

function openPayload(drop) {
  const each = drop.winners > 1;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🎁 XP Drop!')
    .setDescription(
      each
        ? `**${fmt(drop.amount)} XP** each for the first **${drop.winners}** people to click!`
        : `**${fmt(drop.amount)} XP** for the first person to click!`
    )
    .setFooter({ text: 'Claim it before it disappears' })
    .setTimestamp(drop.expiresAt);
  const button = new ButtonBuilder().setCustomId(`xpd:${drop._id}`).setLabel(each ? `Claim (${drop.winners - drop.claimedBy.length} left)` : 'Claim').setEmoji('🎁').setStyle(ButtonStyle.Success);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

function closedPayload(drop) {
  const winners = drop.claimedBy.map((id) => `<@${id}>`).join(', ');
  const embed = new EmbedBuilder()
    .setColor('#4E5058')
    .setTitle('🎁 XP Drop — claimed')
    .setDescription(`**${fmt(drop.amount)} XP**${drop.claimedBy.length > 1 ? ' each' : ''} → ${winners}`);
  const button = new ButtonBuilder().setCustomId(`xpd:${drop._id}`).setLabel('Claimed').setEmoji('✅').setStyle(ButtonStyle.Secondary).setDisabled(true);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: [] } };
}

function congratsPayload(drop) {
  const names = drop.claimedBy.map((id) => `<@${id}>`);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return {
    embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`🎉 ${who} grabbed **${fmt(drop.amount)} XP**${names.length > 1 ? ' each' : ''}!`)],
    allowedMentions: { parse: [] }
  };
}

// ---------------------------------------------------------------- Posting

/**
 * Posts a drop in `channel`. Returns the drop document, or { error }.
 */
async function postDrop(channel, s, { manual = false } = {}) {
  const drop = await ChatDrop.create({
    guildId: channel.guild.id,
    channelId: channel.id,
    amount: rollAmount(s),
    winners: rollWinners(),
    expiresAt: new Date(Date.now() + s.claimSeconds * 1000),
    manual
  });
  try {
    const message = await channel.send(openPayload(drop));
    drop.messageId = message.id;
    await drop.save();
    return drop;
  } catch (err) {
    await ChatDrop.deleteOne({ _id: drop._id }).catch(() => null);
    return { error: `Couldn't post in #${channel.name} — LoofaryBot needs Send Messages and Embed Links there. (${err.message})` };
  }
}

async function fetchDropMessage(guild, drop) {
  const channel = guild?.channels.cache.get(drop.channelId);
  if (!channel || !drop.messageId) return null;
  return channel.messages.fetch(drop.messageId).catch(() => null);
}

/**
 * Closes a drop exactly once: winners get the closed message + a short congrats; a drop nobody
 * claimed is simply removed so it doesn't clutter the channel.
 */
async function finishDrop(guild, dropId) {
  const drop = await ChatDrop.findOneAndUpdate({ _id: dropId, status: 'open' }, { $set: { status: 'closed' } }, { new: true });
  if (!drop) return null;
  const message = await fetchDropMessage(guild, drop);
  if (!drop.claimedBy.length) {
    await message?.delete().catch(() => null);
    return drop;
  }
  await message?.edit(closedPayload(drop)).catch(() => null);
  const channel = guild.channels.cache.get(drop.channelId);
  await channel?.send(congratsPayload(drop)).catch(() => null);
  return drop;
}

// ---------------------------------------------------------------- Claiming

async function handleDropButton(interaction) {
  const dropId = interaction.customId.split(':')[1];
  const userId = interaction.user.id;
  if (interaction.user.bot) return interaction.reply({ content: '🤖 Bots can’t claim drops.', ephemeral: true });

  // One atomic update: still open, not expired, not already yours, and a prize left.
  const drop = await ChatDrop.findOneAndUpdate(
    { _id: dropId, status: 'open', expiresAt: { $gt: new Date() }, claimedBy: { $ne: userId }, $expr: { $lt: [{ $size: '$claimedBy' }, '$winners'] } },
    { $push: { claimedBy: userId } },
    { new: true }
  ).catch(() => null);

  if (!drop) {
    const current = await ChatDrop.findById(dropId).lean().catch(() => null);
    const why = !current
      ? 'This drop is gone.'
      : current.claimedBy.includes(userId)
        ? 'You already grabbed this one!'
        : current.status === 'closed' || current.claimedBy.length >= current.winners
          ? '⚡ Too slow — someone beat you to it!'
          : '⌛ This drop has expired.';
    return interaction.reply({ content: why, ephemeral: true });
  }

  const config = await getOrCreateConfig(interaction.guildId);
  const result = await adjustXp(interaction.guild, userId, drop.amount, config).catch(() => null);
  const levelUp = result && result.newLevel > result.oldLevel ? ` You’re now **Level ${result.newLevel}**! 🎉` : '';
  await interaction.reply({ content: `🎁 You grabbed **${fmt(drop.amount)} XP**!${levelUp}`, ephemeral: true });

  if (drop.claimedBy.length >= drop.winners) return finishDrop(interaction.guild, drop._id);
  // Prizes left: show how many on the button.
  return interaction.message.edit(openPayload(drop)).catch(() => null);
}

// ---------------------------------------------------------------- Scheduler

async function tickGuild(client, config) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild || config.levelingEnabled === false) return;
  const s = dropSettings(config);
  if (!s.enabled || !s.channelIds.length) return;
  const now = Date.now();

  if (!s.nextDropAt) {
    await GuildConfig.updateOne({ guildId: guild.id, 'chatDrops.nextDropAt': null }, { $set: { 'chatDrops.nextDropAt': new Date(now + nextDelayMs(s)) } });
    return;
  }
  if (s.nextDropAt.getTime() > now) return;
  if (await ChatDrop.exists({ guildId: guild.id, status: 'open' })) return; // one drop at a time

  // Due, but only in a channel people are actually talking in — otherwise wait for activity.
  const channels = eligibleChannels(guild, s);
  if (!channels.length) return;

  // Claim this slot atomically so two copies of the bot (during a redeploy) can't both drop.
  const claimed = await GuildConfig.updateOne(
    { guildId: guild.id, 'chatDrops.nextDropAt': s.nextDropAt },
    { $set: { 'chatDrops.nextDropAt': new Date(now + nextDelayMs(s)), 'chatDrops.lastDropAt': new Date(now) } }
  );
  if (claimed.modifiedCount !== 1) return;
  const channel = channels[crypto.randomInt(channels.length)];
  const posted = await postDrop(channel, s);
  if (posted.error) console.warn(`[chatDrops] ${guild.id}: ${posted.error}`);
}

// Closes drops whose claim window ran out.
async function sweepExpired(client) {
  const expired = await ChatDrop.find({ status: 'open', expiresAt: { $lte: new Date() } }).limit(50).lean();
  for (const d of expired) {
    const guild = client.guilds.cache.get(d.guildId);
    if (guild) await finishDrop(guild, d._id).catch(() => null);
    else await ChatDrop.updateOne({ _id: d._id, status: 'open' }, { $set: { status: 'closed' } }).catch(() => null);
  }
}

async function tick(client) {
  await sweepExpired(client).catch((err) => console.error('Chat drop sweep failed:', err.message));
  const configs = await GuildConfig.find({ 'chatDrops.enabled': true }, { guildId: 1, chatDrops: 1, levelingEnabled: 1 }).lean().catch(() => []);
  for (const c of configs) await tickGuild(client, c).catch((err) => console.error(`Chat drop failed in ${c.guildId}:`, err.message));
}

function startChatDrops(client) {
  setInterval(() => tick(client), TICK_MS);
}

// ---------------------------------------------------------------- Settings

/** Validates a settings update (from /xpdrop or the dashboard). Returns { patch } or { error }. */
function cleanSettings(guild, input, current) {
  const next = { ...dropSettings({ chatDrops: current }), ...input };
  const whole = (v) => Number.parseInt(v, 10);
  const patch = {};
  if (input.enabled !== undefined) patch['chatDrops.enabled'] = !!input.enabled;
  if (input.channelIds !== undefined) {
    const ids = [...new Set((input.channelIds || []).map(String))];
    if (ids.length > 10) return { error: 'Pick at most 10 channels.' };
    if (ids.some((id) => !guild.channels.cache.get(id)?.isTextBased?.())) return { error: 'One of the drop channels is not a text channel in this server.' };
    patch['chatDrops.channelIds'] = ids;
  }
  const minXp = whole(next.minXp);
  const maxXp = whole(next.maxXp);
  if (!(minXp >= 1 && maxXp >= minXp && maxXp <= 100000)) return { error: 'XP per drop: pick a minimum of at least 1 and a maximum ≥ the minimum (up to 100,000).' };
  const minMin = whole(next.minMinutes);
  const maxMin = whole(next.maxMinutes);
  if (!(minMin >= 5 && maxMin >= minMin && maxMin <= 10080)) return { error: 'Time between drops: at least 5 minutes, and the maximum ≥ the minimum (up to 7 days).' };
  const activityMin = whole(next.minActivity);
  if (!(activityMin >= 0 && activityMin <= 100)) return { error: 'Chat activity must be 0–100 messages.' };
  const claim = whole(next.claimSeconds);
  if (!(claim >= 15 && claim <= 3600)) return { error: 'The claim window must be 15 seconds to 1 hour.' };
  Object.assign(patch, {
    'chatDrops.minXp': minXp,
    'chatDrops.maxXp': maxXp,
    'chatDrops.minMinutes': minMin,
    'chatDrops.maxMinutes': maxMin,
    'chatDrops.minActivity': activityMin,
    'chatDrops.claimSeconds': claim
  });
  // Just turned on, or the timing changed: pick a fresh next drop time within the new range.
  const was = dropSettings({ chatDrops: current });
  const timingChanged = minMin !== was.minMinutes || maxMin !== was.maxMinutes;
  if ((input.enabled && !was.enabled) || timingChanged || (input.enabled && !was.nextDropAt)) {
    patch['chatDrops.nextDropAt'] = new Date(Date.now() + randInt(minMin * 60, maxMin * 60) * 1000);
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const config = await getOrCreateConfig(guild.id);
  const current = config.chatDrops?.toObject ? config.chatDrops.toObject() : config.chatDrops || {};
  const { patch, error } = cleanSettings(guild, input, current);
  if (error) return { error };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { chatDrops: 1 }).lean();
  return { settings: dropSettings(fresh) };
}

async function recentDrops(guildId, limit = 10) {
  return ChatDrop.find({ guildId }).sort({ createdAt: -1 }).limit(limit).lean();
}

module.exports = {
  WINNER_ODDS,
  dropSettings,
  rollWinners,
  rollAmount,
  noteActivity,
  recentMessages,
  eligibleChannels,
  postDrop,
  finishDrop,
  handleDropButton,
  tick,
  sweepExpired,
  startChatDrops,
  cleanSettings,
  saveSettings,
  recentDrops,
  _test: { activity, openPayload, closedPayload, congratsPayload }
};
