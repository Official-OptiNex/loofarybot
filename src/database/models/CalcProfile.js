const mongoose = require('mongoose');

// What a member last typed into /calculate (per calculator), so the form opens pre-filled next time.
const CalcProfileSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    kind: { type: String, required: true }, // 'pets' | 'guns'
    have: { type: String, default: '' },
    want: { type: String, default: '' }
  },
  { timestamps: true }
);

CalcProfileSchema.index({ userId: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('CalcProfile', CalcProfileSchema);
