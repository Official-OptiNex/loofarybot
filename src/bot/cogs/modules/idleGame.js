// The Bubble Factory: a no-gambling idle game. Your factory makes 🫧 Bubbles over time (even while
// you're away, up to an offline cap). You spend Bubbles on upgrades that make more Bubbles, and you
// cash Bubbles out to real XP — but only up to a daily cap, so it stays a gentle alternative to
// gambling and never makes levels crazy. All pure functions here are easy to test.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const IdleFactory = require('../../../database/models/IdleFactory');
const { getCachedConfig } = require('../../../database/configCache');

const HOUR = 3600000;

// The default upgrade tree. `rate` adds bubbles/hour per level; `shine` is a +% multiplier per level;
// `tub` adds hours to the offline cap. Costs grow geometrically, so there's always a next goal. Each
// upgrade's cost, effect strength, max level and whether it's available are configurable per server
// (see effectiveUpgrades / setUpgrade, /idle admin upgrade and the dashboard).
const DEFAULT_UPGRADES = [
  { id: 'scrubber', name: 'Scrubber', emoji: '🧽', baseCost: 100, growth: 1.55, rate: 30 },
  { id: 'soap', name: 'Fancy Soap', emoji: '🧴', baseCost: 600, growth: 1.6, rate: 90 },
  { id: 'jets', name: 'Jet Nozzles', emoji: '🚿', baseCost: 3000, growth: 1.65, rate: 260 },
  { id: 'tub', name: 'Bigger Tub', emoji: '🛁', baseCost: 500, growth: 1.9, tub: 2, max: 12 },
  { id: 'shine', name: 'Extra Shine', emoji: '✨', baseCost: 4000, growth: 2.0, shine: 10, max: 15 }
];
const DEFAULT_BY_ID = Object.fromEntries(DEFAULT_UPGRADES.map((u) => [u.id, u]));
// Which field carries an upgrade's effect magnitude.
const effectKey = (u) => ('rate' in u ? 'rate' : 'shine' in u ? 'shine' : 'tub' in u ? 'tub' : null);
function blurbFor(u) {
  if (u.rate !== undefined) return `+${u.rate} 🫧/hr`;
  if (u.shine !== undefined) return `+${u.shine}% to all bubbles`;
  if (u.tub !== undefined) return `+${u.tub}h offline storage`;
  return '';
}

const fmt = (n) => Number(Math.round(n)).toLocaleString('en-US');
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/** The upgrade tree for a guild: defaults merged with its per-upgrade overrides (cost, effect, max,
 * enabled). Returns every upgrade (including disabled ones) in the default order, with a fresh blurb. */
function effectiveUpgrades(config) {
  const ov = (config && config.idleGame && config.idleGame.upgradeConfig) || {};
  return DEFAULT_UPGRADES.map((def) => {
    const o = ov[def.id] || {};
    const u = { ...def, enabled: o.enabled !== false };
    if (Number.isFinite(Number(o.baseCost)) && Number(o.baseCost) > 0) u.baseCost = Math.round(Number(o.baseCost));
    if (Number.isFinite(Number(o.max)) && Number(o.max) > 0) u.max = Math.round(Number(o.max));
    const k = effectKey(def);
    if (k && Number.isFinite(Number(o.effect)) && Number(o.effect) >= 0) u[k] = Math.round(Number(o.effect));
    u.blurb = blurbFor(u);
    return u;
  });
}

