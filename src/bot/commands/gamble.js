const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { getGamblingSettings, minesMultiplier, playCoinflip, startMines, startHighLow, startBlackjack } = require('../cogs/modules/gambling');

const betOption = (opt) => opt.setName('bet').setDescription('How much XP to bet').setMinValue(1).setRequired(true);

const data = new SlashCommandBuilder()
  .setName('gamble')
  .setDescription('Bet your XP on games of chance')
  .addSubcommand((sub) =>
    sub
      .setName('coinflip')
      .setDescription('50/50 — win roughly double your bet')
      .addIntegerOption(betOption)
      .addStringOption((opt) =>
        opt
          .setName('side')
          .setDescription('Heads or tails')
          .setRequired(true)
          .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('mines')
      .setDescription('5x5 minefield — reveal gems, avoid mines, cash out any time')
      .addIntegerOption(betOption)
      .addIntegerOption((opt) =>
        opt.setName('mines').setDescription('Number of mines (1-24, default 3). More mines = bigger multipliers').setMinValue(1).setMaxValue(24)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('highlow').setDescription('Guess if the next card is higher or lower — build a streak and cash out').addIntegerOption(betOption)
  )
  .addSubcommand((sub) =>
    sub.setName('blackjack').setDescription('Beat the dealer to 21 — hit, stand or double down').addIntegerOption(betOption)
  )
  .addSubcommand((sub) => sub.setName('info').setDescription('Show payouts, the house edge, and bet limits'))
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('Configure XP gambling for this server (Admin only)')
      .addBooleanOption((opt) => opt.setName('enabled').setDescription('Turn gambling on or off'))
      .addNumberOption((opt) => opt.setName('house_edge').setDescription('House edge in percent (0-50, default 4)').setMinValue(0).setMaxValue(50))
      .addIntegerOption((opt) => opt.setName('min_bet').setDescription('Minimum bet in XP').setMinValue(1))
      .addIntegerOption((opt) => opt.setName('max_bet').setDescription('Maximum bet in XP (0 = no limit)').setMinValue(0))
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Only allow gambling in this channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addBooleanOption((opt) => opt.setName('any_channel').setDescription('Allow gambling in every channel again'))
      .addBooleanOption((opt) => opt.setName('free_play').setDescription('Give players who go broke one free bet'))
      .addIntegerOption((opt) => opt.setName('free_play_xp').setDescription('Size of the free bet (default 300)').setMinValue(1).setMaxValue(1000000))
      .addIntegerOption((opt) => opt.setName('free_play_cooldown').setDescription('Hours between free plays per member (default 24)').setMinValue(0).setMaxValue(720))
  );

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'coinflip') {
    return playCoinflip(interaction, interaction.options.getInteger('bet'), interaction.options.getString('side'));
  }
  if (sub === 'mines') {
    return startMines(interaction, interaction.options.getInteger('bet'), interaction.options.getInteger('mines') ?? 3);
  }
  if (sub === 'highlow') {
    return startHighLow(interaction, interaction.options.getInteger('bet'));
  }
  if (sub === 'blackjack') {
    return startBlackjack(interaction, interaction.options.getInteger('bet'));
  }

  if (sub === 'info') {
    const config = await getOrCreateConfig(interaction.guildId);
    const s = getGamblingSettings(config);
    const mineExamples = [1, 3, 5, 10]
      .map((m) => `${m} mine${m > 1 ? 's' : ''}: 1 gem ${minesMultiplier(1, m, s.edge).toFixed(2)}x · 3 gems ${minesMultiplier(3, m, s.edge).toFixed(2)}x`)
      .join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🎰 XP Gambling')
      .setColor(s.enabled ? '#57F287' : '#ED4245')
      .setDescription(s.enabled ? 'Bet XP from your level progress. Losses can lower your level (role rewards are kept).' : '❌ Gambling is currently **disabled** on this server.')
      .addFields(
        { name: 'House edge', value: `${s.edgePercent}%`, inline: true },
        { name: 'Bet limits', value: `${s.minBet} – ${s.maxBet ? `${s.maxBet} XP` : 'no max'}`, inline: true },
        { name: 'Channel', value: s.channelId ? `<#${s.channelId}>` : 'Anywhere', inline: true },
        {
          name: '🎟️ Free play',
          value: s.freePlay.enabled
            ? `Go broke from gambling and you get one free **${s.freePlay.amount} XP** bet (once every ${s.freePlay.cooldownMs / 3600000}h). You keep the winnings.`
            : 'Off'
        },
        { name: '🪙 Coinflip', value: `50/50, pays **${(2 * (1 - s.edge)).toFixed(2)}x**` },
        { name: '💣 Mines', value: mineExamples },
        {
          name: '🃏 High-Low',
          value: `Each correct call multiplies your winnings by \`1 / chance\` (edge taken once at cash-out) — e.g. one call on a 7 pays ${((1 - s.edge) / (7 / 13)).toFixed(2)}x.`
        },
        {
          name: '🂡 Blackjack',
          value: `Win pays **${(2 - s.edge).toFixed(2)}x**, blackjack **${(1 + 1.5 * (1 - s.edge)).toFixed(2)}x**, push returns your bet. Dealer stands on 17; double down on your first two cards.`
        }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'config') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ This subcommand requires Administrator permission.', ephemeral: true });
    }
    const config = await getOrCreateConfig(interaction.guildId);
    const enabled = interaction.options.getBoolean('enabled');
    const edge = interaction.options.getNumber('house_edge');
    const minBet = interaction.options.getInteger('min_bet');
    const maxBet = interaction.options.getInteger('max_bet');
    const channel = interaction.options.getChannel('channel');
    const anyChannel = interaction.options.getBoolean('any_channel');

    const newMin = minBet ?? config.gamblingMinBet;
    const newMax = maxBet === null ? config.gamblingMaxBet : maxBet || null;
    if (newMax && newMin > newMax) {
      return interaction.reply({ content: '❌ `min_bet` cannot be greater than `max_bet`.', ephemeral: true });
    }

    if (enabled !== null) config.gamblingEnabled = enabled;
    if (edge !== null) config.gamblingHouseEdge = edge;
    config.gamblingMinBet = newMin;
    config.gamblingMaxBet = newMax;
    if (channel) config.gamblingChannelId = channel.id;
    if (anyChannel) config.gamblingChannelId = null;
    const freePlay = interaction.options.getBoolean('free_play');
    const freePlayXp = interaction.options.getInteger('free_play_xp');
    const freePlayCooldown = interaction.options.getInteger('free_play_cooldown');
    if (freePlay !== null) config.gamblingFreePlayEnabled = freePlay;
    if (freePlayXp !== null) config.gamblingFreePlayAmount = freePlayXp;
    if (freePlayCooldown !== null) config.gamblingFreePlayCooldownHours = freePlayCooldown;
    await config.save();

    const s = getGamblingSettings(config);
    return interaction.reply({
      content:
        `✅ Gambling is **${s.enabled ? 'enabled' : 'disabled'}** · House edge **${s.edgePercent}%** · ` +
        `Bets **${s.minBet}–${s.maxBet || '∞'} XP** · Channel: ${s.channelId ? `<#${s.channelId}>` : 'anywhere'} · ` +
        `Free play: ${s.freePlay.enabled ? `**${s.freePlay.amount} XP** every ${s.freePlay.cooldownMs / 3600000}h` : 'off'}`,
      ephemeral: true
    });
  }
}

module.exports = { data, execute };
