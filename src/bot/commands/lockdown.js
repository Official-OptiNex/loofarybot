const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { lockdown } = require('../cogs/modules/lockdown');

const data = new SlashCommandBuilder()
  .setName('lockdown')
  .setDescription('Stop non-staff from sending messages in a channel or the whole server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption((opt) =>
    opt
      .setName('scope')
      .setDescription('Lock one channel or every channel')
      .setRequired(true)
      .addChoices({ name: 'This / one channel', value: 'channel' }, { name: 'Entire server', value: 'server' })
  )
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to lock (defaults to the current one)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice)
  )
  .addStringOption((opt) => opt.setName('reason').setDescription('Shown in the channel and the audit log').setMaxLength(300));

async function execute(interaction) {
  const me = interaction.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) && !me?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ LoofaryBot needs the **Manage Roles** permission to edit channel permissions.', ephemeral: true });
  }

  const scope = interaction.options.getString('scope');
  const reason = interaction.options.getString('reason') || 'Raid protection';
  const channel = scope === 'channel' ? interaction.options.getChannel('channel') || interaction.channel : null;

  // Server-wide lockdown edits every channel, which can take a while on big servers.
  await interaction.deferReply({ ephemeral: true });
  const { locked, failed } = await lockdown(interaction.guild, { channel, reason, actor: interaction.user });

  let content = channel
    ? locked.length
      ? `🔒 Locked ${channel}.`
      : `❌ Couldn't lock ${channel} — check LoofaryBot's permissions there.`
    : `🔒 Server locked down: **${locked.length}** channel(s) locked.`;
  if (!channel && failed.length) content += `\n⚠️ Failed on ${failed.length} channel(s): ${failed.slice(0, 10).map((c) => `${c}`).join(', ')}`;
  content += '\nStaff (Administrator / Manage Messages roles) can still talk. Undo with `/unlockdown`.';
  return interaction.editReply({ content });
}

module.exports = { data, execute };
