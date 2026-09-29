// /starboard — the best messages, picked by the server's ⭐ reactions.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const starboard = require('../cogs/modules/starboard');
const { getOrCreateConfig } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('starboard')
  .setDescription('Repost the most-starred messages in a starboard channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Pick the starboard channel (turns it on)')
      .addChannelOption((o) => o.setName('channel').setDescription('Where starred messages are reposted').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addIntegerOption((o) => o.setName('stars').setDescription('Reactions needed (default 3)').setMinValue(1).setMaxValue(100))
      .addStringOption((o) => o.setName('emoji').setDescription('Reaction that counts (default ⭐)').setMaxLength(64))
      .addBooleanOption((o) => o.setName('self_star').setDescription('Count the author starring their own message (default off)'))
  )
  .addSubcommand((s) =>
    s.setName('toggle').setDescription('Turn the starboard on or off').addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('ignore')
      .setDescription("Stop (or start again) starring messages from a channel")
      .addChannelOption((o) => o.setName('channel').setDescription('The channel').setRequired(true))
  )
  .addSubcommand((s) => s.setName('top').setDescription('The most-starred messages'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;

  if (sub === 'setup') {
    const input = { enabled: true, channelId: o.getChannel('channel').id };
    if (o.getInteger('stars') !== null) input.threshold = o.getInteger('stars');
    if (o.getString('emoji') !== null) input.emoji = o.getString('emoji');
    if (o.getBoolean('self_star') !== null) input.selfStar = o.getBoolean('self_star');
    const saved = await starboard.saveSettings(guild, input);
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    const s = saved.settings;
    const missing = starboard.missingPermissions(guild, s);
    return interaction.reply({
      content:
        `✅ **Starboard is on** — messages with **${s.threshold}+** ${s.emoji} go to <#${s.channelId}>.` +
        (missing.length ? `\n⚠️ LoofaryBot needs: ${missing.join(', ')}` : ''),
      ephemeral: true
    });
  }

  if (sub === 'toggle') {
    const saved = await starboard.saveSettings(guild, { enabled: o.getBoolean('enabled') });
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error} Use \`/starboard setup\`.`, ephemeral: true });
    return interaction.reply({ content: saved.settings.enabled ? '✅ Starboard is **on**.' : '⏸️ Starboard is **off**.', ephemeral: true });
  }

  if (sub === 'ignore') {
    const channel = o.getChannel('channel');
    const s = starboard.starboardSettings(await getOrCreateConfig(guild.id));
    const ignored = s.ignoredChannelIds.includes(channel.id);
    const ids = ignored ? s.ignoredChannelIds.filter((id) => id !== channel.id) : [...s.ignoredChannelIds, channel.id];
    const saved = await starboard.saveSettings(guild, { ignoredChannelIds: ids });
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    return interaction.reply({ content: ignored ? `✅ Messages in ${channel} can be starred again.` : `🙈 Messages in ${channel} won't go to the starboard.`, ephemeral: true });
  }

  const posts = await starboard.topPosts(guild.id, 10);
  const embed = new EmbedBuilder()
    .setColor('#FFAC33')
    .setTitle('⭐ Most-starred messages')
    .setDescription(
      posts.length
        ? posts.map((p, i) => `**${i + 1}.** ${p.stars} ⭐ · <@${p.authorId}> in <#${p.channelId}> · [jump](https://discord.com/channels/${guild.id}/${p.channelId}/${p.messageId})`).join('\n')
        : 'Nothing has reached the starboard yet.'
    );
  return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

module.exports = { data, execute };
