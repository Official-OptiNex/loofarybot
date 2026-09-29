// Birthdays: members save their birthday with /birthday set, and once a day (at the server's chosen hour,
// UTC) LoofaryBot posts one message wishing everyone whose birthday it is. Optionally they get a
// birthday role for the day and an XP gift. Fully automatic once a channel is picked.
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const Birthday = require('../../../database/models/Birthday');
const { adjustXp } = require('./leveling');

const TICK_MS = 5 * 60 * 1000;
const ROLE_HOURS = 24;
const COLOR = '#FF73FA';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb 29 allowed (celebrated Feb 28 in other years)
const DEFAULT_MESSAGE = '🎂 Happy birthday {users}! Have an amazing day! 🎉';

const fmt = (n) => Number(n).toLocaleString('en-US');
const dayKey = (d) => d.toISOString().slice(0, 10);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const formatDate = (month, day) => `${MONTHS[month - 1]} ${day}`;

function birthdaySettings(config) {
  const b = (config && config.birthdays) || {};
  return {
    enabled: !!b.enabled,
    channelId: b.channelId || null,
    roleId: b.roleId || null,
    xpGift: Math.max(0, b.xpGift || 0),
    announceHour: Number.isInteger(b.announceHour) ? Math.min(Math.max(b.announceHour, 0), 23) : 14,
    message: b.message || DEFAULT_MESSAGE,
    lastRunDay: b.lastRunDay || null
  };
}

function validDate(month, day) {
  const m = Number.parseInt(month, 10);
  const d = Number.parseInt(day, 10);
  if (!(m >= 1 && m <= 12)) return { error: 'Pick a month from 1 to 12.' };
  if (!(d >= 1 && d <= DAYS_IN_MONTH[m - 1])) return { error: `${MONTHS[m - 1]} only has ${DAYS_IN_MONTH[m - 1]} days.` };
  return { month: m, day: d };
}

// Which saved dates count as "today" — Feb 29 birthdays are celebrated on Feb 28 outside leap years.
function datesFor(now) {
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const dates = [{ month, day }];
  if (month === 2 && day === 28 && !isLeap(now.getUTCFullYear())) dates.push({ month: 2, day: 29 });
  return dates;
}

// Days from `now` (UTC date) until the next occurrence of month/day (0 = today).
function daysUntil(month, day, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    let d = day;
    if (month === 2 && day === 29 && !isLeap(year)) d = 28;
    const t = Date.UTC(year, month - 1, d);
    if (t >= today) return Math.round((t - today) / 86400000);
  }
  return 365;
}

async function setBirthday(guildId, userId, month, day) {
  const v = validDate(month, day);
  if (v.error) return v;
  await Birthday.updateOne({ guildId, userId }, { $set: { month: v.month, day: v.day } }, { upsert: true });
  return { month: v.month, day: v.day, daysUntil: daysUntil(v.month, v.day) };
}

async function removeBirthday(guildId, userId) {
  const res = await Birthday.deleteOne({ guildId, userId });
  return res.deletedCount > 0;
}

/** Saved birthdays sorted by how soon they come up. Members who left (and bots) are skipped when a guild is given. */
async function upcoming(guildId, { limit = 10, guild = null, now = new Date() } = {}) {
  const all = await Birthday.find({ guildId }).lean();
  return all
    .filter((b) => !guild || (guild.members.cache.has(b.userId) && !guild.members.cache.get(b.userId).user?.bot))
    .map((b) => ({ userId: b.userId, month: b.month, day: b.day, daysUntil: daysUntil(b.month, b.day, now) }))
    .sort((a, b) => a.daysUntil - b.daysUntil || a.month - b.month || a.day - b.day)
    .slice(0, limit);
}

