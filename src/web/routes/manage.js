// Dashboard equivalents of the action commands: giveaways (/loof), reaction role panels (/reactionrole),
// polls (/poll), channel reminders (/remind channel), lockdown / purge, and member XP (/levels givexp…).
// Every route reuses the same module code the slash commands call.
const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { requireAuth, requireGuildAccess, requirePage } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');
const Giveaway = require('../../database/models/Giveaway');
const ReactionRolePanel = require('../../database/models/ReactionRolePanel');
const Poll = require('../../database/models/Poll');
const Reminder = require('../../database/models/Reminder');
const UserLevel = require('../../database/models/UserLevel');
const giveaways = require('../../bot/cogs/modules/giveaways');
const reactionRoles = require('../../bot/cogs/modules/reactionRoles');
const polls = require('../../bot/cogs/modules/polls');
const lockdownModule = require('../../bot/cogs/modules/lockdown');
const mediaOnly = require('../../bot/cogs/modules/mediaOnly');
const modCases = require('../../bot/cogs/modules/modCases');
const ModCase = require('../../database/models/ModCase');
const Ticket = require('../../database/models/Ticket');
const tickets = require('../../bot/cogs/modules/tickets');
const levelColors = require('../../bot/cogs/modules/levelColors');
const birthdays = require('../../bot/cogs/modules/birthdays');
const automod = require('../../bot/cogs/modules/automod');
const shop = require('../../bot/cogs/modules/shop');
const ShopItem = require('../../database/models/ShopItem');
const ShopOwnership = require('../../database/models/ShopOwnership');
const LogEntry = require('../../database/models/LogEntry');
const counting = require('../../bot/cogs/modules/counting');
const starboard = require('../../bot/cogs/modules/starboard');
const { adjustXp, getOrCreateConfig } = require('../../bot/cogs/modules/leveling');
const { parseDuration } = require('../../bot/utils/duration');

const router = express.Router();

const MAX_GIVEAWAY_MS = 365 * 86400000;
const MAX_POLL_MS = 30 * 86400000; // same limits as /poll and /remind
const MAX_REMINDER_MS = 365 * 86400000;

// requireAuth → requireGuildAccess → page permission → change history.
const guard = (page) => [requireAuth, requireGuildAccess, requirePage(page), auditTrail];

const bad = (res, error, status = 400) => res.status(status).json({ ok: false, error });
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v) => (v === '' || v === null || v === undefined ? null : Number.parseInt(v, 10));

// A text channel in this guild that the bot can post in, or null.
function sendableChannel(guild, channelId) {
  const channel = channelId ? guild.channels.cache.get(String(channelId)) : null;
  const me = guild.members.me;
  if (!channel || !channel.isTextBased() || channel.isThread() || !me) return null;
  const perms = channel.permissionsFor(me);
  return perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]) ? channel : null;
}

// Who the bot's audit-log reasons and "hosted by" lines should credit.
const actorOf = (req) => ({ id: req.session.user.id, tag: `${req.session.user.global_name || req.session.user.username} (dashboard)` });

const messageUrl = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

// ---------------------------------------------------------------- Giveaways

function readRequirements(guild, raw = {}) {
  const roleId = raw.roleId && guild.roles.cache.has(String(raw.roleId)) ? String(raw.roleId) : null;
  const minDays = int(raw.minDaysInServer);
  const minLevel = int(raw.minLevel);
  return {
    roleId,
    minDaysInServer: minDays > 0 ? Math.min(minDays, 3650) : null,
    minLevel: minLevel > 0 ? Math.min(minLevel, 1000) : null
  };
}

// Bonus entry roles that still exist (max 5, +1 to +10 each).
function readBonus(guild, raw) {
  return giveaways.cleanBonus(raw).filter((x) => guild.roles.cache.has(x.roleId));
}

// Ping text for a giveaway: '' | 'everyone' | 'here' | a role ID.
function pingText(guild, ping) {
  if (!ping) return null;
  if (ping === 'everyone' || ping === guild.id) return '@everyone';
  if (ping === 'here') return '@here';
  return guild.roles.cache.has(String(ping)) ? `<@&${ping}>` : null;
}

// Giveaways made before drops/requirements existed are stored without those fields, and .lean()
// skips schema defaults — fill them here so the dashboard never receives `undefined`.
function serializeGiveaway(g, guild) {
  const host = guild.members.cache.get(g.hostId);
  const type = g.type === 'drop' ? 'drop' : 'timed';
  const req = g.requirements || {};
  return {
    messageId: g.messageId,
    channelId: g.channelId,
    type,
    prize: g.prize,
    winnerCount: g.winnerCount || 1,
    entryCount: (g.entries || []).length,
    endTimestamp: g.endTimestamp,
    colorHex: /^#[0-9a-f]{6}$/i.test(g.colorHex || '') ? g.colorHex : '#5865F2',
    emoji: g.emoji || (type === 'drop' ? '⚡' : '🎉'),
    customDesc: g.customDesc || (type === 'drop' ? 'Be quick — first come, first served!' : 'Click the button below to enter!'),
    hostId: g.hostId,
    hostName: host ? host.displayName : null,
    requirements: { roleId: req.roleId || null, minDaysInServer: req.minDaysInServer || null, minLevel: req.minLevel || null },
    bonusEntries: (g.bonusEntries || []).map((b) => ({ roleId: b.roleId, extra: b.extra })),
    boosterEntries: typeof g.boosterEntries === 'number' ? g.boosterEntries : null,
    winners: (g.winners || []).map((id) => ({ id, name: guild.members.cache.get(id)?.displayName || null })),
    ended: !!g.ended,
    url: messageUrl(g.guildId, g.channelId, g.messageId)
  };
}

router.get('/guilds/:guildId/giveaways', ...guard('giveaways'), async (req, res) => {
  const [running, ended] = await Promise.all([
    Giveaway.find({ guildId: req.guild.id, ended: false }).sort({ endTimestamp: 1 }).lean(),
    Giveaway.find({ guildId: req.guild.id, ended: true }).sort({ updatedAt: -1 }).limit(20).lean()
  ]);
  res.json({ running: running.map((g) => serializeGiveaway(g, req.guild)), ended: ended.map((g) => serializeGiveaway(g, req.guild)) });
});

