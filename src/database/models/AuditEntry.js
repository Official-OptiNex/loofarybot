const mongoose = require('mongoose');

// Dashboard change history ("who changed what"). Kept for 180 days.
const AuditEntrySchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    username: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    role: { type: String, enum: ['admin', 'mod'], default: 'admin' },
    section: { type: String, default: '' },
    action: { type: String, required: true },
    detail: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 180 }
  },
  { versionKey: false }
);

AuditEntrySchema.index({ guildId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditEntry', AuditEntrySchema);
