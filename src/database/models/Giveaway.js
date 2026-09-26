const mongoose = require('mongoose');

const GiveawaySchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    channelId: { type: String, required: true },
    guildId: { type: String, required: true, index: true },
    prize: { type: String, required: true },
    winnerCount: { type: Number, required: true, default: 1 },
    endTimestamp: { type: Number, required: true },
    colorHex: { type: String, default: '#5865F2' },
    emoji: { type: String, default: '🎉' },
    customDesc: { type: String, default: 'Click the button below to enter!' },
    hostId: { type: String, required: true },
    entries: { type: [String], default: [] },
    ended: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Giveaway', GiveawaySchema);
