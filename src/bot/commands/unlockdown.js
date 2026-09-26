const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { unlockdown } = require('../cogs/modules/lockdown');

const data = new SlashCommandBuilder()
  .setName('unlockdown')
  .setDescription('Lift a lockdown, restoring the original channel permissions')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption((opt) =>
    opt
      .setName('scope')
      .setDescription('Unlock one channel or everything that was locked')
      .setRequired(true)
      .addChoices({ name: 'This / one channel', value: 'channel' }, { name: 'Entire server', value: 'server' })
  )
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to unlock (defaults to the current one)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice)
  );

async function execute(interaction) {
  const scope = interaction.options.getString('scope');
  const channel = scope === 'channel' ? interaction.options.getChannel('channel') || interaction.channel : null;

  await interaction.deferReply({ ephemeral: true });
  const { unlocked } = await unlockdown(interaction.guild, { channel, actor: interaction.user });

  const content = channel
    ? unlocked.length
      ? `🔓 Unlocked ${channel}.`
      : `ℹ️ ${channel} wasn't locked by LoofaryBot.`
    : unlocked.length
      ? `🔓 Lockdown lifted: **${unlocked.length}** channel(s) restored.`
      : 'ℹ️ Nothing is currently locked.';
  return interaction.editReply({ content });
}

module.exports = { data, execute };
