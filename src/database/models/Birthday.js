const mongoose = require('mongoose');

// A member's birthday in one server (month/day only — no year, so no ages are stored).
const BirthdaySchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    day: { type: Number, required: true, min: 1, max: 31 },
    lastCelebrated: { type: String, default: null }, // 'YYYY-MM-DD' — stops a double celebration
    roleGivenAt: { type: Date, default: null } // birthday role handed out; removed ~24h later
  },
  { timestamps: true }
);

BirthdaySchema.index({ guildId: 1, userId: 1 }, { unique: true });
BirthdaySchema.index({ guildId: 1, month: 1, day: 1 });

module.exports = mongoose.model('Birthday', BirthdaySchema);
