const mongoose = require('mongoose');

// One automatic XP drop posted in chat: the first `winners` members to click Claim each get `amount` XP.
const ChatDropSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, default: null, index: true },
    amount: { type: Number, required: true },
    winners: { type: Number, required: true, min: 1, max: 3 },
    claimedBy: { type: [String], default: [] },
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    expiresAt: { type: Date, required: true },
    manual: { type: Boolean, default: false } // started with /xpdrop now or the dashboard
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatDrop', ChatDropSchema);
