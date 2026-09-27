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
    // Daily gamble limit: how many games they've started on `gambleDay` (UTC, YYYY-MM-DD).
    gambleDay: { type: String, default: null },
    gamblesToday: { type: Number, default: 0 },
    // Daily win cap: net XP won from gambling on `gambleWinDay` (UTC). Losses count against it.
    gambleWinDay: { type: String, default: null },
    gambleNetToday: { type: Number, default: 0 },
    boostPackageAt: { type: Date, default: null }, // last booster thank-you package (once per 30 days)
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
