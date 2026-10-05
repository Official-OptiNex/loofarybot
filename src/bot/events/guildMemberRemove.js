const UserLevel = require('../../database/models/UserLevel');
const Reminder = require('../../database/models/Reminder');
const Giveaway = require('../../database/models/Giveaway');
const ShopOwnership = require('../../database/models/ShopOwnership');
const IdleFactory = require('../../database/models/IdleFactory');
const GambleStats = require('../../database/models/GambleStats');
const Birthday = require('../../database/models/Birthday');
const { sendGoodbye } = require('../cogs/modules/welcome');
const { reportIssue } = require('../utils/errorReporter');

/**
 * When someone leaves, drop their per-server personal data so they vanish from the leaderboards and
 * we don't keep data on people who aren't here: XP/level/rank card, owned shop items, their Bubble
 * Factory, gamble stats, birthday, reminders, and entries in giveaways still running.
 * Kept on purpose: moderation cases (ban-evasion / audit history must survive a leave+rejoin) and the
 * anonymous join/leave counts that power the dashboard growth chart.
 */
async function clearMemberData(guildId, userId) {
  const [levels, reminders, giveaways] = await Promise.all([
    UserLevel.deleteOne({ guildId, userId }),
    Reminder.deleteMany({ guildId, userId }),
    Giveaway.updateMany({ guildId, ended: false, entries: userId }, { $pull: { entries: userId } }),
    ShopOwnership.deleteMany({ guildId, userId }),
    IdleFactory.deleteOne({ guildId, userId }),
    GambleStats.deleteOne({ guildId, userId }),
    Birthday.deleteOne({ guildId, userId })
  ]);
  return { levels: levels.deletedCount, reminders: reminders.deletedCount, giveaways: giveaways.modifiedCount };
}

module.exports = function registerGuildMemberRemoveEvent(client) {
  client.on('guildMemberRemove', async (member) => {
    if (member.user?.bot) return;
    // Goodbye message first (it only needs their name), then clean up their data.
    sendGoodbye(member)
      .then((problem) => {
        if (problem && !/disabled|empty/i.test(problem)) reportIssue(member.guild.id, 'Goodbye message not sent', problem);
      })
      .catch((err) => console.error('Goodbye message failed:', err.message));
    try {
      await clearMemberData(member.guild.id, member.id);
    } catch (err) {
      console.error(`Failed to clear data for departed member ${member.id}:`, err);
    }
  });
};

module.exports.clearMemberData = clearMemberData;
