const GuildConfig = require('../../../database/models/GuildConfig');
const UserLevel = require('../../../database/models/UserLevel');
const { XP_MIN, XP_MAX, XP_COOLDOWN_MS, LEVEL_XP_BASE } = require('../../../config');

// XP required to reach a given level. Tune LEVEL_XP_BASE in config.js to speed up/slow down progression.
function xpForLevel(level) {
  return Math.round(LEVEL_XP_BASE * Math.pow(level, 1.5));
}

function levelForXp(xp) {
  let level = 0;
  while (xp >= xpForLevel(level + 1)) level++;
  return level;
}

async function getOrCreateConfig(guildId) {
  let config = await GuildConfig.findOne({ guildId });
  if (!config) config = await GuildConfig.create({ guildId });
  return config;
}

/**
 * Called on every message. Applies the per-user cooldown, awards XP, persists it,
 * and — on level-up — assigns any cosmetic roles configured for that milestone.
 */
async function handleMessageXp(message) {
  if (message.author.bot || !message.guild) return;

  const config = await getOrCreateConfig(message.guild.id);
  if (!config.levelingEnabled) return;

  const now = Date.now();
  let record = await UserLevel.findOne({ guildId: message.guild.id, userId: message.author.id });
  if (!record) {
    record = new UserLevel({ guildId: message.guild.id, userId: message.author.id });
  }

  if (now - record.lastMessageTimestamp < XP_COOLDOWN_MS) return;

  const gained = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
  const previousLevel = record.level;

  record.xp += gained;
  record.lastMessageTimestamp = now;
  record.level = levelForXp(record.xp);
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

  for (const milestone of milestonesCrossed) {
    await member.roles.add(milestone.roleId).catch((err) => {
      console.error(`Failed to add level-${milestone.level} role to ${member.id}:`, err.message);
    });
  }
}

async function getLeaderboard(guildId, limit = 10) {
  return UserLevel.find({ guildId }).sort({ xp: -1 }).limit(limit);
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
  handleMessageXp,
  getLeaderboard,
  getRank
};
