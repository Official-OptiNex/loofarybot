const mongoose = require('mongoose');

// One document per member leaving (kicks and bans included). Only recorded live — Discord offers
// no history of past leaves to backfill from.
const MemberLeaveSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    leftAt: { type: Date, required: true }
  },
  { timestamps: true }
);

MemberLeaveSchema.index({ guildId: 1, leftAt: 1 });

module.exports = mongoose.model('MemberLeave', MemberLeaveSchema);
