const crypto = require('crypto');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextDisplayBuilder,
  MessageFlags,
  ComponentType
} = require('discord.js');
const { getOrCreateConfig, getEffectiveXpSettings, adjustXp, debitXp } = require('./leveling');
const UserLevel = require('../../../database/models/UserLevel');
const ActiveBet = require('../../../database/models/ActiveBet');
const { boosterSettings } = require('./boosterPerks');

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
    maxWin: config.gamblingMaxWin > 0 ? config.gamblingMaxWin : null, // most XP one game can win (profit), null = no cap
    dailyLimit: Math.max(0, config.gamblingDailyLimit ?? 10), // games per member per UTC day, 0 = unlimited
    dailyWinCap: Math.max(0, config.gamblingDailyWinCap ?? 1000), // most XP a member can come out ahead per UTC day, 0 = no cap
    booster: boosterSettings(config),
    channelId: config.gamblingChannelId ?? null,
    freePlay: {
      enabled: config.gamblingFreePlayEnabled !== false,
      amount: Math.max(1, config.gamblingFreePlayAmount ?? 300),
      cooldownMs: Math.max(0, config.gamblingFreePlayCooldownHours ?? 24) * 3600 * 1000
    }
  };
}

const fmtMult = (m) => `${m.toFixed(2)}x`;

// The most one game may pay back: the stake plus the smaller of the server's per-game max win and
// what's left of the player's daily win cap. `g` is a game (or a coinflip's bet context).
function maxReturn(g) {
  const caps = [];
  if (g.settings?.maxWin) caps.push(g.bet + g.settings.maxWin);
  if (g.winRoom !== null && g.winRoom !== undefined) caps.push((g.paidStake ?? g.bet) + Math.max(0, g.winRoom));
  return caps.length ? Math.min(...caps) : Infinity;
}
const capReturn = (g, returned) => Math.min(returned, maxReturn(g));
const hitCap = (game) => Math.floor(game.bet * game.currentMultiplier()) >= maxReturn(game);
// Which cap stopped the game, for the message.
const capLabel = (g) =>
  g.winRoom !== null && g.winRoom !== undefined && (g.paidStake ?? g.bet) + Math.max(0, g.winRoom) <= (g.settings?.maxWin ? g.bet + g.settings.maxWin : Infinity)
    ? `today's win limit (**+${fmtNum(g.settings.dailyWinCap)} XP** a day)`
    : `this server's max win of **${fmtNum(g.settings.maxWin)} XP**`;
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

// ---------------------------------------------------------------- Daily play limit

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const nextUtcMidnight = () => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
};

/**
 * Uses one of today's plays in a single atomic update (so spamming can't slip past the limit).
 * Returns { ok, left } — left is null when there's no limit — or { ok: false } when out of plays.
 */
async function takeDailyPlay(guildId, userId, limit) {
  if (!limit) return { ok: true, left: null };
  const day = utcDay();
  const updated = await UserLevel.findOneAndUpdate(
    { guildId, userId, $or: [{ gambleDay: { $ne: day } }, { gamblesToday: { $lt: limit } }] },
    [
      {
        $set: {
          gamblesToday: { $cond: [{ $eq: ['$gambleDay', day] }, { $add: [{ $ifNull: ['$gamblesToday', 0] }, 1] }, 1] },
          gambleDay: day
        }
      }
    ],
    { new: true, projection: { gamblesToday: 1 } }
  );
  if (updated) return { ok: true, left: Math.max(0, limit - updated.gamblesToday) };
  // No record at all means they've never earned XP — let the bet itself explain that.
  const exists = await UserLevel.exists({ guildId, userId });
  return exists ? { ok: false } : { ok: true, left: null, untracked: true };
}

// Gives a play back when the bet didn't go ahead after all.
async function returnDailyPlay(guildId, userId) {
  await UserLevel.updateOne({ guildId, userId, gambleDay: utcDay(), gamblesToday: { $gt: 0 } }, { $inc: { gamblesToday: -1 } }).catch(() => null);
}

// Daily win cap: net XP won today (wins minus losses). Anyone this far ahead can't gamble again until
// midnight UTC, and a game never pays more than what's left — so gambling can't skip days of levels.
async function recordNet(guildId, userId, net) {
  if (!net) return;
  const day = utcDay();
  await UserLevel.updateOne({ guildId, userId }, [
    {
      $set: {
        gambleNetToday: { $cond: [{ $eq: ['$gambleWinDay', day] }, { $add: [{ $ifNull: ['$gambleNetToday', 0] }, net] }, net] },
        gambleWinDay: day
      }
    }
  ]).catch((err) => console.error('Failed to record gambling result:', err.message));
}

const netToday = (record) => (record?.gambleWinDay === utcDay() ? record.gambleNetToday || 0 : 0);

function winCapText(settings, net) {
  if (!settings.dailyWinCap || net === null || net === undefined) return '';
  if (net >= settings.dailyWinCap) return `🏦 **Daily win limit reached** (+${fmtNum(settings.dailyWinCap)} XP) — you can gamble again <t:${Math.floor(nextUtcMidnight() / 1000)}:R>.`;
  return net > 0 ? `🏦 Won today: **+${fmtNum(net)}** / ${fmtNum(settings.dailyWinCap)} XP` : '';
}

// Daily plays for this member: boosters get extra (0 stays unlimited).
const dailyLimitFor = (settings, member) =>
  settings.dailyLimit && settings.booster?.enabled && member?.premiumSince ? settings.dailyLimit + settings.booster.extraGambles : settings.dailyLimit;

