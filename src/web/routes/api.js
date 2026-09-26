const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { requireAuth, requireGuildAccess, canUse } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');
const { setupHoneypotChannel, refreshCounterEmbed, isHttpUrl } = require('../../bot/cogs/modules/honeypot');
const { LOG_EVENTS } = require('../../bot/cogs/modules/logging');
const { syncJoins, getJoinStats } = require('../../bot/cogs/modules/joinTracking');
const { sendWelcome } = require('../../bot/cogs/modules/welcome');
const WelcomeConfig = require('../../database/models/WelcomeConfig');
const LogEntry = require('../../database/models/LogEntry');
const levelColors = require('../../bot/cogs/modules/levelColors');
const socialAlerts = require('../../bot/cogs/modules/socialAlerts');
const AlertSubscription = require('../../database/models/AlertSubscription');
const AuditEntry = require('../../database/models/AuditEntry');
const ConfigBackup = require('../../database/models/ConfigBackup');
const backups = require('../../bot/cogs/modules/backups');
const { MOD_PAGES } = require('../utils/authMiddleware');
const { getOrCreateConfig, getLeaderboard } = require('../../bot/cogs/modules/leveling');
const EmbedTemplate = require('../../database/models/EmbedTemplate');

const router = express.Router();

// Maps each API route to the dashboard page it belongs to, so moderators can only use the pages
// they've been given. null = available to anyone with dashboard access.
const MODULE_PAGES = { welcome: 'welcome', honeypot: 'honeypot', leveling: 'leveling', autorole: 'autorole', gambling: 'gambling', logs: 'logs', alerts: 'alerts' };
function pageFor(req) {
  const tail = (req.route?.path || '').replace('/guilds/:guildId', '').replace(/^\//, '');
  const first = tail.split('/')[0];
  if (['channels', 'mentionable', 'joins'].includes(first)) return null;
  if (first === 'leaderboard') return 'leaderboard';
  if (first === 'logs') return req.method === 'GET' ? 'logviewer' : 'logs';
  if (first === 'levels' || first === 'levelcolors') return 'leveling';
  if (first === 'embed-templates') return 'embed';
  if (first === 'modules') return MODULE_PAGES[req.params.module] || 'settings';
  if (['settings', 'backups', 'import', 'export', 'audit'].includes(first)) return 'settings';
  return first; // honeypot, gambling, welcome, autorole, alerts
}
function guardApi(req, res, next) {
  const page = pageFor(req);
  if (page === null || canUse(req.access, page)) return next();
  return res.status(403).json({ ok: false, error: "Your dashboard role doesn't include that page." });
}



// GET channels the bot can actually send messages in — used by the embed builder dropdown.
router.get('/guilds/:guildId/channels', requireAuth, requireGuildAccess, guardApi, auditTrail, (req, res) => {
  const me = req.guild.members.me;
  const channels = req.guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread() && me && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ channels });
});

// GET everything the embed builder's live @/#/: autocomplete needs: members, channels, roles, emojis.
router.get('/guilds/:guildId/mentionable', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    // Members aren't always fully cached — fetch (bounded) so autocomplete has real data
    // to search even in servers the bot just joined or hasn't seen much traffic in.
    await req.guild.members.fetch({ limit: 1000 }).catch(() => null);

    const users = req.guild.members.cache
      .filter((m) => !m.user.bot)
      .map((m) => ({ id: m.id, name: m.displayName, username: m.user.username }))
      .slice(0, 1000);

    const channels = req.guild.channels.cache
      .filter((c) => c.isTextBased() && !c.isThread())
      .map((c) => ({ id: c.id, name: c.name }));

    const roles = req.guild.roles.cache
      .filter((r) => r.name !== '@everyone' && !r.managed)
      .map((r) => ({ id: r.id, name: r.name }));

    const emojis = req.guild.emojis.cache.map((e) => ({
      id: e.id,
      name: e.name,
      animated: e.animated,
      url: e.imageURL({ size: 32 })
    }));

    res.json({ users, channels, roles, emojis });
  } catch (err) {
    console.error('Failed to load mentionable data:', err);
    res.status(500).json({ error: 'Failed to load server data.' });
  }
});

