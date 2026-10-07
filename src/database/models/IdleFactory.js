const mongoose = require('mongoose');

// One member's Bubble Factory (the idle game). Bubbles are the game's own currency — earned over
// time, spent on upgrades, and cashed out to real XP at a daily-capped rate (see idleGame.js).
const IdleFactorySchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    active: { type: Boolean, default: false }, // the factory only makes bubbles once the member starts it
    bank: { type: Number, default: 0 }, // bubbles ready to spend or cash out
    lifetime: { type: Number, default: 0 }, // total bubbles ever produced (for the leaderboard)
    lastTick: { type: Number, default: 0 }, // ms timestamp pending has accrued from
    upgrades: { type: mongoose.Schema.Types.Mixed, default: {} }, // { upgradeId: level }
    cashoutDay: { type: String, default: null }, // UTC YYYY-MM-DD of the last cash-out
    cashoutXpToday: { type: Number, default: 0 }, // XP cashed out on cashoutDay (against the daily cap)
    fullNotified: { type: Boolean, default: false }, // we DM'd this member that their tub is full (reset on collect/start)
    // --- Rebirth (prestige) ---
    rebirths: { type: Number, default: 0 }, // how many times they've rebirthed (permanent production bonus)
    stars: { type: Number, default: 0 }, // ⭐ Prestige Stars to spend on permanent perks
    starsEarned: { type: Number, default: 0 }, // cumulative stars ever awarded (so rebirths never double-pay)
    perks: { type: mongoose.Schema.Types.Mixed, default: {} } // permanent prestige perks { perkId: level }
  },
  { timestamps: true }
);

IdleFactorySchema.index({ guildId: 1, userId: 1 }, { unique: true });
IdleFactorySchema.index({ guildId: 1, lifetime: -1 }); // leaderboard

module.exports = mongoose.model('IdleFactory', IdleFactorySchema);
