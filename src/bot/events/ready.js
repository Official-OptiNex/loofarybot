const { REST, Routes } = require('discord.js');
const { BOT_TOKEN, CLIENT_ID } = require('../../config');
const { rescheduleActiveGiveaways } = require('../cogs/modules/giveaways');

const loofCommand = require('../commands/loof');
const honeypotCommand = require('../commands/honeypot');
const levelsCommand = require('../commands/levels');
const autoroleCommand = require('../commands/autorole');
const serverinfoCommand = require('../commands/serverinfo');
const userinfoCommand = require('../commands/userinfo');
const avatarCommand = require('../commands/avatar');
const purgeCommand = require('../commands/purge');

const ALL_COMMANDS = [
  loofCommand,
  honeypotCommand,
  levelsCommand,
  autoroleCommand,
  serverinfoCommand,
  userinfoCommand,
  avatarCommand,
  purgeCommand
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
  });
};
