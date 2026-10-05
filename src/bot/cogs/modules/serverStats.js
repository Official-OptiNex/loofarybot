// Server Stats channels: a stack of view-only voice channels at the top of the server whose names
// show live counts (members, online, boosts, top XP, …). Members can see them but not enter or talk.
// The names are refreshed on a timer (every 30 min by default — channel renames are heavily
// rate-limited, so we never update more often than that).
const { ChannelType, PermissionFlagsBits, Routes } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const UserLevel = require('../../../database/models/UserLevel');

const CATEGORY_NAME = '📊 Server Stats';
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

// Every stat that can be shown. `needsOnline` marks the one that needs the live presence count.
const STAT_DEFS = [
  { key: 'members', emoji: '👥', label: 'Members', value: (c) => fmt(c.memberCount) },
  { key: 'online', emoji: '🟢', label: 'Online', value: (c) => fmt(c.online), needsOnline: true },
  { key: 'boosts', emoji: '🚀', label: 'Boosts', value: (c) => `Lvl ${c.boostTier} (${fmt(c.boostCount)})` },
  { key: 'highestxp', emoji: '🏆', label: 'Top XP', value: (c) => fmt(c.highestXp) },
  { key: 'roles', emoji: '🎭', label: 'Roles', value: (c) => fmt(c.roleCount) },
  { key: 'channels', emoji: '💬', label: 'Channels', value: (c) => fmt(c.channelCount) }
];
const DEF_BY_KEY = Object.fromEntries(STAT_DEFS.map((d) => [d.key, d]));
const VALID_KEYS = STAT_DEFS.map((d) => d.key);

function serverStatsSettings(config) {
  const g = (config && config.serverStats) || {};
  const enabledStats = (Array.isArray(g.enabledStats) ? g.enabledStats : ['members', 'online', 'boosts', 'highestxp']).filter((k) => VALID_KEYS.includes(k));
  return {
    enabled: !!g.enabled,
    categoryId: g.categoryId || null,
    channels: g.channels && typeof g.channels === 'object' ? { ...g.channels } : {},
    enabledStats: enabledStats.length ? enabledStats : ['members']
  };
}

/** The channel name for a stat, e.g. "👥 Members: 233". Clamped to Discord's 100-char limit. */
function channelName(def, ctx) {
  return `${def.emoji} ${def.label}: ${def.value(ctx)}`.slice(0, 100);
}

/** Gathers the numbers the stats need. Only fetches the live online count when a shown stat needs it. */
async function computeContext(client, guild, enabledStats) {
  const ctx = {
    memberCount: guild.memberCount || 0,
    boostTier: guild.premiumTier || 0,
    boostCount: guild.premiumSubscriptionCount || 0,
    roleCount: Math.max(0, guild.roles.cache.size - 1), // minus @everyone
    channelCount: guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).size,
    online: 0,
    highestXp: 0
  };
  if (enabledStats.includes('online')) {
    // approximate_presence_count needs no privileged intent and no member cache.
    const data = await client.rest.get(Routes.guild(guild.id), { query: new URLSearchParams({ with_counts: 'true' }) }).catch(() => null);
    if (data) {
      ctx.online = data.approximate_presence_count || 0;
      if (!ctx.memberCount) ctx.memberCount = data.approximate_member_count || 0;
    }
  }
  if (enabledStats.includes('highestxp')) {
    const top = await UserLevel.findOne({ guildId: guild.id }, { xp: 1 }).sort({ xp: -1 }).lean().catch(() => null);
    ctx.highestXp = top?.xp || 0;
  }
  return ctx;
}

const everyoneOverwrite = (guild) => ({
  id: guild.roles.everyone.id,
  allow: [PermissionFlagsBits.ViewChannel],
  deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages] // see it, but can't join or talk
});

/**
 * Makes the server's stat channels match the settings: creates the category and any missing channels,
 * removes channels for stats that were turned off, and renames them all to the current numbers.
 * Returns { created, removed, renamed } or { error }. Needs Manage Channels.
 */
