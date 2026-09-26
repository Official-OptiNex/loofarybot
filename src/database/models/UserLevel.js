const mongoose = require('mongoose');

const UserLevelSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    xp: { type: Number, default: 0 },
    level: { type: Number, default: 0 },
    lastMessageTimestamp: { type: Number, default: 0 }
  },
  { timestamps: true }
);

UserLevelSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('UserLevel', UserLevelSchema);
