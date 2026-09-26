const { PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const UserLevel = require('../../../database/models/UserLevel');

// Color progression for auto-created tier roles (cool → warm → gold at the top).
const PALETTE = [
  '#5B8CFF', '#4FA3FF', '#3CC2F0', '#2ED3C0', '#3DDC97', '#7ED957', '#B8E04A', '#F2D544', '#FFB547', '#FF9A3D',
  '#FF7A45', '#FF5C7A', '#F2508F', '#E056C1', '#C061F0', '#9B6BFF', '#7C5CFF', '#A07BFF', '#FF6FD8', '#FFD700'
];
const MAX_TIERS = 50;

let clientRef = null;
function setClient(client) {
  clientRef = client;
}

function settingsOf(config) {
  const lc = (config && config.levelColors) || {};
  const interval = Math.max(1, Math.floor(lc.interval || 5));
  const maxLevel = Math.max(interval, Math.floor(lc.maxLevel || 100));
  return {
    enabled: !!lc.enabled,
    interval,
    maxLevel,
    placement: lc.placement || 'low',
    anchorRoleId: lc.anchorRoleId || null,
    tiers: lc.tiers || []
  };
}

// Tier levels for the current settings, e.g. interval 5 / max 100 → [5, 10, …, 100].
function tierLevels(settings) {
  const levels = [];
  for (let l = settings.interval; l <= settings.maxLevel && levels.length < MAX_TIERS; l += settings.interval) levels.push(l);
  return levels;
}

function defaultColor(settings, level) {
  const index = Math.max(0, Math.round(level / settings.interval) - 1);
  const levels = tierLevels(settings);
  // The top tier is always gold; the rest walk through the palette.
  if (level === levels[levels.length - 1]) return '#FFD700';
  return PALETTE[index % (PALETTE.length - 1)];
}

// Highest tier level the given level has reached, or null below the first tier.
function tierFor(settings, level) {
  if (level < settings.interval) return null;
  const capped = Math.min(level, settings.maxLevel);
  return Math.floor(capped / settings.interval) * settings.interval;
}

/**
 * Full tier table (every tier level) merged with what's stored: custom overrides, created roles,
 * and color overrides. Used by the dashboard and by sync.
 */
function describeTiers(config, guild) {
  const settings = settingsOf(config);
  return tierLevels(settings).map((level) => {
    const stored = settings.tiers.find((t) => t.level === level) || {};
    const role = stored.roleId ? guild?.roles.cache.get(stored.roleId) : null;
    return {
      level,
      custom: !!stored.custom,
      roleId: role ? role.id : null,
      roleName: role ? role.name : null,
      color: stored.custom ? (role ? role.hexColor : null) : stored.color || defaultColor(settings, level),
      exists: !!role
    };
  });
}

function botCanManage(guild, role) {
  const me = guild.members.me;
  return !!(me && role && !role.managed && me.roles.highest.position > role.position && me.permissions.has(PermissionFlagsBits.ManageRoles));
}

// Where auto roles should sit in the role list (lowest tier at this position, higher tiers above it).
function basePosition(guild, settings, count) {
  const top = guild.members.me?.roles.highest.position ?? 1;
  if (settings.placement === 'high') return Math.max(1, top - count);
  if (settings.placement === 'above' && settings.anchorRoleId) {
    const anchor = guild.roles.cache.get(settings.anchorRoleId);
    if (anchor) return Math.min(anchor.position + 1, Math.max(1, top - count));
  }
  return 1;
}

/** Re-stacks the auto-created roles at the configured spot, lowest tier first. Best effort. */
async function arrangeRoles(guild, config) {
  const settings = settingsOf(config);
  const autoRoles = settings.tiers
    .filter((t) => !t.custom && t.roleId)
    .sort((a, b) => a.level - b.level)
    .map((t) => guild.roles.cache.get(t.roleId))
    .filter((r) => r && botCanManage(guild, r));
  if (!autoRoles.length) return true;
  const base = basePosition(guild, settings, autoRoles.length);
  try {
    await guild.roles.setPositions(autoRoles.map((role, i) => ({ role: role.id, position: base + i })));
    return true;
  } catch (err) {
    console.error(`Could not arrange level color roles in ${guild.id}:`, err.message);
    return false;
  }
}

const creating = new Map(); // `${guildId}:${level}` -> Promise<Role>

/**
 * Returns the role for a tier, creating the auto role the first time anyone reaches it (or if an
 * admin deleted it). Custom tiers never create anything.
 */
async function ensureTierRole(guild, config, level) {
  const settings = settingsOf(config);
  const stored = settings.tiers.find((t) => t.level === level);
  if (stored?.roleId) {
    const existing = guild.roles.cache.get(stored.roleId);
    if (existing || stored.custom) return existing || null;
  }

  const key = `${guild.id}:${level}`;
  if (creating.has(key)) return creating.get(key);
  const job = (async () => {
    const role = await guild.roles.create({
      name: `Level ${level}`,
      color: stored?.color || defaultColor(settings, level),
      permissions: [],
      hoist: false,
      mentionable: false,
      reason: `LoofaryBot level color role (level ${level})`
    });
    // Re-read to avoid clobbering concurrent edits, then record the new role.
    const fresh = await GuildConfig.findOne({ guildId: guild.id });
    const tiers = fresh.levelColors.tiers.filter((t) => t.level !== level);
    tiers.push({ level, roleId: role.id, custom: false, color: stored?.color || null });
    fresh.levelColors.tiers = tiers;
    await fresh.save();
    await arrangeRoles(guild, fresh);
    return role;
  })();
  creating.set(key, job);
  try {
    return await job;
  } finally {
    creating.delete(key);
  }
}

// Every role id the color system manages for this guild (auto and custom).
function managedRoleIds(config) {
  return new Set(settingsOf(config).tiers.filter((t) => t.roleId).map((t) => t.roleId));
}

/**
 * Gives the member exactly one color role — the one for their highest tier — and removes any other
 * tier role they hold. Returns { added, removed } role ids, or null when nothing changed.
 */
async function applyMemberColor(guild, member, level, config) {
  const settings = settingsOf(config);
  if (!settings.enabled || !member || member.user.bot) return null;

  const tier = tierFor(settings, level);
  const target = tier ? await ensureTierRole(guild, config, tier).catch((err) => {
    require('../../utils/errorReporter').reportIssue(
      guild.id,
      'Level color role could not be created',
      `Creating the Level ${tier} color role failed: ${err.message}. LoofaryBot needs the Manage Roles permission.`
    );
    return null;
  }) : null;

  // Refresh config if a role was just created so the managed set includes it.
  const latest = target ? await GuildConfig.findOne({ guildId: guild.id }).lean() : config;
  const managed = managedRoleIds(latest || config);
  const toRemove = member.roles.cache.filter((r) => managed.has(r.id) && r.id !== target?.id && botCanManage(guild, r));
  const toAdd = target && !member.roles.cache.has(target.id) && botCanManage(guild, target) ? target : null;
  if (!toRemove.size && !toAdd) return null;

  if (toRemove.size) await member.roles.remove([...toRemove.keys()], 'Level color update');
  if (toAdd) await member.roles.add(toAdd, `Reached level ${tier}`);
  return { added: toAdd ? toAdd.id : null, removed: [...toRemove.keys()] };
}

/** Hook called by leveling whenever a stored level changes (chat, gambling, admin XP changes). */
async function onLevelChange(guildId, userId, newLevel) {
  if (!clientRef) return;
  const guild = clientRef.guilds.cache.get(guildId);
  if (!guild) return;
  const config = await GuildConfig.findOne({ guildId });
  if (!config || !settingsOf(config).enabled) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  await applyMemberColor(guild, member, newLevel, config).catch((err) =>
    require('../../utils/errorReporter').reportIssue(
      guildId,
      'Level color could not be updated',
      `Updating <@${userId}>'s color role failed: ${err.message}. Check that LoofaryBot's role is above the level color roles.`
    )
  );
}

const syncing = new Set();

/**
 * Recalculates every member's color role from their stored level. Creates any tier roles that are
 * needed, fixes placement, and strips color roles from members below the first tier.
 */
async function syncAll(guild) {
  if (syncing.has(guild.id)) {
    const err = new Error('A level color sync is already running for this server.');
    err.status = 429;
    throw err;
  }
  syncing.add(guild.id);
  try {
    let config = await GuildConfig.findOne({ guildId: guild.id });
    const settings = settingsOf(config);
    if (!settings.enabled) throw Object.assign(new Error('Turn level colors on first.'), { status: 400 });
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw Object.assign(new Error('LoofaryBot needs the Manage Roles permission.'), { status: 400 });
    }

    const [members, records] = await Promise.all([
      guild.members.fetch(),
      UserLevel.find({ guildId: guild.id }, { userId: 1, level: 1 }).lean()
    ]);
    const levelOf = new Map(records.map((r) => [r.userId, r.level]));

    // Create every tier role someone currently qualifies for, before touching members.
    const neededTiers = new Set(
      members.filter((m) => !m.user.bot).map((m) => tierFor(settings, levelOf.get(m.id) || 0)).filter(Boolean)
    );
    for (const tier of [...neededTiers].sort((a, b) => a - b)) {
      await ensureTierRole(guild, await GuildConfig.findOne({ guildId: guild.id }), tier);
    }
    config = await GuildConfig.findOne({ guildId: guild.id });
    await arrangeRoles(guild, config);

    let updated = 0;
    let failed = 0;
    for (const member of members.values()) {
      if (member.user.bot) continue;
      try {
        if (await applyMemberColor(guild, member, levelOf.get(member.id) || 0, config)) updated++;
      } catch {
        failed++;
      }
    }
    return { scanned: members.filter((m) => !m.user.bot).size, updated, failed, tiersInUse: neededTiers.size };
  } finally {
    syncing.delete(guild.id);
  }
}

