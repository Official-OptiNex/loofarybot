const mongoose = require('mongoose');

const GameStatsSchema = new mongoose.Schema({ games: Number, wins: Number, net: Number }, { _id: false });

// Lifetime gambling results per member (/gamble stats). Refunded games aren't counted.
const GambleStatsSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    games: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    pushes: { type: Number, default: 0 },
    freePlays: { type: Number, default: 0 },
    wagered: { type: Number, default: 0 }, // XP actually staked (free plays stake nothing)
    returned: { type: Number, default: 0 }, // XP paid back
    net: { type: Number, default: 0 }, // returned − wagered
    biggestWin: { type: Number, default: 0 }, // largest profit from one game
    biggestWinGame: { type: String, default: null },
    biggestWinMultiplier: { type: Number, default: 0 },
    biggestWinAt: { type: Date, default: null },
    streak: { type: Number, default: 0 }, // +N = N wins in a row, −N = N losses in a row
    bestStreak: { type: Number, default: 0 },
    worstStreak: { type: Number, default: 0 }, // most losses in a row (positive number)
    byGame: { type: Map, of: GameStatsSchema, default: {} },
    lastPlayedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

GambleStatsSchema.index({ guildId: 1, userId: 1 }, { unique: true });
GambleStatsSchema.index({ guildId: 1, net: -1 });

module.exports = mongoose.model('GambleStats', GambleStatsSchema);
