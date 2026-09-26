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

/**
 * Called on every message. Applies the per-user cooldown, awards XP, persists it,
 * and — on level-up — assigns any cosmetic roles configured for that milestone.
 */
async function handleMessageXp(message) {
  if (message.author.bot || !message.guild) return;

  const config = await getOrCreateConfig(message.guild.id);
  if (!config.levelingEnabled) return;

  const { xpMin, xpMax, cooldownMs, levelXpBase } = getEffectiveXpSettings(config);

  const now = Date.now();
  let record = await UserLevel.findOne({ guildId: message.guild.id, userId: message.author.id });
  if (!record) {
    record = new UserLevel({ guildId: message.guild.id, userId: message.author.id });
  }

  if (now - record.lastMessageTimestamp < cooldownMs) return;

  const gained = Math.floor(Math.random() * (xpMax - xpMin + 1)) + xpMin;
  const previousLevel = record.level;

  record.xp += gained;
  record.lastMessageTimestamp = now;
  record.level = levelForXp(record.xp, levelXpBase);
  await record.save();

  if (record.level > previousLevel) {
    await handleLevelUp(message, config, previousLevel, record.level);
  }
}

async function handleLevelUp(message, config, oldLevel, newLevel) {
  message.channel
    .send(`🎉 ${message.author}, you leveled up to **Level ${newLevel}**!`)
    .catch(() => null);

  // Assign roles for every milestone crossed (covers users who jump multiple levels at once).
  const milestonesCrossed = config.levelRoles.filter((lr) => lr.level > oldLevel && lr.level <= newLevel);
  if (milestonesCrossed.length === 0) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  const botMember = message.guild.members.me;
  const failures = [];

  for (const milestone of milestonesCrossed) {
    const role = message.guild.roles.cache.get(milestone.roleId);

    // The bot can only grant roles positioned BELOW its own highest role — this is
    // the single most common reason a level-up role silently fails to attach.
    if (role && botMember && botMember.roles.highest.position <= role.position) {
      failures.push(`<@&${milestone.roleId}>`);
      console.error(
        `Cannot assign level-${milestone.level} role (${role.name}) in guild ${message.guild.id}: ` +
          `bot's highest role is below it in the hierarchy.`
      );
      continue;
    }

    await member.roles.add(milestone.roleId).catch((err) => {
      failures.push(`<@&${milestone.roleId}>`);
      console.error(`Failed to add level-${milestone.level} role to ${member.id}:`, err.message);
    });
  }

  if (failures.length > 0) {
    message.channel
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
  handleMessageXp,
  getLeaderboard,
  getRank
};
