const mongoose = require('mongoose');

const ReminderSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    guildId: { type: String, default: null },
    // 'dm' reminders go to the user's DMs (falling back to sourceChannelId if DMs are closed);
    // 'channel' reminders are posted in channelId.
    target: { type: String, enum: ['dm', 'channel'], default: 'dm' },
    channelId: { type: String, default: null },
    sourceChannelId: { type: String, default: null },
    message: { type: String, required: true },
    remindAt: { type: Number, required: true, index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Reminder', ReminderSchema);
