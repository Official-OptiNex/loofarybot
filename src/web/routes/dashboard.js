const express = require('express');
const { requireAuth, requireGuildAccess, MANAGE_GUILD, ADMINISTRATOR } = require('../utils/authMiddleware');
const GuildConfig = require('../../database/models/GuildConfig');
const { getEffectiveXpSettings } = require('../../bot/cogs/modules/leveling');
const commandReference = require('../../bot/commandReference');
const { XP_MIN, XP_MAX, XP_COOLDOWN_MS, LEVEL_XP_BASE } = require('../../config');

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
  const configDoc = await GuildConfig.findOne({ guildId: req.guild.id });
  const config = configDoc || {};

  const textChannels = req.guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread())
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const botHighestPosition = req.guild.members.me?.roles.highest.position ?? 0;
  const roles = req.guild.roles.cache
    .filter((r) => r.name !== '@everyone' && !r.managed)
    .map((r) => ({ id: r.id, name: r.name, assignable: r.position < botHighestPosition }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Resolve the effective (guild override, or global default) XP settings so the form
  // can show real current values as placeholders/values rather than blank inputs.
  const effectiveXp = configDoc
    ? getEffectiveXpSettings(configDoc)
    : { xpMin: XP_MIN, xpMax: XP_MAX, cooldownMs: XP_COOLDOWN_MS, levelXpBase: LEVEL_XP_BASE };

  res.render('guild', {
    guild: req.guild,
    config,
    channels: textChannels,
    roles,
    effectiveXp,
    commandReference
  });
});

module.exports = router;