function renderMessage(template, userIds, guild) {
  const users = userIds.map((id) => `<@${id}>`);
  const list = users.length > 1 ? `${users.slice(0, -1).join(', ')} and ${users.at(-1)}` : users[0];
  return String(template || DEFAULT_MESSAGE)
    .replaceAll('{users}', list)
    .replaceAll('{user}', list)
    .replaceAll('{count}', String(userIds.length))
    .replaceAll('{server}', guild.name)
    .slice(0, 2000);
}

function botCanGiveRole(guild, roleId) {
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  const me = guild.members.me;
  return !!(role && !role.managed && me?.permissions.has(PermissionFlagsBits.ManageRoles) && me.roles.highest.position > role.position);
}

/**
 * Celebrates today's birthdays in one guild. Runs at most once per UTC day per guild (claimed atomically),
 * so restarts or two copies of the bot during a deploy never post twice.
 */
async function celebrate(guild, config, { now = new Date() } = {}) {
  const s = birthdaySettings(config);
  const today = dayKey(now);
  const claimed = await GuildConfig.updateOne(
    { guildId: guild.id, 'birthdays.lastRunDay': { $ne: today } },
    { $set: { 'birthdays.lastRunDay': today } }
  );
  if (claimed.modifiedCount !== 1) return { skipped: true };

  const dates = datesFor(now);
  const rows = await Birthday.find({ guildId: guild.id, $or: dates, lastCelebrated: { $ne: today } }).lean();
  const members = [];
  for (const r of rows) {
    const member = guild.members.cache.get(r.userId) || (await guild.members.fetch(r.userId).catch(() => null));
    if (member && !member.user.bot) members.push(member);
  }
  if (!members.length) return { celebrated: [] };

  const channel = s.channelId ? guild.channels.cache.get(s.channelId) : null;
  const ids = members.map((m) => m.id);
  if (channel?.isTextBased()) {
    const extras = [];
    if (s.xpGift > 0 && config.levelingEnabled !== false) extras.push(`🎁 **+${fmt(s.xpGift)} XP** birthday gift`);
    if (s.roleId && botCanGiveRole(guild, s.roleId)) extras.push(`<@&${s.roleId}> for the day`);
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setDescription(renderMessage(s.message, ids, guild) + (extras.length ? `\n-# ${extras.join(' · ')}` : ''));
    await channel
      .send({ content: ids.map((id) => `<@${id}>`).join(' '), embeds: [embed], allowedMentions: { users: ids } })
      .catch((err) => console.warn(`[birthdays] ${guild.id}: could not post —`, err.message));
  }

  for (const member of members) {
    await Birthday.updateOne({ guildId: guild.id, userId: member.id }, { $set: { lastCelebrated: today } });
    if (s.xpGift > 0 && config.levelingEnabled !== false) await adjustXp(guild, member.id, s.xpGift, config).catch(() => null);
    if (s.roleId && botCanGiveRole(guild, s.roleId)) {
      const given = await member.roles.add(s.roleId, 'Birthday').then(() => true).catch(() => false);
      if (given) await Birthday.updateOne({ guildId: guild.id, userId: member.id }, { $set: { roleGivenAt: now } });
    }
  }
  return { celebrated: ids };
}

// Takes the birthday role back once the day is over.
async function removeExpiredRoles(client, now = new Date()) {
  const cutoff = new Date(now.getTime() - ROLE_HOURS * 3600000);
  const due = await Birthday.find({ roleGivenAt: { $ne: null, $lte: cutoff } }).limit(100).lean();
  for (const b of due) {
    const guild = client.guilds.cache.get(b.guildId);
    if (!guild) continue;
    const config = await GuildConfig.findOne({ guildId: b.guildId }, { birthdays: 1 }).lean();
    const roleId = birthdaySettings(config).roleId;
    const member = await guild.members.fetch(b.userId).catch(() => null);
    if (roleId && member?.roles.cache.has(roleId)) await member.roles.remove(roleId, 'Birthday is over').catch(() => null);
    await Birthday.updateOne({ _id: b._id }, { $set: { roleGivenAt: null } });
  }
}

