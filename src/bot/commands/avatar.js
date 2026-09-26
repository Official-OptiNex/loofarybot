const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('avatar')
  .setDescription("Show a user's full-size avatar")
  .addUserOption((opt) => opt.setName('user').setDescription('User to look up').setRequired(false));

async function execute(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;

  const embed = new EmbedBuilder()
    .setTitle(`${target.username}'s Avatar`)
    .setImage(target.displayAvatarURL({ size: 1024 }))
    .setColor('#5865F2');

  return interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