const playsLeftText = (left) => (left === null || left === undefined ? '' : `🎲 **${left}** play${left === 1 ? '' : 's'} left today`);

// ---------------------------------------------------------------- Free play (going broke)

/**
 * When a loss leaves the player below the minimum bet, give them one free play (a bet of
 * settings.freePlay.amount that costs them nothing) — at most once per cooldown so it can't be
 * farmed. Returns { granted, nextAt } (nextAt = when the next one could be given, if on cooldown).
 */
async function maybeGrantFreePlay(guildId, userId, settings, balance) {
  const fp = settings.freePlay;
  if (!fp.enabled || balance.xp >= settings.minBet) return { granted: false };
  const cutoff = new Date(Date.now() - fp.cooldownMs);
  const res = await UserLevel.updateOne(
    {
      guildId,
      userId,
      $and: [
        { $or: [{ freePlays: { $exists: false } }, { freePlays: { $lt: 1 } }] },
        { $or: [{ lastFreePlayGrantedAt: null }, { lastFreePlayGrantedAt: { $lte: cutoff } }] }
      ]
    },
    { $set: { freePlays: 1, lastFreePlayGrantedAt: new Date() } }
  );
  if (res.modifiedCount === 1) return { granted: true };
  const record = await UserLevel.findOne({ guildId, userId }, { freePlays: 1, lastFreePlayGrantedAt: 1 }).lean();
  if (record?.freePlays > 0) return { granted: false, pending: true };
  const last = record?.lastFreePlayGrantedAt ? new Date(record.lastFreePlayGrantedAt).getTime() : null;
  return { granted: false, nextAt: last ? last + fp.cooldownMs : null };
}

// Uses up the player's free play, atomically (so two commands can't both spend it).
async function consumeFreePlay(guildId, userId) {
  const res = await UserLevel.updateOne({ guildId, userId, freePlays: { $gt: 0 } }, { $inc: { freePlays: -1 } });
  return res.modifiedCount === 1;
}

// Gives an unused free play back (game refunded by a restart or timeout).
async function restoreFreePlay(guildId, userId) {
  await UserLevel.updateOne({ guildId, userId }, { $set: { freePlays: 1 } }).catch(() => null);
}

function freePlayText(outcome, settings) {
  if (!outcome) return '';
  if (outcome.granted) {
    return `🎟️ **You're out of XP — here's a free play!** Your next \`/gamble\` is a **${fmtNum(settings.freePlay.amount)} XP** bet on the house.`;
  }
  if (outcome.pending) return '🎟️ You still have an unused **free play** — your next `/gamble` uses it.';
  if (outcome.nextAt) return `🎟️ You're out of XP. Your next free play unlocks <t:${Math.floor(outcome.nextAt / 1000)}:R> — or chat to earn more.`;
  return '';
}

// Settles a finished interactive game: records the net result (against what the player actually
// staked — free plays cost nothing), their fresh balance, and a free play if they went broke.
async function settle(game, returned) {
  game.net = returned - (game.paidStake ?? game.bet);
  await recordNet(game.guildId, game.userId, game.net);
  if (game.startNet !== null && game.startNet !== undefined) game.netToday = game.startNet + game.net;
  game.balance = await fetchBalance(game.guildId, game.userId);
  if (game.net < 0 || (game.freePlay && returned === 0)) {
    game.freePlayNote = freePlayText(await maybeGrantFreePlay(game.guildId, game.userId, game.settings, game.balance), game.settings);
  }
}

// Text shown under a finished game: balance line plus any free-play notice.
function settledText(game) {
  return [balanceText(game.balance, game.net), game.freePlayNote, playsLeftText(game.playsLeft), winCapText(game.settings, game.netToday)].filter(Boolean).join('\n');
}

// Returns the player's stake after a refund: their own XP, and their free play if it was one.
async function refundStake(game) {
  if (!(await game.claim)) {
    game.alreadySettled = true;
    return;
  }
  if (game.paidStake > 0) await payout(game.guild, game.userId, game.paidStake, game.config);
  if (game.freePlay) await restoreFreePlay(game.guildId, game.userId);
}
const refundWord = (game) => (game.freePlay && !game.paidStake ? 'your free play was given back' : 'your bet was refunded');

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
// Game commands acknowledge Discord straight away ("thinking…") because placing a bet takes several
// database round trips, and Discord drops any interaction not answered within 3 seconds — which used to
// leave the XP taken with no game on screen.
async function acknowledge(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply();
}

// Public reply that works whether or not the command was deferred.
function respond(interaction, payload) {
  return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload);
}

// Private error message; replaces the public "thinking…" placeholder if there is one.
async function replyPrivately(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    await interaction.deleteReply().catch(() => null);
    return interaction.followUp({ content, ephemeral: true });
  }
  return interaction.reply({ content, ephemeral: true });
}

