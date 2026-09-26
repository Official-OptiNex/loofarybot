const { PermissionFlagsBits, ChannelType } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');

const LINK_RE = /https?:\/\/\S+/i;
const MEDIA_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const noticeCooldown = new Map(); // `${channelId}:${userId}` -> timestamp, so spam doesn't spam notices too

function isMedia(message, rule) {
  if (message.attachments.size > 0) return true;
  if (message.stickers?.size > 0) return false;
  return !!(rule.allowLinks && LINK_RE.test(message.content || ''));
}

function describeRule(rule) {
  const parts = [rule.allowLinks ? 'attachments or links' : 'attachments only'];
  if (rule.autoThread) parts.push('comment thread on each post');
  parts.push(rule.staffBypass ? 'staff can post anything' : 'applies to staff too');
  return parts.join(' · ');
}

/**
 * Called for every guild message. Returns true when the message was handled (removed), so the
 * caller can skip XP for it. Threads under a media channel are free for normal chat.
 */
async function handleMediaOnly(message, config) {
  const rule = (config?.mediaOnlyChannels || []).find((r) => r.channelId === message.channelId);
  if (!rule || message.author.bot || message.webhookId || message.system) return false;
  if (rule.staffBypass && message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  if (isMedia(message, rule)) {
    if (rule.autoThread && message.channel.type === ChannelType.GuildText && !message.hasThread) {
      const name = `💬 ${message.member?.displayName || message.author.username}'s post`.slice(0, 100);
      await message.startThread({ name, autoArchiveDuration: 1440 }).catch(() => null);
    }
    return false;
  }

  const deleted = await message.delete().then(() => true).catch(() => false);
  if (!deleted) {
    require('../../utils/errorReporter').reportIssue(
      message.guild.id,
      'Media-only channel could not remove a message',
      `LoofaryBot needs **Manage Messages** in <#${message.channelId}> to keep it media-only.`
    );
    return false;
  }

  const key = `${message.channelId}:${message.author.id}`;
  if (Date.now() - (noticeCooldown.get(key) || 0) > 20000) {
    noticeCooldown.set(key, Date.now());
    const hint = rule.allowLinks ? 'an image, video, file or link' : 'an image, video or file';
    const threadHint = rule.autoThread ? ' Chat about posts in their threads.' : '';
    const notice = await message.channel
      .send({ content: `📸 ${message.author}, <#${message.channelId}> is media-only — posts need ${hint}.${threadHint}`, allowedMentions: { users: [message.author.id] } })
      .catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => null), 8000);
  }
  return true;
}

/** Adds or updates a channel's rule. Returns the saved rule. */
async function setMediaOnly(guildId, channelId, options = {}) {
  const config = await GuildConfig.findOne({ guildId }) || new GuildConfig({ guildId });
  const existing = config.mediaOnlyChannels.find((r) => r.channelId === channelId);
  const rule = {
    channelId,
    allowLinks: options.allowLinks ?? existing?.allowLinks ?? true,
    autoThread: options.autoThread ?? existing?.autoThread ?? false,
    staffBypass: options.staffBypass ?? existing?.staffBypass ?? true
  };
  config.mediaOnlyChannels = [...config.mediaOnlyChannels.filter((r) => r.channelId !== channelId), rule];
  await config.save();
  return { rule, updated: !!existing };
}

async function removeMediaOnly(guildId, channelId) {
  const res = await GuildConfig.updateOne({ guildId }, { $pull: { mediaOnlyChannels: { channelId } } });
  return res.modifiedCount > 0;
}

// What LoofaryBot is missing in a channel to enforce the rule (empty when fine).
function missingPermissions(channel, rule) {
  const me = channel.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const need = [['ViewChannel', 'View Channel'], ['ManageMessages', 'Manage Messages'], ['SendMessages', 'Send Messages']];
  if (rule.autoThread) need.push(['CreatePublicThreads', 'Create Public Threads']);
  return need.filter(([flag]) => !perms?.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}

module.exports = { MEDIA_CHANNEL_TYPES, handleMediaOnly, setMediaOnly, removeMediaOnly, describeRule, missingPermissions, isMedia };
