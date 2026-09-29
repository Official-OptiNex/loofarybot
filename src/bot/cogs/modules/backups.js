const GuildConfig = require('../../../database/models/GuildConfig');
const WelcomeConfig = require('../../../database/models/WelcomeConfig');
const AlertSubscription = require('../../../database/models/AlertSubscription');
const EmbedTemplate = require('../../../database/models/EmbedTemplate');
const UserLevel = require('../../../database/models/UserLevel');
const ConfigBackup = require('../../../database/models/ConfigBackup');
const TicketConfig = require('../../../database/models/TicketConfig');

const FORMAT = 'loofarybot-backup';
const VERSION = 1;
const KEEP_DAILY = 7;
const KEEP_OTHER = 10;

const strip = (doc, extra = []) => {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  for (const k of ['_id', '__v', 'createdAt', 'updatedAt', 'guildId', ...extra]) delete o[k];
  return o;
};

/** Everything that makes up a server's LoofaryBot setup, as plain JSON. */
async function exportGuild(guild, { includeXp = false } = {}) {
  const [config, welcome, alerts, templates, levels, tickets] = await Promise.all([
    GuildConfig.findOne({ guildId: guild.id }).lean(),
    WelcomeConfig.findOne({ guildId: guild.id }).lean(),
    AlertSubscription.find({ guildId: guild.id }).lean(),
    EmbedTemplate.find({ guildId: guild.id }).lean(),
    includeXp ? UserLevel.find({ guildId: guild.id }).lean() : Promise.resolve([]),
    TicketConfig.findOne({ guildId: guild.id }).lean()
  ]);
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    guildId: guild.id,
    guildName: guild.name,
    data: {
      guildConfig: strip(config),
      welcome: strip(welcome),
      alerts: alerts.map((a) => strip(a, ['state'])),
      embedTemplates: templates.map((t) => strip(t)),
      tickets: strip(tickets, ['counter']),
      ...(includeXp ? { members: levels.map((l) => strip(l)) } : {})
    }
  };
}

/** Short description of a backup/export file for the confirm screen. */
function summarize(payload) {
  const d = payload?.data || {};
  return {
    guildName: payload?.guildName || 'Unknown server',
    guildId: payload?.guildId || null,
    exportedAt: payload?.exportedAt || null,
    hasSettings: !!d.guildConfig,
    hasWelcome: !!d.welcome,
    hasTickets: !!d.tickets,
    alerts: (d.alerts || []).length,
    embedTemplates: (d.embedTemplates || []).length,
    members: Array.isArray(d.members) ? d.members.length : 0
  };
}

function validate(payload) {
  if (!payload || payload.format !== FORMAT) throw new Error("That file isn't a LoofaryBot settings backup.");
  if (payload.version > VERSION) throw new Error('That backup was made by a newer version of LoofaryBot.');
  if (!payload.data || typeof payload.data !== 'object') throw new Error('The backup file is empty or damaged.');
}

async function createBackup(guild, { reason = 'manual', createdBy = null, includeXp = true } = {}) {
  const data = await exportGuild(guild, { includeXp });
  const json = JSON.stringify(data);
  const backup = await ConfigBackup.create({
    guildId: guild.id,
    reason,
    createdBy,
    sizeBytes: Buffer.byteLength(json),
    memberCount: data.data.members?.length || 0,
    data
  });
  await pruneBackups(guild.id);
  return backup;
}

// Keeps the newest 7 daily backups and 10 others per server (free-tier storage friendly).
async function pruneBackups(guildId) {
  for (const [filter, keep] of [
    [{ guildId, reason: 'daily' }, KEEP_DAILY],
    [{ guildId, reason: { $ne: 'daily' } }, KEEP_OTHER]
  ]) {
    const old = await ConfigBackup.find(filter, { _id: 1 }).sort({ createdAt: -1 }).skip(keep).lean();
    if (old.length) await ConfigBackup.deleteMany({ _id: { $in: old.map((b) => b._id) } });
  }
}

/**
 * Replaces this server's setup with the payload's. A safety backup is taken first. Member XP is
 * only touched when includeXp is set and the payload contains it. Alert history is reset so
 * restored alerts don't re-announce old streams/videos.
 */
