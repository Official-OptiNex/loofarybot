const { EmbedBuilder } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const { getOrCreateConfig } = require('./leveling'); // shares the same helper/model

function buildCounterEmbed(config) {
  return new EmbedBuilder()
    .setTitle('🍯 Honeypot Trap')
    .setDescription(
      "**Do not send any messages in this channel.** It exists only to catch bots and raiders — " +
        'sending a message here triggers an automatic, instant enforcement action.'
    )
    .addFields(
      { name: 'Kicks', value: `${config.honeypotKicks}`, inline: true },
      { name: 'Soft Bans', value: `${config.honeypotSoftbans}`, inline: true },
      { name: 'Bans', value: `${config.honeypotBans}`, inline: true }
    )
    .setColor('#ED4245')
    .setFooter({ text: 'LoofaryBot Honeypot System' })
    .setTimestamp();
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
  buildCounterEmbed,
  setupHoneypotChannel,
  refreshCounterEmbed,
  handleHoneypotMessage
};
