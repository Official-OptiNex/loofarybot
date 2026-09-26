const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const data = new SlashCommandBuilder().setName('serverinfo').setDescription("Show this server's stats and details");

async function execute(interaction) {
  const guild = interaction.guild;
  await guild.fetch(); // ensure boost/verification data is fresh, not just gateway cache

  const owner = await guild.fetchOwner().catch(() => null);
  const channelCount = guild.channels.cache.size;
  const roleCount = guild.roles.cache.size;
  const emojiCount = guild.emojis.cache.size;
  const boostTier = guild.premiumTier === 'NONE' ? 0 : guild.premiumTier;

  const embed = new EmbedBuilder()
    .setTitle(guild.name)
    .setThumbnail(guild.iconURL({ size: 256 }))
    .setColor('#5865F2')
    .addFields(
      { name: 'Owner', value: owner ? `${owner.user.tag}` : 'Unknown', inline: true },
      { name: 'Members', value: `${guild.memberCount}`, inline: true },
      { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
      { name: 'Channels', value: `${channelCount}`, inline: true },
      { name: 'Roles', value: `${roleCount}`, inline: true },
      { name: 'Emojis', value: `${emojiCount}`, inline: true },
      { name: 'Boost Level', value: `Tier ${boostTier} (${guild.premiumSubscriptionCount || 0} boosts)`, inline: true },
      { name: 'Verification Level', value: `${guild.verificationLevel}`, inline: true },
      { name: 'Server ID', value: guild.id, inline: true }
    )
    .setFooter({ text: `Requested by ${interaction.user.username}` })
    .setTimestamp();

  if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 512 }));

  return interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
