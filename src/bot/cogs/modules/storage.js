// Keeps the bot inside free-tier limits for the long run (MongoDB Atlas M0: 512 MB storage;
// Render free: 512 MB RAM):
//   • log-viewer history: per-server retention (Logs → Storage) AND a hard cap on entries per server,
//     so a burst of activity can't fill the database;
//   • finished chat drops, old ended polls/giveaways and old ticket transcripts are removed;
//   • a watchdog checks the database size — past 75% it prunes harder and switches to "low space"
//     mode (only moderation logs are stored), and it alerts the server's bot-alerts channel.
// Runs at startup and every hour; the dashboard can also run it on demand for one server.
const mongoose = require('mongoose');
const GuildConfig = require('../../../database/models/GuildConfig');
const LogEntry = require('../../../database/models/LogEntry');
const ChatDrop = require('../../../database/models/ChatDrop');
const Poll = require('../../../database/models/Poll');
const Giveaway = require('../../../database/models/Giveaway');
const Ticket = require('../../../database/models/Ticket');
const XpPot = require('../../../database/models/XpPot');

const DAY = 86400000;
const MB = 1024 * 1024;
const DEFAULT_LOG_DAYS = 30;
const RETENTION_CHOICES = [7, 14, 30, 60, 90];
// Hard cap per server — ~1 KB each, so 20,000 entries ≈ 20 MB at most.
const MAX_LOGS_PER_GUILD = Number(process.env.LOG_MAX_ENTRIES) || 20000;
// Free-tier ceilings (override with env vars if you upgrade).
const DB_LIMIT_MB = Number(process.env.DB_STORAGE_LIMIT_MB) || 512;
const RAM_LIMIT_MB = Number(process.env.RAM_LIMIT_MB) || 512;
const LOW_SPACE_AT = 0.75; // share of the DB limit where emergency pruning starts
// Everything else that piles up, and how long it's kept.
const KEEP = {
  chatDropsDays: 30,
  pollsDays: 90,
  giveawaysDays: 180,
  transcriptsDays: 180
};
// In low-space mode only these log types are still stored (the Discord log channel still gets all).
const ESSENTIAL_LOGS = new Set(['modActions', 'automod', 'bans', 'serverRoles', 'channels', 'server']);

const state = { lowSpace: false, lastCheck: null, db: null, lastAlertAt: 0 };

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
async function pruneByAge(now, guildId = null, maxDays = null) {
  const cut = (days) => new Date(now - Math.min(days, maxDays || days) * DAY);
  if (guildId) {
    const config = await GuildConfig.findOne({ guildId }, { logRetentionDays: 1 }).lean();
    const res = await LogEntry.deleteMany({ guildId, createdAt: { $lt: cut(retentionDays(config)) } });
    return res.deletedCount || 0;
  }
  let removed = 0;
  // Servers with a non-default retention, grouped by setting; everyone else gets the default.
  const custom = await GuildConfig.find({ logRetentionDays: { $in: RETENTION_CHOICES.filter((d) => d !== DEFAULT_LOG_DAYS) } }, { guildId: 1, logRetentionDays: 1 }).lean();
  const groups = new Map();
  for (const c of custom) groups.set(c.logRetentionDays, [...(groups.get(c.logRetentionDays) || []), c.guildId]);
  for (const [days, ids] of groups) {
    const res = await LogEntry.deleteMany({ guildId: { $in: ids }, createdAt: { $lt: cut(days) } });
    removed += res.deletedCount || 0;
  }
  const res = await LogEntry.deleteMany({ guildId: { $nin: custom.map((c) => c.guildId) }, createdAt: { $lt: cut(DEFAULT_LOG_DAYS) } });
  return removed + (res.deletedCount || 0);
}

/** Keeps at most `cap` entries per server (the newest). Returns how many were removed. */
async function pruneByCount(cap = MAX_LOGS_PER_GUILD, guildId = null) {
  const counts = guildId
    ? [{ _id: guildId, n: await LogEntry.countDocuments({ guildId }) }]
    : await LogEntry.aggregate([{ $group: { _id: '$guildId', n: { $sum: 1 } } }, { $match: { n: { $gt: cap } } }]).catch(() => []);
  let removed = 0;
  for (const { _id: gid, n } of counts) {
    if (n <= cap) continue;
    // The newest `cap` entries stay; everything older than the cap-th newest goes.
    const edge = await LogEntry.find({ guildId: gid }, { createdAt: 1 }).sort({ createdAt: -1 }).skip(cap - 1).limit(1).lean();
    if (!edge[0]) continue;
    const res = await LogEntry.deleteMany({ guildId: gid, createdAt: { $lt: new Date(edge[0].createdAt) } });
    removed += res.deletedCount || 0;
  }
  return removed;
}

async function pruneLogs(now = Date.now(), guildId = null, { maxDays = null, cap = MAX_LOGS_PER_GUILD } = {}) {
  return (await pruneByAge(now, guildId, maxDays)) + (await pruneByCount(cap, guildId));
}

async function pruneOther(now = Date.now(), guildId = null, keep = KEEP) {
  const scope = guildId ? { guildId } : {};
  const before = (days) => new Date(now - days * DAY);
  const [drops, polls, giveaways, transcripts, pots] = await Promise.all([
    ChatDrop.deleteMany({ ...scope, status: 'closed', createdAt: { $lt: before(keep.chatDropsDays) } }),
    Poll.deleteMany({ ...scope, ended: true, endTimestamp: { $lt: now - keep.pollsDays * DAY } }),
    Giveaway.deleteMany({ ...scope, ended: true, endTimestamp: { $lt: now - keep.giveawaysDays * DAY } }),
    // Closed tickets stay in History; only the old transcript text is dropped.
    Ticket.updateMany({ ...scope, status: 'CLOSED', closedAt: { $lt: before(keep.transcriptsDays) }, 'transcript.0': { $exists: true } }, { $set: { transcript: [] } }),
    // Past Daily XP Pots (winners/rollovers) — only the recent ones are shown anywhere.
    XpPot.deleteMany({ ...scope, status: { $in: ['done', 'rolled'] }, drawAt: { $lt: before(90) } })
  ]);
  return {
    chatDrops: drops.deletedCount || 0,
    polls: polls.deletedCount || 0,
    giveaways: giveaways.deletedCount || 0,
    transcripts: transcripts.modifiedCount || 0,
    pots: pots.deletedCount || 0
  };
}

