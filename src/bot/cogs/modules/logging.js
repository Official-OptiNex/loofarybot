const {
  EmbedBuilder,
  PermissionFlagsBits,
  AuditLogEvent,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown
} = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const LogEntry = require('../../../database/models/LogEntry');
const { recordLeave } = require('./joinTracking');
const { diffWords } = require('../../utils/textDiff');

const LOG_EVENTS = {
  messageEdit: 'Message edits',
  messageDelete: 'Message deletes',
  memberJoin: 'Member joins',
  memberLeave: 'Member leaves',
  voice: 'Voice channel activity',
  roles: 'Role changes',
  modActions: 'Moderator actions (warns, timeouts, kicks, bans)',
  automod: 'Auto-mod catches',
  bulkDelete: 'Bulk deletes (purges)',
  members: 'Nicknames, timeouts, boosts, server avatars',
  bans: 'Bans & unbans (from anywhere)',
  channels: 'Channels created, deleted, edited',
  serverRoles: 'Server roles created, deleted, edited',
  threads: 'Threads',
  invites: 'Invites created & deleted',
  emojis: 'Emoji & stickers',
  server: 'Server settings',
  commands: 'Slash commands used',
  shop: 'XP shop purchases'
};

const truncate = (str, max = 1024) => (!str ? '*(empty)*' : str.length > max ? `${str.slice(0, max - 1)}…` : str);