// GET a paginated, member-info-enriched XP leaderboard — powers the dashboard's Leaderboard tab.
router.get('/guilds/:guildId/leaderboard', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { entries, total, totalPages } = await getLeaderboard(req.guild.id, page, 10);

    // Members may not all be cached — fetch (bounded) so names/avatars resolve even for
    // users who haven't been active recently.
    await req.guild.members.fetch({ limit: 1000 }).catch(() => null);

    const startRank = (page - 1) * 10;
    const enriched = entries.map((r, i) => {
      const member = req.guild.members.cache.get(r.userId);
      return {
        rank: startRank + i + 1,
        userId: r.userId,
        name: member ? member.displayName : `Unknown User (${r.userId})`,
        avatarUrl: member ? member.displayAvatarURL({ size: 64 }) : null,
        level: r.level,
        xp: r.xp
      };
    });

    res.json({ entries: enriched, page, totalPages, total });
  } catch (err) {
    console.error('Failed to load leaderboard:', err);
    res.status(500).json({ error: 'Failed to load leaderboard.' });
  }
});

router.post('/guilds/:guildId/honeypot', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { channelId, action, embed, dmEnabled } = req.body;
    const client = req.app.locals.client;

    const config = await getOrCreateConfig(req.guild.id);
    if (action && ['kick', 'softban', 'ban'].includes(action)) {
      config.honeypotAction = action;
    }
    if (typeof dmEnabled === 'boolean') config.honeypotDmEnabled = dmEnabled;
    if (embed && typeof embed === 'object') {
      for (const key of ['imageUrl', 'thumbnailUrl']) {
        if (embed[key] && !isHttpUrl(embed[key])) {
          return res.status(400).json({ ok: false, error: `${key === 'imageUrl' ? 'Image' : 'Thumbnail'} URL must start with http(s)://` });
        }
      }
      if (embed.color && !/^#[0-9A-F]{6}$/i.test(embed.color)) {
        return res.status(400).json({ ok: false, error: 'Color must be a hex code like #ED4245.' });
      }
      config.honeypotEmbed = {
        title: String(embed.title || '').slice(0, 256),
        description: String(embed.description || '').slice(0, 4000),
        color: embed.color || '',
        footer: String(embed.footer || '').slice(0, 2048),
        imageUrl: embed.imageUrl || '',
        thumbnailUrl: embed.thumbnailUrl || '',
        showCounts: embed.showCounts !== false
      };
    }
    await config.save();

    if (channelId && channelId !== config.honeypotChannelId) {
      await setupHoneypotChannel(client, req.guild.id, channelId);
    } else {
      await refreshCounterEmbed(client, config);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/guilds/:guildId/levels', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const {
      enabled,
      levelRoles,
      xpMin,
      xpMax,
      xpCooldownSeconds,
      levelXpBase,
      levelUpChannelId,
      xpMultipliers,
      rankCardBoosterOnly
    } = req.body;
    const config = await getOrCreateConfig(req.guild.id);

    if (typeof enabled === 'boolean') config.levelingEnabled = enabled;
    if (Array.isArray(levelRoles)) {
      config.levelRoles = levelRoles
        .filter((lr) => lr.level && lr.roleId)
        .map((lr) => ({ level: Number(lr.level), roleId: String(lr.roleId) }));
    }
    if (Array.isArray(xpMultipliers)) {
      const seen = new Set();
      config.xpMultipliers = xpMultipliers
        .filter((m) => ['channel', 'role'].includes(m.type) && m.targetId && m.multiplier !== '' && m.multiplier != null)
        .map((m) => ({ type: m.type, targetId: String(m.targetId), multiplier: Math.min(Math.max(Number(m.multiplier), 0), 10) }))
        .filter((m) => Number.isFinite(m.multiplier))
        .filter((m) => !seen.has(`${m.type}:${m.targetId}`) && seen.add(`${m.type}:${m.targetId}`));
    }
    if (typeof rankCardBoosterOnly === 'boolean') config.rankCardBoosterOnly = rankCardBoosterOnly;
    if (req.body.daily && typeof req.body.daily === 'object') {
      const d = req.body.daily;
      const num = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
      };
      const cur = config.daily || {};
      config.daily = {
        enabled: d.enabled !== false,
        baseXp: num(d.baseXp, 0, 100000, cur.baseXp ?? 50),
        bonusPerDay: num(d.bonusPerDay, 0, 100000, cur.bonusPerDay ?? 10),
        maxBonus: num(d.maxBonus, 0, 1000000, cur.maxBonus ?? 200),
        milestoneEvery: num(d.milestoneEvery, 0, 365, cur.milestoneEvery ?? 7),
        milestoneBonus: num(d.milestoneBonus, 0, 1000000, cur.milestoneBonus ?? 250)
      };
    }
    // Empty string / undefined from the form clears the override back to the global default.
    config.xpMin = xpMin === '' || xpMin == null ? null : Number(xpMin);
    config.xpMax = xpMax === '' || xpMax == null ? null : Number(xpMax);
    config.xpCooldownSeconds = xpCooldownSeconds === '' || xpCooldownSeconds == null ? null : Number(xpCooldownSeconds);
    config.levelXpBase = levelXpBase === '' || levelXpBase == null ? null : Number(levelXpBase);

    // Empty string means "same channel as the message"; otherwise it must be a text channel in this guild.
    if (levelUpChannelId !== undefined) {
      if (!levelUpChannelId) {
        config.levelUpChannelId = null;
      } else {
        const channel = req.guild.channels.cache.get(String(levelUpChannelId));
        if (!channel || !channel.isTextBased() || channel.isThread()) {
          return res.status(400).json({ ok: false, error: 'That level-up channel is not a text channel in this server.' });
        }
        config.levelUpChannelId = channel.id;
      }
    }

    await config.save();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Level color roles ---

