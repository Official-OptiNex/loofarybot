const { ChannelType, PermissionFlagsBits, OverwriteType } = require('discord.js');
const { getOrCreateConfig } = require('./leveling');

// Everything that lets a regular member post. Reactions/voice are left alone.
const LOCKED_PERMS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];

const LOCKABLE_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice
];

const isStaffRole = (role) =>
  role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageMessages);

function snapshot(channel, targetId) {
  const ow = channel.permissionOverwrites.cache.get(targetId);
  return {
    channelId: channel.id,
    targetId,
    hadOverwrite: !!ow,
    prevAllow: ow ? LOCKED_PERMS.filter((p) => ow.allow.has(PermissionFlagsBits[p])) : [],
    prevDeny: ow ? LOCKED_PERMS.filter((p) => ow.deny.has(PermissionFlagsBits[p])) : []
  };
}

/**
 * Denies posting for @everyone — and for any non-staff role that explicitly allows posting
 * (those would otherwise override the @everyone deny). Staff roles (Admin / Manage Messages)
 * and bot-managed roles are untouched, so moderators can keep talking.
 */
async function lockChannel(channel, config, reason) {
  const guild = channel.guild;
  const targets = [guild.roles.everyone.id];
  for (const ow of channel.permissionOverwrites.cache.values()) {
    if (ow.type !== OverwriteType.Role || ow.id === guild.id) continue;
    const role = guild.roles.cache.get(ow.id);
    if (!role || role.managed || isStaffRole(role)) continue;
    if (LOCKED_PERMS.some((p) => ow.allow.has(PermissionFlagsBits[p]))) targets.push(role.id);
  }

  let changed = false;
  for (const targetId of targets) {
    const alreadySaved = config.lockdownOverwrites.some((o) => o.channelId === channel.id && o.targetId === targetId);
    if (!alreadySaved) config.lockdownOverwrites.push(snapshot(channel, targetId));
    await channel.permissionOverwrites.edit(targetId, Object.fromEntries(LOCKED_PERMS.map((p) => [p, false])), { reason });
    changed = true;
  }
  return changed;
}

async function unlockChannel(channel, config, reason) {
  const saved = config.lockdownOverwrites.filter((o) => o.channelId === channel.id);
  for (const entry of saved) {
    const restore = Object.fromEntries(
      LOCKED_PERMS.map((p) => [p, entry.prevAllow.includes(p) ? true : entry.prevDeny.includes(p) ? false : null])
    );
    await channel.permissionOverwrites.edit(entry.targetId, restore, { reason }).catch(() => null);

    // If we created the overwrite from scratch and it's now empty, remove it entirely.
    const ow = channel.permissionOverwrites.cache.get(entry.targetId);
    if (!entry.hadOverwrite && ow && ow.allow.bitfield === 0n && ow.deny.bitfield === 0n) {
      await ow.delete(reason).catch(() => null);
    }
  }
  config.lockdownOverwrites = config.lockdownOverwrites.filter((o) => o.channelId !== channel.id);
  return saved.length > 0;
}

function lockableChannels(guild, config) {
  return guild.channels.cache.filter((c) => LOCKABLE_TYPES.includes(c.type) && c.id !== config.honeypotChannelId);
}

async function notify(channel, content) {
  if (!channel.isTextBased() || channel.type === ChannelType.GuildForum) return;
  await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
}

async function lockdown(guild, { channel = null, reason = 'Lockdown', actor }) {
  const config = await getOrCreateConfig(guild.id);
  const channels = channel ? [channel] : [...lockableChannels(guild, config).values()];
  const auditReason = `${reason} (by ${actor.tag})`;
  const locked = [];
  const failed = [];

  for (const ch of channels) {
    try {
      await lockChannel(ch, config, auditReason);
      locked.push(ch);
    } catch (err) {
      failed.push(ch);
      console.error(`Lockdown failed for #${ch.name}:`, err.message);
    }
  }
  await config.save();

  const notice = `🔒 **This ${channel ? 'channel' : 'server'} is locked down.** ${reason ? `Reason: ${reason}` : ''}`;
  if (channel) await notify(channel, notice);
  else if (guild.systemChannel && locked.includes(guild.systemChannel)) await notify(guild.systemChannel, notice);
  return { locked, failed };
}

async function unlockdown(guild, { channel = null, actor }) {
  const config = await getOrCreateConfig(guild.id);
  const channelIds = channel ? [channel.id] : [...new Set(config.lockdownOverwrites.map((o) => o.channelId))];
  const auditReason = `Lockdown lifted (by ${actor.tag})`;
  const unlocked = [];

  for (const id of channelIds) {
    const ch = guild.channels.cache.get(id);
    if (!ch) {
      config.lockdownOverwrites = config.lockdownOverwrites.filter((o) => o.channelId !== id); // deleted channel
      continue;
    }
    if (await unlockChannel(ch, config, auditReason)) unlocked.push(ch);
  }
  await config.save();

  if (channel && unlocked.length) await notify(channel, '🔓 **This channel has been unlocked.**');
  else if (!channel && guild.systemChannel && unlocked.includes(guild.systemChannel)) {
    await notify(guild.systemChannel, '🔓 **The server lockdown has been lifted.**');
  }
  return { unlocked };
}

module.exports = { LOCKED_PERMS, lockdown, unlockdown };
