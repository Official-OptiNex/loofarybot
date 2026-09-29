// Daily XP Pot: every XP lost in /gamble goes into today's pot (it keeps growing right up to the
// draw). A few minutes before the end of the day (the draw time, UTC) the pot is posted with a live
// countdown; everyone who chatted in the last hour is entered automatically, one wins the lot.
// No one active, or the pot is too small? It rolls over to tomorrow.
const crypto = require('crypto');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const XpPot = require('../../../database/models/XpPot');
const UserLevel = require('../../../database/models/UserLevel');
const { getCachedConfig } = require('../../../database/configCache');

const HOUR = 3600000;
const TICK_MS = 15 * 1000;
const EDIT_EVERY_MS = 30 * 1000; // live embed refresh (the countdown itself ticks client-side)
const MESSAGE_GAP_MS = 20 * 1000; // messages closer together than this count once (no spam-to-enter)
const LATE_LIMIT_MS = 12 * HOUR; // a draw missed while the bot was offline is still done within this

const fmt = (n) => Number(Math.round(n)).toLocaleString('en-US');
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const ts = (t, style = 'R') => `<t:${Math.floor(new Date(t).getTime() / 1000)}:${style}>`;

const DEFAULT_DESCRIPTION =
  'Every XP lost in `/gamble` today goes into this pot — and it keeps growing right up to the draw.\n\n' +
  '**How to win**\n' +
  '💬 Chat in the server: **{min}+ messages in the last {window} minutes** before the draw and you’re entered automatically. No buttons, no cost.\n' +
  '🎲 One random active member wins the **whole pot**.\n' +
  '🔁 Nobody active, or the pot is too small? It rolls over to tomorrow.';

function potSettings(config) {
  const p = (config && config.xpPot) || {};
  const e = p.embed || {};
  const int = (v, d, min, max) => (Number.isFinite(Number(v)) && v !== null ? Math.min(Math.max(Math.round(Number(v)), min), max) : d);
  return {
    enabled: !!p.enabled,
    channelId: p.channelId || null,
    drawHour: int(p.drawHour, 0, 0, 23),
    countdownMinutes: int(p.countdownMinutes, 10, 1, 60),
    windowMinutes: int(p.windowMinutes, 60, 10, 240),
    minMessages: int(p.minMessages, 3, 1, 50),
    sharePercent: int(p.sharePercent, 100, 1, 100),
    minPot: int(p.minPot, 100, 0, 1000000),
    pingRoleId: p.pingRoleId || null,
    embed: {
      title: e.title || '💰 Daily XP Pot',
      description: e.description || null,
      color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#F1C40F',
      thumbnailUrl: e.thumbnailUrl || null,
      imageUrl: e.imageUrl || null,
      footer: e.footer ?? 'Losses today = someone’s win tonight'
    },
    winMessage: p.winMessage || '🎉 {winner} won the **Daily XP Pot** — **{pot} XP**! 💰'
  };
}

/** The next draw time strictly after `now` (drawHour:00 UTC today, or tomorrow). */
function nextDrawAt(now, drawHour) {
  const d = new Date(now);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), drawHour);
  return new Date(at > d.getTime() ? at : at + 24 * HOUR);
}

// ---------------------------------------------------------------- Filling the pot

/**
 * Adds a gambling loss to the pot that's currently filling. Called for every finished game.
 * If today's pot was already drawn (e.g. an early /pot draw), the XP goes into tomorrow's.
 */
async function addLoss(guildId, userId, loss, now = Date.now()) {
  if (!(loss > 0)) return 0;
  const s = potSettings(await getCachedConfig(guildId));
  if (!s.enabled) return 0;
  const amount = Math.floor((loss * s.sharePercent) / 100);
  if (amount <= 0) return 0;
  return (await addToOpenPot(guildId, s, amount, { userId, from: now })) ? amount : 0;
}

/**
 * Adds XP to the next pot that hasn't been drawn yet (the one for the next draw after `from`,
 * skipping days already drawn). `userId` counts it as their contribution; without it, it's rollover.
 */
