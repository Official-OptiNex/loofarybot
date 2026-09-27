const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { resendControls, getGamblingSettings, minesMultiplier, minesLadder, playCoinflip, playDice, playLimbo, diceChance, diceMultiplier, limboChance, DICE_MIN_CHANCE, DICE_MAX_CHANCE, LIMBO_MIN, LIMBO_MAX, startMines, startHighLow, startBlackjack, syncGames, dailyLimitFor } = require('../cogs/modules/gambling');
const UserLevel = require('../../database/models/UserLevel');

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
      .setName('dice')
      .setDescription('Roll 0–100 — pick your odds: lower chance, bigger payout')
      .addIntegerOption(betOption)
      .addNumberOption((opt) =>
        opt.setName('target').setDescription('The number to roll under/over (default 50)').setMinValue(1).setMaxValue(99).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('direction')
          .setDescription('Win by rolling under or over the target (default under)')
          .addChoices({ name: 'Under', value: 'under' }, { name: 'Over', value: 'over' })
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('limbo')
      .setDescription('Pick a multiplier — if the rocket flies that high, you win it')
      .addIntegerOption(betOption)
      .addNumberOption((opt) =>
        opt.setName('target').setDescription('Target multiplier, 1.01–1000 (default 2)').setMinValue(1.01).setMaxValue(1000).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('mines')
      .setDescription('5x5 minefield — reveal gems, avoid mines, cash out any time')
      .addIntegerOption(betOption)
      .addIntegerOption((opt) =>
        opt
          .setName('mines')
          .setDescription('Number of mines (1-24, default 3). More mines = bigger multipliers')
          .setMinValue(1)
          .setMaxValue(24)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('highlow').setDescription('Guess if the next card is higher or lower — build a streak and cash out').addIntegerOption(betOption)
  )
  .addSubcommand((sub) =>
    sub.setName('blackjack').setDescription('Beat the dealer to 21 — hit, stand or double down').addIntegerOption(betOption)
  )
  .addSubcommand((sub) => sub.setName('info').setDescription('Show payouts, the house edge, and bet limits'))
  .addSubcommand((sub) => sub.setName('resume').setDescription('Get your game buttons back (if you dismissed them)'))
  .addSubcommand((sub) =>
    sub
      .setName('sync')
      .setDescription("Stuck? End your game now and get back any XP from games that didn't finish")
      .addBooleanOption((opt) => opt.setName('everyone').setDescription('Fix every player in this server (Manage Server only)'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('Configure XP gambling for this server (Admin only)')
      .addBooleanOption((opt) => opt.setName('enabled').setDescription('Turn gambling on or off'))
      .addNumberOption((opt) => opt.setName('house_edge').setDescription('House edge in percent (0-50, default 4)').setMinValue(0).setMaxValue(50))
      .addIntegerOption((opt) => opt.setName('min_bet').setDescription('Minimum bet in XP').setMinValue(1))
      .addIntegerOption((opt) => opt.setName('max_bet').setDescription('Maximum bet in XP (0 = no limit)').setMinValue(0))
      .addIntegerOption((opt) => opt.setName('max_win').setDescription('Most XP one game can win (0 = no limit) — games auto-cash-out at it').setMinValue(0))
      .addIntegerOption((opt) => opt.setName('daily_limit').setDescription('Games each member can play per day (default 10, 0 = unlimited)').setMinValue(0).setMaxValue(1000))
      .addIntegerOption((opt) =>
        opt.setName('daily_win_cap').setDescription('Most XP a member can win (net) per day — default 1000, 0 = no cap').setMinValue(0).setMaxValue(10000000)
      )
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
  if (sub === 'dice') {
    return playDice(
      interaction,
      interaction.options.getInteger('bet'),
      interaction.options.getNumber('target') ?? 50,
      interaction.options.getString('direction') ?? 'under'
    );
  }
  if (sub === 'limbo') {
    return playLimbo(interaction, interaction.options.getInteger('bet'), interaction.options.getNumber('target') ?? 2);
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

  if (sub === 'resume') return resendControls(interaction);

  if (sub === 'sync') {
    const everyone = interaction.options.getBoolean('everyone') ?? false;
    if (everyone && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ Only members with **Manage Server** can sync everyone.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await syncGames(interaction.client, interaction.guildId, everyone ? null : interaction.user.id);
    const who = (id) => (everyone ? `<@${id}> ` : '');
    const fmt = (n) => Number(n || 0).toLocaleString();
    const lines = [
      ...result.ended.map((e) =>
        e.status === 'cashed'
          ? `💰 ${who(e.userId)}${e.kind} ended and cashed out **${fmt(e.amount)} XP**`
          : e.status === 'refunded'
            ? `↩️ ${who(e.userId)}${e.kind} ended — bet of **${fmt(e.amount)} XP** refunded`
            : `🃏 ${who(e.userId)}${e.kind} ended (auto-stood) — result shown on the game`
      ),
      ...result.refunded.map(
        (r) => `♻️ ${who(r.userId)}unfinished ${r.kind} game — ${[r.paid ? `**${fmt(r.paid)} XP** refunded` : null, r.freePlay ? 'free play given back' : null].filter(Boolean).join(' and ')}`
      )
    ];
    if (result.cleared) lines.push(`🔓 Cleared ${result.cleared} stuck "game in progress" lock(s).`);
    return interaction.editReply({
      content: lines.length
        ? `✅ **Gambling synced${everyone ? ' for everyone' : ''}.**\n${lines.slice(0, 25).join('\n')}${lines.length > 25 ? `\n…and ${lines.length - 25} more.` : ''}`
        : `✅ Nothing was stuck${everyone ? ' in this server' : ' — you can start a new game'}.`,
      allowedMentions: { parse: [] }
    });
  }

  if (sub === 'info') {
    const config = await getOrCreateConfig(interaction.guildId);
    const s = getGamblingSettings(config);
    // More mines = a steeper payout ladder.
    const mineExamples = [1, 3, 5, 10, 20].map((m) => `**${m} mine${m > 1 ? 's' : ''}:** ${minesLadder(m, s.edge)}`).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🎰 XP Gambling')
      .setColor(s.enabled ? '#57F287' : '#ED4245')
      .setDescription(s.enabled ? 'Bet XP from your level progress. Losses can lower your level (role rewards are kept).' : '❌ Gambling is currently **disabled** on this server.')
      .addFields(
        { name: 'House edge', value: `${s.edgePercent}%`, inline: true },
        { name: 'Bet limits', value: `${s.minBet} – ${s.maxBet ? `${s.maxBet} XP` : 'no max'}`, inline: true },
        { name: 'Channel', value: s.channelId ? `<#${s.channelId}>` : 'Anywhere', inline: true },
        {
          name: 'Daily limit',
          value:
            (s.dailyLimit ? `${s.dailyLimit} games per member per day (resets at midnight UTC)` : 'Unlimited') +
            (s.dailyLimit && s.booster.enabled && s.booster.extraGambles ? ` · 💎 boosters +${s.booster.extraGambles}` : ''),
          inline: true
        },
        {
          name: 'Daily win limit',
          value: s.dailyWinCap ? `+${s.dailyWinCap.toLocaleString()} XP net per day — keeps gambling from skipping days of levels` : 'No cap',
          inline: true
        },
        { name: 'Max win per game', value: s.maxWin ? `${s.maxWin.toLocaleString()} XP (games cash out automatically at it)` : 'No cap', inline: true },
        {
          name: '🎟️ Free play',
          value: s.freePlay.enabled
            ? `Go broke from gambling and you get one free **${s.freePlay.amount} XP** bet (once every ${s.freePlay.cooldownMs / 3600000}h). You keep the winnings.`
            : 'Off'
        },
        { name: '🪙 Coinflip', value: `50/50, pays **${(2 * (1 - s.edge)).toFixed(2)}x**` },
        {
          name: '🎲 Dice — pick your odds',
          value: [50, 25, 10, 5].map((c) => `**${c}%** chance → **${diceMultiplier(c, s.edge).toFixed(2)}x**`).join(' · ') + '\nRoll 0.00–99.99, betting under or over your target.'
        },
        {
          name: '🚀 Limbo — pick a multiplier',
          value: [2, 5, 10, 100].map((t) => `**${t}x** → ${(limboChance(t, s.edge) * 100).toFixed(2)}% chance`).join(' · ') + '\nIf the result reaches your target, you win target × bet.'
        },
        { name: '💣 Mines — more mines, bigger payouts', value: mineExamples },
        {
          name: '🃏 High-Low',
          value: `Each correct call multiplies your winnings by \`1 / chance\` (edge taken once at cash-out) — e.g. one call on a 7 pays ${((1 - s.edge) / (7 / 13)).toFixed(2)}x.`
        },
        {
          name: '🂡 Blackjack',
          value: `Win pays **${(2 - s.edge).toFixed(2)}x**, blackjack **${(1 + 1.5 * (1 - s.edge)).toFixed(2)}x**, push returns your bet. Dealer stands on 17; double down on your first two cards.`
        }
      );
    // The player's own day so far.
    const me = await UserLevel.findOne({ guildId: interaction.guildId, userId: interaction.user.id }, { gambleDay: 1, gamblesToday: 1, gambleWinDay: 1, gambleNetToday: 1 }).lean();
    const today = new Date().toISOString().slice(0, 10);
    const limit = dailyLimitFor(s, interaction.member);
    const played = me?.gambleDay === today ? me.gamblesToday || 0 : 0;
    const net = me?.gambleWinDay === today ? me.gambleNetToday || 0 : 0;
    embed.addFields({
      name: '📅 Your day',
      value: [
        limit ? `🎲 **${Math.max(0, limit - played)}** / ${limit} plays left` : '🎲 Unlimited plays',
        `${net >= 0 ? '📈' : '📉'} Today: **${net >= 0 ? '+' : '−'}${Math.abs(net).toLocaleString()} XP**${s.dailyWinCap ? ` (limit +${s.dailyWinCap.toLocaleString()})` : ''}`,
        `Resets <t:${Math.floor(new Date().setUTCHours(24, 0, 0, 0) / 1000)}:R>`
      ].join(' · ')
    });
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
    const maxWin = interaction.options.getInteger('max_win');
    const dailyLimit = interaction.options.getInteger('daily_limit');
    if (dailyLimit !== null) config.gamblingDailyLimit = dailyLimit;
    const winCap = interaction.options.getInteger('daily_win_cap');
    if (winCap !== null) config.gamblingDailyWinCap = winCap;
    if (maxWin !== null) config.gamblingMaxWin = maxWin || null;
    if (freePlay !== null) config.gamblingFreePlayEnabled = freePlay;
    if (freePlayXp !== null) config.gamblingFreePlayAmount = freePlayXp;
    if (freePlayCooldown !== null) config.gamblingFreePlayCooldownHours = freePlayCooldown;
    await config.save();

    const s = getGamblingSettings(config);
    return interaction.reply({
      content:
        `✅ Gambling is **${s.enabled ? 'enabled' : 'disabled'}** · House edge **${s.edgePercent}%** · ` +
        `Bets **${s.minBet}–${s.maxBet || '∞'} XP** · Max win **${s.maxWin ? `${s.maxWin} XP` : 'none'}** · **${s.dailyLimit || '∞'}** games/day · Win cap **${s.dailyWinCap ? `+${s.dailyWinCap} XP/day` : 'none'}** · Channel: ${s.channelId ? `<#${s.channelId}>` : 'anywhere'} · ` +
        `Free play: ${s.freePlay.enabled ? `**${s.freePlay.amount} XP** every ${s.freePlay.cooldownMs / 3600000}h` : 'off'}`,
      ephemeral: true
    });
  }
}

// Mine count suggestions preview the payouts, so it's obvious more mines pay more.
const trim = (n) => String(Math.round(n * 100) / 100);

async function autocomplete(interaction) {
  const typed = interaction.options.getFocused();
  const config = await getOrCreateConfig(interaction.guildId);
  const { edge } = getGamblingSettings(config);
  const sub = interaction.options.getSubcommand();
  const typedNum = typed === '' ? null : Number(typed);

  if (sub === 'dice') {
    const direction = interaction.options.getString('direction') ?? 'under';
    const valid = (t) => {
      const c = diceChance(t, direction);
      return Number.isFinite(t) && c >= DICE_MIN_CHANCE && c <= DICE_MAX_CHANCE;
    };
    const presets = direction === 'over' ? [50, 25, 75, 10, 90, 5, 95] : [50, 75, 25, 90, 10, 95, 5];
    const targets = [...new Set([...(typedNum !== null && valid(typedNum) ? [Math.round(typedNum * 100) / 100] : []), ...presets])].filter(valid);
    return interaction.respond(
      targets.slice(0, 25).map((t) => {
        const c = diceChance(t, direction);
        return { name: `${direction} ${trim(t)} — ${trim(c)}% chance · pays ${diceMultiplier(c, edge).toFixed(2)}x`, value: t };
      })
    );
  }

  if (sub === 'limbo') {
    const valid = (t) => Number.isFinite(t) && t >= LIMBO_MIN && t <= LIMBO_MAX;
    const presets = [2, 1.5, 3, 5, 10, 25, 100, 1000];
    const targets = [...new Set([...(typedNum !== null && valid(typedNum) ? [Math.round(typedNum * 100) / 100] : []), ...presets])].filter(valid);
    return interaction.respond(
      targets.slice(0, 25).map((t) => ({ name: `${trim(t)}x — ${(limboChance(t, edge) * 100).toFixed(2)}% chance`, value: t }))
    );
  }

  const counts = typed ? [Number(typed)].filter((n) => n >= 1 && n <= 24) : [1, 3, 5, 7, 10, 15, 20, 24];
  return interaction.respond(
    counts.map((m) => ({ name: `${m} mine${m === 1 ? '' : 's'} — ${minesLadder(m, edge)}`.slice(0, 100), value: m }))
  );
}

module.exports = { data, execute, autocomplete };