router.post('/guilds/:guildId/levelcolors', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { enabled, interval, maxLevel, placement, anchorRoleId, tiers } = req.body;
    if (placement === 'above' && !anchorRoleId) {
      return res.status(400).json({ ok: false, error: "Pick a role to place the colors above (or choose another placement)." });
    }
    if (anchorRoleId && !req.guild.roles.cache.has(String(anchorRoleId))) {
      return res.status(400).json({ ok: false, error: 'That anchor role is not in this server.' });
    }
    const overrides = [];
    for (const t of Array.isArray(tiers) ? tiers : []) {
      const level = Number(t.level);
      if (!Number.isInteger(level) || level < 1) continue;
      if (t.roleId) {
        const role = req.guild.roles.cache.get(String(t.roleId));
        if (!role) return res.status(400).json({ ok: false, error: `The role picked for level ${level} no longer exists.` });
        if (!levelColors.botCanManage(req.guild, role)) {
          return res.status(400).json({ ok: false, error: `LoofaryBot can't assign @${role.name} (level ${level}) — move its role above it.` });
        }
        overrides.push({ level, roleId: role.id });
      } else {
        overrides.push({ level, roleId: null, color: t.color || null });
      }
    }
    const config = await levelColors.saveSettings(req.guild, {
      enabled: typeof enabled === 'boolean' ? enabled : undefined,
      interval: Number(interval) || undefined,
      maxLevel: Number(maxLevel) || undefined,
      placement,
      anchorRoleId: anchorRoleId ?? null,
      overrides
    });
    res.json({ ok: true, tiers: levelColors.describeTiers(config, req.guild) });
  } catch (err) {
    console.error('Failed to save level colors:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/guilds/:guildId/levelcolors', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  const config = await getOrCreateConfig(req.guild.id);
  res.json({ settings: levelColors.settingsOf(config), tiers: levelColors.describeTiers(config, req.guild) });
});

router.post('/guilds/:guildId/levelcolors/sync', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    res.json({ ok: true, ...(await levelColors.syncAll(req.guild)) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    console.error('Level color sync failed:', err);
    res.status(500).json({ ok: false, error: 'Sync failed. Check the bot has Manage Roles.' });
  }
});

