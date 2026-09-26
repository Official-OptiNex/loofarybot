const mongoose = require('mongoose');

// Server activity shown in the dashboard's log viewer. Entries expire after 30 days.
const LogEntrySchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    type: {
      type: String,
      enum: ['messageEdit', 'messageDelete', 'memberJoin', 'memberLeave', 'voice', 'roles'],
      required: true
    },
    userId: { type: String, default: null },
    userTag: { type: String, default: '' },
    userAvatar: { type: String, default: '' },
    channelId: { type: String, default: null },
    channelName: { type: String, default: '' },
    messageUrl: { type: String, default: '' },
    before: { type: String, default: '' },
    after: { type: String, default: '' },
    summary: { type: String, default: '' }, // one-line description, e.g. "joined #General"
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
  },
  { versionKey: false }
);

LogEntrySchema.index({ guildId: 1, createdAt: -1 });
LogEntrySchema.index({ guildId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('LogEntry', LogEntrySchema);
