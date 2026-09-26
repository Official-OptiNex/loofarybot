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

  const embed = new EmbedBuilder()
    .setTitle(`🪙 Coinflip — ${result === 'heads' ? 'Heads' : 'Tails'}!`)
    .setColor(won ? '#57F287' : '#ED4245')
    .setDescription(
      `${interaction.user} bet **${bet} XP** on **${side}**.\n` +
        (won
          ? `✅ You won **${winnings} XP** (${fmtMult(multiplier)}).`
          : `❌ You lost **${bet} XP**.`) +
        levelNote(levelResult)
    );
  return interaction.reply({ embeds: [embed] });
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
  if (game.canCashOut()) {
    const rendered = await cashOut(game, '⏰ Auto-cashed out after inactivity.');
    if (game.message) await game.message.edit(rendered).catch(() => null);
    return;
  }
  // Nothing won yet — refund the bet instead of eating it.
  endGame(game);
  await payout(game.guild, game.userId, game.bet, game.config);
  game.status = 'refunded';
  if (game.message) await game.message.edit(game.render('⏰ Timed out before any move — your bet was refunded.')).catch(() => null);
}

async function cashOut(game, note = '') {
  endGame(game);
  const winnings = Math.floor(game.bet * game.currentMultiplier());
  const levelResult = await payout(game.guild, game.userId, winnings, game.config);
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
    return interaction.update(game.render());
  }
  game.fairMultiplier /= p;
  game.correct += 1;
  return interaction.update(game.render(`✅ ${cardLabel(next)} — correct!`));
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
  handleGambleButton
};