async function tick(client, now = new Date()) {
  await removeExpiredRoles(client, now).catch((err) => console.error('Birthday role cleanup failed:', err.message));
  const configs = await GuildConfig.find({ 'birthdays.enabled': true }, { guildId: 1, birthdays: 1, levelingEnabled: 1 }).lean().catch(() => []);
  for (const c of configs) {
    const guild = client.guilds.cache.get(c.guildId);
    const s = birthdaySettings(c);
    if (!guild || s.lastRunDay === dayKey(now) || now.getUTCHours() < s.announceHour) continue;
    await celebrate(guild, c, { now }).catch((err) => console.error(`Birthdays failed in ${c.guildId}:`, err.message));
  }
}

function startBirthdays(client) {
  setTimeout(() => tick(client), 20000); // shortly after startup, then every few minutes
  setInterval(() => tick(client), TICK_MS);
}

/** Validates a settings update (from /birthday setup or the dashboard). Returns { patch } or { error }. */
function cleanSettings(guild, input) {
  const patch = {};
  if (input.enabled !== undefined) patch['birthdays.enabled'] = !!input.enabled;
  if (input.channelId !== undefined) {
    const id = input.channelId ? String(input.channelId) : null;
    const ch = id ? guild.channels.cache.get(id) : null;
    if (id && (!ch || !ch.isTextBased() || ch.isThread())) return { error: 'Pick a text channel in this server.' };
    patch['birthdays.channelId'] = id;
  }
  if (input.roleId !== undefined) {
    const id = input.roleId ? String(input.roleId) : null;
    const role = id ? guild.roles.cache.get(id) : null;
    if (id && !role) return { error: 'That role is not in this server.' };
    if (role?.managed) return { error: 'That role is managed by Discord or an integration — pick a normal role.' };
    patch['birthdays.roleId'] = id;
  }
  if (input.xpGift !== undefined) {
    const n = Number.parseInt(input.xpGift || 0, 10);
    if (!(n >= 0 && n <= 100000)) return { error: 'The XP gift must be 0–100,000.' };
    patch['birthdays.xpGift'] = n;
  }
  if (input.announceHour !== undefined) {
    const h = Number.parseInt(input.announceHour, 10);
    if (!(h >= 0 && h <= 23)) return { error: 'The announcement hour must be 0–23 (UTC).' };
    patch['birthdays.announceHour'] = h;
  }
  if (input.message !== undefined) {
    const m = String(input.message || '').trim().slice(0, 1500);
    patch['birthdays.message'] = m || DEFAULT_MESSAGE;
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch, error } = cleanSettings(guild, input);
  if (error) return { error };
  const current = await GuildConfig.findOne({ guildId: guild.id }, { birthdays: 1 }).lean();
  const channelId = patch['birthdays.channelId'] !== undefined ? patch['birthdays.channelId'] : current?.birthdays?.channelId;
  if ((patch['birthdays.enabled'] ?? current?.birthdays?.enabled) && !channelId) return { error: 'Pick a channel for birthday posts first.' };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { birthdays: 1 }).lean();
  return { settings: birthdaySettings(fresh) };
}

// What LoofaryBot is missing to run birthdays as configured (empty when fine).
function missingPermissions(guild, s) {
  const out = [];
  const me = guild.members.me;
  const channel = s.channelId ? guild.channels.cache.get(s.channelId) : null;
  if (channel && me) {
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) out.push(`Send Messages + Embed Links in #${channel.name}`);
  }
  if (s.roleId && !botCanGiveRole(guild, s.roleId)) out.push('Manage Roles, with LoofaryBot’s role above the birthday role');
  return out;
}

module.exports = {
  MONTHS,
  DEFAULT_MESSAGE,
  birthdaySettings,
  validDate,
  datesFor,
  daysUntil,
  formatDate,
  setBirthday,
  removeBirthday,
  upcoming,
  renderMessage,
  celebrate,
  removeExpiredRoles,
  tick,
  startBirthdays,
  cleanSettings,
  saveSettings,
  missingPermissions
};
