const mongoose = require('mongoose');

// XP staked in an interactive game that hasn't finished yet. Deleted when the game settles; any
// left over at startup (crash / hard restart) is refunded to the player.
const ActiveBetSchema = new mongoose.Schema(
  {
    gameId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    kind: { type: String, required: true },
    amount: { type: Number, required: true },
    channelId: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ActiveBet', ActiveBetSchema);
