// Shared bits for the public pages (home, server picker, error): invite link, header data, stats.
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { CLIENT_ID } = require('../../config');
const commandReference = require('../../bot/commandReference');

// Everything the bot's modules use — no Administrator, so server owners can see exactly what it gets.
const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ViewAuditLog
]).bitfield.toString();

function inviteUrl(guildId = null) {
  const params = new URLSearchParams({ client_id: CLIENT_ID, permissions: INVITE_PERMISSIONS, scope: 'bot applications.commands' });
  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function avatarUrl(user) {
  if (!user) return null;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  const index = user.discriminator && user.discriminator !== '0' ? Number(user.discriminator) % 5 : Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// Header data every public page needs.
function siteLocals(req) {
  const client = req.app.locals.discordClient;
  const user = req.session?.user || null;
  return {
    user: user ? { id: user.id, name: user.global_name || user.username, avatarUrl: avatarUrl(user) } : null,
    inviteUrl: inviteUrl(),
    botName: client.user?.username || 'LoofaryBot',
    botAvatar: client.user?.displayAvatarURL({ size: 128 }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
  };
}

function botStats(client) {
  const guilds = [...client.guilds.cache.values()];
  return {
    servers: guilds.length,
    members: guilds.reduce((n, g) => n + (g.memberCount || 0), 0),
    commands: commandReference.reduce((n, g) => n + g.commands.length, 0),
    modules: commandReference.length
  };
}

// Commands anyone can use, grouped like the dashboard — shown on the home page without logging in.
function publicCommands() {
  return commandReference
    .map((g) => ({ ...g, commands: g.commands.filter((c) => !c.perm) }))
    .filter((g) => g.commands.length > 0);
}

module.exports = { inviteUrl, avatarUrl, siteLocals, botStats, publicCommands, INVITE_PERMISSIONS };