// Wraps only the non-whitespace core of a diff segment so markdown markers stay valid.
function mark(text, open, close) {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${open}${m[2]}${close}${m[3]}` : text;
}

/**
 * Renders before/after with removed words struck through (~~old~~) and added words in
 * bold-underline (**__new__**). Falls back to plain text if the markup would overflow a field.
 */
function renderEditDiff(before, after) {
  const ops = diffWords(before, after);
  let beforeText = '';
  let afterText = '';
  let removed = 0;
  let added = 0;
  for (const op of ops) {
    const safe = escapeMarkdown(op.text);
    if (op.type === 'same') {
      beforeText += safe;
      afterText += safe;
    } else if (op.type === 'del') {
      beforeText += mark(safe, '~~', '~~');
      removed += op.text.trim().split(/\s+/).filter(Boolean).length;
    } else {
      afterText += mark(safe, '**__', '__**');
      added += op.text.trim().split(/\s+/).filter(Boolean).length;
    }
  }
  const fits = (t) => t.length <= 1024;
  return {
    before: fits(beforeText) ? beforeText || '*(empty)*' : truncate(escapeMarkdown(before)),
    after: fits(afterText) ? afterText || '*(empty)*' : truncate(escapeMarkdown(after)),
    summary: `${removed ? `−${removed} word${removed === 1 ? '' : 's'}` : ''}${removed && added ? ' · ' : ''}${added ? `+${added} word${added === 1 ? '' : 's'}` : ''}` || 'Formatting only'
  };
}

function jumpRow(url, label = 'Jump to message') {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label).setEmoji('🔗'));
}

async function getLogSettings(guild, eventKey) {
  if (!guild) return null;
  const config = await require('../../../database/configCache').getCachedConfig(guild.id);
  if (!config || config.logsEnabled === false) return null;
  if (config.logEvents && config.logEvents[eventKey] === false) return null;
  return config;
}

function resolveLogChannel(guild, channelId) {
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  const me = guild.members.me;
  if (!channel || !channel.isTextBased() || !me) return null;
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return null;
  }
  return channel;
}

/**
 * Stores the event for the dashboard's log viewer and posts it to the log channel (if one is set).
 * Nothing is recorded when the Logs module or this event type is switched off.
 */
async function sendLog(guild, eventKey, embed, { entry = {}, components = [] } = {}) {
  try {
    const config = await getLogSettings(guild, eventKey);
    if (!config) return;
    // When the database is nearly full only moderation logs are stored (the log channel still gets all).
    if (require('./storage').shouldStoreLog(eventKey)) {
      await LogEntry.create({ guildId: guild.id, type: eventKey, ...entry }).catch((err) =>
        console.error(`Failed to store ${eventKey} log:`, err.message)
      );
    }
    const channel = resolveLogChannel(guild, config.logChannelId);
    if (!channel) return;
    await channel.send({ embeds: [embed.setTimestamp()], components, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`Failed to send ${eventKey} log:`, err.message);
  }
}

function userAuthor(user) {
  return { name: `${user.tag ?? user.username} (${user.id})`, iconURL: user.displayAvatarURL?.({ size: 64 }) };
}

function userEntry(user) {
  return { userId: user.id, userTag: user.tag ?? user.username, userAvatar: user.displayAvatarURL?.({ size: 64 }) || '' };
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
      .setDescription(`✏️ **Message edited in ${newMessage.channel}**`);

    if (oldMessage.partial) {
      embed.addFields(
        { name: 'Before', value: '*(not cached — sent before the bot last restarted)*' },
        { name: 'After', value: truncate(escapeMarkdown(newMessage.content)) }
      );
    } else {
      const diff = renderEditDiff(oldMessage.content, newMessage.content);
      embed
        .addFields({ name: 'Before', value: diff.before }, { name: 'After', value: diff.after })
        .setFooter({ text: `Changes: ${diff.summary} · ~~removed~~ · added in bold` });
    }

    await sendLog(newMessage.guild, 'messageEdit', embed, {
      components: [jumpRow(newMessage.url)],
      entry: {
        ...userEntry(newMessage.author),
        channelId: newMessage.channelId,
        channelName: newMessage.channel.name,
        messageUrl: newMessage.url,
        before: oldMessage.partial ? '' : (oldMessage.content || '').slice(0, 4000),
        after: (newMessage.content || '').slice(0, 4000),
        summary: `edited a message in #${newMessage.channel.name}`,
        details: { beforeUnknown: !!oldMessage.partial }
      }
    });
  });

  client.on('messageDelete', async (message) => {
    if (!message.guild || message.author?.bot) return;
    const embed = new EmbedBuilder().setColor('#ED4245');
    const attachments = message.partial ? [] : message.attachments.map((a) => a.name);
    if (message.partial || !message.author) {
      embed.setDescription(`🗑️ **A message was deleted in ${message.channel}**\n*(Content unavailable — it was sent before the bot last restarted.)*`);
    } else {
      embed
        .setAuthor(userAuthor(message.author))
        .setDescription(`🗑️ **Message by ${message.author} deleted in ${message.channel}**`)
        .addFields({ name: 'Content', value: truncate(escapeMarkdown(message.content || '')) });
      if (attachments.length) embed.addFields({ name: 'Attachments', value: truncate(attachments.join('\n')) });
    }

    // The message is gone, but its link still lands at the spot in the channel where it was.
    const url = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
    await sendLog(message.guild, 'messageDelete', embed, {
      components: [jumpRow(url, 'Jump to where it was')],
      entry: {
        ...(message.author ? userEntry(message.author) : {}),
        channelId: message.channelId,
        channelName: message.channel?.name || '',
        messageUrl: url,
        before: message.partial ? '' : (message.content || '').slice(0, 4000),
        summary: `deleted a message in #${message.channel?.name || 'unknown'}`,
        details: { attachments, contentUnknown: !!message.partial }
      }
    });
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
    await sendLog(member.guild, 'memberJoin', embed, {
      entry: {
        ...userEntry(member.user),
        summary: 'joined the server',
        details: { accountAgeDays: ageDays, memberCount: member.guild.memberCount, newAccount: ageDays < 7 }
      }
    });
  });

  client.on('guildMemberRemove', async (member) => {
    // Feeds the dashboard's leaves line; independent of whether logging is configured.
    recordLeave(member).catch((err) => console.error('Failed to record member leave:', err.message));

    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setAuthor(userAuthor(member.user))
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .setDescription(`📤 ${member.user} **left the server**`);
    if (!member.partial && member.joinedTimestamp) {
      embed.addFields({ name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true });
    }
    const roles = member.partial ? [] : member.roles.cache.filter((r) => r.id !== member.guild.id);
    if (roles.size) embed.addFields({ name: 'Roles', value: truncate(roles.map((r) => `${r}`).join(' ')) });
    await sendLog(member.guild, 'memberLeave', embed, {
      entry: {
        ...userEntry(member.user),
        summary: 'left the server',
        details: { roles: roles.map ? roles.map((r) => r.name) : [], joinedAt: member.joinedTimestamp || null }
      }
    });
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;
    if (oldState.channelId === newState.channelId) return; // mute/deafen/stream toggles aren't logged

    let description;
    let color;
    let summary;
    if (!oldState.channelId) {
      description = `🔊 ${member} **joined** ${newState.channel}`;
      summary = `joined voice #${newState.channel?.name}`;
      color = '#57F287';
    } else if (!newState.channelId) {
      description = `🔇 ${member} **left** ${oldState.channel}`;
      summary = `left voice #${oldState.channel?.name}`;
      color = '#ED4245';
    } else {
      description = `🔀 ${member} **moved** ${oldState.channel} → ${newState.channel}`;
      summary = `moved #${oldState.channel?.name} → #${newState.channel?.name}`;
      color = '#5865F2';
    }
    const embed = new EmbedBuilder().setColor(color).setAuthor(userAuthor(member.user)).setDescription(description);
    await sendLog(newState.guild, 'voice', embed, {
      entry: {
        ...userEntry(member.user),
        channelId: newState.channelId || oldState.channelId,
        channelName: (newState.channel || oldState.channel)?.name || '',
        summary,
        details: { from: oldState.channel?.name || null, to: newState.channel?.name || null }
      }
    });
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
    let executor = null;
    if (newMember.guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      const logs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 }).catch(() => null);
      const found = logs?.entries.find((e) => e.target?.id === newMember.id && Date.now() - e.createdTimestamp < 10000);
      if (found?.executor) {
        executor = found.executor;
        embed.addFields({ name: 'Changed by', value: `${executor}` });
      }
    }
    await sendLog(newMember.guild, 'roles', embed, {
      entry: {
        ...userEntry(newMember.user),
        summary: [added.size ? `+${added.map((r) => r.name).join(', +')}` : '', removed.size ? `−${removed.map((r) => r.name).join(', −')}` : '']
          .filter(Boolean)
          .join(' '),
        details: {
          added: added.map((r) => r.name),
          removed: removed.map((r) => r.name),
          executor: executor ? executor.tag ?? executor.username : null
        }
      }
    });
  });
}

module.exports = { LOG_EVENTS, registerLoggingEvents, sendLog, renderEditDiff };
