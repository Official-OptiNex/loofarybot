const { handleButtonInteraction } = require('../cogs/modules/giveaways');
const loofCommand = require('../commands/loof');

module.exports = function registerInteractionCreateEvent(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton()) {
        return handleButtonInteraction(interaction);
      }

      if (interaction.isModalSubmit()) {
        return loofCommand.handleModalSubmit(interaction, client);
      }

      if (!interaction.isChatInputCommand()) return;

      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      await command.execute(interaction, client);
    } catch (err) {
      console.error('Error handling interaction:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: '⚠️ An internal error occurred while processing your command.', ephemeral: true })
          .catch(() => null);
      }
    }
  });
};
