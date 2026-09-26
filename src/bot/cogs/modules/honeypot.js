const { EmbedBuilder } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const { getOrCreateConfig } = require('./leveling'); // shares the same helper/model

const DEFAULT_TRAP_EMBED = {
  title: '🍯 Honeypot Trap',
  description:
    "**Do not send any messages in this channel.** It exists only to catch bots and raiders — " +
    'sending a message here triggers an automatic, instant enforcement action.',
  color: '#ED4245',
  footer: 'LoofaryBot Honeypot System'
};

function isHttpUrl(str) {
  try {
    return ['http:', 'https:'].includes(new URL(str).protocol);
  } catch {
    return false;
  }
}

// Builds the trap message from the guild's custom look (falling back to the defaults per field),
// so admins can disguise the channel as e.g. a fake "verify here" or announcements channel.
function buildCounterEmbed(config) {
  const custom = (config.honeypotEmbed && (config.honeypotEmbed.toObject ? config.honeypotEmbed.toObject() : config.honeypotEmbed)) || {};
  const embed = new EmbedBuilder()
    .setTitle((custom.title || DEFAULT_TRAP_EMBED.title).slice(0, 256))
    .setDescription((custom.description || DEFAULT_TRAP_EMBED.description).slice(0, 4096))
    .setColor(/^#[0-9A-F]{6}$/i.test(custom.color || '') ? custom.color : DEFAULT_TRAP_EMBED.color);

  const footer = custom.footer || DEFAULT_TRAP_EMBED.footer;
  if (footer) embed.setFooter({ text: footer.slice(0, 2048) });
  if (custom.imageUrl && isHttpUrl(custom.imageUrl)) embed.setImage(custom.imageUrl);
  if (custom.thumbnailUrl && isHttpUrl(custom.thumbnailUrl)) embed.setThumbnail(custom.thumbnailUrl);

  if (custom.showCounts !== false) {
    embed
      .addFields(
        { name: 'Kicks', value: `${config.honeypotKicks || 0}`, inline: true },
        { name: 'Soft Bans', value: `${config.honeypotSoftbans || 0}`, inline: true },
        { name: 'Bans', value: `${config.honeypotBans || 0}`, inline: true }
      )
      .setTimestamp();
  }
  return embed;
}

/**
 * Posts (or reposts) the live counter embed in the configured honeypot channel
 * and stores its message ID so future enforcements can edit it in place.
 */
async function setupHoneypotChannel(client, guildId, channelId) {
  const config = await getOrCreateConfig(guildId);
  config.honeypotChannelId = channelId;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new Error('Could not access that channel.');

  const msg = await channel.send({ embeds: [buildCounterEmbed(config)] });
  config.honeypotCounterMessageId = msg.id;
  await config.save();
  return config;
}

async function refreshCounterEmbed(client, config) {
  if (!config.honeypotChannelId || !config.honeypotCounterMessageId) return;
  const channel = await client.channels.fetch(config.honeypotChannelId).catch(() => null);
  if (!channel) return;
  const msg = await channel.messages.fetch(config.honeypotCounterMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [buildCounterEmbed(config)] }).catch(() => null);
}

/**
 * Called from messageCreate. If the message was sent in a guild's honeypot channel,
 * deletes it and applies the configured enforcement action against the author.
 */
async function handleHoneypotMessage(message) {
  if (message.author.bot || !message.guild) return;

  const config = await GuildConfig.findOne({ guildId: message.guild.id });
  if (!config || !config.honeypotChannelId) return;
  if (message.channel.id !== config.honeypotChannelId) return;

  await message.delete().catch(() => null);

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  try {
    switch (config.honeypotAction) {
      case 'ban':
        await member.ban({ reason: 'Triggered honeypot channel trap.' });
        config.honeypotBans += 1;
        break;
      case 'softban':
        await member.ban({ reason: 'Honeypot trap — soft ban (message purge).', deleteMessageSeconds: 86400 });
        await message.guild.bans.remove(member.id, 'Honeypot soft ban — unbanning to lift restriction.');
        config.honeypotSoftbans += 1;
        break;
      case 'kick':
      default:
        await member.kick('Triggered honeypot channel trap.');
        config.honeypotKicks += 1;
        break;
    }
  } catch (err) {
    console.error(`Honeypot enforcement failed for ${member.id}:`, err.message);
    return; // don't increment counters or save if enforcement failed
  }

  await config.save();
  await refreshCounterEmbed(message.client, config);
}

module.exports = {
  DEFAULT_TRAP_EMBED,
  isHttpUrl,
  buildCounterEmbed,
  setupHoneypotChannel,
  refreshCounterEmbed,
  handleHoneypotMessage
};
