// The rest of the server log: bans, channels, server roles, nicknames/timeouts/boosts, threads,
// invites, emoji & stickers, server settings, bulk deletes and slash-command use. Each one is stored
// for the dashboard's log viewer and posted to the log channel (see logging.js → sendLog).
const { EmbedBuilder, PermissionFlagsBits, AuditLogEvent, ChannelType, PermissionsBitField, escapeMarkdown } = require('discord.js');
const { sendLog } = require('./logging');

const COLORS = { create: '#57F287', delete: '#ED4245', update: '#5865F2', warn: '#F0B232' };
const clip = (s, n = 1000) => (!s ? '' : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const ts = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;
const tagOf = (u) => (u ? u.tag ?? u.username ?? String(u.id) : null);

const CHANNEL_TYPES = {
  [ChannelType.GuildText]: 'text channel',
  [ChannelType.GuildVoice]: 'voice channel',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement channel',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'media channel'
};

/** Who did it and why, from the audit log (needs View Audit Log). Best effort — null if unknown. */
async function findExecutor(guild, type, targetId) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => (!targetId || e.target?.id === targetId || e.targetId === targetId) && Date.now() - e.createdTimestamp < 15000);
  return entry ? { executor: entry.executor, reason: entry.reason || null } : null;
}

function withExecutor(embed, found) {
  if (found?.executor) embed.addFields({ name: 'By', value: `${found.executor}`, inline: true });
  if (found?.reason) embed.addFields({ name: 'Reason', value: clip(found.reason, 500), inline: true });
  return embed;
}

const execDetails = (found) => ({ executor: tagOf(found?.executor), reason: found?.reason || null });

// Lists "field: old → new" for the keys that changed.
function diffLines(before, after, fields) {
  const lines = [];
  for (const [key, label, fmt = (v) => (v === null || v === undefined || v === '' ? '*none*' : String(v))] of fields) {
    const a = before?.[key];
    const b = after?.[key];
    if (String(a ?? '') !== String(b ?? '')) lines.push(`**${label}:** ${clip(fmt(a), 300)} → ${clip(fmt(b), 300)}`);
  }
  return lines;
}

function permDiff(oldBits, newBits) {
  const a = new PermissionsBitField(oldBits || 0n).toArray();
  const b = new PermissionsBitField(newBits || 0n).toArray();
  return { added: b.filter((p) => !a.includes(p)), removed: a.filter((p) => !b.includes(p)) };
}

const colorHex = (n) => (n ? `#${Number(n).toString(16).padStart(6, '0')}` : 'default');
const yesNo = (v) => (v ? 'yes' : 'no');

