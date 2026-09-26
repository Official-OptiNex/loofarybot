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
const levelColors = require('../../bot/cogs/modules/levelColors');
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

// Ping text for a giveaway: '' | 'everyone' | 'here' | a role ID.
function pingText(guild, ping) {
  if (!ping) return null;
  if (ping === 'everyone' || ping === guild.id) return '@everyone';
  if (ping === 'here') return '@here';
  return guild.roles.cache.has(String(ping)) ? `<@&${ping}>` : null;
}

function serializeGiveaway(g, guild) {
  const host = guild.members.cache.get(g.hostId);
  return {
    messageId: g.messageId,
    channelId: g.channelId,
    type: g.type,
    prize: g.prize,
    winnerCount: g.winnerCount,
    entryCount: g.entries.length,
    endTimestamp: g.endTimestamp,
    colorHex: g.colorHex,
    emoji: g.emoji,
    customDesc: g.customDesc,
    hostId: g.hostId,
    hostName: host ? host.displayName : null,
    requirements: g.requirements || {},
    winners: (g.winners || []).map((id) => ({ id, name: guild.members.cache.get(id)?.displayName || null })),
    ended: g.ended,
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
    const { giveaway, message } = await giveaways.postGiveaway(req.app.locals.client, {
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
      requirements: readRequirements(req.guild, b.requirements)
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
  g.customDesc = str(b.description, 1000) || g.customDesc;
  g.colorHex = giveaways.resolveColor(b.color || g.colorHex);
  if (g.type !== 'drop' && b.emoji) g.emoji = str(b.emoji, 64);
  g.requirements = readRequirements(req.guild, b.requirements);
  await g.save();

  const client = req.app.locals.client;
  const found = await giveaways.refreshGiveaway(client, g);
  // A drop whose winner count was lowered to the number of claims is now complete.
  if (g.type === 'drop' && g.entries.length >= g.winnerCount) await giveaways.finishGiveaway(client, g);
  res.locals.audit = { section: 'Giveaways', action: `Edited giveaway “${prize.slice(0, 60)}”`, detail: '' };
  res.json({ ok: true, messageMissing: !found });
});

router.post('/guilds/:guildId/giveaways/:messageId/end', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  if (g.ended) return bad(res, 'That giveaway has already ended.');
  await giveaways.finishGiveaway(req.app.locals.client, g);
  const fresh = await Giveaway.findById(g._id).lean();
  res.locals.audit = { section: 'Giveaways', action: `Ended giveaway “${g.prize.slice(0, 60)}” early`, detail: '' };
  res.json({ ok: true, giveaway: fresh ? serializeGiveaway(fresh, req.guild) : null });
});

router.post('/guilds/:guildId/giveaways/:messageId/reroll', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  const result = await giveaways.rerollGiveaway(req.app.locals.client, g);
  if (result.error) return bad(res, result.error);
  const member = req.guild.members.cache.get(result.winner);
  res.locals.audit = { section: 'Giveaways', action: `Rerolled “${g.prize.slice(0, 60)}”`, detail: `New winner: ${member ? member.displayName : result.winner}` };
  res.json({ ok: true, winner: { id: result.winner, name: member ? member.displayName : null } });
});

router.delete('/guilds/:guildId/giveaways/:messageId', ...guard('giveaways'), async (req, res) => {
  const g = await findGiveaway(req, res);
  if (!g) return;
  await giveaways.deleteGiveaway(req.app.locals.client, g);
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
  await polls.endPoll(req.app.locals.client, poll);
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

module.exports = router;
