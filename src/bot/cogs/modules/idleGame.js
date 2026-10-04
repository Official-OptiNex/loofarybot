// The Bubble Factory: a no-gambling idle game. Your factory makes 🫧 Bubbles over time (even while
// you're away, up to an offline cap). You spend Bubbles on upgrades that make more Bubbles, and you
// cash Bubbles out to real XP — but only up to a daily cap, so it stays a gentle alternative to
// gambling and never makes levels crazy. All pure functions here are easy to test.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const IdleFactory = require('../../../database/models/IdleFactory');
const { getCachedConfig } = require('../../../database/configCache');

const HOUR = 3600000;

// The upgrade tree. `rate` adds bubbles/hour per level; `shine` is a +% multiplier per level; `tub`
// adds hours to the offline cap. Costs grow geometrically, so there's always a next goal.
const UPGRADES = [
  { id: 'scrubber', name: 'Scrubber', emoji: '🧽', baseCost: 100, growth: 1.55, rate: 30, blurb: '+30 🫧/hr' },
  { id: 'soap', name: 'Fancy Soap', emoji: '🧴', baseCost: 600, growth: 1.6, rate: 90, blurb: '+90 🫧/hr' },
  { id: 'jets', name: 'Jet Nozzles', emoji: '🚿', baseCost: 3000, growth: 1.65, rate: 260, blurb: '+260 🫧/hr' },
  { id: 'tub', name: 'Bigger Tub', emoji: '🛁', baseCost: 500, growth: 1.9, tub: 2, max: 12, blurb: '+2h offline storage' },
  { id: 'shine', name: 'Extra Shine', emoji: '✨', baseCost: 4000, growth: 2.0, shine: 10, max: 15, blurb: '+10% to all bubbles' }
];
const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

const fmt = (n) => Number(Math.round(n)).toLocaleString('en-US');
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function idleSettings(config) {
  const g = (config && config.idleGame) || {};
  const int = (v, d, min, max) => (Number.isFinite(Number(v)) && v !== null ? Math.min(Math.max(Math.round(Number(v)), min), max) : d);
  return {
    enabled: !!g.enabled,
    baseRate: int(g.baseRate, 60, 1, 100000), // bubbles/hour at level 0
    offlineHours: int(g.offlineHours, 8, 1, 72), // base offline accrual cap
    bubblesPerXp: int(g.bubblesPerXp, 10, 1, 100000), // bubbles needed for 1 XP at cash-out
    dailyXpCap: int(g.dailyXpCap, 300, 0, 100000) // most XP one member can cash out per UTC day
  };
}

// ---------------------------------------------------------------- Pure game maths

const levelOf = (state, id) => {
  const u = state?.upgrades;
  if (!u) return 0;
  return (u.get ? u.get(id) : u[id]) || 0; // Map (legacy) or plain object
};
function setLevel(state, id, level) {
  if (state.upgrades?.set) state.upgrades.set(id, level);
  else {
    state.upgrades = state.upgrades || {};
    state.upgrades[id] = level;
  }
  state.markModified?.('upgrades');
}

/** Cost of the next level of an upgrade (ceil of a geometric curve). */
function upgradeCost(id, level) {
  const u = UPGRADE_BY_ID[id];
  return Math.ceil(u.baseCost * Math.pow(u.growth, level));
}

/** Bubbles produced per hour, from the base rate, flat upgrades, and the shine multiplier. */
function ratePerHour(state, s) {
  let flat = s.baseRate;
  for (const u of UPGRADES) if (u.rate) flat += u.rate * levelOf(state, u.id);
  const shine = 1 + 0.1 * levelOf(state, 'shine');
  return Math.round(flat * shine);
}

/** How many hours of production the factory can bank while you're away. */
function offlineCapHours(state, s) {
  return s.offlineHours + 2 * levelOf(state, 'tub');
}

/** Bubbles waiting to be collected right now (capped by the offline window). */
function pendingBubbles(state, s, now = Date.now()) {
  if (!state.lastTick) return 0;
  const hours = Math.min((now - state.lastTick) / HOUR, offlineCapHours(state, s));
  return Math.max(0, Math.floor(hours * ratePerHour(state, s)));
}