function registerServerLogEvents(client) {
  const on = (event, fn) => client.on(event, (...args) => fn(...args).catch((err) => console.error(`[serverLogs] ${event}:`, err.message)));

  // ---- Bulk deletes (purges)
  on('messageDeleteBulk', async (messages, channel) => {
    const guild = channel?.guild;
    if (!guild) return;
    const list = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const authors = new Map();
    for (const m of list) if (m.author) authors.set(m.author.id, (authors.get(m.author.id) || 0) + 1);
    const found = await findExecutor(guild, AuditLogEvent.MessageBulkDelete, channel.id);
    const embed = withExecutor(
      new EmbedBuilder()
        .setColor(COLORS.delete)
        .setDescription(`🧹 **${list.length} messages deleted in ${channel}**`)
        .addFields({ name: 'From', value: clip([...authors].map(([id, n]) => `<@${id}> ×${n}`).join(' ') || 'unknown (not cached)', 1000) }),
      found
    );
    const transcript = list
      .filter((m) => !m.partial)
      .map((m) => `[${new Date(m.createdTimestamp).toISOString().slice(11, 19)}] ${tagOf(m.author)}: ${m.content || (m.attachments?.size ? '[attachment]' : '')}`)
      .join('\n');
    await sendLog(guild, 'bulkDelete', embed, {
      entry: {
        channelId: channel.id,
        channelName: channel.name,
        before: clip(transcript, 4000),
        summary: `${list.length} messages bulk-deleted in #${channel.name}${found?.executor ? ` by ${tagOf(found.executor)}` : ''}`,
        details: { count: list.length, authors: Object.fromEntries(authors), ...execDetails(found) }
      }
    });
  });

  // ---- Nicknames, timeouts, boosts (role changes are logged in logging.js)
  on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.partial) return;
    const guild = newMember.guild;
    const user = newMember.user;
    const base = () => new EmbedBuilder().setAuthor({ name: `${tagOf(user)} (${user.id})`, iconURL: user.displayAvatarURL?.({ size: 64 }) || undefined });
    const entryBase = { userId: user.id, userTag: tagOf(user), userAvatar: user.displayAvatarURL?.({ size: 64 }) || '' };

    if (oldMember.nickname !== newMember.nickname) {
      const found = await findExecutor(guild, AuditLogEvent.MemberUpdate, user.id);
      const embed = withExecutor(
        base()
          .setColor(COLORS.update)
          .setDescription(`🏷️ **Nickname changed for ${newMember}**`)
          .addFields({ name: 'Before', value: escapeMarkdown(oldMember.nickname || '*none*'), inline: true }, { name: 'After', value: escapeMarkdown(newMember.nickname || '*none*'), inline: true }),
        found
      );
      await sendLog(guild, 'members', embed, {
        entry: { ...entryBase, before: oldMember.nickname || '', after: newMember.nickname || '', summary: `nickname: ${oldMember.nickname || '(none)'} → ${newMember.nickname || '(none)'}`, details: { kind: 'nickname', ...execDetails(found) } }
      });
    }

    const wasOut = oldMember.communicationDisabledUntilTimestamp > Date.now();
    const isOut = newMember.communicationDisabledUntilTimestamp > Date.now();
    if (wasOut !== isOut || (isOut && oldMember.communicationDisabledUntilTimestamp !== newMember.communicationDisabledUntilTimestamp)) {
      const found = await findExecutor(guild, AuditLogEvent.MemberUpdate, user.id);
      const embed = withExecutor(
        base()
          .setColor(isOut ? COLORS.warn : COLORS.create)
          .setDescription(isOut ? `⏳ ${newMember} **was timed out** until ${ts(newMember.communicationDisabledUntil)}` : `🔊 ${newMember}'s **timeout ended or was removed**`),
        found
      );
      await sendLog(guild, 'members', embed, {
        entry: { ...entryBase, summary: isOut ? `timed out until ${new Date(newMember.communicationDisabledUntilTimestamp).toISOString()}` : 'timeout removed', details: { kind: 'timeout', until: isOut ? newMember.communicationDisabledUntilTimestamp : null, ...execDetails(found) } }
      });
    }

    if (!!oldMember.premiumSince !== !!newMember.premiumSince) {
      const started = !!newMember.premiumSince;
      await sendLog(guild, 'members', base().setColor('#FF73FA').setDescription(started ? `💎 ${newMember} **boosted the server**` : `💔 ${newMember} **stopped boosting**`), {
        entry: { ...entryBase, summary: started ? 'started boosting' : 'stopped boosting', details: { kind: 'boost', started } }
      });
    }

    if (oldMember.avatar !== newMember.avatar) {
      await sendLog(guild, 'members', base().setColor(COLORS.update).setDescription(`🖼️ ${newMember} **changed their server avatar**`).setThumbnail(newMember.displayAvatarURL({ size: 128 })), {
        entry: { ...entryBase, summary: 'changed their server avatar', details: { kind: 'avatar' } }
      });
    }
  });

  // ---- Bans (from anywhere — Discord's own menu, other bots, LoofaryBot)
  on('guildBanAdd', async (ban) => {
    const found = await findExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    const embed = withExecutor(new EmbedBuilder().setColor(COLORS.delete).setAuthor({ name: `${tagOf(ban.user)} (${ban.user.id})`, iconURL: ban.user.displayAvatarURL?.({ size: 64 }) || undefined }).setDescription(`🔨 **${tagOf(ban.user)} was banned**`), found);
    await sendLog(ban.guild, 'bans', embed, {
      entry: { userId: ban.user.id, userTag: tagOf(ban.user), userAvatar: ban.user.displayAvatarURL?.({ size: 64 }) || '', summary: `was banned${found?.executor ? ` by ${tagOf(found.executor)}` : ''}`, details: { kind: 'ban', ...execDetails(found) } }
    });
  });
  on('guildBanRemove', async (ban) => {
    const found = await findExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    const embed = withExecutor(new EmbedBuilder().setColor(COLORS.create).setAuthor({ name: `${tagOf(ban.user)} (${ban.user.id})` }).setDescription(`🕊️ **${tagOf(ban.user)} was unbanned**`), found);
    await sendLog(ban.guild, 'bans', embed, {
      entry: { userId: ban.user.id, userTag: tagOf(ban.user), summary: `was unbanned${found?.executor ? ` by ${tagOf(found.executor)}` : ''}`, details: { kind: 'unban', ...execDetails(found) } }
    });
  });

  // ---- Channels
  const channelEntry = (ch, summary, details = {}) => ({ channelId: ch.id, channelName: ch.name, summary, details });
  on('channelCreate', async (ch) => {
    if (!ch.guild) return;
    const found = await findExecutor(ch.guild, AuditLogEvent.ChannelCreate, ch.id);
    const kind = CHANNEL_TYPES[ch.type] || 'channel';
    const embed = withExecutor(new EmbedBuilder().setColor(COLORS.create).setDescription(`➕ **${kind} created:** ${ch}${ch.parent ? ` in **${ch.parent.name}**` : ''}`), found);
    await sendLog(ch.guild, 'channels', embed, { entry: channelEntry(ch, `created ${kind} #${ch.name}`, { kind: 'create', type: kind, ...execDetails(found) }) });
  });
  on('channelDelete', async (ch) => {
    if (!ch.guild) return;
    const found = await findExecutor(ch.guild, AuditLogEvent.ChannelDelete, ch.id);
    const kind = CHANNEL_TYPES[ch.type] || 'channel';
    const embed = withExecutor(new EmbedBuilder().setColor(COLORS.delete).setDescription(`➖ **${kind} deleted:** #${escapeMarkdown(ch.name)}`), found);
    await sendLog(ch.guild, 'channels', embed, { entry: channelEntry(ch, `deleted ${kind} #${ch.name}`, { kind: 'delete', type: kind, ...execDetails(found) }) });
  });
  on('channelUpdate', async (before, after) => {
    if (!after.guild || before.partial) return;
    const lines = diffLines(before, after, [
      ['name', 'Name'],
      ['topic', 'Topic'],
      ['nsfw', 'Age-restricted', yesNo],
      ['rateLimitPerUser', 'Slowmode', (v) => (v ? `${v}s` : 'off')],
      ['bitrate', 'Bitrate', (v) => (v ? `${Math.round(v / 1000)}kbps` : '*none*')],
      ['userLimit', 'User limit', (v) => (v ? String(v) : 'none')],
      ['parentId', 'Category', (v) => (v ? `<#${v}>` : 'none')]
    ]);
    const oldOw = before.permissionOverwrites?.cache;
    const newOw = after.permissionOverwrites?.cache;
    if (oldOw && newOw) {
      const changed = [...new Set([...oldOw.keys(), ...newOw.keys()])].filter((id) => {
        const a = oldOw.get(id);
        const b = newOw.get(id);
        return !a || !b || a.allow.bitfield !== b.allow.bitfield || a.deny.bitfield !== b.deny.bitfield;
      });
      if (changed.length) {
        const who = changed.map((id) => (id === after.guild.id ? '@everyone' : after.guild.roles.cache.has(id) ? `<@&${id}>` : `<@${id}>`));
        lines.push(`**Permissions changed for:** ${clip(who.join(' '), 600)}`);
      }
    }
    if (!lines.length) return;
    const found = await findExecutor(after.guild, AuditLogEvent.ChannelUpdate, after.id);
    const embed = withExecutor(new EmbedBuilder().setColor(COLORS.update).setDescription(`🛠️ **Channel updated:** ${after}\n${lines.join('\n')}`.slice(0, 4000)), found);
    await sendLog(after.guild, 'channels', embed, {
      entry: channelEntry(after, `updated #${after.name}: ${lines.map((l) => l.replace(/\*\*/g, '')).join('; ')}`.slice(0, 300), { kind: 'update', changes: lines, ...execDetails(found) })
    });
  });

  // ---- Server roles
  on('roleCreate', async (role) => {
    const found = await findExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
    const embed = withExecutor(new EmbedBuilder().setColor(COLORS.create).setDescription(`➕ **Role created:** ${role}`), found);
    await sendLog(role.guild, 'serverRoles', embed, { entry: { summary: `created role @${role.name}`, details: { kind: 'create', role: role.name, ...execDetails(found) } } });
  });
  on('roleDelete', async (role) => {
    const found = await findExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    const embed = withExecutor(new EmbedBuilder().setColor(COLORS.delete).setDescription(`➖ **Role deleted:** @${escapeMarkdown(role.name)}`), found);
    await sendLog(role.guild, 'serverRoles', embed, { entry: { summary: `deleted role @${role.name}`, details: { kind: 'delete', role: role.name, ...execDetails(found) } } });
  });
  on('roleUpdate', async (before, after) => {
    const lines = diffLines(before, after, [
      ['name', 'Name'],
      ['color', 'Color', colorHex],
      ['hoist', 'Shown separately', yesNo],
      ['mentionable', 'Mentionable', yesNo],
      ['icon', 'Icon', (v) => (v ? 'set' : 'none')],
      ['unicodeEmoji', 'Emoji']
    ]);
    const perms = permDiff(before.permissions?.bitfield, after.permissions?.bitfield);
    if (perms.added.length) lines.push(`**Permissions added:** ${perms.added.join(', ')}`);
    if (perms.removed.length) lines.push(`**Permissions removed:** ${perms.removed.join(', ')}`);
    if (!lines.length) return; // position shuffles fire this constantly — not worth logging
    const found = await findExecutor(after.guild, AuditLogEvent.RoleUpdate, after.id);
    const embed = withExecutor(new EmbedBuilder().setColor(after.color || COLORS.update).setDescription(`🎨 **Role updated:** ${after}\n${lines.join('\n')}`.slice(0, 4000)), found);
    await sendLog(after.guild, 'serverRoles', embed, {
      entry: { summary: `updated role @${after.name}: ${lines.map((l) => l.replace(/\*\*/g, '')).join('; ')}`.slice(0, 300), details: { kind: 'update', role: after.name, changes: lines, ...execDetails(found) } }
    });
  });

  // ---- Threads
  on('threadCreate', async (thread, newlyCreated) => {
    if (!newlyCreated || !thread.guild) return;
    const owner = thread.ownerId ? `<@${thread.ownerId}>` : 'someone';
    await sendLog(thread.guild, 'threads', new EmbedBuilder().setColor(COLORS.create).setDescription(`🧵 **Thread created:** ${thread} in <#${thread.parentId}> by ${owner}`), {
      entry: { userId: thread.ownerId || null, channelId: thread.id, channelName: thread.name, summary: `created thread #${thread.name}`, details: { kind: 'create', parentId: thread.parentId } }
    });
  });
  on('threadDelete', async (thread) => {
    if (!thread.guild) return;
    const found = await findExecutor(thread.guild, AuditLogEvent.ThreadDelete, thread.id);
    await sendLog(thread.guild, 'threads', withExecutor(new EmbedBuilder().setColor(COLORS.delete).setDescription(`🧵 **Thread deleted:** #${escapeMarkdown(thread.name)} in <#${thread.parentId}>`), found), {
      entry: { channelId: thread.id, channelName: thread.name, summary: `deleted thread #${thread.name}`, details: { kind: 'delete', ...execDetails(found) } }
    });
  });
  on('threadUpdate', async (before, after) => {
    if (!after.guild) return;
    const lines = diffLines(before, after, [
      ['name', 'Name'],
      ['archived', 'Archived', yesNo],
      ['locked', 'Locked', yesNo]
    ]);
    if (!lines.length) return;
    await sendLog(after.guild, 'threads', new EmbedBuilder().setColor(COLORS.update).setDescription(`🧵 **Thread updated:** ${after}\n${lines.join('\n')}`), {
      entry: { channelId: after.id, channelName: after.name, summary: `updated thread #${after.name}: ${lines.map((l) => l.replace(/\*\*/g, '')).join('; ')}`.slice(0, 300), details: { kind: 'update', changes: lines } }
    });
  });

  // ---- Invites
  on('inviteCreate', async (invite) => {
    if (!invite.guild) return;
    const guild = client.guilds.cache.get(invite.guild.id);
    if (!guild) return;
    const limits = [invite.maxUses ? `${invite.maxUses} uses` : 'unlimited uses', invite.maxAge ? `expires ${ts(Date.now() + invite.maxAge * 1000)}` : 'never expires', invite.temporary ? 'temporary membership' : null].filter(Boolean);
    await sendLog(guild, 'invites', new EmbedBuilder().setColor(COLORS.create).setDescription(`📨 **Invite created:** discord.gg/${invite.code} → ${invite.channel || 'a channel'}${invite.inviter ? ` by ${invite.inviter}` : ''}\n${limits.join(' · ')}`), {
      entry: { userId: invite.inviter?.id || null, userTag: tagOf(invite.inviter) || '', channelId: invite.channelId || null, summary: `created invite ${invite.code}`, details: { kind: 'create', code: invite.code, maxUses: invite.maxUses, maxAge: invite.maxAge } }
    });
  });
  on('inviteDelete', async (invite) => {
    const guild = invite.guild && client.guilds.cache.get(invite.guild.id);
    if (!guild) return;
    await sendLog(guild, 'invites', new EmbedBuilder().setColor(COLORS.delete).setDescription(`📨 **Invite deleted or expired:** discord.gg/${invite.code}`), {
      entry: { channelId: invite.channelId || null, summary: `invite ${invite.code} deleted or expired`, details: { kind: 'delete', code: invite.code } }
    });
  });

  // ---- Emoji & stickers
  const emojiLog = (verb, color, kind) => async (item, after) => {
    const guild = item.guild;
    if (!guild) return;
    const isSticker = !!item.format || item.constructor?.name === 'Sticker';
    const what = isSticker ? 'Sticker' : 'Emoji';
    const auditType = {
      created: isSticker ? AuditLogEvent.StickerCreate : AuditLogEvent.EmojiCreate,
      deleted: isSticker ? AuditLogEvent.StickerDelete : AuditLogEvent.EmojiDelete,
      renamed: isSticker ? AuditLogEvent.StickerUpdate : AuditLogEvent.EmojiUpdate
    }[verb];
    if (verb === 'renamed' && item.name === after?.name) return;
    const found = await findExecutor(guild, auditType, item.id);
    const label = verb === 'renamed' ? `:${item.name}: → :${after.name}:` : `:${item.name}:`;
    const embed = withExecutor(new EmbedBuilder().setColor(color).setDescription(`${isSticker ? '🏷️' : '😀'} **${what} ${verb}:** ${label}`), found);
    const url = isSticker ? item.url : item.imageURL?.({ size: 64 });
    if (url && verb !== 'deleted') embed.setThumbnail(url);
    await sendLog(guild, 'emojis', embed, { entry: { summary: `${what.toLowerCase()} ${verb}: ${label}`, details: { kind, sticker: isSticker, ...execDetails(found) } } });
  };
  on('emojiCreate', emojiLog('created', COLORS.create, 'create'));
  on('emojiDelete', emojiLog('deleted', COLORS.delete, 'delete'));
  on('emojiUpdate', emojiLog('renamed', COLORS.update, 'update'));
  on('stickerCreate', emojiLog('created', COLORS.create, 'create'));
  on('stickerDelete', emojiLog('deleted', COLORS.delete, 'delete'));
  on('stickerUpdate', emojiLog('renamed', COLORS.update, 'update'));

  // ---- Server settings
  on('guildUpdate', async (before, after) => {
    const lines = diffLines(before, after, [
      ['name', 'Name'],
      ['icon', 'Icon', (v) => (v ? 'set' : 'none')],
      ['banner', 'Banner', (v) => (v ? 'set' : 'none')],
      ['description', 'Description'],
      ['verificationLevel', 'Verification level'],
      ['explicitContentFilter', 'Explicit content filter'],
      ['defaultMessageNotifications', 'Default notifications'],
      ['afkChannelId', 'AFK channel', (v) => (v ? `<#${v}>` : 'none')],
      ['afkTimeout', 'AFK timeout', (v) => `${Math.round((v || 0) / 60)} min`],
      ['systemChannelId', 'System channel', (v) => (v ? `<#${v}>` : 'none')],
      ['rulesChannelId', 'Rules channel', (v) => (v ? `<#${v}>` : 'none')],
      ['vanityURLCode', 'Vanity URL'],
      ['ownerId', 'Owner', (v) => (v ? `<@${v}>` : 'none')],
      ['premiumTier', 'Boost level']
    ]);
    if (!lines.length) return;
    const found = await findExecutor(after, AuditLogEvent.GuildUpdate, after.id);
    const embed = withExecutor(new EmbedBuilder().setColor(COLORS.update).setDescription(`⚙️ **Server settings changed**\n${lines.join('\n')}`.slice(0, 4000)), found);
    await sendLog(after, 'server', embed, { entry: { summary: `server settings: ${lines.map((l) => l.replace(/\*\*/g, '')).join('; ')}`.slice(0, 300), details: { changes: lines, ...execDetails(found) } } });
  });
}

/** Logs a slash command use (called from interactionCreate). */
async function logCommand(interaction) {
  if (!interaction.guild) return;
  const text = interaction.toString?.() || `/${interaction.commandName}`;
  const user = interaction.user;
  await sendLog(
    interaction.guild,
    'commands',
    new EmbedBuilder()
      .setColor('#4E5058')
      .setAuthor({ name: `${tagOf(user)} (${user.id})`, iconURL: user.displayAvatarURL?.({ size: 64 }) || undefined })
      .setDescription(`⌨️ Used \`${clip(text, 900).replace(/`/g, 'ˋ')}\` in ${interaction.channel || 'a channel'}`),
    {
      entry: {
        userId: user.id,
        userTag: tagOf(user),
        userAvatar: user.displayAvatarURL?.({ size: 64 }) || '',
        channelId: interaction.channelId,
        channelName: interaction.channel?.name || '',
        summary: `used ${clip(text, 200)}`,
        details: { command: interaction.commandName }
      }
    }
  );
}

module.exports = { registerServerLogEvents, logCommand, findExecutor, diffLines, permDiff };
