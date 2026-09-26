const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('userinfo')
  .setDescription("Show a member's account and server details")
  .addUserOption((opt) => opt.setName('user').setDescription('User to look up').setRequired(false));

async function execute(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);

  const embed = new EmbedBuilder()
    .setTitle(target.username)
    .setThumbnail(target.displayAvatarURL({ size: 256 }))
    .setColor(member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : '#5865F2')
    .addFields(
      { name: 'User ID', value: target.id, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true }
    )
    .setFooter({ text: `Requested by ${interaction.user.username}` })
    .setTimestamp();

  if (member) {
    embed.addFields({ name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`, inline: true });

    const roles = member.roles.cache.filter((r) => r.name !== '@everyone');
    embed.addFields({
      name: `Roles (${roles.size})`,
      value: roles.size > 0 ? [...roles.values()].map((r) => `<@&${r.id}>`).join(' ').slice(0, 1024) : 'None'
    });
  } else {
    embed.addFields({ name: 'Note', value: "This user isn't currently a member of this server." });
  }

  return interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
