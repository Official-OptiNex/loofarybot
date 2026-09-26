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
    ended: { type: Boolean, default: false },
    // 'drop' = first-to-click: the first `winnerCount` people to claim win instantly.
    type: { type: String, enum: ['timed', 'drop'], default: 'timed' },
    requirements: {
      roleId: { type: String, default: null },
      minDaysInServer: { type: Number, default: null },
      minLevel: { type: Number, default: null }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Giveaway', GiveawaySchema);
