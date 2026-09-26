const UserLevel = require('../../database/models/UserLevel');
const Reminder = require('../../database/models/Reminder');
const Giveaway = require('../../database/models/Giveaway');

/**
 * When someone leaves, drop their per-server data: XP/level/rank card (so they vanish from the
 * leaderboard), their reminders in this server, and their entries in giveaways still running.
 * Join/leave counts for the dashboard chart are kept — they're anonymous aggregates.
 */
async function clearMemberData(guildId, userId) {
  const [levels, reminders, giveaways] = await Promise.all([
    UserLevel.deleteOne({ guildId, userId }),
    Reminder.deleteMany({ guildId, userId }),
    Giveaway.updateMany({ guildId, ended: false, entries: userId }, { $pull: { entries: userId } })
  ]);
  return { levels: levels.deletedCount, reminders: reminders.deletedCount, giveaways: giveaways.modifiedCount };
}

module.exports = function registerGuildMemberRemoveEvent(client) {
  client.on('guildMemberRemove', async (member) => {
    if (member.user?.bot) return;
    try {
      await clearMemberData(member.guild.id, member.id);
    } catch (err) {
      console.error(`Failed to clear data for departed member ${member.id}:`, err);
    }
  });
};

module.exports.clearMemberData = clearMemberData;
