const mongoose = require('mongoose');

// One submitted application.
const ApplicationSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    formId: { type: String, required: true, index: true },
    formName: { type: String, default: '' },
    userId: { type: String, required: true, index: true },
    userTag: { type: String, default: null },
    answers: { type: [{ question: String, answer: String, _id: false }], default: [] },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'DENIED'], default: 'PENDING', index: true },
    reviewChannelId: { type: String, default: null },
    reviewMessageId: { type: String, default: null },
    decidedBy: { type: String, default: null },
    decidedByTag: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    reason: { type: String, default: null }, // reviewer's note on approve/deny
    roleGiven: { type: Boolean, default: false },
    dmSent: { type: Boolean, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Application', ApplicationSchema);
