const express = require('express');
const { requireAuth, requireGuildAccess, MANAGE_GUILD, ADMINISTRATOR } = require('../utils/authMiddleware');
const GuildConfig = require('../../database/models/GuildConfig');
const { getEffectiveXpSettings } = require('../../bot/cogs/modules/leveling');
const { getGamblingSettings } = require('../../bot/cogs/modules/gambling');
const { LOG_EVENTS } = require('../../bot/cogs/modules/logging');
const { DEFAULT_TRAP_EMBED } = require('../../bot/cogs/modules/honeypot');
const commandReference = require('../../bot/commandReference');
const { XP_MIN, XP_MAX, XP_COOLDOWN_MS, LEVEL_XP_BASE } = require('../../config');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const client = req.app.locals.client;

  const manageableGuilds = (req.session.guilds || [])
    .filter((g) => {
      const perms = BigInt(g.permissions || '0');
      const hasPerm = (perms & BigInt(ADMINISTRATOR)) !== 0n || (perms & BigInt(MANAGE_GUILD)) !== 0n;
      return hasPerm && client.guilds.cache.has(g.id);
    })
    .map((g) => {
      const liveGuild = client.guilds.cache.get(g.id);
      return { ...g, memberCount: liveGuild.memberCount, channelCount: liveGuild.channels.cache.size };
    });

  res.render('dashboard', {
    user: req.session.user,
    guilds: manageableGuilds,
    botTag: client.user?.tag || 'LoofaryBot',
    totalGuilds: client.guilds.cache.size
  });
});

router.get('/:guildId', requireAuth, requireGuildAccess, async (req, res) => {
  const configDoc = await GuildConfig.findOne({ guildId: req.guild.id });
  const config = configDoc || {};
  const guild = req.guild;

  const textChannels = guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread())
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const botHighestPosition = guild.members.me?.roles.highest.position ?? 0;
  const roles = guild.roles.cache
    .filter((r) => r.name !== '@everyone' && !r.managed)
    .map((r) => ({ id: r.id, name: r.name, assignable: r.position < botHighestPosition }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const effectiveXp = configDoc
    ? getEffectiveXpSettings(configDoc)
    : { xpMin: XP_MIN, xpMax: XP_MAX, cooldownMs: XP_COOLDOWN_MS, levelXpBase: LEVEL_XP_BASE };

  // Extra live server details for a fuller, less-empty Overview tab.
  const owner = await guild.fetchOwner().catch(() => null);
  const autoRoleRole = config.autoRoleId ? guild.roles.cache.get(config.autoRoleId) : null;
  const stats = {
    memberCount: guild.memberCount,
    channelCount: guild.channels.cache.size,
    roleCount: guild.roles.cache.size,
    emojiCount: guild.emojis.cache.size,
    boostTier: guild.premiumTier === 'NONE' ? 0 : Number(guild.premiumTier),
    boostCount: guild.premiumSubscriptionCount || 0,
    createdTimestamp: guild.createdTimestamp,
    ownerTag: owner ? owner.user.tag : 'Unknown',
    autoRoleName: autoRoleRole ? autoRoleRole.name : null
  };

  res.render('guild', {
    guild,
    config,
    channels: textChannels,
    roles,
    effectiveXp,
    gambling: getGamblingSettings(config),
    logEvents: LOG_EVENTS,
    defaultTrapEmbed: DEFAULT_TRAP_EMBED,
    commandReference,
    stats
  });
});

module.exports = router;
