const { REST, Routes } = require('discord.js');
const { BOT_TOKEN, CLIENT_ID } = require('../../config');
const { rescheduleActiveGiveaways } = require('../cogs/modules/giveaways');

const loofCommand = require('../commands/loof');
const honeypotCommand = require('../commands/honeypot');
const levelsCommand = require('../commands/levels');

module.exports = function registerReadyEvent(client) {
  // Populate the in-memory command collection used by interactionCreate.
  client.commands.set(loofCommand.data.name, loofCommand);
  client.commands.set(honeypotCommand.data.name, honeypotCommand);
  client.commands.set(levelsCommand.data.name, levelsCommand);

  client.once('ready', async () => {
    console.log(`LoofaryBot logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: [loofCommand.data.toJSON(), honeypotCommand.data.toJSON(), levelsCommand.data.toJSON()]
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
