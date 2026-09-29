const mongoose = require('mongoose');

const LOG_TTL_SECONDS = 60 * 60 * 24 * 90;

// Server activity shown in the dashboard's log viewer. Each server picks how long entries are kept
// (logRetentionDays, cleaned every few hours). A TTL index on createdAt is a hard ceiling of 90 days;
// it's created/updated at startup by storage.syncLogTtl (not declared here, so changing the ceiling
// never clashes with the index an existing database already has).
const LogEntrySchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    type: {
      type: String,
      enum: [
        'messageEdit', 'messageDelete', 'memberJoin', 'memberLeave', 'voice', 'roles', 'modActions',
        'automod', 'bulkDelete', 'members', 'bans', 'channels', 'serverRoles', 'threads', 'invites', 'emojis', 'server', 'commands', 'shop'
      ],
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
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

LogEntrySchema.index({ guildId: 1, createdAt: -1 });
LogEntrySchema.index({ guildId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('LogEntry', LogEntrySchema);
module.exports.LOG_TTL_SECONDS = LOG_TTL_SECONDS;
