const { EmbedBuilder, PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');

const LOG_EVENTS = {
  messageEdit: 'Message edits',
  messageDelete: 'Message deletes',
  memberJoin: 'Member joins',
  memberLeave: 'Member leaves',
  voice: 'Voice channel activity',
  roles: 'Role changes'
};

const truncate = (str, max = 1024) => (!str ? '*(empty)*' : str.length > max ? `${str.slice(0, max - 1)}…` : str);

/**
 * Returns the guild's log channel if logging is on for this event type and the bot can post there.
 */
async function getLogChannel(guild, eventKey) {
  if (!guild) return null;
  const config = await GuildConfig.findOne({ guildId: guild.id }, { logChannelId: 1, logEvents: 1 }).lean();
  if (!config || !config.logChannelId) return null;
  if (config.logEvents && config.logEvents[eventKey] === false) return null;

  const channel = guild.channels.cache.get(config.logChannelId);
  const me = guild.members.me;
  if (!channel || !channel.isTextBased() || !me) return null;
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return null;
  }
  return channel;
}

async function sendLog(guild, eventKey, embed) {
  try {
    const channel = await getLogChannel(guild, eventKey);
    if (!channel) return;
    await channel.send({ embeds: [embed.setTimestamp()], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`Failed to send ${eventKey} log:`, err.message);
  }
}

function userAuthor(user) {
  return { name: `${user.tag ?? user.username} (${user.id})`, iconURL: user.displayAvatarURL?.({ size: 64 }) };
}

function registerLoggingEvents(client) {
  client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (!newMessage.guild) return;
    if (newMessage.partial) newMessage = await newMessage.fetch().catch(() => null);
    if (!newMessage || newMessage.author?.bot) return;
    // Embeds unfurling also fires messageUpdate — only log real text changes.
    if (!oldMessage.partial && oldMessage.content === newMessage.content) return;

    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setAuthor(userAuthor(newMessage.author))
      .setDescription(`✏️ **Message edited in ${newMessage.channel}** — [Jump](${newMessage.url})`)
      .addFields(
        { name: 'Before', value: oldMessage.partial ? '*(not cached — sent before the bot last restarted)*' : truncate(oldMessage.content) },
        { name: 'After', value: truncate(newMessage.content) }
      );
    await sendLog(newMessage.guild, 'messageEdit', embed);
  });

  client.on('messageDelete', async (message) => {
    if (!message.guild || message.author?.bot) return;
    const embed = new EmbedBuilder().setColor('#ED4245');
    if (message.partial || !message.author) {
      embed.setDescription(`🗑️ **A message was deleted in ${message.channel}**\n*(Content unavailable — it was sent before the bot last restarted.)*`);
    } else {
      embed
        .setAuthor(userAuthor(message.author))
        .setDescription(`🗑️ **Message by ${message.author} deleted in ${message.channel}**`)
        .addFields({ name: 'Content', value: truncate(message.content) });
      if (message.attachments.size > 0) {
        embed.addFields({ name: 'Attachments', value: truncate(message.attachments.map((a) => a.name).join('\n')) });
      }
    }
    await sendLog(message.guild, 'messageDelete', embed);
  });

  client.on('guildMemberAdd', async (member) => {
    const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setAuthor(userAuthor(member.user))
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .setDescription(`📥 ${member} **joined the server**`)
      .addFields(
        { name: 'Account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>${ageDays < 7 ? ' ⚠️ new account' : ''}`, inline: true },
        { name: 'Member count', value: `${member.guild.memberCount}`, inline: true }
      );
    await sendLog(member.guild, 'memberJoin', embed);
  });

  client.on('guildMemberRemove', async (member) => {
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setAuthor(userAuthor(member.user))
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .setDescription(`📤 ${member.user} **left the server**`);
    if (!member.partial && member.joinedTimestamp) {
      embed.addFields({ name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true });
    }
    const roles = member.partial ? [] : member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => `${r}`);
    if (roles.length) embed.addFields({ name: 'Roles', value: truncate(roles.join(' ')) });
    await sendLog(member.guild, 'memberLeave', embed);
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;
    if (oldState.channelId === newState.channelId) return; // mute/deafen/stream toggles aren't logged

    let description;
    let color;
    if (!oldState.channelId) {
      description = `🔊 ${member} **joined** ${newState.channel}`;
      color = '#57F287';
    } else if (!newState.channelId) {
      description = `🔇 ${member} **left** ${oldState.channel}`;
      color = '#ED4245';
    } else {
      description = `🔀 ${member} **moved** ${oldState.channel} → ${newState.channel}`;
      color = '#5865F2';
    }
    const embed = new EmbedBuilder().setColor(color).setAuthor(userAuthor(member.user)).setDescription(description);
    await sendLog(newState.guild, 'voice', embed);
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.partial) return; // no reliable "before" state to diff against
    const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
    const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
    if (added.size === 0 && removed.size === 0) return;

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setAuthor(userAuthor(newMember.user))
      .setDescription(`🎭 **Roles updated for ${newMember}**`);
    if (added.size) embed.addFields({ name: 'Added', value: truncate(added.map((r) => `${r}`).join(' ')) });
    if (removed.size) embed.addFields({ name: 'Removed', value: truncate(removed.map((r) => `${r}`).join(' ')) });

    // Best effort: name who made the change (needs View Audit Log).
    if (newMember.guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      const logs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 }).catch(() => null);
      const entry = logs?.entries.find((e) => e.target?.id === newMember.id && Date.now() - e.createdTimestamp < 10000);
      if (entry?.executor) embed.addFields({ name: 'Changed by', value: `${entry.executor}` });
    }
    await sendLog(newMember.guild, 'roles', embed);
  });
}

module.exports = { LOG_EVENTS, registerLoggingEvents, sendLog };