/** XP a member may still cash out today (resets at UTC midnight). */
function xpLeftToday(state, s, now = Date.now()) {
  const used = state.cashoutDay === dayKey(now) ? state.cashoutXpToday || 0 : 0;
  return Math.max(0, s.dailyXpCap - used);
}

// ---------------------------------------------------------------- Loading / actions

async function getFactory(guildId, userId) {
  let doc = await IdleFactory.findOne({ guildId, userId });
  if (!doc) doc = await IdleFactory.create({ guildId, userId, lastTick: Date.now() });
  return doc;
}

/** Banks pending bubbles into the factory and returns how many were collected. */
async function collect(guildId, userId, s, now = Date.now()) {
  const state = await getFactory(guildId, userId);
  const gained = pendingBubbles(state, s, now);
  state.bank += gained;
  state.lifetime += gained;
  state.lastTick = now;
  await state.save();
  return { state, gained };
}

/** Buys one level of an upgrade, paying from the bank. Spends collected bubbles only — the player
 * has to Collect their pending bubbles first (so the Collect step actually means something). */
async function buyUpgrade(guildId, userId, id, s) {
  const u = UPGRADE_BY_ID[id];
  if (!u) return { error: 'No such upgrade.' };
  const state = await getFactory(guildId, userId);
  const level = levelOf(state, id);
  if (u.max && level >= u.max) return { error: `${u.name} is already maxed (${u.max}).`, state };
  const cost = upgradeCost(id, level);
  if (state.bank < cost) return { error: `That costs ${fmt(cost)} 🫧 — you have ${fmt(state.bank)}.`, state, cost };
  state.bank -= cost;
  setLevel(state, id, level + 1);
  await state.save();
  return { state, bought: u, newLevel: level + 1, cost };
}

/**
 * Cashes bubbles out to real XP, up to the daily cap. `adjustXp` credits the XP (defaults to the
 * leveling module; injectable for tests). Returns { xp, spent, state } or { error }.
 */
async function cashout(guild, userId, s, { now = Date.now(), adjustXp = null } = {}) {
  const state = await getFactory(guild.id, userId);
  // Cash out collected bubbles only — pending bubbles must be Collected first.
  if (s.dailyXpCap <= 0) {
    await state.save();
    return { error: 'Cashing out is turned off on this server.', state };
  }
  const left = xpLeftToday(state, s, now);
  if (left <= 0) {
    await state.save();
    return { error: `You've hit today's cash-out cap (${fmt(s.dailyXpCap)} XP). It resets at midnight UTC.`, state };
  }
  const xp = Math.min(Math.floor(state.bank / s.bubblesPerXp), left);
  if (xp <= 0) {
    await state.save();
    return { error: `You need at least ${fmt(s.bubblesPerXp)} 🫧 to cash out 1 XP (you have ${fmt(state.bank)}).`, state };
  }
  const spent = xp * s.bubblesPerXp;
  state.bank -= spent;
  if (state.cashoutDay !== dayKey(now)) {
    state.cashoutDay = dayKey(now);
    state.cashoutXpToday = 0;
  }
  state.cashoutXpToday += xp;
  await state.save();
  const pay = adjustXp || require('./leveling').adjustXp;
  await pay(guild, userId, xp).catch((err) => console.error('[idle] XP cash-out failed:', err.message));
  return { xp, spent, state };
}

// ---------------------------------------------------------------- Embeds & buttons

function bar(current, max, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((max > 0 ? current / max : 0) * width)));
  return '🫧'.repeat(filled) + '▫️'.repeat(width - filled);
}

