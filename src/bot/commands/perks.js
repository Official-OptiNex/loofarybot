// /perks — what server boosters get, and (Manage Server) how much.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { boosterSettings, describePerks, isBooster } = require('../cogs/modules/boosterPerks');
const { dashboardUrl } = require('../cogs/modules/help');

const data = new SlashCommandBuilder()
  .setName('perks')
  .setDescription('Server booster perks')
  .addSubcommand((s) => s.setName('show').setDescription('See what server boosters get'))
  .addSubcommand((s) =>
    s
      .setName('config')
      .setDescription('Change the booster perks (Manage Server)')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Turn all booster perks on or off'))
      .addIntegerOption((o) => o.setName('extra_gambles').setDescription('Extra gambles per day (default 5)').setMinValue(0).setMaxValue(100))
      .addIntegerOption((o) => o.setName('giveaway_entries').setDescription('Extra entries in every giveaway (default 2)').setMinValue(0).setMaxValue(10))
      .addIntegerOption((o) => o.setName('daily_xp').setDescription('XP every booster gets automatically each day (default 100, 0 = off)').setMinValue(0).setMaxValue(100000))
      .addIntegerOption((o) => o.setName('boost_xp').setDescription('One-time thank-you XP when someone boosts (default 500, 0 = off)').setMinValue(0).setMaxValue(1000000))
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Announce daily drops and thank-yous here').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addBooleanOption((o) => o.setName('no_announcements').setDescription('Stop announcing drops and thank-yous'))
  );

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const config = await getOrCreateConfig(interaction.guildId);

  if (sub === 'config') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ Changing booster perks needs **Manage Server**.', ephemeral: true });
    }
    const perks = (config.boosterPerks = config.boosterPerks || {});
    const set = (key, option, getter = 'getInteger') => {
      const v = interaction.options[getter](option);
      if (v !== null) perks[key] = v;
    };
    set('enabled', 'enabled', 'getBoolean');
    set('extraGambles', 'extra_gambles');
    set('giveawayEntries', 'giveaway_entries');
    set('dailyXp', 'daily_xp');
    set('boostXp', 'boost_xp');
    const channel = interaction.options.getChannel('channel');
    if (channel) perks.channelId = channel.id;
    if (interaction.options.getBoolean('no_announcements')) perks.channelId = null;
    config.markModified('boosterPerks');
    await config.save();
    const s = boosterSettings(config);
    return interaction.reply({
      content:
        `✅ **Booster perks saved.**\n${describePerks(s)}\n` +
        `Announcements: ${s.channelId ? `<#${s.channelId}>` : 'off'}\n-# Giveaway entries apply to giveaways started from now on. Daily drops go out just after midnight UTC.`,
      ephemeral: true
    });
  }

  const s = boosterSettings(config);
  const boosters = interaction.guild.premiumSubscriptionCount ?? 0;
  const embed = new EmbedBuilder()
    .setColor('#F47FFF')
    .setTitle('💎 Booster perks')
    .setDescription(
      `${describePerks(s)}\n\n` +
        (isBooster(interaction.member)
          ? `You're boosting — thank you! Your perks are active since <t:${Math.floor(interaction.member.premiumSinceTimestamp / 1000)}:D>.`
          : 'Boost the server to unlock them!') +
        `\n-# ${boosters} boost${boosters === 1 ? '' : 's'} · Tier ${interaction.guild.premiumTier}`
    );
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    embed.setFooter({ text: `Change them with /perks config or the dashboard: ${dashboardUrl(interaction.guildId)}` });
  }
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { data, execute };
