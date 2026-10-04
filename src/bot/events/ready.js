const { REST, Routes } = require('discord.js');
const { BOT_TOKEN, CLIENT_ID } = require('../../config');
const { rescheduleActiveGiveaways } = require('../cogs/modules/giveaways');
const { sweepPolls } = require('../cogs/modules/polls');
const { sweepReminders } = require('../cogs/modules/reminders');
const UserLevel = require('../../database/models/UserLevel');
const { setClient: setLevelColorClient } = require('../cogs/modules/levelColors');

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
const alertsCommand = require('../commands/alerts');
const dailyCommand = require('../commands/daily');
const mediaonlyCommand = require('../commands/mediaonly');
const casesCommand = require('../commands/cases');
const { commands: modActionCommands } = require('../commands/modActions');
const { commands: greetingCommands } = require('../commands/greetings');
const perksCommand = require('../commands/perks');
const ticketCommand = require('../commands/ticket');
const xpdropCommand = require('../commands/xpdrop');
const birthdayCommand = require('../commands/birthday');
const countingCommand = require('../commands/counting');
const starboardCommand = require('../commands/starboard');
const automodCommand = require('../commands/automod');
const shopCommand = require('../commands/shop');
const potCommand = require('../commands/pot');
const idleCommand = require('../commands/idle');

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
  remindCommand,
  alertsCommand,
  dailyCommand,
  mediaonlyCommand,
  casesCommand,
  ...modActionCommands,
  ...greetingCommands,
  perksCommand,
  ticketCommand,
  xpdropCommand,
  birthdayCommand,
  countingCommand,
  starboardCommand,
  automodCommand,
  shopCommand,
  potCommand,
  idleCommand
];

module.exports = function registerReadyEvent(client) {
  // Populate the in-memory command collection used by interactionCreate.
  ALL_COMMANDS.forEach((cmd) => client.commands.set(cmd.data.name, cmd));

  setLevelColorClient(client);

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

    // Twitch go-live / YouTube upload alerts.
    require('../cogs/modules/socialAlerts').startPolling(client);

    // Daily automatic settings + XP backups (last 7 kept per server).
    require('../cogs/modules/backups').startDailyBackups(client);

    // Refund bets from games that were interrupted by a crash (a clean shutdown settles them itself),
    // then keep sweeping for stuck games every minute.
    const gambling = require('../cogs/modules/gambling');
    gambling
      .refundOrphanedBets(client)
      .then((n) => n && console.log(`Refunded ${n} interrupted game bet(s).`))
      .catch(console.error);
    gambling.startGameSweeper(client);

    // Lift temporary bans when they run out.
    require('../cogs/modules/modCases').startTempBanSweeper(client);

    // Daily XP drop for server boosters.
    require('../cogs/modules/boosterPerks').startBoosterDrops(client);

    // Random XP drops in active chat channels.
    require('../cogs/modules/chatDrops').startChatDrops(client);

    // Daily birthday posts (and taking the birthday role back the next day).
    require('../cogs/modules/birthdays').startBirthdays(client);

    // Daily XP Pot: gambling losses, drawn at the end of the day among active chatters.
    require('../cogs/modules/xpPot').startXpPot(client);

    // XP shop: end expired boosts and temporary roles.
    require('../cogs/modules/shop').startShop(client);

    // Delete old log history and other finished data so the database stays small.
    require('../cogs/modules/storage').startStorageCleanup(client);
  });
};
