const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { LOG_EVENTS } = require('../cogs/modules/logging');

const data = new SlashCommandBuilder()
  .setName('logs')
  .setDescription('Server event logging')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Choose the channel that receives server logs')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('toggle')
      .setDescription('Turn a single log type on or off')
      .addStringOption((opt) =>
        opt
          .setName('event')
          .setDescription('Which log type')
          .setRequired(true)
          .addChoices(...Object.entries(LOG_EVENTS).map(([value, name]) => ({ name, value })))
      )
      .addBooleanOption((opt) => opt.setName('enabled').setDescription('Log this event?').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('enable').setDescription('Turn the logging module back on'))
  .addSubcommand((sub) => sub.setName('disable').setDescription('Turn the logging module off (nothing is logged or stored)'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Show the current logging setup'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const config = await getOrCreateConfig(interaction.guildId);

  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel');
    const me = interaction.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return interaction.reply({ content: `❌ LoofaryBot needs View Channel, Send Messages and Embed Links in ${channel}.`, ephemeral: true });
    }
    config.logChannelId = channel.id;
    config.logsEnabled = true;
    await config.save();
    return interaction.reply({ content: `✅ Server logs will now be sent to ${channel}. Use \`/logs toggle\` to pick which events.`, ephemeral: true });
  }

  if (sub === 'toggle') {
    const event = interaction.options.getString('event');
    const enabled = interaction.options.getBoolean('enabled');
    config.set(`logEvents.${event}`, enabled);
    await config.save();
    return interaction.reply({ content: `✅ ${LOG_EVENTS[event]} logging **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  if (sub === 'enable' || sub === 'disable') {
    config.logsEnabled = sub === 'enable';
    await config.save();
    return interaction.reply({
      content: sub === 'enable'
        ? `✅ Logging enabled.${config.logChannelId ? '' : ' Pick a channel with `/logs set` to also get logs in Discord (they always show on the dashboard).'}`
        : '✅ Logging disabled — nothing will be logged or stored until you run `/logs enable`.',
      ephemeral: true
    });
  }

  if (sub === 'status') {
    const embed = new EmbedBuilder()
      .setTitle('📋 Logging')
      .setColor('#5865F2')
      .addFields(
        { name: 'Module', value: config.logsEnabled === false ? '❌ Disabled' : '✅ Enabled', inline: true },
        { name: 'Channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Not set — dashboard only', inline: true },
        {
          name: 'Events',
          value: Object.entries(LOG_EVENTS)
            .map(([key, label]) => `${config.logEvents?.[key] === false ? '❌' : '✅'} ${label}`)
            .join('\n')
        }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

module.exports = { data, execute };