function idleSettings(config) {
  const g = (config && config.idleGame) || {};
  const int = (v, d, min, max) => (Number.isFinite(Number(v)) && v !== null ? Math.min(Math.max(Math.round(Number(v)), min), max) : d);
  const all = effectiveUpgrades(config);
  const upgrades = all.filter((u) => u.enabled !== false); // the ones members can actually buy
  return {
    enabled: !!g.enabled,
    baseRate: int(g.baseRate, 60, 1, 100000), // bubbles/hour at level 0
    offlineHours: int(g.offlineHours, 8, 1, 72), // base offline accrual cap
    bubblesPerXp: int(g.bubblesPerXp, 10, 1, 100000), // bubbles needed for 1 XP at cash-out
    dailyXpCap: int(g.dailyXpCap, 300, 0, 100000), // most XP one member can cash out per UTC day
    fullAlerts: g.fullAlerts !== false, // DM a member once when their tub fills (default on)
    fullAlertChannelId: g.fullAlertChannelId || null, // fallback channel when DMs are closed
    upgrades,
    upgradeById: Object.fromEntries(upgrades.map((u) => [u.id, u])),
    allUpgrades: all // includes disabled ones, for the dashboard/admin views
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

/** Cost of the next level of an upgrade (ceil of a geometric curve). Uses the guild's effective
 * upgrade defs when given (via a settings object's upgradeById), else the defaults. */
function upgradeCost(id, level, byId = DEFAULT_BY_ID) {
  const u = (byId && byId[id]) || DEFAULT_BY_ID[id];
  return Math.ceil(u.baseCost * Math.pow(u.growth, level));
}

/** Bubbles produced per hour, from the base rate, flat upgrades, and the shine multiplier. */
function ratePerHour(state, s) {
  const list = s.upgrades || DEFAULT_UPGRADES;
  let flat = s.baseRate;
  for (const u of list) if (u.rate) flat += u.rate * levelOf(state, u.id);
  const shineDef = (s.upgradeById || DEFAULT_BY_ID).shine;
  const shine = 1 + ((shineDef?.shine ?? 10) / 100) * levelOf(state, 'shine');
  return Math.round(flat * shine);
}

/** How many hours of production the factory can bank while you're away. */
function offlineCapHours(state, s) {
  const tubDef = (s.upgradeById || DEFAULT_BY_ID).tub;
  return s.offlineHours + (tubDef?.tub ?? 2) * levelOf(state, 'tub');
}

/** Bubbles waiting to be collected right now (capped by the offline window). A paused/never-started
 * factory makes nothing — the member has to start it first with /idle start (or the Start button). */
function pendingBubbles(state, s, now = Date.now()) {
  if (!state.active || !state.lastTick) return 0;
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

/** Starts (or resumes) a member's factory so it begins making bubbles from now. */
async function startFactory(guildId, userId, now = Date.now()) {
  const state = await getFactory(guildId, userId);
  const already = state.active;
  state.active = true;
  state.lastTick = now; // accrual starts fresh — no back-pay for time spent paused
  state.fullNotified = false;
  await state.save();
  return { state, already };
}

/** Pauses a member's factory. Banked bubbles are kept; production stops until they start again. */
async function stopFactory(guildId, userId) {
  const state = await getFactory(guildId, userId);
  const already = !state.active;
  state.active = false;
  await state.save();
  return { state, already };
}

/** Banks pending bubbles into the factory and returns how many were collected. */
async function collect(guildId, userId, s, now = Date.now()) {
  const state = await getFactory(guildId, userId);
  const gained = pendingBubbles(state, s, now);
  state.bank += gained;
  state.lifetime += gained;
  state.lastTick = now;
  state.fullNotified = false; // the tub just drained — eligible for a fresh "full" alert later
  await state.save();
  return { state, gained };
}

/** Buys one level of an upgrade, paying from the bank. Spends collected bubbles only — the player
 * has to Collect their pending bubbles first (so the Collect step actually means something). */
async function buyUpgrade(guildId, userId, id, s) {
  const u = (s.upgradeById || DEFAULT_BY_ID)[id];
  if (!u) return { error: 'No such upgrade.' };
  const state = await getFactory(guildId, userId);
  const level = levelOf(state, id);
  if (u.max && level >= u.max) return { error: `${u.name} is already maxed (${u.max}).`, state };
  const cost = upgradeCost(id, level, s.upgradeById);
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

// ---------------------------------------------------------------- Admin actions (staff only)

/** Adds (delta > 0) or removes (delta < 0) bubbles from a member's bank. Granting also adds to
 * lifetime; taking never lowers lifetime. Bank can't go below 0. Returns the actual change. */
async function adminAdjustBubbles(guildId, userId, delta) {
  const amount = Math.round(Number(delta) || 0);
  const state = await getFactory(guildId, userId);
  const before = state.bank;
  state.bank = Math.max(0, state.bank + amount);
  const applied = state.bank - before;
  if (applied > 0) state.lifetime += applied;
  await state.save();
  return { state, applied };
}

/** Wipes a member's factory (bank, upgrades, lifetime) back to a fresh start. */
async function resetFactory(guildId, userId) {
  await IdleFactory.deleteOne({ guildId, userId });
}

// ---------------------------------------------------------------- "Tub is full" alerts

/** DMs a member once that their factory is full; falls back to the configured channel if DMs are
 * closed. Returns true if anything was delivered. */
async function notifyFull(client, guild, s, userId) {
  const body = `🫧 Your **Bubble Factory** in **${guild.name}** is **full** — run \`/idle play\` and hit **Collect** before you waste production!`;
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content: body });
    return true;
  } catch {
    const ch = s.fullAlertChannelId && guild.channels.cache.get(s.fullAlertChannelId);
    if (ch && ch.isTextBased?.()) {
      await ch.send({ content: `<@${userId}> ${body}`, allowedMentions: { users: [userId] } }).catch(() => null);
      return true;
    }
    return false;
  }
}

/**
 * Finds active factories whose tubs have filled up and nudges their owners once. Only scans guilds
 * that have the game and alerts on; uses lean, projected reads so it's cheap on the free tier.
 */
async function runFullAlertSweep(client, now = Date.now()) {
  const configs = await GuildConfig.find({ 'idleGame.enabled': true }, { guildId: 1, idleGame: 1 }).lean();
  let notified = 0;
  for (const cfg of configs) {
    const s = idleSettings(cfg);
    if (!s.fullAlerts) continue;
    const guild = client.guilds.cache.get(cfg.guildId);
    if (!guild) continue;
    const factories = await IdleFactory.find(
      { guildId: cfg.guildId, active: true, fullNotified: { $ne: true } },
      { userId: 1, lastTick: 1, upgrades: 1 }
    ).lean();
    for (const f of factories) {
      const capBubbles = ratePerHour(f, s) * offlineCapHours(f, s);
      if (capBubbles <= 0 || pendingBubbles({ ...f, active: true }, s, now) < capBubbles) continue;
      // Mark first so a delivery hiccup never turns into a repeat ping next sweep.
      await IdleFactory.updateOne({ guildId: cfg.guildId, userId: f.userId }, { $set: { fullNotified: true } });
      if (await notifyFull(client, guild, s, f.userId).catch(() => false)) notified++;
    }
  }
  return notified;
}

/** Runs the full-tub sweep on an interval (default every 15 min). Returns the timer. */
function startFullAlertLoop(client, intervalMs = 15 * 60000) {
  const tick = () => runFullAlertSweep(client).catch((err) => console.error('[idle] full-alert sweep failed:', err.message));
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

// ---------------------------------------------------------------- Embeds & buttons

const BLUE = 0x4ab3f4;
const GOLD = 0xf4b14a;
const GREEN = 0x3ba55d;

/** A clean, narrow progress bar (▰ filled / ▱ empty). */
function bar(current, max, width = 14) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const filled = Math.round(ratio * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/** The upgrade we nudge the player toward: the biggest one they can afford, else the cheapest next. */
function recommendedUpgrade(state, s) {
  const list = s?.upgrades || DEFAULT_UPGRADES;
  const byId = s?.upgradeById || DEFAULT_BY_ID;
  const opts = list.map((u) => {
    const lvl = levelOf(state, u.id);
    return { u, lvl, maxed: !!(u.max && lvl >= u.max), cost: upgradeCost(u.id, lvl, byId) };
  }).filter((o) => !o.maxed);
  if (!opts.length) return null;
  const affordable = opts.filter((o) => state.bank >= o.cost).sort((x, y) => y.cost - x.cost)[0];
  return affordable ? { ...affordable, affordable: true } : { ...opts.sort((x, y) => x.cost - y.cost)[0], affordable: false };
}

function factoryEmbed(state, s, { name, now = Date.now() } = {}) {
  const pending = pendingBubbles(state, s, now);
  const rate = ratePerHour(state, s);
  const capH = offlineCapHours(state, s);
  const capBubbles = rate * capH;
  const left = xpLeftToday(state, s, now);
  const full = capBubbles > 0 && pending >= capBubbles;
  const pct = capBubbles > 0 ? Math.round((pending / capBubbles) * 100) : 0;

  const owned = (s.upgrades || DEFAULT_UPGRADES).filter((u) => levelOf(state, u.id));
  const ownedStr = owned.length
    ? owned.map((u) => `${u.emoji} **${u.name}** · Lv ${levelOf(state, u.id)}${u.max ? `/${u.max}` : ''}`).join('\n')
    : '_None yet — open **⬆️ Upgrades**._';

  const rec = recommendedUpgrade(state, s);
  const recLine = !rec
    ? '🏆 **Every upgrade maxed** — you’re a Bubble Baron!'
    : rec.affordable
      ? `💡 You can afford **${rec.u.emoji} ${rec.u.name}** for **${fmt(rec.cost)}** 🫧 — grab it in **⬆️ Upgrades**.`
      : `💡 Next goal: **${rec.u.emoji} ${rec.u.name}** — **${fmt(rec.cost)}** 🫧 (${fmt(Math.max(0, rec.cost - state.bank))} to go).`;

  const collectBlock = full
    ? `🫧 **FULL — collect before you waste production!**\n${bar(1, 1)} \`${fmt(pending)} / ${fmt(capBubbles)}\` 🫧`
    : `${bar(pending, capBubbles)} \`${fmt(pending)} / ${fmt(capBubbles)}\` 🫧 · ${pct}%\n-# Fills up after **${capH}h** away.`;

  return new EmbedBuilder()
    .setColor(full ? GOLD : BLUE)
    .setTitle(`🫧 ${name ? `${name}'s ` : ''}Bubble Factory`)
    .setDescription(
      `Your loofah bubbles away around the clock — even while you're gone.\n\n` +
        `**📦 Ready to collect**\n${collectBlock}\n\n${recLine}`
    )
    .addFields(
      { name: '🫧 Bank', value: `**${fmt(state.bank)}**\n-# ready to spend`, inline: true },
      { name: '⚙️ Production', value: `**${fmt(rate)}**/hr\n-# with upgrades`, inline: true },
      { name: '🛁 Storage', value: `**${capH}h**\n-# ~${fmt(capBubbles)} 🫧 at this rate`, inline: true },
      s.dailyXpCap > 0
        ? { name: '💧 Cash out', value: `${fmt(s.bubblesPerXp)} 🫧 = 1 XP\n-# ${fmt(left)} XP left today`, inline: true }
        : { name: '💧 Cash out', value: 'off\n-# bubbles only', inline: true },
      { name: '📈 Lifetime', value: `**${fmt(state.lifetime)}** 🫧\n-# all-time`, inline: true },
      { name: `🏭 Upgrades${owned.length ? ` · ${owned.length}` : ''}`, value: ownedStr, inline: true }
    )
    .setFooter({ text: 'Collect → Upgrade → Cash out to XP' });
}

const rowFor = (userId, s) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`idle:collect:${userId}`).setLabel('Collect').setEmoji('🫧').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`idle:upgrades:${userId}`).setLabel('Upgrades').setEmoji('⬆️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`idle:cashout:${userId}`).setLabel('Cash out → XP').setEmoji('💧').setStyle(ButtonStyle.Success).setDisabled(s.dailyXpCap <= 0),
    new ButtonBuilder().setCustomId(`idle:home:${userId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`idle:stop:${userId}`).setLabel('Pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary)
  );

/** The screen shown before a member starts their factory (or after they pause it). */
function startView(state, s, userId, name) {
  const started = !!(state && state.lifetime);
  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle(`🫧 ${name ? `${name}'s ` : ''}Bubble Factory`)
    .setDescription(
      (started
        ? 'Your factory is **paused** — it isn’t making bubbles right now.\n\n'
        : 'Welcome to your very own **Bubble Factory**! It isn’t running yet.\n\n') +
        'Press **▶️ Start** (or run `/idle start`) to fire it up. It makes 🫧 Bubbles around the clock — even while you’re away — and you pop back to **collect** and **upgrade**.\n\n' +
        `-# Makes **${fmt(s.baseRate)} 🫧/hr** to begin with · stores up to **${fmt(s.offlineHours)}h** while you’re gone.`
    );
  if (started) embed.addFields({ name: '🫧 In the bank', value: `**${fmt(state.bank)}** waiting for you`, inline: false });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`idle:start:${userId}`).setLabel(started ? 'Resume' : 'Start my factory').setEmoji('▶️').setStyle(ButtonStyle.Success)
  );
  return { embed, row };
}

