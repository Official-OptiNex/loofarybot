const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { requireAuth, requireGuildAccess } = require('../utils/authMiddleware');
const { setupHoneypotChannel } = require('../../bot/cogs/modules/honeypot');
const { getOrCreateConfig, getLeaderboard } = require('../../bot/cogs/modules/leveling');

const router = express.Router();

// GET channels the bot can actually send messages in — used by the embed builder dropdown.
router.get('/guilds/:guildId/channels', requireAuth, requireGuildAccess, (req, res) => {
  const me = req.guild.members.me;
  const channels = req.guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread() && me && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ channels });
});

// GET everything the embed builder's live @/#/: autocomplete needs: members, channels, roles, emojis.
router.get('/guilds/:guildId/mentionable', requireAuth, requireGuildAccess, async (req, res) => {
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
router.get('/guilds/:guildId/leaderboard', requireAuth, requireGuildAccess, async (req, res) => {
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

router.post('/guilds/:guildId/honeypot', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { channelId, action } = req.body;
    const client = req.app.locals.client;

    const config = await getOrCreateConfig(req.guild.id);
    if (action && ['kick', 'softban', 'ban'].includes(action)) {
      config.honeypotAction = action;
      await config.save();
    }
    if (channelId && channelId !== config.honeypotChannelId) {
      await setupHoneypotChannel(client, req.guild.id, channelId);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/guilds/:guildId/levels', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { enabled, levelRoles, xpMin, xpMax, xpCooldownSeconds, levelXpBase } = req.body;
    const config = await getOrCreateConfig(req.guild.id);

    if (typeof enabled === 'boolean') config.levelingEnabled = enabled;
    if (Array.isArray(levelRoles)) {
      config.levelRoles = levelRoles
        .filter((lr) => lr.level && lr.roleId)
        .map((lr) => ({ level: Number(lr.level), roleId: String(lr.roleId) }));
    }
    // Empty string / undefined from the form clears the override back to the global default.
    config.xpMin = xpMin === '' || xpMin == null ? null : Number(xpMin);
    config.xpMax = xpMax === '' || xpMax == null ? null : Number(xpMax);
    config.xpCooldownSeconds = xpCooldownSeconds === '' || xpCooldownSeconds == null ? null : Number(xpCooldownSeconds);
    config.levelXpBase = levelXpBase === '' || levelXpBase == null ? null : Number(levelXpBase);

    await config.save();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