async function importGuild(guild, payload, { includeXp = false, createdBy = null, reason = 'before-import' } = {}) {
  validate(payload);
  await createBackup(guild, { reason, createdBy, includeXp: true });
  const d = payload.data;

  if (d.guildConfig) {
    // Keep this server's running counters and schedules: rewinding the case counter would make the
    // next /warn reuse an existing case number, old "last sent" days could re-send today's drops or
    // birthday posts, and the counting game would jump back to an old number.
    const current = (await GuildConfig.findOne({ guildId: guild.id }).lean()) || {};
    const next = { ...d.guildConfig, guildId: guild.id };
    next.caseCounter = Math.max(current.caseCounter || 0, next.caseCounter || 0);
    next.boosterDropDay = current.boosterDropDay ?? null;
    if (next.chatDrops || current.chatDrops) {
      next.chatDrops = { ...(next.chatDrops || {}), nextDropAt: current.chatDrops?.nextDropAt ?? null, lastDropAt: current.chatDrops?.lastDropAt ?? null };
    }
    if (next.birthdays || current.birthdays) {
      next.birthdays = { ...(next.birthdays || {}), lastRunDay: current.birthdays?.lastRunDay ?? null }; // don't re-post today's birthdays
    }
    if (next.counting || current.counting) {
      // The counting game carries on from the live number (the settings come from the backup).
      const live = current.counting || {};
      next.counting = {
        ...(next.counting || {}),
        current: live.current || 0,
        lastUserId: live.lastUserId ?? null,
        lastMessageId: live.lastMessageId ?? null,
        lastCountAt: live.lastCountAt ?? null,
        record: Math.max(live.record || 0, next.counting?.record || 0),
        bestBefore: live.bestBefore || 0,
        resets: live.resets || 0,
        lastResetBy: live.lastResetBy ?? null
      };
    }
    await GuildConfig.replaceOne({ guildId: guild.id }, next, { upsert: true });
  }
  if (d.tickets) {
    // Ticket numbers keep counting up from where this server is.
    const current = await TicketConfig.findOne({ guildId: guild.id }, { counter: 1 }).lean();
    await TicketConfig.replaceOne({ guildId: guild.id }, { ...d.tickets, guildId: guild.id, counter: current?.counter || 0 }, { upsert: true });
  }
  if (d.welcome) {
    await WelcomeConfig.replaceOne({ guildId: guild.id }, { ...d.welcome, guildId: guild.id }, { upsert: true });
  }
  if (Array.isArray(d.alerts)) {
    await AlertSubscription.deleteMany({ guildId: guild.id });
    if (d.alerts.length) {
      await AlertSubscription.insertMany(
        d.alerts.map((a) => ({ ...a, guildId: guild.id, state: { live: false, lastVideoPublished: new Date(), seenVideoIds: [] } }))
      );
    }
  }
  if (Array.isArray(d.embedTemplates)) {
    for (const t of d.embedTemplates) {
      if (!t?.name) continue;
      await EmbedTemplate.updateOne({ guildId: guild.id, name: t.name }, { $set: { ...t, guildId: guild.id } }, { upsert: true });
    }
  }
  let members = 0;
  if (includeXp && Array.isArray(d.members)) {
    const ops = d.members
      .filter((m) => m?.userId)
      .map((m) => ({ replaceOne: { filter: { guildId: guild.id, userId: m.userId }, replacement: { ...m, guildId: guild.id }, upsert: true } }));
    for (let i = 0; i < ops.length; i += 1000) await UserLevel.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    members = ops.length;
  }
  return { ...summarize(payload), membersRestored: members, crossServer: payload.guildId && payload.guildId !== guild.id };
}

async function restoreBackup(guild, backupId, { includeXp = false, createdBy = null } = {}) {
  const backup = await ConfigBackup.findOne({ _id: backupId, guildId: guild.id }).lean();
  if (!backup) throw new Error('Backup not found.');
  return importGuild(guild, backup.data, { includeXp, createdBy, reason: 'before-restore' });
}

// One automatic backup per server per day (checked every few hours; cheap when nothing is due).
async function runDailyBackups(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const recent = await ConfigBackup.exists({ guildId: guild.id, reason: 'daily', createdAt: { $gte: new Date(Date.now() - 23 * 3600 * 1000) } });
      if (!recent) await createBackup(guild, { reason: 'daily', includeXp: true });
    } catch (err) {
      console.error(`Daily backup failed for ${guild.id}:`, err.message);
    }
  }
}

function startDailyBackups(client) {
  setTimeout(() => runDailyBackups(client), 60_000);
  setInterval(() => runDailyBackups(client), 6 * 3600 * 1000);
}

module.exports = { exportGuild, summarize, validate, createBackup, importGuild, restoreBackup, startDailyBackups, FORMAT };
