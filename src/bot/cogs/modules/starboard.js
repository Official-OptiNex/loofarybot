// Starboard: when a message gets enough ⭐ reactions (or the server's chosen emoji), LoofaryBot reposts it
// in the starboard channel with a jump link, and keeps the star count on that post up to date.
// Fully automatic once a channel is picked (/starboard setup or dashboard Engagement → Starboard).
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const StarboardPost = require('../../../database/models/StarboardPost');

const COLOR = '#FFAC33';
const CUSTOM_EMOJI_RE = /^<a?:(\w+):(\d+)>$/;

function starboardSettings(config) {
  const s = (config && config.starboard) || {};
  return {
    enabled: !!s.enabled,
    channelId: s.channelId || null,
    emoji: s.emoji || '⭐',
    threshold: Math.min(Math.max(s.threshold || 3, 1), 100),
    selfStar: !!s.selfStar,
    ignoredChannelIds: Array.isArray(s.ignoredChannelIds) ? s.ignoredChannelIds : []
  };
}

// Does a reaction's emoji match the configured one? Unicode by name, custom emoji by id.
function emojiMatches(emoji, configured) {
  const custom = String(configured).match(CUSTOM_EMOJI_RE);
  if (custom) return emoji.id === custom[2];
  return !emoji.id && emoji.name === configured;
}

// Tier icon for the post header — busier posts glow a little more.
function starIcon(count, configured) {
  if (configured !== '⭐') return configured;
  if (count >= 25) return '💫';
  if (count >= 10) return '🌟';
  return '⭐';
}

function buildPost(message, count, s) {
  const author = message.member?.displayName || message.author?.username || 'Unknown';
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: author, iconURL: message.author?.displayAvatarURL?.({ size: 64 }) || undefined })
    .setTimestamp(message.createdTimestamp || Date.now())
    .setFooter({ text: `#${message.channel?.name || 'channel'}` });
  let text = message.content || '';
  if (!text && message.embeds?.[0]?.description) text = message.embeds[0].description;
  if (text) embed.setDescription(text.slice(0, 3900));
  const image = message.attachments?.find((a) => (a.contentType || '').startsWith('image/')) || null;
  if (image) embed.setImage(image.url);
  else if (message.embeds?.[0]?.image?.url) embed.setImage(message.embeds[0].image.url);
  const others = (message.attachments?.size || 0) - (image ? 1 : 0);
  embed.addFields({ name: '​', value: `[Jump to message](${message.url})${others > 0 ? ` · 📎 ${others} more attachment${others === 1 ? '' : 's'}` : ''}` });
  return {
    content: `${starIcon(count, s.emoji)} **${count}** · <#${message.channelId}>`,
    embeds: [embed],
    allowedMentions: { parse: [] }
  };
}

// Stars on a message, not counting the author (unless self-stars are allowed) or bots.
async function countStars(reaction, message, s) {
  const users = await reaction.users.fetch({ limit: 100 }).catch(() => null);
  if (!users) return reaction.count || 0;
  return users.filter((u) => !u.bot && (s.selfStar || u.id !== message.author?.id)).size;
}

/** Called on every reaction add/remove. Creates or updates the starboard post as needed. */
async function handleReaction(reaction) {
  if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
  if (!reaction) return;
  let message = reaction.message;
  if (!message?.guildId) return;
  const config = await GuildConfig.findOne({ guildId: message.guildId }, { starboard: 1 }).lean();
  const s = starboardSettings(config);
  if (!s.enabled || !s.channelId || !emojiMatches(reaction.emoji, s.emoji)) return;
  if (message.partial) message = await message.fetch().catch(() => null);
  if (!message || message.author?.id === message.client.user?.id) return; // never star the bot's own posts
  const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
  if (message.channelId === s.channelId || [message.channelId, parentId].some((id) => id && s.ignoredChannelIds.includes(id))) return;

  const starChannel = message.guild.channels.cache.get(s.channelId);
  if (!starChannel?.isTextBased()) return;
  // Keep age-restricted content off a normal starboard.
  if (message.channel?.nsfw && !starChannel.nsfw) return;

  const count = await countStars(reaction, message, s);
  const existing = await StarboardPost.findOne({ guildId: message.guildId, messageId: message.id }).lean();

  if (existing?.starMessageId) {
    await StarboardPost.updateOne({ _id: existing._id }, { $set: { stars: count } });
    const post = await starChannel.messages.fetch(existing.starMessageId).catch(() => null);
    if (!post) return;
    if (count < s.threshold) {
      // Dropped below the bar (stars removed): take it off the board. It can come back later.
      await post.delete().catch(() => null);
      await StarboardPost.deleteOne({ _id: existing._id });
    } else {
      await post.edit(buildPost(message, count, s)).catch(() => null);
    }
    return;
  }
  if (count < s.threshold) return;

  // Claim the post atomically so two reactions at once can't both create it.
  const claim = await StarboardPost.findOneAndUpdate(
    { guildId: message.guildId, messageId: message.id },
    { $setOnInsert: { channelId: message.channelId, authorId: message.author?.id || null, stars: count } },
    { upsert: true, new: false }
  ).catch(() => 'taken');
  if (claim !== null) return;

  const sent = await starChannel.send(buildPost(message, count, s)).catch((err) => {
    console.warn(`[starboard] ${message.guildId}: could not post —`, err.message);
    return null;
  });
  if (!sent) return StarboardPost.deleteOne({ guildId: message.guildId, messageId: message.id });
  await StarboardPost.updateOne({ guildId: message.guildId, messageId: message.id }, { $set: { starMessageId: sent.id, starChannelId: starChannel.id, stars: count } });
}