router.post('/guilds/:guildId/giveaways', ...guard('giveaways'), async (req, res) => {
  const b = req.body || {};
  const type = b.type === 'drop' ? 'drop' : 'timed';
  const channel = sendableChannel(req.guild, b.channelId);
  if (!channel) return bad(res, 'Pick a channel LoofaryBot can post embeds in.');
  const prize = str(b.prize, 256);
  if (!prize) return bad(res, 'Enter a prize.');
  const durationMs = parseDuration(b.duration) || (type === 'drop' && !b.duration ? 24 * 3600000 : null);
  if (!durationMs || durationMs > MAX_GIVEAWAY_MS) return bad(res, 'Invalid duration — use e.g. 30m, 2h, 1d12h (max 365d).');
  const winnerCount = int(b.winners) || 1;
  if (winnerCount < 1 || winnerCount > 100) return bad(res, 'Winners must be between 1 and 100.');

  try {
    const { giveaway, message } = await giveaways.postGiveaway(req.app.locals.discordClient, {
      channel,
      hostId: req.session.user.id,
      durationMs,
      winnerCount,
      prize,
      ping: pingText(req.guild, b.ping),
      colorHex: giveaways.resolveColor(b.color || (type === 'drop' ? 'gold' : null)),
      emoji: type === 'drop' ? '⚡' : str(b.emoji, 64) || '🎉',
      customDesc: str(b.description, 1000) || (type === 'drop' ? 'Be quick — first come, first served!' : 'Click the button below to enter!'),
      type,
      requirements: readRequirements(req.guild, b.requirements),
      bonusEntries: readBonus(req.guild, b.bonusEntries)
    });
    res.locals.audit = { section: 'Giveaways', action: `Started ${type === 'drop' ? 'drop' : 'giveaway'} “${prize.slice(0, 60)}”`, detail: `#${channel.name}` };
    res.json({ ok: true, giveaway: serializeGiveaway(giveaway.toObject(), req.guild), url: message.url });
  } catch (err) {
    console.error('Dashboard giveaway failed:', err.message);
    bad(res, `Discord rejected the message — check the button emoji and LoofaryBot's permissions in #${channel.name}. (${err.message})`);
  }
});

async function findGiveaway(req, res) {
  const g = await Giveaway.findOne({ guildId: req.guild.id, messageId: String(req.params.messageId) });
  if (!g) bad(res, 'Giveaway not found.', 404);
  return g;
}

router.post('/guilds/:guildId/giveaways/:messageId', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  if (g.ended) return bad(res, 'That giveaway has already ended.');
  const b = req.body || {};

  const prize = str(b.prize, 256);
  if (!prize) return bad(res, 'Enter a prize.');
  const winnerCount = int(b.winners) || g.winnerCount;
  if (winnerCount < 1 || winnerCount > 100) return bad(res, 'Winners must be between 1 and 100.');
  if (g.type === 'drop' && winnerCount < g.entries.length) return bad(res, `${g.entries.length} people already claimed — winners can't go below that.`);
  if (b.duration) {
    const ms = parseDuration(b.duration);
    if (!ms || ms > MAX_GIVEAWAY_MS) return bad(res, 'Invalid duration — use e.g. 30m, 2h, 1d12h (max 365d).');
    g.endTimestamp = Date.now() + ms;
  }

  g.prize = prize;
  g.winnerCount = winnerCount;
  // An emptied description goes back to the default text, the same as when creating one.
  g.customDesc = str(b.description, 1000) || (g.type === 'drop' ? 'Be quick — first come, first served!' : 'Click the button below to enter!');
  g.colorHex = giveaways.resolveColor(b.color || g.colorHex);
  if (g.type !== 'drop' && b.emoji) g.emoji = str(b.emoji, 64);
  g.requirements = readRequirements(req.guild, b.requirements);
  if (g.type !== 'drop') g.bonusEntries = readBonus(req.guild, b.bonusEntries);
  await g.save();

  const client = req.app.locals.discordClient;
  const found = await giveaways.refreshGiveaway(client, g);
  // A drop whose winner count was lowered to the number of claims is now complete.
  if (g.type === 'drop' && g.entries.length >= g.winnerCount) await giveaways.finishGiveaway(client, g);
  res.locals.audit = { section: 'Giveaways', action: `Edited giveaway “${prize.slice(0, 60)}”`, detail: '' };
  res.json({ ok: true, messageMissing: !found });
});

// Who entered (with their tickets), for the dashboard's entrant list.
router.get('/guilds/:guildId/giveaways/:messageId/entrants', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  const weights = await giveaways.entryWeights(req.guild, g, g.entries);
  const entrants = g.entries.map((id) => {
    const m = req.guild.members.cache.get(id);
    return { id, name: m?.displayName || null, username: m?.user.username || null, avatarUrl: m?.displayAvatarURL?.({ size: 64 }) || null, tickets: weights.get(id) || 1, won: (g.winners || []).includes(id) };
  });
  res.json({ entrants, total: entrants.length, tickets: entrants.reduce((n, e) => n + e.tickets, 0) });
});

router.delete('/guilds/:guildId/giveaways/:messageId/entrants/:userId', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  if (g.ended) return bad(res, "That giveaway has ended — entrants can't be changed.");
  const userId = String(req.params.userId);
  if (!g.entries.includes(userId)) return bad(res, 'That member has not entered.', 404);
  const updated = await Giveaway.findOneAndUpdate({ _id: g._id }, { $pull: { entries: userId } }, { new: true });
  await giveaways.refreshGiveaway(req.app.locals.discordClient, updated);
  const name = req.guild.members.cache.get(userId)?.displayName || userId;
  res.locals.audit = { section: 'Giveaways', action: `Removed ${name} from “${g.prize.slice(0, 60)}”`, detail: '' };
  res.json({ ok: true, entryCount: updated.entries.length });
});

router.post('/guilds/:guildId/giveaways/:messageId/end', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  if (g.ended) return bad(res, 'That giveaway has already ended.');
  await giveaways.finishGiveaway(req.app.locals.discordClient, g);
  const fresh = await Giveaway.findById(g._id).lean();
  res.locals.audit = { section: 'Giveaways', action: `Ended giveaway “${g.prize.slice(0, 60)}” early`, detail: '' };
  res.json({ ok: true, giveaway: fresh ? serializeGiveaway(fresh, req.guild) : null });
});

router.post('/guilds/:guildId/giveaways/:messageId/reroll', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  const result = await giveaways.rerollGiveaway(req.app.locals.discordClient, g);
  if (result.error) return bad(res, result.error);
  const member = req.guild.members.cache.get(result.winner);
  res.locals.audit = { section: 'Giveaways', action: `Rerolled “${g.prize.slice(0, 60)}”`, detail: `New winner: ${member ? member.displayName : result.winner}` };
  res.json({ ok: true, winner: { id: result.winner, name: member ? member.displayName : null } });
});

