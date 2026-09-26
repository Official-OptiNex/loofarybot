const { EmbedBuilder } = require('discord.js');
const UserLevel = require('../../../database/models/UserLevel');
const { getOrCreateConfig, adjustXp } = require('./leveling');

const DAY_MS = 86400000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function dailySettings(config) {
  const d = (config && config.daily) || {};
  return {
    enabled: d.enabled !== false,
    baseXp: d.baseXp ?? 50,
    bonusPerDay: d.bonusPerDay ?? 10,
    maxBonus: d.maxBonus ?? 200,
    milestoneEvery: d.milestoneEvery ?? 7,
    milestoneBonus: d.milestoneBonus ?? 250
  };
}

function rewardFor(settings, streak) {
  const streakBonus = Math.min(settings.bonusPerDay * Math.max(0, streak - 1), settings.maxBonus);
  const milestone = settings.milestoneEvery > 0 && streak % settings.milestoneEvery === 0 ? settings.milestoneBonus : 0;
  return { base: settings.baseXp, streakBonus, milestone, total: settings.baseXp + streakBonus + milestone };
}

/**
 * Claims today's reward. Streak continues if the last claim was yesterday (UTC), otherwise resets
 * to 1. The claim is a single conditional update, so double-clicking /daily can't claim twice.
 */
async function claimDaily(guild, userId, now = Date.now()) {
  const config = await getOrCreateConfig(guild.id);
  const settings = dailySettings(config);
  if (!settings.enabled || config.levelingEnabled === false) return { error: 'Daily rewards are turned off on this server.' };

  const today = dayKey(now);
  const yesterday = dayKey(now - DAY_MS);

  const exists = await UserLevel.exists({ guildId: guild.id, userId });
  if (!exists) {
    await UserLevel.create({ guildId: guild.id, userId }).catch((err) => {
      if (err.code !== 11000) throw err;
    });
  }

  const before = await UserLevel.findOneAndUpdate(
    { guildId: guild.id, userId, lastDailyDay: { $ne: today } },
    [
      {
        $set: {
          dailyStreak: { $cond: [{ $eq: ['$lastDailyDay', yesterday] }, { $add: [{ $ifNull: ['$dailyStreak', 0] }, 1] }, 1] },
          lastDailyDay: today
        }
      },
      { $set: { bestStreak: { $max: [{ $ifNull: ['$bestStreak', 0] }, '$dailyStreak'] } } }
    ],
    { new: true }
  );
  if (!before) {
    const record = await UserLevel.findOne({ guildId: guild.id, userId }).lean();
    return { alreadyClaimed: true, streak: record?.dailyStreak || 0, nextReset: Date.parse(`${today}T00:00:00Z`) + DAY_MS };
  }

  const streak = before.dailyStreak;
  const reward = rewardFor(settings, streak);
  const result = await adjustXp(guild, userId, reward.total, config);
  const nextMilestone = settings.milestoneEvery > 0 ? Math.ceil((streak + 1) / settings.milestoneEvery) * settings.milestoneEvery : null;
  return {
    streak,
    best: before.bestStreak,
    reward,
    result,
    nextMilestone,
    tomorrow: rewardFor(settings, streak + 1).total,
    nextReset: Date.parse(`${today}T00:00:00Z`) + DAY_MS
  };
}

function buildDailyEmbed(user, outcome) {
  const reset = `<t:${Math.floor(outcome.nextReset / 1000)}:R>`;
  if (outcome.alreadyClaimed) {
    return new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('⏳ Already claimed today')
      .setDescription(`You're on a **${outcome.streak}-day** streak 🔥\nCome back ${reset} to keep it going.`);
  }
  const r = outcome.reward;
  const lines = [`Base reward: **+${r.base} XP**`];
  if (r.streakBonus) lines.push(`Streak bonus: **+${r.streakBonus} XP**`);
  if (r.milestone) lines.push(`🏅 ${outcome.streak}-day milestone: **+${r.milestone} XP**`);
  const levelUp = outcome.result.newLevel > outcome.result.oldLevel ? `\n🎉 You leveled up to **Level ${outcome.result.newLevel}**!` : '';
  return new EmbedBuilder()
    .setColor(outcome.reward.milestone ? '#F1C40F' : '#FF8A3D')
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setTitle(`🔥 ${outcome.streak}-day streak! +${r.total} XP`)
    .setDescription(`${lines.join('\n')}${levelUp}`)
    .addFields(
      { name: 'Balance', value: `${outcome.result.record.xp.toLocaleString('en-US')} XP · Level ${outcome.result.newLevel}`, inline: true },
      { name: 'Best streak', value: `${outcome.best} days`, inline: true },
      { name: 'Tomorrow', value: `+${outcome.tomorrow} XP${outcome.nextMilestone ? ` · milestone at day ${outcome.nextMilestone}` : ''}`, inline: true }
    )
    .setFooter({ text: 'Resets at midnight UTC — miss a day and the streak starts over' });
}

module.exports = { dailySettings, rewardFor, claimDaily, buildDailyEmbed };
