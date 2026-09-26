const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const GuildConfig = require('../../database/models/GuildConfig');
const { setupHoneypotChannel, refreshCounterEmbed } = require('../cogs/modules/honeypot');
const { getOrCreateConfig } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('honeypot')
  .setDescription('Configure the honeypot anti-raid trap')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Designate a channel as the honeypot trap and post the live counter')
      .addChannelOption((opt) => opt.setName('channel').setDescription('Trap channel').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('action')
      .setDescription('Set the enforcement action for anyone who posts in the trap')
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Action to take')
          .setRequired(true)
          .addChoices(
            { name: 'Kick', value: 'kick' },
            { name: 'Soft Ban (ban + unban, purges messages)', value: 'softban' },
            { name: 'Permanent Ban', value: 'ban' }
          )
      )
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Show current honeypot configuration and counts'));

async function execute(interaction, client) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'setup') {
    const channel = interaction.options.getChannel('channel');
    try {
      await setupHoneypotChannel(client, interaction.guildId, channel.id);
      return interaction.reply({ content: `✅ Honeypot trap set up in ${channel}.`, ephemeral: true });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }

  if (sub === 'action') {
    const type = interaction.options.getString('type');
    const config = await getOrCreateConfig(interaction.guildId);
    config.honeypotAction = type;
    await config.save();
    return interaction.reply({ content: `✅ Honeypot enforcement action set to **${type}**.`, ephemeral: true });
  }

  if (sub === 'status') {
    const config = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!config || !config.honeypotChannelId) {
      return interaction.reply({ content: 'Honeypot has not been set up yet. Use `/honeypot setup`.', ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle('Honeypot Status')
      .setColor('#ED4245')
      .addFields(
        { name: 'Channel', value: `<#${config.honeypotChannelId}>`, inline: true },
        { name: 'Action', value: config.honeypotAction, inline: true },
        { name: 'Kicks', value: `${config.honeypotKicks}`, inline: true },
        { name: 'Soft Bans', value: `${config.honeypotSoftbans}`, inline: true },
        { name: 'Bans', value: `${config.honeypotBans}`, inline: true }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

module.exports = { data, execute };
