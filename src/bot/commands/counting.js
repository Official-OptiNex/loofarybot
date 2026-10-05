// /counting — set up the counting game channel and check how it's going.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const counting = require('../cogs/modules/counting');
const { getOrCreateConfig } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('counting')
  .setDescription('A counting game channel — count up together, one number at a time')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Pick the counting channel (turns the game on)')
      .addChannelOption((o) => o.setName('channel').setDescription('The counting channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((o) => o.setName('take_turns').setDescription('Members must take turns — no counting twice in a row (default on)'))
      .addBooleanOption((o) => o.setName('math').setDescription('Allow sums like 3*4 (default on)'))
      .addBooleanOption((o) => o.setName('numbers_only').setDescription('Delete normal chat so the channel is numbers only (default on)'))
      .addIntegerOption((o) => o.setName('slowmode').setDescription('Slowmode in seconds, grief protection (default 1200 = 20 min; 0 = off)').setMinValue(0).setMaxValue(21600))
  )
  .addSubcommand((s) =>
    s.setName('toggle').setDescription('Turn the counting game on or off').addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Set the current number (e.g. to undo an unfair reset)')
      .addIntegerOption((o) => o.setName('number').setDescription('The last number counted — the next one will be this + 1').setRequired(true).setMinValue(0))
  )
  .addSubcommand((s) => s.setName('status').setDescription('The current number, best run and settings'));

const fmt = (n) => Number(n).toLocaleString('en-US');

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;

  if (sub === 'setup') {
    const input = { enabled: true, channelId: o.getChannel('channel').id };
    if (o.getBoolean('take_turns') !== null) input.allowSameUser = !o.getBoolean('take_turns');
    if (o.getBoolean('math') !== null) input.mathAllowed = o.getBoolean('math');
    if (o.getBoolean('numbers_only') !== null) input.numbersOnly = o.getBoolean('numbers_only');
    if (o.getInteger('slowmode') !== null) input.slowmodeSeconds = o.getInteger('slowmode');
    const saved = await counting.saveSettings(guild, input);
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    const s = saved.settings;
    const channel = guild.channels.cache.get(s.channelId);
    await channel
      ?.send(`🔢 **Counting game!** Count up one number at a time${s.allowSameUser ? '' : ' — and take turns'}. A wrong number resets the count.\nThe next number is **${fmt(s.current + 1)}**.`)
      .catch(() => null);
    const slowLabel = s.slowmodeSeconds >= 60 ? `${Math.round(s.slowmodeSeconds / 60)} min` : `${s.slowmodeSeconds}s`;
    return interaction.reply({
      content:
        `✅ Counting is on in <#${s.channelId}> · ${s.allowSameUser ? 'same person can count again' : 'members take turns'} · ${s.mathAllowed ? 'sums allowed' : 'plain numbers only'} · ` +
        `${s.numbersOnly ? 'numbers-only (chat removed)' : 'chat allowed'} · slowmode ${s.slowmodeSeconds ? slowLabel : 'off'}.`,
      ephemeral: true
    });
  }

  if (sub === 'toggle') {
    const saved = await counting.saveSettings(guild, { enabled: o.getBoolean('enabled') });
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error} Use \`/counting setup\`.`, ephemeral: true });
    return interaction.reply({ content: saved.settings.enabled ? '✅ Counting is **on**.' : '⏸️ Counting is **off**.', ephemeral: true });
  }

  if (sub === 'set') {
    const saved = await counting.saveSettings(guild, { current: o.getInteger('number') });
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    const s = saved.settings;
    if (s.enabled && s.channelId) {
      await guild.channels.cache
        .get(s.channelId)
        ?.send({ content: `🛠️ A moderator set the count to **${fmt(s.current)}**. The next number is **${fmt(s.current + 1)}**.`, allowedMentions: { parse: [] } })
        .catch(() => null);
    }
    return interaction.reply({ content: `✅ Count set to **${fmt(s.current)}** — next is **${fmt(s.current + 1)}**.`, ephemeral: true });
  }

  const s = counting.countingSettings(await getOrCreateConfig(guild.id));
  const embed = new EmbedBuilder()
    .setColor(s.enabled ? '#57F287' : '#4E5058')
    .setTitle(`🔢 Counting — ${s.enabled ? 'on' : 'off'}`)
    .addFields(
      { name: 'Channel', value: s.channelId ? `<#${s.channelId}>` : 'not set', inline: true },
      { name: 'Next number', value: `**${fmt(s.current + 1)}**`, inline: true },
      { name: 'Best run', value: fmt(s.record), inline: true },
      { name: 'Last counted by', value: s.lastUserId ? `<@${s.lastUserId}>` : '—', inline: true },
      { name: 'Resets', value: fmt(s.resets) + (s.lastResetBy ? ` (last: <@${s.lastResetBy}>)` : ''), inline: true },
      { name: 'Rules', value: `${s.allowSameUser ? 'Same person can count again' : 'Take turns'} · ${s.mathAllowed ? 'sums allowed' : 'plain numbers'}`, inline: true },
      {
        name: 'Anti-grief',
        value: `${s.numbersOnly ? 'Numbers only (chat deleted)' : 'Chat allowed'} · slowmode ${s.slowmodeSeconds ? (s.slowmodeSeconds >= 60 ? `${Math.round(s.slowmodeSeconds / 60)} min` : `${s.slowmodeSeconds}s`) : 'off'}`,
        inline: true
      }
    );
  return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

module.exports = { data, execute };