router.delete('/guilds/:guildId/giveaways/:messageId', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  await giveaways.deleteGiveaway(req.app.locals.discordClient, g);
  res.locals.audit = { section: 'Giveaways', action: `Deleted giveaway “${g.prize.slice(0, 60)}”`, detail: '' };
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Reaction role panels

// Validates the panel's role list; returns { roles } or { error }.
function readPanelRoles(guild, raw) {
  const seen = new Set();
  const roles = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const role = guild.roles.cache.get(String(r?.roleId || ''));
    if (!role || seen.has(role.id)) continue;
    const problem = reactionRoles.canManageRole(guild, role);
    if (problem) return { error: problem.replace(/<@&[^>]+>/g, `@${role.name}`).replace(/\*\*/g, '') };
    seen.add(role.id);
    roles.push({ roleId: role.id, label: str(r.label, 80) || null, emoji: str(r.emoji, 64) || null });
  }
  if (roles.length > reactionRoles.MAX_ROLES) return { error: `A panel can hold at most ${reactionRoles.MAX_ROLES} roles.` };
  return { roles };
}

function readPanelFields(body) {
  return {
    title: str(body.title, 256),
    description: str(body.description, 2000),
    color: giveaways.resolveColor(body.color),
    mode: ['buttons', 'select', 'select_single'].includes(body.mode) ? body.mode : 'buttons'
  };
}

const serializePanel = (p) => ({
  messageId: p.messageId,
  channelId: p.channelId,
  title: p.title,
  description: p.description,
  color: p.color,
  mode: p.mode,
  roles: p.roles,
  url: messageUrl(p.guildId, p.channelId, p.messageId)
});

router.get('/guilds/:guildId/reactionroles', ...guard('reactionroles'), async (req, res) => {
  const panels = await ReactionRolePanel.find({ guildId: req.guild.id }).sort({ createdAt: -1 }).lean();
  res.json({ panels: panels.map(serializePanel) });
});

router.post('/guilds/:guildId/reactionroles', ...guard('reactionroles'), async (req, res) => {
  const b = req.body || {};
  const channel = sendableChannel(req.guild, b.channelId);
  if (!channel) return bad(res, 'Pick a channel LoofaryBot can post embeds in.');
  const fields = readPanelFields(b);
  if (!fields.title) return bad(res, 'Give the panel a title.');
  const { roles, error } = readPanelRoles(req.guild, b.roles);
  if (error) return bad(res, error);

  const panel = new ReactionRolePanel({ guildId: req.guild.id, channelId: channel.id, messageId: 'pending', ...fields, roles });
  let msg;
  try {
    msg = await channel.send(reactionRoles.buildPanelMessage(reactionRoles.withRoleNames(panel, req.guild)));
  } catch (err) {
    return bad(res, `Discord rejected the panel — check the emojis and LoofaryBot's permissions in #${channel.name}. (${err.message})`);
  }
  panel.messageId = msg.id;
  await panel.save();
  res.locals.audit = { section: 'Reaction Roles', action: `Posted role panel “${fields.title.slice(0, 60)}”`, detail: `#${channel.name} · ${roles.length} role(s)` };
  res.json({ ok: true, panel: serializePanel(panel.toObject()), url: msg.url });
});

router.post('/guilds/:guildId/reactionroles/:messageId', ...guard('reactionroles'), async (req, res) => {
  const panel = await ReactionRolePanel.findOne({ guildId: req.guild.id, messageId: String(req.params.messageId) });
  if (!panel) return bad(res, 'Role panel not found.', 404);
  const fields = readPanelFields(req.body || {});
  if (!fields.title) return bad(res, 'Give the panel a title.');
  const { roles, error } = readPanelRoles(req.guild, req.body.roles);
  if (error) return bad(res, error);

  const previous = panel.toObject();
  Object.assign(panel, fields, { roles });
  try {
    if (!(await reactionRoles.refreshPanel(panel, req.guild))) {
      return bad(res, "The panel's message was deleted in Discord — delete this panel and post a new one.");
    }
  } catch (err) {
    Object.assign(panel, previous);
    return bad(res, `Discord rejected the update — is every emoji valid? (${err.message})`);
  }
  await panel.save();
  res.locals.audit = { section: 'Reaction Roles', action: `Updated role panel “${fields.title.slice(0, 60)}”`, detail: `${roles.length} role(s) · ${fields.mode}` };
  res.json({ ok: true, panel: serializePanel(panel.toObject()) });
});

