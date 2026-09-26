const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { requireAuth, requireGuildAccess } = require('../utils/authMiddleware');
const GuildConfig = require('../../database/models/GuildConfig');
const { setupHoneypotChannel } = require('../../bot/cogs/modules/honeypot');
const { getOrCreateConfig } = require('../../bot/cogs/modules/leveling');

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
    const { enabled, levelRoles } = req.body; // levelRoles: [{level, roleId}]
    const config = await getOrCreateConfig(req.guild.id);
    if (typeof enabled === 'boolean') config.levelingEnabled = enabled;
    if (Array.isArray(levelRoles)) {
      config.levelRoles = levelRoles
        .filter((lr) => lr.level && lr.roleId)
        .map((lr) => ({ level: Number(lr.level), roleId: String(lr.roleId) }));
    }
    await config.save();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
