const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const WelcomeConfig = require('../../../database/models/WelcomeConfig');

const PLACEHOLDERS = {
  '{user}': (m) => `<@${m.id}>`,
  '{username}': (m) => m.user.username,
  '{server}': (m) => m.guild.name,
  '{membercount}': (m) => `${m.guild.memberCount}`
};

function applyPlaceholders(text, member) {
  if (!text) return '';
  return text.replace(/\{(user|username|server|membercount)\}/gi, (token) => PLACEHOLDERS[token.toLowerCase()](member));
}

const isHttpUrl = (s) => {
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
};

function buildWelcomePayload(config, member) {
  const payload = { allowedMentions: { users: [member.id] } }; // only ever ping the new member
  const content = applyPlaceholders(config.messageContent, member).slice(0, 2000);
  if (content) payload.content = content;

  if (config.embedEnabled) {
    const e = config.embedConfig || {};
    const embed = new EmbedBuilder();
    const title = applyPlaceholders(e.title, member);
    const description = applyPlaceholders(e.description, member);
    const footer = applyPlaceholders(e.footer, member);
    if (title) embed.setTitle(title.slice(0, 256));
    if (description) embed.setDescription(description.slice(0, 4096));
    if (footer) embed.setFooter({ text: footer.slice(0, 2048) });
    if (/^#[0-9A-F]{6}$/i.test(e.color || '')) embed.setColor(e.color);
    if (e.imageUrl && isHttpUrl(e.imageUrl)) embed.setImage(e.imageUrl);
    // "{avatar}" in the thumbnail field shows the new member's avatar.
    if (e.thumbnailUrl === '{avatar}') embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    else if (e.thumbnailUrl && isHttpUrl(e.thumbnailUrl)) embed.setThumbnail(e.thumbnailUrl);
    if (title || description || footer || e.imageUrl || e.thumbnailUrl) payload.embeds = [embed];
  }
  return payload.content || payload.embeds ? payload : null;
}

/**
 * Sends the configured welcome message for `member`. With `force`, sends even when the module is
 * disabled (used by the dashboard's test button). Returns a reason string on failure, else null.
 */
async function sendWelcome(member, { force = false, config = null } = {}) {
  config = config || (await WelcomeConfig.findOne({ guildId: member.guild.id }).lean());
  if (!config || (!config.enabled && !force)) return 'Welcome messages are disabled.';
  if (!config.channelId) return 'No welcome channel is set.';

  const channel = member.guild.channels.cache.get(config.channelId);
  const me = member.guild.members.me;
  if (!channel || !channel.isTextBased()) return 'The welcome channel no longer exists.';
  if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return `LoofaryBot needs View Channel, Send Messages and Embed Links in #${channel.name}.`;
  }

  const payload = buildWelcomePayload(config, member);
  if (!payload) return 'The welcome message is empty.';
  await channel.send(payload);
  return null;
}

module.exports = { PLACEHOLDERS, applyPlaceholders, buildWelcomePayload, sendWelcome };