router.delete('/guilds/:guildId/reactionroles/:messageId', ...guard('reactionroles'), async (req, res) => {
  const panel = await ReactionRolePanel.findOne({ guildId: req.guild.id, messageId: String(req.params.messageId) });
  if (!panel) return bad(res, 'Role panel not found.', 404);
  const channel = req.guild.channels.cache.get(panel.channelId);
  const msg = channel ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
  if (msg) await msg.delete().catch(() => null);
  await panel.deleteOne();
  res.locals.audit = { section: 'Reaction Roles', action: `Deleted role panel “${panel.title.slice(0, 60)}”`, detail: '' };
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Polls & channel reminders

function serializePoll(p) {
  const counts = p.options.map((_, i) => p.votes.filter((v) => v.option === i).length);
  return {
    messageId: p.messageId,
    channelId: p.channelId,
    question: p.question,
    options: p.options,
    counts,
    voters: new Set(p.votes.map((v) => v.userId)).size,
    anonymous: p.anonymous,
    multipleChoice: p.multipleChoice,
    endTimestamp: p.endTimestamp,
    ended: p.ended,
    url: messageUrl(p.guildId, p.channelId, p.messageId)
  };
}

router.get('/guilds/:guildId/polls', ...guard('community'), async (req, res) => {
  const [open, closed] = await Promise.all([
    Poll.find({ guildId: req.guild.id, ended: false }).sort({ createdAt: -1 }).lean(),
    Poll.find({ guildId: req.guild.id, ended: true }).sort({ updatedAt: -1 }).limit(10).lean()
  ]);
  res.json({ open: open.map(serializePoll), closed: closed.map(serializePoll) });
});

router.post('/guilds/:guildId/polls', ...guard('community'), async (req, res) => {
  const b = req.body || {};
  const channel = sendableChannel(req.guild, b.channelId);
  if (!channel) return bad(res, 'Pick a channel LoofaryBot can post embeds in.');
  const question = str(b.question, 250);
  if (!question) return bad(res, 'Enter a question.');
  const options = [...new Set((Array.isArray(b.options) ? b.options : []).map((o) => str(o, 100)).filter(Boolean))];
  if (options.length < 2 || options.length > polls.MAX_OPTIONS) return bad(res, `Give between 2 and ${polls.MAX_OPTIONS} different options.`);
  let endTimestamp = null;
  if (b.duration) {
    const ms = parseDuration(b.duration);
    if (!ms || ms > MAX_POLL_MS) return bad(res, 'Invalid duration — use e.g. 30m, 1h, 2d (max 30 days).');
    endTimestamp = Date.now() + ms;
  }

  const draft = {
    guildId: req.guild.id,
    channelId: channel.id,
    creatorId: req.session.user.id,
    question,
    options,
    anonymous: !!b.anonymous,
    multipleChoice: !!b.multiple,
    votes: [],
    endTimestamp,
    ended: false
  };
  let msg;
  try {
    msg = await channel.send(polls.buildPollMessage(draft));
  } catch (err) {
    return bad(res, `Couldn't post in #${channel.name} — check LoofaryBot's permissions. (${err.message})`);
  }
  const poll = await Poll.create({ ...draft, messageId: msg.id });
  res.locals.audit = { section: 'Community', action: `Started poll “${question.slice(0, 60)}”`, detail: `#${channel.name}` };
  res.json({ ok: true, poll: serializePoll(poll.toObject()), url: msg.url });
});

router.post('/guilds/:guildId/polls/:messageId/end', ...guard('community'), async (req, res) => {
  const poll = await Poll.findOne({ guildId: req.guild.id, messageId: String(req.params.messageId) });
  if (!poll) return bad(res, 'Poll not found.', 404);
  if (poll.ended) return bad(res, 'That poll is already closed.');
  await polls.endPoll(req.app.locals.discordClient, poll);
  res.locals.audit = { section: 'Community', action: `Closed poll “${poll.question.slice(0, 60)}”`, detail: '' };
  res.json({ ok: true });
});

router.get('/guilds/:guildId/reminders', ...guard('community'), async (req, res) => {
  const reminders = await Reminder.find({ guildId: req.guild.id, target: 'channel' }).sort({ remindAt: 1 }).limit(50).lean();
  res.json({
    reminders: reminders.map((r) => ({
      id: String(r._id),
      channelId: r.channelId,
      message: r.message,
      remindAt: r.remindAt,
      userId: r.userId,
      userName: req.guild.members.cache.get(r.userId)?.displayName || null
    }))
  });
});

router.post('/guilds/:guildId/reminders', ...guard('community'), async (req, res) => {
  const b = req.body || {};
  const channel = sendableChannel(req.guild, b.channelId);
  if (!channel) return bad(res, 'Pick a channel LoofaryBot can post embeds in.');
  const message = str(b.message, 1000);
  if (!message) return bad(res, 'Enter the reminder text.');
  const ms = parseDuration(b.in);
  if (!ms || ms < 60000 || ms > MAX_REMINDER_MS) return bad(res, 'Invalid time — use e.g. 30m, 2h, 1d12h (1 minute to 365 days).');

  const reminder = await Reminder.create({
    userId: req.session.user.id,
    guildId: req.guild.id,
    target: 'channel',
    channelId: channel.id,
    message,
    remindAt: Date.now() + ms
  });
  res.locals.audit = { section: 'Community', action: 'Scheduled a channel reminder', detail: `#${channel.name}` };
  res.json({ ok: true, id: String(reminder._id) });
});

router.delete('/guilds/:guildId/reminders/:id', ...guard('community'), async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{24}$/i.test(id)) return bad(res, 'Reminder not found.', 404);
  const deleted = await Reminder.findOneAndDelete({ _id: id, guildId: req.guild.id, target: 'channel' });
  if (!deleted) return bad(res, 'Reminder not found (it may have already been sent).', 404);
  res.locals.audit = { section: 'Community', action: 'Cancelled a channel reminder', detail: '' };
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Moderation: lockdown & purge

router.get('/guilds/:guildId/moderation', ...guard('moderation'), async (req, res) => {
  const config = await getOrCreateConfig(req.guild.id);
  const lockedIds = [...new Set((config.lockdownOverwrites || []).map((o) => o.channelId))];
  res.json({
    locked: lockedIds.map((id) => ({ id, name: req.guild.channels.cache.get(id)?.name || null })).filter((c) => c.name)
  });
});

// Auto-mod settings and recent catches (Moderation → Auto-mod). Same as /automod.
router.get('/guilds/:guildId/moderation/automod', ...guard('moderation'), async (req, res) => {
  const config = await getOrCreateConfig(req.guild.id);
  const recent = await automod.recentActions(req.guild.id, 20);
  res.json({
    settings: automod.automodSettings(config),
    missingPerms: automod.missingPermissions(req.guild),
    recent: recent.map((c) => ({
      caseId: c.caseId,
      type: c.type,
      userId: c.userId,
      userTag: c.userTag,
      name: req.guild.members.cache.get(c.userId)?.displayName || c.userTag || c.userId,
      reason: c.reason,
      createdAt: c.createdAt
    }))
  });
});

router.post('/guilds/:guildId/moderation/automod', ...guard('moderation'), async (req, res) => {
  const b = req.body || {};
  const input = {};
  for (const k of ['enabled', 'rules', 'warnings', 'muteMinutes', 'strikeResetHours', 'notify', 'exemptRoleIds', 'exemptChannelIds']) if (b[k] !== undefined) input[k] = b[k];
  const saved = await automod.saveSettings(req.guild, input);
  if (saved.error) return bad(res, saved.error);
  res.locals.audit = { section: 'Moderation', action: 'Updated auto-mod', detail: `${saved.settings.enabled ? 'On' : 'Off'} · ${saved.settings.warnings} warning(s) → ${saved.settings.muteMinutes} min mute` };
  res.json({ ok: true, settings: saved.settings });
});

router.post('/guilds/:guildId/moderation/lockdown', ...guard('moderation'), async (req, res) => {
  const b = req.body || {};
  let channel = null;
  if (b.channelId) {
    channel = req.guild.channels.cache.get(String(b.channelId));
    if (!channel) return bad(res, 'Channel not found.');
  }
  const me = req.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) && !me?.permissions.has(PermissionFlagsBits.Administrator)) {
    return bad(res, 'LoofaryBot needs the Manage Roles permission to change channel permissions.');
  }
  const reason = str(b.reason, 300) || 'Lockdown';
  const { locked, failed } = await lockdownModule.lockdown(req.guild, { channel, reason, actor: actorOf(req) });
  res.locals.audit = {
    section: 'Moderation',
    action: channel ? `Locked #${channel.name}` : 'Locked down the whole server',
    detail: `Reason: ${reason}${failed.length ? ` · ${failed.length} channel(s) failed` : ''}`
  };
  res.json({ ok: true, locked: locked.length, failed: failed.map((c) => c.name) });
});

router.post('/guilds/:guildId/moderation/unlock', ...guard('moderation'), async (req, res) => {
  const b = req.body || {};
  let channel = null;
  if (b.channelId) {
    channel = req.guild.channels.cache.get(String(b.channelId));
    if (!channel) return bad(res, 'Channel not found.');
  }
  const { unlocked } = await lockdownModule.unlockdown(req.guild, { channel, actor: actorOf(req) });
  res.locals.audit = { section: 'Moderation', action: channel ? `Unlocked #${channel.name}` : 'Lifted the server lockdown', detail: '' };
  res.json({ ok: true, unlocked: unlocked.length });
});