/** Removes and deletes every auto-created color role (custom roles are left alone). */
async function removeAutoRoles(guild) {
  const config = await GuildConfig.findOne({ guildId: guild.id });
  let deleted = 0;
  for (const tier of settingsOf(config).tiers.filter((t) => !t.custom && t.roleId)) {
    const role = guild.roles.cache.get(tier.roleId);
    if (role && botCanManage(guild, role)) {
      await role.delete('Level color roles removed from the dashboard').catch(() => null);
      deleted++;
    }
  }
  config.levelColors.tiers = config.levelColors.tiers.filter((t) => t.custom).map((t) => t.toObject?.() || t);
  await config.save();
  return { deleted };
}

/**
 * Applies new settings (from the dashboard or /levels colorroles). Keeps created roles for tiers
 * that still exist, recolors auto roles whose color changed, and deletes auto roles for tiers that
 * no longer exist (e.g. after changing the interval).
 */
async function saveSettings(guild, { enabled, interval, maxLevel, placement, anchorRoleId, overrides }) {
  const config = await GuildConfig.findOne({ guildId: guild.id });
  const lc = config.levelColors;
  const before = settingsOf(config);
  if (typeof enabled === 'boolean') lc.enabled = enabled;
  if (interval) lc.interval = Math.min(Math.max(1, Math.floor(interval)), 1000);
  if (maxLevel) lc.maxLevel = Math.min(Math.max(lc.interval, Math.floor(maxLevel)), 10000);
  if (placement && ['low', 'high', 'above'].includes(placement)) lc.placement = placement;
  if (anchorRoleId !== undefined) lc.anchorRoleId = anchorRoleId || null;

  const after = settingsOf(config);
  const validLevels = new Set(tierLevels(after));
  const byLevel = new Map(before.tiers.map((t) => [t.level, { ...(t.toObject?.() || t) }]));

  // Overrides: { level, roleId (custom role) | null, color }.
  for (const o of overrides || []) {
    if (!validLevels.has(o.level)) continue;
    const current = byLevel.get(o.level) || { level: o.level, roleId: null, custom: false, color: null };
    if (o.roleId) {
      if (!current.custom && current.roleId && current.roleId !== o.roleId) {
        // Switching an auto tier to a custom role: delete the auto role we made.
        const old = guild.roles.cache.get(current.roleId);
        if (old && botCanManage(guild, old)) await old.delete('Replaced by a custom level color role').catch(() => null);
      }
      byLevel.set(o.level, { level: o.level, roleId: o.roleId, custom: true, color: null });
    } else {
      const wasCustom = current.custom;
      const color = /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color : null;
      const next = { level: o.level, roleId: wasCustom ? null : current.roleId, custom: false, color };
      const role = next.roleId ? guild.roles.cache.get(next.roleId) : null;
      const wanted = color || defaultColor(after, o.level);
      if (role && botCanManage(guild, role) && role.hexColor.toLowerCase() !== wanted.toLowerCase()) {
        await role.setColor(wanted, 'Level color changed on the dashboard').catch(() => null);
      }
      byLevel.set(o.level, next);
    }
  }

  // Drop tiers that no longer exist, deleting the auto roles behind them.
  for (const [level, tier] of byLevel) {
    if (validLevels.has(level)) continue;
    if (!tier.custom && tier.roleId) {
      const role = guild.roles.cache.get(tier.roleId);
      if (role && botCanManage(guild, role)) await role.delete('Level color tier removed').catch(() => null);
    }
    byLevel.delete(level);
  }

  lc.tiers = [...byLevel.values()].sort((a, b) => a.level - b.level);
  await config.save();
  if (after.enabled) await arrangeRoles(guild, config);
  return config;
}

module.exports = {
  PALETTE,
  setClient,
  settingsOf,
  tierLevels,
  tierFor,
  defaultColor,
  describeTiers,
  botCanManage,
  applyMemberColor,
  onLevelChange,
  syncAll,
  removeAutoRoles,
  saveSettings,
  arrangeRoles
};
