const express = require('express');
const { requireAuth, requireGuildAccess, MANAGE_GUILD, ADMINISTRATOR } = require('../utils/authMiddleware');
const GuildConfig = require('../../database/models/GuildConfig');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const client = req.app.locals.client;

  const manageableGuilds = (req.session.guilds || []).filter((g) => {
    const perms = BigInt(g.permissions || '0');
    const hasPerm = (perms & BigInt(ADMINISTRATOR)) !== 0n || (perms & BigInt(MANAGE_GUILD)) !== 0n;
    const botIsIn = client.guilds.cache.has(g.id);
    return hasPerm && botIsIn;
  });

  res.render('dashboard', { user: req.session.user, guilds: manageableGuilds });
});

router.get('/:guildId', requireAuth, requireGuildAccess, async (req, res) => {
  const config = (await GuildConfig.findOne({ guildId: req.guild.id })) || {};
  const textChannels = req.guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread())
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const roles = req.guild.roles.cache
    .filter((r) => r.name !== '@everyone' && !r.managed)
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.render('guild', {
    guild: req.guild,
    config,
    channels: textChannels,
    roles
  });
});

module.exports = router;