async function addToOpenPot(guildId, s, amount, { userId = null, from = Date.now(), skipDay = null } = {}) {
  let drawAt = nextDrawAt(from, s.drawHour);
  if (skipDay && dayKey(drawAt) === skipDay) drawAt = new Date(drawAt.getTime() + 24 * HOUR);
  const inc = userId ? { amount, [`contributors.${userId}`]: amount } : { amount, rolledOver: amount };
  for (let i = 0; i < 3; i++) {
    try {
      await XpPot.updateOne({ guildId, day: dayKey(drawAt), status: { $in: ['collecting', 'posted'] } }, { $inc: inc, $setOnInsert: { drawAt, status: 'collecting' } }, { upsert: true });
      return true;
    } catch (err) {
      if (err.code !== 11000) throw err;
      drawAt = new Date(drawAt.getTime() + 24 * HOUR); // that day is already drawn — next one
    }
  }
  return false;
}

// ---------------------------------------------------------------- Who's active

const activity = new Map(); // guildId -> Map(userId -> [timestamps, ≥20s apart])

/** Chat hook: remembers when members talk (in memory, the last few hours only). */
function noteChat(message) {
  if (!message.guild || message.author?.bot || message.webhookId || message.system) return;
  let g = activity.get(message.guild.id);
  if (!g) activity.set(message.guild.id, (g = new Map()));
  const now = message.createdTimestamp || Date.now();
  const list = g.get(message.author.id) || [];
  if (list.length && now - list.at(-1) < MESSAGE_GAP_MS) return;
  list.push(now);
  while (list.length && now - list[0] > 4 * HOUR) list.shift();
  if (list.length > 50) list.splice(0, list.length - 50);
  g.set(message.author.id, list);
}

/**
 * Members active in the window before the draw: {min} messages (≥20s apart) in the last {window}
 * minutes. After a restart (no memory yet) it falls back to "earned chat XP in that window".
 */
async function activeMembers(guild, s, drawAt) {
  const from = drawAt.getTime() - s.windowMinutes * 60000;
  const to = drawAt.getTime();
  const g = activity.get(guild.id);
  let ids = [];
  if (g && g.size) {
    for (const [userId, list] of g) if (list.filter((t) => t >= from && t <= to).length >= s.minMessages) ids.push(userId);
  } else {
    const rows = await UserLevel.find({ guildId: guild.id, lastMessageTimestamp: { $gte: from } }, { userId: 1 }).lean().catch(() => []);
    ids = rows.map((r) => r.userId);
  }
  const out = [];
  for (const id of ids) {
    const member = guild.members.cache.get(id) || (await guild.members.fetch(id).catch(() => null));
    if (member && !member.user.bot) out.push(id);
  }
  return out;
}

// Forget old activity so memory stays small.
setInterval(() => {
  const now = Date.now();
  for (const [gid, g] of activity) {
    for (const [uid, list] of g) if (!list.length || now - list.at(-1) > 4 * HOUR) g.delete(uid);
    if (!g.size) activity.delete(gid);
  }
}, 30 * 60 * 1000).unref?.();

// ---------------------------------------------------------------- Embeds