function upgradesView(state, s, userId, now = Date.now()) {
  const pending = pendingBubbles(state, s, now);
  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('⬆️ Upgrade your factory')
    .setDescription(
      `**🫧 ${fmt(state.bank)}** in the bank to spend.` +
        (pending > 0 ? `\n-# 📦 ${fmt(pending)} 🫧 still uncollected — **← Back → Collect** to bank them first.` : '')
    );
  const rows = [];
  let current = new ActionRowBuilder();
  for (const u of (s.upgrades || DEFAULT_UPGRADES)) {
    const level = levelOf(state, u.id);
    const maxed = u.max && level >= u.max;
    const cost = upgradeCost(u.id, level, s.upgradeById);
    const can = state.bank >= cost;
    const status = maxed ? '✅ **MAXED**' : can ? `🟢 buy for **${fmt(cost)}** 🫧` : `🔒 **${fmt(cost)}** 🫧 · ${fmt(cost - state.bank)} to go`;
    embed.addFields({
      name: `${u.emoji} ${u.name} — Lv ${level}${u.max ? `/${u.max}` : ''}`,
      value: `${u.blurb}\n${status}`,
      inline: true
    });
    current.addComponents(
      new ButtonBuilder()
        .setCustomId(`idle:up:${u.id}:${userId}`)
        .setLabel(u.name)
        .setEmoji(u.emoji)
        .setStyle(maxed ? ButtonStyle.Secondary : can ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(maxed || !can)
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

  if (action === 'start') {
    const { state } = await startFactory(interaction.guild.id, interaction.user.id);
    return interaction.update({ embeds: [factoryEmbed(state, s, { name })], components: [rowFor(interaction.user.id, s)] }).catch(() => null);
  }
  if (action === 'stop') {
    const { state } = await stopFactory(interaction.guild.id, interaction.user.id);
    const { embed, row } = startView(state, s, interaction.user.id, name);
    return interaction.update({ embeds: [embed], components: [row] }).catch(() => null);
  }

  // Everything below needs a running factory — send paused members to the Start screen.
  {
    const check = await getFactory(interaction.guild.id, interaction.user.id);
    if (!check.active) {
      const { embed, row } = startView(check, s, interaction.user.id, name);
      return interaction.update({ embeds: [embed], components: [row] }).catch(() => null);
    }
  }

  if (action === 'collect') {
    const { state, gained } = await collect(interaction.guild.id, interaction.user.id, s);
    if (gained <= 0) {
      const embed = factoryEmbed(state, s, { name }).setFooter({ text: '📦 Nothing to collect yet — come back a little later.' });
      return interaction.update({ embeds: [embed], components: [rowFor(interaction.user.id, s)] }).catch(() => null);
    }
    // A little filling-bubble animation, then the factory settles back in.
    const frame = (n) => new EmbedBuilder().setColor(BLUE).setTitle('🫧 Collecting…').setDescription(`${bar(n, 3)}`);
    await interaction.update({ embeds: [frame(1)], components: [] }).catch(() => null);
    await new Promise((r) => setTimeout(r, 350));
    await interaction.editReply({ embeds: [frame(2)] }).catch(() => null);
    await new Promise((r) => setTimeout(r, 350));
    await interaction
      .editReply({ embeds: [new EmbedBuilder().setColor(GREEN).setTitle('🫧 Collected!').setDescription(`${bar(3, 3)}\n**+${fmt(gained)} 🫧** into the bank.`)] })
      .catch(() => null);
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
    if (input.fullAlerts !== undefined) patch['idleGame.fullAlerts'] = !!input.fullAlerts;
    if (input.fullAlertChannelId !== undefined) patch['idleGame.fullAlertChannelId'] = input.fullAlertChannelId || null;
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

// ---------------------------------------------------------------- Upgrade configuration (admin)

const numOr = (v, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/** Overrides one upgrade's cost / effect / max level / availability for a guild. */
async function setUpgrade(guild, id, patch = {}) {
  if (!DEFAULT_BY_ID[id]) return { error: 'No such upgrade.' };
  const set = {};
  if (patch.baseCost !== undefined && patch.baseCost !== null && patch.baseCost !== '') {
    const n = numOr(patch.baseCost, 1, 1e9);
    if (n === undefined) return { error: 'Base cost must be 1–1,000,000,000.' };
    set[`idleGame.upgradeConfig.${id}.baseCost`] = n;
  }
  if (patch.effect !== undefined && patch.effect !== null && patch.effect !== '') {
    const n = numOr(patch.effect, 0, 1e6);
    if (n === undefined) return { error: 'Effect must be 0–1,000,000.' };
    set[`idleGame.upgradeConfig.${id}.effect`] = n;
  }
  if (patch.max !== undefined && patch.max !== null && patch.max !== '') {
    const n = numOr(patch.max, 1, 1000);
    if (n === undefined) return { error: 'Max level must be 1–1000.' };
    set[`idleGame.upgradeConfig.${id}.max`] = n;
  }
  if (patch.enabled !== undefined) set[`idleGame.upgradeConfig.${id}.enabled`] = !!patch.enabled;
  if (!Object.keys(set).length) return { error: 'Nothing to change.' };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: set }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { idleGame: 1 }).lean();
  return { upgrades: effectiveUpgrades(fresh), upgrade: effectiveUpgrades(fresh).find((u) => u.id === id) };
}

/** Saves the whole upgrade table at once (dashboard). `list` is [{ id, baseCost, effect, max, enabled }]. */
async function saveUpgrades(guild, list) {
  const cfg = {};
  for (const row of Array.isArray(list) ? list : []) {
    if (!row || !DEFAULT_BY_ID[row.id]) continue;
    const o = {};
    const bc = numOr(row.baseCost, 1, 1e9);
    if (bc !== undefined) o.baseCost = bc;
    const ef = numOr(row.effect, 0, 1e6);
    if (ef !== undefined) o.effect = ef;
    const mx = numOr(row.max, 1, 1000);
    if (mx !== undefined) o.max = mx;
    o.enabled = row.enabled !== false;
    cfg[row.id] = o;
  }
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'idleGame.upgradeConfig': cfg } }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { idleGame: 1 }).lean();
  return { upgrades: effectiveUpgrades(fresh) };
}

/** Clears all (or one) upgrade overrides, back to the defaults. */
async function resetUpgrades(guild, id = null) {
  if (id) {
    if (!DEFAULT_BY_ID[id]) return { error: 'No such upgrade.' };
    await GuildConfig.updateOne({ guildId: guild.id }, { $set: { [`idleGame.upgradeConfig.${id}`]: {} } }, { upsert: true });
  } else {
    await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'idleGame.upgradeConfig': {} } }, { upsert: true });
  }
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { idleGame: 1 }).lean();
  return { upgrades: effectiveUpgrades(fresh) };
}

module.exports = {
  UPGRADES: DEFAULT_UPGRADES,
  DEFAULT_UPGRADES,
  effectiveUpgrades,
  setUpgrade,
  saveUpgrades,
  resetUpgrades,
  idleSettings,
  upgradeCost,
  ratePerHour,
  offlineCapHours,
  pendingBubbles,
  xpLeftToday,
  getFactory,
  startFactory,
  stopFactory,
  collect,
  buyUpgrade,
  cashout,
  adminAdjustBubbles,
  resetFactory,
  runFullAlertSweep,
  startFullAlertLoop,
  factoryEmbed,
  startView,
  rowFor,
  upgradesView,
  handleIdleInteraction,
  leaderboard,
  cleanSettings,
  saveSettings
};