router.post('/guilds/:guildId/moderation/purge', ...guard('moderation'), async (req, res) => {
  const b = req.body || {};
  const channel = req.guild.channels.cache.get(String(b.channelId || ''));
  if (!channel || !channel.isTextBased()) return bad(res, 'Pick a text channel.');
  const count = int(b.count);
  if (!count || count < 1 || count > 100) return bad(res, 'Count must be between 1 and 100.');
  const me = req.guild.members.me;
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory])) {
    return bad(res, `LoofaryBot needs Manage Messages and Read Message History in #${channel.name}.`);
  }
  const userId = b.userId ? String(b.userId) : null;
  try {
    // Same approach as /purge: only messages under 14 days old can be bulk-deleted.
    let recent = await channel.messages.fetch({ limit: 100 });
    if (userId) recent = recent.filter((m) => m.author.id === userId);
    const toDelete = [...recent.values()].slice(0, count);
    if (!toDelete.length) return res.json({ ok: true, deleted: 0, skipped: 0 });
    const deleted = await channel.bulkDelete(toDelete, true);
    res.locals.audit = {
      section: 'Moderation',
      action: `Purged ${deleted.size} message(s) in #${channel.name}`,
      detail: userId ? `From ${req.guild.members.cache.get(userId)?.displayName || userId}` : ''
    };
    res.json({ ok: true, deleted: deleted.size, skipped: toDelete.length - deleted.size });
  } catch (err) {
    bad(res, `Discord refused the purge. (${err.message})`);
  }
});

// ---------------------------------------------------------------- Media-only channels (/mediaonly)

router.get('/guilds/:guildId/mediaonly', ...guard('moderation'), async (req, res) => {
  const config = await getOrCreateConfig(req.guild.id);
  const rules = (config.mediaOnlyChannels || [])
    .map((r) => (r.toObject ? r.toObject() : r))
    .filter((r) => req.guild.channels.cache.has(r.channelId))
    .map((r) => ({ ...r, name: req.guild.channels.cache.get(r.channelId).name, missing: mediaOnly.missingPermissions(req.guild.channels.cache.get(r.channelId), r) }));
  res.json({ rules });
});

router.post('/guilds/:guildId/mediaonly', ...guard('moderation'), async (req, res) => {
  const b = req.body || {};
  const channel = req.guild.channels.cache.get(String(b.channelId || ''));
  if (!channel || !mediaOnly.MEDIA_CHANNEL_TYPES.includes(channel.type)) return bad(res, 'Pick a text or announcement channel.');
  const { rule, updated } = await mediaOnly.setMediaOnly(req.guild.id, channel.id, {
    allowLinks: !!b.allowLinks,
    autoThread: !!b.autoThread,
    staffBypass: !!b.staffBypass
  });
  res.locals.audit = { section: 'Moderation', action: `${updated ? 'Updated' : 'Made'} #${channel.name} media-only`, detail: mediaOnly.describeRule(rule) };
  res.json({ ok: true, rule, missing: mediaOnly.missingPermissions(channel, rule) });
});

router.delete('/guilds/:guildId/mediaonly/:channelId', ...guard('moderation'), async (req, res) => {
  const removed = await mediaOnly.removeMediaOnly(req.guild.id, String(req.params.channelId));
  if (!removed) return bad(res, "That channel isn't media-only.", 404);
  const name = req.guild.channels.cache.get(req.params.channelId)?.name || 'deleted-channel';
  res.locals.audit = { section: 'Moderation', action: `Turned off media-only in #${name}`, detail: '' };
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Moderation cases (/warn /timeout /kick /ban /unban /cases)

const serializeCase = (c, guild) => ({
  caseId: c.caseId,
  type: c.type,
  userId: c.userId,
  userTag: c.userTag,
  userName: guild.members.cache.get(c.userId)?.displayName || null,
  moderatorId: c.moderatorId,
  moderatorTag: c.moderatorTag,
  reason: c.reason,
  durationMs: c.durationMs,
  expiresAt: c.expiresAt,
  active: c.active,
  auto: c.auto,
  dmSent: c.dmSent,
  createdAt: c.createdAt
});

// The dashboard user acts as themselves, so Discord's own permissions and role order still apply.
async function sessionMember(req) {
  return req.guild.members.fetch(req.session.user.id).catch(() => null);
}

router.get('/guilds/:guildId/cases', ...guard('moderation'), async (req, res) => {
  const page = Math.max(1, int(req.query.page) || 1);
  const userId = /^\d{5,25}$/.test(String(req.query.user || '')) ? String(req.query.user) : null;
  const data = await modCases.listCases(req.guild.id, { userId, type: req.query.type || null, page, pageSize: 15 });
  const config = await getOrCreateConfig(req.guild.id);
  let activeWarnings = null;
  if (userId) activeWarnings = await ModCase.countDocuments({ guildId: req.guild.id, userId, type: 'warn', active: true });
  res.json({
    ...data,
    cases: data.cases.map((c) => serializeCase(c, req.guild)),
    activeWarnings,
    settings: {
      dmEnabled: config.modDmEnabled !== false,
      escalation: (config.warnEscalation || []).map((r) => ({ count: r.count, action: r.action, durationMs: r.durationMs }))
    }
  });
});

router.post('/guilds/:guildId/cases/action', ...guard('moderation'), async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '');
  if (!modCases.TYPES[type]) return bad(res, 'Pick an action.');
  const userId = String(b.userId || '').trim();
  if (!/^\d{5,25}$/.test(userId)) return bad(res, 'Pick a member (or paste a user ID).');
  let durationMs = null;
  if (b.duration) {
    durationMs = parseDuration(b.duration);
    if (!durationMs) return bad(res, 'Invalid duration — use e.g. 10m, 2h, 1d.');
  }
  const moderatorMember = await sessionMember(req);
  if (!moderatorMember) return bad(res, "Couldn't find you in this server.");
  const result = await modCases.performAction(req.guild, {
    type,
    userId,
    moderator: moderatorMember.user,
    moderatorMember,
    reason: str(b.reason, 500),
    durationMs,
    deleteMessageSeconds: int(b.deleteMessageSeconds) || 0
  });
  if (result.error) return bad(res, result.error);
  res.locals.audit = { section: 'Moderation', action: `${modCases.TYPES[type].label}: ${result.case.userTag} (case #${result.case.caseId})`, detail: result.case.reason || '' };
  res.json({
    ok: true,
    case: serializeCase(result.case, req.guild),
    dmSent: result.dmSent,
    escalated: result.escalated ? (result.escalated.error ? { error: result.escalated.error } : { case: serializeCase(result.escalated.case, req.guild) }) : null
  });
});

router.post('/guilds/:guildId/cases/:caseId/reason', ...guard('moderation'), async (req, res) => {
  const result = await modCases.updateReason(req.guild.id, int(req.params.caseId), str(req.body?.reason, 500));
  if (result.error) return bad(res, result.error, 404);
  res.locals.audit = { section: 'Moderation', action: `Edited the reason on case #${req.params.caseId}`, detail: '' };
  res.json({ ok: true, case: serializeCase(result.case, req.guild) });
});