async function syncChannels(client, guild) {
  const me = guild.members.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) return { error: 'I need the **Manage Channels** permission to make the stat channels.' };
  const s = serverStatsSettings(await GuildConfig.findOne({ guildId: guild.id }).lean());
  if (!s.enabled) return { error: 'Server Stats is off.' };

  // Category.
  let category = s.categoryId && guild.channels.cache.get(s.categoryId);
  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      position: 0,
      permissionOverwrites: [everyoneOverwrite(guild)]
    });
    await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'serverStats.categoryId': category.id } });
  }
  await category.setPosition(0).catch(() => null); // keep it at the top

  const ctx = await computeContext(client, guild, s.enabledStats);
  const channels = { ...s.channels };
  let created = 0;
  let removed = 0;
  let renamed = 0;

  // Remove channels for stats no longer enabled.
  for (const key of Object.keys(channels)) {
    if (!s.enabledStats.includes(key)) {
      await guild.channels.cache.get(channels[key])?.delete('Server Stats: stat disabled').catch(() => null);
      delete channels[key];
      removed++;
    }
  }
  // Create / rename the enabled ones, in the defined order.
  for (const def of STAT_DEFS) {
    if (!s.enabledStats.includes(def.key)) continue;
    const name = channelName(def, ctx);
    let ch = channels[def.key] && guild.channels.cache.get(channels[def.key]);
    if (!ch) {
      ch = await guild.channels
        .create({ name, type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: [everyoneOverwrite(guild)] })
        .catch(() => null);
      if (ch) {
        channels[def.key] = ch.id;
        created++;
      }
    } else if (ch.name !== name) {
      await ch.setName(name).catch(() => null);
      renamed++;
    }
  }
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'serverStats.channels': channels } });
  return { created, removed, renamed };
}

/** Deletes the stat channels and the category, and clears the stored ids. */
async function removeAll(guild) {
  const s = serverStatsSettings(await GuildConfig.findOne({ guildId: guild.id }).lean());
  for (const id of Object.values(s.channels)) await guild.channels.cache.get(id)?.delete('Server Stats removed').catch(() => null);
  if (s.categoryId) await guild.channels.cache.get(s.categoryId)?.delete('Server Stats removed').catch(() => null);
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'serverStats.channels': {}, 'serverStats.categoryId': null } });
}

/** Refreshes every server's stat channels. Only touches guilds that have the feature on. */
async function runStatsSweep(client) {
  const configs = await GuildConfig.find({ 'serverStats.enabled': true }, { guildId: 1 }).lean();
  let guilds = 0;
  for (const cfg of configs) {
    const guild = client.guilds.cache.get(cfg.guildId);
    if (!guild) continue;
    await syncChannels(client, guild).catch((err) => console.error('[serverStats] sync failed:', err.message));
    guilds++;
  }
  return guilds;
}

/** Runs the refresh on a timer (default every 30 min — channel renames are rate-limited). */
function startStatsLoop(client, intervalMs = 30 * 60000) {
  const tick = () => runStatsSweep(client).catch((err) => console.error('[serverStats] sweep failed:', err.message));
  setTimeout(tick, 15000); // a first pass shortly after startup
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

function cleanSettings(input) {
  const patch = {};
  if (input.enabled !== undefined) patch['serverStats.enabled'] = !!input.enabled;
  if (input.enabledStats !== undefined) {
    const keys = (Array.isArray(input.enabledStats) ? input.enabledStats : []).filter((k) => VALID_KEYS.includes(k));
    patch['serverStats.enabledStats'] = keys.length ? [...new Set(keys)] : ['members'];
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch } = cleanSettings(input);
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { serverStats: 1 }).lean();
  return { settings: serverStatsSettings(fresh) };
}

module.exports = {
  STAT_DEFS,
  VALID_KEYS,
  CATEGORY_NAME,
  serverStatsSettings,
  channelName,
  computeContext,
  syncChannels,
  removeAll,
  runStatsSweep,
  startStatsLoop,
  cleanSettings,
  saveSettings
};
