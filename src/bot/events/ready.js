const { REST, Routes } = require('discord.js');
const { BOT_TOKEN, CLIENT_ID } = require('../../config');
const { rescheduleActiveGiveaways } = require('../cogs/modules/giveaways');
const { sweepPolls } = require('../cogs/modules/polls');
const { sweepReminders } = require('../cogs/modules/reminders');
const UserLevel = require('../../database/models/UserLevel');

// Removes leaderboard/XP records for people who left while the bot was offline (or before
// departed-member cleanup existed). Runs once per startup, one guild at a time.
async function pruneDepartedMembers(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      const { deletedCount } = await UserLevel.deleteMany({ guildId: guild.id, userId: { $nin: [...members.keys()] } });
      if (deletedCount) console.log(`Pruned ${deletedCount} departed member record(s) in ${guild.name}.`);
    } catch (err) {
      console.error(`Departed-member prune failed for guild ${guild.id}:`, err.message);
    }
  }
}

const loofCommand = require('../commands/loof');
const honeypotCommand = require('../commands/honeypot');
const levelsCommand = require('../commands/levels');
const autoroleCommand = require('../commands/autorole');
const serverinfoCommand = require('../commands/serverinfo');
const userinfoCommand = require('../commands/userinfo');
const avatarCommand = require('../commands/avatar');
const purgeCommand = require('../commands/purge');
const gambleCommand = require('../commands/gamble');
const logsCommand = require('../commands/logs');
const lockdownCommand = require('../commands/lockdown');
const unlockdownCommand = require('../commands/unlockdown');
const reactionroleCommand = require('../commands/reactionrole');
const pollCommand = require('../commands/poll');
const remindCommand = require('../commands/remind');

const ALL_COMMANDS = [
  loofCommand,
  honeypotCommand,
  levelsCommand,
  autoroleCommand,
  serverinfoCommand,
  userinfoCommand,
  avatarCommand,
  purgeCommand,
  gambleCommand,
  logsCommand,
  lockdownCommand,
  unlockdownCommand,
  reactionroleCommand,
  pollCommand,
  remindCommand
];

module.exports = function registerReadyEvent(client) {
  // Populate the in-memory command collection used by interactionCreate.
  ALL_COMMANDS.forEach((cmd) => client.commands.set(cmd.data.name, cmd));

  client.once('ready', async () => {
    console.log(`LoofaryBot logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: ALL_COMMANDS.map((cmd) => cmd.data.toJSON())
      });
      console.log('Successfully registered slash commands.');
    } catch (error) {
      console.error('Error registering slash commands:', error);
    }

    // Pick up giveaways that were mid-flight before this restart/redeploy,
    // then keep sweeping periodically as a safety net for any missed timers.
    await rescheduleActiveGiveaways(client).catch(console.error);
    setInterval(() => rescheduleActiveGiveaways(client).catch(console.error), 60 * 1000);

    // Timed polls and reminders live in MongoDB, so a short sweep survives restarts/redeploys.
    const sweep = () => {
      sweepPolls(client).catch(console.error);
      sweepReminders(client).catch(console.error);
    };
    sweep();
    setInterval(sweep, 10 * 1000);

    pruneDepartedMembers(client).catch(console.error);
  });
};