function factoryEmbed(state, s, { name, now = Date.now() } = {}) {
  const pending = pendingBubbles(state, s, now);
  const rate = ratePerHour(state, s);
  const capH = offlineCapHours(state, s);
  const left = xpLeftToday(state, s, now);
  const owned = UPGRADES.filter((u) => levelOf(state, u.id)).map((u) => `${u.emoji}×${levelOf(state, u.id)}`).join('  ') || 'none yet';
  const embed = new EmbedBuilder()
    .setColor('#4AB3F4')
    .setTitle(`🫧 ${name ? `${name}'s ` : ''}Bubble Factory`)
    .setDescription(
      `Your loofah makes bubbles around the clock. Spend them on upgrades, or cash them out for XP.\n` +
        `**${bar(pending, rate * capH)}**\n-# ${fmt(pending)} / ${fmt(rate * capH)} 🫧 waiting (full after ${capH}h away)`
    )
    .addFields(
      { name: '🫧 Bank', value: fmt(state.bank), inline: true },
      { name: '⚙️ Rate', value: `${fmt(rate)} / hr`, inline: true },
      { name: '📦 To collect', value: fmt(pending), inline: true },
      { name: '💧 Cash-out left today', value: s.dailyXpCap > 0 ? `${fmt(left)} XP` : 'off', inline: true },
      { name: '💱 Rate', value: s.dailyXpCap > 0 ? `${fmt(s.bubblesPerXp)} 🫧 = 1 XP` : '—', inline: true },
      { name: '🏭 Upgrades', value: owned, inline: false }
    );
  return embed;
}

const rowFor = (userId, s) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`idle:collect:${userId}`).setLabel('Collect').setEmoji('🫧').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`idle:upgrades:${userId}`).setLabel('Upgrades').setEmoji('⬆️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`idle:cashout:${userId}`).setLabel('Cash out → XP').setEmoji('💧').setStyle(ButtonStyle.Success).setDisabled(s.dailyXpCap <= 0),
    new ButtonBuilder().setCustomId(`idle:home:${userId}`).setLabel('↻').setStyle(ButtonStyle.Secondary)
  );

function upgradesView(state, s, userId, now = Date.now()) {
  const pending = pendingBubbles(state, s, now);
  const embed = new EmbedBuilder()
    .setColor('#4AB3F4')
    .setTitle('⬆️ Upgrades')
    .setDescription(
      `You have **${fmt(state.bank)} 🫧** to spend.` +
        (pending > 0 ? `\n-# 📦 ${fmt(pending)} 🫧 waiting — hit **← Back**, then **Collect**, to spend them.` : '')
    );
  const rows = [];
  let current = new ActionRowBuilder();
  for (const u of UPGRADES) {
    const level = levelOf(state, u.id);
    const maxed = u.max && level >= u.max;
    const cost = upgradeCost(u.id, level);
    embed.addFields({ name: `${u.emoji} ${u.name} — Lv ${level}${u.max ? `/${u.max}` : ''}`, value: maxed ? `Maxed · ${u.blurb}` : `${u.blurb} · next: **${fmt(cost)} 🫧**`, inline: true });
    current.addComponents(
      new ButtonBuilder()
        .setCustomId(`idle:up:${u.id}:${userId}`)
        .setLabel(maxed ? `${u.name} ✓` : `${u.name}`)
        .setEmoji(u.emoji)
        .setStyle(maxed ? ButtonStyle.Secondary : state.bank >= cost ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(maxed || state.bank < cost)
    );
    if (current.components.length === 5) {
      rows.push(current);
      current = new ActionRowBuilder();
    }
  }
  if (current.components.length) rows.push(current);
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`idle:home:${userId}`).setLabel('← Back').setStyle(ButtonStyle.Secondary)));
  return { embed, rows };
}

// ---------------------------------------------------------------- Interaction routing (idle:*)