router.post('/guilds/:guildId/levelcolors/remove-auto', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    res.json({ ok: true, ...(await levelColors.removeAutoRoles(req.guild)) });
  } catch (err) {
    console.error('Failed to remove level color roles:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Server settings (admin only): moderator access, bot alerts, change history, backups ---

router.post('/guilds/:guildId/settings/access', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const roleIds = (Array.isArray(req.body.modRoleIds) ? req.body.modRoleIds : [])
      .map(String)
      .filter((id) => req.guild.roles.cache.has(id) && id !== req.guild.id);
    const pages = (Array.isArray(req.body.modPages) ? req.body.modPages : []).filter((p) => Object.keys(MOD_PAGES).includes(p));
    const config = await getOrCreateConfig(req.guild.id);
    config.dashboardAccess = { modRoleIds: [...new Set(roleIds)], modPages: [...new Set(pages)] };
    await config.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/guilds/:guildId/settings/alerts-channel', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  const channelId = req.body.channelId ? String(req.body.channelId) : null;
  if (channelId) {
    const channel = req.guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased() || channel.isThread()) return res.status(400).json({ ok: false, error: 'Pick a text channel.' });
  }
  const config = await getOrCreateConfig(req.guild.id);
  config.alertsChannelId = channelId;
  await config.save();
  res.json({ ok: true });
});