router.post('/guilds/:guildId/cases/:caseId/revoke', ...guard('moderation'), async (req, res) => {
  const result = await modCases.revokeCase(req.guild.id, int(req.params.caseId), req.session.user.id);
  if (result.error) return bad(res, result.error);
  res.locals.audit = { section: 'Moderation', action: `Revoked warning #${req.params.caseId}`, detail: '' };
  res.json({ ok: true });
});

router.delete('/guilds/:guildId/cases/:caseId', ...guard('moderation'), async (req, res) => {
  const result = await modCases.deleteCase(req.guild.id, int(req.params.caseId));
  if (result.error) return bad(res, result.error, 404);
  res.locals.audit = { section: 'Moderation', action: `Deleted case #${req.params.caseId}`, detail: '' };
  res.json({ ok: true });
});

router.post('/guilds/:guildId/cases/settings', ...guard('moderation'), async (req, res) => {
  const b = req.body || {};
  const seen = new Set();
  const rules = [];
  for (const r of Array.isArray(b.escalation) ? b.escalation.slice(0, 10) : []) {
    const count = int(r.count);
    if (!count || count < 1 || count > 50 || seen.has(count)) continue;
    if (!['timeout', 'kick', 'ban'].includes(r.action)) continue;
    let durationMs = r.duration ? parseDuration(r.duration) : null;
    if (r.duration && !durationMs) return bad(res, `Invalid duration “${str(r.duration, 20)}” — use e.g. 1h, 1d.`);
    if (r.action === 'timeout' && !durationMs) return bad(res, `The ${count}-warning timeout rule needs a duration.`);
    if (r.action === 'timeout') durationMs = Math.min(durationMs, modCases.MAX_TIMEOUT_MS);
    if (r.action === 'kick') durationMs = null;
    seen.add(count);
    rules.push({ count, action: r.action, durationMs });
  }
  const config = await getOrCreateConfig(req.guild.id);
  config.warnEscalation = rules.sort((a, c) => a.count - c.count);
  config.modDmEnabled = b.dmEnabled !== false;
  await config.save();
  res.locals.audit = { section: 'Moderation', action: 'Updated warning escalation', detail: `${rules.length} rule(s) · DMs ${config.modDmEnabled ? 'on' : 'off'}` };
  res.json({ ok: true, escalation: rules });
});

// ---------------------------------------------------------------- Member XP (/levels givexp · takexp · resetxp)

router.post('/guilds/:guildId/levels/member-xp', ...guard('leveling'), async (req, res) => {
  const b = req.body || {};
  const member = await req.guild.members.fetch(String(b.userId || '')).catch(() => null);
  if (!member) return bad(res, 'Member not found in this server.');
  if (member.user.bot) return bad(res, "Bots don't earn XP.");

  if (b.action === 'reset') {
    await UserLevel.updateOne({ guildId: req.guild.id, userId: member.id }, { $set: { xp: 0, level: 0 } });
    await levelColors.onLevelChange(req.guild.id, member.id, 0).catch(() => null);
    res.locals.audit = { section: 'Leveling', action: `Reset ${member.displayName}'s XP`, detail: '' };
    return res.json({ ok: true, xp: 0, level: 0 });
  }

  const amount = int(b.amount);
  if (!amount || amount < 1 || amount > 10_000_000) return bad(res, 'Enter an amount between 1 and 10,000,000.');
  const delta = b.action === 'take' ? -amount : amount;
  const result = await adjustXp(req.guild, member.id, delta);
  res.locals.audit = {
    section: 'Leveling',
    action: `${delta > 0 ? 'Gave' : 'Took'} ${amount} XP ${delta > 0 ? 'to' : 'from'} ${member.displayName}`,
    detail: `Level ${result.oldLevel} → ${result.newLevel}`
  };
  res.json({ ok: true, xp: result.record.xp, level: result.newLevel, roleFailures: result.roleFailures.length });
});

// ---------------------------------------------------------------- Tickets (same as /ticket)

const nameOf = (guild, id, fallback) => guild.members.cache.get(id)?.displayName || fallback || id;
function serializeTicket(t, guild) {
  return {
    id: String(t._id),
    number: t.number,
    channelId: t.channelId,
    channelUrl: `https://discord.com/channels/${guild.id}/${t.channelId}`,
    channelExists: guild.channels.cache.has(t.channelId),
    openerId: t.openerId,
    openerName: nameOf(guild, t.openerId, t.openerTag),
    openerTag: t.openerTag,
    reason: t.reason,
    status: t.status,
    claimedBy: t.claimedBy,
    claimedByName: t.claimedBy ? nameOf(guild, t.claimedBy, t.claimedByTag) : null,
    closedByName: t.closedBy ? nameOf(guild, t.closedBy, t.closedByTag) : t.closedByTag,
    closeReason: t.closeReason,
    createdAt: t.createdAt,
    closedAt: t.closedAt,
    messageCount: t.messageCount || 0
  };
}

router.get('/guilds/:guildId/tickets', ...guard('tickets'), async (req, res) => {
  const guild = req.guild;
  const s = await tickets.getSettings(guild.id);
  const [open, closedCount, weekCount] = await Promise.all([
    Ticket.find({ guildId: guild.id, status: 'OPEN' }).sort({ number: 1 }).lean(),
    Ticket.countDocuments({ guildId: guild.id, status: 'CLOSED' }),
    Ticket.countDocuments({ guildId: guild.id, createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } })
  ]);
  const categories = guild.channels.cache
    .filter((c) => c.type === 4) // GuildCategory
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.id, name: c.name, children: c.children?.cache?.size ?? 0 }));
  const panelChannel = s.panelChannelId ? guild.channels.cache.get(s.panelChannelId) : null;
  res.json({
    settings: s,
    open: open.map((t) => serializeTicket(t, guild)),
    stats: { open: open.length, closed: closedCount, week: weekCount, unclaimed: open.filter((t) => !t.claimedBy).length },
    categories,
    missingPerms: tickets.missingBotPerms(guild, s),
    panelUrl: panelChannel && s.panelMessageId ? messageUrl(guild.id, panelChannel.id, s.panelMessageId) : null
  });
});