async function handleIdleInteraction(interaction) {
  const [, action, a, b] = interaction.customId.split(':');
  const owner = action === 'up' ? b : a;
  if (owner !== interaction.user.id) {
    return interaction.reply({ content: '🫧 That’s someone else’s factory — open your own with `/idle`.', ephemeral: true }).catch(() => null);
  }
  const s = idleSettings(await getCachedConfig(interaction.guild.id));
  if (!s.enabled) return interaction.reply({ content: '🫧 The Bubble Factory is turned off here.', ephemeral: true }).catch(() => null);
  const name = interaction.member?.displayName || interaction.user.username;

  if (action === 'collect') {
    const { state, gained } = await collect(interaction.guild.id, interaction.user.id, s);
    // A little animation: the bar fills, then settles.
    await interaction.update({ embeds: [new EmbedBuilder().setColor('#4AB3F4').setTitle('🫧 Collecting…').setDescription(`**${bar(1, 3)}**`)], components: [] }).catch(() => null);
    await new Promise((r) => setTimeout(r, 450));
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#4AB3F4').setTitle('🫧 Collecting…').setDescription(`**${bar(3, 3)}**\n+${fmt(gained)} 🫧`)], components: [] }).catch(() => null);
    await new Promise((r) => setTimeout(r, 450));
    return interaction.editReply({ embeds: [factoryEmbed(state, s, { name })], components: [rowFor(interaction.user.id, s)] }).catch(() => null);
  }
  if (action === 'upgrades') {
    const state = await getFactory(interaction.guild.id, interaction.user.id);
    const { embed, rows } = upgradesView(state, s, interaction.user.id);
    return interaction.update({ embeds: [embed], components: rows }).catch(() => null);
  }
  if (action === 'up') {
    const res = await buyUpgrade(interaction.guild.id, interaction.user.id, a, s);
    const { embed, rows } = upgradesView(res.state, s, interaction.user.id);
    if (res.error) embed.setFooter({ text: `⚠️ ${res.error}` });
    else embed.setFooter({ text: `✅ ${res.bought.emoji} ${res.bought.name} is now level ${res.newLevel}.` });
    return interaction.update({ embeds: [embed], components: rows }).catch(() => null);
  }
  if (action === 'cashout') {
    const res = await cashout(interaction.guild, interaction.user.id, s);
    const embed = factoryEmbed(res.state, s, { name });
    embed.setFooter({ text: res.error ? `⚠️ ${res.error}` : `💧 Cashed out ${fmt(res.xp)} XP for ${fmt(res.spent)} 🫧.` });
    return interaction.update({ embeds: [embed], components: [rowFor(interaction.user.id, s)] }).catch(() => null);
  }
  // home / refresh — just re-render (no auto-collect; the Collect button banks pending)
  const state = await getFactory(interaction.guild.id, interaction.user.id);
  return interaction.update({ embeds: [factoryEmbed(state, s, { name })], components: [rowFor(interaction.user.id, s)] }).catch(() => null);
}

// ---------------------------------------------------------------- Leaderboard & settings

async function leaderboard(guild, { now = Date.now(), limit = 10 } = {}) {
  const s = idleSettings(await GuildConfig.findOne({ guildId: guild.id }).lean());
  const rows = await IdleFactory.find({ guildId: guild.id }).sort({ lifetime: -1 }).limit(limit).lean();
  return rows.map((r) => ({
    userId: r.userId,
    name: guild.members.cache.get(r.userId)?.displayName || null,
    lifetime: r.lifetime || 0,
    bank: r.bank || 0,
    rate: ratePerHour(r, s)
  }));
}

function cleanSettings(input) {
  const patch = {};
  const whole = (v, min, max, label) => {
    const n = Number.parseInt(v, 10);
    if (!(n >= min && n <= max)) throw new Error(`${label} must be ${min}–${max}.`);
    return n;
  };
  try {
    if (input.enabled !== undefined) patch['idleGame.enabled'] = !!input.enabled;
    if (input.baseRate !== undefined) patch['idleGame.baseRate'] = whole(input.baseRate, 1, 100000, 'Base rate');
    if (input.offlineHours !== undefined) patch['idleGame.offlineHours'] = whole(input.offlineHours, 1, 72, 'Offline storage (hours)');
    if (input.bubblesPerXp !== undefined) patch['idleGame.bubblesPerXp'] = whole(input.bubblesPerXp, 1, 100000, 'Bubbles per XP');
    if (input.dailyXpCap !== undefined) patch['idleGame.dailyXpCap'] = whole(input.dailyXpCap, 0, 100000, 'Daily XP cap');
  } catch (err) {
    return { error: err.message };
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch, error } = cleanSettings(input);
  if (error) return { error };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { idleGame: 1 }).lean();
  return { settings: idleSettings(fresh) };
}

module.exports = {
  UPGRADES,
  idleSettings,
  upgradeCost,
  ratePerHour,
  offlineCapHours,
  pendingBubbles,
  xpLeftToday,
  getFactory,
  collect,
  buyUpgrade,
  cashout,
  factoryEmbed,
  rowFor,
  upgradesView,
  handleIdleInteraction,
  leaderboard,
  cleanSettings,
  saveSettings
};
