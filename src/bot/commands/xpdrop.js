// /xpdrop — random XP drops in chat: set them up, drop one now, or see the status.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const drops = require('../cogs/modules/chatDrops');
const { dashboardUrl } = require('../cogs/modules/help');

const textChannel = (name, description) => (o) =>
  o.setName(name).setDescription(description).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

const data = new SlashCommandBuilder()
  .setName('xpdrop')
  .setDescription('Random XP drops in chat — first to click wins')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Pick where drops appear and how big/often they are (turns them on)')
      .addChannelOption((o) => textChannel('channel', 'A channel drops can appear in')(o).setRequired(true))
      .addChannelOption(textChannel('channel_2', 'Another channel'))
      .addChannelOption(textChannel('channel_3', 'Another channel'))
      .addIntegerOption((o) => o.setName('min_xp').setDescription('Smallest drop (default 50)').setMinValue(1).setMaxValue(100000))
      .addIntegerOption((o) => o.setName('max_xp').setDescription('Biggest drop (default 250)').setMinValue(1).setMaxValue(100000))
      .addIntegerOption((o) => o.setName('min_minutes').setDescription('Shortest time between drops (default 30)').setMinValue(5).setMaxValue(10080))
      .addIntegerOption((o) => o.setName('max_minutes').setDescription('Longest time between drops (default 90)').setMinValue(5).setMaxValue(10080))
      .addIntegerOption((o) =>
        o.setName('min_activity').setDescription('Messages needed in the last 10 minutes before a channel gets a drop (default 3)').setMinValue(0).setMaxValue(100)
      )
      .addIntegerOption((o) => o.setName('claim_seconds').setDescription('How long a drop stays up (default 120)').setMinValue(15).setMaxValue(3600))
  )
  .addSubcommand((s) =>
    s.setName('toggle').setDescription('Turn chat drops on or off').addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) => s.setName('now').setDescription('Drop one right now').addChannelOption(textChannel('channel', 'Where (defaults to here)')))
  .addSubcommand((s) => s.setName('status').setDescription('Settings, the next drop and recent winners'));

const fmt = (n) => Number(n).toLocaleString('en-US');
const ts = (d, style = 'R') => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:${style}>` : '—');

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;

  if (sub === 'setup') {
    const input = {
      enabled: true,
      channelIds: ['channel', 'channel_2', 'channel_3'].map((k) => o.getChannel(k)?.id).filter(Boolean)
    };
    for (const [opt, key] of [['min_xp', 'minXp'], ['max_xp', 'maxXp'], ['min_minutes', 'minMinutes'], ['max_minutes', 'maxMinutes'], ['min_activity', 'minActivity'], ['claim_seconds', 'claimSeconds']]) {
      if (o.getInteger(opt) !== null) input[key] = o.getInteger(opt);
    }
    const saved = await drops.saveSettings(guild, input);
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    const s = saved.settings;
    const config = await getOrCreateConfig(guild.id);
    return interaction.reply({
      content:
        `✅ **Chat drops are on** in ${s.channelIds.map((id) => `<#${id}>`).join(', ')}.\n` +
        `🎁 **${fmt(s.minXp)}–${fmt(s.maxXp)} XP** every **${s.minMinutes}–${s.maxMinutes} min** when a channel has ${s.minActivity}+ messages in the last 10 minutes · claimable for ${s.claimSeconds}s · usually 1 winner, sometimes 2–3.\n` +
        `Next drop: ${ts(s.nextDropAt)} (or as soon as chat is active after that).` +
        (config.levelingEnabled === false ? '\n⚠️ Leveling is turned off, so no drops will happen until it’s back on.' : '') +
        `\n-# Try one now with \`/xpdrop now\`. Dashboard: ${dashboardUrl(guild.id)}`,
      ephemeral: true
    });
  }

  if (sub === 'toggle') {
    const enabled = o.getBoolean('enabled');
    const config = await getOrCreateConfig(guild.id);
    if (enabled && !(config.chatDrops?.channelIds || []).length) {
      return interaction.reply({ content: '❌ Pick a channel first with `/xpdrop setup`.', ephemeral: true });
    }
    const saved = await drops.saveSettings(guild, { enabled });
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    return interaction.reply({ content: enabled ? `✅ Chat drops are **on** — next one ${ts(saved.settings.nextDropAt)}.` : '⏸️ Chat drops are **off**.', ephemeral: true });
  }

  const config = await getOrCreateConfig(guild.id);
  const s = drops.dropSettings(config);

  if (sub === 'now') {
    const channel = o.getChannel('channel') || interaction.channel;
    if (!channel?.isTextBased() || channel.isThread()) return interaction.reply({ content: '❌ Pick a text channel.', ephemeral: true });
    const posted = await drops.postDrop(channel, s, { manual: true });
    if (posted.error) return interaction.reply({ content: `❌ ${posted.error}`, ephemeral: true });
    return interaction.reply({ content: `🎁 Dropped **${fmt(posted.amount)} XP** (${posted.winners} winner${posted.winners === 1 ? '' : 's'}) in ${channel}.`, ephemeral: true });
  }

  // status
  const recent = await drops.recentDrops(guild.id, 5);
  const embed = new EmbedBuilder()
    .setColor(s.enabled ? '#F1C40F' : '#4E5058')
    .setTitle(`🎁 Chat drops — ${s.enabled ? 'on' : 'off'}`)
    .addFields(
      { name: 'Channels', value: s.channelIds.map((id) => `<#${id}>`).join(' ') || 'none yet', inline: true },
      { name: 'Size', value: `${fmt(s.minXp)}–${fmt(s.maxXp)} XP`, inline: true },
      { name: 'Every', value: `${s.minMinutes}–${s.maxMinutes} min`, inline: true },
      { name: 'Needs', value: `${s.minActivity}+ messages in 10 min`, inline: true },
      { name: 'Claim window', value: `${s.claimSeconds}s`, inline: true },
      { name: 'Next drop', value: s.enabled ? ts(s.nextDropAt) : '—', inline: true },
      {
        name: 'Recent drops',
        value:
          recent
            .map((d) => `${ts(d.createdAt)} · **${fmt(d.amount)} XP** in <#${d.channelId}> → ${d.claimedBy.length ? d.claimedBy.map((id) => `<@${id}>`).join(', ') : d.status === 'open' ? '*open*' : '*nobody*'}`)
            .join('\n') || 'None yet.'
      }
    );
  return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

module.exports = { data, execute };
