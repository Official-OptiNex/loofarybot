const { handleButtonInteraction } = require('../cogs/modules/giveaways');
const { handleGambleButton } = require('../cogs/modules/gambling');
const { handleRoleButton, handleRoleSelect } = require('../cogs/modules/reactionRoles');
const { handleVote } = require('../cogs/modules/polls');
const { handleHelpSelect } = require('../cogs/modules/help');
const loofCommand = require('../commands/loof');
const { reportError } = require('../utils/errorReporter');
const honeypotCommand = require('../commands/honeypot');

// Routes a component's customId to its feature by prefix.
function routeButton(interaction) {
  const id = interaction.customId;
  if (id.startsWith('gm:') || id.startsWith('hl:') || id.startsWith('bj:')) return handleGambleButton(interaction);
  if (id.startsWith('rr:')) return handleRoleButton(interaction);
  if (id.startsWith('poll:')) return handleVote(interaction);
  return handleButtonInteraction(interaction); // giveaways & drops
}

module.exports = function registerInteractionCreateEvent(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton()) {
        return await routeButton(interaction);
      }

      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'rrsel') return await handleRoleSelect(interaction);
        if (interaction.customId === 'help_cat') return await handleHelpSelect(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('hpembed_modal:')) return await honeypotCommand.handleModalSubmit(interaction, client);
        return await loofCommand.handleModalSubmit(interaction, client);
      }

      if (!interaction.isChatInputCommand()) return;

      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      await command.execute(interaction, client);
    } catch (err) {
      const label = interaction.isChatInputCommand?.()
        ? `/${interaction.commandName}${interaction.options.getSubcommand(false) ? ' ' + interaction.options.getSubcommand(false) : ''} failed`
        : `${interaction.customId ? `Component "${interaction.customId.split(':')[0]}"` : 'Interaction'} failed`;
      reportError(err, { guildId: interaction.guildId, context: label });
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: '⚠️ An internal error occurred while processing your command.', ephemeral: true })
          .catch(() => null);
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ content: '⚠️ An internal error occurred while processing your command.' }).catch(() => null);
      }
    }
  });
};