async function placeBet(interaction, bet) {
  const config = await getOrCreateConfig(interaction.guildId);
  const settings = getGamblingSettings(config);
  const { levelXpBase } = getEffectiveXpSettings(config);
  const fail = (content) => replyPrivately(interaction, content).then(() => null);

  if (!settings.enabled) return fail('❌ XP gambling is disabled on this server.');
  if (settings.channelId && interaction.channelId !== settings.channelId) {
    return fail(`❌ Gambling is only allowed in <#${settings.channelId}>.`);
  }
  if (bet < settings.minBet) return fail(`❌ The minimum bet is **${settings.minBet} XP**.`);
  if (settings.maxBet && bet > settings.maxBet) return fail(`❌ The maximum bet is **${settings.maxBet} XP**.`);

  const record = await UserLevel.findOne(
    { guildId: interaction.guildId, userId: interaction.user.id },
    { xp: 1, freePlays: 1, gambleWinDay: 1, gambleNetToday: 1 }
  ).lean();
  const startNet = settings.dailyWinCap ? netToday(record) : null;
  if (startNet !== null && startNet >= settings.dailyWinCap) {
    return fail(
      `🏦 You've won **+${fmtNum(startNet)} XP** from gambling today — that's this server's daily limit (+${fmtNum(settings.dailyWinCap)}). ` +
        `You can gamble again <t:${Math.floor(nextUtcMidnight() / 1000)}:R>. Chatting still earns XP!`
    );
  }
  const winRoom = startNet !== null ? settings.dailyWinCap - startNet : null;

  const limit = dailyLimitFor(settings, interaction.member);
  const daily = await takeDailyPlay(interaction.guildId, interaction.user.id, limit);
  if (!daily.ok) {
    const perk =
      limit === settings.dailyLimit && settings.booster?.enabled && settings.booster.extraGambles
        ? `\n-# 💎 Server boosters get **+${settings.booster.extraGambles}** gambles a day.`
        : '';
    return fail(`🎲 You've used all **${limit}** gambles for today. You can play again <t:${Math.floor(nextUtcMidnight() / 1000)}:R>.${perk}`);
  }
  const giveBack = () => (daily.left !== null ? returnDailyPlay(interaction.guildId, interaction.user.id) : null);
  const extra = { playsLeft: daily.left, winRoom, startNet };

  // A player holding a free play who can't cover this bet plays it for free instead.
  if (record?.freePlays > 0 && (record.xp ?? 0) < bet && settings.freePlay.enabled) {
    if (await consumeFreePlay(interaction.guildId, interaction.user.id)) {
      return { config, settings, bet: settings.freePlay.amount, freePlay: true, paidStake: 0, ...extra };
    }
  }

  const debited = await debitXp(interaction.guildId, interaction.user.id, bet, levelXpBase);
  if (!debited) {
    await giveBack();
    const status = freePlayText(await maybeGrantFreePlay(interaction.guildId, interaction.user.id, settings, { xp: record?.xp ?? 0 }), settings);
    return fail(`❌ You don't have **${fmtNum(bet)} XP** to bet. Check your balance with \`/levels rank\`.${status ? `\n${status}` : ''}`);
  }

  return { config, settings, bet, freePlay: false, paidStake: bet, ...extra };
}

const freePlayBanner = (ctx) =>
  ctx.freePlay ? `🎟️ **Free play!** This **${fmtNum(ctx.bet)} XP** bet is on the house — you keep any winnings.` : '';

async function payout(guild, userId, amount, config) {
  if (amount <= 0) return null;
  return adjustXp(guild, userId, amount, config);
}

// ---------------------------------------------------------------- Instant games (coinflip, dice, limbo)

/**
 * One-shot games: take the bet, run `round(ctx)` → { title, won, multiplier, betLine, resultLine },
 * pay out (respecting the max-win and daily win caps) and post the result with the balance.
 */