router.get('/guilds/:guildId/audit', requireAuth, requireGuildAccess, guardApi, async (req, res) => {
  const pageSize = 30;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter = { guildId: req.guild.id };
  if (req.query.section) filter.section = String(req.query.section).slice(0, 40);
  const [entries, total] = await Promise.all([
    AuditEntry.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    AuditEntry.countDocuments(filter)
  ]);
  res.json({ entries, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

router.get('/guilds/:guildId/backups', requireAuth, requireGuildAccess, guardApi, async (req, res) => {
  const list = await ConfigBackup.find({ guildId: req.guild.id }, { data: 0 }).sort({ createdAt: -1 }).lean();
  res.json({ backups: list });
});

router.post('/guilds/:guildId/backups', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const b = await backups.createBackup(req.guild, { reason: 'manual', createdBy: req.session.user.username, includeXp: true });
    res.json({ ok: true, id: b._id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/guilds/:guildId/backups/:id/download', requireAuth, requireGuildAccess, guardApi, async (req, res) => {
  const b = await ConfigBackup.findOne({ _id: req.params.id, guildId: req.guild.id }).lean().catch(() => null);
  if (!b) return res.status(404).json({ ok: false, error: 'Backup not found.' });
  const stamp = new Date(b.createdAt).toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="loofarybot-${req.guild.id}-${stamp}-${b.reason}.json"`);
  res.json(b.data);
});

router.post('/guilds/:guildId/backups/:id/restore', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const result = await backups.restoreBackup(req.guild, req.params.id, { includeXp: req.body.includeXp === true, createdBy: req.session.user.username });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/guilds/:guildId/export', requireAuth, requireGuildAccess, guardApi, async (req, res) => {
  const data = await backups.exportGuild(req.guild, { includeXp: req.query.xp === '1' });
  res.setHeader('Content-Disposition', `attachment; filename="loofarybot-${req.guild.id}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});

// Step 1 of an import: validate the file and describe what's in it (nothing is changed).
router.post('/guilds/:guildId/import/preview', requireAuth, requireGuildAccess, guardApi, async (req, res) => {
  try {
    backups.validate(req.body.payload);
    const summary = backups.summarize(req.body.payload);
    res.json({ ok: true, summary: { ...summary, crossServer: summary.guildId && summary.guildId !== req.guild.id } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/guilds/:guildId/import', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const result = await backups.importGuild(req.guild, req.body.payload, { includeXp: req.body.includeXp === true, createdBy: req.session.user.username });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Go-live / upload alerts ---

router.get('/guilds/:guildId/alerts', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  const subs = await AlertSubscription.find({ guildId: req.guild.id }).sort({ createdAt: 1 }).lean();
  res.json({ subscriptions: subs, twitchOfficialApi: socialAlerts.twitchUsesOfficialApi(), defaults: socialAlerts.DEFAULTS });
});

router.post('/guilds/:guildId/alerts', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const sub = await socialAlerts.upsertSubscription(req.guild, req.body, req.body.id || null);
    res.json({ ok: true, subscription: sub.toObject() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.delete('/guilds/:guildId/alerts/:id', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  const result = await AlertSubscription.deleteOne({ _id: req.params.id, guildId: req.guild.id }).catch(() => ({ deletedCount: 0 }));
  if (!result.deletedCount) return res.status(404).json({ ok: false, error: 'Alert not found.' });
  res.json({ ok: true });
});

router.post('/guilds/:guildId/alerts/:id/test', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const sub = await AlertSubscription.findOne({ _id: req.params.id, guildId: req.guild.id });
    if (!sub) return res.status(404).json({ ok: false, error: 'Alert not found.' });
    await socialAlerts.sendTest(req.app.locals.client, sub);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- XP Gambling ---

router.post('/guilds/:guildId/gambling', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { enabled, houseEdge, minBet, maxBet, channelId } = req.body;
    const edge = Number(houseEdge);
    const min = Number(minBet);
    const max = maxBet === '' || maxBet == null || Number(maxBet) === 0 ? null : Number(maxBet);

    if (!Number.isFinite(edge) || edge < 0 || edge > 50) {
      return res.status(400).json({ ok: false, error: 'House edge must be between 0 and 50%.' });
    }
    if (!Number.isInteger(min) || min < 1) return res.status(400).json({ ok: false, error: 'Minimum bet must be at least 1.' });
    if (max !== null && (!Number.isInteger(max) || max < min)) {
      return res.status(400).json({ ok: false, error: 'Maximum bet must be a whole number ≥ the minimum (or blank).' });
    }
    if (channelId && !req.guild.channels.cache.has(String(channelId))) {
      return res.status(400).json({ ok: false, error: 'That channel is not in this server.' });
    }

    const config = await getOrCreateConfig(req.guild.id);
    config.gamblingEnabled = !!enabled;
    config.gamblingHouseEdge = edge;
    config.gamblingMinBet = min;
    config.gamblingMaxBet = max;
    config.gamblingChannelId = channelId || null;
    await config.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save gambling config:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Logging ---

router.post('/guilds/:guildId/logs', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { channelId, events } = req.body;
    if (channelId) {
      const channel = req.guild.channels.cache.get(String(channelId));
      if (!channel || !channel.isTextBased() || channel.isThread()) {
        return res.status(400).json({ ok: false, error: 'That log channel is not a text channel in this server.' });
      }
    }
    const config = await getOrCreateConfig(req.guild.id);
    config.logChannelId = channelId || null;
    if (events && typeof events === 'object') {
      for (const key of Object.keys(LOG_EVENTS)) {
        if (typeof events[key] === 'boolean') config.set(`logEvents.${key}`, events[key]);
      }
    }
    await config.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save logging config:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Module on/off switches (sidebar, overview cards and each module page header) ---

const MODULE_FIELDS = {
  honeypot: 'honeypotEnabled',
  leveling: 'levelingEnabled',
  autorole: 'autoRoleEnabled',
  gambling: 'gamblingEnabled',
  logs: 'logsEnabled',
  alerts: 'socialAlertsEnabled'
};

router.post('/guilds/:guildId/modules/:module', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { module } = req.params;
    const enabled = req.body.enabled === true;

    if (module === 'welcome') {
      const welcome = await WelcomeConfig.findOne({ guildId: req.guild.id });
      if (enabled && !welcome?.channelId) {
        return res.status(400).json({ ok: false, error: 'Pick a welcome channel on the Welcome page first.' });
      }
      await WelcomeConfig.updateOne({ guildId: req.guild.id }, { $set: { enabled } }, { upsert: true });
      return res.json({ ok: true, enabled });
    }

    const field = MODULE_FIELDS[module];
    if (!field) return res.status(404).json({ ok: false, error: 'Unknown module.' });
    const config = await getOrCreateConfig(req.guild.id);
    config[field] = enabled;
    await config.save();

    // Tell the admin when a module is on but still needs setting up to do anything.
    let note = null;
    if (enabled && module === 'honeypot' && !config.honeypotChannelId) note = 'Pick a trap channel to arm it.';
    if (enabled && module === 'autorole' && !config.autoRoleId) note = 'Pick a role to hand out.';
    res.json({ ok: true, enabled, note });
  } catch (err) {
    console.error('Failed to toggle module:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Server log viewer ---

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/guilds/:guildId/logs', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const pageSize = 25;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = { guildId: req.guild.id };
    if (req.query.type && Object.keys(LOG_EVENTS).includes(req.query.type)) filter.type = req.query.type;
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ userTag: rx }, { userId: q }, { summary: rx }, { before: rx }, { after: rx }, { channelName: rx }];
    }

    const [entries, total] = await Promise.all([
      LogEntry.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      LogEntry.countDocuments(filter)
    ]);
    res.json({ entries, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (err) {
    console.error('Failed to load logs:', err);
    res.status(500).json({ error: 'Failed to load logs.' });
  }
});

// --- Join analytics ---

router.get('/guilds/:guildId/joins', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 365);
    const bucket = req.query.bucket === 'week' ? 'week' : 'day';
    res.json(await getJoinStats(req.guild.id, { days, bucket }));
  } catch (err) {
    console.error('Failed to load join stats:', err);
    res.status(500).json({ error: 'Failed to load join data.' });
  }
});

router.post('/guilds/:guildId/joins/sync', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const result = await syncJoins(req.guild);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ ok: false, error: err.message });
    console.error('Join sync failed:', err);
    res.status(500).json({ ok: false, error: 'Sync failed. Check that the Server Members intent is enabled.' });
  }
});

// --- Welcome messages ---

function cleanWelcomeInput(body, guild) {
  const errors = [];
  const embed = body.embedConfig && typeof body.embedConfig === 'object' ? body.embedConfig : {};
  for (const key of ['imageUrl', 'thumbnailUrl']) {
    const v = embed[key];
    if (v && !(key === 'thumbnailUrl' && v === '{avatar}') && !isHttpUrl(v)) {
      errors.push(`${key === 'imageUrl' ? 'Image' : 'Thumbnail'} URL must start with http(s)://`);
    }
  }
  if (embed.color && !/^#[0-9A-F]{6}$/i.test(embed.color)) errors.push('Color must be a hex code like #5865F2.');
  if (body.channelId) {
    const channel = guild.channels.cache.get(String(body.channelId));
    if (!channel || !channel.isTextBased() || channel.isThread()) errors.push('That welcome channel is not a text channel in this server.');
  }
  return {
    errors,
    data: {
      enabled: !!body.enabled,
      channelId: body.channelId ? String(body.channelId) : null,
      messageContent: String(body.messageContent || '').slice(0, 2000),
      embedEnabled: !!body.embedEnabled,
      embedConfig: {
        title: String(embed.title || '').slice(0, 256),
        description: String(embed.description || '').slice(0, 4096),
        color: embed.color || '#5865F2',
        imageUrl: embed.imageUrl || '',
        thumbnailUrl: embed.thumbnailUrl || '',
        footer: String(embed.footer || '').slice(0, 2048)
      }
    }
  };
}

router.get('/guilds/:guildId/welcome', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  const config = await WelcomeConfig.findOne({ guildId: req.guild.id }).lean();
  res.json({ config: config || new WelcomeConfig({ guildId: req.guild.id }).toObject() });
});

router.post('/guilds/:guildId/welcome', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { errors, data } = cleanWelcomeInput(req.body, req.guild);
    if (errors.length) return res.status(400).json({ ok: false, error: errors[0] });
    if (data.enabled && !data.channelId) return res.status(400).json({ ok: false, error: 'Pick a welcome channel before enabling.' });
    if (data.enabled && !data.messageContent.trim() && !data.embedEnabled) {
      return res.status(400).json({ ok: false, error: 'Add a message or turn on the embed before enabling.' });
    }
    await WelcomeConfig.findOneAndUpdate({ guildId: req.guild.id }, { $set: data }, { upsert: true, setDefaultsOnInsert: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save welcome config:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Called from the Embed Builder's "Use as Welcome Message" button: replaces the welcome text/embed
// but keeps the existing channel and on/off state.
router.post('/guilds/:guildId/welcome/from-embed', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { content, title, description, color, footer, imageUrl, thumbnailUrl } = req.body;
    const existing = (await WelcomeConfig.findOne({ guildId: req.guild.id }).lean()) || {};
    const { errors, data } = cleanWelcomeInput(
      {
        enabled: existing.enabled,
        channelId: existing.channelId,
        messageContent: content,
        embedEnabled: !!(title || description || footer || imageUrl || thumbnailUrl),
        embedConfig: { title, description, color, footer, imageUrl, thumbnailUrl }
      },
      req.guild
    );
    if (errors.length) return res.status(400).json({ ok: false, error: errors[0] });
    await WelcomeConfig.findOneAndUpdate({ guildId: req.guild.id }, { $set: data }, { upsert: true, setDefaultsOnInsert: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save welcome from embed builder:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Sends the (unsaved) form's welcome message to the chosen channel, as if the logged-in admin just joined.
router.post('/guilds/:guildId/welcome/test', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { errors, data } = cleanWelcomeInput(req.body, req.guild);
    if (errors.length) return res.status(400).json({ ok: false, error: errors[0] });
    const member = await req.guild.members.fetch(req.session.user.id).catch(() => null);
    if (!member) return res.status(400).json({ ok: false, error: "Couldn't find you in this server to use as the test member." });
    const problem = await sendWelcome(member, { force: true, config: data });
    if (problem) return res.status(400).json({ ok: false, error: problem });
    res.json({ ok: true });
  } catch (err) {
    console.error('Welcome test failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to send. Check that all URLs are valid.' });
  }
});

// --- Embed Templates: save/load/delete named embed drafts per guild ---

router.get('/guilds/:guildId/embed-templates', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const templates = await EmbedTemplate.find({ guildId: req.guild.id }).sort({ name: 1 });
    res.json({ templates });
  } catch (err) {
    console.error('Failed to load embed templates:', err);
    res.status(500).json({ error: 'Failed to load templates.' });
  }
});

router.post('/guilds/:guildId/embed-templates', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { name, title, description, color, footer, imageUrl, thumbnailUrl, fields, content } = req.body;
    const cleanName = String(name || '').trim().slice(0, 100);
    if (!cleanName) {
      return res.status(400).json({ ok: false, error: 'A template name is required.' });
    }

    const cleanFields = Array.isArray(fields)
      ? fields
          .filter((f) => f && f.name && f.value)
          .slice(0, 25)
          .map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline }))
      : [];

    const data = {
      guildId: req.guild.id,
      name: cleanName,
      createdBy: req.session.user.id,
      title: title || '',
      description: description || '',
      content: content || '',
      color: color || '#5865f2',
      footer: footer || '',
      imageUrl: imageUrl || '',
      thumbnailUrl: thumbnailUrl || '',
      fields: cleanFields
    };

    // Upsert: saving under an existing name in this guild overwrites it rather than erroring,
    // so "Save" behaves the way people expect for an already-loaded template.
    const template = await EmbedTemplate.findOneAndUpdate({ guildId: req.guild.id, name: cleanName }, data, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });

    res.json({ ok: true, template });
  } catch (err) {
    console.error('Failed to save embed template:', err);
    res.status(500).json({ ok: false, error: 'Failed to save template.' });
  }
});

router.delete('/guilds/:guildId/embed-templates/:name', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const result = await EmbedTemplate.deleteOne({ guildId: req.guild.id, name: req.params.name });
    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: 'Template not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete embed template:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete template.' });
  }
});

