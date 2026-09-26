const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const Giveaway = require('../../database/models/Giveaway');
const { isAuthorized } = require('../utils/permissions');
const {
  parseDuration,
  formatTime,
  resolveColor,
  buildGiveawayEmbed,
  launchGiveaway,
  finishGiveawayById
} = require('../cogs/modules/giveaways');

const data = new SlashCommandBuilder()
  .setName('loof')
  .setDescription('LoofaryBot Giveaway Commands')
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Start a giveaway immediately')
      .addChannelOption((opt) => opt.setName('channel').setDescription('Target channel').setRequired(true))
      .addStringOption((opt) => opt.setName('duration').setDescription('Duration (e.g., 10m, 1h, 2d)').setRequired(true))
      .addIntegerOption((opt) => opt.setName('winners').setDescription('Number of winners').setRequired(true))
      .addStringOption((opt) => opt.setName('prize').setDescription('Giveaway prize').setRequired(true))
      .addRoleOption((opt) => opt.setName('ping_role').setDescription('Role to ping (or @everyone/@here)').setRequired(false))
      .addStringOption((opt) => opt.setName('color').setDescription('Hex or name color (e.g., #FF5733, green)').setRequired(false))
      .addStringOption((opt) => opt.setName('button_emoji').setDescription('Emoji for entry button').setRequired(false))
      .addStringOption((opt) => opt.setName('description').setDescription('Custom description text').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Interactively create a giveaway using a popup modal')
      .addChannelOption((opt) => opt.setName('channel').setDescription('Target channel').setRequired(true))
      .addRoleOption((opt) => opt.setName('ping_role').setDescription('Role to ping').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('End an active giveaway early')
      .addStringOption((opt) => opt.setName('message_id').setDescription('Giveaway Message ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('reroll')
      .setDescription('Pick a new winner from an ended giveaway')
      .addStringOption((opt) => opt.setName('message_id').setDescription('Giveaway Message ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Delete a giveaway and remove its message')
      .addStringOption((opt) => opt.setName('message_id').setDescription('Giveaway Message ID').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List all running giveaways'))
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Modify an ongoing giveaway')
      .addStringOption((opt) => opt.setName('message_id').setDescription('Giveaway Message ID').setRequired(true))
      .addStringOption((opt) => opt.setName('new_prize').setDescription('Updated prize text').setRequired(false))
      .addIntegerOption((opt) => opt.setName('new_winners').setDescription('Updated winner count').setRequired(false))
  )
  .addSubcommand((sub) => sub.setName('ping').setDescription('Check bot websocket and API latency'))
  .addSubcommand((sub) => sub.setName('help').setDescription('Show help and available commands'));

async function execute(interaction, client) {
  if (!isAuthorized(interaction)) {
    return interaction.reply({
      content: '❌ Only Administrators or @loofary can use LoofaryBot commands.',
      ephemeral: true
    });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'ping') {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true, ephemeral: true });
    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    return interaction.editReply({
      content: `🏓 **Pong!**\n• API Latency: \`${roundtrip}ms\`\n• WebSocket Latency: \`${Math.round(client.ws.ping)}ms\``
    });
  }

  if (sub === 'help') {
    const { EmbedBuilder } = require('discord.js');
    const helpEmbed = new EmbedBuilder()
      .setTitle('LoofaryBot Commands & Usage')
      .setColor('#5865F2')
      .setDescription(
        '`/loof start` - Starts a giveaway with option arguments.\n' +
          '`/loof create` - Opens an interactive popup modal to configure a giveaway.\n' +
          '`/loof end` - Forces an active giveaway to end early.\n' +
          '`/loof reroll` - Selects a new winner from an ended giveaway.\n' +
          '`/loof delete` - Removes a giveaway message and cancels the draw.\n' +
          '`/loof list` - Displays active giveaways on the server.\n' +
          '`/loof edit` - Modifies prize details or winner counts on a live giveaway.\n' +
          '`/loof ping` - Checks bot API latency and WebSocket status.\n' +
          '`/loof help` - Shows this help menu.\n\n' +
          'See also: `/honeypot` and `/levels` for the moderation and XP systems, ' +
          'and the web dashboard for the embed builder.'
      );
    return interaction.reply({ embeds: [helpEmbed], ephemeral: true });
  }

  if (sub === 'start') {
    const channel = interaction.options.getChannel('channel');
    const durationMs = parseDuration(interaction.options.getString('duration'));
    if (!durationMs) {
      return interaction.reply({ content: '❌ Invalid duration format! Use e.g. `10m`, `1h`, `2d`.', ephemeral: true });
    }
    const winnerCount = interaction.options.getInteger('winners');
    const prize = interaction.options.getString('prize');
    const pingRole = interaction.options.getRole('ping_role');
    const colorHex = resolveColor(interaction.options.getString('color'));
    const emoji = interaction.options.getString('button_emoji') || '🎉';
    const customDesc = interaction.options.getString('description') || 'Click the button below to enter!';

    return launchGiveaway(client, {
      interaction,
      channel,
      durationMs,
      winnerCount,
      prize,
      pingRole,
      colorHex,
      emoji,
      customDesc
    });
  }

  if (sub === 'create') {
    const channel = interaction.options.getChannel('channel');
    const pingRole = interaction.options.getRole('ping_role');
    const pingRoleId = pingRole ? pingRole.id : 'none';

    const modal = new ModalBuilder()
      .setCustomId(`gcreate_modal_${channel.id}_${pingRoleId}`)
      .setTitle('Create a Giveaway');

    const prizeInput = new TextInputBuilder().setCustomId('m_prize').setLabel('Prize').setStyle(TextInputStyle.Short).setRequired(true);
    const durationInput = new TextInputBuilder()
      .setCustomId('m_duration')
      .setLabel('Duration (e.g., 10m, 1h, 2d)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    const winnersInput = new TextInputBuilder().setCustomId('m_winners').setLabel('Number of winners').setStyle(TextInputStyle.Short).setRequired(true);
    const colorInput = new TextInputBuilder()
      .setCustomId('m_color')
      .setLabel('Color (hex or name, optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    const descInput = new TextInputBuilder()
      .setCustomId('m_desc')
      .setLabel('Custom description (optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(prizeInput),
      new ActionRowBuilder().addComponents(durationInput),
      new ActionRowBuilder().addComponents(winnersInput),
      new ActionRowBuilder().addComponents(colorInput),
      new ActionRowBuilder().addComponents(descInput)
    );

    return interaction.showModal(modal);
  }

  if (sub === 'end') {
    const msgId = interaction.options.getString('message_id').trim();
    const g = await Giveaway.findOne({ messageId: msgId });
    if (!g || g.ended) {
      return interaction.reply({ content: '❌ Giveaway not found or already ended.', ephemeral: true });
    }
    await finishGiveawayById(client, msgId);
    return interaction.reply({ content: `✅ Giveaway \`${msgId}\` ended early.`, ephemeral: true });
  }

  if (sub === 'reroll') {
    const msgId = interaction.options.getString('message_id').trim();
    const g = await Giveaway.findOne({ messageId: msgId });
    if (!g || !g.ended) {
      return interaction.reply({ content: '❌ Giveaway not found or has not ended yet.', ephemeral: true });
    }
    if (g.entries.length === 0) {
      return interaction.reply({ content: '❌ No entries to reroll from.', ephemeral: true });
    }
    const newWinner = g.entries[Math.floor(Math.random() * g.entries.length)];
    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (channel) {
      channel.send(`🎉 New winner for **${g.prize}**: <@${newWinner}>!`).catch(() => null);
    }
    return interaction.reply({ content: `✅ Rerolled. New winner: <@${newWinner}>`, ephemeral: true });
  }

  if (sub === 'delete') {
    const msgId = interaction.options.getString('message_id').trim();
    const g = await Giveaway.findOne({ messageId: msgId });
    if (!g) {
      return interaction.reply({ content: '❌ Giveaway not found.', ephemeral: true });
    }
    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (channel) {
      const msg = await channel.messages.fetch(g.messageId).catch(() => null);
      if (msg) await msg.delete().catch(() => null);
    }
    await Giveaway.deleteOne({ messageId: msgId });
    return interaction.reply({ content: `✅ Giveaway \`${msgId}\` deleted.`, ephemeral: true });
  }

  if (sub === 'list') {
    const active = await Giveaway.find({ ended: false, guildId: interaction.guildId });
    if (active.length === 0) {
      return interaction.reply({ content: 'No active giveaways currently running in this server.', ephemeral: true });
    }
    const listStr = active
      .map((g) => `• **${g.prize}** | ID: \`${g.messageId}\` | Channel: <#${g.channelId}> | Ends: ${formatTime(g.endTimestamp)}`)
      .join('\n');
    return interaction.reply({ content: `**Active Giveaways (${active.length}):**\n${listStr}`, ephemeral: true });
  }

  if (sub === 'edit') {
    const msgId = interaction.options.getString('message_id').trim();
    const newPrize = interaction.options.getString('new_prize');
    const newWinners = interaction.options.getInteger('new_winners');

    const g = await Giveaway.findOne({ messageId: msgId });
    if (!g || g.ended) {
      return interaction.reply({ content: '❌ Giveaway not found or already ended.', ephemeral: true });
    }
    if (newPrize) g.prize = newPrize;
    if (newWinners) g.winnerCount = newWinners;
    await g.save();

    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (channel) {
      const msg = await channel.messages.fetch(g.messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [buildGiveawayEmbed(g)] }).catch(() => null);
    }
    return interaction.reply({ content: `✅ Giveaway \`${msgId}\` updated successfully.`, ephemeral: true });
  }
}

async function handleModalSubmit(interaction, client) {
  if (!interaction.customId.startsWith('gcreate_modal_')) return;

  const parts = interaction.customId.split('_');
  const channelId = parts[2];
  const pingRoleId = parts[3];

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    return interaction.reply({ content: '❌ Target channel could not be found.', ephemeral: true });
  }

  const durationStr = interaction.fields.getTextInputValue('m_duration');
  const winnersStr = interaction.fields.getTextInputValue('m_winners');
  const prize = interaction.fields.getTextInputValue('m_prize');
  const rawColor = interaction.fields.getTextInputValue('m_color');
  const customDesc = interaction.fields.getTextInputValue('m_desc') || 'Click the button below to enter!';

  const durationMs = parseDuration(durationStr);
  if (!durationMs) {
    return interaction.reply({ content: '❌ Invalid duration format inside modal! Use e.g. `10m`, `1h`, `2d`.', ephemeral: true });
  }
  const winnerCount = parseInt(winnersStr, 10);
  if (isNaN(winnerCount) || winnerCount < 1) {
    return interaction.reply({ content: '❌ Winner count must be a valid positive integer.', ephemeral: true });
  }

  const colorHex = resolveColor(rawColor);
  let pingRole = null;
  if (pingRoleId !== 'none') {
    pingRole = await interaction.guild.roles.fetch(pingRoleId).catch(() => null);
  }

  return launchGiveaway(client, {
    interaction,
    channel,
    durationMs,
    winnerCount,
    prize,
    pingRole,
    colorHex,
    emoji: '🎉',
    customDesc
  });
}

module.exports = { data, execute, handleModalSubmit };
