const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const Reminder = require('../../database/models/Reminder');
const { parseDuration, formatDuration } = require('../utils/duration');

const MAX_REMINDER_MS = 365 * 86400000;
const MAX_ACTIVE_PER_USER = 25;

const whenOption = (opt) => opt.setName('in').setDescription('When (e.g. 10m, 2h, 1d12h, 1w)').setRequired(true);
const messageOption = (opt) => opt.setName('message').setDescription('What to remind about').setMaxLength(1000).setRequired(true);

const data = new SlashCommandBuilder()
  .setName('remind')
  .setDescription('Set reminders without leaving Discord')
  .addSubcommand((sub) => sub.setName('me').setDescription('Remind yourself (sent by DM)').addStringOption(whenOption).addStringOption(messageOption))
  .addSubcommand((sub) =>
    sub
      .setName('channel')
      .setDescription('Post a reminder in a channel')
      .addStringOption(whenOption)
      .addStringOption(messageOption)
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel (defaults to this one)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show your upcoming reminders'))
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel one of your reminders')
      .addIntegerOption((opt) => opt.setName('number').setDescription('Number from /remind list').setMinValue(1).setRequired(true))
  );

async function listForUser(userId) {
  return Reminder.find({ userId }).sort({ remindAt: 1 }).limit(MAX_ACTIVE_PER_USER);
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (sub === 'me' || sub === 'channel') {
    const ms = parseDuration(interaction.options.getString('in'));
    if (!ms || ms > MAX_REMINDER_MS) {
      return interaction.reply({ content: '❌ Invalid time. Use e.g. `10m`, `2h`, `1d12h`, `1w` (max 1 year).', ephemeral: true });
    }
    if ((await Reminder.countDocuments({ userId })) >= MAX_ACTIVE_PER_USER) {
      return interaction.reply({ content: `❌ You already have ${MAX_ACTIVE_PER_USER} reminders. Cancel some with \`/remind cancel\`.`, ephemeral: true });
    }

    const reminder = {
      userId,
      guildId: interaction.guildId,
      sourceChannelId: interaction.channelId,
      message: interaction.options.getString('message'),
      remindAt: Date.now() + ms,
      target: sub === 'me' ? 'dm' : 'channel'
    };

    if (sub === 'channel') {
      if (!interaction.guild) return interaction.reply({ content: '❌ Channel reminders only work in servers.', ephemeral: true });
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const canPost = channel.permissionsFor(interaction.member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
      if (!canPost) return interaction.reply({ content: `❌ You can't send messages in ${channel}.`, ephemeral: true });
      reminder.channelId = channel.id;
    }

    await Reminder.create(reminder);
    const when = `<t:${Math.floor(reminder.remindAt / 1000)}:R>`;
    return interaction.reply({
      content: sub === 'me' ? `⏰ Got it — I'll DM you ${when} (in ${formatDuration(ms)}).` : `⏰ I'll post it in <#${reminder.channelId}> ${when}.`,
      ephemeral: true
    });
  }

  if (sub === 'list') {
    const reminders = await listForUser(userId);
    if (!reminders.length) return interaction.reply({ content: 'You have no upcoming reminders.', ephemeral: true });
    const lines = reminders.map(
      (r, i) =>
        `**${i + 1}.** <t:${Math.floor(r.remindAt / 1000)}:R> ${r.target === 'channel' ? `in <#${r.channelId}>` : 'by DM'} — ${r.message.slice(0, 80)}${r.message.length > 80 ? '…' : ''}`
    );
    return interaction.reply({ content: `**Your reminders:**\n${lines.join('\n')}`, ephemeral: true });
  }

  if (sub === 'cancel') {
    const reminders = await listForUser(userId);
    const target = reminders[interaction.options.getInteger('number') - 1];
    if (!target) return interaction.reply({ content: '❌ No reminder with that number — check `/remind list`.', ephemeral: true });
    await Reminder.deleteOne({ _id: target._id, userId });
    return interaction.reply({ content: `✅ Cancelled: ${target.message.slice(0, 100)}`, ephemeral: true });
  }
}

module.exports = { data, execute };
