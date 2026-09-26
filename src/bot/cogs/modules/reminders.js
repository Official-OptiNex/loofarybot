const { EmbedBuilder } = require('discord.js');
const Reminder = require('../../../database/models/Reminder');

function buildReminderEmbed(reminder) {
  return new EmbedBuilder()
    .setTitle('⏰ Reminder')
    .setColor('#FEE75C')
    .setDescription(reminder.message)
    .setFooter({ text: 'Set' })
    .setTimestamp(reminder.createdAt || Date.now());
}

async function deliver(client, reminder) {
  const embed = buildReminderEmbed(reminder);
  // Only ever ping the person who set the reminder — never @everyone/roles typed into the text.
  const allowedMentions = { users: [reminder.userId] };

  if (reminder.target === 'channel') {
    const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
    if (channel) {
      await channel.send({ content: `<@${reminder.userId}>`, embeds: [embed], allowedMentions }).catch(() => null);
    }
    return;
  }

  const user = await client.users.fetch(reminder.userId).catch(() => null);
  const dm = user ? await user.send({ embeds: [embed] }).catch(() => null) : null;
  if (dm) return;

  // DMs closed — fall back to the channel the reminder was created in.
  const fallback = reminder.sourceChannelId ? await client.channels.fetch(reminder.sourceChannelId).catch(() => null) : null;
  if (fallback) {
    await fallback
      .send({ content: `<@${reminder.userId}> (couldn't DM you)`, embeds: [embed], allowedMentions })
      .catch(() => null);
  }
}

async function sweepReminders(client) {
  const due = await Reminder.find({ remindAt: { $lte: Date.now() } }, { _id: 1 }).limit(50).lean();
  for (const { _id } of due) {
    // Delete-then-send so a reminder is never delivered twice, even if two sweeps overlap.
    const reminder = await Reminder.findOneAndDelete({ _id });
    if (reminder) await deliver(client, reminder).catch(console.error);
  }
}

module.exports = { sweepReminders };
