const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const AlertSubscription = require('../../database/models/AlertSubscription');
const { upsertSubscription, sendTest } = require('../cogs/modules/socialAlerts');

const platformOption = (opt) =>
  opt.setName('platform').setDescription('Twitch or YouTube').setRequired(true).addChoices({ name: 'Twitch', value: 'twitch' }, { name: 'YouTube', value: 'youtube' });

const data = new SlashCommandBuilder()
  .setName('alerts')
  .setDescription('Go-live (Twitch) and new upload (YouTube) alerts')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Follow a Twitch or YouTube channel')
      .addStringOption(platformOption)
      .addStringOption((opt) => opt.setName('account').setDescription('Any twitch.tv link or username, or a YouTube @handle / channel link').setRequired(true))
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Where to post alerts').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)
      )
      .addRoleOption((opt) => opt.setName('ping_role').setDescription('Role to ping (pick @everyone to ping everyone)'))
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show every followed channel'))
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Stop following a channel')
      .addStringOption((opt) => opt.setName('account').setDescription('Name as shown in /alerts list').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('test')
      .setDescription('Post a sample alert (no one is pinged)')
      .addStringOption((opt) => opt.setName('account').setDescription('Name as shown in /alerts list').setRequired(true))
  );

async function findSub(interaction) {
  const q = interaction.options.getString('account').trim().toLowerCase().replace(/^@/, '');
  const subs = await AlertSubscription.find({ guildId: interaction.guildId });
  return subs.find((s) => s.account.toLowerCase() === q || s.displayName.toLowerCase() === q);
}

async function execute(interaction, client) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const platform = interaction.options.getString('platform');
    await interaction.deferReply({ ephemeral: true });
    try {
      const role = interaction.options.getRole('ping_role');
      const created = await upsertSubscription(interaction.guild, {
        platform,
        account: interaction.options.getString('account'),
        channelId: interaction.options.getChannel('channel').id,
        pingRoleId: role ? role.id : null
      });
      return interaction.editReply(
        `✅ Following **${created.displayName}** on ${platform === 'twitch' ? 'Twitch' : 'YouTube'} → <#${created.channelId}>.` +
          '\nCustomize the message and embed on the dashboard (Alerts page), or try `/alerts test`.'
      );
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }
  }

  if (sub === 'list') {
    const subs = await AlertSubscription.find({ guildId: interaction.guildId }).lean();
    if (!subs.length) return interaction.reply({ content: 'Not following anyone yet — use `/alerts add`.', ephemeral: true });
    const lines = subs.map(
      (s) =>
        `${s.platform === 'twitch' ? '🟣' : '🔴'} **${s.displayName}** → <#${s.channelId}>${s.pingRoleId ? ` · pings <@&${s.pingRoleId}>` : ''}${s.enabled ? '' : ' · ⏸️ paused'}${s.state?.live ? ' · 🔴 live now' : ''}`
    );
    return interaction.reply({ content: lines.join('\n'), ephemeral: true, allowedMentions: { parse: [] } });
  }

  const target = await findSub(interaction);
  if (!target) return interaction.reply({ content: '❌ No followed channel with that name — check `/alerts list`.', ephemeral: true });

  if (sub === 'remove') {
    await target.deleteOne();
    return interaction.reply({ content: `✅ Stopped following **${target.displayName}**.`, ephemeral: true });
  }
  if (sub === 'test') {
    try {
      await sendTest(client, target);
      return interaction.reply({ content: `✅ Test alert posted in <#${target.channelId}>.`, ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }
}

module.exports = { data, execute };
