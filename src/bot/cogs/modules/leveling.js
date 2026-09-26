const { PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const UserLevel = require('../../../database/models/UserLevel');
const { XP_MIN, XP_MAX, XP_COOLDOWN_MS, LEVEL_XP_BASE } = require('../../../config');

// XP required to reach a given level, using either the guild's custom base or the global default.
function xpForLevel(level, base = LEVEL_XP_BASE) {
  return Math.round(base * Math.pow(level, 1.5));
}

function levelForXp(xp, base = LEVEL_XP_BASE) {
  let level = 0;
  while (xp >= xpForLevel(level + 1, base)) level++;
  return level;
}

async function getOrCreateConfig(guildId) {
  let config = await GuildConfig.findOne({ guildId });
  if (!config) config = await GuildConfig.create({ guildId });
  return config;
}

// Resolves a guild's effective tuning values, falling back to the global defaults
// in config.js wherever the guild hasn't set its own override.
function getEffectiveXpSettings(config) {
  return {
    xpMin: config.xpMin ?? XP_MIN,
    xpMax: config.xpMax ?? XP_MAX,
    cooldownMs: (config.xpCooldownSeconds ?? XP_COOLDOWN_MS / 1000) * 1000,
    levelXpBase: config.levelXpBase ?? LEVEL_XP_BASE
  };
}

// Multiplier for a message: the channel's multiplier (or its parent's, for threads) times the
// best matching role multiplier. Either side defaults to 1x when nothing is configured.
function getXpMultiplier(config, channel, member) {
  const multipliers = config.xpMultipliers || [];
  if (multipliers.length === 0) return 1;

  const channelIds = [channel.id, channel.parentId].filter(Boolean);
  const channelEntry = multipliers.find((m) => m.type === 'channel' && channelIds.includes(m.targetId));
  const channelMult = channelEntry ? channelEntry.multiplier : 1;

  const roleMults = member
    ? multipliers.filter((m) => m.type === 'role' && member.roles.cache.has(m.targetId)).map((m) => m.multiplier)
    : [];
  const roleMult = roleMults.length > 0 ? Math.max(...roleMults) : 1;

  return channelMult * roleMult;
}

// Keeps the stored `level` in sync with `xp` after an atomic XP change.
async function syncLevel(guildId, userId, levelXpBase) {
  const record = await UserLevel.findOne({ guildId, userId });
  if (!record) return null;
  const oldLevel = record.level;
  const newLevel = levelForXp(record.xp, levelXpBase);
  if (newLevel !== oldLevel) {
    await UserLevel.updateOne({ _id: record._id }, { $set: { level: newLevel } });
    record.level = newLevel;
    // Name-color roles follow every level change (up or down). Lazy require avoids a cycle.
    require('./levelColors')
      .onLevelChange(guildId, userId, newLevel)
      .catch((err) => console.error('Level color hook failed:', err.message));
  }
  return { record, oldLevel, newLevel };
}

/**
 * Grants every milestone role crossed between oldLevel (exclusive) and newLevel (inclusive).
 * Returns role mentions that couldn't be assigned (usually a hierarchy problem).
 */
async function grantMilestoneRoles(guild, userId, config, oldLevel, newLevel) {
  const milestonesCrossed = (config.levelRoles || []).filter((lr) => lr.level > oldLevel && lr.level <= newLevel);
  if (milestonesCrossed.length === 0) return [];

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return [];

  const botMember = guild.members.me;
  const failures = [];

  for (const milestone of milestonesCrossed) {
    const role = guild.roles.cache.get(milestone.roleId);

    // The bot can only grant roles positioned BELOW its own highest role — this is
    // the single most common reason a level-up role silently fails to attach.
    if (role && botMember && botMember.roles.highest.position <= role.position) {
      failures.push(`<@&${milestone.roleId}>`);
      require('../../utils/errorReporter').reportIssue(
        guild.id,
        'Level reward role could not be given',
        `LoofaryBot's role is below **${role.name}** (level ${milestone.level} reward). Move LoofaryBot's role above it in Server Settings → Roles.`
      );
      continue;
    }

    await member.roles.add(milestone.roleId).catch((err) => {
      failures.push(`<@&${milestone.roleId}>`);
      console.error(`Failed to add level-${milestone.level} role to ${member.id}:`, err.message);
    });
  }
  return failures;
}

/**
 * Atomically adds (or, with a negative delta, removes) XP, never dropping below 0.
 * Grants any role rewards crossed on the way up. Used by /levels givexp|takexp and gambling payouts.
 */
async function adjustXp(guild, userId, delta, config = null) {
  config = config || (await getOrCreateConfig(guild.id));
  const { levelXpBase } = getEffectiveXpSettings(config);

  await UserLevel.updateOne(
    { guildId: guild.id, userId },
    [
      {
        $set: {
          xp: { $max: [0, { $add: [{ $ifNull: ['$xp', 0] }, delta] }] },
          // Pipeline upserts skip schema defaults — fill them so chat XP's cooldown query matches.
          level: { $ifNull: ['$level', 0] },
          lastMessageTimestamp: { $ifNull: ['$lastMessageTimestamp', 0] },
          createdAt: { $ifNull: ['$createdAt', '$$NOW'] }
        }
      }
    ],
    { upsert: true }
  );

  const result = await syncLevel(guild.id, userId, levelXpBase);
  let roleFailures = [];
  if (result.newLevel > result.oldLevel) {
    roleFailures = await grantMilestoneRoles(guild, userId, config, result.oldLevel, result.newLevel);
  }
  return { ...result, roleFailures };
}

/**
 * Atomically takes `amount` XP only if the user has at least that much. Returns false when
 * they can't afford it — this is what stops double-spending the same XP on parallel bets.
 */
async function debitXp(guildId, userId, amount, levelXpBase) {
  const updated = await UserLevel.findOneAndUpdate(
    { guildId, userId, xp: { $gte: amount } },
    { $inc: { xp: -amount } },
    { new: true }
  );
  if (!updated) return false;
  await syncLevel(guildId, userId, levelXpBase);
  return true;
}

/**
 * Called on every message. Applies the per-user cooldown, awards XP, persists it,
 * and — on level-up — assigns any cosmetic roles configured for that milestone.
 */
async function handleMessageXp(message) {
  if (message.author.bot || !message.guild) return;

  const config = await getOrCreateConfig(message.guild.id);
  if (!config.levelingEnabled) return;

  const { xpMin, xpMax, cooldownMs, levelXpBase } = getEffectiveXpSettings(config);
  const guildId = message.guild.id;
  const userId = message.author.id;
  const now = Date.now();

  const multiplier = getXpMultiplier(config, message.channel, message.member);
  const gained = Math.round((Math.floor(Math.random() * (xpMax - xpMin + 1)) + xpMin) * multiplier);
  if (gained <= 0) return; // e.g. a 0x multiplier on a bot-spam channel

  // Make sure the record exists, then award XP with a single conditional update so the cooldown
  // check and the XP write can't race each other (or a gambling payout landing at the same time).
  const exists = await UserLevel.exists({ guildId, userId });
  if (!exists) {
    await UserLevel.create({ guildId, userId }).catch((err) => {
      if (err.code !== 11000) throw err; // another message created it first — fine
    });
  }

  const updated = await UserLevel.findOneAndUpdate(
    { guildId, userId, lastMessageTimestamp: { $lte: now - cooldownMs } },
    { $inc: { xp: gained }, $set: { lastMessageTimestamp: now } },
    { new: true }
  );
  if (!updated) return; // still on cooldown

  const result = await syncLevel(guildId, userId, levelXpBase);
  if (result && result.newLevel > result.oldLevel) {
    await handleLevelUp(message, config, result.oldLevel, result.newLevel);
  }
}

// Picks where level-up messages go: the guild's configured announcement channel if it
// still exists and the bot can post there, otherwise the channel the user was chatting in.
function resolveLevelUpChannel(message, config) {
  if (!config.levelUpChannelId) return message.channel;
  const channel = message.guild.channels.cache.get(config.levelUpChannelId);
  const me = message.guild.members.me;
  if (!channel || !channel.isTextBased() || !me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return message.channel;
  }
  return channel;
}

async function handleLevelUp(message, config, oldLevel, newLevel) {
  const announceChannel = resolveLevelUpChannel(message, config);
  announceChannel
    .send(`🎉 ${message.author}, you leveled up to **Level ${newLevel}**!`)
    .catch(() => null);

  const failures = await grantMilestoneRoles(message.guild, message.author.id, config, oldLevel, newLevel);
  if (failures.length > 0) {
    announceChannel
      .send(
        `⚠️ Couldn't assign ${failures.join(', ')} to ${message.author} — LoofaryBot's role needs to be moved ` +
          `**above** that role in Server Settings → Roles.`
      )
      .catch(() => null);
  }
}

async function getLeaderboard(guildId, page = 1, pageSize = 10) {
  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * pageSize;
  const [entries, total] = await Promise.all([
    UserLevel.find({ guildId }).sort({ xp: -1 }).skip(skip).limit(pageSize),
    UserLevel.countDocuments({ guildId })
  ]);
  return {
    entries,
    total,
    page: safePage,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

async function getRank(guildId, userId) {
  const record = await UserLevel.findOne({ guildId, userId });
  if (!record) return null;
  const higherCount = await UserLevel.countDocuments({ guildId, xp: { $gt: record.xp } });
  return { record, rank: higherCount + 1 };
}

module.exports = {
  xpForLevel,
  levelForXp,
  getOrCreateConfig,
  getEffectiveXpSettings,
  getXpMultiplier,
  syncLevel,
  grantMilestoneRoles,
  adjustXp,
  debitXp,
  handleMessageXp,
  getLeaderboard,
  getRank
};
