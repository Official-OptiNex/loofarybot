const MemberJoin = require('../../../database/models/MemberJoin');
const MemberLeave = require('../../../database/models/MemberLeave');

const DAY_MS = 86400000;
const SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const lastSyncByGuild = new Map();

// Called from guildMemberAdd. Duplicate-key errors mean the join is already recorded.
async function recordJoin(member) {
  if (member.user.bot) return;
  const joinedAt = new Date(member.joinedTimestamp || Date.now());
  await MemberJoin.updateOne(
    { guildId: member.guild.id, userId: member.id, joinedAt },
    { $setOnInsert: { source: 'live' } },
    { upsert: true }
  ).catch((err) => {
    if (err.code !== 11000) throw err;
  });
}

async function recordLeave(member) {
  if (member.user?.bot) return;
  await MemberLeave.create({ guildId: member.guild.id, userId: member.id, leftAt: new Date() });
}

/**
 * Backfills join records from every current member's joinedAt date. Members who joined, left and
 * rejoined only report their latest join — Discord doesn't expose earlier ones.
 */
async function syncJoins(guild) {
  const last = lastSyncByGuild.get(guild.id);
  if (last && Date.now() - last < SYNC_COOLDOWN_MS) {
    const waitSec = Math.ceil((SYNC_COOLDOWN_MS - (Date.now() - last)) / 1000);
    const err = new Error(`Join data was synced recently — try again in ${waitSec}s.`);
    err.status = 429;
    throw err;
  }
  lastSyncByGuild.set(guild.id, Date.now());

  const members = await guild.members.fetch();
  const ops = members
    .filter((m) => !m.user.bot && m.joinedTimestamp)
    .map((m) => ({
      updateOne: {
        filter: { guildId: guild.id, userId: m.id, joinedAt: new Date(m.joinedTimestamp) },
        update: { $setOnInsert: { source: 'sync' } },
        upsert: true
      }
    }));

  let added = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const result = await MemberJoin.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    added += result.upsertedCount || 0;
  }
  return { scanned: ops.length, added };
}

const dayKey = (date) => date.toISOString().slice(0, 10);

async function dailyCounts(Model, field, guildId, since) {
  const rows = await Model.aggregate([
    { $match: { guildId, [field]: { $gte: since } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}` } }, count: { $sum: 1 } } }
  ]);
  return new Map(rows.map((r) => [r._id, r.count]));
}

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// Percent change from `previous` to `current`; null when there's no baseline to compare with.
const pctChange = (current, previous) => (previous > 0 ? Math.round(((current - previous) / previous) * 100) : null);

/**
 * Joins, leaves and net change per day or week (UTC) for the last `days` days, with empty buckets
 * filled in, a cumulative join series, and headline totals with week-over-week / day-over-day trends.
 */
async function getJoinStats(guildId, { days = 30, bucket = 'day' } = {}) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Always look back at least 14 days so the week-over-week trend has a full previous week.
  const lookback = Math.max(days, 14);
  const since = new Date(today.getTime() - (lookback - 1) * DAY_MS);

  const [joinsByDay, leavesByDay, before, total] = await Promise.all([
    dailyCounts(MemberJoin, 'joinedAt', guildId, since),
    dailyCounts(MemberLeave, 'leftAt', guildId, since),
    MemberJoin.countDocuments({ guildId, joinedAt: { $lt: new Date(today.getTime() - (days - 1) * DAY_MS) } }),
    MemberJoin.countDocuments({ guildId })
  ]);

  const allDays = [];
  for (let i = 0; i < lookback; i++) {
    const key = dayKey(new Date(since.getTime() + i * DAY_MS));
    allDays.push({ date: key, joins: joinsByDay.get(key) || 0, leaves: leavesByDay.get(key) || 0 });
  }
  const points = allDays.slice(-days);

  let series = points;
  if (bucket === 'week') {
    series = [];
    for (let i = 0; i < points.length; i += 7) {
      const chunk = points.slice(i, i + 7);
      series.push({ date: chunk[0].date, joins: sum(chunk.map((p) => p.joins)), leaves: sum(chunk.map((p) => p.leaves)) });
    }
  }

  let running = before;
  const joins = series.map((p) => p.joins);
  const leaves = series.map((p) => p.leaves);

  const last7Days = allDays.slice(-7);
  const prev7Days = allDays.slice(-14, -7);
  const joinsToday = allDays.at(-1).joins;
  const joinsYesterday = allDays.at(-2).joins;
  const joins7 = sum(last7Days.map((p) => p.joins));
  const joinsPrev7 = sum(prev7Days.map((p) => p.joins));
  const leaves7 = sum(last7Days.map((p) => p.leaves));
  const leavesPrev7 = sum(prev7Days.map((p) => p.leaves));

  return {
    labels: series.map((p) => p.date),
    joins,
    leaves,
    net: series.map((p) => p.joins - p.leaves),
    cumulative: joins.map((j) => (running += j)),
    totals: {
      tracked: total,
      inRange: sum(joins),
      leavesInRange: sum(leaves),
      today: joinsToday,
      last7: joins7,
      last24h: joinsToday, // kept for older clients; "today" (UTC) is what's shown now
      leaves7,
      leavesToday: allDays.at(-1).leaves,
      trends: {
        joinsWeek: pctChange(joins7, joinsPrev7),
        joinsDay: pctChange(joinsToday, joinsYesterday),
        leavesWeek: pctChange(leaves7, leavesPrev7),
        netWeek: joins7 - leaves7
      }
    }
  };
}

module.exports = { recordJoin, recordLeave, syncJoins, getJoinStats };