async function playInstant(interaction, bet, round) {
  await acknowledge(interaction);
  const ctx = await placeBet(interaction, bet);
  if (!ctx) return;
  bet = ctx.bet;

  const r = round(ctx);
  const uncapped = r.won ? Math.floor(bet * r.multiplier) : 0;
  const winnings = capReturn(ctx, uncapped);
  const levelResult = await payout(interaction.guild, interaction.user.id, winnings, ctx.config);
  const balance = await fetchBalance(interaction.guildId, interaction.user.id);
  const net = winnings - ctx.paidStake;
  await recordNet(interaction.guildId, interaction.user.id, net);
  const capText = winCapText(ctx.settings, ctx.startNet !== null ? ctx.startNet + net : null);
  const freeNote = net < 0 || (ctx.freePlay && !r.won)
    ? freePlayText(await maybeGrantFreePlay(interaction.guildId, interaction.user.id, ctx.settings, balance), ctx.settings)
    : '';

  const embed = new EmbedBuilder()
    .setTitle(r.title)
    .setColor(r.won ? '#57F287' : '#ED4245')
    .setDescription(
      (ctx.freePlay ? `${freePlayBanner(ctx)}\n` : '') +
        `${interaction.user} bet **${fmtNum(bet)} XP** ${r.betLine}.\n` +
        (r.resultLine ? `${r.resultLine}\n` : '') +
        (r.won
          ? `✅ You won **${fmtNum(winnings)} XP** (${fmtMult(r.multiplier)}).${winnings < uncapped ? `\n🏁 Capped by ${capLabel(ctx)}.` : ''}`
          : ctx.freePlay
            ? '❌ No luck this time — it was a free play, so you lost nothing.'
            : `❌ You lost **${fmtNum(bet)} XP**.`) +
        levelNote(levelResult) +
        `\n\n${balanceText(balance, net)}${freeNote ? `\n${freeNote}` : ''}${ctx.playsLeft !== null && ctx.playsLeft !== undefined ? `\n${playsLeftText(ctx.playsLeft)}` : ''}${capText ? `\n${capText}` : ''}`
    );
  return respond(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
}

function playCoinflip(interaction, bet, side) {
  return playInstant(interaction, bet, (ctx) => {
    const result = randInt(2) === 0 ? 'heads' : 'tails';
    return {
      title: `🪙 Coinflip — ${result === 'heads' ? 'Heads' : 'Tails'}!`,
      won: result === side,
      multiplier: 2 * (1 - ctx.settings.edge),
      betLine: `on **${side}**`
    };
  });
}

// Dice: roll 0.00–99.99. "under T" wins below T (T% chance); "over T" wins at T or higher ((100 − T)%).
// Pays (1 − edge) × 100 ÷ chance, so every target returns the same on average.
const DICE_MIN_CHANCE = 1;
const DICE_MAX_CHANCE = 95;
const diceChance = (target, direction) => (direction === 'over' ? 100 - target : target);
const diceMultiplier = (chance, edge) => ((1 - edge) * 100) / chance;

function diceProblem(target, direction) {
  const chance = diceChance(target, direction);
  if (!Number.isFinite(target) || chance < DICE_MIN_CHANCE || chance > DICE_MAX_CHANCE) {
    return direction === 'over'
      ? `❌ For **over**, pick a target from **${100 - DICE_MAX_CHANCE}** to **${100 - DICE_MIN_CHANCE}** (a ${DICE_MIN_CHANCE}–${DICE_MAX_CHANCE}% chance).`
      : `❌ For **under**, pick a target from **${DICE_MIN_CHANCE}** to **${DICE_MAX_CHANCE}** (a ${DICE_MIN_CHANCE}–${DICE_MAX_CHANCE}% chance).`;
  }
  return null;
}

function playDice(interaction, bet, target = 50, direction = 'under') {
  target = Math.round(target * 100) / 100;
  const problem = diceProblem(target, direction);
  if (problem) return interaction.reply({ content: problem, ephemeral: true });
  return playInstant(interaction, bet, (ctx) => {
    const roll = randInt(10000) / 100;
    const won = direction === 'over' ? roll >= target : roll < target;
    const chance = diceChance(target, direction);
    const bar = diceBar(roll, target, direction);
    return {
      title: `🎲 Dice — rolled ${roll.toFixed(2)}`,
      won,
      multiplier: diceMultiplier(chance, ctx.settings.edge),
      betLine: `on **${direction} ${target.toFixed(2)}** (${chance.toFixed(2).replace(/\.00$/, '')}% chance)`,
      resultLine: bar
    };
  });
}

// A 20-segment track: 🟩 winning range, 🟥 losing range, ⚪ where the roll landed.
function diceBar(roll, target, direction) {
  const cells = [];
  for (let i = 0; i < 20; i++) {
    const mid = i * 5 + 2.5;
    const win = direction === 'over' ? mid >= target : mid < target;
    cells.push(win ? '🟩' : '🟥');
  }
  cells[Math.min(19, Math.floor(roll / 5))] = '⚪';
  return `\`0\` ${cells.join('')} \`100\``;
}

// Limbo: pick a target multiplier. The result is (1 − edge) ÷ U for a uniform U, so it reaches any
// target t with probability (1 − edge) ÷ t — hit it (or beat it) and you're paid t × your bet.
const LIMBO_MIN = 1.01;
const LIMBO_MAX = 1000;
const limboChance = (target, edge) => (1 - edge) / target;

function playLimbo(interaction, bet, target = 2) {
  target = Math.round(target * 100) / 100;
  if (!Number.isFinite(target) || target < LIMBO_MIN || target > LIMBO_MAX) {
    return interaction.reply({ content: `❌ Pick a target from **${LIMBO_MIN}x** to **${fmtNum(LIMBO_MAX)}x**.`, ephemeral: true });
  }
  return playInstant(interaction, bet, (ctx) => {
    const u = (randInt(100000000) + 1) / 100000000; // (0, 1]
    const raw = (1 - ctx.settings.edge) / u;
    const result = Math.max(1, Math.floor(raw * 100) / 100);
    const won = result >= target;
    const shown = result >= 1e6 ? `${fmtNum(Math.floor(result))}x` : `${result.toFixed(2)}x`;
    return {
      title: `🚀 Limbo — ${shown}`,
      won,
      multiplier: target,
      betLine: `on **${target.toFixed(2)}x** (${(limboChance(target, ctx.settings.edge) * 100).toFixed(2)}% chance)`,
      resultLine: won ? `🚀 Flew to **${shown}** — past your **${target.toFixed(2)}x**!` : `💥 Stopped at **${shown}** — short of your **${target.toFixed(2)}x**.`
    };
  });
}

// ---------------------------------------------------------------- Shared game lifecycle

function startGame(interaction, game, ctx) {
  game.id = crypto.randomBytes(6).toString('hex');
  game.settings = ctx.settings;
  game.freePlay = !!ctx.freePlay;
  game.paidStake = ctx.paidStake;
  game.playsLeft = ctx.playsLeft;
  game.winRoom = ctx.winRoom;
  game.startNet = ctx.startNet;
  game.userId = interaction.user.id;
  game.guildId = interaction.guildId;
  game.guild = interaction.guild;
  game.finished = false;
  game.busy = false;
  activeGames.set(game.id, game);
  activeByUser.set(`${game.guildId}:${game.userId}`, game.id);
  touchGame(game);
  // Persist the stake so a crash or redeploy mid-game can refund it.
  // Writes are chained through game.betWrite so create → update → delete always land in order
  // (a delete racing ahead of its create would leave a stray record that gets refunded later).
  game.betWrite = ActiveBet.create({
    gameId: game.id,
    guildId: game.guildId,
    userId: game.userId,
    kind: game.kind,
    amount: game.bet,
    paidAmount: game.paidStake,
    freePlay: game.freePlay,
    channelId: interaction.channelId
  })
    .then(() => {
      game.betRecorded = true;
    })
    .catch((err) => console.error('Failed to record active bet:', err.message));
  return game;
}

// ---------------------------------------------------------------- Spectators vs. the player
// Everyone can watch a game live on its public message, but every button there is disabled, so
// nobody else can press anything. The player drives the game from a private copy (only they see it).

const toJSON = (c) => (c && typeof c.toJSON === 'function' ? c.toJSON() : c);

function disableButtons(node) {
  if (Array.isArray(node)) return node.map(disableButtons);
  if (!node || typeof node !== 'object') return node;
  const out = { ...node };
  if (out.type === ComponentType.Button && out.style !== ButtonStyle.Link) out.disabled = true;
  if (out.components) out.components = disableButtons(out.components.map(toJSON));
  if (out.accessory) out.accessory = disableButtons(toJSON(out.accessory));
  return out;
}

const isV2 = (payload) => ((payload.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;

// Adds a small line of text under the game (a TextDisplay for Components V2 messages, content otherwise).
function withNote(payload, note) {
  if (isV2(payload)) return { ...payload, components: [...(payload.components || []).map(toJSON), { type: ComponentType.TextDisplay, content: note }] };
  return { ...payload, content: note };
}

// Once the game is over the note goes away (edits keep old text unless content is cleared explicitly).
const clearNote = (payload) => (isV2(payload) ? payload : { ...payload, content: payload.content ?? null });

function spectatorView(game, payload) {
  const view = { ...payload, components: disableButtons((payload.components || []).map(toJSON)), allowedMentions: { parse: [] } };
  return game.finished ? clearNote(view) : withNote(view, `-# 👀 Watching live — only <@${game.userId}> can play this game.`);
}

function playerView(game, payload) {
  return game.finished
    ? clearNote(payload)
    : withNote(payload, '-# 🎮 Your controls — only you can see these buttons. Everyone else watches the public board. Dismissed them? `/gamble resume` brings them back.');
}

/** Posts a new game: the public (watch-only) board, then the player's private controls. */
async function showGame(interaction, game) {
  const payload = game.render();
  try {
    await respond(interaction, spectatorView(game, payload));
  } catch (err) {
    // The board couldn't be posted (Discord rejected it or the interaction expired): don't leave the
    // player locked out with their XP gone — end the game and give the stake back right away.
    console.error('Could not post game board:', err.message);
    await abortGame(game);
    await interaction
      .followUp({ content: `⚠️ Your game couldn't be shown, so it was cancelled — ${refundWord(game)}.`, ephemeral: true })
      .catch(() => null);
    return;
  }
  game.message = await interaction.fetchReply().catch(() => null);
  if (game.finished) return; // e.g. a blackjack natural settles straight away
  const flags = (payload.flags ?? 0) | MessageFlags.Ephemeral;
  let controls = null;
  try {
    controls = await interaction.followUp({ ...playerView(game, payload), flags });
  } catch (err) {
    console.error('Could not send private game controls:', err.message);
  }
  if (controls) {
    game.editControls = (p) => interaction.webhook.editMessage(controls, playerView(game, p));
  } else if (game.message) {
    // Couldn't send the private copy — fall back to playable buttons on the public message.
    await game.message.edit(payload).catch(() => null);
    game.publicControls = true;
  }
}

/** Shows a state change on both copies (used when the bot itself ends a game: idle timeout, restart). */
async function syncViews(game, payload) {
  if (!payload) return;
  if (game.message) await game.message.edit(game.publicControls ? payload : spectatorView(game, payload)).catch(() => null);
  if (game.editControls) await game.editControls(payload).catch(() => null);
}

function touchGame(game) {
  clearTimeout(game.timer);
  game.lastActive = Date.now();
  game.timer = setTimeout(() => expireGame(game).catch(console.error), IDLE_TIMEOUT_MS);
  // Keep the stored bet's timestamp fresh (at most once a minute) so the orphan sweep never
  // mistakes a game that's still being played for an abandoned one.
  if (game.betRecorded && Date.now() - (game.lastPersisted || 0) > 60000) {
    game.lastPersisted = Date.now();
    game.betWrite = Promise.resolve(game.betWrite).then(() =>
      ActiveBet.updateOne({ gameId: game.id }, { $set: { lastActiveAt: new Date() } }).catch(() => null)
    );
  }
}

function endGame(game) {
  game.finished = true;
  clearTimeout(game.timer);
  // Settling "claims" the stored bet by deleting it. If another copy of the bot (e.g. the new one
  // during a redeploy) already refunded it, the claim fails and this game pays nothing — so a stake is
  // never paid back twice. If the bet was never recorded, there's nothing to race against.
  game.claim = Promise.resolve(game.betWrite).then(async () => {
    if (!game.betRecorded) return true;
    try {
      return !!(await ActiveBet.findOneAndDelete({ gameId: game.id }));
    } catch (err) {
      console.error('Failed to clear active bet:', err.message);
      return true; // can't tell — pay rather than risk losing the player's XP
    }
  });
  game.betWrite = game.claim;
  activeGames.delete(game.id);
  if (activeByUser.get(`${game.guildId}:${game.userId}`) === game.id) {
    activeByUser.delete(`${game.guildId}:${game.userId}`);
  }
}

// Pays XP out of a finished game, unless its bet was already settled elsewhere.
async function gamePayout(game, amount) {
  if (!(await game.claim)) {
    game.alreadySettled = true;
    return null;
  }
  return payout(game.guild, game.userId, amount, game.config);
}

/**
 * The player's game that's still running, or null. Also heals stale state: a lock pointing at a game
 * that no longer exists is cleared, and a game idle past its timeout (a lost timer) is ended now.
 */
async function currentGame(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const game = activeGames.get(activeByUser.get(key));
  if (!game || game.finished) {
    activeByUser.delete(key);
    return null;
  }
  if (Date.now() - (game.lastActive || 0) > IDLE_TIMEOUT_MS) {
    await expireGame(game).catch(console.error);
    return null;
  }
  return game;
}

async function busyReply(interaction, game) {
  const endsAt = Math.floor(((game.lastActive || Date.now()) + IDLE_TIMEOUT_MS) / 1000);
  const where = game.message?.url ? `[your ${game.kind} game](${game.message.url})` : `your ${game.kind} game`;
  return interaction.reply({
    content: `❌ Finish ${where} first — it ends by itself <t:${endsAt}:R> if you leave it. Lost your buttons? Press below. Stuck? \`/gamble sync\`.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gctl:${game.id}`).setLabel('Show my controls').setEmoji('🎮').setStyle(ButtonStyle.Primary)
      )
    ],
    ephemeral: true
  });
}

