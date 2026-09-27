// Moderation cases: warn / timeout / kick / ban / unban, each recorded as a numbered case, DM'd to
// the member (optional), logged, and — for warnings — escalated automatically at set counts.
// Used by the slash commands and the dashboard alike.
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const ModCase = require('../../../database/models/ModCase');
const GuildConfig = require('../../../database/models/GuildConfig');
const { sendLog } = require('./logging');
const { formatDuration } = require('../../utils/duration');

const MAX_TIMEOUT_MS = 28 * 86400000; // Discord's limit

const TYPES = {
  warn: { label: 'Warning', emoji: '⚠️', color: '#FEE75C', past: 'warned', perm: PermissionFlagsBits.ModerateMembers },
  timeout: { label: 'Timeout', emoji: '⏳', color: '#F0B232', past: 'timed out', perm: PermissionFlagsBits.ModerateMembers },
  untimeout: { label: 'Timeout removed', emoji: '🔊', color: '#57F287', past: 'had their timeout removed', perm: PermissionFlagsBits.ModerateMembers },
  kick: { label: 'Kick', emoji: '👢', color: '#E67E22', past: 'kicked', perm: PermissionFlagsBits.KickMembers },
  ban: { label: 'Ban', emoji: '🔨', color: '#ED4245', past: 'banned', perm: PermissionFlagsBits.BanMembers },
  unban: { label: 'Unban', emoji: '🕊️', color: '#57F287', past: 'unbanned', perm: PermissionFlagsBits.BanMembers }
};

const userTag = (u) => (u ? u.tag ?? u.username ?? String(u.id) : 'Unknown');