// Save settings; with `publish`, also post/update the panel (in `panelChannelId` if given).
router.post('/guilds/:guildId/tickets/settings', ...guard('tickets'), async (req, res) => {
  const b = req.body || {};
  const { patch, error } = tickets.cleanSettings(req.guild, b);
  if (error) return bad(res, error);
  const s = await tickets.saveSettings(req.guild.id, patch);
  res.locals.audit = { section: 'Tickets', action: b.publish ? 'Saved ticket settings and posted the panel' : 'Saved ticket settings', detail: '' };
  let panelUrl = null;
  let warnings = [];
  if (b.publish) {
    const posted = await tickets.publishPanel(req.guild, b.panelChannelId ? String(b.panelChannelId) : null);
    if (posted.error) return bad(res, `Settings saved, but the panel wasn't posted: ${posted.error}`);
    panelUrl = posted.message.url;
    warnings = posted.warnings || [];
  } else {
    // Support roles or locks may have changed — re-apply channel permissions right away.
    warnings = (await tickets.applyLockdown(req.guild, s)).warnings;
  }
  res.json({ ok: true, settings: s, panelUrl, warnings, missingPerms: tickets.missingBotPerms(req.guild, s) });
});

router.get('/guilds/:guildId/tickets/history', ...guard('tickets'), async (req, res) => {
  const guild = req.guild;
  const page = Math.max(1, int(req.query.page) || 1);
  const pageSize = 15;
  const filter = { guildId: guild.id, status: 'CLOSED' };
  const q = str(req.query.q, 80);
  if (q) {
    const num = Number.parseInt(q.replace(/^#/, ''), 10);
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // Members matched by display name, so "nick" finds tickets opened by Nick.
    const memberIds = guild.members.cache.filter((m) => rx.test(m.displayName) || rx.test(m.user.username)).map((m) => m.id);
    filter.$or = [
      { openerTag: rx },
      { reason: rx },
      { closeReason: rx },
      { claimedByTag: rx },
      { closedByTag: rx },
      { openerId: q },
      ...(memberIds.length ? [{ openerId: { $in: memberIds.slice(0, 200) } }] : []),
      ...(Number.isFinite(num) && /^#?\d+$/.test(q) ? [{ number: num }] : [])
    ];
  }
  const [rows, total] = await Promise.all([
    Ticket.find(filter, { transcript: 0 }).sort({ closedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Ticket.countDocuments(filter)
  ]);
  res.json({ tickets: rows.map((t) => serializeTicket(t, guild)), page, totalPages: Math.max(1, Math.ceil(total / pageSize)), total });
});

router.get('/guilds/:guildId/tickets/:ticketId', ...guard('tickets'), async (req, res) => {
  const t = await Ticket.findOne({ _id: req.params.ticketId, guildId: req.guild.id }).lean().catch(() => null);
  if (!t) return bad(res, 'That ticket was not found.', 404);
  res.json({ ticket: serializeTicket(t, req.guild), transcript: t.transcript || [] });
});

router.post('/guilds/:guildId/tickets/:ticketId/close', ...guard('tickets'), async (req, res) => {
  const t = await Ticket.findOne({ _id: req.params.ticketId, guildId: req.guild.id }).catch(() => null);
  if (!t) return bad(res, 'That ticket was not found.', 404);
  if (t.status !== 'OPEN') return bad(res, 'That ticket is already closed.');
  // The member's DM names the staff member, not "(dashboard)".
  const u = req.session.user;
  const result = await tickets.closeTicket(req.guild, t, { id: u.id, tag: u.global_name || u.username }, str(req.body?.reason, 500) || null);
  if (result.error) return bad(res, result.error);
  res.locals.audit = { section: 'Tickets', action: `Closed ticket #${t.number}`, detail: str(req.body?.reason, 100) };
  res.json({ ok: true, ticket: serializeTicket(result.ticket, req.guild), dmSent: !!result.dmSent });
});

// ---------------------------------------------------------------- Engagement (birthdays, counting, starboard)

router.get('/guilds/:guildId/engagement', ...guard('engagement'), async (req, res) => {
  const guild = req.guild;
  const config = await getOrCreateConfig(guild.id);
  const name = (id) => guild.members.cache.get(id)?.displayName || null;
  const [upcoming, savedCount, top] = await Promise.all([
    birthdays.upcoming(guild.id, { limit: 15, guild }),
    require('../../database/models/Birthday').countDocuments({ guildId: guild.id }),
    starboard.topPosts(guild.id, 10)
  ]);
  const b = birthdays.birthdaySettings(config);
  const c = counting.countingSettings(config);
  const st = starboard.starboardSettings(config);
  res.json({
    levelingEnabled: config.levelingEnabled !== false,
    birthdays: {
      settings: { ...b, lastRunDay: undefined },
      saved: savedCount,
      missingPerms: birthdays.missingPermissions(guild, b),
      upcoming: upcoming.map((x) => ({ ...x, name: name(x.userId), date: birthdays.formatDate(x.month, x.day) }))
    },
    counting: {
      settings: { ...c, lastUserName: c.lastUserId ? name(c.lastUserId) : null, lastResetByName: c.lastResetBy ? name(c.lastResetBy) : null }
    },
    starboard: {
      settings: st,
      missingPerms: starboard.missingPermissions(guild, st),
      top: top.map((p) => ({
        stars: p.stars,
        authorId: p.authorId,
        authorName: name(p.authorId),
        channelId: p.channelId,
        url: messageUrl(guild.id, p.channelId, p.messageId),
        at: p.createdAt
      }))
    }
  });
});

const PICK = {
  birthdays: ['enabled', 'channelId', 'roleId', 'xpGift', 'announceHour', 'message'],
  counting: ['enabled', 'channelId', 'allowSameUser', 'mathAllowed', 'current'],
  starboard: ['enabled', 'channelId', 'emoji', 'threshold', 'selfStar', 'ignoredChannelIds']
};
const MODULES = { birthdays, counting, starboard };

router.post('/guilds/:guildId/engagement/:module', ...guard('engagement'), async (req, res) => {
  const mod = MODULES[req.params.module];
  if (!mod || !Object.hasOwn(MODULES, req.params.module)) return bad(res, 'Unknown section.', 404);
  const b = req.body || {};
  const input = {};
  for (const k of PICK[req.params.module]) if (b[k] !== undefined) input[k] = b[k];
  const saved = await mod.saveSettings(req.guild, input);
  if (saved.error) return bad(res, saved.error);
  // A dashboard count change gets the same heads-up in the channel as /counting set.
  if (req.params.module === 'counting' && input.current !== undefined && input.current !== '' && saved.settings.enabled && saved.settings.channelId) {
    const next = (saved.settings.current + 1).toLocaleString('en-US');
    await req.guild.channels.cache
      .get(saved.settings.channelId)
      ?.send({ content: `🛠️ A moderator set the count to **${saved.settings.current.toLocaleString('en-US')}**. The next number is **${next}**.`, allowedMentions: { parse: [] } })
      .catch(() => null);
  }
  res.json({ ok: true, settings: saved.settings });
});

// ---------------------------------------------------------------- XP shop

function serializeItem(i, stats = {}) {
  return {
    id: String(i._id),
    key: i.key || null,
    type: i.type,
    name: i.name,
    description: i.description || '',
    emoji: i.emoji,
    price: i.price,
    enabled: i.enabled !== false,
    order: i.order || 0,
    stock: i.stock ?? null,
    sold: i.sold || 0,
    maxPerUser: i.maxPerUser ?? 1,
    minLevel: i.minLevel || 0,
    config: i.config || {},
    owners: stats.owners || 0,
    active: stats.active || 0,
    spent: stats.spent || 0
  };
}

router.get('/guilds/:guildId/shop', ...guard('shop'), async (req, res) => {
  const guild = req.guild;
  const config = await getOrCreateConfig(guild.id);
  const [items, stats, recent] = await Promise.all([
    shop.listItems(guild.id, { all: true }),
    shop.shopStats(guild.id),
    LogEntry.find({ guildId: guild.id, type: 'shop' }).sort({ createdAt: -1 }).limit(15).lean().catch(() => [])
  ]);
  const me = guild.members.me;
  res.json({
    enabled: config.shopEnabled !== false,
    levelingEnabled: config.levelingEnabled !== false,
    types: Object.fromEntries(Object.entries(shop.TYPES).map(([k, t]) => [k, { label: t.label, help: t.help, toggle: t.toggle, custom: t.custom }])),
    items: items.map((i) => serializeItem(i, stats.perItem[String(i._id)])),
    totals: { spent: stats.totalSpent, buyers: stats.buyers },
    recent: recent.map((e) => ({ userTag: e.userTag, userId: e.userId, summary: e.summary, at: e.createdAt })),
    botCan: {
      manageRoles: !!me?.permissions.has(PermissionFlagsBits.ManageRoles),
      manageNicknames: !!me?.permissions.has(PermissionFlagsBits.ManageNicknames),
      highestRolePosition: me?.roles.highest.position ?? 0
    }
  });
});

router.post('/guilds/:guildId/shop/items', ...guard('shop'), async (req, res) => {
  const { item, error } = shop.cleanItem(req.guild, req.body || {});
  if (error) return bad(res, error);
  const count = await ShopItem.countDocuments({ guildId: req.guild.id });
  if (count >= 50) return bad(res, 'A shop can hold up to 50 items.');
  const created = await ShopItem.create({ ...item, guildId: req.guild.id, order: count });
  res.locals.audit = { section: 'XP Shop', action: `Added “${item.name}”`, detail: `${item.price} XP · ${shop.TYPES[item.type].label}` };
  res.json({ ok: true, item: serializeItem(created.toObject ? created.toObject() : created) });
});

router.post('/guilds/:guildId/shop/items/:id', ...guard('shop'), async (req, res) => {
  const existing = await ShopItem.findOne({ _id: req.params.id, guildId: req.guild.id }).lean().catch(() => null);
  if (!existing) return bad(res, 'That item no longer exists.', 404);
  const { item, error } = shop.cleanItem(req.guild, { ...req.body, type: existing.type }); // the kind can't change once people own it
  if (error) return bad(res, error);
  if (item.stock !== null && item.stock < (existing.sold || 0)) return bad(res, `Stock can't go below the ${existing.sold} already sold.`);
  await ShopItem.updateOne({ _id: existing._id }, { $set: item });
  res.locals.audit = { section: 'XP Shop', action: `Edited “${item.name}”`, detail: `${item.price} XP${item.enabled ? '' : ' · hidden'}` };
  const fresh = await ShopItem.findOne({ _id: existing._id }).lean();
  res.json({ ok: true, item: serializeItem(fresh) });
});

router.delete('/guilds/:guildId/shop/items/:id', ...guard('shop'), async (req, res) => {
  const existing = await ShopItem.findOne({ _id: req.params.id, guildId: req.guild.id }).lean().catch(() => null);
  if (!existing) return bad(res, 'That item no longer exists.', 404);
  // Switch owners' effects off (nickname tags, roles) before the item goes.
  const owned = await ShopOwnership.find({ guildId: req.guild.id, itemId: String(existing._id) }).lean();
  for (const o of owned) await shop.removeOwned(req.guild, o._id).catch(() => null);
  await ShopItem.deleteOne({ _id: existing._id });
  res.locals.audit = { section: 'XP Shop', action: `Deleted “${existing.name}”`, detail: owned.length ? `${owned.length} owner(s) lost it` : '' };
  res.json({ ok: true, removedFrom: owned.length });
});

router.post('/guilds/:guildId/shop/order', ...guard('shop'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 50) : [];
  for (const [i, id] of ids.entries()) await ShopItem.updateOne({ _id: id, guildId: req.guild.id }, { $set: { order: i } }).catch(() => null);
  res.json({ ok: true });
});

router.post('/guilds/:guildId/shop/restore', ...guard('shop'), async (req, res) => {
  const added = await shop.restoreDefaults(req.guild.id);
  res.locals.audit = { section: 'XP Shop', action: 'Restored starter items', detail: `${added} added` };
  res.json({ ok: true, added });
});

// A member's items, and staff gifting / removing them.
router.get('/guilds/:guildId/shop/member/:userId', ...guard('shop'), async (req, res) => {
  const member = await req.guild.members.fetch(String(req.params.userId)).catch(() => null);
  if (!member) return bad(res, "That member isn't in the server.", 404);
  const owned = await shop.inventory(req.guild.id, member.id);
  const record = await UserLevel.findOne({ guildId: req.guild.id, userId: member.id }, { xp: 1, level: 1 }).lean();
  res.json({
    member: { id: member.id, name: member.displayName, avatarUrl: member.displayAvatarURL({ size: 64 }), xp: record?.xp || 0, level: record?.level || 0 },
    owned: owned.map((o) => ({ id: String(o._id), itemId: String(o.itemId), name: o.item.name, emoji: o.item.emoji, type: o.item.type, active: o.active, quantity: o.quantity, spent: o.spent, expiresAt: o.expiresAt, custom: o.custom }))
  });
});

router.post('/guilds/:guildId/shop/member/:userId/give', ...guard('shop'), async (req, res) => {
  const member = await req.guild.members.fetch(String(req.params.userId)).catch(() => null);
  if (!member) return bad(res, "That member isn't in the server.", 404);
  const result = await shop.buy(req.guild, member, String(req.body?.itemId || ''), { free: true, by: `${req.session.user.global_name || req.session.user.username} (dashboard)` });
  if (result.error) return bad(res, result.error.replace(/\*\*/g, ''));
  res.locals.audit = { section: 'XP Shop', action: `Gave “${result.item.name}” to ${member.displayName}`, detail: '' };
  res.json({ ok: true });
});

router.delete('/guilds/:guildId/shop/owned/:id', ...guard('shop'), async (req, res) => {
  const result = await shop.removeOwned(req.guild, String(req.params.id));
  if (result.error) return bad(res, result.error, 404);
  res.locals.audit = { section: 'XP Shop', action: `Took “${result.item?.name || 'an item'}” from a member`, detail: '' };
  res.json({ ok: true });
});

module.exports = router;
