const crypto = require('crypto');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextDisplayBuilder,
  MessageFlags
} = require('discord.js');
const { getOrCreateConfig, getEffectiveXpSettings, adjustXp, debitXp } = require('./leveling');
const UserLevel = require('../../../database/models/UserLevel');

const GRID_SIZE = 25; // 5x5 mines board
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

// Interactive games live in memory. The bet is already debited when a game starts, so if a game
// sits idle it is auto-cashed-out (or refunded if nothing was revealed yet) rather than lost.
const activeGames = new Map(); // gameId -> game
const activeByUser = new Map(); // `${guildId}:${userId}` -> gameId

const randInt = (n) => crypto.randomInt(n);

function getGamblingSettings(config) {
  const edgePercent = Math.min(Math.max(config.gamblingHouseEdge ?? 4, 0), 50);
  return {
    enabled: config.gamblingEnabled !== false,
    edge: edgePercent / 100,
    edgePercent,
    minBet: config.gamblingMinBet ?? 10,
    maxBet: config.gamblingMaxBet ?? null,
    channelId: config.gamblingChannelId ?? null
  };
}

const fmtMult = (m) => `${m.toFixed(2)}x`;
const fmtNum = (n) => Number(n).toLocaleString('en-US');

async function fetchBalance(guildId, userId) {
  const record = await UserLevel.findOne({ guildId, userId }, { xp: 1, level: 1 }).lean();
  return { xp: record?.xp ?? 0, level: record?.level ?? 0 };
}

// "💳 Balance: 1,234 XP · Level 7 (+92 this game)" — shown on every finished game, win or lose.
function balanceText(balance, net) {
  if (!balance) return '';
  const change = net === 0 ? '±0' : `${net > 0 ? '+' : '−'}${fmtNum(Math.abs(net))}`;
  return `💳 **Balance:** \`${fmtNum(balance.xp)} XP\` · Level **${balance.level}** · this game: **${change} XP**`;
}

// Settles a finished interactive game: records the net result and the player's fresh balance.
async function settle(game, returned) {
  game.net = returned - game.bet;
  game.balance = await fetchBalance(game.guildId, game.userId);
}

function levelNote(result) {
  if (!result) return '';
  let note = result.newLevel > result.oldLevel ? `\n🎉 You leveled up to **Level ${result.newLevel}**!` : '';
  if (result.roleFailures && result.roleFailures.length > 0) {
    note += `\n⚠️ Couldn't assign ${result.roleFailures.join(', ')} — LoofaryBot's role must be above it.`;
  }
  return note;
}

/**
 * Validates the bet against the guild's gambling settings and atomically takes it from the
 * player's XP. Replies with the reason and returns null if the bet can't be placed.
 */
async function placeBet(interaction, bet) {
  const config = await getOrCreateConfig(interaction.guildId);
  const settings = getGamblingSettings(config);
  const { levelXpBase } = getEffectiveXpSettings(config);
  const fail = (content) => interaction.reply({ content, ephemeral: true }).then(() => null);

  if (!settings.enabled) return fail('❌ XP gambling is disabled on this server.');
  if (settings.channelId && interaction.channelId !== settings.channelId) {
    return fail(`❌ Gambling is only allowed in <#${settings.channelId}>.`);
  }
  if (bet < settings.minBet) return fail(`❌ The minimum bet is **${settings.minBet} XP**.`);
  if (settings.maxBet && bet > settings.maxBet) return fail(`❌ The maximum bet is **${settings.maxBet} XP**.`);

  const debited = await debitXp(interaction.guildId, interaction.user.id, bet, levelXpBase);
  if (!debited) return fail(`❌ You don't have **${bet} XP** to bet. Check your balance with \`/levels rank\`.`);

  return { config, settings };
}

async function payout(guild, userId, amount, config) {
  if (amount <= 0) return null;
  return adjustXp(guild, userId, amount, config);
}

// ---------------------------------------------------------------- Coinflip