/**
 * Re-sends the player's private controls (e.g. after they dismissed them). The new copy becomes
 * the one the bot keeps updated. Used by /gamble resume and the "Show my controls" button.
 */
async function resendControls(interaction, game = null) {
  game = game || (await currentGame(interaction.guildId, interaction.user.id));
  if (!game) return interaction.reply({ content: "You don't have a game running — start one with `/gamble`.", ephemeral: true });
  if (game.userId !== interaction.user.id) return interaction.reply({ content: "🙅 This isn't your game.", ephemeral: true });
  if (game.publicControls) {
    return interaction.reply({ content: `Your game's buttons are on [the board](${game.message?.url || 'https://discord.com'}).`, ephemeral: true });
  }
  touchGame(game);
  const payload = game.render();
  await interaction.reply({ ...playerView(game, payload), flags: (payload.flags ?? 0) | MessageFlags.Ephemeral });
  game.editControls = (p) => interaction.editReply(playerView(game, p));
}

async function handleControlsButton(interaction) {
  const game = activeGames.get(interaction.customId.split(':')[1]);
  if (!game || game.finished) return interaction.reply({ content: '⌛ That game is already over.', ephemeral: true });
  return resendControls(interaction, game);
}

const EXPIRE_NOTES = {
  idle: { stand: '⏰ Auto-stood after inactivity.', cash: '⏰ Auto-cashed out after inactivity.', refund: 'Timed out before any move' },
  sync: { stand: '🔧 Ended with /gamble sync — auto-stood.', cash: '🔧 Ended with /gamble sync — cashed out.', refund: 'Ended with /gamble sync' }
};

