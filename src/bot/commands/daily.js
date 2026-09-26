const { SlashCommandBuilder } = require('discord.js');
const { claimDaily, buildDailyEmbed } = require('../cogs/modules/daily');

const data = new SlashCommandBuilder().setName('daily').setDescription('Claim your daily XP — keep the streak going for bigger rewards');

async function execute(interaction) {
  const outcome = await claimDaily(interaction.guild, interaction.user.id);
  if (outcome.error) return interaction.reply({ content: `❌ ${outcome.error}`, ephemeral: true });
  return interaction.reply({ embeds: [buildDailyEmbed(interaction.user, outcome)], ephemeral: !!outcome.alreadyClaimed });
}

module.exports = { data, execute };
