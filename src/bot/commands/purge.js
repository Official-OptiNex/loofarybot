const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Bulk-delete recent messages in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((opt) =>
    opt.setName('count').setDescription('Number of messages to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)
  )
  .addUserOption((opt) => opt.setName('user').setDescription('Only delete messages from this user').setRequired(false));

async function execute(interaction) {
  const count = interaction.options.getInteger('count');
  const user = interaction.options.getUser('user');

  await interaction.deferReply({ ephemeral: true });

  try {
    // Discord's bulk-delete only works on messages under 14 days old — bulkDelete's
    // `true` flag silently skips anything older instead of throwing, which is what we want.
    let toDelete = await interaction.channel.messages.fetch({ limit: 100 });
    if (user) toDelete = toDelete.filter((m) => m.author.id === user.id);
    toDelete = [...toDelete.values()].slice(0, count);

    if (toDelete.length === 0) {
      return interaction.editReply({ content: 'No matching messages found to delete.' });
    }

    const deleted = await interaction.channel.bulkDelete(toDelete, true);
    return interaction.editReply({
      content: `✅ Deleted ${deleted.size} message(s)${user ? ` from ${user}` : ''}.` +
        (deleted.size < toDelete.length ? ' (some messages were older than 14 days and were skipped.)' : '')
    });
  } catch (err) {
    console.error('Purge failed:', err);
    return interaction.editReply({ content: '❌ Failed to delete messages. Check the bot has Manage Messages permission here.' });
  }
}

module.exports = { data, execute };
