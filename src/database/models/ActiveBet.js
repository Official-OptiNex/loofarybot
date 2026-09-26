const mongoose = require('mongoose');

// XP staked in an interactive game that hasn't finished yet. Deleted when the game settles; any
// left over at startup (crash / hard restart) is refunded to the player.
const ActiveBetSchema = new mongoose.Schema(
  {
    gameId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    kind: { type: String, required: true },
    amount: { type: Number, required: true }, // total stake in play
    paidAmount: { type: Number, default: null }, // XP that actually came from the player (free plays = 0)
    freePlay: { type: Boolean, default: false },
    channelId: { type: String, default: null },
    lastActiveAt: { type: Date, default: null } // bumped while the game is being played (orphan sweep uses updatedAt)
  },
  { timestamps: true }
);

module.exports = mongoose.model('ActiveBet', ActiveBetSchema);
