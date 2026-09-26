const mongoose = require('mongoose');

// One document per join event. Live joins and the dashboard's "Sync Join Data" backfill both
// key on (guildId, userId, joinedAt), so re-syncing never double-counts the same join.
const MemberJoinSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    joinedAt: { type: Date, required: true },
    source: { type: String, enum: ['live', 'sync'], default: 'live' }
  },
  { timestamps: true }
);

MemberJoinSchema.index({ guildId: 1, userId: 1, joinedAt: 1 }, { unique: true });
MemberJoinSchema.index({ guildId: 1, joinedAt: 1 });

module.exports = mongoose.model('MemberJoin', MemberJoinSchema);