async function expireGame(game, reason = 'idle') {
  if (game.finished) return null;
  const notes = EXPIRE_NOTES[reason];
  let rendered;
  if (game.onExpire) {
    rendered = await game.onExpire(notes.stand);
  } else if (game.canCashOut()) {
    rendered = await cashOut(game, notes.cash);
  } else {
    // Nothing won yet — refund the bet instead of eating it.
    endGame(game);
    await refundStake(game);
    await settle(game, game.paidStake);
    game.status = 'refunded';
    rendered = game.render(`⏰ ${notes.refund} — ${refundWord(game)}.`);
  }
  await syncViews(game, rendered);
  return game;
}

// Ends a game whose board never made it to Discord, returning the stake.
async function abortGame(game) {
  if (game.finished) return;
  endGame(game);
  await refundStake(game);
  if (game.playsLeft !== null && game.playsLeft !== undefined) await returnDailyPlay(game.guildId, game.userId);
  game.status = 'refunded';
}

async function cashOut(game, note = '') {
  endGame(game);
  const uncapped = Math.floor(game.bet * game.currentMultiplier());
  const winnings = capReturn(game, uncapped);
  if (winnings < uncapped) note = `${note ? `${note}\n` : ''}🏁 Capped by ${capLabel(game)}.`;
  const levelResult = await gamePayout(game, winnings);
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

// "1 gem 1.09x · 2 → 1.25x · 3 → 1.43x · 5 → 1.94x · all 22 → 2,331x", starting from the next gem.
function minesLadder(mineCount, edge, revealed = 0) {
  const safe = GRID_SIZE - mineCount;
  const steps = [...new Set([1, 2, 3, 5, 8, 12, safe].map((n) => Math.max(n, revealed + 1)).filter((n) => n <= safe))].slice(0, 5);
  const fmt = (m) => (m >= 1000 ? Math.round(m).toLocaleString() : m.toFixed(2)) + 'x';
  return steps.map((n) => `${n === safe ? `all ${n}` : n} gem${n === 1 ? '' : 's'} ${fmt(minesMultiplier(n, mineCount, edge))}`).join(' · ');
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
  // The payout ladder for this mine count — more mines, steeper ladder.
  if (!over) header += `\n-# ${minesLadder(game.mineCount, game.edge, game.revealed.size)}`;
  if (!over) {
    header +=
      `\n**Current:** ${fmtMult(game.revealed.size > 0 ? game.currentMultiplier() : 0)}` +
      (safeLeft > 0 ? ` · **Next gem:** ${fmtMult(next)}` : '');
  }
  if (game.status === 'lost') header += `\n💥 You hit a mine and lost **${game.bet} XP**.`;
  if (note) header += `\n${note}`;
  if (game.freePlay && !game.balance) header += `\n${freePlayBanner(game)}`;
  if (game.balance) header += `\n\n${settledText(game)}`;

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
  const running = await currentGame(interaction.guildId, interaction.user.id);
  if (running) return busyReply(interaction, running);
  await acknowledge(interaction);
  const ctx = await placeBet(interaction, bet);
  if (!ctx) return;

  const game = startGame(interaction, createMinesGame(ctx.bet, mineCount, ctx.config, ctx.settings), ctx);
  await showGame(interaction, game);
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
  // Nothing more to win past the server's cap — bank it rather than risk a mine for nothing.
  if (hitCap(game)) return interaction.update(await cashOut(game, `🏁 Reached ${capLabel(game)} — cashed out automatically.`));
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
  if (game.freePlay && !game.balance) lines.push(freePlayBanner(game));
  if (game.balance) lines.push('', settledText(game));

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
  const running = await currentGame(interaction.guildId, interaction.user.id);
  if (running) return busyReply(interaction, running);
  await acknowledge(interaction);
  const ctx = await placeBet(interaction, bet);
  if (!ctx) return;

  const game = startGame(interaction, createHighLowGame(ctx.bet, ctx.config, ctx.settings), ctx);
  await showGame(interaction, game);
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
  if (hitCap(game)) return interaction.update(await cashOut(game, `✅ ${cardLabel(next)} — correct!\n🏁 Reached ${capLabel(game)} — cashed out automatically.`));
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
  game.onExpire = async (note) => {
    // Idle hands stand automatically rather than forfeiting the bet.
    await resolveBlackjack(game, note);
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

  const uncapped = blackjackReturn(game, outcome);
  const returned = capReturn(game, uncapped);
  if (returned < uncapped) note = [note, `🏁 Capped by ${capLabel(game)}.`].filter(Boolean).join('\n');
  const levelResult = await gamePayout(game, returned);
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

  const text = [game.freePlay && !game.balance ? freePlayBanner(game) : '', note, game.note, game.balance ? settledText(game) : '']
    .filter(Boolean)
    .join('\n\n');
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
  const running = await currentGame(interaction.guildId, interaction.user.id);
  if (running) return busyReply(interaction, running);
  await acknowledge(interaction);
  const ctx = await placeBet(interaction, bet);
  if (!ctx) return;

  const game = startGame(interaction, createBlackjackGame(ctx.bet, ctx.config, ctx.settings), ctx);
  // A natural on either side settles immediately.
  if (isBlackjack(game.player) || isBlackjack(game.dealer)) await resolveBlackjack(game);
  await showGame(interaction, game);
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
    game.paidStake += game.bet; // doubling always costs the player's own XP, even on a free play
    game.bet *= 2;
    game.doubled = true;
    game.betWrite = Promise.resolve(game.betWrite).then(() =>
      ActiveBet.updateOne({ gameId: game.id }, { $set: { amount: game.bet, paidAmount: game.paidStake } }).catch(() => null)
    );
    game.player.push(game.shoe.pop());
    await resolveBlackjack(game);
    return interaction.update(game.render());
  }
  return interaction.deferUpdate();
}

// ---------------------------------------------------------------- Restarts

/**
 * Called on SIGTERM (Render redeploys/restarts): every open game is cashed out if it has winnings,
 * otherwise refunded, and its message is updated so the player knows what happened.
 */
async function settleAllForShutdown() {
  const games = [...activeGames.values()];
  await Promise.allSettled(
    games.map(async (game) => {
      if (game.finished) return;
      let rendered;
      if (game.kind === 'blackjack') {
        // Mid-hand blackjack can't be fairly finished for the player — give the stake back.
        endGame(game);
        await refundStake(game);
        await settle(game, game.paidStake);
        game.status = 'refunded';
        game.note = `🔧 The bot restarted mid-hand — ${refundWord(game)}.`;
        rendered = game.render();
      } else if (game.canCashOut()) {
        rendered = await cashOut(game, '🔧 The bot restarted — you were cashed out automatically.');
      } else {
        endGame(game);
        await refundStake(game);
        await settle(game, game.paidStake);
        game.status = 'refunded';
        rendered = game.render(`🔧 The bot restarted — ${refundWord(game)}.`);
      }
      await syncViews(game, rendered);
      await game.betWrite;
    })
  );
  return games.length;
}

/**
 * Called at startup: refunds stakes left behind by a crash (games that never settled) and tells
 * the player in the channel where they were playing.
 */
async function refundOrphanedBets(client) {
  // During a redeploy the old copy of the bot is still running (and will settle its own games), so
  // only refund bets that have sat untouched for a couple of minutes; the sweeper catches the rest.
  const orphans = await ActiveBet.find({ updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } }).lean();
  let refunded = 0;
  for (const bet of orphans) {
    if (await refundBetRecord(client, bet, 'the bot restarted during your')) refunded++;
  }
  return refunded;
}

