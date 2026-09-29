// Members known to have a UserLevel record, so chat XP can skip an "exists?" query per message.
// Cleared whenever records are deleted or replaced (hooks in models/UserLevel.js). Bounded in size.
const MAX = 20000;
const known = new Set();

const key = (guildId, userId) => `${guildId}:${userId}`;
const has = (guildId, userId) => known.has(key(guildId, userId));
function remember(guildId, userId) {
  if (known.size >= MAX) known.delete(known.values().next().value);
  known.add(key(guildId, userId));
}
function forget(filter) {
  if (filter?.guildId && typeof filter.userId === 'string') known.delete(key(filter.guildId, filter.userId));
  else known.clear();
}

module.exports = { has, remember, forget, _known: known };