// The original was deleted: remove its starboard copy too.
async function handleMessageDeleted(message) {
  if (!message.guildId) return;
  const post = await StarboardPost.findOneAndDelete({ guildId: message.guildId, messageId: message.id }).lean().catch(() => null);
  if (!post?.starMessageId) return;
  const channel = message.client?.channels.cache.get(post.starChannelId);
  const copy = await channel?.messages.fetch(post.starMessageId).catch(() => null);
  await copy?.delete().catch(() => null);
}

async function topPosts(guildId, limit = 10) {
  return StarboardPost.find({ guildId, starMessageId: { $ne: null } }).sort({ stars: -1, createdAt: -1 }).limit(limit).lean();
}

/** Validates a settings update (from /starboard or the dashboard). Returns { patch } or { error }. */
function cleanSettings(guild, input) {
  const patch = {};
  if (input.enabled !== undefined) patch['starboard.enabled'] = !!input.enabled;
  if (input.channelId !== undefined) {
    const id = input.channelId ? String(input.channelId) : null;
    const ch = id ? guild.channels.cache.get(id) : null;
    if (id && (!ch || !ch.isTextBased() || ch.isThread())) return { error: 'Pick a text channel in this server.' };
    patch['starboard.channelId'] = id;
  }
  if (input.emoji !== undefined) {
    const e = String(input.emoji || '').trim() || '⭐';
    const custom = e.match(CUSTOM_EMOJI_RE);
    if (custom && !guild.emojis.cache.has(custom[2])) return { error: 'That custom emoji is not from this server.' };
    if (!custom && (e.length > 16 || /[\w\s<>:]/.test(e))) return { error: 'Use a single emoji, like ⭐ or a custom emoji from this server.' };
    patch['starboard.emoji'] = e;
  }
  if (input.threshold !== undefined) {
    const n = Number.parseInt(input.threshold, 10);
    if (!(n >= 1 && n <= 100)) return { error: 'Stars needed must be 1–100.' };
    patch['starboard.threshold'] = n;
  }
  if (input.selfStar !== undefined) patch['starboard.selfStar'] = !!input.selfStar;
  if (input.ignoredChannelIds !== undefined) {
    const ids = [...new Set((input.ignoredChannelIds || []).map(String))].filter((id) => guild.channels.cache.has(id));
    if (ids.length > 25) return { error: 'Ignore at most 25 channels.' };
    patch['starboard.ignoredChannelIds'] = ids;
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch, error } = cleanSettings(guild, input);
  if (error) return { error };
  const current = await GuildConfig.findOne({ guildId: guild.id }, { starboard: 1 }).lean();
  const channelId = patch['starboard.channelId'] !== undefined ? patch['starboard.channelId'] : current?.starboard?.channelId;
  if ((patch['starboard.enabled'] ?? current?.starboard?.enabled) && !channelId) return { error: 'Pick a starboard channel first.' };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { starboard: 1 }).lean();
  return { settings: starboardSettings(fresh) };
}

function missingPermissions(guild, s) {
  const channel = s.channelId ? guild.channels.cache.get(s.channelId) : null;
  const me = guild.members.me;
  if (!channel || !me) return [];
  const perms = channel.permissionsFor(me);
  const need = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links'], ['ReadMessageHistory', 'Read Message History']];
  return need.filter(([flag]) => !perms?.has(PermissionFlagsBits[flag])).map(([, label]) => `${label} in #${channel.name}`);
}

function registerStarboardEvents(client) {
  const run = (reaction) => handleReaction(reaction).catch((err) => console.error('Starboard update failed:', err.message));
  client.on('messageReactionAdd', run);
  client.on('messageReactionRemove', run);
  client.on('messageDelete', (message) => handleMessageDeleted(message).catch(() => null));
}

module.exports = {
  starboardSettings,
  emojiMatches,
  buildPost,
  countStars,
  handleReaction,
  handleMessageDeleted,
  topPosts,
  cleanSettings,
  saveSettings,
  missingPermissions,
  registerStarboardEvents
};
