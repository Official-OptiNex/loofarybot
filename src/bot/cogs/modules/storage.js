// Keeps the database small: old log-viewer entries (per server, how long is set in Logs → Storage),
// finished chat drops, and old ended polls/giveaways and ticket transcripts. Runs at startup and
// every 6 hours; the dashboard can also run it on demand for one server.
const mongoose = require('mongoose');
const GuildConfig = require('../../../database/models/GuildConfig');
const LogEntry = require('../../../database/models/LogEntry');
const ChatDrop = require('../../../database/models/ChatDrop');
const Poll = require('../../../database/models/Poll');
const Giveaway = require('../../../database/models/Giveaway');
const Ticket = require('../../../database/models/Ticket');

const DAY = 86400000;
const DEFAULT_LOG_DAYS = 30;
const RETENTION_CHOICES = [7, 14, 30, 60, 90];
// Everything else that piles up, and how long it's kept.
const KEEP = {
  chatDropsDays: 30,
  pollsDays: 90,
  giveawaysDays: 180,
  transcriptsDays: 180
};

const retentionDays = (config) => (RETENTION_CHOICES.includes(config?.logRetentionDays) ? config.logRetentionDays : DEFAULT_LOG_DAYS);

// Makes sure the log collection's TTL index exists with the current (90 day) ceiling. Older
// databases have it at 30 days — collMod updates it in place.
async function syncLogTtl() {
  const collection = LogEntry.collection;
  if (!mongoose.connection?.db) return;
  try {
    await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: LogEntry.LOG_TTL_SECONDS });
  } catch {
    await mongoose.connection.db
      .command({ collMod: collection.collectionName, index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: LogEntry.LOG_TTL_SECONDS } })
      .catch((err) => console.warn('[storage] could not update the log TTL index:', err.message));
  }
}

/** Deletes log entries older than each server's retention. Returns how many were removed. */
async function pruneLogs(now = Date.now(), guildId = null) {
  let removed = 0;
  if (guildId) {
    const config = await GuildConfig.findOne({ guildId }, { logRetentionDays: 1 }).lean();
    const res = await LogEntry.deleteMany({ guildId, createdAt: { $lt: new Date(now - retentionDays(config) * DAY) } });
    return res.deletedCount || 0;
  }
  // Servers with a non-default retention, grouped by setting; everyone else gets the default.
  const custom = await GuildConfig.find({ logRetentionDays: { $in: RETENTION_CHOICES.filter((d) => d !== DEFAULT_LOG_DAYS) } }, { guildId: 1, logRetentionDays: 1 }).lean();
  const groups = new Map();
  for (const c of custom) groups.set(c.logRetentionDays, [...(groups.get(c.logRetentionDays) || []), c.guildId]);
  for (const [days, ids] of groups) {
    const res = await LogEntry.deleteMany({ guildId: { $in: ids }, createdAt: { $lt: new Date(now - days * DAY) } });
    removed += res.deletedCount || 0;
  }
  const res = await LogEntry.deleteMany({ guildId: { $nin: custom.map((c) => c.guildId) }, createdAt: { $lt: new Date(now - DEFAULT_LOG_DAYS * DAY) } });
  return removed + (res.deletedCount || 0);
}

async function pruneOther(now = Date.now(), guildId = null) {
  const scope = guildId ? { guildId } : {};
  const before = (days) => new Date(now - days * DAY);
  const [drops, polls, giveaways, transcripts] = await Promise.all([
    ChatDrop.deleteMany({ ...scope, status: 'closed', createdAt: { $lt: before(KEEP.chatDropsDays) } }),
    Poll.deleteMany({ ...scope, ended: true, endTimestamp: { $lt: now - KEEP.pollsDays * DAY } }),
    Giveaway.deleteMany({ ...scope, ended: true, endTimestamp: { $lt: now - KEEP.giveawaysDays * DAY } }),
    // Closed tickets stay in History; only the old transcript text is dropped.
    Ticket.updateMany({ ...scope, status: 'CLOSED', closedAt: { $lt: before(KEEP.transcriptsDays) }, 'transcript.0': { $exists: true } }, { $set: { transcript: [] } })
  ]);
  return {
    chatDrops: drops.deletedCount || 0,
    polls: polls.deletedCount || 0,
    giveaways: giveaways.deletedCount || 0,
    transcripts: transcripts.modifiedCount || 0
  };
}

async function runCleanup({ now = Date.now(), guildId = null } = {}) {
  const logs = await pruneLogs(now, guildId);
  const other = await pruneOther(now, guildId);
  const total = logs + Object.values(other).reduce((a, b) => a + b, 0);
  if (total && !guildId) console.log(`[storage] cleaned up ${logs} log entries, ${JSON.stringify(other)}`);
  return { logs, ...other };
}

/** Counts for the dashboard's Storage card. */
async function storageStats(guildId) {
  const [logs, oldest, byType] = await Promise.all([
    LogEntry.countDocuments({ guildId }),
    LogEntry.findOne({ guildId }).sort({ createdAt: 1 }).lean(),
    LogEntry.aggregate([{ $match: { guildId } }, { $group: { _id: '$type', n: { $sum: 1 } } }]).catch(() => [])
  ]);
  return { logs, oldest: oldest?.createdAt || null, byType: Object.fromEntries(byType.map((t) => [t._id, t.n])) };
}

function startStorageCleanup() {
  const run = () => runCleanup().catch((err) => console.error('Storage cleanup failed:', err.message));
  setTimeout(() => syncLogTtl().then(run), 60 * 1000);
  setInterval(run, 6 * 3600 * 1000);
}

module.exports = { RETENTION_CHOICES, DEFAULT_LOG_DAYS, KEEP, retentionDays, syncLogTtl, pruneLogs, pruneOther, runCleanup, storageStats, startStorageCleanup };
