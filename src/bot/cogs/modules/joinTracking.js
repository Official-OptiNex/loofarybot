const MemberJoin = require('../../../database/models/MemberJoin');

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

/**
 * Join counts per day or week (UTC) for the last `days` days, with empty buckets filled in, plus a
 * cumulative series that starts from every tracked join before the range.
 */
async function getJoinStats(guildId, { days = 30, bucket = 'day' } = {}) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);

  const [daily, before, total, last24h] = await Promise.all([
    MemberJoin.aggregate([
      { $match: { guildId, joinedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$joinedAt' } }, count: { $sum: 1 } } }
    ]),
    MemberJoin.countDocuments({ guildId, joinedAt: { $lt: since } }),
    MemberJoin.countDocuments({ guildId }),
    MemberJoin.countDocuments({ guildId, joinedAt: { $gte: new Date(Date.now() - DAY_MS) } })
  ]);
  const byDay = new Map(daily.map((d) => [d._id, d.count]));

  const points = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(since.getTime() + i * DAY_MS);
    points.push({ date: dayKey(date), count: byDay.get(dayKey(date)) || 0 });
  }

  let series = points;
  if (bucket === 'week') {
    series = [];
    for (let i = 0; i < points.length; i += 7) {
      const chunk = points.slice(i, i + 7);
      series.push({ date: chunk[0].date, count: chunk.reduce((sum, p) => sum + p.count, 0) });
    }
  }

  let running = before;
  const labels = series.map((p) => p.date);
  const joins = series.map((p) => p.count);
  const cumulative = series.map((p) => (running += p.count));
  const inRange = joins.reduce((a, b) => a + b, 0);
  const last7 = points.slice(-7).reduce((a, p) => a + p.count, 0);

  return { labels, joins, cumulative, totals: { tracked: total, inRange, last7, last24h } };
}

module.exports = { recordJoin, syncJoins, getJoinStats };