// --- Auto-Role ---

router.post('/guilds/:guildId/autorole', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const { roleId, enabled } = req.body;
    const config = await getOrCreateConfig(req.guild.id);
    if (roleId !== undefined) config.autoRoleId = roleId || null;
    if (typeof enabled === 'boolean') config.autoRoleEnabled = enabled;
    await config.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save auto-role config:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/guilds/:guildId/autorole/sync', requireAuth, requireGuildAccess, guardApi, auditTrail, async (req, res) => {
  try {
    const config = await getOrCreateConfig(req.guild.id);
    if (!config.autoRoleId) {
      return res.status(400).json({ ok: false, error: 'No auto-role is configured yet.' });
    }
    const role = req.guild.roles.cache.get(config.autoRoleId);
    if (!role) {
      return res.status(404).json({ ok: false, error: 'The configured role no longer exists.' });
    }
    const botMember = req.guild.members.me;
    if (!botMember || botMember.roles.highest.position <= role.position) {
      return res.status(400).json({
        ok: false,
        error: `LoofaryBot's role is below ${role.name} in the hierarchy — move it above before syncing.`
      });
    }

    const members = await req.guild.members.fetch();
    const needsRole = members.filter((m) => !m.user.bot && !m.roles.cache.has(role.id));

    let granted = 0;
    let failed = 0;
    for (const member of needsRole.values()) {
      try {
        await member.roles.add(role, 'Auto-role sync (dashboard)');
        granted++;
      } catch {
        failed++;
      }
    }

    res.json({ ok: true, granted, failed });
  } catch (err) {
    console.error('Auto-role sync failed:', err);
    res.status(500).json({ ok: false, error: 'Sync failed. Check the server logs.' });
  }
});

module.exports = router;