async function playCoinflip(interaction, bet, side) {
  const ctx = await placeBet(interaction, bet);
  if (!ctx) return;

  const result = randInt(2) === 0 ? 'heads' : 'tails';
  const won = result === side;
  const multiplier = 2 * (1 - ctx.settings.edge);
  const winnings = won ? Math.floor(bet * multiplier) : 0;
  const levelResult = await payout(interaction.guild, interaction.user.id, winnings, ctx.config);
  const balance = await fetchBalance(interaction.guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setTitle(`🪙 Coinflip — ${result === 'heads' ? 'Heads' : 'Tails'}!`)
    .setColor(won ? '#57F287' : '#ED4245')
    .setDescription(
      `${interaction.user} bet **${fmtNum(bet)} XP** on **${side}**.\n` +
        (won
          ? `✅ You won **${fmtNum(winnings)} XP** (${fmtMult(multiplier)}).`
          : `❌ You lost **${fmtNum(bet)} XP**.`) +
        levelNote(levelResult) +
        `\n\n${balanceText(balance, winnings - bet)}`
    );
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

// ---------------------------------------------------------------- Shared game lifecycle

function startGame(interaction, game) {
  game.id = crypto.randomBytes(6).toString('hex');
  game.userId = interaction.user.id;
  game.guildId = interaction.guildId;
  game.guild = interaction.guild;
  game.finished = false;
  game.busy = false;
  activeGames.set(game.id, game);
  activeByUser.set(`${game.guildId}:${game.userId}`, game.id);
  touchGame(game);
  return game;
}

function touchGame(game) {
  clearTimeout(game.timer);
  game.timer = setTimeout(() => expireGame(game).catch(console.error), IDLE_TIMEOUT_MS);
}

function endGame(game) {
  game.finished = true;
  clearTimeout(game.timer);
  activeGames.delete(game.id);
  if (activeByUser.get(`${game.guildId}:${game.userId}`) === game.id) {
    activeByUser.delete(`${game.guildId}:${game.userId}`);
  }
}

function hasActiveGame(guildId, userId) {
  return activeByUser.has(`${guildId}:${userId}`);
}

async function expireGame(game) {
  if (game.finished) return;
  if (game.onExpire) {
    const rendered = await game.onExpire();
    if (game.message && rendered) await game.message.edit(rendered).catch(() => null);
    return;
  }
  if (game.canCashOut()) {
    const rendered = await cashOut(game, '⏰ Auto-cashed out after inactivity.');
    if (game.message) await game.message.edit(rendered).catch(() => null);
    return;
  }
  // Nothing won yet — refund the bet instead of eating it.
  endGame(game);
  await payout(game.guild, game.userId, game.bet, game.config);
  await settle(game, game.bet);
  game.status = 'refunded';
  if (game.message) await game.message.edit(game.render('⏰ Timed out before any move — your bet was refunded.')).catch(() => null);
}

async function cashOut(game, note = '') {
  endGame(game);
  const winnings = Math.floor(game.bet * game.currentMultiplier());
  const levelResult = await payout(game.guild, game.userId, winnings, game.config);
  await settle(game, winnings);
  game.status = 'cashed';
  game.winnings = winnings;
  return game.render(`${note ? `${note}\n` : ''}💰 Cashed out **${winnings} XP** (${fmtMult(game.currentMultiplier())}).${levelNote(levelResult)}`);
}

// ---------------------------------------------------------------- Mines

function minesMultiplier(safeRevealed, mineCount, edge) {
  let m = 1;
  for (let i = 0; i < safeRevealed; i++) m *= (GRID_SIZE - i) / (GRID_SIZE - mineCount - i);
  return m * (1 - edge);
}

function createMinesGame(bet, mineCount, config, settings) {
  const mines = new Set();
  while (mines.size < mineCount) mines.add(randInt(GRID_SIZE));

  const game = {
    kind: 'mines',
    bet,
    config,
    edge: settings.edge,
    mineCount,
    mines,
    revealed: new Set(),
    status: 'playing',
    hitIndex: null
  };
  game.currentMultiplier = () => minesMultiplier(game.revealed.size, mineCount, game.edge);
  game.canCashOut = () => !game.finished && game.revealed.size > 0;
  game.render = (note = '') => renderMines(game, note);
  return game;
}

function renderMines(game, note) {
  const over = game.status !== 'playing';
  const safeLeft = GRID_SIZE - game.mineCount - game.revealed.size;
  const next = minesMultiplier(game.revealed.size + 1, game.mineCount, game.edge);

  let header = `## 💣 Mines — <@${game.userId}>\n**Bet:** ${game.bet} XP · **Mines:** ${game.mineCount} · **Gems found:** ${game.revealed.size}`;
  if (!over) {
    header +=
      `\n**Current:** ${fmtMult(game.revealed.size > 0 ? game.currentMultiplier() : 0)}` +
      (safeLeft > 0 ? ` · **Next gem:** ${fmtMult(next)}` : '');
  }
  if (game.status === 'lost') header += `\n💥 You hit a mine and lost **${game.bet} XP**.`;
  if (note) header += `\n${note}`;
  if (game.balance) header += `\n\n${balanceText(game.balance, game.net)}`;

  const rows = [];
  for (let r = 0; r < 5; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c;
      const btn = new ButtonBuilder().setCustomId(`gm:${game.id}:${idx}`);
      if (game.revealed.has(idx)) {
        btn.setEmoji('💎').setStyle(ButtonStyle.Success).setDisabled(true);
      } else if (over && game.mines.has(idx)) {
        btn.setEmoji('💣').setStyle(idx === game.hitIndex ? ButtonStyle.Danger : ButtonStyle.Secondary).setDisabled(true);
      } else if (over) {
        btn.setEmoji('💎').setStyle(ButtonStyle.Secondary).setDisabled(true);
      } else {
        btn.setLabel('?').setStyle(ButtonStyle.Secondary);
      }
      row.addComponents(btn);
    }
    rows.push(row);
  }

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gm:${game.id}:cash`)
      .setLabel(
        over ? 'Game over' : game.revealed.size > 0 ? `Cash out ${Math.floor(game.bet * game.currentMultiplier())} XP` : 'Reveal a tile first'
      )
      .setEmoji('💰')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(over || game.revealed.size === 0)
  );

  // Components V2 lets one message hold the full 5x5 board plus the cash-out row
  // (classic messages cap out at 5 rows total).
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [new TextDisplayBuilder().setContent(header), ...rows, controls],
    allowedMentions: { parse: [] }
  };
}

async function startMines(interaction, bet, mineCount) {
  if (hasActiveGame(interaction.guildId, interaction.user.id)) {
    return interaction.reply({ content: '❌ Finish your current game first.', ephemeral: true });
  }
  const ctx = await placeBet(interaction, bet);
  if (!ctx) return;

  const game = startGame(interaction, createMinesGame(bet, mineCount, ctx.config, ctx.settings));
  await interaction.reply(game.render());
  game.message = await interaction.fetchReply().catch(() => null);
}

async function handleMinesClick(interaction, game, action) {
  if (action === 'cash') {
    if (!game.canCashOut()) return interaction.deferUpdate();
    return interaction.update(await cashOut(game));
  }

  const idx = Number(action);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_SIZE || game.revealed.has(idx)) {
    return interaction.deferUpdate();
  }

  if (game.mines.has(idx)) {
    endGame(game);
    game.status = 'lost';
    game.hitIndex = idx;
    await settle(game, 0);
    return interaction.update(game.render());
  }

  game.revealed.add(idx);
  touchGame(game);
  if (game.revealed.size === GRID_SIZE - game.mineCount) {
    return interaction.update(await cashOut(game, '🏆 Cleared the whole board!'));
  }
  return interaction.update(game.render());
}

// ---------------------------------------------------------------- High-Low

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠️', '♥️', '♦️', '♣️'];

function drawCard() {
  return { value: randInt(13) + 1, suit: SUITS[randInt(4)] };
}

const cardLabel = (card) => `${RANKS[card.value - 1]}${card.suit}`;

// Probability the next card is >= / <= the current one (equal counts as a win both ways).
const pHigherOrSame = (v) => (14 - v) / 13;
const pLowerOrSame = (v) => v / 13;

function createHighLowGame(bet, config, settings) {
  const game = {
    kind: 'highlow',
    bet,
    config,
    edge: settings.edge,
    card: drawCard(),
    fairMultiplier: 1, // product of 1/chance for every correct call; the edge is applied once on top
    correct: 0,
    history: [],
    status: 'playing'
  };
  game.currentMultiplier = () => game.fairMultiplier * (1 - game.edge);
  game.canCashOut = () => !game.finished && game.correct > 0;
  // Total multiplier the player would hold after one more correct call at chance p.
  game.multiplierIfCorrect = (p) => (game.fairMultiplier / p) * (1 - game.edge);
  game.render = (note = '') => renderHighLow(game, note);
  return game;
}

function renderHighLow(game, note) {
  const over = game.status !== 'playing';
  const v = game.card.value;
  const hiMult = game.multiplierIfCorrect(pHigherOrSame(v));
  const loMult = game.multiplierIfCorrect(pLowerOrSame(v));

  const lines = [
    `${game.status === 'lost' ? 'Last card' : 'Current card'}: **${cardLabel(game.card)}**`,
    `**Bet:** ${game.bet} XP · **Streak:** ${game.correct} · **Multiplier:** ${game.correct > 0 ? fmtMult(game.currentMultiplier()) : '—'}`
  ];
  if (game.history.length > 0) lines.push(`**History:** ${game.history.slice(-10).join(' → ')}`);
  if (game.status === 'lost') lines.push(`❌ Wrong call — you lost **${game.bet} XP**.`);
  if (note) lines.push(note);
  if (game.balance) lines.push('', balanceText(game.balance, game.net));

  const embed = new EmbedBuilder()
    .setTitle('🃏 High-Low')
    .setColor(game.status === 'lost' ? '#ED4245' : game.status === 'playing' ? '#5865F2' : '#57F287')
    .setDescription(`<@${game.userId}>\n${lines.join('\n')}`)
    .setFooter({ text: 'Equal cards count as a win for both Higher and Lower.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hl:${game.id}:hi`)
      .setLabel(`Higher or same → ${fmtMult(hiMult)}`)
      .setEmoji('⬆️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(over),
    new ButtonBuilder()
      .setCustomId(`hl:${game.id}:lo`)
      .setLabel(`Lower or same → ${fmtMult(loMult)}`)
      .setEmoji('⬇️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(over),
    new ButtonBuilder().setCustomId(`hl:${game.id}:skip`).setLabel('Skip card').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(over),
    new ButtonBuilder()
      .setCustomId(`hl:${game.id}:cash`)
      .setLabel(game.correct > 0 && !over ? `Cash out ${Math.floor(game.bet * game.currentMultiplier())} XP` : 'Cash out')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Success)
      .setDisabled(over || game.correct === 0)
  );

  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

async function startHighLow(interaction, bet) {
  if (hasActiveGame(interaction.guildId, interaction.user.id)) {
    return interaction.reply({ content: '❌ Finish your current game first.', ephemeral: true });
  }
  const ctx = await placeBet(interaction, bet);
  if (!ctx) return;

  const game = startGame(interaction, createHighLowGame(bet, ctx.config, ctx.settings));
  await interaction.reply(game.render());
  game.message = await interaction.fetchReply().catch(() => null);
}

async function handleHighLowClick(interaction, game, action) {
  if (action === 'cash') {
    if (!game.canCashOut()) return interaction.deferUpdate();
    return interaction.update(await cashOut(game));
  }

  const previous = game.card;
  const next = drawCard();
  touchGame(game);

  if (action === 'skip') {
    game.history.push(`${cardLabel(previous)} (skipped)`);
    game.card = next;
    return interaction.update(game.render());
  }
  if (action !== 'hi' && action !== 'lo') return interaction.deferUpdate();

  const p = action === 'hi' ? pHigherOrSame(previous.value) : pLowerOrSame(previous.value);
  const won = action === 'hi' ? next.value >= previous.value : next.value <= previous.value;
  game.history.push(cardLabel(previous));
  game.card = next;

  if (!won) {
    endGame(game);
    game.status = 'lost';
    await settle(game, 0);
    return interaction.update(game.render());
  }
  game.fairMultiplier /= p;
  game.correct += 1;
  return interaction.update(game.render(`✅ ${cardLabel(next)} — correct!`));
}

// ---------------------------------------------------------------- Blackjack

// 6-deck shoe, dealer stands on all 17s, blackjack pays 3:2, no splits. The house edge is taken
// from the winnings (not the returned stake), so a win at 4% edge pays 1.96x the bet.
const BJ_DECKS = 6;

function buildShoe() {
  const shoe = [];
  for (let d = 0; d < BJ_DECKS; d++) for (let v = 1; v <= 13; v++) for (const suit of SUITS) shoe.push({ value: v, suit });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.value === 1) {
      aces += 1;
      total += 11;
    } else total += Math.min(c.value, 10);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;
const showHand = (cards) => cards.map(cardLabel).join('  ');

function createBlackjackGame(bet, config, settings) {
  const shoe = buildShoe();
  const game = {
    kind: 'blackjack',
    bet,
    config,
    edge: settings.edge,
    shoe,
    player: [shoe.pop(), shoe.pop()],
    dealer: [shoe.pop(), shoe.pop()],
    doubled: false,
    status: 'playing',
    outcome: null
  };
  game.currentMultiplier = () => 1;
  game.canCashOut = () => false;
  game.onExpire = async () => {
    // Idle hands stand automatically rather than forfeiting the bet.
    await resolveBlackjack(game, '⏰ Auto-stood after inactivity.');
    return game.render();
  };
  game.render = (note = '') => renderBlackjack(game, note);
  return game;
}

// Amount returned to the player (stake included) for each outcome.
function blackjackReturn(game, outcome) {
  const winnings = (mult) => Math.floor(game.bet * mult * (1 - game.edge));
  switch (outcome) {
    case 'blackjack':
      return game.bet + winnings(1.5);
    case 'win':
    case 'dealer_bust':
      return game.bet + winnings(1);
    case 'push':
      return game.bet;
    default:
      return 0;
  }
}

const BJ_OUTCOME_TEXT = {
  blackjack: '🂡 **Blackjack!**',
  win: '✅ **You win!**',
  dealer_bust: '💥 **Dealer busts — you win!**',
  push: '🤝 **Push** — your bet is returned.',
  lose: '❌ **Dealer wins.**',
  bust: '💥 **Bust!** You went over 21.',
  dealer_blackjack: '🂡 **Dealer has blackjack.**'
};

async function resolveBlackjack(game, note = '') {
  if (game.finished) return;
  endGame(game);
  const player = handValue(game.player).total;
  let outcome;

  if (player > 21) outcome = 'bust';
  else if (isBlackjack(game.player) && !isBlackjack(game.dealer)) outcome = 'blackjack';
  else if (isBlackjack(game.dealer) && !isBlackjack(game.player)) outcome = 'dealer_blackjack';
  else {
    while (handValue(game.dealer).total < 17) game.dealer.push(game.shoe.pop());
    const dealer = handValue(game.dealer).total;
    if (dealer > 21) outcome = 'dealer_bust';
    else if (player > dealer) outcome = 'win';
    else if (player === dealer) outcome = 'push';
    else outcome = 'lose';
  }

  const returned = blackjackReturn(game, outcome);
  const levelResult = await payout(game.guild, game.userId, returned, game.config);
  game.outcome = outcome;
  game.status = ['blackjack', 'win', 'dealer_bust'].includes(outcome) ? 'won' : outcome === 'push' ? 'push' : 'lost';
  game.note = [note, BJ_OUTCOME_TEXT[outcome] + (returned > game.bet ? ` +${fmtNum(returned - game.bet)} XP` : ''), levelNote(levelResult).trim()]
    .filter(Boolean)
    .join('\n');
  await settle(game, returned);
}

function renderBlackjack(game, note) {
  const over = game.status !== 'playing';
  const player = handValue(game.player);
  const dealerShown = over ? game.dealer : [game.dealer[0]];
  const dealerValue = handValue(dealerShown);

  const embed = new EmbedBuilder()
    .setTitle('🃏 Blackjack')
    .setColor(game.status === 'won' ? '#57F287' : game.status === 'lost' ? '#ED4245' : game.status === 'push' ? '#FEE75C' : '#5865F2')
    .setDescription(`<@${game.userId}> · **Bet:** ${fmtNum(game.bet)} XP${game.doubled ? ' (doubled)' : ''}`)
    .addFields(
      {
        name: `Dealer — ${over ? dealerValue.total : `${dealerValue.total} + ?`}`,
        value: `${showHand(dealerShown)}${over ? '' : '  🂠'}`,
        inline: true
      },
      { name: `You — ${player.total}${player.soft && player.total < 21 ? ' (soft)' : ''}`, value: showHand(game.player), inline: true }
    )
    .setFooter({ text: 'Dealer stands on 17 · Blackjack pays 3:2 · 6-deck shoe' });

  const text = [note, game.note, game.balance ? balanceText(game.balance, game.net) : ''].filter(Boolean).join('\n\n');
  if (text) embed.addFields({ name: '​', value: text });

  const canDouble = !over && game.player.length === 2 && !game.doubled;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bj:${game.id}:hit`).setLabel('Hit').setEmoji('➕').setStyle(ButtonStyle.Primary).setDisabled(over),
    new ButtonBuilder().setCustomId(`bj:${game.id}:stand`).setLabel('Stand').setEmoji('✋').setStyle(ButtonStyle.Secondary).setDisabled(over),
    new ButtonBuilder()
      .setCustomId(`bj:${game.id}:double`)
      .setLabel(`Double (+${fmtNum(game.bet)} XP)`)
      .setEmoji('💰')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canDouble)
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

async function startBlackjack(interaction, bet) {
  if (hasActiveGame(interaction.guildId, interaction.user.id)) {
    return interaction.reply({ content: '❌ Finish your current game first.', ephemeral: true });
  }
  const ctx = await placeBet(interaction, bet);
  if (!ctx) return;

  const game = startGame(interaction, createBlackjackGame(bet, ctx.config, ctx.settings));
  // A natural on either side settles immediately.
  if (isBlackjack(game.player) || isBlackjack(game.dealer)) await resolveBlackjack(game);
  await interaction.reply(game.render());
  if (!game.finished) game.message = await interaction.fetchReply().catch(() => null);
}

async function handleBlackjackClick(interaction, game, action) {
  touchGame(game);
  if (action === 'hit') {
    game.player.push(game.shoe.pop());
    if (handValue(game.player).total >= 21) await resolveBlackjack(game);
    return interaction.update(game.render());
  }
  if (action === 'stand') {
    await resolveBlackjack(game);
    return interaction.update(game.render());
  }
  if (action === 'double') {
    if (game.player.length !== 2 || game.doubled) return interaction.deferUpdate();
    const { levelXpBase } = getEffectiveXpSettings(game.config);
    if (!(await debitXp(game.guildId, game.userId, game.bet, levelXpBase))) {
      return interaction.reply({ content: `❌ You need another **${fmtNum(game.bet)} XP** to double down.`, ephemeral: true });
    }
    game.bet *= 2;
    game.doubled = true;
    game.player.push(game.shoe.pop());
    await resolveBlackjack(game);
    return interaction.update(game.render());
  }
  return interaction.deferUpdate();
}

// ---------------------------------------------------------------- Button router

async function handleGambleButton(interaction) {
  const [prefix, gameId, action] = interaction.customId.split(':');
  const game = activeGames.get(gameId);
  if (!game) {
    return interaction.reply({ content: '⌛ This game is over or expired.', ephemeral: true });
  }
  if (interaction.user.id !== game.userId) {
    return interaction.reply({ content: "🙅 This isn't your game — start your own with `/gamble`.", ephemeral: true });
  }
  // Ignore double-clicks while the previous click is still being processed.
  if (game.busy) return interaction.deferUpdate().catch(() => null);
  game.busy = true;
  try {
    if (prefix === 'gm') return await handleMinesClick(interaction, game, action);
    if (prefix === 'hl') return await handleHighLowClick(interaction, game, action);
    if (prefix === 'bj') return await handleBlackjackClick(interaction, game, action);
  } finally {
    game.busy = false;
  }
}

module.exports = {
  getGamblingSettings,
  minesMultiplier,
  pHigherOrSame,
  pLowerOrSame,
  playCoinflip,
  startMines,
  startHighLow,
  startBlackjack,
  handValue,
  blackjackReturn,
  handleGambleButton
};
