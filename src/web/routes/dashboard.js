const express = require('express');
const { requireAuth, requireGuildAccess, MANAGE_GUILD, ADMINISTRATOR } = require('../utils/authMiddleware');
const GuildConfig = require('../../database/models/GuildConfig');
const WelcomeConfig = require('../../database/models/WelcomeConfig');
const UserLevel = require('../../database/models/UserLevel');
const { getEffectiveXpSettings } = require('../../bot/cogs/modules/leveling');
const { getGamblingSettings } = require('../../bot/cogs/modules/gambling');
const levelColors = require('../../bot/cogs/modules/levelColors');
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
  const [configDoc, welcomeDoc, levelAgg] = await Promise.all([
    GuildConfig.findOne({ guildId: req.guild.id }),
    WelcomeConfig.findOne({ guildId: req.guild.id }).lean(),
    UserLevel.aggregate([
      { $match: { guildId: req.guild.id, xp: { $gt: 0 } } },
      { $group: { _id: null, ranked: { $sum: 1 }, topLevel: { $max: '$level' }, totalXp: { $sum: '$xp' } } }
    ])
  ]);
  const levelStats = levelAgg[0] || { ranked: 0, topLevel: 0, totalXp: 0 };
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

  // Used by the Welcome tab's live preview: the logged-in admin stands in for the new member.
  const sessionUser = req.session.user || {};
  const viewer = {
    id: sessionUser.id,
    username: sessionUser.username || 'new-member',
    avatarUrl: sessionUser.avatar
      ? `https://cdn.discordapp.com/avatars/${sessionUser.id}/${sessionUser.avatar}.png?size=128`
      : 'https://cdn.discordapp.com/embed/avatars/0.png'
  };
  const me = guild.members.me;
  const client = req.app.locals.client;
  const bot = {
    name: me?.displayName || client.user?.username || 'LoofaryBot',
    avatarUrl: me?.displayAvatarURL({ size: 64 }) || client.user?.displayAvatarURL({ size: 64 }) || ''
  };

  // Newest members for the header's avatar stack (from cache — no extra API calls).
  const humans = guild.members.cache.filter((m) => !m.user.bot);
  const recentMembers = [...humans.values()]
    .sort((a, b) => (b.joinedTimestamp || 0) - (a.joinedTimestamp || 0))
    .slice(0, 5)
    .map((m) => ({ name: m.displayName, avatarUrl: m.displayAvatarURL({ size: 64 }) }));

  // "Server goals" panel: next member milestone, leveling participation, and next boost tier.
  const milestones = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  const nextMilestone = milestones.find((m) => m > guild.memberCount) || Math.ceil((guild.memberCount + 1) / 100000) * 100000;
  const boostTiers = [2, 7, 14];
  const nextBoostGoal = boostTiers.find((t) => t > stats.boostCount) || 14;
  const goals = {
    members: { current: guild.memberCount, target: nextMilestone },
    ranked: { current: levelStats.ranked, target: Math.max(guild.memberCount, 1) },
    boosts: { current: stats.boostCount, target: nextBoostGoal, maxed: stats.boostCount >= 14 }
  };

  res.render('guild', {
    viewer,
    recentMembers,
    levelStats,
    goals,
    bot,
    guild,
    config,
    channels: textChannels,
    roles,
    effectiveXp,
    levelColorSettings: levelColors.settingsOf(config),
    levelColorTiers: levelColors.describeTiers(configDoc || {}, guild),
    levelColorPalette: levelColors.PALETTE,
    welcome: welcomeDoc || new WelcomeConfig({ guildId: guild.id }).toObject(),
    gambling: getGamblingSettings(config),
    logEvents: LOG_EVENTS,
    defaultTrapEmbed: DEFAULT_TRAP_EMBED,
    commandReference,
    stats
  });
});

module.exports = router;
