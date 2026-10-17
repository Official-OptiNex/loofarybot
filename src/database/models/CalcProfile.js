const mongoose = require('mongoose');

// A member's /calculate numbers (per calculator), so the panel opens where they left off.
const CalcProfileSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    kind: { type: String, required: true }, // 'pets' | 'guns'
    have: { type: String, default: '' },
    want: { type: String, default: '' },
    // The panel's numbers: how many of each rarity they own / want (index 0 = D … 12 = ZZZ).
    haveCounts: { type: [Number], default: [] },
    wantCounts: { type: [Number], default: [] }
  },
  { timestamps: true }
);

CalcProfileSchema.index({ userId: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('CalcProfile', CalcProfileSchema);