/**
 * Refunds one stored bet whose game is gone (claimed atomically, so it's only ever paid once).
 * Returns the amount refunded, or null if it was already settled elsewhere.
 */
async function refundBetRecord(client, bet, why, { notify = true } = {}) {
  const claimed = await ActiveBet.findOneAndDelete({ _id: bet._id });
  if (!claimed) return null;
  const guild = client.guilds.cache.get(bet.guildId);
  if (!guild) return null;
  const paid = bet.paidAmount ?? bet.amount;
  try {
    if (paid > 0) await adjustXp(guild, bet.userId, paid);
    if (bet.freePlay) await restoreFreePlay(bet.guildId, bet.userId);
  } catch (err) {
    console.error(`Failed to refund bet ${bet.gameId}:`, err.message);
    return null;
  }
  if (notify) {
    const what = [paid > 0 ? `your **${fmtNum(paid)} XP** bet was refunded` : null, bet.freePlay ? 'your free play was given back' : null]
      .filter(Boolean)
      .join(' and ');
    const channel = bet.channelId ? guild.channels.cache.get(bet.channelId) : null;
    await channel
      ?.send({ content: `♻️ <@${bet.userId}> ${why} ${bet.kind} game — ${what}.`, allowedMentions: { users: [bet.userId] } })
      .catch(() => null);
  }
  return { paid, freePlay: !!bet.freePlay, kind: bet.kind, userId: bet.userId };
}

