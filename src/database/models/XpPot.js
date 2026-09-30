const mongoose = require('mongoose');

// One day's Daily XP Pot in a server. `day` is the UTC date of its draw.
const XpPotSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    day: { type: String, required: true }, // 'YYYY-MM-DD' of the draw
    drawAt: { type: Date, required: true },
    amount: { type: Number, default: 0 },
    rolledOver: { type: Number, default: 0 }, // part of `amount` carried over from earlier days
    contributors: { type: Map, of: Number, default: {} }, // userId -> XP lost into the pot
    status: { type: String, enum: ['collecting', 'posted', 'done', 'rolled'], default: 'collecting' },
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
    winners: { type: [{ _id: false, userId: String, place: Number, amount: Number }], default: [] }, // 1st, 2nd, 3rd…
    winnerId: { type: String, default: null }, // 1st place
    won: { type: Number, default: 0 }, // total paid out
    leftover: { type: Number, default: 0 }, // didn't fit the prizes — rolled over to the next pot
    entrants: { type: Number, default: 0 },
    entrantIds: { type: [String], default: [] } // who was entered when it was drawn (first 500)
  },
  { timestamps: true }
);

XpPotSchema.index({ guildId: 1, day: 1 }, { unique: true });
XpPotSchema.index({ status: 1, drawAt: 1 });

module.exports = mongoose.model('XpPot', XpPotSchema);