/** Database size in MB (data + indexes, what Atlas counts), or null when it can't be read. */
async function databaseUsage() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  const s = await db.stats().catch(() => null);
  if (!s) return null;
  const usedMb = ((s.storageSize || s.dataSize || 0) + (s.indexSize || 0)) / MB;
  return { usedMb: Math.round(usedMb * 10) / 10, limitMb: DB_LIMIT_MB, share: usedMb / DB_LIMIT_MB, dataMb: Math.round(((s.dataSize || 0) / MB) * 10) / 10, objects: s.objects || 0 };
}

function memoryUsage() {
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / MB), heapMb: Math.round(m.heapUsed / MB), limitMb: RAM_LIMIT_MB, share: m.rss / MB / RAM_LIMIT_MB };
}

async function alertLowSpace(client, usage) {
  if (Date.now() - state.lastAlertAt < DAY) return; // at most once a day
  state.lastAlertAt = Date.now();
  const { reportIssue } = require('../../utils/errorReporter');
  for (const guild of client?.guilds?.cache?.values() || []) {
    reportIssue(
      guild.id,
      'Database is getting full',
      `LoofaryBot's database is at **${usage.usedMb} MB of ${usage.limitMb} MB** (${Math.round(usage.share * 100)}%). ` +
        'Old logs were trimmed and only moderation logs are being kept for now. Lower **Logs → Storage → Keep log history** on the dashboard, or turn off noisy log types (commands, voice).'
    ).catch?.(() => null);
  }
}

/** Checks the database size and prunes harder when it's getting full. */
async function watchdog(client, now = Date.now(), usageFn = databaseUsage) {
  const usage = await usageFn();
  state.lastCheck = new Date(now);
  state.db = usage;
  if (!usage) return { usage: null };
  const wasLow = state.lowSpace;
  state.lowSpace = usage.share >= LOW_SPACE_AT;
  let removed = null;
  if (state.lowSpace) {
    // Emergency: 7 days of logs, a quarter of the cap, and shorter keep times for everything else.
    removed = {
      logs: await pruneLogs(now, null, { maxDays: 7, cap: Math.floor(MAX_LOGS_PER_GUILD / 4) }),
      ...(await pruneOther(now, null, { chatDropsDays: 7, pollsDays: 30, giveawaysDays: 60, transcriptsDays: 30 }))
    };
    console.warn(`[storage] database at ${usage.usedMb}/${usage.limitMb} MB — emergency clean-up`, removed);
    await alertLowSpace(client, usage);
  } else if (wasLow) {
    console.log(`[storage] database back to ${usage.usedMb}/${usage.limitMb} MB — normal logging resumed`);
  }
  return { usage, removed, lowSpace: state.lowSpace };
}

/** Whether a log type should be stored right now (everything, unless the database is nearly full). */
const shouldStoreLog = (type) => !state.lowSpace || ESSENTIAL_LOGS.has(type);

async function runCleanup({ now = Date.now(), guildId = null } = {}) {
  const logs = await pruneLogs(now, guildId);
  const other = await pruneOther(now, guildId);
  const total = logs + Object.values(other).reduce((a, b) => a + b, 0);
  if (total && !guildId) console.log(`[storage] cleaned up ${logs} log entries, ${JSON.stringify(other)}`);
  return { logs, ...other };
}

/** Counts for the dashboard's Storage card. */
async function storageStats(guildId) {
  const [logs, oldest, byType, db] = await Promise.all([
    LogEntry.countDocuments({ guildId }),
    LogEntry.findOne({ guildId }).sort({ createdAt: 1 }).lean(),
    LogEntry.aggregate([{ $match: { guildId } }, { $group: { _id: '$type', n: { $sum: 1 } } }]).catch(() => []),
    databaseUsage().catch(() => null)
  ]);
  if (db) state.db = db;
  return {
    logs,
    cap: MAX_LOGS_PER_GUILD,
    oldest: oldest?.createdAt || null,
    byType: Object.fromEntries(byType.map((t) => [t._id, t.n])),
    db,
    memory: memoryUsage(),
    lowSpace: state.lowSpace
  };
}

function startStorageCleanup(client) {
  const run = async () => {
    await runCleanup().catch((err) => console.error('Storage cleanup failed:', err.message));
    await watchdog(client).catch((err) => console.error('Storage watchdog failed:', err.message));
    const mem = memoryUsage();
    if (mem.share > 0.8) console.warn(`[storage] memory at ${mem.rssMb}/${mem.limitMb} MB`);
  };
  setTimeout(() => syncLogTtl().then(run), 60 * 1000);
  setInterval(run, 3600 * 1000);
}

module.exports = {
  RETENTION_CHOICES,
  DEFAULT_LOG_DAYS,
  MAX_LOGS_PER_GUILD,
  KEEP,
  ESSENTIAL_LOGS,
  retentionDays,
  syncLogTtl,
  pruneLogs,
  pruneByCount,
  pruneOther,
  runCleanup,
  databaseUsage,
  memoryUsage,
  watchdog,
  shouldStoreLog,
  storageStats,
  startStorageCleanup,
  _state: state
};