// A stored bet untouched for this long can't belong to a game that's still being played
// (games end after 3 idle minutes), even one running on another copy of the bot.
const ORPHAN_AFTER_MS = 10 * 60 * 1000;

/**
 * Safety net, run every minute: ends games whose idle timer was lost, clears stale "game in progress"
 * locks, and refunds stored bets whose game no longer exists anywhere.
 */
async function sweepStuckGames(client) {
  const now = Date.now();
  for (const game of [...activeGames.values()]) {
    if (!game.finished && now - (game.lastActive || 0) > IDLE_TIMEOUT_MS + 30000) await expireGame(game).catch(console.error);
  }
  for (const [key, id] of [...activeByUser]) {
    const game = activeGames.get(id);
    if (!game || game.finished) activeByUser.delete(key);
  }
  const stale = await ActiveBet.find({ updatedAt: { $lt: new Date(now - ORPHAN_AFTER_MS) } }).lean();
  for (const bet of stale) {
    if (!activeGames.has(bet.gameId)) await refundBetRecord(client, bet, 'your interrupted').catch(console.error);
  }
}

function startGameSweeper(client) {
  const timer = setInterval(() => sweepStuckGames(client).catch(console.error), 60 * 1000);
  timer.unref?.();
  return timer;
}

/**
 * /gamble sync: ends the given players' games right now (cashing out winnings, auto-standing
 * blackjack, or refunding) and refunds any stored bets left behind by games that no longer exist.
 * `userId` null = everyone in the server. Returns a summary of what was fixed.
 */
async function syncGames(client, guildId, userId = null) {
  const result = { ended: [], refunded: [], cleared: 0 };
  const mine = (g) => g.guildId === guildId && (!userId || g.userId === userId);

  for (const game of [...activeGames.values()].filter(mine)) {
    if (game.finished) continue;
    await expireGame(game, 'sync');
    result.ended.push({ userId: game.userId, kind: game.kind, status: game.status, amount: game.status === 'cashed' ? game.winnings : game.paidStake });
  }
  for (const [key, id] of [...activeByUser]) {
    const [g, u] = key.split(':');
    if (g !== guildId || (userId && u !== userId)) continue;
    const game = activeGames.get(id);
    if (!game || game.finished) {
      activeByUser.delete(key);
      result.cleared++;
    }
  }
  // Stored bets with no live game here. Skip brand-new ones (a game may be starting on another copy of the bot).
  const filter = { guildId, updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } };
  if (userId) filter.userId = userId;
  for (const bet of await ActiveBet.find(filter).lean()) {
    if (activeGames.has(bet.gameId)) continue;
    const refund = await refundBetRecord(client, bet, '', { notify: false });
    if (refund) result.refunded.push(refund);
  }
  return result;
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
  // The click came from the player's private controls: update those, and mirror the new state
  // onto the public board (buttons disabled) so everyone keeps watching live.
  const updateControls = interaction.update.bind(interaction);
  interaction.update = async (payload) => {
    const result = await updateControls(game.publicControls ? payload : playerView(game, payload));
    if (!game.publicControls && game.message) await game.message.edit(spectatorView(game, payload)).catch(() => null);
    return result;
  };
  if (!game.publicControls) game.editControls = (p) => interaction.editReply(playerView(game, p));
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
  dailyLimitFor,
  winCapText,
  minesMultiplier,
  minesLadder,
  pHigherOrSame,
  pLowerOrSame,
  playCoinflip,
  playDice,
  playLimbo,
  diceChance,
  diceMultiplier,
  limboChance,
  DICE_MIN_CHANCE,
  DICE_MAX_CHANCE,
  LIMBO_MIN,
  LIMBO_MAX,
  startMines,
  startHighLow,
  startBlackjack,
  settleAllForShutdown,
  refundOrphanedBets,
  handValue,
  blackjackReturn,
  handleGambleButton,
  handleControlsButton,
  resendControls,
  startGameSweeper,
  sweepStuckGames,
  syncGames,
  _test: { spectatorView, playerView, disableButtons }
};
