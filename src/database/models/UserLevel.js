const mongoose = require('mongoose');

const UserLevelSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    xp: { type: Number, default: 0 },
    level: { type: Number, default: 0 },
    lastMessageTimestamp: { type: Number, default: 0 },
    // /daily streaks — lastDailyDay is the UTC date (YYYY-MM-DD) of the last claim.
    dailyStreak: { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 },
    lastDailyDay: { type: String, default: null },
    // Gambling free play: an unused free bet (0 or 1) and when the last one was given.
    freePlays: { type: Number, default: 0 },
    lastFreePlayGrantedAt: { type: Date, default: null },
    // Personal /levels card customization.
    card: {
      color: { type: String, default: null },
      backgroundUrl: { type: String, default: null },
      text: { type: String, default: null }
    }
  },
  { timestamps: true }
);

UserLevelSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('UserLevel', UserLevelSchema);
