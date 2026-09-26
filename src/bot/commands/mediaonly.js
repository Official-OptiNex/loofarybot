const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const GuildConfig = require('../../database/models/GuildConfig');
const { setMediaOnly, removeMediaOnly, describeRule, missingPermissions } = require('../cogs/modules/mediaOnly');

const data = new SlashCommandBuilder()
  .setName('mediaonly')
  .setDescription('Make channels media-only: posts without an image, video, file (or link) are removed')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Make a channel media-only (or change its settings)')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel (defaults to this one)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addBooleanOption((opt) => opt.setName('allow_links').setDescription('Count links (YouTube, GIFs, image URLs) as media — default: yes'))
      .addBooleanOption((opt) => opt.setName('auto_thread').setDescription('Open a comment thread on every post — default: no'))
      .addBooleanOption((opt) => opt.setName('staff_bypass').setDescription('Let Manage Messages members post anything — default: yes'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Turn media-only off for a channel')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel (defaults to this one)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show every media-only channel'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
    const rules = (config?.mediaOnlyChannels || []).filter((r) => interaction.guild.channels.cache.has(r.channelId));
    if (!rules.length) return interaction.reply({ content: 'No media-only channels yet. Add one with `/mediaonly add`.', ephemeral: true });
    return interaction.reply({ content: `📸 **Media-only channels**\n${rules.map((r) => `• <#${r.channelId}> — ${describeRule(r)}`).join('\n')}`, ephemeral: true });
  }

  const channel = interaction.options.getChannel('channel') || interaction.channel;
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    return interaction.reply({ content: '❌ Pick a text or announcement channel.', ephemeral: true });
  }

  if (sub === 'remove') {
    const removed = await removeMediaOnly(interaction.guildId, channel.id);
    return interaction.reply({ content: removed ? `✅ ${channel} is no longer media-only.` : `ℹ️ ${channel} wasn't media-only.`, ephemeral: true });
  }

  const { rule, updated } = await setMediaOnly(interaction.guildId, channel.id, {
    allowLinks: interaction.options.getBoolean('allow_links') ?? undefined,
    autoThread: interaction.options.getBoolean('auto_thread') ?? undefined,
    staffBypass: interaction.options.getBoolean('staff_bypass') ?? undefined
  });
  const missing = missingPermissions(channel, rule);
  return interaction.reply({
    content:
      `📸 ${channel} is ${updated ? 'still' : 'now'} media-only — ${describeRule(rule)}.` +
      (missing.length ? `\n⚠️ LoofaryBot is missing **${missing.join(', ')}** there, so it can't enforce this yet.` : ''),
    ephemeral: true
  });
}

module.exports = { data, execute };
