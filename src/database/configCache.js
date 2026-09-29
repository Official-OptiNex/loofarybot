// A few seconds of caching for server settings on the hot path (every chat message reads them).
// MongoDB's free tier allows ~100 operations a second, so saving 2–3 reads per message matters as
// a server grows. Any write through the GuildConfig model clears the entry (see the hooks in
// models/GuildConfig.js), so dashboard and command changes still apply straight away.
const TTL_MS = Number(process.env.CONFIG_CACHE_MS ?? 30000);
const MAX_ENTRIES = 500;
const cache = new Map(); // guildId -> { at, value }

function invalidate(guildId) {
  if (guildId === undefined || guildId === null || typeof guildId === 'object') cache.clear(); // unknown/complex filter
  else cache.delete(String(guildId));
}

/**
 * The server's settings as a plain object with every schema default filled in, or null when the
 * server has none yet. Treat it as read-only.
 */
async function getCachedConfig(guildId) {
  const hit = cache.get(guildId);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const GuildConfig = require('./models/GuildConfig');
  const doc = await GuildConfig.findOne({ guildId });
  const value = doc ? (doc.toObject ? doc.toObject() : doc) : null;
  if (TTL_MS > 0) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(guildId, { at: Date.now(), value });
  }
  return value;
}

module.exports = { getCachedConfig, invalidate, _cache: cache };