function topContributors(pot, n = 3) {
  const entries = pot?.contributors instanceof Map ? [...pot.contributors.entries()] : Object.entries(pot?.contributors || {});
  return entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function fill(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/**
 * The pot embed. phase: 'live' (countdown), 'done' (winner), 'rolled' (nobody won), 'preview'.
 */
function buildEmbed(pot, s, { phase = 'live', entrants = null, winnerId = null, won = 0, drawAt = null } = {}) {
  const at = drawAt || pot?.drawAt || new Date();
  const amount = pot?.amount || 0;
  const vars = { pot: fmt(amount), draw: ts(at), time: ts(at, 't'), min: s.minMessages, window: s.windowMinutes, entrants: entrants ?? '—' };
  const embed = new EmbedBuilder()
    .setColor(phase === 'done' ? '#57F287' : phase === 'rolled' ? '#4E5058' : s.embed.color)
    .setTitle(phase === 'done' ? `${s.embed.title} — we have a winner!` : phase === 'rolled' ? `${s.embed.title} — rolled over` : s.embed.title)
    .setDescription(fill(s.embed.description || DEFAULT_DESCRIPTION, vars).slice(0, 4000));
  if (phase === 'done') {
    embed.addFields({ name: '🏆 Winner', value: `<@${winnerId}>`, inline: true }, { name: '💰 Won', value: `**${fmt(won)} XP**`, inline: true }, { name: '🎟️ Entered', value: fmt(entrants || 0), inline: true });
  } else if (phase === 'rolled') {
    embed.addFields(
      { name: '💰 Pot', value: `**${fmt(amount)} XP** → tomorrow`, inline: true },
      { name: 'Why', value: amount < s.minPot ? `Under the ${fmt(s.minPot)} XP minimum` : 'Nobody was active in the last hour', inline: true }
    );
  } else {
    embed.addFields(
      { name: '💰 Pot', value: `**${fmt(amount)} XP**${pot?.rolledOver ? `\n-# incl. ${fmt(pot.rolledOver)} rolled over` : ''}`, inline: true },
      { name: '⏳ Draw', value: `${ts(at)}\n-# ${ts(at, 't')}`, inline: true },
      { name: '🎟️ Entered so far', value: entrants === null ? '—' : fmt(entrants), inline: true }
    );
  }
  const top = topContributors(pot);
  const medals = ['🥇', '🥈', '🥉'];
  embed.addFields({ name: '📉 Top pot contributors', value: top.length ? top.map(([id, v], i) => `${medals[i]} <@${id}> — ${fmt(v)} XP`).join('\n') : 'Nobody has lost any XP yet… 👀' });
  if (s.embed.thumbnailUrl) embed.setThumbnail(s.embed.thumbnailUrl);
  if (s.embed.imageUrl) embed.setImage(s.embed.imageUrl);
  if (s.embed.footer) embed.setFooter({ text: s.embed.footer.slice(0, 2048) });
  return embed;
}

// ---------------------------------------------------------------- Posting and drawing

const lastEdit = new Map(); // potId -> ts

function potChannel(guild, s) {
  const channel = s.channelId ? guild.channels.cache.get(s.channelId) : null;
  const me = guild.members.me;
  if (!channel?.isTextBased() || !me) return null;
  return channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]) ? channel : null;
}

async function postPot(guild, s, drawAt, now = Date.now(), day = dayKey(drawAt)) {
  // Make sure the pot exists (it may be empty) and claim posting it — once.
  await XpPot.updateOne({ guildId: guild.id, day }, { $setOnInsert: { drawAt, amount: 0, status: 'collecting' } }, { upsert: true }).catch(() => null);
  const pot = await XpPot.findOneAndUpdate({ guildId: guild.id, day, status: 'collecting' }, { $set: { status: 'posted', drawAt } }, { new: true });
  if (!pot) return null;
  const channel = potChannel(guild, s);
  if (!channel) return pot;
  const entrants = (await activeMembers(guild, s, new Date(now))).length;
  const msg = await channel
    .send({ content: s.pingRoleId ? `<@&${s.pingRoleId}>` : undefined, embeds: [buildEmbed(pot, s, { entrants, drawAt })], allowedMentions: { roles: s.pingRoleId ? [s.pingRoleId] : [] } })
    .catch((err) => console.warn(`[xpPot] ${guild.id}: could not post —`, err.message));
  if (msg) await XpPot.updateOne({ _id: pot._id }, { $set: { messageId: msg.id, channelId: channel.id } });
  lastEdit.set(String(pot._id), now);
  return pot;
}

async function refreshLive(guild, s, pot, now = Date.now()) {
  if (!pot.messageId || now - (lastEdit.get(String(pot._id)) || 0) < EDIT_EVERY_MS) return;
  lastEdit.set(String(pot._id), now);
  const channel = guild.channels.cache.get(pot.channelId);
  const msg = await channel?.messages?.fetch(pot.messageId).catch(() => null);
  if (!msg) return;
  const entrants = (await activeMembers(guild, s, new Date(Math.min(now, new Date(pot.drawAt).getTime())))).length;
  await msg.edit({ embeds: [buildEmbed(pot, s, { entrants })] }).catch(() => null);
}

/** Draws a pot whose time has come: picks the winner, pays out, or rolls it over. */
async function drawPot(guild, s, potId, { now = Date.now(), adjustXp = null } = {}) {
  const pot = await XpPot.findOneAndUpdate({ _id: potId, status: { $in: ['collecting', 'posted'] } }, { $set: { status: 'done' } }, { new: true });
  if (!pot) return null; // someone else drew it
  lastEdit.delete(String(pot._id));
  const drawAt = new Date(pot.drawAt);
  const entrants = await activeMembers(guild, s, drawAt);
  const amount = pot.amount || 0;
  const channel = (pot.channelId && guild.channels.cache.get(pot.channelId)) || potChannel(guild, s);
  const msg = pot.messageId ? await channel?.messages?.fetch(pot.messageId).catch(() => null) : null;

  if (amount < Math.max(1, s.minPot) || !entrants.length) {
    // Roll the XP over to the next draw.
    await XpPot.updateOne({ _id: pot._id }, { $set: { status: 'rolled', entrants: entrants.length } });
    if (amount > 0) await addToOpenPot(guild.id, s, amount, { from: Math.max(now, drawAt.getTime()), skipDay: pot.day }).catch((err) => console.warn('[xpPot] rollover failed:', err.message));
    const embed = buildEmbed(pot, s, { phase: 'rolled', entrants: entrants.length });
    // Only a pot that was posted says so — quiet days (tiny pots) roll over silently.
    if (msg) await msg.edit({ content: null, embeds: [embed] }).catch(() => null);
    return { rolled: true, amount, entrants: entrants.length };
  }

  const winnerId = entrants[crypto.randomInt(entrants.length)];
  const pay = adjustXp || require('./leveling').adjustXp;
  await pay(guild, winnerId, amount).catch((err) => console.error('[xpPot] payout failed:', err.message));
  await XpPot.updateOne({ _id: pot._id }, { $set: { winnerId, won: amount, entrants: entrants.length } });
  const embed = buildEmbed(pot, s, { phase: 'done', entrants: entrants.length, winnerId, won: amount });
  if (msg) await msg.edit({ content: null, embeds: [embed] }).catch(() => null);
  const top = topContributors(pot).map(([id]) => `<@${id}>`).join(', ');
  await channel
    ?.send({
      content: fill(s.winMessage, { winner: `<@${winnerId}>`, pot: fmt(amount), entrants: entrants.length, contributors: top || 'nobody' }).slice(0, 2000),
      embeds: msg ? [] : [embed],
      allowedMentions: { users: [winnerId] }
    })
    .catch(() => null);
  return { winnerId, amount, entrants: entrants.length };
}

async function tickGuild(client, config, now = Date.now()) {
  const guild = client.guilds.cache.get(config.guildId);
  const s = potSettings(config);
  if (!guild || !s.enabled) return;
  // 1) Anything due (or overdue, e.g. the bot was offline at the draw) gets drawn.
  const due = await XpPot.find({ guildId: guild.id, status: { $in: ['collecting', 'posted'] }, drawAt: { $lte: new Date(now) } }).lean();
  for (const pot of due) {
    if (now - new Date(pot.drawAt).getTime() > LATE_LIMIT_MS) {
      const claimed = await XpPot.updateOne({ _id: pot._id, status: { $in: ['collecting', 'posted'] } }, { $set: { status: 'rolled' } });
      if (claimed.modifiedCount === 1 && pot.amount > 0) await addToOpenPot(guild.id, s, pot.amount, { from: now, skipDay: pot.day });
      continue;
    }
    await drawPot(guild, s, pot._id, { now });
  }
  // 2) Countdown time: post the pot, then keep its numbers fresh.
  const drawAt = nextDrawAt(now, s.drawHour);
  if (now >= drawAt.getTime() - s.countdownMinutes * 60000) {
    const pot = await XpPot.findOne({ guildId: guild.id, day: dayKey(drawAt) }).lean();
    // Posted once it's worth drawing (checked every tick, so a pot that grows past the minimum
    // during the countdown still gets posted).
    if (pot?.status === 'collecting' && pot.amount >= Math.max(1, s.minPot)) await postPot(guild, s, drawAt, now);
    else if (pot?.status === 'posted') await refreshLive(guild, s, pot, now);
  }
}

async function tick(client, now = Date.now()) {
  const configs = await GuildConfig.find({ 'xpPot.enabled': true }, { guildId: 1, xpPot: 1 }).lean().catch(() => []);
  for (const c of configs) await tickGuild(client, c, now).catch((err) => console.error(`XP pot failed in ${c.guildId}:`, err.message));
}

function startXpPot(client) {
  setInterval(() => tick(client), TICK_MS);
}

/**
 * Staff: start the countdown now (for testing, or an early draw). The current pot is posted and drawn
 * in `countdownMinutes`; losses after that go into the next pot.
 */
async function startNow(guild, now = Date.now()) {
  const s = potSettings(await GuildConfig.findOne({ guildId: guild.id }).lean());
  if (!s.enabled) return { error: 'The Daily XP Pot is off — turn it on first.' };
  if (!potChannel(guild, s)) return { error: 'Pick a channel LoofaryBot can post in first.' };
  const scheduled = nextDrawAt(now, s.drawHour);
  const existing = await XpPot.findOne({ guildId: guild.id, day: dayKey(scheduled) }).lean();
  if (existing && existing.status !== 'collecting') return { error: 'Today’s pot is already posted.' };
  const drawAt = new Date(now + s.countdownMinutes * 60000);
  // Today's pot (keyed by its scheduled day) is posted now and drawn early; later losses go to the next one.
  const pot = await postPot(guild, s, drawAt, now, dayKey(scheduled));
  if (!pot) return { error: 'Today’s pot is already posted.' };
  return { ok: true, drawAt, pot };
}

// ---------------------------------------------------------------- Reading / settings

async function currentPot(guild, now = Date.now()) {
  const config = await GuildConfig.findOne({ guildId: guild.id }).lean();
  const s = potSettings(config);
  const drawAt = nextDrawAt(now, s.drawHour);
  const pot = (await XpPot.findOne({ guildId: guild.id, status: { $in: ['collecting', 'posted'] } }).sort({ drawAt: 1 }).lean()) || { amount: 0, contributors: {}, drawAt, status: 'collecting' };
  const at = new Date(pot.drawAt || drawAt);
  const entrants = await activeMembers(guild, s, new Date(Math.min(now, at.getTime())));
  return { settings: s, pot, drawAt: at, entrants: entrants.length, top: topContributors(pot) };
}

async function recentPots(guildId, limit = 7) {
  return XpPot.find({ guildId, status: { $in: ['done', 'rolled'] } }).sort({ drawAt: -1 }).limit(limit).lean();
}

/** Validates a settings update (dashboard or /pot). Returns { patch } or { error }. */
function cleanSettings(guild, input) {
  const patch = {};
  const whole = (v, min, max, label) => {
    const n = Number.parseInt(v, 10);
    if (!(n >= min && n <= max)) throw new Error(`${label} must be ${min}–${max}.`);
    return n;
  };
  const url = (v, label) => {
    const t = String(v || '').trim();
    if (!t) return null;
    if (!/^https?:\/\/\S+$/i.test(t) || t.length > 500) throw new Error(`${label} must be an image link (https://…).`);
    return t;
  };
  try {
    if (input.enabled !== undefined) patch['xpPot.enabled'] = !!input.enabled;
    if (input.channelId !== undefined) {
      const id = input.channelId ? String(input.channelId) : null;
      const ch = id ? guild.channels.cache.get(id) : null;
      if (id && (!ch || !ch.isTextBased() || ch.isThread())) return { error: 'Pick a text channel in this server.' };
      patch['xpPot.channelId'] = id;
    }
    if (input.drawHour !== undefined) patch['xpPot.drawHour'] = whole(input.drawHour, 0, 23, 'The draw hour (UTC)');
    if (input.countdownMinutes !== undefined) patch['xpPot.countdownMinutes'] = whole(input.countdownMinutes, 1, 60, 'The countdown (minutes)');
    if (input.windowMinutes !== undefined) patch['xpPot.windowMinutes'] = whole(input.windowMinutes, 10, 240, 'The activity window (minutes)');
    if (input.minMessages !== undefined) patch['xpPot.minMessages'] = whole(input.minMessages, 1, 50, 'Messages needed');
    if (input.sharePercent !== undefined) patch['xpPot.sharePercent'] = whole(input.sharePercent, 1, 100, 'Share of losses (%)');
    if (input.minPot !== undefined) patch['xpPot.minPot'] = whole(input.minPot, 0, 1000000, 'Minimum pot');
    if (input.pingRoleId !== undefined) {
      const id = input.pingRoleId ? String(input.pingRoleId) : null;
      if (id && !guild.roles.cache.has(id)) return { error: 'That role is not in this server.' };
      patch['xpPot.pingRoleId'] = id;
    }
    const e = input.embed || {};
    if (e.title !== undefined) patch['xpPot.embed.title'] = String(e.title || '').trim().slice(0, 256) || '💰 Daily XP Pot';
    if (e.description !== undefined) patch['xpPot.embed.description'] = String(e.description || '').trim().slice(0, 3000) || null;
    if (e.color !== undefined) {
      if (e.color && !/^#[0-9a-f]{6}$/i.test(e.color)) return { error: 'Use a hex color like #F1C40F.' };
      patch['xpPot.embed.color'] = e.color || '#F1C40F';
    }
    if (e.thumbnailUrl !== undefined) patch['xpPot.embed.thumbnailUrl'] = url(e.thumbnailUrl, 'The thumbnail');
    if (e.imageUrl !== undefined) patch['xpPot.embed.imageUrl'] = url(e.imageUrl, 'The banner');
    if (e.footer !== undefined) patch['xpPot.embed.footer'] = String(e.footer || '').trim().slice(0, 2048);
    if (input.winMessage !== undefined) patch['xpPot.winMessage'] = String(input.winMessage || '').trim().slice(0, 1500) || '🎉 {winner} won the **Daily XP Pot** — **{pot} XP**! 💰';
  } catch (err) {
    return { error: err.message };
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch, error } = cleanSettings(guild, input);
  if (error) return { error };
  const current = await GuildConfig.findOne({ guildId: guild.id }, { xpPot: 1 }).lean();
  const channelId = patch['xpPot.channelId'] !== undefined ? patch['xpPot.channelId'] : current?.xpPot?.channelId;
  if ((patch['xpPot.enabled'] ?? current?.xpPot?.enabled) && !channelId) return { error: 'Pick a channel for the pot first.' };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { xpPot: 1 }).lean();
  return { settings: potSettings(fresh) };
}

module.exports = {
  DEFAULT_DESCRIPTION,
  potSettings,
  nextDrawAt,
  dayKey,
  addLoss,
  addToOpenPot,
  noteChat,
  activeMembers,
  topContributors,
  buildEmbed,
  postPot,
  drawPot,
  tick,
  tickGuild,
  startXpPot,
  startNow,
  currentPot,
  recentPots,
  cleanSettings,
  saveSettings,
  _activity: activity
};