async function nextCaseId(guildId) {
  const config = await GuildConfig.findOneAndUpdate({ guildId }, { $inc: { caseCounter: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  return config.caseCounter;
}

/**
 * Why `moderator` can't do `type` to `target` (a GuildMember, or null when they aren't in the server),
 * or null if it's allowed. `moderatorMember` is null for automatic actions by the bot itself.
 */
function checkAllowed(guild, type, moderatorMember, target) {
  const me = guild.members.me;
  const need = TYPES[type].perm;
  if (moderatorMember && !moderatorMember.permissions.has(need)) return `You need the **${permName(need)}** permission for that.`;
  if (type !== 'warn' && !me?.permissions.has(need)) return `LoofaryBot needs the **${permName(need)}** permission.`;
  if (!target) return ['ban', 'unban'].includes(type) ? null : "That member isn't in the server.";
  if (target.id === guild.ownerId) return "The server owner can't be moderated.";
  if (target.id === me?.id) return "LoofaryBot can't moderate itself.";
  if (moderatorMember && target.id === moderatorMember.id) return "You can't moderate yourself.";
  if (target.user?.bot && type === 'warn') return "Bots can't be warned.";
  if (moderatorMember && moderatorMember.id !== guild.ownerId && target.roles.highest.position >= moderatorMember.roles.highest.position) {
    return `**${target.displayName}**'s highest role is at or above yours.`;
  }
  if (type !== 'warn' && target.roles.highest.position >= (me?.roles.highest.position ?? 0)) {
    return `LoofaryBot's role must be above **${target.displayName}**'s highest role.`;
  }
  if (type === 'timeout' && target.permissions.has(PermissionFlagsBits.Administrator)) return "Administrators can't be timed out.";
  return null;
}

function permName(flag) {
  return { [PermissionFlagsBits.ModerateMembers]: 'Timeout Members', [PermissionFlagsBits.KickMembers]: 'Kick Members', [PermissionFlagsBits.BanMembers]: 'Ban Members' }[flag] || 'required';
}

function dmText(guild, c) {
  const t = TYPES[c.type];
  const duration = c.durationMs ? ` for **${formatDuration(c.durationMs)}**` : '';
  return `${t.emoji} You were **${t.past}**${duration} in **${guild.name}**.\n**Reason:** ${c.reason || 'No reason given'}${c.type === 'warn' ? `\n-# Case #${c.caseId}` : ''}`;
}

function caseEmbed(c) {
  const t = TYPES[c.type];
  const embed = new EmbedBuilder()
    .setColor(t.color)
    .setTitle(`${t.emoji} ${t.label} · Case #${c.caseId}${c.auto ? ' (automatic)' : ''}`)
    .addFields(
      { name: 'Member', value: `<@${c.userId}> (${c.userTag || c.userId})`, inline: true },
      { name: 'Moderator', value: c.moderatorId ? `<@${c.moderatorId}>` : 'LoofaryBot', inline: true },
      { name: 'Reason', value: c.reason || 'No reason given' }
    )
    .setTimestamp(c.createdAt || Date.now());
  if (c.durationMs) embed.addFields({ name: 'Duration', value: formatDuration(c.durationMs), inline: true });
  if (c.expiresAt) embed.addFields({ name: 'Ends', value: `<t:${Math.floor(new Date(c.expiresAt).getTime() / 1000)}:R>`, inline: true });
  if (!c.active && c.type === 'warn') embed.setFooter({ text: 'Revoked' });
  return embed;
}

/**
 * Performs a moderation action and records it. Returns { case, escalated } or { error }.
 * options: type, userId, moderator (User or {id, tag}), moderatorMember (null for automatic),
 *          reason, durationMs (timeout / temporary ban), deleteMessageSeconds (ban), auto.
 */
async function performAction(guild, { type, userId, moderator, moderatorMember = null, reason = '', durationMs = null, deleteMessageSeconds = 0, auto = false }) {
  if (!TYPES[type]) return { error: 'Unknown action.' };
  reason = String(reason || '').trim().slice(0, 500);
  const target = await guild.members.fetch(userId).catch(() => null);
  const problem = checkAllowed(guild, type, moderatorMember, target);
  if (problem) return { error: problem };
  if (type === 'timeout') {
    if (!durationMs || durationMs < 5000) return { error: 'Give a timeout length, e.g. 10m, 2h, 1d.' };
    durationMs = Math.min(durationMs, MAX_TIMEOUT_MS);
  }
  if (type === 'untimeout' && !target.isCommunicationDisabled()) return { error: `**${target.displayName}** isn't timed out.` };
  if (type === 'unban' && !(await guild.bans.fetch(userId).catch(() => null))) return { error: "That user isn't banned." };

  const config = await GuildConfig.findOne({ guildId: guild.id }).lean();
  const user = target?.user || (await guild.client.users.fetch(userId).catch(() => null));
  const draft = {
    guildId: guild.id,
    type,
    userId,
    userTag: userTag(user),
    moderatorId: moderator?.id || guild.members.me?.id,
    moderatorTag: moderator ? userTag(moderator) : 'LoofaryBot',
    reason,
    durationMs: ['timeout', 'ban'].includes(type) && durationMs ? durationMs : null,
    expiresAt: type === 'ban' && durationMs ? new Date(Date.now() + durationMs) : null,
    auto
  };
  const auditReason = `${reason || 'No reason given'} — by ${draft.moderatorTag}`.slice(0, 512);
  const wantsDm = config?.modDmEnabled !== false && user && !user.bot && ['warn', 'timeout', 'kick', 'ban'].includes(type);

  // Kicked/banned members can't be messaged afterwards, so DM those first.
  let dmSent = false;
  const sendDm = async (c) => {
    if (!wantsDm) return;
    dmSent = !!(await user.send({ content: dmText(guild, c) }).catch(() => null));
  };
  if (['kick', 'ban'].includes(type)) await sendDm({ ...draft, caseId: '…' });

  try {
    if (type === 'timeout') await target.timeout(durationMs, auditReason);
    if (type === 'untimeout') await target.timeout(null, auditReason);
    if (type === 'kick') await target.kick(auditReason);
    if (type === 'ban') await guild.members.ban(userId, { reason: auditReason, deleteMessageSeconds: Math.min(Math.max(deleteMessageSeconds || 0, 0), 604800) });
    if (type === 'unban') await guild.members.unban(userId, auditReason);
  } catch (err) {
    return { error: `Discord refused: ${err.message}` };
  }

  if (type === 'unban') await ModCase.updateMany({ guildId: guild.id, userId, type: 'ban', active: true }, { $set: { active: false } });
  if (type === 'untimeout') await ModCase.updateMany({ guildId: guild.id, userId, type: 'timeout', active: true }, { $set: { active: false } });

  const caseId = await nextCaseId(guild.id);
  const record = await ModCase.create({ ...draft, caseId, dmSent });
  if (['warn', 'timeout'].includes(type)) {
    await sendDm(record);
    if (dmSent) await ModCase.updateOne({ _id: record._id }, { $set: { dmSent: true } });
  }

  sendLog(guild, 'modActions', caseEmbed(record), {
    entry: {
      userId,
      userTag: draft.userTag,
      userAvatar: user?.displayAvatarURL?.({ size: 64 }) || '',
      summary: `${TYPES[type].past} by ${draft.moderatorTag} (case #${caseId})${reason ? ` — ${reason.slice(0, 120)}` : ''}`,
      details: { caseId, type, moderator: draft.moderatorTag, reason, durationMs: draft.durationMs }
    }
  }).catch(() => null);

  const escalated = type === 'warn' ? await escalate(guild, userId, config) : null;
  return { case: record.toObject ? record.toObject() : record, dmSent, escalated };
}

// Runs the escalation rule matching this member's active warning count (once per threshold).
async function escalate(guild, userId, config) {
  const rules = config?.warnEscalation || [];
  if (!rules.length) return null;
  const count = await ModCase.countDocuments({ guildId: guild.id, userId, type: 'warn', active: true });
  const rule = rules.find((r) => r.count === count);
  if (!rule) return null;
  const result = await performAction(guild, {
    type: rule.action,
    userId,
    moderator: null,
    moderatorMember: null,
    reason: `Reached ${count} warnings`,
    durationMs: rule.durationMs,
    auto: true
  });
  return result.error ? { error: result.error, rule } : { case: result.case, rule };
}

async function listCases(guildId, { userId = null, type = null, page = 1, pageSize = 15 } = {}) {
  const filter = { guildId };
  if (userId) filter.userId = userId;
  if (type && TYPES[type]) filter.type = type;
  const [cases, total] = await Promise.all([
    ModCase.find(filter).sort({ caseId: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    ModCase.countDocuments(filter)
  ]);
  return { cases, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

async function getCase(guildId, caseId) {
  return ModCase.findOne({ guildId, caseId: Number(caseId) });
}

// Stops a warning counting toward escalation (the case stays on record).
async function revokeCase(guildId, caseId, byId) {
  const c = await getCase(guildId, caseId);
  if (!c) return { error: `Case #${caseId} doesn't exist.` };
  if (c.type !== 'warn') return { error: 'Only warnings can be revoked — undo other actions with /untimeout or /unban.' };
  if (!c.active) return { error: `Case #${caseId} is already revoked.` };
  c.active = false;
  c.revokedBy = byId;
  c.revokedAt = new Date();
  await c.save();
  return { case: c.toObject() };
}

async function updateReason(guildId, caseId, reason) {
  const c = await ModCase.findOneAndUpdate({ guildId, caseId: Number(caseId) }, { $set: { reason: String(reason).slice(0, 500) } }, { new: true }).lean();
  return c ? { case: c } : { error: `Case #${caseId} doesn't exist.` };
}

async function deleteCase(guildId, caseId) {
  const res = await ModCase.deleteOne({ guildId, caseId: Number(caseId) });
  return res.deletedCount ? {} : { error: `Case #${caseId} doesn't exist.` };
}

// Every minute: lift temporary bans that have run out.
async function sweepTempBans(client) {
  const due = await ModCase.find({ type: 'ban', active: true, expiresAt: { $ne: null, $lte: new Date() } }).limit(25).lean();
  for (const c of due) {
    const claimed = await ModCase.findOneAndUpdate({ _id: c._id, active: true }, { $set: { active: false } });
    if (!claimed) continue;
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) continue;
    await performAction(guild, { type: 'unban', userId: c.userId, moderator: null, reason: `Temporary ban from case #${c.caseId} ended`, auto: true }).catch(console.error);
  }
}

function startTempBanSweeper(client) {
  const timer = setInterval(() => sweepTempBans(client).catch(console.error), 60 * 1000);
  timer.unref?.();
}

module.exports = {
  TYPES,
  MAX_TIMEOUT_MS,
  performAction,
  checkAllowed,
  listCases,
  getCase,
  revokeCase,
  updateReason,
  deleteCase,
  caseEmbed,
  sweepTempBans,
  startTempBanSweeper
};
